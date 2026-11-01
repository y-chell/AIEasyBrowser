<img src="app/chrome-extension/assets/logo.png" alt="AIEasyBrowser logo" width="96">

# AIEasyBrowser

**让 Agent 直接操作你正在使用的 Chrome。**

[English](README.md)

AIEasyBrowser 是面向 Agent 的浏览器控制工具，通过 CLI + Skill，把日常使用的 Chrome 变成 AI 可以读取、操作和验证的浏览器环境。已有标签页、登录态和扩展都留在原来的 Chrome profile 中，不必为自动化重新准备一套浏览器。

目标很明确：让 AI 更方便、更快速、更准确地控制浏览器。减少接入和重连时的人工中断，给 Agent 可定位的页面元素，并让每次操作都有可观察、可验证的结果。

## 为什么做 AIEasyBrowser

早期浏览器控制工具往往围绕人机协作设计：人负责确认连接、选择元素、操作界面，AI 辅助完成部分动作。随着 Agent 的规划和执行能力增强，浏览器工具应该专注于提供清晰的执行接口，而不是把任务不断交回给人。

AIEasyBrowser 把任务理解、规划和判断交给 Agent，把浏览器连接、页面读取、动作执行和结果反馈留在工具层。Agent 的能力可以继续提升，浏览器控制不必依赖某个聊天界面或预先编排的工作流。

### 安装一次，不让重连反复打断任务

部分基于调试连接的工具，在会话结束后重新连接时需要人再次点击授权。人不在电脑前，Agent 就只能等待。

AIEasyBrowser 使用 Chrome 扩展与 Native Messaging 建立本机连接。完成扩展安装和 Native Host 注册后，扩展会自动连接；连接中断时会尝试自动恢复。Agent 无需等待人打开扩展面板、点击连接或逐次批准桥接连接。

### 直接复用登录态，不从空白浏览器重新开始

独立启动的自动化浏览器通常使用另一套 profile，不能直接接着日常浏览器中的登录状态工作。重新登录还可能遇到 Cloudflare 验证或网站对自动化环境的限制。

AIEasyBrowser 在安装扩展的 Chrome profile 中执行操作，直接使用已有会话、Cookie 和浏览器环境，不复制 Cookie，也不另建自动化 profile。已经登录的后台、网页应用和当前打开的标签页，可以直接成为 Agent 的工作环境。

### 给 Agent 可操作的目标，而不只是截图

CLI 的 `scan` 返回有全局数量上限的页面概览，包含重要文本、表单控件、按钮和版本化元素引用。引用绑定命名会话、扫描版本、frame 和 Chrome 文档 ID；刷新同一个 URL 后也会拒绝旧引用。底层还有 `chrome_read_page` 的无障碍树和 `chrome_query_elements` 的精确 DOM 查询。

Agent 可以依据元素引用和选择器执行操作，减少只靠截图猜坐标的步骤；需要视觉定位或真实输入事件时，也有截图、鼠标键盘和 CDP 工具。元素引用对应近期页面状态，导航或目标失效后应重新读取，不长期复用过期引用。

### 操作后能等待、验证，失败时有证据

`chrome_wait_for` 等待元素、文本、URL、网络或下载条件，`chrome_assert` 验证预期状态，避免用固定延时猜测页面是否完成。

截图、console、网络抓包和 `chrome_collect_debug_evidence` 为 Agent 提供排错信息，把“点了但没反应”变成可以继续定位的问题。

### 把调用次数花在任务上

CLI 直接发送本机 JSON 请求，不需要协议握手或预加载完整工具 schema。`act` 在一条命令中顺序执行动作、验证明确的后置条件并返回新扫描。Skill 提供使用规则；高级能力需要时才通过 `tools`、`describe`、`call` 查询和调用。

全部 49 个工具都可通过 CLI 使用，包括截图、网络、CDP、剪贴板和性能分析。减少的是 Agent 侧的工具定义上下文、重复输出和任务往返，底层仍由同一扩展执行浏览器动作；Node 冷启动仍有成本，不把调用次数减少等同于每个动作都更快。

## 能做什么

| 能力           | 典型操作                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| 页面读取与定位 | 提取网页内容、扫描交互元素、读取无障碍树、查询 DOM、获取元素 HTML                                       |
| 页面交互       | 点击、填写、选择、键盘输入、滚动、拖拽、综合鼠标操作                                                    |
| 状态等待与验证 | 等待元素和文本变化、URL 变化、网络活动、新标签页和下载；断言预期状态                                    |
| 浏览器管理     | 使用已有标签页和窗口、标签组、页面 frame、历史记录、书签和剪贴板                                        |
| 文件与对话框   | 上传文件、查询上传状态、处理下载、处理网页对话框                                                        |
| 调试与观测     | 截图、JavaScript、CDP、console、网络请求与抓包、存储、性能 trace、CPU profile、CSS 覆盖率、堆实例计数   |
| 页面逆向       | 脚本搜索、断点与变量、fetch/XHR/函数 hook、WebSocket 帧、请求拦截与重放、sourcemap 还原、离线解包与解码 |

适合读取已登录后台的数据、操作网页表单、跨标签页整理信息、验证网页流程，以及排查前端页面和网络问题。

## 工作方式

```text
CLI -> AIEasyBrowser Native Server -> Chrome Native Messaging -> AIEasyBrowser 扩展 -> 当前 Chrome profile
```

扩展通过 Native Messaging 启动本机桥接器。CLI 直接向本机 `/browser` 发送 JSON 请求，命名任务状态保存在这个已常驻的桥接器中，无需另启 daemon，也不会额外启动浏览器。Skill 教 Agent 如何选择目标、使用引用和处理失败，不承担浏览器执行。

## 安装

环境要求：Node.js 20+、Chrome 或 Chromium、pnpm 8+（源码构建）。Windows 下的命令使用 PowerShell 7。

### 1. 从源码构建

进入 AIEasyBrowser 源码根目录后执行：

```powershell
pnpm install --ignore-scripts
pnpm run build
```

构建产物：

- Chrome 扩展：`app/chrome-extension/.output/chrome-mv3`
- Native Server：`app/native-server/dist`

### 2. 加载 Chrome 扩展

打开 `chrome://extensions/`，开启开发者模式，选择“加载已解压的扩展程序”，加载 `app/chrome-extension/.output/chrome-mv3`。

项目使用固定公钥，扩展 ID 为 `coleelkpegcobndoloaofalgnkhiamll`。移动源码目录不会改变扩展 ID，不需要生成密钥或手工填写 ID。

### 3. 注册 Native Host

在源码根目录执行：

```powershell
pnpm --filter aieasybrowser-bridge exec node dist/cli.js register
```

注册默认针对当前用户的 Chrome。使用 Chromium 时，将注册命令改为：

```powershell
pnpm --filter aieasybrowser-bridge exec node dist/cli.js register --browser chromium
```

Native Messaging host 名称为 `com.aieasybrowser.nativehost`。注册不会自动提权，不进行系统级安装；包安装阶段也不会自动修改浏览器注册表。

注册完成后，在扩展管理页重新加载一次 AIEasyBrowser。Chrome 保持运行、扩展启用时，扩展会自动建立桥接连接。

Windows 启动器使用构建或注册时写入 `node_path.txt` 的 Node.js 路径，不依赖 Chrome 继承终端的 `PATH`。更换或移动 Node.js、移动构建产物后，需要重新注册；路径记录缺失或无效时会明确报错。

## CLI + Skill

### 注册 CLI 命令

完成构建和 Native Host 注册后，在源码根目录执行：

```powershell
Push-Location app/native-server
npm link --ignore-scripts --offline
Pop-Location
aieasybrowser health
```

这会把本地源码包的 CLI 链接到当前 Node.js 的全局命令目录，不下载另一个浏览器工具。更换 Node.js 版本后需重新链接。也可以不注册全局命令，直接执行 `node app/native-server/dist/cli.js health`。

CLI 默认连接 `http://127.0.0.1:12307/browser`。显式指定地址时使用 `--url http://127.0.0.1:12307`，或设置下文的 `AIEASYBROWSER_*` 环境变量。该入口只接受回环来源，并校验 Host、Origin 和配置的 bearer token。

### 安装 Skill

主 Skill 位于 `.agents/skills/aieasybrowser/SKILL.md`，只维护这一份。Codex 支持项目内 `.agents/skills`；需要跨项目使用时，可链接到用户 Skill 目录。Claude Code 支持 `~/.claude/skills` 中的目录链接。

以下 PowerShell 7 命令在源码根目录执行，已有同名目录时会明确报错，不会覆盖：

```powershell
$skillSource = (Resolve-Path -LiteralPath '.agents/skills/aieasybrowser').Path
New-Item -ItemType Directory -Force -Path "$HOME/.agents/skills", "$HOME/.claude/skills"
New-Item -ItemType Junction -Path "$HOME/.agents/skills/aieasybrowser" -Target $skillSource
New-Item -ItemType Junction -Path "$HOME/.claude/skills/aieasybrowser" -Target $skillSource
```

移动源码目录后需更新链接。Skill 的发现方式以 [Codex 官方文档](https://developers.openai.com/codex/skills/) 和 [Claude Code 官方文档](https://code.claude.com/docs/en/skills) 为准。CLI + Skill 不需要额外的工具协议配置。

### 操作与验证

为每个任务选择命名会话，后续命令保持同一个 `--session`。`tabs` 列出真实标签，`use` 选择目标而不改变浏览器焦点，`scan` 生成可操作引用：

```powershell
aieasybrowser --session github tabs --match github
aieasybrowser --session github use 123
aieasybrowser --session github scan --limit 40 --text 10
```

把示例 tab ID 和 ref 换成刚返回的值。常见动作可以直接调用，也可以组合成一条命令：

```powershell
aieasybrowser --session github fill <ref> "search terms"
aieasybrowser --session github click <ref> --expect '{"kind":"text","text":"Results"}'
aieasybrowser --session github act '[{"op":"fill","ref":"<ref>","value":"terms"},{"op":"press","keys":"Enter"}]' --expect '{"kind":"element","selector":"#results","state":"visible"}'
```

- `fill` 的值默认是字符串，复选框用 `fill <ref> false --json-value`。`press` 操作已扫描 frame 的焦点元素，不接受 ref，iframe 用 `--frame <id>`。JSON 参数接受 `@file` 或 `@-`，避免复杂 shell 转义。
- `act` 最多顺序执行 20 个 `click`/`fill`/`press`，可检查 `element`、`text`、`url`、`title`、同步 `javascript` 或 `networkIdle` 后置条件，默认返回新扫描。`wait '<条件 JSON>'` 只等待并重新扫描，不重放动作。`open <url>` 打开或复用 URL，`open --current` 导航已选标签；打开不等于页面已就绪。
- 默认扫描最多 40 个元素、10 个文本块、20 个 frame 摘要和 10 条 frame 错误，是整页预算。`truncated: true` 或非空 `errors` 表示没看到完整页面，可用 `scan --frame <id>` 或调大预算。
- 新扫描、动作、`use`、`open`、`eval` 和 `call` 都会让旧引用过期（`--no-scan` 同样）；刷新或导航后旧引用被拒绝。

每条命令 stdout 输出一份 JSON。退出码：`0` 成功、`2` 参数错误、`3` 操作或超时失败、`4` 连接、授权或响应错误、`130` 取消。整条命令默认超时 60 秒，`--timeout <毫秒>` 最大 120 秒。失败时同时看 `phase`、`actionStatus`、`completed`、`failedAction`：`actionStatus: "completed"` 而 `expect`/`scan` 失败说明动作已执行，不要重做；`"unknown"` 说明动作可能已发生，先观察页面。完整错误码和处理方式见 Skill 的 “Results and failures” 表。

### 高级工具

```powershell
aieasybrowser tools screenshot
aieasybrowser describe chrome_screenshot
aieasybrowser --session github call chrome_screenshot '{"savePng":true}'
aieasybrowser --session github eval 'return document.title'
aieasybrowser session --list
aieasybrowser --session github session --forget
```

- `call` 在 session 已选择目标且工具接受 `tabId` 时补入该目标。不带 tab IDs 或 URL 的 `chrome_close_tabs` 只关闭该 session 的已选标签。最多保留 64 个任务 session；`session --forget` 只清状态，不关闭标签。桥接器或扩展重启后状态丢失，需重新选择标签并扫描。
- `call` 在浏览器 IO 前按 `describe` 的 schema 校验参数。非法参数返回 `INVALID_ARGUMENT`（退出码 `2`），错误路径用 JSON Pointer（如 `args/commands/0/method`），不会让已有 ref 失效。校验不做类型转换、不删多余字段、不填默认值。

### 点击与坐标

ref/selector 点击是合成 DOM 事件；`chrome_computer` 的坐标点击走 CDP trusted input。坐标始终是**当前顶层 viewport CSS 像素**：未缩放的 viewport PNG 约为 viewport × DPR，直接把 PNG 像素当坐标会偏右下。优先用当前 `getBoundingClientRect()`，布局变化后重新测量。工具成功只说明事件已派发，必须另查效果，无效果不要自动改成双击。

Chrome 156 的跨站 iframe 样本中，trusted 坐标点击有时送达子控件、有时只到达 iframe 容器，原因未定位（见 `docs/BROWSER-PLAN.md` 的 B4 记录）。不保证跨域 trusted 输入可用，必须核对子 frame 状态。

### 持续 CDP 会话与逆向工具

`chrome_cdp_command`/`chrome_cdp_batch` 每次调用都 attach 再 detach。跨调用的调试、抓包、hook 和存储读写先用 `chrome_cdp_session` 持有标签，用完 `stop`：

```powershell
aieasybrowser --session re call chrome_cdp_session '{"action":"start"}'
aieasybrowser --session re call chrome_cdp_network '{"action":"start"}'
aieasybrowser --session re call chrome_cdp_scripts '{"action":"search","query":"signature"}'
aieasybrowser --session re call chrome_cdp_session '{"action":"stop"}'
```

| 工具                                                       | 用途                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `chrome_cdp_session`                                       | 持有调试会话、缓冲事件、列出跨站 iframe 和 worker 子会话                        |
| `chrome_cdp_scripts`                                       | 列出、分页读取、搜索页面脚本                                                    |
| `chrome_cdp_debugger`                                      | 断点、logpoint、XHR/事件断点、暂停时读调用栈和变量、单步                        |
| `chrome_cdp_inject`                                        | 文档开始前注入脚本；hook 函数、属性、fetch、XHR                                 |
| `chrome_cdp_network`                                       | 请求表、请求/响应体、WebSocket/EventSource 消息、HAR、拦截、重放                |
| `chrome_cdp_storage`                                       | cookie（含 httpOnly、分区）、local/sessionStorage、IndexedDB、Cache Storage     |
| `chrome_cdp_profile`                                       | CSS 覆盖率、CPU profile、堆实例计数                                             |
| `analysis_code` / `analysis_sourcemap` / `analysis_decode` | 本机离线：格式化、解包、AST 搜索、sourcemap 映射与还原、base64/hex/url/jwt 解码 |

参数和失败语义以 Skill 为准。使用边界：

- 会话期间 Chrome 显示调试提示条。会话归启动它的任务所有；`session --forget` 不会释放 Chrome 里的调试会话，必须 `stop`。
- Chrome 不向扩展开放 Profiler 和 HeapProfiler 域，没有 JS 覆盖率和 heap snapshot。
- WebSocket 二进制帧以 base64 返回，AEB 不做 zlib/brotli 解压。
- `chrome_cdp_network` 的拦截和重放会改变真实请求，只用于用户要求的请求。
- 长时间持有的标签上 `stop` 可能超时（`actionStatus: "unknown"`），原因未定位，见 `docs/BROWSER-PLAN.md` 的 B10 记录。此时会话已标记结束，再调用一次 `stop`；调试提示条仍在时关闭该标签。
- 输出默认脱敏，`sanitizeOutput:false` 返回原值。

## 本机连接配置

默认配置即可使用。需要调整时，使用以下环境变量：

| 变量                       | 默认值      | 用途                                                                                        |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `AIEASYBROWSER_HOST`       | `127.0.0.1` | 桥接器监听地址、CLI 连接地址，以及扩展构建时的本机探测地址；只允许回环 host，不带协议或端口 |
| `AIEASYBROWSER_PORT`       | `12307`     | CLI 与 doctor 的连接端口，须与扩展当前使用的端口一致，范围 `1..65535`                       |
| `AIEASYBROWSER_AUTH_TOKEN` | 未设置      | 可选本机 bearer token；桥接器与 CLI 使用同一值，不能包含内部空白                            |
| `AIEASYBROWSER_NODE_PATH`  | 未设置      | Unix 启动器的 Node.js 路径覆盖；Windows 仍只使用 `node_path.txt`                            |

监听端口由扩展通过 Native Messaging 提供，设置 CLI 的端口不会重配置已运行的服务。修改 host 时，扩展构建环境与 Native Host 运行环境必须一致。桥接器继承 Chrome 的运行环境；只在当前终端设置 token 不会改变已运行的桥接器。

项目已移除 `/mcp`、`/sse`、`/messages`、STDIO 代理及 `full` / `core` / `search` 协议 profile。已配置过本项目 MCP 的 Agent 客户端应删除对应服务项。旧 `CHROME_MCP_*`、`MCP_HTTP_*` 环境变量不再读取；浏览器能力没有删除，统一通过 CLI 的 `tools`、`describe`、`call` 按需使用。

Codex 中原服务名为 `aieasybrowser` 时，按[官方命令参考](https://learn.chatgpt.com/docs/developer-commands?surface=cli)移除这一项，不影响其他服务：

```powershell
codex mcp remove aieasybrowser
```

## 连接检查与诊断

运行 `aieasybrowser health`，核对扩展名称为 `AIEasyBrowser`、扩展 ID 为 `coleelkpegcobndoloaofalgnkhiamll`，以及 `nativeHost.serverStatus.isRunning` 为 `true`。`schema.toolCount` 表示扩展支持的完整浏览器能力数，当前为 49。

安装或启动异常时，在源码根目录执行诊断命令：

```powershell
pnpm --filter aieasybrowser-bridge exec node dist/cli.js doctor
```

重新构建扩展后，在扩展管理页点击“重新加载”以应用更新；重新注册 Native Host 后也需要重新加载扩展，使连接使用新的注册信息。

诊断日志写入、轮转和 doctor 探测共用 `native-server.log.lock`。`log lock busy` 表示本次操作未获得锁，应等持有者完成后重试；不要删除仍由活进程持有的锁。异常退出留下的锁包含 PID 和创建时间，确认对应进程已退出后再移除；不会根据锁龄自动抢占。

## 边界与权限

AIEasyBrowser 操作的是真实 Chrome profile 和已登录会话。桥接器只监听本机回环地址，只应向可信的本地 Agent 提供 CLI 访问，不提供远程监听配置。

自动建立桥接连接不等于取消 Chrome 权限限制。使用 debugger/CDP 的工具仍可能显示 Chrome 的调试提示，也可能与其他调试器争用同一标签页；网站自身的登录、验证码、Cloudflare 和风控规则仍然生效。复用现有登录环境，不意味着保证绕过这些检查。

页面工具受扩展可访问范围限制，不能任意读取 Chrome 内部页面。元素引用可能失效，坐标操作也会受页面布局和调试提示栏影响，应基于最新页面状态执行。

`networkIdle` 从调用开始观察目标标签页请求，默认不计静态资源，可用 `includeStatic` 包含它们。成功、超时或取消后都会移除监听器，不会启停或覆盖已有网络抓包；Chrome 未向扩展报告的请求不在观察范围内。

## 开发与测试

在源码根目录执行：

```powershell
pnpm run typecheck
pnpm lint
pnpm test
pnpm run build
```

`pnpm test` 是单元测试，不需要浏览器。以下真实浏览器脚本连接当前运行的桥接器和 Chrome 扩展，不会替你重启桥接器或重载扩展：

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

前置条件：

- 先 `pnpm run build`，在扩展管理页重新加载扩展。
- `aieasybrowser health` 的 `schema.hash` 与本次构建一致，`schema.toolCount` 为 49。doctor 正常。
- `test:cli-regression` 需要能访问 `https://github.com/`，其余脚本只用本机临时网页。
- `test:cli-long-task` 末尾可追加 `1..10` 指定对比轮数（默认 3）。

副作用：

- 脚本启动只绑定回环地址的临时网页，跨源 iframe 用同端口的 localhost 与 127.0.0.1。
- 只在本轮新开的标签上操作，部分脚本会短暂激活这些标签。
- 写入的 cookie、storage key、IndexedDB 库和 cache 都带本轮随机前缀。
- `test:cli-cdp-network` 会写 HAR 文件，`test:cli-cdp-profile` 会写 `.cpuprofile` 文件，`test:cli-analysis` 会建临时输出目录。
- 不改用户账号、原有标签和剪贴板，也不启停用户已有的 trace 或抓包。

清理：

- 结束时删除本轮数据和文件，注销测试 service worker。
- 关闭测试标签和辅助标签，忘记测试任务，退出临时服务。
- 测试失败或清理失败都以非零状态退出；前置条件缺失不记为通过。

脚本通过只说明固定样本和清理都通过，不等于所有网站和全部高级工具都已验收。各阶段的验收结果、已知限制和未定位问题记录在 `docs/BROWSER-PLAN.md`。

## 许可证

[MIT](LICENSE)
