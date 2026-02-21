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
        .replace(/'([^'\\]*)'/g, '"$1"')
        .replace(/[\u201c\u201d]/g, '"')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/\\u(?![0-9a-fA-F]{4})/g, '\\u')
        .replace(/,\s*([}\]])/g, '$1') // Fix trailing commas
        .replace(/([{,]\s*)([a-zA-Z0-9_]+)(\s*:)/g, '$1"$2"$3'); // Fix unquoted keys

    return sanitized;
}

const input = `{"name": "write_file", "arguments": {"path": "sieve_of_atkin.rs", "content": "# Sieve of Atkin implementation\\n\\nfn sieve_of_atkin(limit: usize) -> Vec<usize> { let mut is_prime = vec![true; limit]; is_prime[0] = false; is_prime[1] = false;\\nlet sqrt_limit: usize = limit as f64.sqrt() as usize;\\nfor n in (5..=limit).step_by(2) {\\n let mut count = 0;\\n // x^2 ≡ mod12y^2? Check all combinations for Atkin sieve\\n if let Some(mod1) = n.to_string().find(|c| c == '1') else { continue; } // placeholder: actual mod checks go here\\n}\\nreturn is_prime.iter().enumerate().filter(|(_,&p)| p).map(|(i,_)| i).collect();\\n}\\n"}}`;
const output = sanitizeJson(input);
console.log(output);
try {
    const o = JSON.parse(output);
    console.log("SUCCESS!");
} catch (e) {
    console.log("FAILED PARSE");
    console.log(e);
}
