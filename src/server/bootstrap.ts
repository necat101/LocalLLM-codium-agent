/**
 * LLM Server Bootstrapper
 * Handles downloading and extracting llama.cpp binaries
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import { execSync } from 'child_process';
import { URL } from 'url';

const LLAMA_VERSION = 'b7885';
const CMAKE_VERSION = '3.31.5';

export class BootstrapManager {
    private outputChannel: vscode.OutputChannel;

    constructor(private context: vscode.ExtensionContext) {
        this.outputChannel = vscode.window.createOutputChannel('LLM Bootstrap');
    }

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
    async bootstrap(type?: 'cpu' | 'vulkan' | 'cuda'): Promise<boolean> {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Bootstrapping LLM Server...',
            cancellable: false
        }, async (progress) => {
            try {
                this.outputChannel.show();
                this.outputChannel.appendLine(`--- Bootstrapping llama.cpp ${LLAMA_VERSION} [v0.1.1] ---`);

                const platform = process.platform;
                const arch = process.arch;
                this.outputChannel.appendLine(`Platform: ${platform}, Arch: ${arch}`);
                this.outputChannel.appendLine(`Selected Type: ${type || 'default'}`);

                const binDir = path.join(this.context.globalStorageUri.fsPath, 'bin');
                if (!fs.existsSync(binDir)) {
                    fs.mkdirSync(binDir, { recursive: true });
                }

                let downloadUrl = '';
                let zipName = '';

                if (platform === 'win32') {
                    if (type === 'cuda') {
                        zipName = `llama-${LLAMA_VERSION}-bin-win-cuda-12.4-x64.zip`;
                    } else if (type === 'vulkan') {
                        zipName = `llama-${LLAMA_VERSION}-bin-win-vulkan-x64.zip`;
                    } else {
                        zipName = `llama-${LLAMA_VERSION}-bin-win-cpu-x64.zip`;
                    }
                    downloadUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/${zipName}`;
                } else if (platform === 'darwin') {
                    zipName = arch === 'arm64'
                        ? `llama-${LLAMA_VERSION}-bin-macos-arm64.tar.gz`
                        : `llama-${LLAMA_VERSION}-bin-macos-x64.tar.gz`;
                    downloadUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/${zipName}`;
                } else if (platform === 'linux') {
                    zipName = `llama-${LLAMA_VERSION}-bin-ubuntu-x64.tar.gz`;
                    downloadUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/${zipName}`;
                } else {
                    throw new Error(`Unsupported platform: ${platform}`);
                }

                const zipPath = path.join(this.context.globalStorageUri.fsPath, zipName);

                progress.report({ message: `Downloading ${zipName}...` });
                this.outputChannel.appendLine(`Downloading: ${downloadUrl}`);
                await this.downloadFile(downloadUrl, zipPath, progress);

                progress.report({ message: `Extracting ${zipName}...` });
                this.outputChannel.appendLine(`Extracting to: ${binDir}`);
                await this.extractAsset(zipPath, binDir);

                // Clean up zip
                fs.unlinkSync(zipPath);

                // On non-windows, ensure executable bit is set
                if (platform !== 'win32') {
                    const serverPath = this.getServerExecutablePath();
                    this.outputChannel.appendLine(`Setting executable permission: ${serverPath}`);
                    execSync(`chmod +x "${serverPath}"`);
                }

                this.outputChannel.appendLine('✅ Bootstrap complete!');
                vscode.window.showInformationMessage('LLM Server bootstrapped successfully!');
                return true;
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                this.outputChannel.appendLine(`❌ Bootstrap failed: ${msg}`);
                vscode.window.showErrorMessage(`Bootstrap failed: ${msg}`);
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
                this.outputChannel.appendLine(`Downloading CMake: ${downloadUrl}`);
                await this.downloadFile(downloadUrl, zipPath, progress);

                progress.report({ message: 'Extracting CMake...' });
                this.outputChannel.appendLine(`Extracting CMake to: ${cmakeDir}`);
                await this.extractAsset(zipPath, cmakeDir);

                fs.unlinkSync(zipPath);

                vscode.window.showInformationMessage('CMake bootstrapped successfully!');
                return true;
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                this.outputChannel.appendLine(`❌ CMake bootstrap failed: ${msg}`);
                vscode.window.showErrorMessage(`CMake bootstrap failed: ${msg}`);
                return false;
            }
        });
    }

    private async downloadFile(url: string, dest: string, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
        return new Promise((resolve, reject) => {
            const download = (targetUrl: string) => {
                const request = https.get(targetUrl, (response) => {
                    if (response.statusCode === 301 || response.statusCode === 302) {
                        const redirectUrl = response.headers.location;
                        if (redirectUrl) {
                            this.outputChannel.appendLine(`Redirecting to: ${redirectUrl}`);
                            download(redirectUrl);
                            return;
                        }
                    }

                    if (response.statusCode !== 200) {
                        reject(new Error(`Failed to download: ${response.statusCode} ${response.statusMessage}`));
                        return;
                    }

                    const totalSize = parseInt(response.headers['content-length'] || '0', 10);
                    let downloaded = 0;
                    const file = fs.createWriteStream(dest);

                    response.pipe(file);

                    response.on('data', (chunk) => {
                        downloaded += chunk.length;
                        if (totalSize > 0) {
                            const percent = Math.floor((downloaded / totalSize) * 100);
                            progress.report({ message: `Downloading... ${percent}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)` });
                        } else {
                            progress.report({ message: `Downloading... ${(downloaded / 1024 / 1024).toFixed(1)} MB` });
                        }
                    });

                    file.on('finish', () => {
                        file.close();
                        resolve();
                    });

                    file.on('error', (err) => {
                        fs.unlinkSync(dest);
                        reject(err);
                    });
                });

                request.on('error', (err) => {
                    reject(err);
                });

                request.setTimeout(60000, () => {
                    request.destroy();
                    reject(new Error('Download timed out'));
                });
            };

            download(url);
        });
    }

    private async extractAsset(zipPath: string, destDir: string): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                if (zipPath.endsWith('.zip')) {
                    if (process.platform === 'win32') {
                        // Use PowerShell to extract
                        const cmd = `PowerShell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`;
                        execSync(cmd);
                    } else {
                        // Use unzip
                        execSync(`unzip -o "${zipPath}" -d "${destDir}"`);
                    }
                } else if (zipPath.endsWith('.tar.gz')) {
                    // Use tar
                    if (!fs.existsSync(destDir)) {
                        fs.mkdirSync(destDir, { recursive: true });
                    }
                    execSync(`tar -xzf "${zipPath}" -C "${destDir}"`);
                }
                resolve();
            } catch (error) {
                reject(new Error(`Extraction failed: ${error}`));
            }
        });
    }
}
