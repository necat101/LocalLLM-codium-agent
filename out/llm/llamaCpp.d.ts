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
export declare class LlamaCppClient {
    private config;
    private abortController;
    constructor(config?: Partial<LlamaCppConfig>);
    /**
     * Check if the llama.cpp server is running
     */
    healthCheck(): Promise<boolean>;
    /**
     * Get available models from the server
     */
    getModels(): Promise<string[]>;
    /**
     * Update client configuration
     */
    updateConfig(newConfig: Partial<LlamaCppConfig>): void;
    /**
     * Stream chat completions from the LLM
     */
    streamChat(messages: ChatMessage[], tools?: Tool[], onToolCall?: (toolCalls: ToolCall[]) => void, stop?: string[]): AsyncGenerator<string, void, unknown>;
    /**
     * Non-streaming chat completion
     */
    chat(messages: ChatMessage[], tools?: Tool[]): Promise<{
        content: string;
        toolCalls?: ToolCall[];
    }>;
    /**
     * Cancel ongoing request
     */
    abort(): void;
}
//# sourceMappingURL=llamaCpp.d.ts.map