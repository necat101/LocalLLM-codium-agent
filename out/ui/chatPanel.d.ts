/**
 * Chat View Provider - Sidebar webview for the agentic assistant
 */
import * as vscode from 'vscode';
import { LlamaCppClient } from '../llm/llamaCpp';
import { ToolRegistry } from '../tools/registry';
export declare class ChatViewProvider implements vscode.WebviewViewProvider {
    private readonly _extensionUri;
    private readonly llmClient;
    private readonly tools;
    static readonly viewType = "agentic.chatView";
    private _view?;
    private messages;
    private isProcessing;
    private log;
    private maxContextMessages;
    private hasWrittenFile;
    constructor(_extensionUri: vscode.Uri, llmClient: LlamaCppClient, tools: ToolRegistry);
    private getSystemPrompt;
    resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken): void;
    private handleUserMessage;
    private runAgentLoop;
    private parseToolCalls;
    private sanitizeJson;
    private postUpdate;
    private getHtmlContent;
}
//# sourceMappingURL=chatPanel.d.ts.map