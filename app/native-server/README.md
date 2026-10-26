# AIEasyBrowser Native Server

Native Server is the local bridge between an MCP client and the AIEasyBrowser Chrome extension. It only forwards browser tool calls through Chrome Native Messaging and exposes MCP transports. It does not run a model, host a chat UI, store conversations, or manage workflows.

The maintained build, registration, MCP configuration, and verification guide is
[README_zh.md](../../README_zh.md) at the repository root.

The HTTP MCP endpoint is `http://127.0.0.1:12307/mcp`. The STDIO entry point is
`dist/mcp/mcp-server-stdio.js`. The Native Messaging host is
`com.aieasybrowser.nativehost`, and it only allows the fixed AIEasyBrowser extension ID.

The bridge listens on loopback by default. Configure an explicit authentication token and allowed hosts before exposing the HTTP server beyond the local machine.
