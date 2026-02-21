const fs = require('fs');

function sanitizeJson(json) {
    let braceDepth = 0;
    let inString = false;
    let escapeNext = false;
    let objectStarted = false;
    let sanitizedChars = [];

    for (let i = 0; i < json.length; i++) {
        const char = json[i];

        if (escapeNext) {
            sanitizedChars.push(char);
            escapeNext = false;
            continue;
        }

        if (char === '\\') {
            sanitizedChars.push(char);
            escapeNext = true;
            continue;
        }

        if (char === '"') {
            inString = !inString;
        } else if (!inString) {
            if (char === '{') {
                braceDepth++;
                objectStarted = true;
            } else if (char === '}') {
                braceDepth--;
            }
        } else {
            if (char === '\n') {
                sanitizedChars.push('\\', 'n');
                continue;
            } else if (char === '\r') {
                sanitizedChars.push('\\', 'r');
                continue;
            } else if (char === '\t') {
                sanitizedChars.push('\\', 't');
                continue;
            }
        }

        sanitizedChars.push(char);

        if (objectStarted && braceDepth === 0) {
            break;
        }
    }

    let cutJson = sanitizedChars.join('');
    if (braceDepth > 0) {
        cutJson += '}'.repeat(braceDepth);
    }

    let sanitized = cutJson
        .replace(/r#"/g, '"')
        .replace(/"#/g, '"')
        .replace(/String\(\d+\)\.toString\(\)/g, '""')
        .replace(/[\u201c\u201d]/g, '"')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u')
        .replace(/,\s*([}\]])/g, '$1') // Fix trailing commas
        .replace(/([{,]\s*)([a-zA-Z0-9_]+)(\s*:)/g, '$1"$2"$3'); // Fix unquoted keys

    return sanitized;
}

function rescueToolCall(jsonStr) {
    const calls = [];
    const nameMatch = jsonStr.match(/"name"\s*[:=]\s*"(\w+)"/);
    if (!nameMatch) return calls;
    const toolName = nameMatch[1];

    if (toolName === 'write_file' || toolName === 'append_file') {
        let path = 'untitled';
        const pathMatch = jsonStr.match(/"path"\s*[:=]\s*"([^"]+)"/);
        if (pathMatch) path = pathMatch[1];

        let contentKeyIdx = jsonStr.indexOf('"content"');
        let content = '';
        if (contentKeyIdx >= 0) {
            const afterKey = jsonStr.substring(contentKeyIdx);
            const contentStart = afterKey.match(/"content"\s*[:=]\s*(?:r#)?"/);
            if (contentStart) {
                content = afterKey.substring(contentStart[0].length);
            }
        }

        if (!content) {
            const pathMatchStr = jsonStr.match(/"path"\s*[:=]\s*"[^"]+"\s*(?:}|\])?\s*,\s*(?:r#)?"/);
            if (pathMatchStr) {
                const startIdx = pathMatchStr.index + pathMatchStr[0].length;
                content = jsonStr.substring(startIdx);
            } else {
                return calls;
            }
        }

        content = content.replace(/["\\s}]*$/, '');
        content = content.replace(/\\\\$/, '');
        content = content
            .replace(/\\\\n/g, '\\n')
            .replace(/\\\\"/g, '"')
            .replace(/\\\\\\\\/g, '\\\\')
            .replace(/\\\\t/g, '\\t')
            .replace(/\\\\r/g, '\\r');

        calls.push({ function: { name: toolName, arguments: JSON.stringify({ path, content }) } });
    }
    return calls;
}

const input = fs.readFileSync('test_input.json', 'utf8');

try {
    const clean = sanitizeJson(input);
    const parsed = JSON.parse(clean);
    console.log("JSON.parse OK!");
} catch (e) {
    console.log("JSON.parse FAILED:", e.message);
    const rescued = rescueToolCall(input);
    console.log("Rescued calls:", rescued.length);
    if (rescued.length > 0) {
        try {
            const resultArg = rescued[0].function.arguments;
            const sanitizedResult = sanitizeJson(resultArg);
            const payload = JSON.parse(sanitizedResult);
            console.log("Content length:", payload.content.length);
        } catch (e) {
            fs.writeFileSync('test_err.txt', e.message + " --- " + sanitizeJson(rescued[0].function.arguments));
            console.log("Wrote out error!");
        }
    }
}
