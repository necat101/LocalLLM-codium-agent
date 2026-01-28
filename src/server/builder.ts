/**
 * LLM Server Builder
 * Handles cloning and building llama.cpp from source
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawn } from 'child_process';
import { BootstrapManager } from './bootstrap';

export class BuildManager {
    private outputChannel: vscode.OutputChannel;
    private bootstrapManager: BootstrapManager;

    constructor(private context: vscode.ExtensionContext) {
        this.outputChannel = vscode.window.createOutputChannel('LLM Build Tool');
        this.bootstrapManager = new BootstrapManager(context);
    }

    /**
     * Build llama.cpp from source in the extension's global storage
     */
    async build(): Promise<boolean> {
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
                } else {
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
                    execSync('cmake --version', { stdio: 'ignore' });
                } catch {
                    this.outputChannel.appendLine('System CMake not found. Trying to bootstrap portable CMake...');
                    const cmakeSuccess = await this.bootstrapManager.bootstrapCMake();
                    if (cmakeSuccess) {
                        const bootstrappedCmake = this.bootstrapManager.getCMakeExecutablePath();
                        if (bootstrappedCmake) {
                            cmakeCmd = `"${bootstrappedCmake}"`;
                            this.outputChannel.appendLine(`Using bootstrapped CMake: ${bootstrappedCmake}`);
                        }
                    } else {
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
            } catch (error) {
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

    private runCommand(command: string, args: string[], cwd: string, token: vscode.CancellationToken): Promise<void> {
        return new Promise((resolve, reject) => {
            const process = spawn(command, args, { cwd, shell: true });

            process.stdout.on('data', (data) => {
                this.outputChannel.append(data.toString());
            });

            process.stderr.on('data', (data) => {
                this.outputChannel.append(data.toString());
            });

            process.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`Command "${command} ${args.join(' ')}" exited with code ${code}`));
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
    getBuiltBinaryPath(): string | null {
        const storagePath = this.context.globalStorageUri.fsPath;
        const llamaDir = path.join(storagePath, 'llama.cpp');

        const possiblePaths = [
            path.join(llamaDir, 'build', 'bin', 'Release', 'llama-server.exe'),
            path.join(llamaDir, 'build', 'bin', 'llama-server.exe'),
            path.join(llamaDir, 'build', 'bin', 'Release', 'llama-server'),
            path.join(llamaDir, 'build', 'bin', 'llama-server'),
        ];

        for (const p of possiblePaths) {
            if (fs.existsSync(p)) return p;
        }
        return null;
    }
}
