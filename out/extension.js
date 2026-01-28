"use strict";
/**
 * VSCodium Agentic Extension - Entry Point
 * Local LLM-powered agentic coding assistant
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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const agent_1 = require("./agent");
const llamaCpp_1 = require("./llm/llamaCpp");
const registry_1 = require("./tools/registry");
const manager_1 = require("./server/manager");
const settingsPanel_1 = require("./server/settingsPanel");
const chatPanel_1 = require("./ui/chatPanel");
let agentChat;
let llmClient;
let serverManager;
let statusBarItem;
let modelStatusBarItem;
let chatStatusBarItem;
let tools;
let chatProvider;
async function activate(context) {
    console.log('Agentic extension activating...');
    // Get configuration
    const config = vscode.workspace.getConfiguration('agentic');
    const endpoint = config.get('llamaCpp.endpoint', 'http://localhost:8080');
    const autoStart = config.get('llamaCpp.autoStart', true);
    // Initialize server manager
    serverManager = new manager_1.ServerManager(context);
    context.subscriptions.push({ dispose: () => serverManager?.dispose() });
    // Initialize LLM client
    llmClient = new llamaCpp_1.LlamaCppClient({
        endpoint,
        maxTokens: config.get('model.maxTokens', 4096),
        temperature: config.get('sampling.temperature', 0.7),
        topP: config.get('sampling.topP', 0.9),
        topK: config.get('sampling.topK', 40),
        frequencyPenalty: config.get('sampling.repeatPenalty', 1.1)
    });
    // Initialize tool registry
    tools = new registry_1.ToolRegistry();
    // Initialize chat provider
    chatProvider = new chatPanel_1.ChatViewProvider(context.extensionUri, llmClient, tools);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(chatPanel_1.ChatViewProvider.viewType, chatProvider));
    // Initialize agent
    agentChat = new agent_1.AgentChat(llmClient, tools);
    // Register chat participant (if available - may not exist in all VS Code forks)
    try {
        if (vscode.chat && vscode.chat.createChatParticipant) {
            const participant = vscode.chat.createChatParticipant('agentic.local', (request, context, stream, token) => {
                return agentChat.handleRequest(request, context, stream, token);
            });
            participant.iconPath = new vscode.ThemeIcon('hubot');
            context.subscriptions.push(participant);
            console.log('Chat participant registered successfully');
        }
        else {
            console.log('Chat API not available - running in standalone mode');
        }
    }
    catch (err) {
        console.log('Failed to register chat participant:', err);
    }
    // Create status bar items
    createStatusBarItems(context);
    // Setup server status callback
    serverManager.onStatusChange((status) => {
        updateStatusBar(status.running, status.model);
    });
    // Register commands
    registerCommands(context);
    // Watch for configuration changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e) => {
        const config = vscode.workspace.getConfiguration('agentic');
        if (e.affectsConfiguration('agentic.llamaCpp.endpoint')) {
            llmClient?.updateConfig({ endpoint: config.get('llamaCpp.endpoint', 'http://localhost:8080') });
            await checkAndUpdateStatus();
        }
        if (e.affectsConfiguration('agentic.model.maxTokens')) {
            llmClient?.updateConfig({ maxTokens: config.get('model.maxTokens', 4096) });
        }
        if (e.affectsConfiguration('agentic.sampling')) {
            llmClient?.updateConfig({
                temperature: config.get('sampling.temperature', 0.7),
                topP: config.get('sampling.topP', 0.9),
                topK: config.get('sampling.topK', 40),
                frequencyPenalty: config.get('sampling.repeatPenalty', 1.1)
            });
        }
    }));
    // Check server status on startup
    try {
        const isServerRunning = await llmClient.healthCheck();
        if (!isServerRunning && autoStart) {
            // Try to auto-start server with previously selected model
            const lastModel = context.globalState.get('lastModelPath');
            if (lastModel) {
                vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Starting LLM server...',
                    cancellable: false
                }, async () => {
                    await serverManager?.startServer(lastModel);
                });
            }
            else {
                // Always show prompt to select model on first run
                setTimeout(async () => {
                    const action = await vscode.window.showInformationMessage('Agentic: No LLM model configured. Select a model to start.', 'Select Model', 'Open Settings', 'Later');
                    if (action === 'Select Model') {
                        vscode.commands.executeCommand('agentic.selectModel');
                    }
                    else if (action === 'Open Settings') {
                        vscode.commands.executeCommand('agentic.openSettings');
                    }
                }, 2000); // Delay to let extension fully activate
            }
        }
        else {
            await checkAndUpdateStatus();
        }
    }
    catch (err) {
        console.log('Agentic: Startup check failed:', err);
        // Show settings option even on error
        setTimeout(() => {
            vscode.window.showWarningMessage('Agentic: Could not connect to LLM server.', 'Open Settings').then(action => {
                if (action === 'Open Settings') {
                    vscode.commands.executeCommand('agentic.openSettings');
                }
            });
        }, 2000);
    }
    // Periodic status check
    const statusInterval = setInterval(() => checkAndUpdateStatus(), 30000);
    context.subscriptions.push({ dispose: () => clearInterval(statusInterval) });
    console.log('Agentic extension activated!');
}
function createStatusBarItems(context) {
    // Model selector (left side)
    modelStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    modelStatusBarItem.command = 'agentic.selectModel';
    modelStatusBarItem.text = '$(database) No Model';
    modelStatusBarItem.tooltip = 'Click to select an LLM model';
    modelStatusBarItem.show();
    context.subscriptions.push(modelStatusBarItem);
    // Chat button (right side, next to status)
    chatStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    chatStatusBarItem.command = 'agentic.openChat';
    chatStatusBarItem.text = '$(comment-discussion) Chat';
    chatStatusBarItem.tooltip = 'Open Agent Chat Panel';
    chatStatusBarItem.show();
    context.subscriptions.push(chatStatusBarItem);
    // Server status (right side)
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'agentic.showStatus';
    statusBarItem.text = '$(hubot) Agent';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
}
function registerCommands(context) {
    context.subscriptions.push(
    // Start server command
    vscode.commands.registerCommand('agentic.startServer', async () => {
        const modelPath = await serverManager?.pickModel();
        if (modelPath) {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Starting LLM server...',
                cancellable: false
            }, async () => {
                const success = await serverManager?.startServer(modelPath);
                if (success) {
                    context.globalState.update('lastModelPath', modelPath);
                }
            });
        }
    }), 
    // Stop server command  
    vscode.commands.registerCommand('agentic.stopServer', async () => {
        await serverManager?.stopServer();
        vscode.window.showInformationMessage('LLM server stopped');
    }), 
    // Select model command (with integrated start)
    vscode.commands.registerCommand('agentic.selectModel', async () => {
        const modelPath = await serverManager?.pickModel();
        if (modelPath) {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Loading model...',
                cancellable: false
            }, async () => {
                const success = await serverManager?.startServer(modelPath);
                if (success) {
                    context.globalState.update('lastModelPath', modelPath);
                }
            });
        }
    }), 
    // Open settings panel command
    vscode.commands.registerCommand('agentic.openSettings', () => {
        if (serverManager) {
            settingsPanel_1.SettingsPanel.createOrShow(context.extensionUri, serverManager);
        }
    }), 
    // Open chat panel command
    vscode.commands.registerCommand('agentic.openChat', () => {
        vscode.commands.executeCommand('workbench.view.extension.agentic-sidebar');
        vscode.commands.executeCommand('agentic.chatView.focus');
    }), 
    // Clear history command
    vscode.commands.registerCommand('agentic.clearHistory', () => {
        agentChat?.clearHistory();
        vscode.window.showInformationMessage('Conversation history cleared');
    }), 
    // Show status command
    vscode.commands.registerCommand('agentic.showStatus', async () => {
        const status = serverManager?.getStatus();
        const isHealthy = await llmClient?.healthCheck();
        const items = [];
        if (status?.running && status.model) {
            items.push({
                label: '$(check) Server Running',
                description: status.model,
                detail: status.endpoint
            });
            items.push({
                label: '$(stop) Stop Server',
                description: 'Shut down the LLM server'
            });
        }
        else if (isHealthy) {
            items.push({
                label: '$(check) External Server Connected',
                description: status?.endpoint
            });
        }
        else {
            items.push({
                label: '$(error) Server Not Running',
                description: 'Click to start'
            });
        }
        items.push({
            label: '$(database) Change Model',
            description: 'Select a different model'
        });
        items.push({
            label: '$(comment-discussion) Open Chat',
            description: 'Open the agent chat sidebar'
        });
        items.push({
            label: '$(gear) Settings',
            description: 'Configure extension settings'
        });
        const selected = await vscode.window.showQuickPick(items, {
            title: 'Agentic Status',
            placeHolder: 'Server status and actions'
        });
        if (selected) {
            if (selected.label.includes('Stop Server')) {
                vscode.commands.executeCommand('agentic.stopServer');
            }
            else if (selected.label.includes('Not Running') || selected.label.includes('Change Model')) {
                vscode.commands.executeCommand('agentic.selectModel');
            }
            else if (selected.label.includes('Open Chat')) {
                vscode.commands.executeCommand('agentic.openChat');
            }
            else if (selected.label.includes('Settings')) {
                vscode.commands.executeCommand('agentic.openSettings');
            }
        }
    }));
}
async function checkAndUpdateStatus() {
    if (!llmClient)
        return;
    const isHealthy = await llmClient.healthCheck();
    const status = serverManager?.getStatus();
    updateStatusBar(isHealthy, status?.model);
}
function updateStatusBar(isConnected, modelName) {
    if (!statusBarItem || !modelStatusBarItem)
        return;
    if (isConnected) {
        statusBarItem.text = '$(hubot) Agent';
        statusBarItem.tooltip = 'Agentic: Connected';
        statusBarItem.backgroundColor = undefined;
        if (modelName) {
            modelStatusBarItem.text = `$(database) ${modelName}`;
            modelStatusBarItem.tooltip = `Current model: ${modelName}\nClick to change`;
        }
        else {
            modelStatusBarItem.text = '$(database) Connected';
            modelStatusBarItem.tooltip = 'Connected to external server';
        }
    }
    else {
        statusBarItem.text = '$(hubot) Agent (offline)';
        statusBarItem.tooltip = 'Agentic: Server not running. Click for options.';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        modelStatusBarItem.text = '$(database) No Model';
        modelStatusBarItem.tooltip = 'Click to select and start a model';
    }
}
function deactivate() {
    serverManager?.dispose();
    llmClient?.abort();
    console.log('Agentic extension deactivated');
}
//# sourceMappingURL=extension.js.map