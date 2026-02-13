"use strict";
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
exports.resolvePath = resolvePath;
exports.getFileTools = getFileTools;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
/**
 * Helper to resolve and anchor paths to workspace root
 */
function resolvePath(inputPath, workspaceRoot) {
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
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
/**
 * Robustly calculates a relative path for display, handling Windows drive casing
 */
function getDisplayPath(root, target) {
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
async function listDir(dirPath, maxDepth, currentDepth) {
    if (currentDepth >= maxDepth)
        return [];
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const results = [];
    const indent = '  '.repeat(currentDepth);
    entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory())
            return a.isDirectory() ? -1 : 1;
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
        }
        else {
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
async function searchInFiles(directory, pattern, filePattern) {
    const results = [];
    const regex = new RegExp(pattern, 'gi');
    const processFile = async (filePath) => {
        try {
            const stats = await fs.stat(filePath);
            if (stats.size > 10 * 1024 * 1024)
                return;
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                    let cleaned = lines[i].replace(/[^\x20-\x7E\n\r\t]/g, '');
                    cleaned = cleaned.replace(/\s+/g, ' ').trim();
                    if (cleaned.length > 150)
                        cleaned = cleaned.slice(0, 147) + '...';
                    if (cleaned.length > 0)
                        results.push(`${filePath}:${i + 1}: ${cleaned}`);
                    else
                        results.push(`${filePath}:${i + 1}: [Non-printable content match]`);
                    if (results.length >= 50)
                        return;
                }
                regex.lastIndex = 0;
            }
        }
        catch { /* skip */ }
    };
    const walkDir = async (dir) => {
        if (results.length >= 50)
            return;
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (results.length >= 50)
                return;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!['node_modules', '.git', '__pycache__'].includes(entry.name))
                    await walkDir(fullPath);
            }
            else {
                if (filePattern) {
                    const ext = path.extname(entry.name);
                    if (!filePattern.includes(ext) && !filePattern.includes(entry.name))
                        continue;
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
function getFileTools() {
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
                const filePath = resolvePath(args.path, context.workspaceRoot);
                const startLine = args.startLine;
                const endLine = args.endLine;
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
                    }
                    else if (lines.length > 500) {
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
                }
                catch (error) {
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
                const inputPath = args.path;
                const filePath = resolvePath(inputPath, context.workspaceRoot);
                // Try to get content from various possible field names (model might use wrong names)
                let content = args.content;
                if (!content || !content.trim()) {
                    // Try alternate field names the model might use
                    content = (args.code || args.text || args.data || args.source || args.body || '');
                }
                if (!content || !content.trim()) {
                    return `❌ Error: File content is empty. Please provide the actual code in the 'content' parameter.\n\nExample:\n{"name": "write_file", "arguments": {"path": "main.rs", "content": "fn main() { println!(\"Hello!\"); }"}}`;
                }
                // Normalize space artifacts (fixes common copy-paste errors)
                content = normalizeContent(content);
                // Strip trailing JSON artifacts that may leak from tool call structure
                // This handles cases like: fn main() { } "}}}  or  fn main() { } }\n")}}
                content = content.replace(/["}\]\s]*$/, (match) => {
                    // Only strip if it looks like JSON leftovers (contains unmatched quotes/braces)
                    if (/["}]{2,}/.test(match)) {
                        // Find where the actual code ends (last legitimate bracket/semicolon)
                        const codeEnd = content.lastIndexOf('}');
                        if (codeEnd > 0) {
                            return ''; // Strip the JSON garbage
                        }
                    }
                    return match; // Keep original if it's not JSON garbage
                });
                content = content.trim();
                const relativePath = path.relative(context.workspaceRoot, filePath);
                const pathParts = relativePath.split(path.sep).filter(p => p && p !== '.');
                if (pathParts.length > 500)
                    return `❌ Error: Path too deep.`;
                try {
                    let exists = false;
                    try {
                        await fs.access(filePath);
                        exists = true;
                    }
                    catch { /* ignore */ }
                    await fs.mkdir(path.dirname(filePath), { recursive: true });
                    await fs.writeFile(filePath, content, 'utf-8');
                    const lines = content.split('\n').length;
                    const bytes = Buffer.byteLength(content, 'utf-8');
                    const relativeDisplayPath = getDisplayPath(context.workspaceRoot, filePath);
                    let message = `✓ Successfully wrote ${relativeDisplayPath}\n  ${lines} lines, ${bytes} bytes`;
                    if (exists)
                        message = `⚠️ WARNING: Overwrite detected.\n` + message;
                    return message;
                }
                catch (error) {
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
                const filePath = resolvePath(args.path, context.workspaceRoot);
                const search = args.search;
                const replace = args.replace;
                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    if (content.trim().length === 0) {
                        return `❌ Error: The file is empty. There is no content to search or replace. STOP using edit_file. \nUse write_file or append_file to add the initial content.`;
                    }
                    if (!search)
                        return `❌ Error: Search text cannot be empty.`;
                    const normalizedContent = content.replace(/\r\n/g, '\n');
                    const normalizedSearch = search.replace(/\r\n/g, '\n');
                    let normalizedReplace = replace.replace(/\r\n/g, '\n');
                    // Normalize space artifacts (fixes common copy-paste errors)
                    normalizedReplace = normalizeContent(normalizedReplace);
                    const strictIndex = normalizedContent.indexOf(normalizedSearch);
                    let targetStart = -1, targetEnd = -1;
                    if (strictIndex !== -1) {
                        targetStart = strictIndex;
                        targetEnd = strictIndex + normalizedSearch.length;
                    }
                    else {
                        // Try fuzzy whitespace matching
                        const escapedSearch = normalizedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const fuzzyPattern = escapedSearch.replace(/\s+/g, '\\s+');
                        const fuzzyRegex = new RegExp(fuzzyPattern, 'g');
                        const matches = Array.from(normalizedContent.matchAll(fuzzyRegex));
                        if (matches.length === 1) {
                            targetStart = matches[0].index;
                            targetEnd = targetStart + matches[0][0].length;
                        }
                        else if (matches.length > 1) {
                            return `❌ Error: Multiple matches found. Be more specific.`;
                        }
                        else {
                            // Try to find similar lines to help the model
                            const searchLines = normalizedSearch.split('\n').map(l => l.trim()).filter(l => l.length > 5);
                            const contentLines = normalizedContent.split('\n');
                            const similarLines = [];
                            for (const searchLine of searchLines.slice(0, 2)) {
                                for (let i = 0; i < contentLines.length; i++) {
                                    if (contentLines[i].includes(searchLine.slice(0, 20))) {
                                        similarLines.push(`  Line ${i + 1}: ${contentLines[i].slice(0, 60)}`);
                                    }
                                }
                            }
                            let hint = `❌ Error: Could not find search text.\n\nTIP: Use read_file first to see exact content.`;
                            if (similarLines.length > 0) {
                                hint += `\n\nSimilar lines found:\n${similarLines.slice(0, 3).join('\n')}`;
                            }
                            return hint;
                        }
                    }
                    const newContentNormalized = normalizedContent.substring(0, targetStart) + normalizedReplace + normalizedContent.substring(targetEnd);
                    const finalContent = content.includes('\r\n') ? newContentNormalized.replace(/\n/g, '\r\n') : newContentNormalized;
                    await fs.writeFile(filePath, finalContent, 'utf-8');
                    const relativeDisplayPath = getDisplayPath(context.workspaceRoot, filePath);
                    return `✓ Successfully edited ${relativeDisplayPath}`;
                }
                catch (error) {
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
                const filePath = resolvePath(args.path, context.workspaceRoot);
                const startLine = Math.max(1, args.startLine);
                const endLine = args.endLine;
                const newContent = args.content;
                try {
                    const originalContent = await fs.readFile(filePath, 'utf-8');
                    const lines = originalContent.split(/\r?\n/);
                    if (startLine > lines.length)
                        return `❌ Error: Out of bounds.`;
                    const startIdx = startLine - 1;
                    const endIdx = Math.min(lines.length, endLine);
                    const newLines = newContent.split(/\r?\n/);
                    const updatedLines = [...lines.slice(0, startIdx), ...newLines, ...lines.slice(endIdx)];
                    const finalContent = originalContent.includes('\r\n') ? updatedLines.join('\r\n') : updatedLines.join('\n');
                    await fs.writeFile(filePath, finalContent, 'utf-8');
                    const relativeDisplayPath = getDisplayPath(context.workspaceRoot, filePath);
                    return `✓ Successfully replaced lines ${startLine}-${endLine} in ${relativeDisplayPath}`;
                }
                catch (error) {
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
                const filePath = resolvePath(args.path, context.workspaceRoot);
                const content = args.content;
                if (!content || !content.trim())
                    return `❌ Error: append_file content cannot be empty.`;
                try {
                    await fs.appendFile(filePath, content, 'utf-8');
                    const relativeDisplayPath = getDisplayPath(context.workspaceRoot, filePath);
                    return `✓ Successfully appended ${content.length} chars to ${relativeDisplayPath}`;
                }
                catch (error) {
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
                const dirPath = resolvePath(args.path, context.workspaceRoot);
                const recursive = args.recursive;
                try {
                    const entries = await listDir(dirPath, recursive ? 3 : 1, 0);
                    return entries.join('\n');
                }
                catch (error) {
                    return `Error listing directory: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            }
        },
        {
            name: 'search_files',
            description: 'Search for TEXT content inside files. NOT for listing files by extension.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Text to search for INSIDE files (e.g. "fn main", "TODO", "import"). NOT a filename glob.' },
                    directory: { type: 'string', description: 'Directory to search in' },
                    filePattern: { type: 'string', description: 'Optional: filter by file extension (e.g. ".rs", ".py")' }
                },
                required: ['pattern', 'directory']
            },
            execute: async (args, context) => {
                let searchPattern = args.pattern;
                const directory = resolvePath(args.directory, context.workspaceRoot);
                let filePattern = args.filePattern;
                // Auto-correct: if the search pattern looks like a file glob (e.g. "*.rs"),
                // the model likely wants to find files of that type, not search for that text
                if (searchPattern.includes('*') || searchPattern.includes('?')) {
                    // Shift the glob to filePattern and search for any content
                    filePattern = searchPattern.replace('*', '');
                    searchPattern = '.';
                }
                try {
                    const results = await searchInFiles(directory, searchPattern, filePattern);
                    if (results.length === 0)
                        return `No matches found.`;
                    return results.slice(0, 50).join('\n');
                }
                catch (error) {
                    return `Error searching: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            }
        }
    ];
}
/**
 * Normalizes content by replacing problematic Unicode characters with ASCII equivalents.
 * Common in code snippets copied from the web (middle dots for spaces, smart quotes, etc.)
 */
function normalizeContent(text) {
    return text
        .replace(/\u00A0/g, ' ') // Non-breaking space
        .replace(/\u00B7/g, ' ') // Middle dot (sometimes used to show spaces)
        .replace(/\u2018|\u2019/g, "'") // Smart single quotes
        .replace(/\u201C|\u201D/g, '"') // Smart double quotes
        .replace(/\u2013/g, '-') // En dash
        .replace(/\u2014/g, '--') // Em dash
        .replace(/[\u200B-\u200F]/g, '') // Zero width space, non-joiner, joiner, LTR/RTL marks
        .replace(/\u2026/g, '...') // Ellipsis
        .replace(/[\u2028\u2029]/g, '\n'); // Line/paragraph separators
}
//# sourceMappingURL=fileTools.js.map