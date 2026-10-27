<img src="app/chrome-extension/assets/logo.png" alt="AIEasyBrowser logo" width="96">

# AIEasyBrowser

**Let agents use the Chrome you already use.**

[中文介绍与使用指南](README_zh.md)

AIEasyBrowser is an agent-native browser control layer with a CLI + Skill entrypoint and an existing MCP interface. It connects AI agents to your everyday Chrome profile, with its open tabs, existing login sessions, and installed extensions.

The goal is straightforward: less setup and human interruption, less guesswork when targeting elements, and observable results after each action. Planning and decision-making belong to the agent; AIEasyBrowser provides the browser access, execution, and feedback.

## Why AIEasyBrowser

Browser control should not require a person to approve every reconnection, or a fresh automation profile just to work on a site that is already logged in.

### Connect once, keep working

Some debugging-based tools require a new human approval when reconnecting after a session ends. AIEasyBrowser uses a Chrome extension and a registered Native Messaging host instead. After installation and registration, the extension connects automatically and attempts to reconnect if the bridge disconnects. An agent does not need someone to open an extension panel or approve each bridge connection.

### Keep your existing browser context

Actions run in the profile where the extension is installed, rather than in a separately launched Playwright browser. There is no need to copy cookies or set up another profile just for automation. This avoids the extra login setup that can encounter Cloudflare challenges or site restrictions in a fresh browser environment.

### Give agents actionable page information

CLI `scan` provides a globally bounded overview of important text and controls. Its handles bind the named task session, scan revision, frame, and Chrome document ID, so even a refresh to the same URL rejects old handles. `chrome_read_page` and `chrome_query_elements` provide additional accessibility and DOM information.

`chrome_wait_for` and `chrome_assert` let agents wait for page conditions and verify outcomes. Screenshots, console output, network capture, and `chrome_collect_debug_evidence` help explain failures instead of leaving the agent to guess.

### Spend fewer calls on plumbing

The CLI makes direct local JSON requests without MCP initialization or a tool-catalog preload. Named sessions survive separate CLI processes, and `act` runs an ordered action sequence, checks an explicit postcondition, and returns a fresh scan in one command. The short Skill teaches reference lifetimes and failure handling; advanced schemas are loaded only when needed.

MCP still exposes all 39 browser tools. Both entrypoints reuse the same browser execution layer. Fewer agent-side round trips and tool definitions do not imply that every cold Node CLI launch is faster than a warm MCP call.

## What agents can do

- Read and operate already-authenticated dashboards, forms, and web applications.
- Work across existing tabs, windows, tab groups, and page frames.
- Click, fill, select, type, scroll, drag, upload files, and handle downloads or dialogs.
- Verify page changes using elements, text, URLs, network activity, and assertions.
- Inspect JavaScript, console messages, network requests, and performance traces.
- Use bookmarks, history, and the clipboard within the connected Chrome profile.

## How it works

```text
CLI / MCP client -> AIEasyBrowser Native Server -> Chrome Native Messaging -> AIEasyBrowser extension -> your Chrome profile
```

The extension starts the local bridge through Native Messaging. CLI requests go directly to `/browser`, with task state held in that existing bridge, not another daemon. MCP clients use Streamable HTTP or the supplied STDIO proxy. All entrypoints operate the same browser.

## Getting started

The [installation and configuration guide](README_zh.md#安装) covers source builds, extension loading, Native Host registration, CLI linking, Skill installation, and MCP setup. The canonical Skill is [`.agents/skills/aieasybrowser/SKILL.md`](.agents/skills/aieasybrowser/SKILL.md); it can be linked into user Skill directories without maintaining duplicate instructions.

- Default CLI endpoint: `http://127.0.0.1:12307/browser` (loopback only)
- Default MCP endpoint: `http://127.0.0.1:12307/mcp?profile=full`
- Native Messaging host: `com.aieasybrowser.nativehost`
- Stable extension ID: `coleelkpegcobndoloaofalgnkhiamll`

## CLI workflow

Select a named task session, choose an actual tab from `tabs`, then `scan`. Use the returned handles with `click`, `fill`, or a short `act` batch, and supply a site-specific `--expect` for asynchronous effects. Actions/checks/rescans return one JSON result per command.

New scans and actions expire previous handles. `STALE_REF` or `STALE_DOCUMENT` requires a new scan. On failure, inspect `phase`, `actionStatus`, and `completed`: an assertion or scan failure after completed actions is not a reason to replay them, and `unknown` means a sent action may have happened. No automatic action replay or state recovery is performed after a bridge restart.

Exit codes are `0` success, `2` invalid arguments, `3` operation/timeout failure, `4` connection/protocol failure, and `130` cancellation. Discover advanced capabilities with `tools`, `describe`, and `call` instead of loading the entire catalog. See the [CLI operation guide](README_zh.md#cli--skill) for copyable commands and target rules.

## Security and limitations

AIEasyBrowser controls a real browser profile and its authenticated sessions. The bridge listens on loopback by default; only connect trusted local agents.

Automatic bridge connection does not remove Chrome's permission boundaries, debugger notifications, or a website's own authentication and security checks. Reusing an existing profile is not a promise to bypass Cloudflare, CAPTCHA, or automation detection.

## License

[MIT](LICENSE)
