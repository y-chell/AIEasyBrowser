# AIEasyBrowser

AIEasyBrowser is a browser-only control bridge for agents. It does not run a model, provide a chat UI, store conversations, or manage workflows.

Agents call MCP tools and those tools execute in the Chrome instance you already use. The bridge reuses the current Chrome profile, cookies, extensions, and login state. There is no separate Playwright browser and no repeated click-to-authorize step.

## Architecture

```text
MCP client -> AIEasyBrowser Native Server -> Chrome Native Messaging -> AIEasyBrowser extension -> current Chrome
```

Install the extension and Native Server once. The extension connects to the local bridge automatically, so an agent can read pages, interact with elements, switch tabs, run JavaScript, capture screenshots, inspect network traffic, and use browser data directly.

## Installation and Configuration

The maintained installation, MCP configuration, and verification guide is
[README_zh.md](README_zh.md).

The default endpoint is `http://127.0.0.1:12307/mcp`; the Native Messaging host is
`com.aieasybrowser.nativehost`. A fixed public manifest key gives the extension a
stable ID, so registration does not require an extension ID environment variable.

## Browser Capabilities

- Page reading, interactive-element scans, DOM queries, and element HTML
- Click, fill, select, keyboard, scroll, drag, and combined mouse operations
- Tabs, windows, tab groups, frames, navigation, and new-tab waits
- Screenshots, JavaScript, CDP, console logs, and performance traces
- Network requests, capture, uploads, downloads, and dialogs
- History, bookmarks, clipboard, and userscripts

The MCP server publishes the browser tool catalog directly. AIEasyBrowser contains no model, conversation UI, human annotation flow, recording/replay workflow, or workflow editor.

## Security Boundary

The bridge listens on the local loopback address by default. It controls the real login state in the current Chrome profile; only expose the MCP endpoint to trusted local agents.

## Attribution

Browser tool implementations originate from
[mcp-chrome-community](https://github.com/y-chell/mcp-chrome-community) and
[mcp-chrome](https://github.com/hangwin/mcp-chrome). Their MIT copyright notices
are retained in the license files.
