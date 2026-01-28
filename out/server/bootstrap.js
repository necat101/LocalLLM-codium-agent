"use strict";
/**
 * LLM Server Bootstrapper
 * Handles downloading and extracting llama.cpp binaries
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
exports.BootstrapManager = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
const LLAMA_VERSION = 'b4570';
const CMAKE_VERSION = '3.31.5';
class BootstrapManager {
    context;
    constructor(context) {
        this.context = context;
    }
    /**
     * Get the expected path for the bootstrapped server binary
     */
    getServerExecutablePath() {
        const binDir = path.join(this.context.globalStorageUri.fsPath, 'bin');
        const ext = process.platform === 'win32' ? '.exe' : '';
        return path.join(binDir, `llama-server${ext}`);
    }
    /**
     * Check if the server is already bootstrapped
     */
    isBootstrapped() {
        return fs.existsSync(this.getServerExecutablePath());
    }
    /**
     * Get path to bootstrapped CMake executable
     */
    getCMakeExecutablePath() {
        const binDir = path.join(this.context.globalStorageUri.fsPath, 'cmake', `cmake-${CMAKE_VERSION}-windows-x86_64`, 'bin');
        const ext = process.platform === 'win32' ? '.exe' : '';
        const cmakePath = path.join(binDir, `cmake${ext}`);
        return fs.existsSync(cmakePath) ? cmakePath : null;
    }
    /**
     * Bootstrap the server binary for the current platform
     */
    async bootstrap() {
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
                }
                else if (platform === 'darwin') {
                    zipName = arch === 'arm64'
                        ? `llama-${LLAMA_VERSION}-bin-macos-arm64.zip`
                        : `llama-${LLAMA_VERSION}-bin-macos-x64.zip`;
                    downloadUrl = `https://github.com/ggerganov/llama.cpp/releases/download/${LLAMA_VERSION}/${zipName}`;
                }
                else if (platform === 'linux') {
                    zipName = `llama-${LLAMA_VERSION}-bin-ubuntu-x64.zip`;
                    downloadUrl = `https://github.com/ggerganov/llama.cpp/releases/download/${LLAMA_VERSION}/${zipName}`;
                }
                else {
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
                    (0, child_process_1.execSync)(`chmod +x "${serverPath}"`);
                }
                vscode.window.showInformationMessage('LLM Server bootstrapped successfully!');
                return true;
            }
            catch (error) {
                vscode.window.showErrorMessage(`Bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
                return false;
            }
        });
    }
    /**
     * Bootstrap CMake if missing
     */
    async bootstrapCMake() {
        if (this.getCMakeExecutablePath())
            return true;
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
            }
            catch (error) {
                vscode.window.showErrorMessage(`CMake bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
                return false;
            }
        });
    }
    async downloadFile(url, dest) {
        // Use a simple fetch-based download or fallback to child_process if needed
        // Since we are in VS Code, we can use the built-in fetch if available (Node 18+)
        const response = await fetch(url);
        if (!response.ok)
            throw new Error(`Failed to download: ${response.statusText}`);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        fs.writeFileSync(dest, buffer);
    }
    async extractZip(zipPath, destDir) {
        return new Promise((resolve, reject) => {
            try {
                if (process.platform === 'win32') {
                    // Use PowerShell to extract
                    const cmd = `PowerShell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`;
                    (0, child_process_1.execSync)(cmd);
                }
                else {
                    // Use unzip
                    (0, child_process_1.execSync)(`unzip -o "${zipPath}" -d "${destDir}"`);
                }
                resolve();
            }
            catch (error) {
                reject(new Error(`Extraction failed: ${error}`));
            }
        });
    }
}
exports.BootstrapManager = BootstrapManager;
//# sourceMappingURL=bootstrap.js.map