/**
 * Settings Panel - Webview for model and sampling configuration
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { ServerManager, ServerStatus } from './manager';

export class SettingsPanel {
    public static currentPanel: SettingsPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private serverManager: ServerManager;
    private disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        serverManager: ServerManager
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.serverManager = serverManager;

        this.update();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'browseModel':
                        await this.browseForModel();
                        break;
                    case 'loadModel':
                        await this.loadModel(message.path);
                        break;
                    case 'stopServer':
                        await this.serverManager.stopServer();
                        this.update();
                        break;
                    case 'saveSetting':
                        await this.saveSetting(message.key, message.value);
                        break;
                    case 'bootstrapServer':
                        await this.serverManager.startServer(); // This will trigger bootstrap if missing (but user opted for download)
                        this.update();
                        break;
                    case 'buildServer':
                        // Force a build from source
                        await vscode.commands.executeCommand('agentic.startServer'); // This will trigger the new prompt
                        this.update();
                        break;
                    case 'refresh':
                        this.update();
                        break;
                }
            },
            null,
            this.disposables
        );

        // Update when server status changes
        this.serverManager.onStatusChange(() => this.update());
    }

    public static createOrShow(extensionUri: vscode.Uri, serverManager: ServerManager) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (SettingsPanel.currentPanel) {
            SettingsPanel.currentPanel.panel.reveal(column);
            SettingsPanel.currentPanel.update();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'agenticSettings',
            'Agentic LLM Settings',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri, serverManager);
    }

    private async browseForModel() {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'GGUF Models': ['gguf'] },
            title: 'Select GGUF Model File'
        });

        if (result && result[0]) {
            const modelPath = result[0].fsPath;
            // Save to settings
            await vscode.workspace.getConfiguration('agentic').update(
                'llamaCpp.modelPath',
                modelPath,
                vscode.ConfigurationTarget.Global
            );
            // Load the model
            await this.loadModel(modelPath);
        }
    }

    private async loadModel(modelPath: string) {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Loading model...',
            cancellable: false
        }, async () => {
            await this.serverManager.startServer(modelPath);
        });
        this.update();
    }

    private async saveSetting(key: string, value: unknown) {
        await vscode.workspace.getConfiguration('agentic').update(
            key,
            value,
            vscode.ConfigurationTarget.Global
        );
        vscode.window.showInformationMessage(`Setting saved: ${key}`);
    }

    private update() {
        const config = vscode.workspace.getConfiguration('agentic');
        const status = this.serverManager.getStatus();

        this.panel.webview.html = this.getHtmlContent(config, status);
    }

    private getHtmlContent(config: vscode.WorkspaceConfiguration, status: ServerStatus): string {
        const isInstalled = this.serverManager.isServerInstalled();
        const modelPath = config.get<string>('llamaCpp.modelPath', '');
        const contextLength = config.get<number>('model.contextLength', 32768);
        const maxTokens = config.get<number>('model.maxTokens', 4096);
        const temperature = config.get<number>('sampling.temperature', 0.7);
        const topP = config.get<number>('sampling.topP', 0.9);
        const topK = config.get<number>('sampling.topK', 40);
        const repeatPenalty = config.get<number>('sampling.repeatPenalty', 1.1);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Agentic Settings</title>
    <style>
        :root {
            --bg: var(--vscode-editor-background);
            --fg: var(--vscode-editor-foreground);
            --accent: var(--vscode-button-background);
            --accent-hover: var(--vscode-button-hoverBackground);
            --input-bg: var(--vscode-input-background);
            --input-border: var(--vscode-input-border);
            --card-bg: var(--vscode-editorWidget-background);
            --success: #4caf50;
            --warning: #ff9800;
            --error: #f44336;
        }
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
            font-family: var(--vscode-font-family);
            background: var(--bg);
            color: var(--fg);
            padding: 20px;
            line-height: 1.6;
        }
        
        h1 {
            font-size: 1.5rem;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        h1::before {
            content: '🤖';
        }
        
        .card {
            background: var(--card-bg);
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            border: 1px solid var(--input-border);
        }
        
        .card h2 {
            font-size: 1.1rem;
            margin-bottom: 15px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--input-border);
        }
        
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.85rem;
            font-weight: 500;
        }
        
        .status-running {
            background: rgba(76, 175, 80, 0.2);
            color: var(--success);
        }
        
        .status-offline {
            background: rgba(244, 67, 54, 0.2);
            color: var(--error);
        }
        
        .model-info {
            display: flex;
            align-items: center;
            gap: 15px;
            margin: 15px 0;
            padding: 15px;
            background: var(--input-bg);
            border-radius: 6px;
        }
        
        .model-icon {
            font-size: 2rem;
        }
        
        .model-details {
            flex: 1;
        }
        
        .model-name {
            font-weight: 600;
            font-size: 1.1rem;
        }
        
        .model-path {
            font-size: 0.8rem;
            opacity: 0.7;
            word-break: break-all;
        }
        
        .button-row {
            display: flex;
            gap: 10px;
            margin-top: 15px;
        }
        
        button {
            background: var(--accent);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9rem;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: background 0.2s;
        }
        
        button:hover {
            background: var(--accent-hover);
        }
        
        button.secondary {
            background: transparent;
            border: 1px solid var(--input-border);
        }
        
        button.danger {
            background: var(--error);
        }
        
        .form-group {
            margin-bottom: 15px;
        }
        
        label {
            display: block;
            margin-bottom: 5px;
            font-weight: 500;
            font-size: 0.9rem;
        }
        
        label small {
            font-weight: normal;
            opacity: 0.7;
        }
        
        input[type="text"],
        input[type="number"] {
            width: 100%;
            padding: 8px 12px;
            background: var(--input-bg);
            border: 1px solid var(--input-border);
            border-radius: 4px;
            color: var(--fg);
            font-size: 0.9rem;
        }
        
        input[type="range"] {
            width: 100%;
            margin: 5px 0;
        }
        
        .range-value {
            display: inline-block;
            min-width: 50px;
            text-align: right;
            font-family: monospace;
        }
        
        .grid-2 {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
        }
        
        @media (max-width: 500px) {
            .grid-2 { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <h1>Agentic LLM Settings</h1>
    
    <!-- Server Status Card -->
    <div class="card">
        <h2>🖥️ Server Status</h2>
        <div>
            <span class="status-badge ${status.running ? 'status-running' : 'status-offline'}">
                ${status.running ? '● Running' : '○ Offline'}
            </span>
        </div>
        
        <div class="model-info">
            <div class="model-icon">${status.model ? '📦' : '📭'}</div>
            <div class="model-details">
                <div class="model-name">${status.model || 'No model loaded'}</div>
                <div class="model-path">${modelPath || 'Click "Browse" to select a model'}</div>
            </div>
        </div>
        
        <div class="button-row">
            <button onclick="browseModel()">📂 Browse for Model</button>
            ${!isInstalled
                ? '<button onclick="bootstrapServer()" class="secondary">⬇️ Download Binary</button> <button onclick="buildServer()" class="secondary">🛠️ Build from Source</button>'
                : (status.running
                    ? '<button class="danger" onclick="stopServer()">⏹ Stop Server</button>'
                    : '<button onclick="loadModel()">▶️ Start Server</button>')
            }
        </div>
    </div>
    
    <!-- Model Settings Card -->
    <div class="card">
        <h2>⚙️ Model Configuration</h2>
        <div class="grid-2">
            <div class="form-group">
                <label>Context Length <small>(tokens)</small></label>
                <input type="number" id="contextLength" value="${contextLength}" 
                       min="512" max="131072" step="512"
                       onchange="saveSetting('model.contextLength', parseInt(this.value))">
            </div>
            <div class="form-group">
                <label>Max Output Tokens</label>
                <input type="number" id="maxTokens" value="${maxTokens}" 
                       min="64" max="32768" step="64"
                       onchange="saveSetting('model.maxTokens', parseInt(this.value))">
            </div>
        </div>
    </div>
    
    <!-- Sampling Settings Card -->
    <div class="card">
        <h2>🎛️ Sampling Parameters</h2>
        
        <div class="form-group">
            <label>Temperature <small>(creativity)</small> <span class="range-value" id="tempVal">${temperature}</span></label>
            <input type="range" id="temperature" value="${temperature}" 
                   min="0" max="2" step="0.05"
                   oninput="document.getElementById('tempVal').textContent = this.value"
                   onchange="saveSetting('sampling.temperature', parseFloat(this.value))">
        </div>
        
        <div class="grid-2">
            <div class="form-group">
                <label>Top P <small>(nucleus)</small> <span class="range-value" id="topPVal">${topP}</span></label>
                <input type="range" id="topP" value="${topP}" 
                       min="0" max="1" step="0.05"
                       oninput="document.getElementById('topPVal').textContent = this.value"
                       onchange="saveSetting('sampling.topP', parseFloat(this.value))">
            </div>
            <div class="form-group">
                <label>Top K <span class="range-value" id="topKVal">${topK}</span></label>
                <input type="range" id="topK" value="${topK}" 
                       min="1" max="100" step="1"
                       oninput="document.getElementById('topKVal').textContent = this.value"
                       onchange="saveSetting('sampling.topK', parseInt(this.value))">
            </div>
        </div>
        
        <div class="form-group">
            <label>Repeat Penalty <span class="range-value" id="repVal">${repeatPenalty}</span></label>
            <input type="range" id="repeatPenalty" value="${repeatPenalty}" 
                   min="1" max="2" step="0.05"
                   oninput="document.getElementById('repVal').textContent = this.value"
                   onchange="saveSetting('sampling.repeatPenalty', parseFloat(this.value))">
        </div>
    </div>
    
    <!-- Endpoint Settings Card -->
    <div class="card">
        <h2>🌐 Server Endpoint</h2>
        <div class="form-group">
            <label>llama.cpp Server URL</label>
            <input type="text" id="endpoint" value="${config.get('llamaCpp.endpoint', 'http://localhost:8080')}"
                   onchange="saveSetting('llamaCpp.endpoint', this.value)">
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        
        function browseModel() {
            vscode.postMessage({ command: 'browseModel' });
        }
        
        function loadModel() {
            const path = '${modelPath.replace(/\\/g, '\\\\')}';
            if (path) {
                vscode.postMessage({ command: 'loadModel', path });
            } else {
                browseModel();
            }
        }
        
        function stopServer() {
            vscode.postMessage({ command: 'stopServer' });
        }

        function bootstrapServer() {
            vscode.postMessage({ command: 'bootstrapServer' });
        }

        function buildServer() {
            vscode.postMessage({ command: 'buildServer' });
        }
        
        function saveSetting(key, value) {
            vscode.postMessage({ command: 'saveSetting', key, value });
        }
    </script>
</body>
</html>`;
    }

    public dispose() {
        SettingsPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) d.dispose();
        }
    }
}
