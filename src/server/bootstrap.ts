/**
 * LLM Server Bootstrapper
 * Handles downloading and extracting llama.cpp binaries
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

const LLAMA_VERSION = 'b4570';
const CMAKE_VERSION = '3.31.5';

export class BootstrapManager {
    constructor(private context: vscode.ExtensionContext) { }

    /**
     * Get the expected path for the bootstrapped server binary
     */
    getServerExecutablePath(): string {
        const binDir = path.join(this.context.globalStorageUri.fsPath, 'bin');
        const ext = process.platform === 'win32' ? '.exe' : '';
        return path.join(binDir, `llama-server${ext}`);
    }

    /**
     * Check if the server is already bootstrapped
     */
    isBootstrapped(): boolean {
        return fs.existsSync(this.getServerExecutablePath());
    }

    /**
     * Get path to bootstrapped CMake executable
     */
    getCMakeExecutablePath(): string | null {
        const binDir = path.join(this.context.globalStorageUri.fsPath, 'cmake', `cmake-${CMAKE_VERSION}-windows-x86_64`, 'bin');
        const ext = process.platform === 'win32' ? '.exe' : '';
        const cmakePath = path.join(binDir, `cmake${ext}`);
        return fs.existsSync(cmakePath) ? cmakePath : null;
    }

    /**
     * Bootstrap the server binary for the current platform
     */
    async bootstrap(): Promise<boolean> {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Bootstrapping LLM Server...',
            cancellable: false
        }, async (progress) => {
            try {
                const binDir = path.join(this.context.globalStorageUri.fsPath, 'bin');
                if (!fs.existsSync(binDir)) {
                    fs.mkdirSync(binDir, { recursive: true });
                }

                const platform = process.platform;
                const arch = process.arch;
                let downloadUrl = '';
                let zipName = '';

                if (platform === 'win32') {
                    // Prefer Vulkan for most modern Windows users
                    zipName = `llama-${LLAMA_VERSION}-bin-win-vulkan-x64.zip`;
                    downloadUrl = `https://github.com/ggerganov/llama.cpp/releases/download/${LLAMA_VERSION}/${zipName}`;
                } else if (platform === 'darwin') {
                    zipName = arch === 'arm64'
                        ? `llama-${LLAMA_VERSION}-bin-macos-arm64.zip`
                        : `llama-${LLAMA_VERSION}-bin-macos-x64.zip`;
                    downloadUrl = `https://github.com/ggerganov/llama.cpp/releases/download/${LLAMA_VERSION}/${zipName}`;
                } else if (platform === 'linux') {
                    zipName = `llama-${LLAMA_VERSION}-bin-ubuntu-x64.zip`;
                    downloadUrl = `https://github.com/ggerganov/llama.cpp/releases/download/${LLAMA_VERSION}/${zipName}`;
                } else {
                    throw new Error(`Unsupported platform: ${platform}`);
                }

                const zipPath = path.join(this.context.globalStorageUri.fsPath, zipName);

                progress.report({ message: `Downloading ${zipName}...` });
                await this.downloadFile(downloadUrl, zipPath);

                progress.report({ message: `Extracting ${zipName}...` });
                await this.extractZip(zipPath, binDir);

                // Clean up zip
                fs.unlinkSync(zipPath);

                // On non-windows, ensure executable bit is set
                if (platform !== 'win32') {
                    const serverPath = this.getServerExecutablePath();
                    execSync(`chmod +x "${serverPath}"`);
                }

                vscode.window.showInformationMessage('LLM Server bootstrapped successfully!');
                return true;
            } catch (error) {
                vscode.window.showErrorMessage(`Bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
                return false;
            }
        });
    }

    /**
     * Bootstrap CMake if missing
     */
    async bootstrapCMake(): Promise<boolean> {
        if (this.getCMakeExecutablePath()) return true;

        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Bootstrapping CMake...',
            cancellable: false
        }, async (progress) => {
            try {
                const cmakeDir = path.join(this.context.globalStorageUri.fsPath, 'cmake');
                if (!fs.existsSync(cmakeDir)) {
                    fs.mkdirSync(cmakeDir, { recursive: true });
                }

                // Currently supporting Windows specifically as requested for VSCodium
                if (process.platform !== 'win32') {
                    throw new Error('CMake bootstrapping currently only supported on Windows. Please install CMake manually via your package manager.');
                }

                const zipName = `cmake-${CMAKE_VERSION}-windows-x86_64.zip`;
                const downloadUrl = `https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/${zipName}`;
                const zipPath = path.join(this.context.globalStorageUri.fsPath, zipName);

                progress.report({ message: `Downloading CMake ${CMAKE_VERSION}...` });
                await this.downloadFile(downloadUrl, zipPath);

                progress.report({ message: 'Extracting CMake...' });
                await this.extractZip(zipPath, cmakeDir);

                fs.unlinkSync(zipPath);

                vscode.window.showInformationMessage('CMake bootstrapped successfully!');
                return true;
            } catch (error) {
                vscode.window.showErrorMessage(`CMake bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
                return false;
            }
        });
    }

    private async downloadFile(url: string, dest: string): Promise<void> {
        // Use a simple fetch-based download or fallback to child_process if needed
        // Since we are in VS Code, we can use the built-in fetch if available (Node 18+)
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to download: ${response.statusText}`);

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        fs.writeFileSync(dest, buffer);
    }

    private async extractZip(zipPath: string, destDir: string): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                if (process.platform === 'win32') {
                    // Use PowerShell to extract
                    const cmd = `PowerShell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`;
                    execSync(cmd);
                } else {
                    // Use unzip
                    execSync(`unzip -o "${zipPath}" -d "${destDir}"`);
                }
                resolve();
            } catch (error) {
                reject(new Error(`Extraction failed: ${error}`));
            }
        });
    }
}
