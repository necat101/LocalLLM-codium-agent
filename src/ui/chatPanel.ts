/**
 * Chat View Provider - Sidebar webview for the agentic assistant
 */

import * as vscode from 'vscode';
import { LlamaCppClient, ToolCall } from '../llm/llamaCpp';
import { ToolRegistry, ToolContext } from '../tools/registry';

interface ChatMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    displayContent?: string;
    tool_calls?: ToolCall[];
    id?: string;
    name?: string;
    toolResults?: Array<{ name: string; result: string }>;
}

const SHARED_SYSTEM_PROMPT = `You are Falcon, a helpful AI assistant created by Technology Innovation Institute (TII).

## Guidelines
1. Use <think> </think> tags for your internal reasoning process.
2. If you need to use a tool, first think in <think> tags, then provide ONLY the <tool_call> tags. Do NOT provide a final answer until you have the tool results.
3. If you have the final answer, provide it after your <think> process.

# Tools
You may call one or more functions to assist with the user query. You are provided with function signatures within <tools></tools> XML tags.
<tools>
{TOOL_DEFINITIONS}
</tools>
For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>

Working directory: {WORKSPACE}`;

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'agentic.chatView';
    private _view?: vscode.WebviewView;
    private messages: ChatMessage[] = [];
    private isProcessing = false;
    private log: vscode.OutputChannel;
    private maxContextMessages = 10;
    private hasWrittenFile = false;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly llmClient: LlamaCppClient,
        private readonly tools: ToolRegistry
    ) {
        this.log = vscode.window.createOutputChannel('Agent Chat (Logs)');
    }

    private getSystemPrompt(): string {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const toolDefs = this.tools.getToolDefinitions().map(d => JSON.stringify(d)).join('\n');
        return SHARED_SYSTEM_PROMPT
            .replace('{WORKSPACE}', workspaceRoot || 'NO_WORKSPACE_OPEN')
            .replace('{TOOL_DEFINITIONS}', toolDefs);
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
        const config = vscode.workspace.getConfiguration('agentic');
        const maxIterations = config.get<number>('agent.maxIterations', 15);
        const requireConfirmation = config.get<boolean>('tools.requireConfirmation', true);
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

        const getBaseContext = (confirm: boolean): ToolContext => ({
            workspaceRoot,
            requireConfirmation: confirm,
            allowedCommands: ['npm', 'node', 'git', 'python', 'rustc', 'cargo'],
            onConfirmCommand: async (cmd) => {
                const sel = await vscode.window.showInformationMessage(`Run: ${cmd}`, { modal: true }, 'Run', 'Cancel');
                return sel === 'Run';
            }
        });

        this.hasWrittenFile = false;

        while (iterations < maxIterations && this.isProcessing) {
            iterations++;
            let assistantMsg: ChatMessage = { role: 'assistant', content: '' };
            this.messages.push(assistantMsg);
            this.postUpdate();

            let toolCallsFromStream: ToolCall[] = [];

            try {
                let historyToKeep = this.messages.slice(0, -1);
                if (historyToKeep.length > this.maxContextMessages) {
                    historyToKeep = [historyToKeep[0], ...historyToKeep.slice(-this.maxContextMessages + 1)];
                }

                const stream = this.llmClient.streamChat(
                    historyToKeep,
                    undefined,
                    (tc) => { toolCallsFromStream = tc; }
                );

                for await (const chunk of stream) {
                    assistantMsg.content += chunk;
                    this._view?.webview.postMessage({
                        command: 'streamChunk',
                        content: assistantMsg.content
                    });
                }

                const parsedCalls = this.parseToolCalls(assistantMsg.content);
                const allToolCalls = [...toolCallsFromStream, ...parsedCalls];

                if (allToolCalls.length === 0) {
                    break;
                }

                for (const tc of allToolCalls) {
                    const toolName = tc.function.name;
                    let args: any = {};
                    try { args = JSON.parse(this.sanitizeJson(tc.function.arguments)); } catch (e) { /* skip */ }

                    const res = await this.tools.executeTool(toolName, args, getBaseContext(requireConfirmation));
                    this.messages.push({ role: 'tool', name: toolName, content: res });
                }
                this.postUpdate();
            } catch (error) {
                assistantMsg.content += `\n\n[Error]: ${error}`;
                this.postUpdate();
                break;
            }
        }
        this.isProcessing = false;
        this.postUpdate();
    }

    private parseToolCalls(response: string): ToolCall[] {
        const calls: ToolCall[] = [];
        const xmlRegex = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/gi;
        let match;
        while ((match = xmlRegex.exec(response)) !== null) {
            let jsonStr = match[1].trim();
            if (!jsonStr) continue;
            try {
                if (jsonStr.includes('{') && jsonStr.includes('}')) {
                    jsonStr = jsonStr.substring(jsonStr.indexOf('{'), jsonStr.lastIndexOf('}') + 1);
                }
                const parsed = JSON.parse(this.sanitizeJson(jsonStr));
                if (parsed.name) {
                    calls.push({
                        id: `call_${Date.now()}_${calls.length}`,
                        type: 'function',
                        function: {
                            name: parsed.name,
                            arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || {})
                        }
                    });
                }
            } catch { /* skip */ }
        }
        return calls;
    }

    private sanitizeJson(json: string): string {
        return json.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
    }

    private postUpdate() {
        this._view?.webview.postMessage({ command: 'update', messages: this.messages, isProcessing: this.isProcessing });
    }

    private getHtmlContent(): string {
        return `<!DOCTYPE html><html><head><style>
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
        </style></head><body>
        <div id="toolbar">
            <button onclick="vscode.postMessage({command:'clearChat'})">New Chat</button>
            <button onclick="vscode.postMessage({command:'stopGeneration'})">Stop</button>
            <button onclick="vscode.postMessage({command:'ping'})">Ping</button>
        </div>
        <div id="messages"></div>
        <div id="input-container">
            <textarea id="input" rows="1" placeholder="Type here..."></textarea>
            <button id="send-btn">SEND</button>
        </div>
        <div id="debug-panel">
            <span>Link: <span id="link-status" class="status-no">WAITING</span></span>
            <span>Sent: <span id="sent-count">0</span></span>
            <span>Last: <span id="last-event">NONE</span></span>
        </div>
        <script>
            const vscode = acquireVsCodeApi();
            const messages = document.getElementById('messages');
            const input = document.getElementById('input');
            const linkStatus = document.getElementById('link-status');
            const sentCount = document.getElementById('sent-count');
            const lastEvent = document.getElementById('last-event');
            let count = 0;

            function logEvent(msg) {
                lastEvent.innerText = msg;
                console.log('[Falcon Debug]:', msg);
            }

            function formatContent(content) {
                if (!content) return "";
                let clean = content.replace(/<tool_call>[\\s\\S]*?<\/tool_call>/gi, '')
                                   .replace(/<tool_call>[\\s\\S]*?$/gi, '')
                                   .replace(/<tools>[\\s\\S]*?<\/tools>/gi, '');
                let html = clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                html = html.replace(/&lt;think&gt;([\\s\\S]*?)&lt;\\/think&gt;/g, '<div class="thinking"><div class="thinking-title">Thinking</div>$1</div>');
                html = html.replace(/&lt;think&gt;([\\s\\S]*?)$/g, '<div class="thinking"><div class="thinking-title">Thinking...</div>$1</div>');
                html = html.replace(/\\n/g, '<br>');
                return html.trim() || "...";
            }

            function trySend() {
                const text = input.value.trim();
                console.log('[Falcon] trySend:', text);
                if (text) {
                    count++;
                    sentCount.innerText = count;
                    logEvent('Sending...');
                    vscode.postMessage({ command: 'sendMessage', text: text });
                    input.value = '';
                    input.style.height = 'auto';
                }
            }

            document.getElementById('send-btn').addEventListener('click', () => {
                logEvent('Btn Click');
                trySend();
            });

            input.addEventListener('keydown', (e) => {
                if (e.keyCode === 13 && !e.shiftKey) {
                    e.preventDefault();
                    logEvent('Enter Pressed');
                    trySend();
                }
            });

            window.addEventListener('message', e => {
                const data = e.data;
                if (data.command === 'update') {
                    linkStatus.innerText = 'CONNECTED';
                    linkStatus.className = 'status-ok';
                    logEvent('UI Update');
                    messages.innerHTML = data.messages.filter(m => m.role !== 'system').map(m => {
                        const role = m.role.toUpperCase();
                        return \`<div class="message \${m.role}"><div class="message-role">\${role}</div><div class="message-content">\${formatContent(m.content)}</div></div>\`;
                    }).join('');
                    messages.scrollTop = messages.scrollHeight;
                } else if (data.command === 'streamChunk') {
                    const containers = document.querySelectorAll('.message.assistant .message-content');
                    if (containers.length > 0) {
                        containers[containers.length - 1].innerHTML = formatContent(data.content);
                        messages.scrollTop = messages.scrollHeight;
                        logEvent('Streaming...');
                    }
                } else if (data.command === 'pong') {
                    logEvent('PONG');
                    alert('v0.1.6 Connection OK!');
                }
            });

            logEvent('Ready v0.1.6');
            vscode.postMessage({ command: 'ping' });
        </script></body></html>`;
    }
}
