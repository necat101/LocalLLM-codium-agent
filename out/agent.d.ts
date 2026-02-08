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
    constructor(llm: LlamaCppClient, tools: ToolRegistry);
    handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult>;
    /**
     * Parse tool calls from model output text
     * Supports various formats including markdown code blocks
     */
    private parseToolCalls;
    /**
     * Sanitize malformed JSON - fix common issues from model output
     */
    private sanitizeJson;
    /**
     * Extract JSON objects from a string, properly handling nested braces
     */
    private extractJsonObjects;
    /**
     * Add message to conversation history with length limit
     */
    private addToHistory;
    /**
     * Clear conversation history
     */
    clearHistory(): void;
    /**
     * Get current conversation history
     */
    getHistory(): ChatMessage[];
}
//# sourceMappingURL=agent.d.ts.map