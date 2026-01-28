/**
 * Tool Registry - Manages agentic tools for file operations, terminal, and web search
 */

import * as vscode from 'vscode';
import { Tool } from '../llm/llamaCpp';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

export interface ToolExecutor {
    (args: Record<string, unknown>, context: ToolContext): Promise<string>;
}

export interface ToolContext {
    workspaceRoot: string;
    cancellationToken?: vscode.CancellationToken;
    requireConfirmation: boolean;
    allowedCommands: string[];
}

interface RegisteredTool {
    definition: Tool;
    execute: ToolExecutor;
}

export interface ToolResult {
    success: boolean;
    output?: string;
    error?: string;
}

export class ToolRegistry {
    private tools: Map<string, RegisteredTool> = new Map();

    constructor() {
        this.registerBuiltinTools();
    }

    private registerBuiltinTools(): void {
        // ─────────────────────────────────────────────────────────────
        // Web Search Tool
        // ─────────────────────────────────────────────────────────────
        this.register({
            name: 'web_search',
            description: 'Search the web for documentation, tutorials, API references, or solutions. Use this to research unfamiliar topics or find current information.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'The search query - be specific and include technical terms'
                    }
                },
                required: ['query']
            },
            execute: async (args, context) => {
                const query = args.query as string;
                const endpoints = [
                    {
                        url: `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
                        linkRegex: /<a [^>]*class="result__a" [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
                        snippetRegex: /<a [^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
                    },
                    {
                        url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
                        linkRegex: /<a [^>]*class="result__a" [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
                        snippetRegex: /<a [^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
                    },
                    {
                        url: `https://duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
                        linkRegex: /<a [^>]*class="result-link" [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
                        snippetRegex: /<div [^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/div>/g
                    }
                ];

                const userAgents = [
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                ];

                for (let attempt = 0; attempt < endpoints.length; attempt++) {
                    const endpoint = endpoints[attempt];
                    try {
                        const response = await fetch(endpoint.url, {
                            headers: {
                                'User-Agent': userAgents[attempt % userAgents.length],
                                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                                'Accept-Language': 'en-US,en;q=0.5',
                                'Referer': 'https://duckduckgo.com/'
                            },
                            signal: AbortSignal.timeout(12000)
                        });

                        if (!response.ok) continue;

                        const html = await response.text();

                        // Extract titles and links
                        const linkMatches = [...html.matchAll(endpoint.linkRegex)];
                        const snippetMatches = [...html.matchAll(endpoint.snippetRegex)];

                        if (linkMatches.length > 0) {
                            const results = linkMatches.slice(0, 10).map((match, i) => {
                                let link = match[1];
                                const title = match[2].replace(/<[^>]+>/g, '').trim();
                                const snippet = snippetMatches[i] ? snippetMatches[i][1].replace(/<[^>]+>/g, '').trim() : '(No snippet)';

                                // Clean up link (un-redirect DuckDuckGo wrappers)
                                try {
                                    if (link.startsWith('/l/') || link.includes('duckduckgo.com/l/')) {
                                        const parts = link.split('?');
                                        if (parts.length > 1) {
                                            const params = new URLSearchParams(parts[1]);
                                            link = params.get('uddg') || params.get('u') || link;
                                        }
                                    } else if (link.startsWith('//')) {
                                        link = 'https:' + link;
                                    }
                                } catch { /* ignore */ }

                                return `**[${title}](${link})**\n${snippet}`;
                            });

                            return `Found results for "${query}":\n\n${results.join('\n\n')}\n\nUse \`read_url\` on any link to get more details.`;
                        }

                        // Final "Brute Force" attempt on this HTML if specific classes failed
                        if (attempt === 0) {
                            const genericLinks = [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
                                .filter(m => {
                                    const link = m[1];
                                    const text = m[2].replace(/<[^>]+>/g, '').trim();
                                    return text.length > 10 && !link.includes('duckduckgo.com') && !link.startsWith('/') && !link.startsWith('#');
                                })
                                .slice(0, 5);

                            if (genericLinks.length > 0) {
                                const results = genericLinks.map(m => `- [${m[2].replace(/<[^>]+>/g, '').trim()}](${m[1]})`);
                                return `Found some external links for "${query}":\n\n${results.join('\n')}\n\nUse \`read_url\` to explore these.`;
                            }
                        }

                    } catch (err) {
                        console.error(`Search failed for ${endpoint.url}:`, err);
                    }
                }

                return `Web search found no direct results for "${query}". This can happen if the query is too specific or DuckDuckGo is throttling. Try a broader search term.`;
            }
        });

        // ─────────────────────────────────────────────────────────────
        // Read URL Content Tool
        // ─────────────────────────────────────────────────────────────
        this.register({
            name: 'read_url',
            description: 'Fetch the text content of a web page (URL). Use this to read documentation, articles, or search results found with web_search.',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'The full URL to fetch (must start with http:// or https://)'
                    }
                },
                required: ['url']
            },
            execute: async (args) => {
                let url = args.url as string;

                // Cleanup URL if it's a DuckDuckGo redirect that slipped through
                try {
                    if (url.includes('duckduckgo.com/l/')) {
                        const parts = url.split('?');
                        if (parts.length > 1) {
                            const params = new URLSearchParams(parts[1]);
                            url = params.get('uddg') || params.get('u') || url;
                        }
                    }
                } catch { /* ignore */ }

                try {
                    const response = await fetch(url, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.5',
                            'Upgrade-Insecure-Requests': '1',
                            'Referer': 'https://www.google.com/'
                        },
                        signal: AbortSignal.timeout(20000)
                    });

                    if (!response.ok) {
                        return `Failed to fetch URL: ${response.status} ${response.statusText}\nURL: ${url}`;
                    }

                    const html = await response.text();

                    // Simple HTML to Text conversion
                    // 1. Remove script/style tags
                    let text = html.replace(/<(script|style|header|footer|nav|aside)[\s\S]*?<\/\1>/gi, '');
                    // 2. Extract title if possible
                    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
                    const title = titleMatch ? `# ${titleMatch[1].trim()}\n\n` : '';
                    // 3. Remove all other tags but keep content
                    text = text.replace(/<[^>]+>/g, ' ');
                    // 4. Decode common entities
                    text = text.replace(/&nbsp;/g, ' ')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&amp;/g, '&')
                        .replace(/&quot;/g, '"')
                        .replace(/&#39;/g, "'");
                    // 5. Cleanup whitespace
                    text = text.replace(/\s+/g, ' ').trim();

                    // Truncate to reasonable size for LLM context (CPU speed optimization)
                    if (text.length > 6000) {
                        text = text.slice(0, 5000) + '\n\n... (Content truncated for length) ...';
                    }

                    return title + (text || 'No readable text content found on this page.');
                } catch (err) {
                    return `Error fetching URL: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        });

        // ─────────────────────────────────────────────────────────────
        // Run Terminal Command Tool
        // ─────────────────────────────────────────────────────────────
        this.register({
            name: 'run_command',
            description: 'Execute a shell command in the terminal. Use for running tests, builds, git operations, or checking system state. Commands run in PowerShell on Windows.',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'The command to execute'
                    },
                    cwd: {
                        type: 'string',
                        description: 'Working directory (optional, defaults to workspace root)'
                    }
                },
                required: ['command']
            },
            execute: async (args, context) => {
                const command = args.command as string;
                const cwd = (args.cwd as string) || context.workspaceRoot;

                // Security check: extract base command
                const baseCommand = command.split(/\s+/)[0].toLowerCase();
                const isAllowed = context.allowedCommands.some(
                    allowed => baseCommand === allowed || baseCommand.endsWith(`\\${allowed}.exe`) || baseCommand.endsWith(`/${allowed}`)
                );

                if (context.requireConfirmation && !isAllowed) {
                    // In a real implementation, we'd prompt the user
                    // For now, return a notice
                    return `⚠️ Command "${baseCommand}" requires user confirmation. Allowed commands: ${context.allowedCommands.join(', ')}`;
                }

                try {
                    const { stdout, stderr } = await execAsync(command, {
                        cwd,
                        timeout: 60000,
                        maxBuffer: 1024 * 1024 * 5,
                        shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'
                    });

                    let output = '';
                    if (stdout) output += stdout;
                    if (stderr) output += (output ? '\n\nSTDERR:\n' : '') + stderr;

                    // Truncate very long outputs
                    if (output.length > 10000) {
                        output = output.slice(0, 5000) + '\n\n... (truncated) ...\n\n' + output.slice(-2000);
                    }

                    return output || '(Command completed with no output)';
                } catch (error: unknown) {
                    const execError = error as { message?: string; stderr?: string; stdout?: string };
                    let message = execError.message || 'Command failed';
                    if (execError.stderr) message += '\n' + execError.stderr;
                    if (execError.stdout) message += '\n' + execError.stdout;
                    return `Error: ${message}`;
                }
            }
        });

        // ─────────────────────────────────────────────────────────────
        // Read File Tool
        // ─────────────────────────────────────────────────────────────
        this.register({
            name: 'read_file',
            description: 'Read the contents of a file. Use this to understand existing code, check configurations, or analyze content.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Absolute or workspace-relative path to the file'
                    },
                    startLine: {
                        type: 'number',
                        description: 'Optional: First line to read (1-indexed)'
                    },
                    endLine: {
                        type: 'number',
                        description: 'Optional: Last line to read (1-indexed)'
                    }
                },
                required: ['path']
            },
            execute: async (args, context) => {
                const filePath = this.resolvePath(args.path as string, context.workspaceRoot);
                const startLine = args.startLine as number | undefined;
                const endLine = args.endLine as number | undefined;

                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    const lines = content.split('\n');

                    if (startLine !== undefined || endLine !== undefined) {
                        const start = Math.max(1, startLine || 1) - 1;
                        const end = Math.min(lines.length, endLine || lines.length);
                        const selected = lines.slice(start, end);
                        return `Lines ${start + 1}-${end} of ${filePath}:\n\n${selected.join('\n')}`;
                    }

                    // Truncate very large files
                    if (lines.length > 500) {
                        return `File has ${lines.length} lines. Showing first 200:\n\n${lines.slice(0, 200).join('\n')}\n\n... (${lines.length - 200} more lines)`;
                    }

                    return content;
                } catch (error) {
                    return `Error reading file: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            }
        });

        // ─────────────────────────────────────────────────────────────
        // Write File Tool
        // ─────────────────────────────────────────────────────────────
        this.register({
            name: 'write_file',
            description: 'Create a new file or overwrite an existing file with content. Parent directories will be created if needed.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Absolute or workspace-relative path for the file'
                    },
                    content: {
                        type: 'string',
                        description: 'The complete file content to write'
                    }
                },
                required: ['path', 'content']
            },
            execute: async (args, context) => {
                const filePath = this.resolvePath(args.path as string, context.workspaceRoot);
                const content = args.content as string;

                try {
                    // Ensure parent directory exists
                    await fs.mkdir(path.dirname(filePath), { recursive: true });
                    await fs.writeFile(filePath, content, 'utf-8');

                    const lines = content.split('\n').length;
                    const bytes = Buffer.byteLength(content, 'utf-8');
                    return `✓ Successfully wrote ${filePath}\n  ${lines} lines, ${bytes} bytes`;
                } catch (error) {
                    return `Error writing file: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            }
        });

        // ─────────────────────────────────────────────────────────────
        // Edit File Tool (for surgical edits)
        // ─────────────────────────────────────────────────────────────
        this.register({
            name: 'edit_file',
            description: 'Make a targeted edit to a file by replacing specific content. For small, precise changes.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Path to the file to edit'
                    },
                    search: {
                        type: 'string',
                        description: 'Exact text to find and replace (must match exactly)'
                    },
                    replace: {
                        type: 'string',
                        description: 'Replacement text'
                    }
                },
                required: ['path', 'search', 'replace']
            },
            execute: async (args, context) => {
                const filePath = this.resolvePath(args.path as string, context.workspaceRoot);
                const search = args.search as string;
                const replace = args.replace as string;

                try {
                    const content = await fs.readFile(filePath, 'utf-8');

                    if (!content.includes(search)) {
                        return `Error: Could not find the search text in ${filePath}. Make sure it matches exactly.`;
                    }

                    const newContent = content.replace(search, replace);
                    await fs.writeFile(filePath, newContent, 'utf-8');

                    return `✓ Successfully edited ${filePath}\n  Replaced ${search.length} chars with ${replace.length} chars`;
                } catch (error) {
                    return `Error editing file: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            }
        });

        // ─────────────────────────────────────────────────────────────
        // List Directory Tool
        // ─────────────────────────────────────────────────────────────
        this.register({
            name: 'list_directory',
            description: 'List files and subdirectories in a directory. Use to explore project structure.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Directory path to list'
                    },
                    recursive: {
                        type: 'boolean',
                        description: 'If true, list recursively (max 3 levels deep)'
                    }
                },
                required: ['path']
            },
            execute: async (args, context) => {
                const dirPath = this.resolvePath(args.path as string, context.workspaceRoot);
                const recursive = args.recursive as boolean;

                try {
                    const entries = await this.listDir(dirPath, recursive ? 3 : 1, 0);
                    return entries.join('\n');
                } catch (error) {
                    return `Error listing directory: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            }
        });

        // ─────────────────────────────────────────────────────────────
        // Search Files Tool (grep-like)
        // ─────────────────────────────────────────────────────────────
        this.register({
            name: 'search_files',
            description: 'Search for text patterns in files within a directory. Similar to grep.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: {
                        type: 'string',
                        description: 'Text or regex pattern to search for'
                    },
                    directory: {
                        type: 'string',
                        description: 'Directory to search in'
                    },
                    filePattern: {
                        type: 'string',
                        description: 'Optional glob pattern for files (e.g., "*.ts")'
                    }
                },
                required: ['pattern', 'directory']
            },
            execute: async (args, context) => {
                const searchPattern = args.pattern as string;
                const directory = this.resolvePath(args.directory as string, context.workspaceRoot);
                const filePattern = args.filePattern as string | undefined;

                try {
                    const results = await this.searchInFiles(directory, searchPattern, filePattern);
                    if (results.length === 0) {
                        return `No matches found for "${searchPattern}" in ${directory}`;
                    }
                    return results.slice(0, 50).join('\n');
                } catch (error) {
                    return `Error searching: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            }
        });
    }

    // ─────────────────────────────────────────────────────────────
    // Helper Methods
    // ─────────────────────────────────────────────────────────────

    private resolvePath(inputPath: string, workspaceRoot: string): string {
        if (path.isAbsolute(inputPath)) {
            return inputPath;
        }
        return path.join(workspaceRoot, inputPath);
    }

    private async listDir(dirPath: string, maxDepth: number, currentDepth: number): Promise<string[]> {
        if (currentDepth >= maxDepth) return [];

        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const results: string[] = [];
        const indent = '  '.repeat(currentDepth);

        // Sort: directories first, then files
        entries.sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) {
                return a.isDirectory() ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });

        for (const entry of entries) {
            // Skip common non-essential directories
            if (entry.isDirectory() && ['node_modules', '.git', '__pycache__', '.next', 'dist', 'out', '.vscode'].includes(entry.name)) {
                results.push(`${indent}[DIR] ${entry.name}/ (skipped)`);
                continue;
            }

            if (entry.isDirectory()) {
                results.push(`${indent}[DIR] ${entry.name}/`);
                const subEntries = await this.listDir(path.join(dirPath, entry.name), maxDepth, currentDepth + 1);
                results.push(...subEntries);
            } else {
                const stat = await fs.stat(path.join(dirPath, entry.name));
                const size = this.formatBytes(stat.size);
                results.push(`${indent}[FILE] ${entry.name} (${size})`);
            }
        }

        return results;
    }

    private formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    private async searchInFiles(directory: string, pattern: string, filePattern?: string): Promise<string[]> {
        const results: string[] = [];
        const regex = new RegExp(pattern, 'gi');

        const processFile = async (filePath: string) => {
            try {
                // Read file, but limit size to 10MB to prevent hangs on massive binaries
                const stats = await fs.stat(filePath);
                if (stats.size > 10 * 1024 * 1024) {
                    // For very large files, we check for matches but don't read the whole thing at once
                    // For now, let's keep it simple and skip 10MB+ to maintain performance
                    return;
                }

                const content = await fs.readFile(filePath, 'utf-8');
                const lines = content.split('\n');

                for (let i = 0; i < lines.length; i++) {
                    if (regex.test(lines[i])) {
                        // Clean line: remove non-printable/binary garbage
                        let cleaned = lines[i].replace(/[^\x20-\x7E\n\r\t]/g, '');
                        cleaned = cleaned.replace(/\s+/g, ' ').trim();

                        // Truncate long lines (especially common in binaries/minified files)
                        if (cleaned.length > 150) {
                            cleaned = cleaned.slice(0, 147) + '...';
                        }

                        if (cleaned.length > 0) {
                            results.push(`${filePath}:${i + 1}: ${cleaned}`);
                        } else {
                            results.push(`${filePath}:${i + 1}: [Non-printable content match]`);
                        }

                        if (results.length >= 50) return;
                    }
                    regex.lastIndex = 0; // Reset regex state
                }
            } catch {
                // Skip files that can't be read
            }
        };

        const walkDir = async (dir: string) => {
            if (results.length >= 50) return;

            const entries = await fs.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                if (results.length >= 50) return;

                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    if (!['node_modules', '.git', '__pycache__'].includes(entry.name)) {
                        await walkDir(fullPath);
                    }
                } else {
                    if (filePattern) {
                        const ext = path.extname(entry.name);
                        if (!filePattern.includes(ext) && !filePattern.includes(entry.name)) {
                            continue;
                        }
                    }
                    await processFile(fullPath);
                }
            }
        };

        await walkDir(directory);
        return results;
    }

    // ─────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────

    register(tool: {
        name: string;
        description: string;
        parameters: Tool['function']['parameters'];
        execute: ToolExecutor;
    }): void {
        this.tools.set(tool.name, {
            definition: {
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters
                }
            },
            execute: tool.execute
        });
    }

    getToolDefinitions(): Tool[] {
        return Array.from(this.tools.values()).map(t => t.definition);
    }

    async executeTool(name: string, args: Record<string, unknown>, context: ToolContext): Promise<string> {
        const tool = this.tools.get(name);
        if (!tool) {
            return `Error: Unknown tool "${name}". Available tools: ${Array.from(this.tools.keys()).join(', ')}`;
        }

        try {
            return await tool.execute(args, context);
        } catch (error) {
            return `Tool execution error: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
    }

    getToolNames(): string[] {
        return Array.from(this.tools.keys());
    }
}
