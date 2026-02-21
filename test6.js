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

const input = `{"name": "edit_file", "arguments":{"path": "src/sieve_atkin.rs", "replace": "\\u2793\\uffcf", "search": "\\u00a4"}}`;

let tc = {
    function: {
        name: "edit_file",
        arguments: `{"path": "src/sieve_atkin.rs", "replace": "\\u2793\\uffcf", "search": "\\u00a4"}`
    }
}

let args = {};
try {
    args = JSON.parse(sanitizeJson(tc.function.arguments));
} catch (e) {
    console.log("PARSE FAILED", e);
}

console.log("Parsed Args:", args);
console.log("Search Parameter:", args.search);
