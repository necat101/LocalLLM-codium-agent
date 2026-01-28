# VSCodium Agentic - Local LLM Coding Assistant ***IN PROGRESS***

An open-source, privacy-first agentic coding assistant for VSCodium/VSCode that runs entirely on local LLMs via llama.cpp.

## Features

- **🤖 Agentic Coding** - Autonomous task execution with tool use
- **🔒 Fully Local** - No cloud APIs required, complete privacy
- **🌐 Web Search** - Research documentation and solutions in real-time
- **💻 Terminal Access** - Run tests, builds, and git commands
- **📁 File Operations** - Read, write, edit, and search code files
- **🔄 Streaming** - Real-time response streaming

## Requirements

1. **llama.cpp server** running with a capable model
2. **VSCodium** or **VSCode** 1.80+

### Setting up llama.cpp

```bash
# Clone and build llama.cpp
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp
cmake -B build
cmake --build build --config Release

# Download a model (e.g., Qwen2.5-Coder)
# Place GGUF file in a known location

# Start the server
./build/bin/llama-server -m /path/to/model.gguf --port 8080 --chat-template
```

### Recommended Models

| Model | Parameters | Context | Notes |
|-------|------------|---------|-------|
| Qwen2.5-Coder | 7B-32B | 32K | Excellent code understanding |
| DeepSeek-Coder-V2 | 16B | 128K | Long context, great reasoning |
| CodeLlama | 7B-34B | 16K | Meta's coding model |

## Installation

### From Source

```bash
cd extensions/vscodium-agentic
npm install
npm run compile
```

Then press F5 in VSCodium to launch with the extension.

### From VSIX

```bash
npm run vscode:prepublish
npx vsce package
code --install-extension vscodium-agentic-0.1.0.vsix
```

## Usage

1. Start your llama.cpp server
2. Open the Chat panel (Ctrl+Shift+I or View → Chat)
3. Type `@agent` followed by your request

### Example Prompts

```
@agent Create a Python script that fetches weather data from an API

@agent What does the function on line 50 of src/main.ts do?

@agent Run the tests and fix any failures

@agent Search for how to implement WebSocket in Node.js
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `agentic.llamaCpp.endpoint` | `http://localhost:8080` | llama.cpp server URL |
| `agentic.model.maxTokens` | `4096` | Max tokens per response |
| `agentic.agent.maxIterations` | `15` | Max tool call loops |
| `agentic.tools.requireConfirmation` | `true` | Confirm before running commands |
| `agentic.tools.allowedCommands` | `["npm", "node", "git", ...]` | Commands that run without confirmation |

## Tools

The agent has access to these tools:

| Tool | Description |
|------|-------------|
| `web_search` | Search the internet for information |
| `run_command` | Execute shell commands |
| `read_file` | Read file contents |
| `write_file` | Create or overwrite files |
| `edit_file` | Make targeted edits |
| `list_directory` | Explore file structure |
| `search_files` | Grep-like pattern search |

## Architecture

```
┌─────────────────┐     ┌───────────────────┐
│  Chat UI Panel  │────▶│  AgentChat Class  │
└─────────────────┘     └────────┬──────────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
            ┌───────────┐ ┌───────────┐ ┌─────────┐
            │  llama.cpp│ │ Tool      │ │ History │
            │  Client   │ │ Registry  │ │ Manager │
            └─────┬─────┘ └─────┬─────┘ └─────────┘
                  │             │
                  ▼             ▼
            ┌───────────┐ ┌──────────────────────────┐
            │ Local LLM │ │ web_search │ run_command │
            │ (GGUF)    │ │ read_file  │ write_file  │
            └───────────┘ └──────────────────────────┘
```

## Roadmap

- [ ] Inline code suggestions
- [ ] Diff view for file changes
- [ ] Multi-model support
- [ ] Hierarchos architecture integration
- [ ] Vulkan backend for broader GPU support

## License

MIT

