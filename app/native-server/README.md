# AIEasyBrowser Native Server

Native Server is the local bridge between the AIEasyBrowser CLI and the Chrome extension. It holds named task sessions and document-bound references, runs ordered action/check/scan commands, and dispatches all 39 browser capabilities through Chrome Native Messaging. It does not run a model, host a chat UI, or store conversations.

The maintained build, registration, CLI + Skill configuration, and verification guide is
[README_zh.md](../../README_zh.md) at the repository root.

The CLI entrypoint is `dist/cli.js` and its default HTTP endpoint is
`http://127.0.0.1:12307/browser`. The Native Messaging host is
`com.aieasybrowser.nativehost`, and it only allows the fixed AIEasyBrowser extension ID.

The bridge only listens on loopback and checks the request Host, Origin, and optional bearer token. There is no MCP transport, STDIO proxy, or remote-listener configuration.
