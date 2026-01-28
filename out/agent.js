"use strict";
/**
 * Agentic Chat Handler
 * Implements ReAct-style reasoning loop with tool use
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentChat = void 0;
const vscode = __importStar(require("vscode"));
const SYSTEM_PROMPT = `You are an expert AI coding assistant running locally. You help developers write, debug, test, and understand code.

## Available Tools
You have access to these tools to accomplish tasks:

1. **web_search** - Search the internet for documentation, APIs, or solutions
2. **run_command** - Execute shell commands (tests, builds, git, etc.)
3. **read_file** - Read file contents (code, configs, etc.)
4. **write_file** - Create or overwrite files
5. **edit_file** - Make targeted edits to existing files
6. **list_directory** - Explore the file system
7. **search_files** - Search for patterns in code (like grep)

## Guidelines

1. **Think step-by-step** - Before acting, briefly explain your reasoning
2. **Gather context first** - Read relevant files before making changes
3. **Be precise** - When editing files, match existing style and formatting
4. **Test your work** - Run commands to verify changes work correctly
5. **Handle errors gracefully** - If something fails, diagnose and try alternatives
6. **Ask for clarification** if the request is ambiguous

## Tool Call Format
When you need to use a tool, respond with a JSON tool call in this format:
\`\`\`tool_call
{"name": "tool_name", "arguments": {"arg1": "value1"}}
\`\`\`

You can use multiple tools in sequence. After each tool result, continue reasoning until the task is complete.

## Current Context
- Working directory: {WORKSPACE}
- Operating system: ${process.platform}
`;
class AgentChat {
    llm;
    tools;
    conversationHistory = [];
    maxHistoryLength = 20;
    constructor(llm, tools) {
        this.llm = llm;
        this.tools = tools;
    }
    async handleRequest(request, context, stream, token) {
        const config = vscode.workspace.getConfiguration('agentic');
        const maxIterations = config.get('agent.maxIterations', 15);
        const requireConfirmation = config.get('tools.requireConfirmation', true);
        const allowedCommands = config.get('tools.allowedCommands', ['npm', 'node', 'git', 'python']);
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const toolContext = {
            workspaceRoot,
            cancellationToken: token,
            requireConfirmation,
            allowedCommands
        };
        // Build system prompt with workspace info
        const systemPrompt = SYSTEM_PROMPT.replace('{WORKSPACE}', workspaceRoot);
        // Build conversation messages
        const messages = [
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
                const pendingToolCalls = [];
                // Stream the response
                for await (const chunk of this.llm.streamChat(messages, this.tools.getToolDefinitions(), (toolCalls) => pendingToolCalls.push(...toolCalls))) {
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
                    if (token.isCancellationRequested)
                        break;
                    const toolName = toolCall.function.name;
                    let toolArgs;
                    try {
                        toolArgs = JSON.parse(toolCall.function.arguments);
                    }
                    catch {
                        toolArgs = {};
                    }
                    // Show tool execution in UI
                    stream.markdown(`\n\n---\n**🔧 Executing:** \`${toolName}\``);
                    if (Object.keys(toolArgs).length > 0) {
                        const argsPreview = JSON.stringify(toolArgs, null, 2);
                        if (argsPreview.length < 200) {
                            stream.markdown(`\n\`\`\`json\n${argsPreview}\n\`\`\``);
                        }
                    }
                    stream.markdown('\n\n');
                    // Execute the tool
                    const result = await this.tools.executeTool(toolName, toolArgs, toolContext);
                    // Show result preview
                    const resultPreview = result.length > 500
                        ? result.slice(0, 500) + `\n... (${result.length - 500} more chars)`
                        : result;
                    stream.markdown(`**Result:**\n\`\`\`\n${resultPreview}\n\`\`\`\n\n`);
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
                stream.markdown('\n\n⚠️ *Reached maximum iterations. Task may be incomplete.*');
            }
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            stream.markdown(`\n\n❌ **Error:** ${errorMessage}`);
            // Check if it's a connection error
            if (errorMessage.includes('fetch') || errorMessage.includes('ECONNREFUSED')) {
                stream.markdown('\n\n💡 *Make sure llama.cpp server is running on the configured endpoint.*');
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
    parseToolCalls(response) {
        const calls = [];
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
            }
            catch {
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
                }
                catch {
                    // Skip
                }
            }
        }
        return calls;
    }
    /**
     * Add message to conversation history with length limit
     */
    addToHistory(message) {
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
    clearHistory() {
        this.conversationHistory = [];
    }
    /**
     * Get current conversation history
     */
    getHistory() {
        return [...this.conversationHistory];
    }
}
exports.AgentChat = AgentChat;
//# sourceMappingURL=agent.js.map