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

const input = `{"name": "write_file", "arguments":{"path": "sieve_of_atkins.rs", "content": r#"// Sieve of Atkins implementation in Rust. This file includes functionality to generate prime numbers using the Sieve of Atkins algorithm.\n\nfn main() {\n let limit: usize; if std::env::var("LIMIT").ok().map(|v| v.parse().unwrap()).is(Some(limit)) { limit = limit; } else { limit = isize::max(); println!("Generating primes up to the maximum integer value.");}\n let primes = sieve_of_atkins(limit);\n for p in primes.iter(){\n if p*p==usize::MAX{ break; }\n }"}\nif let sqr." matches!(is_prime[\""].into(), vec![1,7,13])" else if sqr.matches(vec![1,3,7])."matches" {}" else if sqr.matches(vec![1,7,19})", lineNumber: false}"`;
fs.writeFileSync('out.json', sanitizeJson(input));
