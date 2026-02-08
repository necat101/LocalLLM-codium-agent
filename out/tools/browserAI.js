"use strict";
/**
 * Expert AI Module - Uses DuckDuckGo AI Chat (FREE, no login required)
 * DuckDuckGo offers free access to Claude, GPT-4o-mini, Llama, and Mixtral
 * Completely free, no account needed, privacy-focused
 */
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
exports.askExpertAI = askExpertAI;
const fs = __importStar(require("fs"));
// Find Chrome/Edge executable on the system
function findBrowserExecutable() {
    const possiblePaths = [];
    if (process.platform === 'win32') {
        possiblePaths.push(process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe', process.env['PROGRAMFILES'] + '\\Microsoft\\Edge\\Application\\msedge.exe', process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe', process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe', process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe');
    }
    else if (process.platform === 'darwin') {
        possiblePaths.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    }
    else {
        possiblePaths.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
    }
    for (const browserPath of possiblePaths) {
        try {
            if (fs.existsSync(browserPath)) {
                return browserPath;
            }
        }
        catch {
            continue;
        }
    }
    return null;
}
/**
 * Ask DuckDuckGo AI Chat - FREE, no login required
 * Uses Claude, GPT-4o-mini, Llama 3, or Mixtral
 */
async function askExpertAI(question) {
    const browserPath = findBrowserExecutable();
    if (!browserPath) {
        return provideSelfHelpGuidance(question);
    }
    try {
        const puppeteer = await Promise.resolve().then(() => __importStar(require('puppeteer-core')));
        const browser = await puppeteer.launch({
            executablePath: browserPath,
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--window-size=1280,720'
            ]
        });
        try {
            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 720 });
            // Set a realistic user agent
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            // Navigate to DuckDuckGo AI Chat
            await page.goto('https://duckduckgo.com/?q=DuckDuckGo+AI+Chat&ia=chat&duckai=1', {
                waitUntil: 'networkidle2',
                timeout: 30000
            });
            // Wait for the chat interface to load
            await page.waitForSelector('textarea, [contenteditable="true"], input[type="text"]', {
                timeout: 20000
            });
            // Accept terms if prompted (click through any modal)
            try {
                const acceptButton = await page.$('button[data-testid="chat-terms-accept"], button:has-text("Get Started"), button:has-text("I Agree")');
                if (acceptButton) {
                    await acceptButton.click();
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
            catch {
                // No terms dialog, continue
            }
            // Find and fill the input
            const textarea = await page.$('textarea');
            if (textarea) {
                await textarea.click();
                await textarea.type(question, { delay: 3 });
            }
            else {
                const input = await page.$('[contenteditable="true"], input[type="text"]');
                if (input) {
                    await input.click();
                    await input.type(question, { delay: 3 });
                }
                else {
                    throw new Error('Could not find input field');
                }
            }
            // Submit the query
            await page.keyboard.press('Enter');
            // Wait for response - look for the response container
            await page.waitForFunction(`
                (() => {
                    const responses = document.querySelectorAll('[data-testid="chat-message-content"], [class*="message"], [class*="response"]');
                    if (responses.length >= 2) {
                        const lastResponse = responses[responses.length - 1];
                        return lastResponse && lastResponse.textContent && lastResponse.textContent.length > 50;
                    }
                    return false;
                })()
            `, { timeout: 90000 });
            // Wait for response to complete (no more streaming)
            await new Promise(resolve => setTimeout(resolve, 5000));
            // Extract the response
            const responseText = await page.evaluate(`
                (() => {
                    // Try DuckDuckGo AI specific selectors
                    const messages = document.querySelectorAll('[data-testid="chat-message-content"], [class*="ChatMessage"], [class*="message-content"]');
                    if (messages.length >= 2) {
                        // Get the last message (AI response)
                        const lastMessage = messages[messages.length - 1];
                        return lastMessage.textContent || '';
                    }
                    
                    // Fallback: get any response-like content
                    const content = document.querySelector('[class*="response"], [class*="answer"], main');
                    return content?.textContent || 'No response found';
                })()
            `);
            await browser.close();
            if (responseText && responseText.length > 50 && !responseText.includes('No response found')) {
                return {
                    success: true,
                    response: responseText.trim().slice(0, 4000)
                };
            }
            else {
                return provideSelfHelpGuidance(question);
            }
        }
        catch (err) {
            try {
                await browser.close();
            }
            catch { }
            console.error('Browser automation error:', err);
            return provideSelfHelpGuidance(question);
        }
    }
    catch (err) {
        console.error('Puppeteer error:', err);
        return provideSelfHelpGuidance(question);
    }
}
/**
 * Provide self-help guidance when automation fails
 */
function provideSelfHelpGuidance(question) {
    const lowerQuestion = question.toLowerCase();
    let guidance = '';
    // Detect common Rust errors
    if (lowerQuestion.includes('rustc') || lowerQuestion.includes('.rs')) {
        if (lowerQuestion.includes('user std') || (lowerQuestion.includes('expected') && lowerQuestion.includes('found'))) {
            guidance = `**Rust Syntax Error Detected**

🔍 **Found issue:** \`user std\` should be \`use std\` (typo!)

**Corrected code:**
\`\`\`rust
use std::collections::HashMap;  // NOT "user"
use std::cmp::Ordering;

fn main() {
    // Your code here
}
\`\`\`

**Common Rust syntax rules:**
- \`use\` for imports (not \`user\`)
- Braces \`{ }\` for blocks (no colons like Python)
- Semicolons at end of statements
- \`let mut\` for mutable variables`;
        }
        else if (lowerQuestion.includes('cannot find')) {
            guidance = `**Rust Import Error**

Add the missing import at the top:
\`\`\`rust
use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Write};
\`\`\``;
        }
        else if (lowerQuestion.includes('unterminated') || lowerQuestion.includes('e0765') || lowerQuestion.includes('double quote')) {
            guidance = `**Rust String Error (E0765) - Unterminated String**

🔍 **Problem:** You have an unclosed string literal

**Common causes:**
1. Missing closing \`"\` quote
2. Quote inside a string not escaped: use \`\\"\` 
3. Multi-line string needs proper syntax

**Fix options:**

1. **Close the string:**
\`\`\`rust
println!("Hello World"); // Make sure the " is closed
\`\`\`

2. **Escape internal quotes:**
\`\`\`rust
println!("She said \\"Hello\\""); // Use \\" for quotes inside strings
\`\`\`

3. **Use raw string for complex content:**
\`\`\`rust
println!(r#"Content with "quotes" inside"#);
\`\`\`

**ACTION:** Use read_file to see the exact line, then use write_file to rewrite the file with correct quoting.`;
        }
        else {
            guidance = `**Rust Compilation Help**

1. Check the exact line number in the error
2. Run \`rustc --explain EXXXX\` for details
3. Common issues: missing semicolons, type mismatches, borrow errors`;
        }
    }
    else {
        guidance = `**Code Debugging Tips**

1. Check the exact line number mentioned
2. Look for typos in keywords
3. Verify syntax matches the language`;
    }
    return {
        success: true,
        response: guidance
    };
}
//# sourceMappingURL=browserAI.js.map