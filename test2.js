function sanitizeJson(json) {
    let braceDepth = 0;
    let inString = false;
    let escapeNext = false;
    let objectStarted = false;
    let sanitizedChars = [];

    // Strip out r#" "# early to test if it fixes the counting?
    // Wait, the loop processes char by char.
    // Let's just run it as is.
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
            // We are inside a string. If we see a literal newline, escape it.
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

    return cutJson;
}

const input = `{"name": "write_file", "arguments":{"path": "sieve.rs", "content": r#"fn main() { println!("Hello!"); }"#}}`;
console.log('OUTPUT:', sanitizeJson(input));
