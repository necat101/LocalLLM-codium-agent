/**
 * Tool Registry - Manages agentic tools for file operations, terminal, and web search
 */

import * as vscode from 'vscode';
import { Tool } from '../llm/llamaCpp';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getFileTools } from './fileTools';

const execAsync = promisify(exec);

export interface ToolExecutor {
    (args: Record<string, unknown>, context: ToolContext): Promise<string>;
}

export interface ToolContext {
    workspaceRoot: string;
    cancellationToken?: vscode.CancellationToken;
    requireConfirmation: boolean;
    allowedCommands: string[];
    onConfirmCommand?: (command: string) => Promise<boolean>;
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
        // File Tools (Imported from fileTools.ts)
        // ─────────────────────────────────────────────────────────────
        getFileTools().forEach(tool => {
            if (tool.name === 'read_file') {
                tool.description += ' TIP: If unsure of the path, use `run_command` with "ls -R" or "dir /s" to explore the directory structure first.';
            }
            this.register(tool);
        });

        // ─────────────────────────────────────────────────────────────
        // Web Search Tool
        // ─────────────────────────────────────────────────────────────
        this.register({
            name: 'web_search',
            description: 'Search the web for documentation, tutorials, API references, or solutions. MAX 8 KEYWORDS. Use this to research unfamiliar topics or find current information.',
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
                let query = (args.query as string || '').trim();

                // Clean up query: strip hallucinated leading/trailing quotes
                query = query.replace(/^["']+|["']+$/g, '').trim();

                if (!query) return 'Error: Empty search query.';

                // Hard enforcement of word count to prevent DDG saturation and agent laziness
                // Auto-truncate long queries to prevent agent failure loops
                const wordCount = query.split(/\s+/).length;
                let warningPrefix = '';
                if (wordCount > 8) {
                    const truncatedQuery = query.split(/\s+/).slice(0, 8).join(' ');
                    warningPrefix = `⚠️ **Warning**: Query too long (${wordCount} words). Truncated to first 8 words: "${truncatedQuery}"\n\n`;
                    query = truncatedQuery;
                }
                const endpoints = [
                    {
                        url: `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
                        // Use more flexible regex to handle multi-class elements
                        linkRegex: /<a [^>]*class="[^"]*result__a[^"]*" [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
                        snippetRegex: /<a [^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g
                    },
                    {
                        url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
                        linkRegex: /<a [^>]*class="[^"]*result__a[^"]*" [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
                        snippetRegex: /<a [^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g
                    },
                    {
                        url: `https://duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
                        linkRegex: /<a [^>]*class="[^"]*result-link[^"]*" [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
                        snippetRegex: /<(td|div) [^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/\1>/g
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
                            const results = linkMatches.slice(0, 6).map((match, i) => {
                                let link = match[1];
                                const title = match[2].replace(/<[^>]+>/g, '').trim();
                                let snippet = snippetMatches[i] ? snippetMatches[i][1].replace(/<[^>]+>/g, '').trim() : '(No snippet)';

                                // Distillation: Truncate long snippets
                                if (snippet.length > 200) {
                                    snippet = snippet.slice(0, 197) + '...';
                                }

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

                            return `${warningPrefix}Results for "${query}":\n\n${results.join('\n\n')}`;
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
            description: 'Fetch the text content of a web page. Use this to read documentation or search results.',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'The full URL to fetch'
                    },
                    chunk: {
                        type: 'number',
                        description: 'CRITICAL: The chunk index to read (1 for first 3000 chars, 2 for next 3000, etc.). Do NOT use character offsets.'
                    }
                },
                required: ['url']
            },
            execute: async (args) => {
                let url = args.url as string;
                let chunkIdx = Math.max(1, Math.floor(args.chunk as number) || 1);

                if (chunkIdx > 1000) {
                    return `⚠️ Error: Chunk ${chunkIdx} is astronomically large and likely a hallucination. \nChunk numbers are small integers (1, 2, 3...). Pages rarely exceed 20 chunks.\n\nSTOP GUESSING. Start with \`read_url("${url}", 1)\`.`;
                }

                const chunkSize = 3000;
                const offset = (chunkIdx - 1) * chunkSize;

                // Cleanup URL...
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
                            'Accept-Encoding': 'identity',
                            'Cache-Control': 'no-cache',
                            'Pragma': 'no-cache',
                            'Upgrade-Insecure-Requests': '1',
                            'Referer': 'https://www.google.com/'
                        },
                        signal: AbortSignal.timeout(30000)
                    });

                    if (!response.ok) {
                        return `Failed to fetch URL: ${response.status} ${response.statusText}\nURL: ${url}`;
                    }

                    const html = await response.text();

                    // Simple HTML to Text conversion
                    let text = html.replace(/<(script|style|header|footer|nav|aside)[\s\S]*?<\/\1>/gi, '');
                    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
                    const title = titleMatch ? titleMatch[1].trim() : 'Untitled';
                    text = text.replace(/<[^>]+>/g, ' ');
                    text = text.replace(/&nbsp;/g, ' ')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&amp;/g, '&')
                        .replace(/&quot;/g, '"')
                        .replace(/&#39;/g, "'");
                    text = text.replace(/\s+/g, ' ').trim();

                    const totalLength = text.length;
                    const totalChunks = Math.ceil(totalLength / chunkSize);

                    // If model asked for an impossible chunk (like 10000), help it out
                    if (chunkIdx > totalChunks && totalChunks > 0) {
                        return `⚠️ Error: Chunk ${chunkIdx} does not exist. The page only has ${totalChunks} chunks.\n\nMaybe you meant \`read_url("${url}", ${totalChunks})\`?`;
                    }

                    const chunk = text.slice(offset, offset + chunkSize);
                    const hasMore = offset + chunkSize < totalLength;
                    const endChar = Math.min(offset + chunkSize, totalLength);

                    if (chunk.length === 0 && totalLength > 0) {
                        return `No content at chunk ${chunkIdx}. Page has ${totalChunks} chunks (${totalLength} chars total).`;
                    }

                    let result = `📄 **${title}**\n`;
                    result += `📍 Chunk ${chunkIdx}/${totalChunks} (chars ${offset + 1}-${endChar} of ${totalLength})\n\n`;
                    result += chunk;

                    if (hasMore) {
                        result += `\n\n---\n📎 More content available. Use \`read_url("${url}", ${chunkIdx + 1})\` for next chunk.`;
                    } else {
                        result += `\n\n---\n✅ End of content.`;
                    }

                    return result;
                } catch (err) {
                    return `Error fetching URL: ${err instanceof Error ? err.message : 'Unknown error'}`;
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
                    if (context.onConfirmCommand) {
                        const confirmed = await context.onConfirmCommand(command);
                        if (!confirmed) {
                            return `❌ Command execution cancelled by user: "${command}"`;
                        }
                    } else {
                        return `⚠️ Command "${baseCommand}" requires user confirmation. Allowed commands: ${context.allowedCommands.join(', ')}`;
                    }
                }

                try {
                    // Use ComSpec if available, fallback to full System32 path for robustness
                    const winShell = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
                    const shellOptions = process.platform === 'win32'
                        ? { shell: winShell }
                        : { shell: '/bin/bash' };

                    const { stdout, stderr } = await execAsync(command, {
                        cwd,
                        timeout: 60000,
                        maxBuffer: 1024 * 1024 * 5,
                        ...shellOptions
                    });

                    let output = '';
                    if (stdout) output += stdout;
                    if (stderr) output += (output ? '\n\nSTDERR:\n' : '') + stderr;

                    // Aggressively truncate for model context
                    if (output.length > 4000) {
                        output = output.slice(0, 2500) + '\n\n... (output truncated in context) ...\n\n' + output.slice(-1000);
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
