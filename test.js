const jsonStr = `{"name": "write_file", "arguments":{"path": "sieve_of_atkins.rs", "content": r#"// Sieve of Atkins implementation in Rust

fn is_prime(mut n: u64, sqrt: u64) -> bool {
if n < 2 { return false;
}
set_panic_on_error!();"}"}}`;

let contentKeyIdx = jsonStr.indexOf('"content"');
if (contentKeyIdx < 0) contentKeyIdx = jsonStr.indexOf('"text"');
if (contentKeyIdx < 0) contentKeyIdx = jsonStr.indexOf('"code"');

let content = '';
if (contentKeyIdx >= 0) {
    const afterKey = jsonStr.substring(contentKeyIdx);
    const contentStart = afterKey.match(/"(?:content|text|code)"\s*[:=]\s*(?:r#)?"/);
    if (contentStart) {
        content = afterKey.substring(contentStart[0].length);
    }
}

if (!content) {
    const pathMatchStr = jsonStr.match(/"path"\s*[:=]\s*"[^"]+"\s*(?:}|\])?\s*,\s*(?:r#)?"/);
    if (pathMatchStr) {
        const startIdx = pathMatchStr.index + pathMatchStr[0].length;
        content = jsonStr.substring(startIdx);
    }
}

content = content.replace(/["\s}]*$/, '');

console.log('LENGTH:', content.length);
console.log('CONTENT:', content);
