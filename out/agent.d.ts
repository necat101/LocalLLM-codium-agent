/**
 * Agentic Chat Handler
 * Implements ReAct-style reasoning loop with tool use
 */
import * as vscode from 'vscode';
import { LlamaCppClient, ChatMessage } from './llm/llamaCpp';
import { ToolRegistry } from './tools/registry';
export declare class AgentChat {
    private llm;
    private tools;
    private conversationHistory;
    private maxHistoryLength;
    private hasWrittenFile;
    constructor(llm: LlamaCppClient, tools: ToolRegistry);
    handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult>;
    /**
     * Auto-chain: compile and run a code file
     * Uses a permissive context that bypasses command confirmation
     */
    private autoChainCompileRun;
    /**
     * Parse tool calls from model output text
     */
    private parseToolCalls;
    /**
     * Rescue a tool call from broken JSON using regex extraction.
     * Handles cases where JSON.parse fails but the tool name, path, etc are identifiable.
     */
    private rescueToolCall;
    /**
     * Sanitize malformed JSON from model output
     */
    private sanitizeJson;
    /**
     * Extract JSON objects from text, handling nested braces
     */
    private extractJsonObjects;
    private addToHistory;
    clearHistory(): void;
    getHistory(): ChatMessage[];
}
//# sourceMappingURL=agent.d.ts.map