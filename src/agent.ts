/**
 * Agentic Chat Handler
 * Implements ReAct-style reasoning loop with tool use
 */

import * as vscode from 'vscode';
import { LlamaCppClient, ChatMessage, ToolCall, Tool } from './llm/llamaCpp';
import { ToolRegistry, ToolContext } from './tools/registry';

const SYSTEM_PROMPT = `You are an elite AI developer. You follow these 4 RULES to ensure high-fidelity delivery:

1. **RESEARCH VS EXECUTION**: If you are unsure or need technical specs, SEARCH FIRST using \`web_search\` (MAX 8 KEYWORDS). **Next, you MUST use \`read_url\`** to get the actual code/docs. Search snippets are NOT enough.
2. **STRICT FILE OPERATIONS**: You CANNOT write code in the chat. You MUST use \`write_file\` to create code. **Ensure a file exists before reading it.** (If creating a new file, write it first). Plan -> Write -> Verify.
3. **TERMINAL VALIDATION**: You MUST \`run_command\` to compile, test, and verify your logic. Fix all errors until it runs perfectly.
4. **COMPLETE CODE**: No placeholders. Write EVERY necessary line.
5. **ACTION BIAS**: Do not stop to ask for permission. If you have the solution, \`write_file\` immediately. Describing code without writing it is a FAILURE.

## Execution Loop
1. **PLAN**: Briefly state your plan.
2. **WRITE**: Use tools to create/edit files.
3. **VERIFY**: Run commands to test your code.
4. **ITERATE**: Fix errors if any.

## Autonomy
Continue using tools until the task is 100% finished. Do not stop to ask for intermediate permission.

## Current Context
- Working directory: {WORKSPACE}
- Operating system: ${process.platform}

5. **RELATIVE PATHS ONLY**: You are in a VS Code workspace. NEVER use absolute paths like \`/home/user\` or \`C:/Users\`. ALL paths must be relative to the root (e.g., \`src/main.rs\`, \`./package.json\`).
6. **NO HALLUCINATIONS**: Do not read files that don't exist. Use \`run_command\` with \`dir\` or \`ls\` to verify structure first.
`;

export class AgentChat {
    private conversationHistory: ChatMessage[] = [];
    private maxHistoryLength = 10;

    constructor(
        private llm: LlamaCppClient,
        private tools: ToolRegistry
    ) { }

    async handleRequest(
        request: vscode.ChatRequest,
        context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        const config = vscode.workspace.getConfiguration('agentic');
        const maxIterations = config.get<number>('agent.maxIterations', 15);
        const requireConfirmation = config.get<boolean>('tools.requireConfirmation', true);
        const allowedCommands = config.get<string[]>('tools.allowedCommands', ['npm', 'node', 'git', 'python']);

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            stream.markdown(' **No workspace folder open!**\n\nPlease open a folder first: **File  Open Folder...**');
            vscode.window.showErrorMessage('Please open a folder or workspace before using the agent. Go to File  Open Folder...');
            return {};
        }
        const workspaceRoot = workspaceFolder.uri.fsPath;

        const toolContext: ToolContext = {
            workspaceRoot,
            cancellationToken: token,
            requireConfirmation,
            allowedCommands
        };

        // Build system prompt with workspace info
        const systemPrompt = SYSTEM_PROMPT.replace('{WORKSPACE}', workspaceRoot);

        // Build conversation messages
        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...this.conversationHistory,
            { role: 'user', content: request.prompt }
        ];

        let iteration = 0;
        let totalTokensUsed = 0;

        try {
            while (iteration < maxIterations && !token.isCancellationRequested) {
                iteration++;

                // Progress indicator
                stream.progress(`Thinking... (iteration ${iteration}/${maxIterations})`);

                // Get LLM response
                let fullResponse = '';
                const pendingToolCalls: ToolCall[] = [];

                // Stream the response
                for await (const chunk of this.llm.streamChat(
                    messages,
                    this.tools.getToolDefinitions(),
                    (toolCalls) => pendingToolCalls.push(...toolCalls)
                )) {
                    fullResponse += chunk;
                    stream.markdown(chunk);
                }

                // Parse tool calls from the response text (for models that don't use native tool calling)
                const parsedToolCalls = this.parseToolCalls(fullResponse);
                const allToolCalls = [...pendingToolCalls, ...parsedToolCalls];

                // If no tool calls, we're done
                if (allToolCalls.length === 0) {
                    // Save to conversation history
                    this.addToHistory({ role: 'user', content: request.prompt });
                    this.addToHistory({ role: 'assistant', content: fullResponse });
                    break;
                }

                // Add assistant message with tool calls
                messages.push({
                    role: 'assistant',
                    content: fullResponse,
                    tool_calls: allToolCalls
                });

                // Execute each tool call
                for (const toolCall of allToolCalls) {
                    if (token.isCancellationRequested) break;

                    const toolName = toolCall.function.name;
                    let toolArgs: Record<string, unknown>;

                    try {
                        toolArgs = JSON.parse(toolCall.function.arguments);
                    } catch {
                        toolArgs = {};
                    }

                    // Show tool execution in UI
                    stream.markdown(`\n\n---\n** Executing:** \`${toolName}\``);
                    if (Object.keys(toolArgs).length > 0) {
                        const argEntries = Object.entries(toolArgs);
                        const argsPreview = argEntries.length === 1
                            ? ` \`${argEntries[0][1]}\``
                            : `\n\`\`\`json\n${JSON.stringify(toolArgs, null, 2)}\n\`\`\``;
                        stream.markdown(argsPreview);
                    }
                    stream.markdown('\n\n');

                    // Execute the tool
                    const result = await this.tools.executeTool(toolName, toolArgs, toolContext);

                    // Show concise result preview in UI (while providing full result to LLM context)
                    let resultPreview = '';
                    if (toolName === 'read_file') {
                        // Extract relative path from success message if possible (e.g. "Read X lines from path")
                        const pathMatch = result.match(/from\s+([^\n\r:\s]+)/);
                        const displayPath = pathMatch ? pathMatch[1] : toolArgs.path;
                        const lines = result.split('\n').filter(l => l.trim().length > 0).length;
                        resultPreview = ` Read from \`${displayPath}\` (${lines} lines)`;
                    } else if (toolName === 'search_files') {
                        const matchCount = (result.match(/\[MATCH\]/g) || []).length;
                        resultPreview = ` Found ${matchCount} matches for \`${toolArgs.pattern}\``;
                    } else if (toolName === 'edit_file' || toolName === 'write_file' || toolName === 'append_file') {
                        resultPreview = result.split('\n')[0]; // Just the first line (Success/Warning)
                    } else {
                        resultPreview = result.length > 500
                            ? ` Success (${result.length} characters)\n\`\`\`\n${result.slice(0, 200)}...\n\`\`\``
                            : `\`\`\`\n${result}\n\`\`\``;
                    }

                    stream.markdown(`**Result:** ${resultPreview}\n\n`);

                    // Add tool result to messages
                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: result,
                        name: toolName
                    });
                }
            }

            // Warn if max iterations reached
            if (iteration >= maxIterations) {
                stream.markdown('\n\n *Reached maximum iterations. Task may be incomplete.*');
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            stream.markdown(`\n\n **Error:** ${errorMessage}`);

            // Check if it's a connection error
            if (errorMessage.includes('fetch') || errorMessage.includes('ECONNREFUSED')) {
                stream.markdown('\n\n *Make sure llama.cpp server is running on the configured endpoint.*');
            }
        }

        return {
            metadata: {
                iterations: iteration,
                tokensUsed: totalTokensUsed
            }
        };
    }

    /**
     * Parse tool calls from model output text
     * Supports various formats including markdown code blocks
     */
    private parseToolCalls(response: string): ToolCall[] {
        const calls: ToolCall[] = [];

        // Pattern 1: ```tool_call\n{...}\n```
        const toolCallBlockRegex = /```(?:tool_call|json)?\s*\n?\s*(\{[\s\S]*?"name"[\s\S]*?\})\s*\n?```/gi;

        let match;
        while ((match = toolCallBlockRegex.exec(response)) !== null) {
            try {
                const parsed = JSON.parse(match[1]);
                if (parsed.name) {
                    calls.push({
                        id: `call_${Date.now()}_${calls.length}`,
                        type: 'function',
                        function: {
                            name: parsed.name,
                            arguments: JSON.stringify(parsed.arguments || parsed.params || {})
                        }
                    });
                }
            } catch {
                // Skip malformed JSON
            }
        }

        // Pattern 2: Inline JSON with "name" and "arguments" keys
        if (calls.length === 0) {
            const inlineJsonRegex = /\{\s*"name"\s*:\s*"([^"]+)"[\s\S]*?"arguments"\s*:\s*(\{[^}]*\})/gi;
            while ((match = inlineJsonRegex.exec(response)) !== null) {
                try {
                    calls.push({
                        id: `call_${Date.now()}_${calls.length}`,
                        type: 'function',
                        function: {
                            name: match[1],
                            arguments: match[2]
                        }
                    });
                } catch {
                    // Skip
                }
            }
        }

        return calls;
    }

    /**
     * Add message to conversation history with length limit
     */
    private addToHistory(message: ChatMessage): void {
        this.conversationHistory.push(message);

        // Trim old messages if too long
        while (this.conversationHistory.length > this.maxHistoryLength * 2) {
            // Remove oldest pair (user + assistant)
            this.conversationHistory.shift();
            this.conversationHistory.shift();
        }
    }

    /**
     * Clear conversation history
     */
    clearHistory(): void {
        this.conversationHistory = [];
    }

    /**
     * Get current conversation history
     */
    getHistory(): ChatMessage[] {
        return [...this.conversationHistory];
    }
}