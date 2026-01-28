/**
 * Chat View Provider - Sidebar webview for the agentic assistant
 */

import * as vscode from 'vscode';
import { LlamaCppClient, ToolCall } from '../llm/llamaCpp';
import { ToolRegistry } from '../tools/registry';

interface ChatMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
    toolResults?: Array<{ name: string; result: string }>; // For local state tracking
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'agentic.chatView';
    private _view?: vscode.WebviewView;
    private messages: ChatMessage[] = [];
    private isProcessing = false;
    private log: vscode.OutputChannel;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly llmClient: LlamaCppClient,
        private readonly tools: ToolRegistry
    ) {
        this.log = vscode.window.createOutputChannel('Agent Chat (Logs)');
        // Add system message
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        this.messages.push({
            role: 'system',
            content: `You are an expert AI coding assistant running locally. You help developers write, debug, test, and understand code.

## Available Tools
You have access to these tools to accomplish tasks:
1. **web_search** - Search the internet for documentation, APIs, or solutions
2. **run_command** - Execute shell commands (tests, builds, git, etc.)
3. **read_file** - Read file contents (code, configs, etc.)
4. **write_file** - Create or overwrite files
5. **edit_file** - Make targeted edits to existing files
6. **list_directory** - Explore the file system
7. **search_files** - Search for patterns in code (like grep)
8. **read_url** - Fetch documentation from a specific URL

## Guidelines
1. **Think step-by-step** - Before acting, briefly explain your reasoning.
2. **Take ACTION** - Do not just outline code. Use \`write_file\` or \`edit_file\` to implement solutions locally.
3. **Gather context first** - Read relevant files before making changes.
4. **Test your work** - Run commands (like \`cargo test\`, \`npm test\`) to verify changes.
5. **Handle errors gracefully** - If something fails, diagnose and try alternatives.

## Tool Call Format
Respond with a JSON tool call if native calling is not available:
\`\`\`tool_call
{"name": "tool_name", "arguments": {"arg1": "value1"}}
\`\`\`

## Current Context
- Working directory: ${workspaceRoot}
- Operating system: ${process.platform}`
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this.getHtmlContent();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.command) {
                case 'sendMessage':
                    this.log.appendLine(`User: ${data.text}`);
                    await this.handleUserMessage(data.text);
                    break;
                case 'clearChat':
                    this.messages = [this.messages[0]]; // Keep system prompt
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

    private async handleUserMessage(text: string) {
        if (this.isProcessing) return;

        this.messages.push({ role: 'user', content: text });
        this.postUpdate();

        await this.runAgentLoop();
    }

    private async runAgentLoop() {
        this.isProcessing = true;
        this.postUpdate();

        let iterations = 0;
        const maxIterations = 15;

        while (iterations < maxIterations && this.isProcessing) {
            iterations++;

            let assistantMsg: ChatMessage = {
                role: 'assistant',
                content: ''
            };
            this.messages.push(assistantMsg);
            this.postUpdate();

            let toolCalls: ToolCall[] = [];

            try {
                // Keep the prefix stable for KV cache / SSM state reuse
                const promptMessages = this.messages.slice(0, -1).map(m => {
                    const msg: any = {
                        role: m.role,
                        content: m.content
                    };
                    if (m.tool_calls) msg.tool_calls = m.tool_calls;
                    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
                    if (m.name) msg.name = m.name;
                    return msg;
                });

                const stream = this.llmClient.streamChat(
                    promptMessages,
                    this.tools.getToolDefinitions(),
                    (tc) => { toolCalls = tc; }
                );

                this.log.appendLine(`Starting stream for message ${this.messages.length - 1}. Context size: ${promptMessages.length}`);

                let receiveStartTime = Date.now();
                let firstChunk = true;

                for await (const chunk of stream) {
                    if (firstChunk) {
                        this.log.appendLine(`First chunk received after ${Date.now() - receiveStartTime}ms`);
                        firstChunk = false;
                    }
                    assistantMsg.content += chunk;
                    // Send partial update to webview
                    this._view?.webview.postMessage({
                        command: 'streamChunk',
                        index: this.messages.length - 1,
                        content: assistantMsg.content
                    });
                }
                this.log.appendLine(`Stream finished for message ${this.messages.length - 1}. Content length: ${assistantMsg.content.length}`);

                // Parse tool calls from the response text (fallback for models that don't use native tool calling)
                const parsedToolCalls = this.parseToolCalls(assistantMsg.content);
                const allToolCalls = [...toolCalls, ...parsedToolCalls];

                // If tool calls were detected during stream
                if (allToolCalls.length > 0) {
                    assistantMsg.tool_calls = allToolCalls;
                    this.postUpdate();

                    const toolResults: Array<{ name: string; result: string }> = [];
                    for (const toolCall of allToolCalls) {
                        try {
                            this.log.appendLine(`Executing tool: ${toolCall.function.name}`);
                            const args = JSON.parse(toolCall.function.arguments);
                            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                            const config = vscode.workspace.getConfiguration('agentic');

                            const result = await this.tools.executeTool(
                                toolCall.function.name,
                                args,
                                {
                                    workspaceRoot,
                                    requireConfirmation: config.get('tools.requireConfirmation', true),
                                    allowedCommands: config.get<string[]>('tools.allowedCommands', ['npm', 'node', 'git'])
                                }
                            );

                            this.messages.push({
                                role: 'tool',
                                content: result,
                                tool_call_id: toolCall.id,
                                name: toolCall.function.name
                            });
                            toolResults.push({ name: toolCall.function.name, result });
                        } catch (error) {
                            const errorMsg = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
                            this.messages.push({
                                role: 'tool',
                                content: errorMsg,
                                tool_call_id: toolCall.id,
                                name: toolCall.function.name
                            });
                            toolResults.push({
                                name: toolCall.function.name,
                                result: errorMsg
                            });
                        }
                    }
                    assistantMsg.toolResults = toolResults;
                    this.postUpdate();
                    continue; // Loop again for the next assistant turn
                } else {
                    // No more tool calls, regular message finished
                    if (!assistantMsg.content) {
                        assistantMsg.content = 'I apologize, but I could not generate a response.';
                    }
                    this.postUpdate();
                    break;
                }
            } catch (error) {
                if (error instanceof Error && error.name === 'AbortError') {
                    assistantMsg.content += '\n\n[Generation Stopped]';
                } else {
                    assistantMsg.content += `\n\n[Error]: ${error instanceof Error ? error.message : String(error)}`;
                }
                this.postUpdate();
                break;
            }
        }

        this.isProcessing = false;
        this.postUpdate();
    }

    private parseToolCalls(response: string): ToolCall[] {
        const calls: ToolCall[] = [];
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
            } catch { /* skip malformed */ }
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
                } catch { /* skip */ }
            }
        }

        return calls;
    }

    private postUpdate() {
        this._view?.webview.postMessage({
            command: 'update',
            messages: this.messages,
            isProcessing: this.isProcessing
        });
    }

    private getHtmlContent(): string {
        const messagesHtml = this.messages
            .filter(m => m.role !== 'system')
            .map(m => this.renderMessage(m))
            .join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        :root {
            --bg: var(--vscode-sideBar-background);
            --fg: var(--vscode-sideBar-foreground);
            --accent: var(--vscode-button-background);
            --user-bg: var(--vscode-button-background);
            --assistant-bg: var(--vscode-editorWidget-background);
            --tool-bg: var(--vscode-textBlockQuote-background);
            --border: var(--vscode-sideBar-border);
            --input-bg: var(--vscode-input-background);
        }
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
            font-family: var(--vscode-font-family);
            background: var(--bg);
            color: var(--fg);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        
        #messages {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
            display: flex;
            flex-direction: column;
            gap: 15px;
        }
        
        .message {
            max-width: 90%;
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 13px;
            line-height: 1.5;
            position: relative;
        }
        
        .message.user {
            align-self: flex-end;
            background: var(--user-bg);
            color: white;
        }
        
        .message.assistant {
            align-self: flex-start;
            background: var(--assistant-bg);
            border: 1px solid var(--border);
        }
        
        .message.tool {
            align-self: center;
            background: var(--tool-bg);
            font-family: var(--vscode-editor-font-family);
            font-size: 11px;
            max-width: 95%;
            color: var(--vscode-descriptionForeground);
            border-left: 3px solid var(--vscode-problemsWarningIcon-foreground);
        }
        
        .message-role {
            font-weight: bold;
            font-size: 10px;
            margin-bottom: 4px;
            opacity: 0.7;
            text-transform: uppercase;
        }
        
        .tool-calls {
            margin-top: 8px;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        
        .tool-call {
            background: rgba(0,0,0,0.1);
            padding: 4px 8px;
            border-radius: 4px;
            font-family: monospace;
        }
        
        .tool-name {
            color: var(--vscode-symbolIcon-functionForeground);
            font-weight: bold;
        }
        
        #input-container {
            padding: 10px;
            border-top: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        
        #input {
            width: 100%;
            background: var(--input-bg);
            color: var(--fg);
            border: 1px solid var(--border);
            padding: 8px;
            border-radius: 4px;
            resize: none;
            outline: none;
        }
        
        .controls {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
        }
        
        button {
            background: var(--accent);
            color: white;
            border: none;
            padding: 4px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        
        button:hover { opacity: 0.9; }
        
        pre {
            background: rgba(0,0,0,0.2);
            padding: 8px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 8px 0;
        }
        
        code {
            font-family: var(--vscode-editor-font-family);
        }

        .pondering {
            font-style: italic;
            opacity: 0.7;
            font-size: 12px;
            padding: 10px;
        }
    </style>
</head>
<body>
    <div id="messages"></div>
    <div id="status"></div>
    <div id="input-container">
        <textarea id="input" rows="3" placeholder="Ask agent... (Enter to send)"></textarea>
        <div class="controls">
            <button id="stop-btn" onclick="stopGeneration()" style="background: var(--vscode-errorForeground); display: none;">Stop</button>
            <button onclick="clearChat()">Clear Chat</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const messages = document.getElementById('messages');
        const input = document.getElementById('input');
        const stopBtn = document.getElementById('stop-btn');
        let currentIndicator = null;

        window.addEventListener('message', event => {
            const data = event.data;
            switch (data.command) {
                case 'update':
                    renderMessages(data.messages);
                    stopBtn.style.display = data.isProcessing ? 'block' : 'none';
                    if (data.isProcessing && !currentIndicator) {
                        showPondering();
                    } else if (!data.isProcessing && currentIndicator) {
                        currentIndicator.remove();
                        currentIndicator = null;
                    }
                    break;
                case 'streamChunk':
                    updateStreamedMessage(data.index, data.content);
                    break;
            }
        });

        function renderMessages(msgs) {
            messages.innerHTML = '';
            msgs.filter(m => m.role !== 'system').forEach((m, i) => {
                const div = document.createElement('div');
                div.id = 'msg-' + i;
                div.className = 'message ' + m.role;
                
                const role = document.createElement('div');
                role.className = 'message-role';
                role.textContent = m.role === 'user' ? 'YOU' : m.role === 'assistant' ? 'AGENT' : 'TOOL';
                
                const content = document.createElement('div');
                content.className = 'message-content';
                content.innerHTML = formatContent(m.content);
                
                div.appendChild(role);
                div.appendChild(content);

                if (m.tool_calls && m.tool_calls.length > 0) {
                    const toolCalls = document.createElement('div');
                    toolCalls.className = 'tool-calls';
                    m.tool_calls.forEach(tc => {
                        const tcDiv = document.createElement('div');
                        tcDiv.className = 'tool-call';
                        tcDiv.innerHTML = '<span class="tool-name">' + tc.function.name + '</span>(...)';
                        toolCalls.appendChild(tcDiv);
                    });
                    div.appendChild(toolCalls);
                }
                
                messages.appendChild(div);
            });
            messages.scrollTop = messages.scrollHeight;
        }

        function showPondering() {
            if (currentIndicator) return;
            currentIndicator = document.createElement('div');
            currentIndicator.className = 'pondering';
            currentIndicator.textContent = 'Pondering...';
            messages.appendChild(currentIndicator);
            messages.scrollTop = messages.scrollHeight;
        }

        function updateStreamedMessage(index, content) {
            const msgDiv = document.getElementById('msg-' + index);
            if (msgDiv) {
                const contentDiv = msgDiv.querySelector('.message-content');
                if (contentDiv) {
                    contentDiv.innerHTML = formatContent(content);
                }
            } else {
                vscode.postMessage({ command: 'refresh' });
            }
            messages.scrollTop = messages.scrollHeight;
        }

        function formatContent(content) {
            let html = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            html = html.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>');
            html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
            html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
            html = html.replace(/\\n/g, '<br>');
            return html;
        }
        
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const text = input.value.trim();
                if (text) {
                    vscode.postMessage({ command: 'sendMessage', text });
                    input.value = '';
                }
            }
        });
        
        function clearChat() {
            vscode.postMessage({ command: 'clearChat' });
        }

        function stopGeneration() {
            vscode.postMessage({ command: 'stopGeneration' });
        }
    </script>
</body>
</html>`;
    }

    private renderMessage(msg: ChatMessage): string {
        // This is a backup server-side render, usually webview handles it
        let roleLabel = msg.role === 'user' ? 'YOU' : msg.role === 'assistant' ? 'AGENT' : 'TOOL';
        return `
            <div class="message ${msg.role}">
                <div class="message-role">${roleLabel}</div>
                <div class="message-content">${this.formatContent(msg.content)}</div>
            </div>
        `;
    }

    private formatContent(content: string): string {
        let html = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\n/g, '<br>');
        return html;
    }
}
