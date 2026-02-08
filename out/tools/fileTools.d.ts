import { ToolExecutor } from './registry';
/**
 * Helper to resolve and anchor paths to workspace root
 */
export declare function resolvePath(inputPath: string, workspaceRoot: string): string;
/**
 * Returns all file-related tools
 */
export declare function getFileTools(): {
    name: string;
    description: string;
    parameters: any;
    execute: ToolExecutor;
}[];
//# sourceMappingURL=fileTools.d.ts.map