"use strict";
/**
 * Chat View Provider - Sidebar webview for the agentic assistant
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
exports.ChatViewProvider = void 0;
const vscode = __importStar(require("vscode"));
const SHARED_SYSTEM_PROMPT = `You are Falcon, an expert AI coding assistant. You solve tasks by using tools.

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

Working directory: {WORKSPACE}`;
class ChatViewProvider {
    _extensionUri;
    llmClient;
    tools;
    static viewType = 'agentic.chatView';
    _view;
    messages = [];
    isProcessing = false;
    log;
    maxContextMessages = 10;
    hasWrittenFile = false;
    constructor(_extensionUri, llmClient, tools) {
        this._extensionUri = _extensionUri;
        this.llmClient = llmClient;
        this.tools = tools;
        this.log = vscode.window.createOutputChannel('Agent Chat (Logs)');
    }
    getSystemPrompt() {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const toolDefs = this.tools.getToolDefinitions().map(d => JSON.stringify(d)).join('\n');
        return SHARED_SYSTEM_PROMPT
            .replace('{WORKSPACE}', workspaceRoot || 'NO_WORKSPACE_OPEN')
            .replace('{TOOL_DEFINITIONS}', toolDefs);
    }
    resolveWebviewView(webviewView, _context, _token) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        webviewView.webview.html = this.getHtmlContent();
        if (this.messages.length === 0) {
            this.messages.push({
                role: 'system',
                content: this.getSystemPrompt()
            });
        }
        webviewView.webview.onDidReceiveMessage(async (data) => {
            this.log.appendLine(`[Webview Message]: ${JSON.stringify(data)}`);
            switch (data.command) {
                case 'sendMessage':
                    await this.handleUserMessage(data.text);
                    break;
                case 'ping':
                    this._view?.webview.postMessage({ command: 'pong', timestamp: Date.now() });
                    break;
                case 'clearChat':
                    this.messages = [{ role: 'system', content: this.getSystemPrompt() }];
                    this.hasWrittenFile = false;
                    this.postUpdate();
                    break;
                case 'stopGeneration':
                    this.llmClient.abort();
                    this.isProcessing = false;
                    this.postUpdate();
                    break;
                case 'refresh':
                    this.postUpdate();
                    break;
            }
        });
    }
    async handleUserMessage(text) {
        if (this.isProcessing)
            return;
        this.messages.push({ role: 'user', content: text });
        this.postUpdate();
        await this.runAgentLoop();
    }
    async runAgentLoop() {
        this.isProcessing = true;
        this.postUpdate();
        let iterations = 0;
        const config = vscode.workspace.getConfiguration('agentic');
        const maxIterations = config.get('agent.maxIterations', 15);
        const requireConfirmation = config.get('tools.requireConfirmation', true);
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const getBaseContext = (confirm) => ({
            workspaceRoot,
            requireConfirmation: confirm,
            allowedCommands: ['npm', 'node', 'git', 'python', 'rustc', 'cargo'],
            onConfirmCommand: async (cmd) => {
                const sel = await vscode.window.showInformationMessage(`Run: ${cmd}`, { modal: true }, 'Run', 'Cancel');
                return sel === 'Run';
            }
        });
        this.hasWrittenFile = false;
        let consecutiveFailures = 0;
        try {
            while (iterations < maxIterations && this.isProcessing) {
                iterations++;
                let assistantMsg = { role: 'assistant', content: '' };
                this.messages.push(assistantMsg);
                this.postUpdate();
                let toolCallsFromStream = [];
                try {
                    let historyToKeep = this.messages.slice(0, -1);
                    if (historyToKeep.length > this.maxContextMessages) {
                        historyToKeep = [historyToKeep[0], ...historyToKeep.slice(-this.maxContextMessages + 1)];
                    }
                    // Force tool call by pre-filling the assistant response
                    // This structurally prevents the model from rambling
                    const toolCallPrefix = '<tool_call>\n{"name": "';
                    const prefixedMessages = [
                        ...historyToKeep,
                        { role: 'assistant', content: toolCallPrefix }
                    ];
                    let toolCallText = '';
                    const stream = this.llmClient.streamChat(prefixedMessages, undefined, (tc) => { toolCallsFromStream = tc; }, ['</tool_call>'] // Only stop at closing tag
                    );
                    for await (const chunk of stream) {
                        toolCallText += chunk;
                        // Show generation progress
                        assistantMsg.content = '⚡ Generating...\n' + toolCallPrefix + toolCallText;
                        this._view?.webview.postMessage({
                            command: 'streamChunk',
                            content: assistantMsg.content
                        });
                    }
                    // Reconstruct: prefix + generated text
                    const fullResponse = toolCallPrefix + toolCallText;
                    assistantMsg.content = fullResponse;
                    const parsedCalls = this.parseToolCalls(fullResponse);
                    let allToolCalls = [...toolCallsFromStream, ...parsedCalls];
                    // Fallback: extract code blocks from response if no write_file tool call is found
                    const hasWriteFile = allToolCalls.some(tc => tc.function.name === 'write_file' || tc.function.name === 'append_file');
                    if (!hasWriteFile) {
                        // Match code blocks lazily up to closing backticks OR the end of string (for unclosed blocks)
                        const codeBlockRegex = /```(?:rust|rs|python|py|javascript|js|c|cpp|typescript|ts|html|css|java|go|php|ruby|swift|kotlin|sh|bash|json)\s*\n([\s\S]*?)(?:```|$)/;
                        const codeBlock = fullResponse.match(codeBlockRegex);
                        if (codeBlock && codeBlock[1].trim().length > 50) {
                            const langTagMatch = fullResponse.match(/```(\w+)/);
                            const langTag = langTagMatch ? langTagMatch[1].toLowerCase() : 'rs';
                            const extMap = { rust: 'rs', rs: 'rs', c: 'c', cpp: 'cpp', python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', html: 'html', css: 'css', java: 'java', go: 'go', php: 'php', ruby: 'rb', swift: 'swift', kotlin: 'kt', sh: 'sh', bash: 'sh', json: 'json' };
                            const ext = extMap[langTag] || 'txt';
                            const userMsg = this.messages.find(m => m.role === 'user');
                            const promptLower = (userMsg?.content || '').toLowerCase();
                            let fileName = `snippet.${ext}`;
                            if (promptLower.includes('atkin'))
                                fileName = `sieve_of_atkin.${ext}`;
                            else if (promptLower.includes('eratosthenes'))
                                fileName = `sieve_eratosthenes.${ext}`;
                            else if (promptLower.includes('fibonacci'))
                                fileName = `fibonacci.${ext}`;
                            else if (promptLower.includes('hello'))
                                fileName = `hello.${ext}`;
                            else if (promptLower.includes('sort'))
                                fileName = `sort.${ext}`;
                            allToolCalls.push({
                                id: `call_${Date.now()}_fallback`,
                                type: 'function',
                                function: {
                                    name: 'write_file',
                                    arguments: JSON.stringify({ path: fileName, content: codeBlock[1].trim() })
                                }
                            });
                            // Remove the massive code block from the chat to prevent context overflow 
                            assistantMsg.content = assistantMsg.content.replace(codeBlockRegex, '\n_[Code automatically extracted to file by UI]_\n');
                        }
                    }
                    if (allToolCalls.length === 0) {
                        consecutiveFailures++;
                        if (consecutiveFailures >= 3) {
                            assistantMsg.content = 'Failed to generate valid tool call after retries. Raw output:\n' + fullResponse;
                            this.postUpdate();
                            break;
                        }
                        this.messages.push({
                            role: 'assistant',
                            content: fullResponse
                        });
                        this.messages.push({
                            role: 'tool',
                            name: 'error',
                            content: 'ERROR: Your tool call contained invalid JSON. Use simple, short code. Escape all quotes and newlines properly. Try again.'
                        });
                        this.postUpdate();
                        continue;
                    }
                    consecutiveFailures = 0;
                    for (const tc of allToolCalls) {
                        const toolName = tc.function.name;
                        let args = {};
                        try {
                            args = JSON.parse(this.sanitizeJson(tc.function.arguments));
                        }
                        catch (e) {
                            // Fallback: try to rescue the arguments using the regex extractor
                            const syntheizedJson = `{"name": "${toolName}", "arguments": ${tc.function.arguments}}`;
                            const dummyCalls = [];
                            this.rescueToolCall(syntheizedJson, dummyCalls);
                            if (dummyCalls.length > 0) {
                                try {
                                    args = JSON.parse(this.sanitizeJson(dummyCalls[0].function.arguments));
                                }
                                catch { /* skip */ }
                            }
                        }
                        const res = await this.tools.executeTool(toolName, args, getBaseContext(requireConfirmation));
                        this.messages.push({ role: 'tool', name: toolName, content: res });
                    }
                    this.postUpdate();
                }
                catch (error) {
                    assistantMsg.content += `\n\n[Error]: ${error}`;
                    this.postUpdate();
                    break;
                }
            }
        }
        finally {
            this.isProcessing = false;
            this.postUpdate();
        }
    }
    parseToolCalls(response) {
        const calls = [];
        // Strip out <think> blocks (could contain hypothetical tool calls that shouldn't execute)
        response = response.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
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
                // Regex rescue: extract tool calls from broken JSON
                this.rescueToolCall(jsonStr, calls);
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
            else {
                // Determine path based on content loosely
                if (jsonStr.toLowerCase().includes('atkin'))
                    path = 'sieve_of_atkin.rs';
                else if (jsonStr.toLowerCase().includes('eratosthenes'))
                    path = 'sieve_eratosthenes.rs';
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
    postUpdate() {
        this._view?.webview.postMessage({ command: 'update', messages: this.messages, isProcessing: this.isProcessing });
    }
    getHtmlContent() {
        // The webview JavaScript is built as a plain string to avoid
        // template-literal escape-sequence processing, which silently
        // corrupts regex patterns like \s \S \n inside backtick strings.
        const S = '\\'; // single backslash helper
        const BS = S + 's'; // produces the two-char string: \s
        const BSS = S + 'S'; // produces: \S
        const BN = S + 'n'; // produces: \n
        const script = [
            'var vscode = acquireVsCodeApi();',
            'var msgDiv = document.getElementById("messages");',
            'var input = document.getElementById("input");',
            'var linkStatus = document.getElementById("link-status");',
            'var sentCount = document.getElementById("sent-count");',
            'var lastEvent = document.getElementById("last-event");',
            'var count = 0;',
            '',
            'function logEvent(msg) {',
            '  lastEvent.innerText = msg;',
            '  console.log("[Falcon Debug]:", msg);',
            '}',
            '',
            'function formatContent(content) {',
            '  if (!content) return "";',
            '  var re1 = new RegExp("<tool_call>[' + BS + BSS + ']*?</tool_call>", "gi");',
            '  var re2 = new RegExp("<tool_call>[' + BS + BSS + ']*?$", "gi");',
            '  var re3 = new RegExp("<tools>[' + BS + BSS + ']*?</tools>", "gi");',
            '  var clean = content.replace(re1, "").replace(re2, "").replace(re3, "");',
            '  var html = clean.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");',
            '  var re4 = new RegExp("&lt;think&gt;([' + BS + BSS + ']*?)&lt;/think&gt;", "g");',
            '  var re5 = new RegExp("&lt;think&gt;([' + BS + BSS + ']*?)$", "g");',
            '  html = html.replace(re4, \'<div class="thinking"><div class="thinking-title">Thinking</div>$1</div>\');',
            '  html = html.replace(re5, \'<div class="thinking"><div class="thinking-title">Thinking...</div>$1</div>\');',
            '  html = html.replace(/' + BN + '/g, "<br>");',
            '  return html.trim() || "...";',
            '}',
            '',
            'function trySend() {',
            '  var text = input.value.trim();',
            '  console.log("[Falcon] trySend:", text);',
            '  if (text) {',
            '    count++;',
            '    sentCount.innerText = count;',
            '    logEvent("Sending...");',
            '    vscode.postMessage({ command: "sendMessage", text: text });',
            '    input.value = "";',
            '    input.style.height = "auto";',
            '  }',
            '}',
            '',
            'document.getElementById("send-btn").addEventListener("click", function() {',
            '  logEvent("Btn Click");',
            '  trySend();',
            '});',
            '',
            'input.addEventListener("keydown", function(e) {',
            '  if (e.keyCode === 13 && !e.shiftKey) {',
            '    e.preventDefault();',
            '    logEvent("Enter Pressed");',
            '    trySend();',
            '  }',
            '});',
            '',
            'window.addEventListener("message", function(e) {',
            '  var data = e.data;',
            '  if (data.command === "update") {',
            '    linkStatus.innerText = "CONNECTED";',
            '    linkStatus.className = "status-ok";',
            '    logEvent("UI Update");',
            '    msgDiv.innerHTML = data.messages.filter(function(m) { return m.role !== "system"; }).map(function(m) {',
            '      var role = m.role.toUpperCase();',
            '      return \'<div class="message \' + m.role + \'"><div class="message-role">\' + role + \'</div><div class="message-content">\' + formatContent(m.content) + \'</div></div>\';',
            '    }).join("");',
            '    msgDiv.scrollTop = msgDiv.scrollHeight;',
            '  } else if (data.command === "streamChunk") {',
            '    var containers = document.querySelectorAll(".message.assistant .message-content");',
            '    if (containers.length > 0) {',
            '      containers[containers.length - 1].innerHTML = formatContent(data.content);',
            '      msgDiv.scrollTop = msgDiv.scrollHeight;',
            '      logEvent("Streaming...");',
            '    }',
            '  } else if (data.command === "pong") {',
            '    logEvent("PONG");',
            '    alert("v0.1.7 Connection OK!");',
            '  }',
            '});',
            '',
            'logEvent("Ready v0.1.7");',
            'vscode.postMessage({ command: "ping" });',
        ].join('\n');
        const css = `
            :root { --bg: var(--vscode-sideBar-background); --fg: var(--vscode-sideBar-foreground); --accent: var(--vscode-button-background); --border: var(--vscode-panel-border); }
            body { font-family: var(--vscode-font-family); background: var(--bg); color: var(--fg); height: 100vh; display: flex; flex-direction: column; overflow: hidden; margin: 0; font-size: 11px; }
            #toolbar { padding: 4px; border-bottom: 1px solid var(--border); display: flex; gap: 4px; background: var(--bg); }
            #toolbar button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 2px 8px; border-radius: 2px; cursor: pointer; font-size: 10px; }
            #messages { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
            .message { max-width: 95%; padding: 8px; border-radius: 4px; position: relative; word-wrap: break-word; }
            .message.user { align-self: flex-end; background: var(--accent); color: white; }
            .message.assistant { align-self: flex-start; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); }
            .message.tool { align-self: center; background: rgba(100,100,100,0.1); font-family: monospace; font-size: 10px; width: 100%; border-left: 2px solid orange; }
            .message-role { font-weight: bold; font-size: 8px; opacity: 0.5; margin-bottom: 4px; text-transform: uppercase; }
            .thinking { background: rgba(0,0,0,0.2); border: 1px dashed rgba(255,255,255,0.2); padding: 6px; margin-bottom: 8px; border-radius: 4px; font-style: italic; color: rgba(255,255,255,0.5); font-size: 10px; }
            .thinking-title { font-weight: bold; font-style: normal; font-size: 8px; opacity: 0.4; text-transform: uppercase; margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.1); }
            #input-container { padding: 8px; border-top: 1px solid var(--border); background: var(--bg); display: flex; gap: 8px; align-items: flex-end; }
            #input { flex: 1; background: rgba(0,0,0,0.2); color: inherit; border: 1px solid var(--border); padding: 8px; border-radius: 4px; resize: none; min-height: 32px; max-height: 100px; outline: none; }
            #send-btn { background: var(--accent); color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-weight: bold; height: 32px; }
            #debug-panel { padding: 4px 8px; background: #222; color: #888; font-size: 9px; border-top: 1px solid #333; display: flex; justify-content: space-between; }
            .status-ok { color: #4f4; }
            .status-no { color: #f44; }
            pre { background: rgba(0,0,0,0.3); padding: 6px; border-radius: 4px; overflow-x: auto; margin: 4px 0; border: 1px solid rgba(255,255,255,0.1); }
            code { font-family: monospace; font-size: 10px; }
        `;
        return '<!DOCTYPE html><html><head><style>' + css + '</style></head><body>'
            + '<div id="toolbar">'
            + '<button onclick="vscode.postMessage({command:\'clearChat\'})">New Chat</button>'
            + '<button onclick="vscode.postMessage({command:\'stopGeneration\'})">Stop</button>'
            + '<button onclick="vscode.postMessage({command:\'ping\'})">Ping</button>'
            + '</div>'
            + '<div id="messages"></div>'
            + '<div id="input-container">'
            + '<textarea id="input" rows="1" placeholder="Type here..."></textarea>'
            + '<button id="send-btn">SEND</button>'
            + '</div>'
            + '<div id="debug-panel">'
            + '<span>Link: <span id="link-status" class="status-no">WAITING</span></span>'
            + '<span>Sent: <span id="sent-count">0</span></span>'
            + '<span>Last: <span id="last-event">NONE</span></span>'
            + '</div>'
            + '<script>' + script + '</script></body></html>';
    }
}
exports.ChatViewProvider = ChatViewProvider;
//# sourceMappingURL=chatPanel.js.map