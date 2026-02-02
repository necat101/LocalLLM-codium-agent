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
        const flashAttention = config.get<boolean>('performance.flashAttention', true);
        const threads = config.get<number>('model.threads', 0);
        const batchSize = config.get<number>('performance.batchSize', 512);
        const ubatchSize = config.get<number>('performance.ubatchSize', 128);
        const cacheQuant = config.get<string>('performance.cacheQuant', 'q8_0');
        const cacheReuse = config.get<number>('performance.cacheReuse', 0);
        const noWarmup = config.get<boolean>('performance.noWarmup', true);
        const mlock = config.get<boolean>('performance.mlock', false);
        const mmap = config.get<boolean>('performance.mmap', true);

        const modelPath = config.get<string>('llamaCpp.modelPath', '');
        const contextLength = config.get<number>('model.contextLength', 32768);
        const maxTokens = config.get<number>('model.maxTokens', 4096);
        const chatTemplate = config.get<string>('model.chatTemplate', 'chatml');
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
        input[type="number"],
        select {
            width: 100%;
            padding: 8px 12px;
            background: var(--input-bg);
            border: 1px solid var(--input-border);
            border-radius: 4px;
            color: var(--fg);
            font-size: 0.9rem;
        }
        
        .checkbox-group {
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
        }
        
        input[type="checkbox"] {
            width: 16px;
            height: 16px;
            cursor: pointer;
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
    
    <!-- Performance Boost Card -->
    <div class="card">
        <h2>🚀 Performance Optimizations</h2>
        <div class="grid-2">
            <div class="form-group">
                <label class="checkbox-group">
                    <input type="checkbox" id="flashAttention" ${flashAttention ? 'checked' : ''} 
                           onchange="saveSetting('performance.flashAttention', this.checked); validatePerformanceSettings()">
                    Flash Attention (-fa)
                </label>
                <div id="fa-hint" style="font-size: 0.75rem; opacity: 0.7; color: var(--warning); display: ${cacheQuant !== 'f16' ? 'block' : 'none'};">
                    ⚠️ Required by Quantized Cache
                </div>
            </div>
            <div class="form-group">
                <label class="checkbox-group">
                    <input type="checkbox" id="noWarmup" ${noWarmup ? 'checked' : ''} 
                           onchange="saveSetting('performance.noWarmup', this.checked)">
                    No Warmup (--no-warmup)
                </label>
            </div>
            <div class="form-group">
                <label class="checkbox-group">
                    <input type="checkbox" id="mlock" ${mlock ? 'checked' : ''} 
                           onchange="saveSetting('performance.mlock', this.checked)">
                    Lock RAM (--mlock)
                </label>
            </div>
            <div class="form-group">
                <label class="checkbox-group">
                    <input type="checkbox" id="mmap" ${mmap ? 'checked' : ''} 
                           onchange="saveSetting('performance.mmap', this.checked)">
                    Memory Map (--mmap)
                </label>
            </div>
        </div>
        
        <div class="grid-2" style="margin-top: 10px;">
            <div class="form-group">
                <label>Thread Count (-t)</label>
                <input type="number" id="threads" value="${threads}" 
                       onchange="saveSetting('model.threads', parseInt(this.value))">
                <small style="opacity: 0.7;">0 = Auto (Physical Cores)</small>
            </div>
            <div class="form-group" style="display: flex; align-items: flex-end;">
                <button onclick="applyLowLatencyPreset()" class="secondary" style="width: 100%;">⚡ Low Latency Preset</button>
            </div>
        </div>

        <div class="grid-2" style="margin-top: 10px;">
            <div class="form-group">
                <label>Batch Size (-b)</label>
                <input type="number" id="batchSize" value="${batchSize}" 
                       onchange="saveSetting('performance.batchSize', parseInt(this.value))">
            </div>
            <div class="form-group">
                <label>U-Batch Size (-ub)</label>
                <input type="number" id="ubatchSize" value="${ubatchSize}" 
                       onchange="saveSetting('performance.ubatchSize', parseInt(this.value))">
            </div>
            <div class="form-group">
                <label>KV Cache Quantization</label>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    <label class="checkbox-group">
                        <input type="checkbox" id="enableCacheQuant" ${cacheQuant !== 'f16' ? 'checked' : ''} 
                               onchange="validatePerformanceSettings()">
                        Enable Quantized Cache
                    </label>
                    <select id="cacheQuant" style="display: ${cacheQuant !== 'f16' ? 'block' : 'none'};" 
                            onchange="saveSetting('performance.cacheQuant', this.value); validatePerformanceSettings()">
                        <option value="q8_0" ${cacheQuant === 'q8_0' ? 'selected' : ''}>q8_0 (Recommended)</option>
                        <option value="q4_0" ${cacheQuant === 'q4_0' ? 'selected' : ''}>q4_0 (Extreme Saving)</option>
                    </select>
                </div>
            </div>
            <div class="form-group">
                <label>Cache Reuse Threshold <small>(0 = disabled)</small></label>
                <input type="number" id="cacheReuse" value="${cacheReuse}" 
                       min="0" max="1" step="0.1"
                       onchange="saveSetting('performance.cacheReuse', parseFloat(this.value))">
                <div class="help-text" style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; line-height: 1.4;">
                    <strong>How it works:</strong> When enabled, the server compares your new prompt to the previous one. 
                    If similarity exceeds this threshold (0.0-1.0), it reuses cached KV states instead of recomputing, speeding up prefill.<br><br>
                    <strong>Trade-offs:</strong><br>
                    • <strong>0</strong> = Disabled (safest, always recompute)<br>
                    • <strong>0.5</strong> = Reuse if 50%+ of prefix matches (good for multi-turn chat)<br>
                    • <strong>0.9</strong> = Very strict, only reuse near-identical prompts<br><br>
                    <strong>⚠️ Warning:</strong> Low values (e.g., 0.1) can cause cache mismatches that hurt quality. 
                    Recommended: <strong>0</strong> (disabled) or <strong>0.75+</strong> if enabled.
                </div>
            </div>
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
        <div class="form-group">
            <label>Chat Template <small>(format for chat messages)</small></label>
            <select id="chatTemplate" onchange="saveSetting('model.chatTemplate', this.value)">
                <option value="chatml" \${chatTemplate === 'chatml' ? 'selected' : ''}>ChatML (Falcon-H1, OpenHermes, Yi)</option>
                <option value="auto" \${chatTemplate === 'auto' ? 'selected' : ''}>Auto (use model's built-in template)</option>
                <option value="llama3" \${chatTemplate === 'llama3' ? 'selected' : ''}>Llama 3 / 3.1</option>
                <option value="mistral-v7" \${chatTemplate === 'mistral-v7' ? 'selected' : ''}>Mistral v0.7</option>
                <option value="hermes-2-pro" \${chatTemplate === 'hermes-2-pro' ? 'selected' : ''}>Hermes 2 Pro (tool calling)</option>
                <option value="phi4" \${chatTemplate === 'phi4' ? 'selected' : ''}>Phi-4</option>
                <option value="gemma" \${chatTemplate === 'gemma' ? 'selected' : ''}>Gemma</option>
                <option value="command-r" \${chatTemplate === 'command-r' ? 'selected' : ''}>Command-R</option>
                <option value="llama2" \${chatTemplate === 'llama2' ? 'selected' : ''}>Llama 2 (legacy)</option>
            </select>
            <div class="help-text" style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px;">
                ChatML works for most models. "Generic" tool format in logs is normal - it's the fallback tool calling format.
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

        function validatePerformanceSettings() {
            const enableCacheQuant = document.getElementById('enableCacheQuant').checked;
            const cacheQuantSelect = document.getElementById('cacheQuant');
            const flashAttention = document.getElementById('flashAttention');
            const faHint = document.getElementById('fa-hint');

            if (enableCacheQuant) {
                cacheQuantSelect.style.display = 'block';
                const currentVal = cacheQuantSelect.value;
                // If it was f16, switch to q8_0
                if (currentVal === 'f16') {
                    cacheQuantSelect.value = 'q8_0';
                }
                saveSetting('performance.cacheQuant', cacheQuantSelect.value);

                // Force Flow Attention
                if (!flashAttention.checked) {
                    flashAttention.checked = true;
                    saveSetting('performance.flashAttention', true);
                }
                faHint.style.display = 'block';
                flashAttention.disabled = true; // User cannot disable FA if quant is on
            } else {
                cacheQuantSelect.style.display = 'none';
                saveSetting('performance.cacheQuant', 'f16');
                faHint.style.display = 'none';
                flashAttention.disabled = false;
            }
        }
        
        function applyLowLatencyPreset() {
            // Set conservative values for CPU execution
            document.getElementById('batchSize').value = 512;
            document.getElementById('ubatchSize').value = 128;
            document.getElementById('threads').value = 0; // Auto
            
            saveSetting('performance.batchSize', 512);
            saveSetting('performance.ubatchSize', 128);
            saveSetting('model.threads', 0);
            
            validatePerformanceSettings();
        }

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
