<img src="app/chrome-extension/assets/logo.png" alt="AIEasyBrowser logo" width="96">

# AIEasyBrowser

**Let agents use the Chrome you already use.**

[中文](README_zh.md)

AIEasyBrowser is a browser control tool for AI agents, driven through a CLI and a Skill. It turns your everyday Chrome into a browser that an agent can read, operate, and verify. Your open tabs, logged-in sessions, and extensions stay in the profile you already use; there is no separate automation browser to set up.

The goal is to make browser control easier, faster, and more accurate for agents: fewer human interruptions when connecting, page elements the agent can target directly, and an observable, checkable result after every action.

## Why AIEasyBrowser

Early browser tools were built for human-AI collaboration: a person approved the connection, picked elements, and drove the interface while the AI helped with some steps. Agents can now plan and execute on their own, so a browser tool should offer a clear execution interface instead of handing the task back to a person.

AIEasyBrowser leaves understanding, planning, and judgement to the agent, and keeps the browser connection, page reading, action execution, and feedback in the tool layer.

### Connect once, keep working

Some debugging-based tools ask a person to approve again every time they reconnect after a session ends. If nobody is at the computer, the agent waits.

AIEasyBrowser connects through a Chrome extension and Native Messaging. After the extension is installed and the Native Host is registered, the extension connects on its own and tries to reconnect if the link drops. The agent never waits for someone to open an extension panel or approve a connection.

### Keep your existing browser context

A separately launched automation browser usually runs another profile, so it cannot pick up the logins of your everyday browser, and logging in again may hit Cloudflare checks or site restrictions on automated environments.

AIEasyBrowser acts inside the Chrome profile where the extension is installed, with its existing sessions, cookies, and environment. Nothing is copied and no extra profile is created. Dashboards and web apps you are already logged into become the agent's workspace.

### Targets, not just screenshots

`scan` returns a bounded overview of the page: important text, form controls, buttons, and versioned element references. A reference is tied to the task, the scan, the frame, and Chrome's document ID, so even a refresh of the same URL rejects old references. The accessibility tree (`chrome_read_page`) and precise DOM queries (`chrome_query_elements`) are available underneath.

The agent acts on references and selectors instead of guessing coordinates from screenshots. When it needs visual positioning or real input events, screenshots, mouse and keyboard tools, and CDP are there too.

### Wait, verify, and keep evidence

`chrome_wait_for` waits for elements, text, URLs, network activity, or downloads, and `chrome_assert` checks the expected state, so the agent does not guess with fixed sleeps. Screenshots, console output, network capture, and `chrome_collect_debug_evidence` turn "I clicked and nothing happened" into something the agent can investigate.

### Spend calls on the task

The CLI sends local JSON requests directly, with no protocol handshake and no full tool catalog to preload. `act` runs several actions, checks a postcondition, and returns a fresh scan in one command. The Skill holds the usage rules; advanced tools are looked up with `tools`, `describe`, and `call` only when needed.

All 49 tools are available through the CLI. What shrinks is the agent's tool-definition context, repeated output, and round trips; each browser action still runs in the same extension, and starting Node still costs time.

## What it can do

| Area                      | Typical operations                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reading and locating      | Extract page content, scan interactive elements, read the accessibility tree, query the DOM, get element HTML                                                                                  |
| Interaction               | Click, fill, select, type, scroll, drag, combined mouse actions                                                                                                                                |
| Waiting and checks        | Wait for elements, text, URL changes, network activity, new tabs, and downloads; assert expected state                                                                                         |
| Browser management        | Existing tabs and windows, tab groups, frames, history, bookmarks, clipboard                                                                                                                   |
| Files and dialogs         | Upload files, check upload status, handle downloads and page dialogs                                                                                                                           |
| Debugging and observation | Screenshots, JavaScript, console, network capture, cookies and all storage types, performance traces, CPU profiles, CSS coverage, heap instance counts                                         |
| Page reverse engineering  | Search page scripts, inspect variables at breakpoints, hook fetch/XHR/functions, read WebSocket frames, intercept and replay requests, restore source maps, format, unpack, and decode offline |

Good fits: reading data from logged-in dashboards, filling web forms, collecting information across tabs, checking web flows, and debugging front-end and network problems.

## How it works

```text
CLI -> AIEasyBrowser Native Server -> Chrome Native Messaging -> AIEasyBrowser extension -> your Chrome profile
```

The extension starts the local bridge through Native Messaging. The CLI sends JSON requests to the local `/browser` endpoint, and task state lives in that bridge, so there is no extra daemon and no extra browser. The Skill teaches the agent how to choose targets, use references, and handle failures; it does not execute anything itself.

## Installation

Requirements: Node.js 20+, Chrome or Chromium, and pnpm 8+ for source builds. Windows commands below use PowerShell 7.

### 1. Build from source

From the repository root:

```powershell
pnpm install --ignore-scripts
pnpm run build
```

Build output:

- Chrome extension: `app/chrome-extension/.output/chrome-mv3`
- Native Server: `app/native-server/dist`

### 2. Load the Chrome extension

Open `chrome://extensions/`, turn on Developer mode, choose "Load unpacked", and select `app/chrome-extension/.output/chrome-mv3`.

The project ships a fixed public key, so the extension ID is always `coleelkpegcobndoloaofalgnkhiamll`. Moving the source directory does not change it, and there is no key to generate or ID to enter.

### 3. Register the Native Host

From the repository root:

```powershell
pnpm --filter aieasybrowser-bridge exec node dist/cli.js register
```

This registers for the current user's Chrome. For Chromium, use:

```powershell
pnpm --filter aieasybrowser-bridge exec node dist/cli.js register --browser chromium
```

The Native Messaging host is `com.aieasybrowser.nativehost`. Registration never elevates privileges or installs system-wide, and package installation does not touch the browser registry.

After registering, reload AIEasyBrowser once on the extensions page. While Chrome runs with the extension enabled, the extension connects to the bridge on its own.

On Windows the launcher uses the Node.js path recorded in `node_path.txt` at build or registration time, not the `PATH` Chrome inherited. Register again after changing or moving Node.js or the build output; a missing or invalid path fails with a clear error.

## CLI + Skill

### Register the CLI command

After building and registering the Native Host, run from the repository root:

```powershell
Push-Location app/native-server
npm link --ignore-scripts --offline
Pop-Location
aieasybrowser health
```

This links the local CLI into the current Node.js global bin directory; nothing else is downloaded. Link again after switching Node.js versions. Without a global command, run `node app/native-server/dist/cli.js health` instead.

The CLI connects to `http://127.0.0.1:12307/browser` by default. Pass `--url http://127.0.0.1:12307` or set the `AIEASYBROWSER_*` variables below to change it. The endpoint accepts only loopback clients and checks Host, Origin, and the optional bearer token.

### Install the Skill

The only Skill is `.agents/skills/aieasybrowser/SKILL.md`. Codex reads project `.agents/skills`; to use it in other projects, link it into your user Skill directories. Claude Code accepts directory links in `~/.claude/skills`.

Run from the repository root in PowerShell 7. An existing directory with the same name makes the command fail instead of being overwritten:

```powershell
$skillSource = (Resolve-Path -LiteralPath '.agents/skills/aieasybrowser').Path
New-Item -ItemType Directory -Force -Path "$HOME/.agents/skills", "$HOME/.claude/skills"
New-Item -ItemType Junction -Path "$HOME/.agents/skills/aieasybrowser" -Target $skillSource
New-Item -ItemType Junction -Path "$HOME/.claude/skills/aieasybrowser" -Target $skillSource
```

Update the links after moving the repository. See the [Codex docs](https://developers.openai.com/codex/skills/) and [Claude Code docs](https://code.claude.com/docs/en/skills) for how Skills are discovered.

## Quick start

```powershell
aieasybrowser health
aieasybrowser --session demo tabs --match github
aieasybrowser --session demo use 123
aieasybrowser --session demo scan
aieasybrowser --session demo click <ref> --expect '{"kind":"text","text":"Results"}'
```

Replace the tab ID and ref with the values the previous step returned. `--session` names the task: keep the same name for one task and it remembers the selected tab and the latest scan. Each command prints one JSON object; check `ok`. Advanced tools such as screenshots, network capture, and breakpoints are found with `tools`, described with `describe`, and run with `call`.

In daily use the agent issues these commands following the rules in the Skill: how to choose targets, when references expire, and when a failure may be retried. You describe the task and check the result.

## Known limitations

- No JavaScript coverage or heap snapshot: Chrome does not give extensions the Profiler or HeapProfiler domains. CSS coverage, CPU profiles, and per-constructor instance counts work.
- Binary WebSocket frames are returned as-is; there is no zlib/brotli decompression.
- Trusted clicks inside cross-site iframes are unreliable and sometimes reach only the iframe container; cause not identified.
- `stop` of a debugging session held for a long time occasionally times out; cause not identified.
- Chrome shows its debugging banner while debugging tools run.

`docs/BROWSER-PLAN.md` records how each of these was checked.

## Local connection settings

The defaults work as they are. To change them, set:

| Variable                   | Default     | Purpose                                                                                                         |
| -------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| `AIEASYBROWSER_HOST`       | `127.0.0.1` | Bridge listen address, CLI target, and the address the extension build probes; loopback only, no scheme or port |
| `AIEASYBROWSER_PORT`       | `12307`     | Port for the CLI and doctor; must match the port the extension uses, `1..65535`                                 |
| `AIEASYBROWSER_AUTH_TOKEN` | unset       | Optional local bearer token; the bridge and CLI must use the same value, no inner whitespace                    |
| `AIEASYBROWSER_NODE_PATH`  | unset       | Node.js path override for the Unix launcher; Windows uses `node_path.txt` only                                  |

The extension supplies the listen port through Native Messaging, so setting these variables in a terminal does not reconfigure a bridge that is already running. If you change the host, the extension build environment and the Native Host runtime must agree.

The MCP endpoints (`/mcp`, `/sse`, `/messages`) and the STDIO proxy have been removed, and the old `CHROME_MCP_*` and `MCP_HTTP_*` variables are no longer read; every browser capability remains in the CLI. If an agent client still has this project configured as an MCP server, remove that entry, for example in Codex:

```powershell
codex mcp remove aieasybrowser
```

## Health check and diagnostics

Run `aieasybrowser health` and confirm the extension name is `AIEasyBrowser`, the extension ID is `coleelkpegcobndoloaofalgnkhiamll`, `nativeHost.serverStatus.isRunning` is `true`, and `schema.toolCount` is 49.

If installation or startup fails, run the diagnostics from the repository root:

```powershell
pnpm --filter aieasybrowser-bridge exec node dist/cli.js doctor
```

Reload the extension on the extensions page after rebuilding it or registering the Native Host again. `log lock busy` means another process is writing logs or running diagnostics; retry later, and do not delete a `native-server.log.lock` that a live process still holds.

## Security and permissions

AIEasyBrowser controls a real Chrome profile and its logged-in sessions. The bridge listens on loopback only; give CLI access only to trusted local agents. There is no remote listening option.

Connecting automatically does not lift Chrome's permission boundaries. Debugging tools show Chrome's debugging banner and may compete with DevTools or other extensions for the same tab. A site's own login, CAPTCHA, Cloudflare, and risk checks still apply; reusing an existing profile is not a promise to bypass them. The extension cannot read Chrome's internal pages.

## Development and tests

From the repository root:

```powershell
pnpm run typecheck
pnpm lint
pnpm test
pnpm run build
```

`pnpm test` runs unit tests and needs no browser. The real-browser acceptance scripts connect to the running bridge and extension: build first, reload the extension on the extensions page, and check that `aieasybrowser health` reports the `schema.hash` of this build.

```powershell
pnpm test:cli-regression
pnpm test:cli-long-task
pnpm test:cli-cdp-session
pnpm test:cli-cdp-scripts
pnpm test:cli-cdp-debugger
pnpm test:cli-cdp-contexts
pnpm test:cli-cdp-inject
pnpm test:cli-cdp-network
pnpm test:cli-cdp-storage
pnpm test:cli-cdp-profile
pnpm test:cli-analysis
```

`test:cli-regression` needs access to GitHub; the others use local temporary pages only. Scripts touch only the tabs they open and the data they write, and clean everything up at the end; a failure or a failed cleanup exits non-zero.

## License

[MIT](LICENSE)
