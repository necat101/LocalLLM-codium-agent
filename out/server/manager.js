"use strict";
/**
 * llama.cpp Server Manager
 * Handles automatic server startup, model selection, and lifecycle
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
exports.ServerManager = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
const bootstrap_1 = require("./bootstrap");
const builder_1 = require("./builder");
class ServerManager {
    context;
    serverProcess = null;
    outputChannel;
    workspaceRoot;
    currentModel = null;
    statusCallback;
    bootstrapManager;
    buildManager;
    constructor(context) {
        this.context = context;
        this.outputChannel = vscode.window.createOutputChannel('LLM Server');
        this.bootstrapManager = new bootstrap_1.BootstrapManager(context);
        this.buildManager = new builder_1.BuildManager(context);
        // Try to find the llama.cpp installation
        this.workspaceRoot = this.findLlamaCppRoot();
    }
    findLlamaCppRoot() {
        // Check relative to extension
        const extensionPath = vscode.extensions.getExtension('local.vscodium-agentic')?.extensionPath;
        if (extensionPath) {
            const llamaPath = path.join(extensionPath, '..', '..', 'llama.cpp');
            if (fs.existsSync(llamaPath)) {
                return path.dirname(llamaPath);
            }
        }
        // Check workspace folders
        const workspaces = vscode.workspace.workspaceFolders;
        if (workspaces) {
            for (const ws of workspaces) {
                const llamaPath = path.join(ws.uri.fsPath, 'llama.cpp');
                if (fs.existsSync(llamaPath)) {
                    return ws.uri.fsPath;
                }
            }
        }
        // Fallback - check common locations
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        const commonPaths = [
            path.join(homeDir, 'llama.cpp'),
            'C:\\llama.cpp',
            '/opt/llama.cpp'
        ];
        for (const p of commonPaths) {
            if (fs.existsSync(p)) {
                return path.dirname(p);
            }
        }
        return '';
    }
    /**
     * Get available GGUF models from the models directory
     */
    async getAvailableModels() {
        const config = vscode.workspace.getConfiguration('agentic');
        const customPath = config.get('llamaCpp.modelPath', '');
        const searchPaths = [
            path.join(this.workspaceRoot, 'models'),
            customPath ? path.dirname(customPath) : '',
            path.join(this.workspaceRoot, 'llama.cpp', 'models'),
        ].filter(Boolean);
        const models = [];
        for (const searchPath of searchPaths) {
            if (!searchPath || !fs.existsSync(searchPath))
                continue;
            try {
                const files = fs.readdirSync(searchPath);
                for (const file of files) {
                    if (file.endsWith('.gguf')) {
                        const fullPath = path.join(searchPath, file);
                        models.push(fullPath);
                    }
                }
            }
            catch {
                // Skip inaccessible directories
            }
        }
        return models;
    }
    /**
     * Show model picker and return selected model path
     */
    async pickModel() {
        const models = await this.getAvailableModels();
        if (models.length === 0) {
            const action = await vscode.window.showWarningMessage('No GGUF models found. Download one to the "models" folder.', 'Open Download Page', 'Browse for Model');
            if (action === 'Open Download Page') {
                vscode.env.openExternal(vscode.Uri.parse('https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF'));
            }
            else if (action === 'Browse for Model') {
                const result = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    filters: { 'GGUF Models': ['gguf'] },
                    title: 'Select GGUF Model'
                });
                if (result && result[0]) {
                    return result[0].fsPath;
                }
            }
            return undefined;
        }
        // Show quick pick with model names
        const items = models.map(m => ({
            label: path.basename(m),
            description: path.dirname(m),
            path: m
        }));
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a model to load',
            title: 'Available Models'
        });
        return selected?.path;
    }
    /**
     * Start the llama.cpp server with the specified model
     */
    async startServer(modelPath) {
        // If no model specified, let user pick
        if (!modelPath) {
            modelPath = await this.pickModel();
            if (!modelPath)
                return false;
        }
        // Check if server is already running with this model
        if (this.serverProcess && this.currentModel === modelPath) {
            vscode.window.showInformationMessage('Server already running with this model.');
            return true;
        }
        // Stop existing server if running
        await this.stopServer();
        // Find server executable
        let serverPath = this.findServerExecutable();
        if (!serverPath) {
            const action = await vscode.window.showWarningMessage('llama-server not found. Select a setup method:', 'Build from Source (Recommended)', 'Download Pre-built Binary', 'Cancel');
            if (action === 'Build from Source (Recommended)') {
                const success = await this.buildManager.build();
                if (success) {
                    serverPath = this.findServerExecutable();
                }
                else {
                    const fallback = await vscode.window.showErrorMessage('Build failed. Would you like to download a pre-built binary instead?', 'Download', 'Cancel');
                    if (fallback === 'Download') {
                        const dlSuccess = await this.promptAndBootstrap();
                        if (dlSuccess)
                            serverPath = this.findServerExecutable();
                    }
                }
            }
            else if (action === 'Download Pre-built Binary') {
                const success = await this.promptAndBootstrap();
                if (success) {
                    serverPath = this.findServerExecutable();
                }
            }
            if (!serverPath) {
                return false;
            }
        }
        const config = vscode.workspace.getConfiguration('agentic');
        const contextLength = config.get('model.contextLength', 4096);
        let threads = config.get('model.threads', 0);
        if (threads <= 0) {
            // Default to physical cores (approx Total/2) to avoid hyperthreading contention and cache thrashing on CPU
            const logicalCores = require('os').cpus().length;
            threads = Math.max(1, Math.floor(logicalCores / 2));
        }
        const batchSize = config.get('performance.batchSize', 512);
        const ubatchSize = config.get('performance.ubatchSize', 128);
        const flashAttn = config.get('performance.flashAttention', true);
        const cacheQuant = config.get('performance.cacheQuant', 'f16');
        const cacheReuse = config.get('performance.cacheReuse', 0);
        const noWarmup = config.get('performance.noWarmup', false);
        const mlock = config.get('performance.mlock', false);
        const mmap = config.get('performance.mmap', true);
        const chatTemplate = config.get('model.chatTemplate', 'chatml');
        // Start server
        this.outputChannel.show();
        if (!serverPath) {
            this.outputChannel.appendLine('Error: Server path is null');
            return false;
        }
        this.outputChannel.appendLine(`Starting server with model: ${path.basename(modelPath)}`);
        this.outputChannel.appendLine(`Context length: ${contextLength}`);
        this.outputChannel.appendLine(`Threads: ${threads}`);
        this.outputChannel.appendLine(`Performance: FA=${flashAttn ? 'Enabled' : 'Auto'}, B=${batchSize}, UB=${ubatchSize}, Cache=${cacheQuant}, Reuse=${cacheReuse}`);
        this.outputChannel.appendLine(`Chat Template: ${chatTemplate}`);
        this.outputChannel.appendLine('---');
        try {
            const args = [
                '-m', modelPath,
                '-c', contextLength.toString(),
                '-t', threads.toString(),
                '--host', '127.0.0.1',
                '--port', '8080',
                '-np', '1', // single slot for simplicity
                '-b', batchSize.toString(),
                '-ub', ubatchSize.toString()
            ];
            if (cacheReuse > 0) {
                args.push('--cache-reuse', cacheReuse.toString());
            }
            if (noWarmup)
                args.push('--no-warmup');
            if (mlock)
                args.push('--mlock');
            if (!mmap)
                args.push('--no-mmap');
            if (flashAttn) {
                args.push('-fa', 'on');
            }
            if (cacheQuant !== 'f16') {
                args.push('-ctk', cacheQuant);
                args.push('-ctv', cacheQuant);
            }
            // Chat template handling
            // IMPORTANT: Do NOT use custom Jinja template or --jinja flag!
            // llama.cpp detects <tool_call> in templates and overrides with "Hermes 2 Pro" format,
            // which completely corrupts the prompt formatting for Falcon H1.
            // Instead, tools are embedded directly in the system prompt (see agent.ts).
            if (chatTemplate && chatTemplate !== 'auto') {
                args.push('--chat-template', chatTemplate);
            }
            this.serverProcess = (0, child_process_1.spawn)(serverPath, args, {
                cwd: path.dirname(serverPath)
            });
            this.currentModel = modelPath;
            this.serverProcess.stdout?.on('data', (data) => {
                this.outputChannel.append(data.toString());
            });
            this.serverProcess.stderr?.on('data', (data) => {
                this.outputChannel.append(data.toString());
            });
            this.serverProcess.on('error', (err) => {
                this.outputChannel.appendLine(`Server error: ${err.message}`);
                this.serverProcess = null;
                this.currentModel = null;
                this.notifyStatus();
            });
            this.serverProcess.on('exit', async (code) => {
                this.outputChannel.appendLine(`Server exited with code: ${code}`);
                this.serverProcess = null;
                const failedModel = modelPath;
                this.currentModel = null;
                if (code !== 0 && code !== null) {
                    this.outputChannel.appendLine(`--- Server Failure Analysis ---`);
                    if (failedModel && !fs.existsSync(failedModel)) {
                        this.outputChannel.appendLine(`❌ Error: Model file not found: ${failedModel}`);
                        vscode.window.showErrorMessage(`LLM Server failed: Model file not found.`);
                        this.notifyStatus();
                        return;
                    }
                    const action = await vscode.window.showErrorMessage(`LLM Server failed (code ${code}). Check logs for details.`, 'Switch to CPU Settings', 'Restart Server', 'Cancel');
                    if (action === 'Switch to CPU Settings') {
                        const config = vscode.workspace.getConfiguration('agentic');
                        await config.update('performance.flashAttention', false, vscode.ConfigurationTarget.Global);
                        await config.update('performance.mmap', false, vscode.ConfigurationTarget.Global);
                        await config.update('llamaCpp.binaryType', 'cpu', vscode.ConfigurationTarget.Global);
                        await vscode.window.showInformationMessage('Settings updated to CPU-safe defaults. Try starting the server again.');
                    }
                    else if (action === 'Restart Server') {
                        this.startServer(failedModel);
                    }
                }
                this.notifyStatus();
            });
            // Wait for server to be ready
            await this.waitForServerReady();
            vscode.window.showInformationMessage(`LLM Server started: ${path.basename(modelPath)}`);
            this.notifyStatus();
            return true;
        }
        catch (error) {
            this.outputChannel.appendLine(`Failed to start server: ${error}`);
            return false;
        }
    }
    /**
     * Check if a server executable is available (bootstrapped or locally built)
     */
    isServerInstalled() {
        return this.findServerExecutable() !== null;
    }
    async promptAndBootstrap() {
        const items = [
            { label: 'CPU Only', description: 'Universal, but slowest', type: 'cpu' },
            { label: 'Vulkan (GPU)', description: 'Best for AMD/Intel/ROG Ally', type: 'vulkan' },
            { label: 'CUDA (NVIDIA)', description: 'Best for NVIDIA GPUs', type: 'cuda' }
        ];
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select hardware optimization for binary download',
            title: 'Download llama.cpp Binary'
        });
        if (!selected)
            return false;
        // Save preference
        const config = vscode.workspace.getConfiguration('agentic');
        await config.update('llamaCpp.binaryType', selected.type, vscode.ConfigurationTarget.Global);
        return await this.bootstrapManager.bootstrap(selected.type);
    }
    findServerExecutable() {
        // 1. Check for local workspace/setup.bat build first (it may be a custom fork like Hierarchos)
        const possiblePaths = [
            path.join(this.workspaceRoot, 'llama.cpp', 'build', 'bin', 'Release', 'llama-server.exe'),
            path.join(this.workspaceRoot, 'llama.cpp', 'build', 'bin', 'llama-server.exe'),
            path.join(this.workspaceRoot, 'llama.cpp', 'llama-server.exe'),
            path.join(this.workspaceRoot, 'llama.cpp', 'build', 'bin', 'Release', 'llama-server'),
            path.join(this.workspaceRoot, 'llama.cpp', 'build', 'bin', 'llama-server'),
        ];
        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                return p;
            }
        }
        // 2. Check for extension-built binary
        const builtPath = this.buildManager.getBuiltBinaryPath();
        if (builtPath && fs.existsSync(builtPath)) {
            return builtPath;
        }
        // 3. Fallback to bootstrapped binary
        const bootstrappedPath = this.bootstrapManager.getServerExecutablePath();
        if (fs.existsSync(bootstrappedPath)) {
            return bootstrappedPath;
        }
        return null;
    }
    async waitForServerReady(timeout = 60000) {
        const startTime = Date.now();
        const endpoint = vscode.workspace.getConfiguration('agentic')
            .get('llamaCpp.endpoint', 'http://localhost:8080');
        while (Date.now() - startTime < timeout) {
            try {
                const response = await fetch(`${endpoint}/health`, {
                    signal: AbortSignal.timeout(2000)
                });
                if (response.ok) {
                    return;
                }
            }
            catch {
                // Server not ready yet
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        throw new Error('Server failed to start within timeout');
    }
    /**
     * Stop the running server
     */
    async stopServer() {
        if (this.serverProcess) {
            this.outputChannel.appendLine('Stopping server...');
            this.serverProcess.kill();
            this.serverProcess = null;
            this.currentModel = null;
            this.notifyStatus();
        }
    }
    /**
     * Get current server status
     */
    getStatus() {
        const endpoint = vscode.workspace.getConfiguration('agentic')
            .get('llamaCpp.endpoint', 'http://localhost:8080');
        return {
            running: this.serverProcess !== null,
            model: this.currentModel ? path.basename(this.currentModel) : undefined,
            endpoint
        };
    }
    /**
     * Set callback for status updates
     */
    onStatusChange(callback) {
        this.statusCallback = callback;
    }
    notifyStatus() {
        if (this.statusCallback) {
            this.statusCallback(this.getStatus());
        }
    }
    /**
     * Dispose resources
     */
    dispose() {
        this.stopServer();
        this.outputChannel.dispose();
    }
}
exports.ServerManager = ServerManager;
//# sourceMappingURL=manager.js.map