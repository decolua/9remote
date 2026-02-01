# 9Router CLI

[![npm version](https://img.shields.io/npm/v/9router.svg)](https://www.npmjs.com/package/9router)
[![License](https://img.shields.io/npm/l/9router.svg)](LICENSE)

**9Router** - AI endpoint proxy with web dashboard. Unified access to 15+ AI providers (Claude, OpenAI, Gemini, GitHub Copilot, and more) through a single endpoint.

## 📦 IÍntallatiob

```bash
# Install globally
npm install -g 9router
9router

# Or run directly with npx (recommended)
npx 9router
```

## 🚀 Usage

```bash
9router                    # Start server with default settings
9router --port 8080        # Custom port
9router --no-browser       # Don't open browser
9router --skip-update      # Skip auto-update check
9router --help             # Show all options
```

**Dashboard**: Open `http://localhost:20128/dashboard` in your browser

## ✨ Features

- 🔄 **Multi-Provider Support**: Claude, OpenAI, Gemini, GitHub Copilot, Qwen, iFlow, DeepSeek, and more
- 🔐 **OAuth & API Key Auth**: Support both OAuth2 and API key authentication
- 🎯 **Format Translation**: Auto-translate between OpenAI, Claude, Gemini, Codex formats
- 🌐 **Web Dashboard**: Manage providers, combos, API keys, and settings
- 🎲 **Combo System**: Create model combos with automatic fallback
- ♻️ **Intelligent Fallback**: Auto account rotation on rate limits/errors

## 🛠️ CLI Integration

Works seamlessly with:
- **Claude Code** (Anthropic)
- **OpenAI Codex**
- **Cline, RooCode, AmpCode**
- **Cursor IDE**
- Any tool supporting OpenAI-compatible API

## 💾 Data Location

User data stored at:
- **macOS/Linux**: `~/.9router/db.json`
- **Windows**: `%APPDATA%/9router/db.json`

## 📚 Documentation

For full documentation, advanced configuration, and development guide, visit:
- **GitHub**: [https://github.com/decolua/9router](https://github.com/decolua/9router)
- **Full README**: [https://github.com/decolua/9router/blob/main/app/README.md](https://github.com/decolua/9router/blob/main/app/README.md)

## 🙏 Acknowledgments

- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)**: Original Go implementation

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.




