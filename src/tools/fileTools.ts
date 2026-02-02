import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool } from '../llm/llamaCpp';
import { ToolExecutor, ToolContext } from './registry';

/**
 * Helper to resolve and anchor paths to workspace root
 */
export function resolvePath(inputPath: string, workspaceRoot: string): string {
    if (!inputPath || !workspaceRoot) {
        return path.join(workspaceRoot || '.', inputPath || 'untitled');
    }

    if (inputPath === '.' || inputPath === './' || inputPath === '.\\') {
        return workspaceRoot;
    }

    const normalizedInput = inputPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    const workspaceFolderName = path.basename(normalizedRoot).toLowerCase();

    if (normalizedInput.toLowerCase() === workspaceFolderName) {
        return workspaceRoot;
    }

    if (normalizedInput.toLowerCase().startsWith(workspaceFolderName + '/')) {
        const relativePart = normalizedInput.substring(workspaceFolderName.length + 1);
        return path.join(workspaceRoot, relativePart);
    }

    const isWindowsAbsolute = /^[a-zA-Z]:[\\\/]/.test(inputPath);
    const isUnixAbsolute = inputPath.startsWith('/');
    const isAbsolute = isWindowsAbsolute || isUnixAbsolute || path.isAbsolute(inputPath);

    if (isAbsolute) {
        const inputLower = normalizedInput.toLowerCase();
        const rootLower = normalizedRoot.toLowerCase();

        if (inputLower.startsWith(rootLower + '/') || inputLower === rootLower) {
            return path.normalize(inputPath);
        }

        let relativePortion = normalizedInput;
        const tempPrefixes = [
            /^\/tmp\//i,
            /^\/temp\//i,
            /^\/workspace\//i,
            /^workspace\//i,
            /^[a-zA-Z]:\/tmp\//i,
            /^[a-zA-Z]:\/temp\//i,
            /^[a-zA-Z]:\/workspace\//i,
        ];

        let stripped = false;
        for (const prefix of tempPrefixes) {
            if (prefix.test(relativePortion)) {
                relativePortion = relativePortion.replace(prefix, '');
                stripped = true;
                break;
            }
        }

        if (!stripped) {
            if (isWindowsAbsolute) {
                relativePortion = normalizedInput.replace(/^[a-zA-Z]:\//, '');
            }
            relativePortion = relativePortion.replace(/^\/+/, '');
            if (relativePortion.includes('/')) {
                relativePortion = path.basename(relativePortion);
            }
        }

        return path.join(workspaceRoot, relativePortion);
    }

    const joined = path.join(workspaceRoot, inputPath);
    const joinedNormalized = joined.replace(/\\/g, '/').toLowerCase();
    const rootNormalized = normalizedRoot.toLowerCase();

    if (!joinedNormalized.startsWith(rootNormalized)) {
        return path.join(workspaceRoot, path.basename(inputPath));
    }

    return joined;
}

/**
 * Formats bytes into human readable string
 */
function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Robustly calculates a relative path for display, handling Windows drive casing
 */
function getDisplayPath(root: string, target: string): string {
    const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '');
    const targetNorm = target.replace(/\\/g, '/');

    if (targetNorm.toLowerCase().startsWith(rootNorm.toLowerCase() + '/')) {
        return targetNorm.substring(rootNorm.length + 1);
    }

    if (targetNorm.toLowerCase() === rootNorm.toLowerCase()) {
        return '.';
    }

    return path.relative(root, target).replace(/\\/g, '/');
}

/**
 * Lists directory content recursively
 */
async function listDir(dirPath: string, maxDepth: number, currentDepth: number): Promise<string[]> {
    if (currentDepth >= maxDepth) return [];
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const results: string[] = [];
    const indent = '  '.repeat(currentDepth);

    entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
        if (entry.isDirectory() && ['node_modules', '.git', '__pycache__', '.next', 'dist', 'out', '.vscode'].includes(entry.name)) {
            results.push(`${indent}[DIR] ${entry.name}/ (skipped)`);
            continue;
        }

        if (entry.isDirectory()) {
            results.push(`${indent}[DIR] ${entry.name}/`);
            const subEntries = await listDir(path.join(dirPath, entry.name), maxDepth, currentDepth + 1);
            results.push(...subEntries);
        } else {
            const stat = await fs.stat(path.join(dirPath, entry.name));
            const size = formatBytes(stat.size);
            results.push(`${indent}[FILE] ${entry.name} (${size})`);
        }
    }
    return results;
}

/**
 * Searches for pattern in files
 */
async function searchInFiles(directory: string, pattern: string, filePattern?: string): Promise<string[]> {
    const results: string[] = [];
    const regex = new RegExp(pattern, 'gi');

    const processFile = async (filePath: string) => {
        try {
            const stats = await fs.stat(filePath);
            if (stats.size > 10 * 1024 * 1024) return;
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                    let cleaned = lines[i].replace(/[^\x20-\x7E\n\r\t]/g, '');
                    cleaned = cleaned.replace(/\s+/g, ' ').trim();
                    if (cleaned.length > 150) cleaned = cleaned.slice(0, 147) + '...';
                    if (cleaned.length > 0) results.push(`${filePath}:${i + 1}: ${cleaned}`);
                    else results.push(`${filePath}:${i + 1}: [Non-printable content match]`);
                    if (results.length >= 50) return;
                }
                regex.lastIndex = 0;
            }
        } catch { /* skip */ }
    };

    const walkDir = async (dir: string) => {
        if (results.length >= 50) return;
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (results.length >= 50) return;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!['node_modules', '.git', '__pycache__'].includes(entry.name)) await walkDir(fullPath);
            } else {
                if (filePattern) {
                    const ext = path.extname(entry.name);
                    if (!filePattern.includes(ext) && !filePattern.includes(entry.name)) continue;
                }
                await processFile(fullPath);
            }
        }
    };

    await walkDir(directory);
    return results;
}

/**
 * Returns all file-related tools
 */
export function getFileTools(): { name: string, description: string, parameters: any, execute: ToolExecutor }[] {
    return [
        {
            name: 'read_file',
            description: 'Read the contents of a file. Use this to understand existing code, check configurations, or analyze content.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute or workspace-relative path to the file' },
                    startLine: { type: 'number', description: 'Optional: First line to read (1-indexed)' },
                    endLine: { type: 'number', description: 'Optional: Last line to read (1-indexed)' },
                    lineNumbers: { type: 'boolean', description: 'Optional: Whether to include line numbers in output (default: true)' }
                },
                required: ['path']
            },
            execute: async (args, context) => {
                const filePath = resolvePath(args.path as string, context.workspaceRoot);
                const startLine = args.startLine as number | undefined;
                const endLine = args.endLine as number | undefined;
                const showLineNumbers = args.lineNumbers !== false;

                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    const lines = content.split(/\r?\n/);
                    let selectedLines = lines;
                    let displayRange = '';

                    if (startLine !== undefined || endLine !== undefined) {
                        const start = Math.max(1, startLine || 1) - 1;
                        const end = Math.min(lines.length, endLine || lines.length);
                        selectedLines = lines.slice(start, end);
                        displayRange = `Lines ${start + 1}-${end} of `;
                    } else if (lines.length > 500) {
                        selectedLines = lines.slice(0, 200);
                        displayRange = `File has ${lines.length} lines. Showing first 200 of `;
                    }

                    const relativeDisplayPath = getDisplayPath(context.workspaceRoot, filePath);
                    if (content.trim().length === 0) {
                        return `📖 Read 0 lines from ${relativeDisplayPath}\n\n(Empty file)`;
                    }

                    if (showLineNumbers) {
                        const start = startLine !== undefined ? startLine - 1 : 0;
                        const numbered = selectedLines.map((line, i) => `${(start + i + 1).toString().padStart(4)} | ${line}`);
                        return `${displayRange}${relativeDisplayPath}:\n\n${numbered.join('\n')}${lines.length > selectedLines.length && !displayRange.includes('Lines') ? '\n\n... (truncated)' : ''}`;
                    }
                    return selectedLines.join('\n');
                } catch (error) {
                    return `Error reading file: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            }
        },
        {
            name: 'write_file',
            description: 'Create a new file or overwrite an existing file with content. Parent directories will be created if needed.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute or workspace-relative path for the file' },
                    content: { type: 'string', description: 'The complete file content to write' }
                },
                required: ['path', 'content']
            },
            execute: async (args, context) => {
                const inputPath = args.path as string;
                const filePath = resolvePath(inputPath, context.workspaceRoot);
                const content = args.content as string;
                if (!content || !content.trim()) return `❌ Error: Content cannot be empty.`;

                const relativePath = path.relative(context.workspaceRoot, filePath);
                const pathParts = relativePath.split(path.sep).filter(p => p && p !== '.');
                if (pathParts.length > 500) return `❌ Error: Path too deep.`;

                try {
                    let exists = false;
                    try { await fs.access(filePath); exists = true; } catch { /* ignore */ }
                    await fs.mkdir(path.dirname(filePath), { recursive: true });
                    await fs.writeFile(filePath, content, 'utf-8');
                    const lines = content.split('\n').length;
                    const bytes = Buffer.byteLength(content, 'utf-8');
                    const relativeDisplayPath = getDisplayPath(context.workspaceRoot, filePath);
                    let message = `✓ Successfully wrote ${relativeDisplayPath}\n  ${lines} lines, ${bytes} bytes`;
                    if (exists) message = `⚠️ WARNING: Overwrite detected.\n` + message;
                    return message;
                } catch (error) {
                    return `Error writing file: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            }
        },
        {
            name: 'edit_file',
            description: 'Make a targeted edit to a file by replacing specific content.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to file' },
                    search: { type: 'string', description: 'Text to find' },
                    replace: { type: 'string', description: 'New text' }
                },
                required: ['path', 'search', 'replace']
            },
            execute: async (args, context) => {
                const filePath = resolvePath(args.path as string, context.workspaceRoot);
                const search = args.search as string;
                const replace = args.replace as string;

                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    if (content.trim().length === 0) {
                        return `❌ Error: The file is empty. There is no content to search or replace. STOP using edit_file. \nUse write_file or append_file to add the initial content.`;
                    }

                    if (!search) return `❌ Error: Search text cannot be empty.`;

                    const normalizedContent = content.replace(/\r\n/g, '\n');
                    const normalizedSearch = search.replace(/\r\n/g, '\n');
                    const normalizedReplace = replace.replace(/\r\n/g, '\n');

                    const strictIndex = normalizedContent.indexOf(normalizedSearch);
                    let targetStart = -1, targetEnd = -1;

                    if (strictIndex !== -1) {
                        targetStart = strictIndex;
                        targetEnd = strictIndex + normalizedSearch.length;
                    } else {
                        const escapedSearch = normalizedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const fuzzyPattern = escapedSearch.replace(/\s+/g, '\\s+');
                        const fuzzyRegex = new RegExp(fuzzyPattern, 'g');
                        const matches = Array.from(normalizedContent.matchAll(fuzzyRegex));
                        if (matches.length === 1) {
                            targetStart = matches[0].index!;
                            targetEnd = targetStart + matches[0][0].length;
                        } else if (matches.length > 1) {
                            return `❌ Error: Multiple matches found.`;
                        } else {
                            return `❌ Error: Could not find search text.`;
                        }
                    }

                    const newContentNormalized = normalizedContent.substring(0, targetStart) + normalizedReplace + normalizedContent.substring(targetEnd);
                    const finalContent = content.includes('\r\n') ? newContentNormalized.replace(/\n/g, '\r\n') : newContentNormalized;
                    await fs.writeFile(filePath, finalContent, 'utf-8');
                    const relativeDisplayPath = getDisplayPath(context.workspaceRoot, filePath);
                    return `✓ Successfully edited ${relativeDisplayPath}`;
                } catch (error) {
                    return `Error editing file: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            }
        },
        {
            name: 'replace_lines',
            description: 'Replace a range of lines in a file.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to file' },
                    startLine: { type: 'number', description: 'First line (1-indexed)' },
                    endLine: { type: 'number', description: 'Last line (1-indexed)' },
                    content: { type: 'string', description: 'New content' }
                },
                required: ['path', 'startLine', 'endLine', 'content']
            },
            execute: async (args, context) => {
                const filePath = resolvePath(args.path as string, context.workspaceRoot);
                const startLine = Math.max(1, args.startLine as number);
                const endLine = args.endLine as number;
                const newContent = args.content as string;

                try {
                    const originalContent = await fs.readFile(filePath, 'utf-8');
                    const lines = originalContent.split(/\r?\n/);
                    if (startLine > lines.length) return `❌ Error: Out of bounds.`;
                    const startIdx = startLine - 1;
                    const endIdx = Math.min(lines.length, endLine);
                    const newLines = newContent.split(/\r?\n/);
                    const updatedLines = [...lines.slice(0, startIdx), ...newLines, ...lines.slice(endIdx)];
                    const finalContent = originalContent.includes('\r\n') ? updatedLines.join('\r\n') : updatedLines.join('\n');
                    await fs.writeFile(filePath, finalContent, 'utf-8');
                    const relativeDisplayPath = getDisplayPath(context.workspaceRoot, filePath);
                    return `✓ Successfully replaced lines ${startLine}-${endLine} in ${relativeDisplayPath}`;
                } catch (error) {
                    return `Error replacing lines: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            }
        },
        {
            name: 'append_file',
            description: 'Add content to the end of a file.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to file' },
                    content: { type: 'string', description: 'Content to append' }
                },
                required: ['path', 'content']
            },
            execute: async (args, context) => {
                const filePath = resolvePath(args.path as string, context.workspaceRoot);
                const content = args.content as string;
                if (!content || !content.trim()) return `❌ Error: append_file content cannot be empty.`;
                try {
                    await fs.appendFile(filePath, content, 'utf-8');
                    const relativeDisplayPath = getDisplayPath(context.workspaceRoot, filePath);
                    return `✓ Successfully appended ${content.length} chars to ${relativeDisplayPath}`;
                } catch (error) {
                    return `Error appending to file: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            }
        },
        {
            name: 'list_directory',
            description: 'List files and subdirectories.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Directory path' },
                    recursive: { type: 'boolean', description: 'List recursively' }
                },
                required: ['path']
            },
            execute: async (args, context) => {
                const dirPath = resolvePath(args.path as string, context.workspaceRoot);
                const recursive = args.recursive as boolean;
                try {
                    const entries = await listDir(dirPath, recursive ? 3 : 1, 0);
                    return entries.join('\n');
                } catch (error) {
                    return `Error listing directory: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            }
        },
        {
            name: 'search_files',
            description: 'Search for text patterns in files.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Search pattern' },
                    directory: { type: 'string', description: 'Directory to search' },
                    filePattern: { type: 'string', description: 'File pattern' }
                },
                required: ['pattern', 'directory']
            },
            execute: async (args, context) => {
                const searchPattern = args.pattern as string;
                const directory = resolvePath(args.directory as string, context.workspaceRoot);
                const filePattern = args.filePattern as string | undefined;
                try {
                    const results = await searchInFiles(directory, searchPattern, filePattern);
                    if (results.length === 0) return `No matches found.`;
                    return results.slice(0, 50).join('\n');
                } catch (error) {
                    return `Error searching: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            }
        }
    ];
}
