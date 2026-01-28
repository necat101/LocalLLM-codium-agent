/**
 * llama.cpp Server Manager
 * Handles automatic server startup, model selection, and lifecycle
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChildProcess, spawn } from 'child_process';
import { BootstrapManager } from './bootstrap';
import { BuildManager } from './builder';

export interface ServerStatus {
    running: boolean;
    model?: string;
    endpoint: string;
}

export class ServerManager {
    private serverProcess: ChildProcess | null = null;
    private outputChannel: vscode.OutputChannel;
    private workspaceRoot: string;
    private currentModel: string | null = null;
    private statusCallback?: (status: ServerStatus) => void;
    private bootstrapManager: BootstrapManager;
    private buildManager: BuildManager;

    constructor(private context: vscode.ExtensionContext) {
        this.outputChannel = vscode.window.createOutputChannel('LLM Server');
        this.bootstrapManager = new BootstrapManager(context);
        this.buildManager = new BuildManager(context);
        // Try to find the llama.cpp installation
        this.workspaceRoot = this.findLlamaCppRoot();
    }

    private findLlamaCppRoot(): string {
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
    async getAvailableModels(): Promise<string[]> {
        const config = vscode.workspace.getConfiguration('agentic');
        const customPath = config.get<string>('llamaCpp.modelPath', '');

        const searchPaths = [
            path.join(this.workspaceRoot, 'models'),
            customPath ? path.dirname(customPath) : '',
            path.join(this.workspaceRoot, 'llama.cpp', 'models'),
        ].filter(Boolean);

        const models: string[] = [];

        for (const searchPath of searchPaths) {
            if (!searchPath || !fs.existsSync(searchPath)) continue;

            try {
                const files = fs.readdirSync(searchPath);
                for (const file of files) {
                    if (file.endsWith('.gguf')) {
                        const fullPath = path.join(searchPath, file);
                        models.push(fullPath);
                    }
                }
            } catch {
                // Skip inaccessible directories
            }
        }

        return models;
    }

    /**
     * Show model picker and return selected model path
     */
    async pickModel(): Promise<string | undefined> {
        const models = await this.getAvailableModels();

        if (models.length === 0) {
            const action = await vscode.window.showWarningMessage(
                'No GGUF models found. Download one to the "models" folder.',
                'Open Download Page',
                'Browse for Model'
            );

            if (action === 'Open Download Page') {
                vscode.env.openExternal(vscode.Uri.parse(
                    'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF'
                ));
            } else if (action === 'Browse for Model') {
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
    async startServer(modelPath?: string): Promise<boolean> {
        // If no model specified, let user pick
        if (!modelPath) {
            modelPath = await this.pickModel();
            if (!modelPath) return false;
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
            const action = await vscode.window.showWarningMessage(
                'llama-server not found. Select a setup method:',
                'Build from Source (Recommended)',
                'Download Pre-built Binary',
                'Cancel'
            );

            if (action === 'Build from Source (Recommended)') {
                const success = await this.buildManager.build();
                if (success) {
                    serverPath = this.findServerExecutable();
                } else {
                    const fallback = await vscode.window.showErrorMessage(
                        'Build failed. Would you like to download a pre-built binary instead?',
                        'Download',
                        'Cancel'
                    );
                    if (fallback === 'Download') {
                        const dlSuccess = await this.bootstrapManager.bootstrap();
                        if (dlSuccess) serverPath = this.findServerExecutable();
                    }
                }
            } else if (action === 'Download Pre-built Binary') {
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
        const contextLength = config.get<number>('model.contextLength', 32768);
        let threads = config.get<number>('model.threads', 0);

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
            this.serverProcess = spawn(serverPath, [
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

            vscode.window.showInformationMessage(
                `LLM Server started: ${path.basename(modelPath)}`
            );

            this.notifyStatus();
            return true;
        } catch (error) {
            this.outputChannel.appendLine(`Failed to start server: ${error}`);
            return false;
        }
    }

    /**
     * Check if a server executable is available (bootstrapped or locally built)
     */
    isServerInstalled(): boolean {
        return this.findServerExecutable() !== null;
    }

    private findServerExecutable(): string | null {
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

    private async waitForServerReady(timeout = 60000): Promise<void> {
        const startTime = Date.now();
        const endpoint = vscode.workspace.getConfiguration('agentic')
            .get<string>('llamaCpp.endpoint', 'http://localhost:8080');

        while (Date.now() - startTime < timeout) {
            try {
                const response = await fetch(`${endpoint}/health`, {
                    signal: AbortSignal.timeout(2000)
                });
                if (response.ok) {
                    return;
                }
            } catch {
                // Server not ready yet
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        throw new Error('Server failed to start within timeout');
    }

    /**
     * Stop the running server
     */
    async stopServer(): Promise<void> {
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
    getStatus(): ServerStatus {
        const endpoint = vscode.workspace.getConfiguration('agentic')
            .get<string>('llamaCpp.endpoint', 'http://localhost:8080');

        return {
            running: this.serverProcess !== null,
            model: this.currentModel ? path.basename(this.currentModel) : undefined,
            endpoint
        };
    }

    /**
     * Set callback for status updates
     */
    onStatusChange(callback: (status: ServerStatus) => void): void {
        this.statusCallback = callback;
    }

    private notifyStatus(): void {
        if (this.statusCallback) {
            this.statusCallback(this.getStatus());
        }
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        this.stopServer();
        this.outputChannel.dispose();
    }
}
