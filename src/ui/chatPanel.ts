/**
 * Chat View Provider - Sidebar webview for the agentic assistant
 */

import * as vscode from 'vscode';
import { LlamaCppClient, ToolCall } from '../llm/llamaCpp';
import { ToolRegistry } from '../tools/registry';

interface ChatMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    displayContent?: string; // New: optional content for UI only
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
    toolResults?: Array<{ name: string; result: string }>; // For local state tracking
}

const SHARED_SYSTEM_PROMPT = `You are a powerful AI coding assistant.
Workspace: {WORKSPACE}

## Core Directives
1. **Smart Research**: Use \`web_search\` whenever you are unsure or need technical documentation. If you have the info, prioritize local implementation.
2. **Show, Don't Tell**: Code MUST go in source files (NOT .md). Never describe code in text and use placeholders in tools.
3. **Surgical First**: Use \`edit_file\` or \`replace_lines\`. Avoid \`write_file\` unless creating a NEW file.
4. **Complete Fidelity**: No placeholders. Write EVERY necessary line.
5. **Terminal Validation**: Use \`run_command\` to verify your work.
6. **Autonomy**: Use tools until 100% done.
`;

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'agentic.chatView';
    private _view?: vscode.WebviewView;
    private messages: ChatMessage[] = [];
    private isProcessing = false;
    private log: vscode.OutputChannel;
    private maxContextMessages = 10;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly llmClient: LlamaCppClient,
        private readonly tools: ToolRegistry
    ) {
        this.log = vscode.window.createOutputChannel('Agent Chat (Logs)');
    }

    private getSystemPrompt(): string {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        if (!workspaceRoot) {
            return SHARED_SYSTEM_PROMPT.replace('{WORKSPACE}', 'NO_WORKSPACE_OPEN') + `\n\n - ⚠️ WARNING: No workspace folder is open!\n - OS: ${process.platform} `;
        }
        return SHARED_SYSTEM_PROMPT.replace('{WORKSPACE}', workspaceRoot) + `\n\n - Working Directory: ${workspaceRoot} \n - OS: ${process.platform} `;
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

        // Ensure we have a system prompt if history is empty
        if (this.messages.length === 0) {
            this.messages.push({
                role: 'system',
                content: this.getSystemPrompt()
            });
        }

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.command) {
                case 'sendMessage':
                    this.log.appendLine(`User: ${data.text} `);
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

        // Check if workspace folder is open
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            this.messages.push({ role: 'user', content: text });
            this.messages.push({
                role: 'assistant',
                content: '⚠️ **No Workspace Folder Open**\n\nPlease open a folder or workspace first before using the agent:\n\n1. Go to **File → Open Folder...**\n2. Select or create a folder for your project\n3. Try your request again\n\nThe agent needs a workspace folder to safely read/write files and run commands.'
            });
            this.postUpdate();
            return;
        }

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
                // Context Management: Sliding window
                // Keep system prompt + last N messages
                let historyToKeep = this.messages.slice(0, -1);
                if (historyToKeep.length > this.maxContextMessages) {
                    const systemMsg = historyToKeep[0];
                    const recentMsgs = historyToKeep.slice(-(this.maxContextMessages - 1));
                    historyToKeep = [systemMsg, ...recentMsgs];
                }

                const promptMessages = historyToKeep.map(m => {
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

                this.log.appendLine(`Starting stream for message ${this.messages.length - 1}.Context size: ${promptMessages.length} `);

                let receiveStartTime = Date.now();
                let firstChunk = true;

                for await (const chunk of stream) {
                    if (firstChunk) {
                        this.log.appendLine(`First chunk received after ${Date.now() - receiveStartTime} ms`);
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
                this.log.appendLine(`Stream finished for message ${this.messages.length - 1}.Content length: ${assistantMsg.content.length} `);

                // Track metrics for the user to see in logs
                const elapsed = Date.now() - receiveStartTime;
                const tokensEstimate = Math.ceil(assistantMsg.content.split(/\s+/).length * 1.3); // Rough estimate
                if (assistantMsg.content.length > 0) {
                    this.log.appendLine(`Metrics: ${tokensEstimate} tokens in ${elapsed / 1000} s(${(tokensEstimate / (elapsed / 1000)).toFixed(2)} tok / s)`);
                }

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
                            this.log.appendLine(`Executing tool: ${toolCall.function.name} `);
                            const args = JSON.parse(toolCall.function.arguments);
                            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                            const config = vscode.workspace.getConfiguration('agentic');

                            const result = await this.tools.executeTool(
                                toolCall.function.name,
                                args,
                                {
                                    workspaceRoot,
                                    requireConfirmation: config.get('tools.requireConfirmation', true),
                                    allowedCommands: config.get<string[]>('tools.allowedCommands', ['npm', 'node', 'git']),
                                    onConfirmCommand: async (command: string) => {
                                        const selection = await vscode.window.showInformationMessage(
                                            `Agent wants to run: ${command} `,
                                            { modal: true },
                                            'Run',
                                            'Cancel'
                                        );
                                        return selection === 'Run';
                                    }
                                }
                            );

                            // Create concise display content for UI
                            let displayContent = result;
                            if (toolCall.function.name === 'read_file') {
                                const lineCount = result.split('\n').length;
                                displayContent = `📖 Read ${lineCount} lines from \`${args.path}\``;
                            } else if (toolCall.function.name === 'search_files') {
                                const matchCount = (result.match(/\[MATCH\]/g) || []).length;
                                displayContent = `🔍 Found ${matchCount} matches for \`${args.pattern}\``;
                            } else if (result.length > 500) {
                                displayContent = `${result.slice(0, 200)}...\n\n*(Truncated in UI, full content sent to agent)*`;
                            }

                            // Truncate tool result for context if it's too large
                            let contextResult = result;
                            if (result.length > 3000) {
                                contextResult = `${result.slice(0, 1500)}\n\n... (content truncated for context) ...\n\n${result.slice(-1000)}`;
                            }

                            this.messages.push({
                                role: 'tool',
                                content: contextResult,
                                displayContent: displayContent,
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
                    // No more tool calls detected
                    if (!assistantMsg.content) {
                        // RECOVERY TURN: If model is empty but previous turn had a tool failure, nudge it
                        const lastMsg = this.messages[this.messages.length - 2];
                        if (lastMsg && lastMsg.role === 'tool' && lastMsg.content.startsWith('Error')) {
                            this.log.appendLine('Empty response detected after tool error. Attempting recovery nudge...');
                            assistantMsg.content = '*(LLM returned empty response. Retrying with explicit error instructions...)*';
                            this.postUpdate();

                            this.messages.push({
                                role: 'user',
                                content: `The previous tool call failed with an error. Please acknowledge the error and try a different approach or tool to accomplish the task.`
                            });
                            continue; // Retry the loop one more time
                        }

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

        // Strip any raw ChatML tokens that the model might output
        let cleanedResponse = response
            .replace(/<\|im_start\|>[\w]*\n?/gi, '')
            .replace(/<\|im_end\|>/gi, '')
            .replace(/<\|eot_id\|>/gi, '')
            .replace(/<\|end_of_text\|>/gi, '');

        // Pattern 1: Tool call in code blocks (```tool_call or ```json)
        const toolCallBlockRegex = /```(?:tool_call|json)?\s*\n?\s*(\{[\s\S]*?"name"[\s\S]*?\})\s*\n?```/gi;

        let match;
        while ((match = toolCallBlockRegex.exec(cleanedResponse)) !== null) {
            try {
                const parsed = JSON.parse(match[1]);
                if (parsed.name) {
                    calls.push({
                        id: `call_${Date.now()}_${calls.length}`,
                        type: 'function',
                        function: {
                            name: parsed.name,
                            arguments: JSON.stringify(parsed.arguments || parsed.params || parsed.parameters || {})
                        }
                    });
                }
            } catch { /* skip malformed */ }
        }

        // Pattern 2: Inline JSON with "name" and "arguments" keys
        if (calls.length === 0) {
            const inlineJsonRegex = /\{\s*"name"\s*:\s*"([^"]+)"[\s\S]*?"arguments"\s*:\s*(\{[^}]*\})/gi;
            while ((match = inlineJsonRegex.exec(cleanedResponse)) !== null) {
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

        // Pattern 3: Hermes/ChatML function call format: <tool_call>{"name": "...", ...}</tool_call>
        if (calls.length === 0) {
            const hermesRegex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/gi;
            while ((match = hermesRegex.exec(cleanedResponse)) !== null) {
                try {
                    const parsed = JSON.parse(match[1]);
                    if (parsed.name) {
                        calls.push({
                            id: `call_${Date.now()}_${calls.length}`,
                            type: 'function',
                            function: {
                                name: parsed.name,
                                arguments: JSON.stringify(parsed.arguments || parsed.params || parsed.parameters || {})
                            }
                        });
                    }
                } catch { /* skip */ }
            }
        }

        // Pattern 4: Standalone JSON object with "name" key anywhere in response
        if (calls.length === 0) {
            // Find JSON-like objects with name field
            const jsonRegex = /\{[^{}]*"name"\s*:\s*"([^"]+)"[^{}]*\}/g;
            while ((match = jsonRegex.exec(cleanedResponse)) !== null) {
                try {
                    const parsed = JSON.parse(match[0]);
                    if (parsed.name && this.tools.getToolNames().includes(parsed.name)) {
                        calls.push({
                            id: `call_${Date.now()}_${calls.length}`,
                            type: 'function',
                            function: {
                                name: parsed.name,
                                arguments: JSON.stringify(parsed.arguments || parsed.params || parsed.parameters || {})
                            }
                        });
                    }
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
                content.innerHTML = formatContent(m.displayContent || m.content);
                
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
                <div class="message-content">${this.formatContent(msg.displayContent || msg.content)}</div>
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
