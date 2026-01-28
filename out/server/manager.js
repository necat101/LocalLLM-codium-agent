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
                        const dlSuccess = await this.bootstrapManager.bootstrap();
                        if (dlSuccess)
                            serverPath = this.findServerExecutable();
                    }
                }
            }
            else if (action === 'Download Pre-built Binary') {
                const success = await this.bootstrapManager.bootstrap();
                if (success) {
                    serverPath = this.findServerExecutable();
                }
            }
            if (!serverPath) {
                return false;
            }
        }
        const config = vscode.workspace.getConfiguration('agentic');
        const contextLength = config.get('model.contextLength', 32768);
        let threads = config.get('model.threads', 0);
        if (threads <= 0) {
            threads = require('os').cpus().length;
        }
        // Start server
        this.outputChannel.show();
        this.outputChannel.appendLine(`Starting server with model: ${path.basename(modelPath)}`);
        this.outputChannel.appendLine(`Context length: ${contextLength}`);
        this.outputChannel.appendLine(`Threads: ${threads}`);
        this.outputChannel.appendLine('---');
        try {
            this.serverProcess = (0, child_process_1.spawn)(serverPath, [
                '-m', modelPath,
                '-c', contextLength.toString(),
                '-t', threads.toString(),
                '--host', '127.0.0.1',
                '--port', '8080',
                '-np', '1' // single slot for simplicity
            ], {
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
            this.serverProcess.on('exit', (code) => {
                this.outputChannel.appendLine(`Server exited with code: ${code}`);
                this.serverProcess = null;
                this.currentModel = null;
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