/**
 * LLM Server Builder
 * Handles cloning and building llama.cpp from source
 */
import * as vscode from 'vscode';
export declare class BuildManager {
    private context;
    private outputChannel;
    private bootstrapManager;
    constructor(context: vscode.ExtensionContext);
    /**
     * Build llama.cpp from source in the extension's global storage
     */
    build(): Promise<boolean>;
    private runCommand;
    /**
     * Get the built binary path
     */
    getBuiltBinaryPath(): string | null;
}
//# sourceMappingURL=builder.d.ts.map