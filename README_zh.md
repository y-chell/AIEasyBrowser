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

JavaScript 条件复用 `chrome_javascript` 的执行引擎：顶层页面默认使用 CDP，不再在网页 MAIN world 中动态 eval 条件字符串，可能显示 Chrome 调试提示；显式非零 `frameId` 使用该工具的 ISOLATED frame 执行，访问的是该 world 的环境。需要 iframe 的页面主世界或跨域 CDP context 时，使用已有 CDP 工具。执行、语法或序列化错误会立即失败，不再当作“条件暂未满足”反复等待；要等待尚不存在的对象，谓词应显式返回 `false`，而不是解引用空对象。

默认扫描最多返回 40 个元素、10 个文本块、20 个 frame 摘要和 10 条 frame 错误，元素/文本限制是整页全局预算，而非每个 iframe 单独计算。`truncated: true` 或非空 `errors` 不代表已经看到完整页面；可指定 `scan --frame <id>` 或调整预算。表单值不自动回显，受保护字段会标记 `protected`。

每条操作命令 stdout 输出一份 JSON。退出码：`0` 成功、`2` 参数错误、`3` 操作或超时失败、`4` 连接、授权或响应错误、`130` 取消。默认整条命令超时 60 秒，可用 `--timeout <毫秒>` 调整，最大 120 秒。

失败必须同时看 `phase`、`actionStatus`、`completed` 和 `failedAction`：

- `expect` / `scan` 阶段失败且 `actionStatus: "completed"`：动作已经执行，不要因为验证失败重做动作。
- `actionStatus: "unknown"`：超时、断开或执行失败时，已发出的动作可能已经发生；先观察页面，再决定是否重试。
- `STALE_REF` / `STALE_DOCUMENT`：重新扫描，不把旧引用替换成看起来相似的 `ref_1`。
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

`call` 仅在 session 已选择目标、且工具接受 `tabId` 时补入该目标；没有已选目标时保留工具原来的默认规则，系统剪贴板读写等操作无需先选择标签。其他工具遵循自己的 URL/活动标签规则，例如抓包工具没有 `tabId`。不带 tab IDs 或 URL 的 `chrome_close_tabs` 必须有已选目标，只关闭该 session 的标签，不默认关闭用户当前活动页。高级调用继续拒绝未声明的顶层参数，但不是完整 JSON Schema 校验器。最多保留 64 个任务 session；`session --forget` 只清状态，不关闭标签。桥接器/扩展重启后状态不持久化，需重新选择真实标签并扫描，旧句柄不会自动恢复或重放。

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

运行 `aieasybrowser health`，核对扩展名称为 `AIEasyBrowser`、扩展 ID 为 `coleelkpegcobndoloaofalgnkhiamll`，以及 `nativeHost.serverStatus.isRunning` 为 `true`。`schema.toolCount` 表示扩展支持的完整浏览器能力数，当前为 39。

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
pnpm run build
```

`pnpm test:cli-regression` 会先构建 shared/native，再通过多个独立 CLI 进程连接当前运行的桥接器和 Chrome 扩展；它不会替你重启旧桥接器或重载扩展。运行前确认当前桥接器/扩展对应待测版本，且 `aieasybrowser health`、doctor 正常。

脚本启动本机临时网页，创建两个随机 URL 的本机测试标签和一个带随机 query 的 GitHub HTTPS 测试副本；需要能访问 `https://github.com/`。只在新标签中填写测试值、刷新、运行脚本和插入随后移除的 CSP 探针，不改账号、原有标签或剪贴板。结束时关闭测试标签、忘记测试任务并退出临时服务；失败或清理失败都以非零状态报告，不把前置条件缺失写成跳过通过。成功 JSON 中 `commands` 包含清理阶段的 CLI 调用。

单元测试覆盖 CLI 参数、命名任务、动作/验证/扫描、输入能力契约、本机安全边界、取消与目标锁；旧协议入口返回 404。真实浏览器脚本额外检查跨进程引用、同 URL 刷新、动作后置条件、超时/断开后的迟到失败与目标锁，以及真实 HTTPS 的 CSP。Windows 的 SIGINT 样本验证客户端终止和断开续查，不等于已验证 POSIX 的退出码 130 分支。结果和未验证范围维护在 `docs/KNOWN-ISSUES.md`，不把这些样本通过等同于所有网站和全部高级工具都已验收。

## 许可证

[MIT](LICENSE)
