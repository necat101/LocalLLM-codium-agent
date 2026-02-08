/**
 * Tool Registry - Manages agentic tools for file operations, terminal, and web search
 */
import * as vscode from 'vscode';
import { Tool } from '../llm/llamaCpp';
export interface ToolExecutor {
    (args: Record<string, unknown>, context: ToolContext): Promise<string>;
}
export interface ToolContext {
    workspaceRoot: string;
    cancellationToken?: vscode.CancellationToken;
    requireConfirmation: boolean;
    allowedCommands: string[];
    onConfirmCommand?: (command: string) => Promise<boolean>;
}
export interface ToolResult {
    success: boolean;
    output?: string;
    error?: string;
}
export declare class ToolRegistry {
    private tools;
    constructor();
    private registerBuiltinTools;
    register(tool: {
        name: string;
        description: string;
        parameters: Tool['function']['parameters'];
        execute: ToolExecutor;
    }): void;
    getToolDefinitions(): Tool[];
    executeTool(name: string, args: Record<string, unknown>, context: ToolContext): Promise<string>;
    getToolNames(): string[];
}
//# sourceMappingURL=registry.d.ts.map