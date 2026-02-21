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
const SYSTEM_PROMPT = `You are Falcon, an expert AI coding assistant. You solve tasks by using tools.

## Operating Environment
OS: ${process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'}
Shell: ${process.platform === 'win32' ? 'powershell/cmd' : 'bash'}

## Critical Rules
- When asked to write code, IMMEDIATELY call write_file. Do NOT write code in your response.
- When asked about existing code, call read_file first.
- To compile or run code, call run_command.
- NEVER explain how you would implement something. Just DO it with tools.
- After receiving tool results, either call another tool or give a SHORT final answer.

## Available Tools
<tools>
{TOOL_DEFINITIONS}
</tools>

## Tool Call Format
You MUST use this EXACT format. Every <tool_call> MUST have a matching </tool_call>.
<tool_call>
{"name": "tool_name", "arguments": {"param": "value"}}
</tool_call>

IMPORTANT: Always close each tool call with </tool_call> BEFORE starting the next one.

## Example: Single tool
<tool_call>
{"name": "write_file", "arguments": {"path": "hello.py", "content": "print('Hello!')"}}
</tool_call>

## Example: Multiple tools
<tool_call>
{"name": "write_file", "arguments": {"path": "main.rs", "content": "fn main() { println!(\\"Hello\\"); }"}}
</tool_call>
<tool_call>
{"name": "run_command", "arguments": {"command": "rustc main.rs && ./main"}}
</tool_call>

Working directory: {WORKSPACE}

Respond ONLY with tool_call blocks. No explanations.`;
class AgentChat {
    llm;
    tools;
    conversationHistory = [];
    maxHistoryLength = 10;
    hasWrittenFile = false;
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
            stream.markdown('❌ **No workspace folder open!**\n\nPlease open a folder first: **File → Open Folder...**');
            vscode.window.showErrorMessage('Please open a folder or workspace before using the agent.');
            return {};
        }
        const workspaceRoot = workspaceFolder.uri.fsPath;
        const toolContext = {
            workspaceRoot,
            cancellationToken: token,
            requireConfirmation,
            allowedCommands
        };
        // Auto-chain context bypasses confirmation for internal compile/run commands
        const autoChainContext = {
            workspaceRoot,
            cancellationToken: token,
            requireConfirmation: false,
            allowedCommands: ['rustc', 'gcc', 'g++', 'python', 'node', 'npm', 'git', ...allowedCommands]
        };
        // Core tools list for validation
        const coreTools = ['write_file', 'run_command', 'read_file', 'edit_file', 'web_search'];
        // Reset session state
        this.hasWrittenFile = false;
        const toolDefs = this.tools.getToolDefinitions().map(d => JSON.stringify(d)).join('\n');
        const systemPrompt = SYSTEM_PROMPT
            .replace('{WORKSPACE}', workspaceRoot)
            .replace('{TOOL_DEFINITIONS}', toolDefs);
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
                // Get LLM response — force tool call via prefix injection
                let fullResponse = '';
                let pendingToolCalls = [];
                // Pre-fill assistant with tool call start to prevent rambling
                const toolCallPrefix = '<tool_call>\n{"name": "';
                const prefixedMessages = [
                    ...messages,
                    { role: 'assistant', content: toolCallPrefix }
                ];
                let toolCallText = '';
                for await (const chunk of this.llm.streamChat(prefixedMessages, undefined, (toolCalls) => pendingToolCalls.push(...toolCalls), ['</tool_call>'] // Only stop at closing tag
                )) {
                    toolCallText += chunk;
                }
                // Reconstruct: prefix + generated text
                fullResponse = toolCallPrefix + toolCallText;
                const parsedToolCalls = this.parseToolCalls(fullResponse);
                const allToolCalls = [...pendingToolCalls, ...parsedToolCalls];
                // If no tool calls found, check for code blocks in the text
                if (allToolCalls.length === 0) {
                    // Try to extract code from markdown response
                    const codeBlockMatch = fullResponse.match(/```(?:rust|rs|c|cpp|python|py|javascript|js)\s*\n([\s\S]*?)```/);
                    if (codeBlockMatch && codeBlockMatch[1].trim().length > 20) {
                        const langTag = fullResponse.match(/```(\w+)/)?.[1] || 'rs';
                        const extMap = { rust: 'rs', rs: 'rs', c: 'c', cpp: 'cpp', python: 'py', py: 'py', javascript: 'js', js: 'js' };
                        const ext = extMap[langTag] || 'rs';
                        const promptLower = request.prompt.toLowerCase();
                        let fileName = `main.${ext}`;
                        if (promptLower.includes('atkins'))
                            fileName = `atkins_sieve.${ext}`;
                        else if (promptLower.includes('eratosthenes'))
                            fileName = `eratosthenes_sieve.${ext}`;
                        else if (promptLower.includes('fibonacci'))
                            fileName = `fibonacci.${ext}`;
                        else if (promptLower.includes('hello'))
                            fileName = `hello_world.${ext}`;
                        else if (promptLower.includes('sort'))
                            fileName = `sort.${ext}`;
                        stream.markdown(`\n📝 *Extracted code from response, writing to \`${fileName}\`...*\n`);
                        const writeResult = await this.tools.executeTool('write_file', { path: fileName, content: codeBlockMatch[1].trim() }, toolContext);
                        stream.markdown(`**Result:** ${writeResult.split('\n')[0]}\n\n`);
                        if (writeResult.includes('Successfully wrote')) {
                            this.hasWrittenFile = true;
                            await this.autoChainCompileRun(fileName, stream, autoChainContext, messages, token);
                        }
                        break;
                    }
                    // No code blocks either - just stop
                    if (iteration > 1) {
                        stream.markdown(`\n✅ *Task complete.*\n`);
                        break;
                    }
                    this.addToHistory({ role: 'user', content: request.prompt });
                    this.addToHistory({ role: 'assistant', content: fullResponse });
                    stream.markdown(fullResponse);
                    break;
                }
                // Add assistant message with tool calls embedded in content
                let assistantContent = fullResponse;
                if (!assistantContent.includes('<tool_call>')) {
                    for (const tc of allToolCalls) {
                        assistantContent += `\n<tool_call>\n{"name": "${tc.function.name}", "arguments": ${tc.function.arguments}}\n</tool_call>`;
                    }
                }
                messages.push({ role: 'assistant', content: assistantContent });
                // Execute each tool call and collect results for auto-chaining
                const completedWriteFiles = [];
                for (const toolCall of allToolCalls) {
                    if (token.isCancellationRequested)
                        break;
                    const toolName = toolCall.function.name;
                    // Block non-core tools
                    if (!coreTools.includes(toolName)) {
                        const result = `Error: Tool "${toolName}" is not available. Use write_file to create code.`;
                        stream.markdown(`⚠️ *Blocked: ${toolName} is not available. Use write_file.*\n`);
                        messages.push({ role: 'user', content: `<tool_response>\n${result}\n</tool_response>` });
                        continue;
                    }
                    let toolArgs = {};
                    try {
                        let argsString = toolCall.function.arguments
                            .replace(/[\u201c\u201d]/g, '"')
                            .replace(/[\u2018\u2019]/g, "'")
                            .replace(/\\u[0-9a-fA-F]{0,3}(?![0-9a-fA-F])/g, '');
                        toolArgs = JSON.parse(argsString);
                    }
                    catch {
                        // Fallback: try to rescue the arguments using the regex extractor
                        const syntheizedJson = `{"name": "${toolName}", "arguments": ${toolCall.function.arguments}}`;
                        const dummyCalls = [];
                        this.rescueToolCall(syntheizedJson, dummyCalls);
                        if (dummyCalls.length > 0) {
                            try {
                                toolArgs = JSON.parse(dummyCalls[0].function.arguments);
                            }
                            catch { /* skip */ }
                        }
                    }
                    // ENFORCE: write_file must come before run_command (except for enumeration)
                    if (toolName === 'run_command' && !this.hasWrittenFile) {
                        const cmd = (toolArgs.command || '').toLowerCase();
                        const isEnumerate = ['ls', 'dir', 'pwd', 'env', 'whoami', 'ver', 'rustc --version', 'node --version', 'python --version', 'gcc --version', 'g++ --version'].some(e => cmd.includes(e));
                        if (!isEnumerate) {
                            const result = `Error: You must use write_file FIRST to create the code before running commands like compilation or execution. However, you MAY use run_command for environment enumeration (e.g., ls, dir, env).`;
                            stream.markdown(`⚠️ *Blocked: Only enumeration commands allowed before write_file.*\n`);
                            messages.push({ role: 'user', content: `<tool_response>\n${result}\n</tool_response>` });
                            continue;
                        }
                    }
                    // Show tool execution in UI
                    stream.markdown(`\n\n---\n**🔧 Executing:** \`${toolName}\``);
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
                    // Show concise result preview
                    let resultPreview = '';
                    if (toolName === 'read_file') {
                        const pathMatch = result.match(/from\s+([^\n\r:\s]+)/);
                        const displayPath = pathMatch ? pathMatch[1] : toolArgs.path;
                        const lines = result.split('\n').filter((l) => l.trim().length > 0).length;
                        resultPreview = ` Read from \`${displayPath}\` (${lines} lines)`;
                    }
                    else if (toolName === 'edit_file' || toolName === 'write_file' || toolName === 'append_file') {
                        resultPreview = result.split('\n')[0];
                    }
                    else {
                        resultPreview = result.length > 500
                            ? ` Success (${result.length} characters)\n\`\`\`\n${result.slice(0, 200)}...\n\`\`\``
                            : `\`\`\`\n${result}\n\`\`\``;
                    }
                    stream.markdown(`**Result:** ${resultPreview}\n\n`);
                    // Track successful write_file calls for auto-chaining
                    if (toolName === 'write_file' && result.includes('Successfully wrote')) {
                        this.hasWrittenFile = true;
                        const filePath = toolArgs.path || '';
                        if (filePath)
                            completedWriteFiles.push(filePath);
                    }
                    // Add tool result to messages
                    messages.push({ role: 'user', content: `<tool_response>\n${result}\n</tool_response>` });
                }
                // AUTO-CHAIN: After write_file on code files, automatically compile and run
                if (completedWriteFiles.length > 0) {
                    const lastFile = completedWriteFiles[completedWriteFiles.length - 1];
                    await this.autoChainCompileRun(lastFile, stream, autoChainContext, messages, token);
                    break;
                }
            }
            // Warn if max iterations reached
            if (iteration >= maxIterations) {
                stream.markdown('\n\n⚠ *Reached maximum iterations. Task may be incomplete.*');
            }
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            stream.markdown(`\n\n❌ **Error:** ${errorMessage}`);
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
     * Auto-chain: compile and run a code file
     * Uses a permissive context that bypasses command confirmation
     */
    async autoChainCompileRun(filePath, stream, ctx, messages, token) {
        if (token.isCancellationRequested)
            return;
        const ext = filePath.split('.').pop()?.toLowerCase();
        const baseName = filePath.replace(/\.[^.]+$/, '');
        let compileCmd = '';
        let runCmd = '';
        if (ext === 'rs') {
            compileCmd = `rustc "${filePath}" -o "${baseName}.exe"`;
            runCmd = `".\\${baseName}.exe"`;
        }
        else if (ext === 'c') {
            compileCmd = `gcc "${filePath}" -o "${baseName}.exe"`;
            runCmd = `".\\${baseName}.exe"`;
        }
        else if (ext === 'cpp') {
            compileCmd = `g++ "${filePath}" -o "${baseName}.exe"`;
            runCmd = `".\\${baseName}.exe"`;
        }
        else if (ext === 'py') {
            runCmd = `python "${filePath}"`;
        }
        else if (ext === 'js') {
            runCmd = `node "${filePath}"`;
        }
        // Compile if needed
        if (compileCmd) {
            stream.markdown(`\n---\n**🔨 Auto-compiling:** \`${compileCmd}\`\n\n`);
            try {
                const compileResult = await this.tools.executeTool('run_command', { command: compileCmd }, ctx);
                const compileSuccess = !compileResult.toLowerCase().includes('error');
                stream.markdown(`**Result:** \`\`\`\n${compileResult.slice(0, 500)}\n\`\`\`\n\n`);
                messages.push({ role: 'user', content: `<tool_response>\nCompile result:\n${compileResult}\n</tool_response>` });
                if (!compileSuccess) {
                    stream.markdown(`⚠️ *Compilation failed.*\n`);
                    return;
                }
            }
            catch (e) {
                stream.markdown(`⚠️ *Compile error: ${e instanceof Error ? e.message : 'unknown'}*\n`);
                return;
            }
        }
        // Run if we have a run command
        if (runCmd) {
            stream.markdown(`\n---\n**▶️ Auto-running:** \`${runCmd}\`\n\n`);
            try {
                const runResult = await this.tools.executeTool('run_command', { command: runCmd }, ctx);
                stream.markdown(`**Output:** \`\`\`\n${runResult.slice(0, 500)}\n\`\`\`\n\n`);
                messages.push({ role: 'user', content: `<tool_response>\nExecution result:\n${runResult}\n</tool_response>` });
            }
            catch (e) {
                stream.markdown(`⚠️ *Run error: ${e instanceof Error ? e.message : 'unknown'}*\n`);
                return;
            }
        }
        stream.markdown(`\n✅ *Done!*\n`);
    }
    /**
     * Parse tool calls from model output text
     */
    parseToolCalls(response) {
        const calls = [];
        // Strip out <think> blocks (could contain hypothetical tool calls that shouldn't execute)
        response = response.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
        // Pattern 1: ```tool_call\n{...}\n```
        const toolCallBlockRegex = /```(?:tool_call|json)?\s*\n?\s*(\{[\s\S]*?"name"[\s\S]*?\})\s*\n?```/gi;
        let match;
        while ((match = toolCallBlockRegex.exec(response)) !== null) {
            try {
                const parsed = JSON.parse(match[1]);
                const { name, arguments: args, parameters: params, ...rest } = parsed;
                if (name) {
                    let finalArgs = args || params;
                    if (!finalArgs && Object.keys(rest).length > 0)
                        finalArgs = rest;
                    calls.push({
                        id: `call_${Date.now()}_${calls.length}`,
                        type: 'function',
                        function: {
                            name: name,
                            arguments: typeof finalArgs === 'string' ? finalArgs : JSON.stringify(finalArgs || {})
                        }
                    });
                }
            }
            catch { /* skip */ }
        }
        // Pattern 2: <tool_call>...</tool_call> or <tool_call>...}} (unclosed)
        if (calls.length === 0) {
            const segments = response.split('<tool_call>');
            for (const segment of segments) {
                let jsonStr = segment.replace(/<\/tool_call>/g, '').trim();
                if (!jsonStr || !jsonStr.includes('{') || !jsonStr.includes('}'))
                    continue;
                try {
                    jsonStr = jsonStr.substring(jsonStr.indexOf('{'), jsonStr.lastIndexOf('}') + 1);
                    const parsed = JSON.parse(this.sanitizeJson(jsonStr));
                    const { name, arguments: args, parameters: params, ...rest } = parsed;
                    if (name) {
                        let finalArgs = args || params;
                        if (!finalArgs && Object.keys(rest).length > 0)
                            finalArgs = rest;
                        calls.push({
                            id: `call_${Date.now()}_${calls.length}`,
                            type: 'function',
                            function: {
                                name: name,
                                arguments: typeof finalArgs === 'string' ? finalArgs : JSON.stringify(finalArgs || {})
                            }
                        });
                    }
                }
                catch {
                    this.rescueToolCall(jsonStr, calls);
                }
            }
        }
        // Pattern 3: Raw JSON objects with "name" field
        if (calls.length === 0) {
            const jsonObjects = this.extractJsonObjects(response);
            for (const jsonStr of jsonObjects) {
                try {
                    const sanitized = this.sanitizeJson(jsonStr);
                    const parsed = JSON.parse(sanitized);
                    const { name, arguments: args, parameters: params, ...rest } = parsed;
                    if (name && typeof name === 'string') {
                        let finalArgs = args || params;
                        if (!finalArgs && Object.keys(rest).length > 0)
                            finalArgs = rest;
                        calls.push({
                            id: `call_${Date.now()}_${calls.length}`,
                            type: 'function',
                            function: {
                                name: name,
                                arguments: typeof finalArgs === 'string' ? finalArgs : JSON.stringify(finalArgs || {})
                            }
                        });
                    }
                }
                catch { /* skip */ }
            }
        }
        return calls;
    }
    /**
     * Rescue a tool call from broken JSON using regex extraction.
     * Handles cases where JSON.parse fails but the tool name, path, etc are identifiable.
     */
    rescueToolCall(jsonStr, calls) {
        const nameMatch = jsonStr.match(/"name"\s*[:=]\s*"(\w+)"/);
        if (!nameMatch)
            return;
        const toolName = nameMatch[1];
        if (toolName === 'write_file' || toolName === 'append_file') {
            let path = 'untitled';
            const pathMatch = jsonStr.match(/"path"\s*[:=]\s*"([^"]+)"/);
            if (pathMatch) {
                path = pathMatch[1];
            }
            // Extract content: try standard keys first
            let contentKeyIdx = jsonStr.indexOf('"content"');
            if (contentKeyIdx < 0)
                contentKeyIdx = jsonStr.indexOf('"text"');
            if (contentKeyIdx < 0)
                contentKeyIdx = jsonStr.indexOf('"code"');
            let content = '';
            if (contentKeyIdx >= 0) {
                const afterKey = jsonStr.substring(contentKeyIdx);
                const contentStart = afterKey.match(/"(?:content|text|code)"\s*[:=]\s*(?:r#)?"/);
                if (contentStart) {
                    content = afterKey.substring(contentStart[0].length);
                }
            }
            if (!content) {
                // Aggressive rescue: find what looks like a raw string right after the path
                const pathMatchStr = jsonStr.match(/"path"\s*[:=]\s*"[^"]+"\s*(?:}|\])?\s*,\s*(?:r#)?"/);
                if (pathMatchStr) {
                    const startIdx = pathMatchStr.index + pathMatchStr[0].length;
                    content = jsonStr.substring(startIdx);
                }
                else {
                    return;
                }
            }
            // Strip trailing JSON structure: "}} or similar
            content = content.replace(/["\s}]*$/, '');
            // Remove trailing incomplete escape: backslash at end
            content = content.replace(/\\$/, '');
            // Unescape JSON string escapes manually
            content = content
                .replace(/\\n/g, '\n')
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\')
                .replace(/\\t/g, '\t')
                .replace(/\\r/g, '\r');
            calls.push({
                id: `call_${Date.now()}_${calls.length}`,
                type: 'function',
                function: {
                    name: toolName,
                    arguments: JSON.stringify({ path, content })
                }
            });
        }
        else {
            // For other tools: try to extract arguments object, allowing for } inside strings
            const argsMatch = jsonStr.match(/"?arguments"?\s*[:=]\s*(\{.*)/s);
            if (argsMatch) {
                try {
                    let extracted = argsMatch[1];
                    extracted = extracted.replace(/}<\/tool_call>\s*$/, '}');
                    extracted = extracted.replace(/}\s*}$/, '}');
                    const args = JSON.parse(this.sanitizeJson(extracted));
                    calls.push({
                        id: `call_${Date.now()}_${calls.length}`,
                        type: 'function',
                        function: { name: toolName, arguments: JSON.stringify(args) }
                    });
                }
                catch { /* can't rescue */ }
            }
        }
    }
    /**
     * Sanitize malformed JSON from model output
     */
    sanitizeJson(json) {
        let braceDepth = 0;
        let inString = false;
        let escapeNext = false;
        let objectStarted = false;
        let sanitizedChars = [];
        for (let i = 0; i < json.length; i++) {
            const char = json[i];
            if (escapeNext) {
                sanitizedChars.push(char);
                escapeNext = false;
                continue;
            }
            if (char === '\\') {
                sanitizedChars.push(char);
                escapeNext = true;
                continue;
            }
            if (char === '"') {
                inString = !inString;
            }
            else if (!inString) {
                if (char === '{') {
                    braceDepth++;
                    objectStarted = true;
                }
                else if (char === '}') {
                    braceDepth--;
                }
            }
            else {
                // We are inside a string. If we see a literal newline, escape it.
                if (char === '\n') {
                    sanitizedChars.push('\\', 'n');
                    continue;
                }
                else if (char === '\r') {
                    sanitizedChars.push('\\', 'r');
                    continue;
                }
                else if (char === '\t') {
                    sanitizedChars.push('\\', 't');
                    continue;
                }
            }
            sanitizedChars.push(char);
            if (objectStarted && braceDepth === 0) {
                break;
            }
        }
        let cutJson = sanitizedChars.join('');
        if (braceDepth > 0) {
            cutJson += '}'.repeat(braceDepth);
        }
        let sanitized = cutJson
            .replace(/r#"/g, '"')
            .replace(/"#/g, '"')
            .replace(/String\(\d+\)\.toString\(\)/g, '""')
            .replace(/[\u201c\u201d]/g, '"')
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/(?<!\\)\\u(?![0-9a-fA-F]{4})/g, '\\\\u');
        return sanitized;
    }
    /**
     * Extract JSON objects from text, handling nested braces
     */
    extractJsonObjects(text) {
        const objects = [];
        let depth = 0;
        let start = -1;
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '{') {
                if (depth === 0)
                    start = i;
                depth++;
            }
            else if (text[i] === '}') {
                depth--;
                if (depth === 0 && start !== -1) {
                    const candidate = text.slice(start, i + 1);
                    if (candidate.includes('"name"'))
                        objects.push(candidate);
                    start = -1;
                }
            }
        }
        return objects;
    }
    addToHistory(message) {
        this.conversationHistory.push(message);
        while (this.conversationHistory.length > this.maxHistoryLength * 2) {
            this.conversationHistory.shift();
            this.conversationHistory.shift();
        }
    }
    clearHistory() {
        this.conversationHistory = [];
    }
    getHistory() {
        return [...this.conversationHistory];
    }
}
exports.AgentChat = AgentChat;
//# sourceMappingURL=agent.js.map