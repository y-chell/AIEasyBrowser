<img src="app/chrome-extension/assets/logo.png" alt="AIEasyBrowser logo" width="96">

# AIEasyBrowser

**Let agents use the Chrome you already use.**

[中文介绍与使用指南](README_zh.md)

AIEasyBrowser is an agent-native browser control layer exposed through MCP. It connects AI agents to your everyday Chrome profile, with its open tabs, existing login sessions, and installed extensions.

The goal is straightforward: less setup and human interruption, less guesswork when targeting elements, and observable results after each action. Planning and decision-making belong to the agent; AIEasyBrowser provides the browser access, execution, and feedback.

## Why AIEasyBrowser

Browser control should not require a person to approve every reconnection, or a fresh automation profile just to work on a site that is already logged in.

### Connect once, keep working

Some debugging-based tools require a new human approval when reconnecting after a session ends. AIEasyBrowser uses a Chrome extension and a registered Native Messaging host instead. After installation and registration, the extension connects automatically and attempts to reconnect if the bridge disconnects. An agent does not need someone to open an extension panel or approve each bridge connection.

### Keep your existing browser context

Actions run in the profile where the extension is installed, rather than in a separately launched Playwright browser. There is no need to copy cookies or set up another profile just for automation. This avoids the extra login setup that can encounter Cloudflare challenges or site restrictions in a fresh browser environment.

### Give agents actionable page information

`chrome_scan_compact` provides a bounded overview of important text and controls. `chrome_read_page` and `chrome_query_elements` provide element references and DOM information, so agents can target elements instead of relying only on screenshot coordinates.

`chrome_wait_for` and `chrome_assert` let agents wait for page conditions and verify outcomes. Screenshots, console output, network capture, and `chrome_collect_debug_evidence` help explain failures instead of leaving the agent to guess.

### Spend fewer calls on plumbing

The default MCP catalog exposes all 39 browser tools directly, with no discovery step required. Compact scans limit page output, and `chrome_cdp_batch` runs multiple CDP commands in one tool call. Optional smaller catalogs trade extra discovery calls for a smaller initial tool-definition context.

## What agents can do

- Read and operate already-authenticated dashboards, forms, and web applications.
- Work across existing tabs, windows, tab groups, and page frames.
- Click, fill, select, type, scroll, drag, upload files, and handle downloads or dialogs.
- Verify page changes using elements, text, URLs, network activity, and assertions.
- Inspect JavaScript, console messages, network requests, and performance traces.
- Use bookmarks, history, and the clipboard within the connected Chrome profile.

## How it works

```text
MCP client -> AIEasyBrowser Native Server -> Chrome Native Messaging -> AIEasyBrowser extension -> your Chrome profile
```

The extension starts the local bridge through Native Messaging. MCP clients connect through Streamable HTTP, or through the supplied STDIO proxy. Both routes operate the same browser; the STDIO proxy does not launch a separate Chrome instance.

## Getting started

The [installation and configuration guide](README_zh.md#安装) covers source builds, extension loading, Native Host registration, Codex setup, tool catalogs, and connection checks.

- Default MCP endpoint: `http://127.0.0.1:12307/mcp?profile=full`
- Native Messaging host: `com.aieasybrowser.nativehost`
- Stable extension ID: `coleelkpegcobndoloaofalgnkhiamll`

## Security and limitations

AIEasyBrowser controls a real browser profile and its authenticated sessions. The bridge listens on loopback by default; only connect trusted local agents.

Automatic bridge connection does not remove Chrome's permission boundaries, debugger notifications, or a website's own authentication and security checks. Reusing an existing profile is not a promise to bypass Cloudflare, CAPTCHA, or automation detection.

## License

[MIT](LICENSE)
