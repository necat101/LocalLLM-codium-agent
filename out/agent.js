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
const SYSTEM_PROMPT = `You are an autonomous coding agent. You respond ONLY with tool calls, never with text or explanations.

WORKFLOW: write_file -> run_command (compile) -> run_command (execute) -> fix errors if any.

RULES:
- For Rust: rustc file.rs -o program.exe then .\\program.exe
- On errors: read_file first, then edit_file to fix
- Rust is NOT Python: use vec![], for i in 0..n, println!()
- Keep iterating until code WORKS

Working directory: {WORKSPACE}
`;
class AgentChat {
    llm;
    tools;
    conversationHistory = [];
    maxHistoryLength = 10;
    constructor(llm, tools) {
        this.llm = llm;
        this.tools = tools;
    }
    async handleRequest(request, context, stream, token) {
        const config = vscode.workspace.getConfiguration('agentic');
        const maxIterations = config.get('agent.maxIterations', 15);
        const requireConfirmation = config.get('tools.requireConfirmation', true);
        const allowedCommands = config.get('tools.allowedCommands', ['npm', 'node', 'git', 'python']);
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            stream.markdown(' **No workspace folder open!**\n\nPlease open a folder first: **File  Open Folder...**');
            vscode.window.showErrorMessage('Please open a folder or workspace before using the agent. Go to File  Open Folder...');
            return {};
        }
        const workspaceRoot = workspaceFolder.uri.fsPath;
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
                let inThinkBlock = false;
                // Stream the response
                for await (const chunk of this.llm.streamChat(messages, this.tools.getToolDefinitions(), (toolCalls) => pendingToolCalls.push(...toolCalls))) {
                    fullResponse += chunk;
                    // Filter out <think> blocks from being shown to user
                    if (chunk.includes('<think>')) {
                        inThinkBlock = true;
                    }
                    if (!inThinkBlock) {
                        // Don't stream <tool_call> tags or raw JSON to user
                        if (!chunk.includes('<tool_call>') && !chunk.includes('</tool_call>') && !chunk.startsWith('{"name"')) {
                            stream.markdown(chunk);
                        }
                    }
                    if (chunk.includes('</think>')) {
                        inThinkBlock = false;
                    }
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
                        // Sanitize smart quotes and other problematic characters before parsing
                        let argsString = toolCall.function.arguments
                            .replace(/[\u201c\u201d]/g, '"') // Curly double quotes -> straight
                            .replace(/[\u2018\u2019]/g, "'") // Curly single quotes -> straight
                            .replace(/\\u[0-9a-fA-F]{0,3}(?![0-9a-fA-F])/g, ''); // Remove incomplete unicode escapes
                        toolArgs = JSON.parse(argsString);
                    }
                    catch {
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
                    }
                    else if (toolName === 'search_files') {
                        const matchCount = (result.match(/\[MATCH\]/g) || []).length;
                        resultPreview = ` Found ${matchCount} matches for \`${toolArgs.pattern}\``;
                    }
                    else if (toolName === 'edit_file' || toolName === 'write_file' || toolName === 'append_file') {
                        resultPreview = result.split('\n')[0]; // Just the first line (Success/Warning)
                    }
                    else {
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
        }
        catch (error) {
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
        // Pattern 2: <tool_call>...</tool_call> XML tags (Official Falcon format)
        if (calls.length === 0) {
            const xmlToolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
            while ((match = xmlToolCallRegex.exec(response)) !== null) {
                try {
                    // Extract and sanitize the JSON content
                    const jsonContent = this.sanitizeJson(match[1]);
                    const parsed = JSON.parse(jsonContent);
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
        }
        // Pattern 3: Look for JSON-like structures containing "name" field
        // Use a more robust approach that handles nested braces properly
        if (calls.length === 0) {
            const jsonObjects = this.extractJsonObjects(response);
            for (const jsonStr of jsonObjects) {
                try {
                    // Sanitize the JSON - fix unquoted string values
                    const sanitized = this.sanitizeJson(jsonStr);
                    const parsed = JSON.parse(sanitized);
                    if (parsed.name && typeof parsed.name === 'string') {
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
        }
        return calls;
    }
    /**
     * Sanitize malformed JSON - fix common issues from model output
     */
    sanitizeJson(json) {
        // First, remove any hallucinated tool response at the end
        // Model sometimes generates fake responses like ({"results":...})
        const toolCallEnd = json.indexOf('</tool_call>');
        if (toolCallEnd === -1) {
            // Find where the main JSON ends and cut off garbage
            let braceDepth = 0;
            let jsonEnd = -1;
            for (let i = 0; i < json.length; i++) {
                if (json[i] === '{')
                    braceDepth++;
                else if (json[i] === '}') {
                    braceDepth--;
                    if (braceDepth === 0) {
                        jsonEnd = i + 1;
                        break;
                    }
                }
            }
            if (jsonEnd > 0) {
                json = json.slice(0, jsonEnd);
            }
        }
        let sanitized = json
            // Convert single quotes to double quotes for JSON strings
            // Handle: 'value' -> "value" but be careful with apostrophes
            .replace(/'([^'\\]*)'/g, '"$1"')
            // Fix smart quotes -> straight quotes
            .replace(/[\u201c\u201d]/g, '"')
            .replace(/[\u2018\u2019]/g, "'")
            // Fix incomplete Unicode escapes: \u{...} -> \\u{...} 
            .replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u')
            // Fix missing colons after "arguments" or "params"
            .replace(/,\s*(arguments|params)\s*:/gi, ',"$1":')
            .replace(/,\s*(arguments|params)\s*\{/gi, ',"$1":{')
            // Fix unquoted property names
            .replace(/([{,])\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
            // Fix unquoted string values after colons
            .replace(/:\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*([,}])/g, ':"$1"$2');
        // Fix unescaped newlines within JSON strings (very common)
        // We find string content and replace raw newlines with \n
        // This is a bit risky but usually necessary for model output
        sanitized = sanitized.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/gs, (match, p1) => {
            return `"${p1.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
        });
        return sanitized;
    }
    /**
     * Extract JSON objects from a string, properly handling nested braces
     */
    extractJsonObjects(text) {
        const objects = [];
        let depth = 0;
        let start = -1;
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (char === '{') {
                if (depth === 0) {
                    start = i;
                }
                depth++;
            }
            else if (char === '}') {
                depth--;
                if (depth === 0 && start !== -1) {
                    const candidate = text.slice(start, i + 1);
                    // Only include if it looks like a tool call (has "name" key)
                    if (candidate.includes('"name"')) {
                        objects.push(candidate);
                    }
                    start = -1;
                }
            }
        }
        return objects;
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