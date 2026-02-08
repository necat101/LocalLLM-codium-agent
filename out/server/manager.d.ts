/**
 * llama.cpp Server Manager
 * Handles automatic server startup, model selection, and lifecycle
 */
import * as vscode from 'vscode';
export interface ServerStatus {
    running: boolean;
    model?: string;
    endpoint: string;
}
export declare class ServerManager {
    private context;
    private serverProcess;
    private outputChannel;
    private workspaceRoot;
    private currentModel;
    private statusCallback?;
    private bootstrapManager;
    private buildManager;
    constructor(context: vscode.ExtensionContext);
    private findLlamaCppRoot;
    /**
     * Get available GGUF models from the models directory
     */
    getAvailableModels(): Promise<string[]>;
    /**
     * Show model picker and return selected model path
     */
    pickModel(): Promise<string | undefined>;
    /**
     * Start the llama.cpp server with the specified model
     */
    startServer(modelPath?: string): Promise<boolean>;
    /**
     * Check if a server executable is available (bootstrapped or locally built)
     */
    isServerInstalled(): boolean;
    private promptAndBootstrap;
    private findServerExecutable;
    private waitForServerReady;
    /**
     * Stop the running server
     */
    stopServer(): Promise<void>;
    /**
     * Get current server status
     */
    getStatus(): ServerStatus;
    /**
     * Set callback for status updates
     */
    onStatusChange(callback: (status: ServerStatus) => void): void;
    private notifyStatus;
    /**
     * Dispose resources
     */
    dispose(): void;
}
//# sourceMappingURL=manager.d.ts.map