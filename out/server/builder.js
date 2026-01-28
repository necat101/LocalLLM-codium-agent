"use strict";
/**
 * LLM Server Builder
 * Handles cloning and building llama.cpp from source
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
exports.BuildManager = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
const bootstrap_1 = require("./bootstrap");
class BuildManager {
    context;
    outputChannel;
    bootstrapManager;
    constructor(context) {
        this.context = context;
        this.outputChannel = vscode.window.createOutputChannel('LLM Build Tool');
        this.bootstrapManager = new bootstrap_1.BootstrapManager(context);
    }
    /**
     * Build llama.cpp from source in the extension's global storage
     */
    async build() {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Building LLM Server from source...',
            cancellable: true
        }, async (progress, token) => {
            try {
                const storagePath = this.context.globalStorageUri.fsPath;
                if (!fs.existsSync(storagePath)) {
                    fs.mkdirSync(storagePath, { recursive: true });
                }
                const llamaDir = path.join(storagePath, 'llama.cpp');
                this.outputChannel.show();
                // 1. Clone or Update
                if (!fs.existsSync(path.join(llamaDir, 'CMakeLists.txt'))) {
                    progress.report({ message: 'Cloning llama.cpp...' });
                    await this.runCommand('git', ['clone', '--depth', '1', 'https://github.com/ggerganov/llama.cpp.git', 'llama.cpp'], storagePath, token);
                }
                else {
                    progress.report({ message: 'Updating llama.cpp...' });
                    await this.runCommand('git', ['pull'], llamaDir, token);
                }
                // 2. Configure
                const buildDir = path.join(llamaDir, 'build');
                if (!fs.existsSync(buildDir)) {
                    fs.mkdirSync(buildDir);
                }
                // Check for CMake in PATH, fallback to bootstrapped
                let cmakeCmd = 'cmake';
                try {
                    (0, child_process_1.execSync)('cmake --version', { stdio: 'ignore' });
                }
                catch {
                    this.outputChannel.appendLine('System CMake not found. Trying to bootstrap portable CMake...');
                    const cmakeSuccess = await this.bootstrapManager.bootstrapCMake();
                    if (cmakeSuccess) {
                        const bootstrappedCmake = this.bootstrapManager.getCMakeExecutablePath();
                        if (bootstrappedCmake) {
                            cmakeCmd = `"${bootstrappedCmake}"`;
                            this.outputChannel.appendLine(`Using bootstrapped CMake: ${bootstrappedCmake}`);
                        }
                    }
                    else {
                        throw new Error('CMake is required but could not be found or bootstrapped.');
                    }
                }
                progress.report({ message: 'Configuring build (CMake)...' });
                const cmakeArgs = ['..', '-DLLAMA_BUILD_SERVER=ON', '-DCMAKE_BUILD_TYPE=Release'];
                // Detection for CUDA could be added here, but keeping it simple for now
                await this.runCommand(cmakeCmd, cmakeArgs, buildDir, token);
                // 3. Compile
                progress.report({ message: 'Compiling (this may take several minutes)...' });
                const buildArgs = ['--build', '.', '--config', 'Release', '-j'];
                await this.runCommand(cmakeCmd, buildArgs, buildDir, token);
                vscode.window.showInformationMessage('LLM Server built successfully from source!');
                return true;
            }
            catch (error) {
                if (token.isCancellationRequested) {
                    this.outputChannel.appendLine('Build cancelled by user.');
                    return false;
                }
                const msg = error instanceof Error ? error.message : String(error);
                this.outputChannel.appendLine(`Build failed: ${msg}`);
                return false;
            }
        });
    }
    runCommand(command, args, cwd, token) {
        return new Promise((resolve, reject) => {
            const process = (0, child_process_1.spawn)(command, args, { cwd, shell: true });
            process.stdout.on('data', (data) => {
                this.outputChannel.append(data.toString());
            });
            process.stderr.on('data', (data) => {
                this.outputChannel.append(data.toString());
            });
            process.on('close', (code) => {
                if (code === 0)
                    resolve();
                else
                    reject(new Error(`Command "${command} ${args.join(' ')}" exited with code ${code}`));
            });
            token.onCancellationRequested(() => {
                process.kill();
                reject(new Error('Cancelled'));
            });
        });
    }
    /**
     * Get the built binary path
     */
    getBuiltBinaryPath() {
        const storagePath = this.context.globalStorageUri.fsPath;
        const llamaDir = path.join(storagePath, 'llama.cpp');
        const possiblePaths = [
            path.join(llamaDir, 'build', 'bin', 'Release', 'llama-server.exe'),
            path.join(llamaDir, 'build', 'bin', 'llama-server.exe'),
            path.join(llamaDir, 'build', 'bin', 'Release', 'llama-server'),
            path.join(llamaDir, 'build', 'bin', 'llama-server'),
        ];
        for (const p of possiblePaths) {
            if (fs.existsSync(p))
                return p;
        }
        return null;
    }
}
exports.BuildManager = BuildManager;
//# sourceMappingURL=builder.js.map