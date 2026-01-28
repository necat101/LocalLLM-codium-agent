/**
 * LLM Server Bootstrapper
 * Handles downloading and extracting llama.cpp binaries
 */
import * as vscode from 'vscode';
export declare class BootstrapManager {
    private context;
    constructor(context: vscode.ExtensionContext);
    /**
     * Get the expected path for the bootstrapped server binary
     */
    getServerExecutablePath(): string;
    /**
     * Check if the server is already bootstrapped
     */
    isBootstrapped(): boolean;
    /**
     * Get path to bootstrapped CMake executable
     */
    getCMakeExecutablePath(): string | null;
    /**
     * Bootstrap the server binary for the current platform
     */
    bootstrap(): Promise<boolean>;
    /**
     * Bootstrap CMake if missing
     */
    bootstrapCMake(): Promise<boolean>;
    private downloadFile;
    private extractZip;
}
//# sourceMappingURL=bootstrap.d.ts.map