/**
 * Settings Panel - Webview for model and sampling configuration
 */
import * as vscode from 'vscode';
import { ServerManager } from './manager';
export declare class SettingsPanel {
    static currentPanel: SettingsPanel | undefined;
    private readonly panel;
    private readonly extensionUri;
    private serverManager;
    private disposables;
    private constructor();
    static createOrShow(extensionUri: vscode.Uri, serverManager: ServerManager): void;
    private browseForModel;
    private loadModel;
    private saveSetting;
    private update;
    private getHtmlContent;
    dispose(): void;
}
//# sourceMappingURL=settingsPanel.d.ts.map