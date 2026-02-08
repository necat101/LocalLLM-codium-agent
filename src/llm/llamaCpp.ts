/**
 * llama.cpp OpenAI-compatible API client
 * Handles streaming chat completions with tool calling support
 */

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

export interface Tool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, unknown>;
            required?: string[];
        };
    };
}

export interface ChatCompletionChunk {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        delta: {
            role?: string;
            content?: string;
            tool_calls?: Array<{
                index: number;
                id?: string;
                type?: string;
                function?: {
                    name?: string;
                    arguments?: string;
                };
            }>;
        };
        finish_reason: string | null;
    }>;
}

export interface LlamaCppConfig {
    endpoint: string;
    maxTokens: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    stream?: boolean;
}

export class LlamaCppClient {
    private config: LlamaCppConfig;
    private abortController: AbortController | null = null;

    constructor(config: Partial<LlamaCppConfig> = {}) {
        this.config = {
            endpoint: config.endpoint || 'http://localhost:8080',
            maxTokens: config.maxTokens || 4096,
            temperature: config.temperature ?? 0.7,
            topP: config.topP ?? 0.9,
            topK: config.topK ?? 40,
            frequencyPenalty: config.frequencyPenalty ?? 1.1,
            stream: config.stream ?? true
        };
    }

    /**
     * Check if the llama.cpp server is running
     */
    async healthCheck(): Promise<boolean> {
        try {
            const response = await fetch(`${this.config.endpoint}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(5000)
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
     * Get available models from the server
     */
    async getModels(): Promise<string[]> {
        try {
            const response = await fetch(`${this.config.endpoint}/v1/models`);
            if (!response.ok) return [];
            const data = await response.json() as { data?: Array<{ id: string }> };
            return data.data?.map((m) => m.id) || [];
        } catch {
            return [];
        }
    }

    /**
     * Update client configuration
     */
    updateConfig(newConfig: Partial<LlamaCppConfig>): void {
        this.config = { ...this.config, ...newConfig };
    }

    /**
     * Stream chat completions from the LLM
     */
    async *streamChat(
        messages: ChatMessage[],
        tools?: Tool[],
        onToolCall?: (toolCalls: ToolCall[]) => void
    ): AsyncGenerator<string, void, unknown> {
        this.abortController = new AbortController();

        const requestBody: Record<string, unknown> = {
            messages: messages.map(m => ({
                role: m.role,
                content: m.content,
                ...(m.tool_calls && { tool_calls: m.tool_calls }),
                ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
                ...(m.name && { name: m.name })
            })),
            max_tokens: this.config.maxTokens,
            temperature: this.config.temperature,
            top_p: this.config.topP,
            top_k: this.config.topK,
            frequency_penalty: this.config.frequencyPenalty,
            stream: true
        };

        // Add tools if provided (for function calling)
        if (tools && tools.length > 0) {
            requestBody.tools = tools;
            requestBody.tool_choice = 'auto';
        }

        const response = await fetch(`${this.config.endpoint}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
            },
            body: JSON.stringify(requestBody),
            signal: this.abortController.signal
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`LLM API error: ${response.status} - ${error}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let buffer = '';
        const accumulatedToolCalls: Map<number, ToolCall> = new Map();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]') continue;
                    if (!trimmed.startsWith('data: ')) continue;

                    try {
                        const chunk: ChatCompletionChunk = JSON.parse(trimmed.slice(6));
                        const delta = chunk.choices[0]?.delta;

                        // Yield main content
                        if (delta?.content) {
                            yield delta.content;
                        }

                        // Some models put reasoning in a separate field
                        if ((delta as Record<string, unknown>)?.reasoning_content) {
                            yield (delta as Record<string, unknown>).reasoning_content as string;
                        }

                        // Accumulate tool calls
                        if (delta?.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                let existing = accumulatedToolCalls.get(tc.index);
                                if (!existing) {
                                    existing = {
                                        id: tc.id || `call_${Date.now()}_${tc.index}`,
                                        type: 'function',
                                        function: { name: '', arguments: '' }
                                    };
                                    accumulatedToolCalls.set(tc.index, existing);
                                }
                                if (tc.function?.name) {
                                    existing.function.name += tc.function.name;
                                }
                                if (tc.function?.arguments) {
                                    existing.function.arguments += tc.function.arguments;
                                }
                            }
                        }

                        // Check for finish with tool calls
                        if (chunk.choices[0]?.finish_reason === 'tool_calls' && onToolCall) {
                            onToolCall(Array.from(accumulatedToolCalls.values()));
                        }
                    } catch {
                        // Skip malformed JSON
                    }
                }
            }

            // Final check for accumulated tool calls
            if (accumulatedToolCalls.size > 0 && onToolCall) {
                onToolCall(Array.from(accumulatedToolCalls.values()));
            }
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * Non-streaming chat completion
     */
    async chat(messages: ChatMessage[], tools?: Tool[]): Promise<{ content: string; toolCalls?: ToolCall[] }> {
        const requestBody: Record<string, unknown> = {
            messages,
            max_tokens: this.config.maxTokens,
            temperature: this.config.temperature,
            top_p: this.config.topP,
            top_k: this.config.topK,
            frequency_penalty: this.config.frequencyPenalty,
            stream: false
        };

        if (tools && tools.length > 0) {
            requestBody.tools = tools;
            requestBody.tool_choice = 'auto';
        }

        const response = await fetch(`${this.config.endpoint}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            throw new Error(`LLM API error: ${response.status}`);
        }

        const data = await response.json() as { choices: Array<{ message?: { content?: string; tool_calls?: ToolCall[] } }> };
        const choice = data.choices[0];

        return {
            content: choice.message?.content || '',
            toolCalls: choice.message?.tool_calls
        };
    }

    /**
     * Cancel ongoing request
     */
    abort(): void {
        this.abortController?.abort();
        this.abortController = null;
    }
}
