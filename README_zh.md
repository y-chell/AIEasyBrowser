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

全部 39 项浏览器能力都可通过 CLI 使用，包括截图、网络、CDP、剪贴板和性能分析。减少的是 Agent 侧的工具定义上下文、重复输出和任务往返，底层仍由同一扩展执行浏览器动作；Node 冷启动仍有成本，不把调用次数减少等同于每个动作都更快。

## 能做什么

| 能力           | 典型操作                                                             |
| -------------- | -------------------------------------------------------------------- |
| 页面读取与定位 | 提取网页内容、扫描交互元素、读取无障碍树、查询 DOM、获取元素 HTML    |
| 页面交互       | 点击、填写、选择、键盘输入、滚动、拖拽、综合鼠标操作                 |
| 状态等待与验证 | 等待元素和文本变化、URL 变化、网络活动、新标签页和下载；断言预期状态 |
| 浏览器管理     | 使用已有标签页和窗口、标签组、页面 frame、历史记录、书签和剪贴板     |
| 文件与对话框   | 上传文件、查询上传状态、处理下载、处理网页对话框                     |
| 调试与观测     | 截图、JavaScript、CDP、console、网络请求与抓包、性能 trace           |

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

`fill` 的值默认是字符串；复选框的布尔值使用 `fill <ref> false --json-value`。`press` 操作已扫描 frame 内的焦点元素，不接受 ref；iframe 使用 `--frame <id>`。JSON 参数接受 `@file` 或 `@-` 从文件或 stdin 读取，避免复杂 shell 转义。

`act` 最多顺序执行 20 个 `click` / `fill` / `press` 动作，可检查 `element`、`text`、`url`、`title`、同步 `javascript` 或 `networkIdle` 后置条件，默认返回新扫描。异步页面动作应提供网站特定的后置条件；工具不会猜测“点击成功”是否等于任务完成。`wait '<条件 JSON>'` 只等待条件并重新扫描，不重放动作。`open <url>` 按底层规则打开或复用 URL，`open --current` 导航已选标签；打开不等于页面已就绪。

JavaScript 条件复用 `chrome_javascript`：一律经 CDP 执行，可能显示 Chrome 调试提示；带 `frameId` 时在该 frame 的 MAIN world 求值，跨站 iframe 内的 frame 需要本任务已在该标签 start 的 `chrome_cdp_session`。执行、语法或序列化错误会立即失败，不再当作“条件暂未满足”反复等待；要等待尚不存在的对象，谓词应显式返回 `false`，而不是解引用空对象。

`chrome_javascript` 没有 `chrome.scripting` 回退（旧的 ISOLATED `new AsyncFunction` 回退在扩展 CSP 下必然失败，已删除），DevTools 或其他扩展占用调试器时返回 `error.kind: "debugger_conflict"`。三种上下文最多选一种：`frameId`（scan 或 `chrome_list_frames` 给出的任意 frame，`world` 可选 `MAIN` 默认或 `ISOLATED`）、`sessionId`（持有会话中的 dedicated/service worker 或跨站 iframe 根）、`workerTargetId`（shared worker）。扩展 frameId 与 CDP frameId 没有共同键，执行前逐级用父 frame 中 `window.frames` 下标定位 iframe 元素并取其 CDP frameId，执行后核对 frame 的 documentId，期间导航返回 `FRAME_CHANGED`；不会改到别的 frame 或顶层执行。ISOLATED 是 AEB 自己的 world，对页面不可见，全局变量保留到 frame 导航。CLI 的 `eval --frame <id>` 只走 MAIN，ISOLATED 用 `call chrome_javascript`。结果带实际执行的 `frameId`、`world`、`cdpFrameId`、`sessionId` 或 `workerTargetId`。

默认扫描最多返回 40 个元素、10 个文本块、20 个 frame 摘要和 10 条 frame 错误，元素/文本限制是整页全局预算，而非每个 iframe 单独计算。`truncated: true` 或非空 `errors` 不代表已经看到完整页面；可指定 `scan --frame <id>` 或调整预算。表单值不自动回显，受保护字段会标记 `protected`。

每条操作命令 stdout 输出一份 JSON。退出码：`0` 成功、`2` 参数错误、`3` 操作或超时失败、`4` 连接、授权或响应错误、`130` 取消。默认整条命令超时 60 秒，可用 `--timeout <毫秒>` 调整，最大 120 秒。

失败必须同时看 `phase`、`actionStatus`、`completed` 和 `failedAction`：

- `expect` / `scan` 阶段失败且 `actionStatus: "completed"`：动作已经执行，不要因为验证失败重做动作。
- `actionStatus: "unknown"`：超时、断开或执行失败时，已发出的动作可能已经发生；先观察页面，再决定是否重试。
- `STALE_REF` / `STALE_DOCUMENT`：重新扫描，不把旧引用替换成看起来相似的 `ref_1`。
- `NOT_INTERACTABLE`：检查 disabled、readonly、inert、遮挡或选择器多匹配，不强行重放。click/fill 在明确的执行前拒绝时返回 `not_started`；批次此前已完成的动作仍计入 `completed`。
- `SESSION_BUSY`：同一任务已有命令执行中，不交错发送整条工作流。不同 session 也不保证并发修改同一个页面安全。

新扫描、动作、目标切换、导航、`eval` 和高级 `call` 都会让旧句柄过期；`--no-scan` 只是不输出新扫描，仍会使旧引用失效。刷新或跨文档导航会额外触发文档身份检查。同 URL 的 SPA 更新可能仍是同一文档，引用的元素若已从 DOM 移除，底层工具仍会明确报错。

高级工具按需使用，不在 Skill 中重复完整目录：

```powershell
aieasybrowser tools screenshot
aieasybrowser describe chrome_screenshot
aieasybrowser --session github call chrome_screenshot '{"savePng":true}'
aieasybrowser --session github eval 'return document.title'
aieasybrowser session --list
aieasybrowser --session github session --forget
```

`call` 仅在 session 已选择目标、且工具接受 `tabId` 时补入该目标；没有已选目标时保留工具原来的默认规则，系统剪贴板读写等操作无需先选择标签。其他工具遵循自己的 URL/活动标签规则，例如抓包工具没有 `tabId`。不带 tab IDs 或 URL 的 `chrome_close_tabs` 必须有已选目标，只关闭该 session 的标签，不默认关闭用户当前活动页。最多保留 64 个任务 session；`session --forget` 只清状态，不关闭标签。桥接器/扩展重启后状态不持久化，需重新选择真实标签并扫描，旧句柄不会自动恢复或重放。

高级 `call` 在浏览器 IO 前按 `describe` 返回的完整输入 schema 校验必填项、类型、枚举、嵌套对象及数组条目。非法参数返回 `INVALID_ARGUMENT`、退出码 `2`，错误中的 `args/commands/0/method` 等路径使用 JSON Pointer（属性名中的 `~` 和 `/` 分别写成 `~0`、`~1`）。此前能传到扩展的非法输入现在会提前拒绝，不使已有 ref 失效；通过校验并执行的 `call` 仍会使旧 ref 失效。

校验不把字符串 `"false"` 改成布尔值、不删多余字段、不填默认值；headers 和 CDP params 等未声明固定字段的 map 保持开放；formData 保留现有对象与紧凑数组两种写法。schema 目前未声明数值范围、整数或数组长度约束，描述里的上限不是新增校验规则；工具原有运行时限制仍有效。`describe` 无需提供工具调用的必填参数。

### 点击与坐标边界

普通 click/ref 和 `chrome_computer` 的 ref/selector 单击使用合成 DOM 事件。`chrome_computer` 的坐标单击使用 CDP trusted input，不再先尝试 DOM、失败后换通道重放。需要 `event.isTrusted` 的控件应使用当前实测坐标或显式 CDP。工具成功只证明事件已派发，必须另查预期效果；无效果不自动升级成双击。

`chrome_computer` 的坐标、拖动起点和区域始终为**当前顶层 viewport CSS 像素**，不受历史截图影响。旧实现会按截图上下文隐式缩放，这一行为已移除；依赖旧缩放的调用方需自行转换图像坐标。未缩放 viewport PNG 的物理像素约为 viewport × DPR；缩略图、裁剪图或整页图还要考虑各自尺寸、原点及当前滚动，不能一律除以 DPR。优先用当前 `getBoundingClientRect()`，布局变化后重新测量。iframe 内坐标需转换到顶层 viewport；跨域限制不等于无法扫描该 frame，也不使 ref 点击变成 trusted input。

Chrome 156 的跨站 iframe 样本中，trusted 坐标点击有时送达子控件、有时只到达 iframe 容器，代码与坐标相同；B4 按窗口状态、焦点、是否刚重载扩展、其他调试客户端对比 7 轮，均不能解释差异，原因未定位（见 `docs/KNOWN-ISSUES.md`）。不保证跨域 trusted 输入可用；必须核对子 frame 状态，不能把输入 API 成功当作交互完成。

### 持续 CDP 会话

`chrome_cdp_command` / `chrome_cdp_batch` 每次调用都会 attach 再 detach，调用之间启用的域、断点和事件都不保留。跨多次调用的调试、事件观察和 iframe/worker 上下文使用 `chrome_cdp_session`：

```powershell
aieasybrowser --session re call chrome_cdp_session '{"action":"start","events":["Runtime.consoleAPICalled","Network"]}'
aieasybrowser --session re call chrome_cdp_command '{"method":"Runtime.enable"}'
aieasybrowser --session re call chrome_cdp_session '{"action":"events","after":0}'
aieasybrowser --session re call chrome_cdp_session '{"action":"stop"}'
```

`start` 默认以 `flatten` 方式自动附着跨站 iframe 和 worker，`status.targets` 给出它们的 `sessionId`，传给 `chrome_cdp_command` / `chrome_cdp_batch` 即可在该上下文执行；未知或已分离的 sessionId 在发给 Chrome 前即拒绝。同站 iframe 不是独立 target。事件存放在扩展内存的环形缓冲（默认 1000 条，最多 10000 条，另有 8 MB 上限），用 `after` 游标分页；`missed` / `dropped` 非零表示有事件因溢出丢失。输出默认脱敏，`sanitizeOutput:false` 返回原值。

会话归启动它的命名任务所有，其他任务访问返回 `CDP_SESSION_OWNED`。会话期间 Chrome 会持续显示调试提示条。用户取消提示条、DevTools 接管或页面崩溃会使会话结束（`active:false` 和 `ended.reason`），已缓冲事件在 `stop` 前仍可读；关闭标签直接丢弃会话。扩展重载或 Native Host 退出后状态丢失，需要重新 `start`。用完必须 `stop`，`session --forget` 不会释放 Chrome 中的调试会话。

`{"action":"workers"}` 列出 `sessions`（自动附着的 dedicated worker、作用域内的 service worker，`sessionId` 传给 `chrome_javascript` 或 CDP 命令）和 `browserTargets`（不属于页面子 target 的 worker，如 shared worker，按标签各 frame 的 origin 筛选，`workerTargetId` 传给 `chrome_javascript`，只在该次调用期间附着）。跨站 iframe 内的 frame 用 `chrome_javascript {frameId}` 时也走本任务持有会话的子 session；没有会话返回 `CDP_SESSION_NOT_STARTED`，他人会话返回 `CDP_SESSION_OWNED`。owner 元素在 shadow root 中的 frame 返回 `FRAME_MAPPING_FAILED`；跨站 iframe 内再嵌套的跨站 iframe 不会自动附着，返回 `FRAME_TARGET_NOT_ATTACHED`。

持有会话期间，`chrome_cdp_scripts` 列出、读取和搜索页面脚本（外链 bundle、内联、eval，以及 iframe/worker 子会话中的脚本）：

```powershell
aieasybrowser --session re call chrome_cdp_scripts '{"action":"list","url":"bundle"}'
aieasybrowser --session re call chrome_cdp_scripts '{"action":"search","query":"signature","maxMatches":20}'
aieasybrowser --session re call chrome_cdp_scripts '{"action":"source","scriptId":"42","offset":180000,"length":4000}'
```

首次调用会在页面和已附着子会话上启用 `Debugger` 并跳过所有暂停，页面里的 `debugger;` 不会停住；`stop` 时关闭 Debugger。脚本表按 `scriptParsed` 维护，主 frame 导航清空该会话的旧脚本，子 target 分离时移除其脚本，最多保留 5000 条（`dropped` 计溢出）。搜索在扩展内用 JS 正则逐脚本匹配，命中给出相对资源的 0 基 `line`/`column`（内联脚本含其在 HTML 中的起始偏移）、脚本内 `offset` 和前后片段；`source` 按 `offset`/`length` 或 `line`/`lineCount` 读取，受 `maxOutputBytes`（UTF-8 字节）限制，用 `endOffset` 续读，不一次返回整个 bundle。isolated（扩展内容脚本）默认不列出，`includeIsolated:true` 才包含。源码与片段默认脱敏，`sanitizeOutput:false` 返回原值。V8 已回收的脚本返回 `SCRIPT_GONE`，wasm 返回 `SCRIPT_NOT_TEXT`。

`chrome_cdp_debugger` 在同一会话里设断点、等待暂停、单步并读取调用栈和变量：

```powershell
aieasybrowser --session re call chrome_cdp_debugger '{"action":"setBreakpoint","url":"https://site/app.js","line":0,"column":18342}'
aieasybrowser --session re call chrome_cdp_debugger '{"action":"wait","timeoutMs":30000}'
aieasybrowser --session re call chrome_cdp_debugger '{"action":"properties","scopeIndex":0,"depth":1}'
aieasybrowser --session re call chrome_cdp_debugger '{"action":"resume"}'
```

断点有四种：`url` / `urlRegex`（页面重载后仍生效）或 `scriptId`（只绑定该脚本实例）加 0 基行列，可带 `condition`，或用 `logMessage` 做 logpoint（只打 console 不暂停，读取需 `Runtime.enable` 并在 start 时订阅 `Runtime.consoleAPICalled`）；`xhrUrl`（URL 子串，`""` 为全部请求）；`eventName`（DOM 事件监听）。子会话 `sessionId` 上设的断点只作用于该 iframe/worker。

B2 默认跳过所有暂停。某个会话有断点、有待生效的 `pause` 或正处于暂停时才"布防"（关闭 skipAllPauses），此时该会话里的 `debugger;` 语句也会停；最后一个断点移除且恢复后撤防；单步跑完没有再停时会话仍布防，未暂停时调用 `resume` 会撤防没有断点的会话并取消待生效的 `pause`。`status` 列出暂停（调用栈、scope、命中断点）、断点及命中次数、布防的会话；`chrome_cdp_session status` 的 `paused` 也会显示。`wait` 返回 `seq` 大于 `after` 的第一个暂停，超时返回 `timedOut:true`。`stepOver` / `stepInto` / `stepOut` / `continueToLocation` 返回下一个暂停，否则 `running:true`。`evaluate` 在暂停帧中求值，`properties` 按 `frameIndex`+`scopeIndex` 或 `objectId` 列出属性，`depth` 展开嵌套对象，总数受 `maxProperties` 限制；objectId 在恢复后失效。变量名含 token/password/cookie 等时默认隐藏值。`blackbox` 设置单步时跳过的脚本 URL 正则。

暂停会冻结页面：执行页面 JavaScript 的工具（`eval`、`chrome_javascript`、`Runtime.evaluate` 等）会一直等到恢复。扩展按标签串行执行工具调用，`chrome_cdp_debugger`、`chrome_cdp_scripts` 以及 `chrome_cdp_session` 的 status/events/stop 不受这个标签锁限制，所以另一个调用卡在暂停页面上时仍能恢复或停止。同一任务内的调用仍按顺序执行：一个任务的同步调用触发断点后，它自己无法发出 `resume`，要从另一个任务恢复，或用页面自身的定时器/用户操作触发。`stop` 先对所有布防会话跳过暂停、恢复已暂停的会话，再关闭 Debugger 并分离。

`chrome_cdp_inject` 在同一会话里注册文档开始前脚本和 hook，作用于之后（重载或导航后）的文档，覆盖顶层、同站 iframe 和自动附着的跨站 iframe：

```bash
aieasybrowser --session re call chrome_cdp_inject '{"action":"add","source":"window.__early = 1;","worldName":"probe"}'
aieasybrowser --session re call chrome_cdp_inject '{"action":"hook","hook":"function","path":"app.sign"}'
aieasybrowser --session re call chrome_cdp_inject '{"action":"hook","hook":"fetch"}'
aieasybrowser --session re call chrome_cdp_session '{"action":"events","after":0}'
aieasybrowser --session re call chrome_cdp_inject '{"action":"list"}'
```

`add` 用 `Page.addScriptToEvaluateOnNewDocument` 注册，可选 `worldName`（命名隔离 world）和 `runImmediately`（同时在当前文档执行，默认否）。`hook` 在页面 MAIN world 安装记录器：`function` 包装指定路径的函数，记录参数、返回值、`this` 摘要和调用栈；`property` 观察 get/set（`document.cookie` 这类访问器在定义处包装）；`fetch` / `xhr` 记录方法、URL、请求头名（不记值）、body 摘要、状态和耗时。路径还不存在时在 DOMContentLoaded 和 load 各重试一次，始终不存在的 frame 记为 `failed`。hook 默认也在当前文档执行。记录作为 `AEB.hook` 事件进入 `chrome_cdp_session events`，不受 start 的事件过滤影响，但同样受环形缓冲、字节上限和脱敏约束；每个文档超过 `maxRecords` 后停止并发一条 `limit`。记录来自页面上下文，页面能看到 binding 并伪造或屏蔽记录，只能当页面数据。`remove` 后新文档不再注入，已在当前文档运行的 hook 保留到导航，之后的记录被丢弃；`stop` 移除全部注册。跨站 iframe 重建时先暂停在启动前，注册完再恢复。worker 和跨站 iframe 内再嵌套的跨站 iframe 不覆盖。原 `chrome_inject_script` / `chrome_userscript` 执行器已删除。

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

运行 `aieasybrowser health`，核对扩展名称为 `AIEasyBrowser`、扩展 ID 为 `coleelkpegcobndoloaofalgnkhiamll`，以及 `nativeHost.serverStatus.isRunning` 为 `true`。`schema.toolCount` 表示扩展支持的完整浏览器能力数，当前为 42。

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
pnpm test:cli-regression
pnpm test:cli-long-task
pnpm test:cli-cdp-session
pnpm test:cli-cdp-scripts
pnpm test:cli-cdp-debugger
pnpm test:cli-cdp-contexts
pnpm test:cli-cdp-inject
pnpm run build
```

`pnpm test:cli-regression` 会先构建 shared/native，再通过多个独立 CLI 进程连接当前运行的桥接器和 Chrome 扩展；它不会替你重启旧桥接器或重载扩展。运行前确认当前桥接器/扩展对应待测版本，且 `aieasybrowser health`、doctor 正常。

脚本启动本机临时网页，创建两个随机 URL 的本机测试标签和一个带随机 query 的 GitHub HTTPS 测试副本；需要能访问 `https://github.com/`。只在新标签中填写测试值、刷新、运行脚本和插入随后移除的 CSP 探针，不改账号、原有标签或剪贴板。结束时关闭测试标签、忘记测试任务并退出临时服务；失败或清理失败都以非零状态报告，不把前置条件缺失写成跳过通过。成功 JSON 中 `commands` 包含清理阶段的 CLI 调用。

单元测试覆盖 CLI 参数、命名任务、动作/验证/扫描、输入能力契约、本机安全边界、取消与目标锁；旧协议入口返回 404。真实浏览器脚本额外检查跨进程引用、同 URL 刷新、动作后置条件、超时/断开后的迟到失败与目标锁，以及真实 HTTPS 的 CSP。Windows 的 SIGINT 样本验证客户端终止和断开续查，不等于已验证 POSIX 的退出码 130 分支。结果和未验证范围维护在 `docs/KNOWN-ISSUES.md`，不把这些样本通过等同于所有网站和全部高级工具都已验收。

### 固定长程比较

`pnpm test:cli-long-task` 同样先构建 shared/native，要求 Chrome 中已重载待测扩展。默认交替顺序运行 3 对逐字段命令与 `act` 批次；可在命令末尾追加 `1..10` 指定对数。两组使用相同页面、输入、40 元素/10 文本预算，执行读取、5 字段填写、异步保存、跨标签读取、刷新、旧 document 拒绝和后置条件失败后的只读观察。

JSON 保留每条命令的字节、耗时、失败阶段及每对比较。`agentEquivalentCalls` 是脚本模拟的 Agent CLI 调用数，不是模型调用数；`coldCliWallMs` 是每次新启 CLI 进程的完整耗时之和，不是仅启动耗时，也不含模型思考。`browserRoundTripMs` 关联诊断日志中的扩展终态耗时，包含 IPC/排队，不是纯浏览器 CPU 时间。比较区间不含建页/清理及额外定位验收；字节、工具数或 wall time 的变化不等于模型 token 或任意网站任务的同等改善。

额外验收 detached/disabled/遮挡/重复目标、实际 PNG 尺寸与 DPR、滚动/布局更新、整页截图后坐标不变，以及跨域 iframe 的 synthetic/trusted 差异和不存在 frame 的错误。fixture 服务只绑定回环，iframe 使用同端口 localhost 与 127.0.0.1 构成跨源；不需要外网。只在本轮随机 URL 标签和唯一 storage key 上产生副作用，结束逐项清除 storage、关闭标签、忘记任务并退出服务；截图只在内存，不下载文件，不改用户账号、剪贴板或原有标签，也不启停原有 trace/抓包。失败和清理失败均非零退出；不支持的浏览器前置条件不记作通过。

脚本 `ok=true` 表示固定工作流、严格防误操作断言及观测/清理完成，不表示全部能力可用。额外跨 frame 输入探针在未送达子控件时输出 `geometry.trustedFramePassed=false`、`frameInputStatus=container_only` 和显式 `limitations`；只有拿到容器事件及子控件计数证据才接受这类已知限制，不把未知失败、重复副作用或缺失证据当通过。跨域探针会短暂激活本轮测试标签，结束关闭；不对用户原有标签发送激活或导航命令。

### 持续 CDP 会话验收

`pnpm test:cli-cdp-session` 要求 Chrome 中已重载包含 `chrome_cdp_session` 的扩展。它在本机临时网页（含跨站 iframe）上用多个独立 CLI 进程验证：会话跨进程保持并缓冲另一进程触发的 console 事件；跨站 iframe 与新建的 dedicated worker 作为子会话可求值；未知 sessionId、其他任务访问和重复 start 被拒绝；`stop` 后该标签不再有调试附着；关闭标签后没有残留 debug target。脚本会打开一个本扩展的 `offscreen.html` 辅助标签读取 `chrome.debugger.getTargets()`，结束时与测试标签一起关闭，并忘记测试任务、退出临时服务。

`pnpm test:cli-cdp-scripts` 同样要求已重载包含 `chrome_cdp_scripts` 的扩展。临时网页含一个约 23 万字符、单行的外链 bundle（带 sourceMappingURL 和中文）、两段内联脚本、一段 eval 和跨站 iframe。脚本验证：未 start 时拒绝且不附着；bundle 分页读取后与服务端文件逐字相同、每页不超过字节上限；同一 runId 在 bundle、内联、eval 中的命中坐标与在源文件中算出的位置一致，游标逐条翻页结果与一次搜索相同；页面的 `debugger;` 不暂停；新建 worker 的脚本可搜到；未知 scriptId、非法参数、其他任务访问被拒绝；导航后旧脚本被清除；`stop` 后无调试附着。结束关闭测试标签与辅助标签、忘记任务并退出临时服务。

`pnpm test:cli-cdp-debugger` 要求已重载包含 `chrome_cdp_debugger` 的扩展。临时网页加载一个按标记注释定位行号的外链脚本和跨站 iframe。脚本验证：一个 CLI 进程的 `wait` 收到另一个任务触发的 url 断点暂停，之后各独立进程读取调用栈（`compute` ← `trigger`）、局部变量（敏感名默认隐藏）、帧内求值和 `stepOver` / `stepOut`；另一个任务的同步 eval 卡在暂停页面时仍能恢复，恢复后该调用返回；无断点时 `debugger;` 不停；条件断点只在条件成立时停；logpoint 打出 console 不暂停；XHR、click 监听断点；跨站 iframe 子会话断点；导航后 url 断点仍命中、scriptId 断点不再命中；暂停中 `stop` 后页面继续执行并分离。结束关闭测试标签与辅助标签、忘记任务并退出临时服务。

`pnpm test:cli-cdp-contexts` 要求已重载包含 `chrome_cdp_session workers` 的扩展。临时网页带 `script-src 'self' 'unsafe-inline'` CSP（页面自身 `eval` 被拒），含同站 iframe、两个同 URL 的同站 iframe、跨站 iframe 及其内部嵌套 iframe，并创建 dedicated worker、shared worker 和 service worker。脚本验证：同站 frame 的 MAIN 求值（`eval --frame` 与 `chrome_javascript`）和 `wait --frame`；两个同 URL frame 各自命中自己的文档；ISOLATED 全局在调用间保留且 MAIN 看不到；未 start 时跨站 frame 返回 `CDP_SESSION_NOT_STARTED` 且不在其他 frame 执行；start 后跨站 frame 与其嵌套 frame 的 MAIN/ISOLATED 求值，其他任务返回 `CDP_SESSION_OWNED`；`workers` 列出三类 worker 且各自可求值，shared worker 调用后不留附着；未知 frame/worker/session 和非法参数被拒；`stop` 后无调试附着、跨站 frame 再次被拒。结束注销 service worker、关闭测试标签与辅助标签、忘记任务并退出临时服务。

`pnpm test:cli-cdp-inject` 要求已重载包含 `chrome_cdp_inject` 的扩展。临时网页含同站 iframe、跨站 iframe 及其嵌套 iframe，签名对象在 DOMContentLoaded 中才创建。脚本验证：未 start 时被拒；注册主世界与命名 world 脚本、函数/属性/fetch/XHR hook 后重载，顶层第一个页面脚本前已执行，命名 world 全局与主世界隔离，各 frame（含重建后的跨站 iframe 新子会话）都执行并产生记录；函数 hook 在 DOMContentLoaded 后安装，调用记录含参数、返回值和调用栈，fetch/XHR 记录头名不含头值；`maxRecords` 生效；remove 后记录被丢弃、重载后不再安装；其他任务、非法路径、未知 id 和未知 hook 类型被拒；`stop` 后无调试附着，下次加载不再注入，跨站 iframe 正常加载。结束关闭测试标签与辅助标签、忘记任务并退出临时服务。

## 许可证

[MIT](LICENSE)
