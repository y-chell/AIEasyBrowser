# AIEasyBrowser Chrome Extension

This extension is the browser-side runtime for AIEasyBrowser. It has no popup, side panel, options page, chat UI, or user workflow editor.

The background service worker connects to `com.aieasybrowser.nativehost` automatically and executes MCP browser tool calls in the current Chrome profile. The offscreen document is created only when clipboard access is needed.

Build and installation instructions are maintained in the repository's
[README_zh.md](../../README_zh.md). The extension uses a fixed public key and
connects to the independent local bridge on port `12307`.
