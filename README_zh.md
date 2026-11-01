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

| 能力           | 典型操作                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 页面读取与定位 | 提取网页内容、扫描交互元素、读取无障碍树、查询 DOM、获取元素 HTML                                                          |
| 页面交互       | 点击、填写、选择、键盘输入、滚动、拖拽、综合鼠标操作                                                                       |
| 状态等待与验证 | 等待元素和文本变化、URL 变化、网络活动、新标签页和下载；断言预期状态                                                       |
| 浏览器管理     | 使用已有标签页和窗口、标签组、页面 frame、历史记录、书签和剪贴板                                                           |
| 文件与对话框   | 上传文件、查询上传状态、处理下载、处理网页对话框                                                                           |
| 调试与观测     | 截图、JavaScript、console、网络请求与抓包、cookie 和各类存储、性能 trace、CPU profile、CSS 覆盖率、堆实例计数              |
| 页面逆向       | 搜索页面脚本、断点查看变量、hook fetch/XHR/函数、读取 WebSocket 帧、拦截和重放请求、还原 sourcemap、离线格式化、解包和解码 |

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

## 快速上手

```powershell
aieasybrowser health
aieasybrowser --session demo tabs --match github
aieasybrowser --session demo use 123
aieasybrowser --session demo scan
aieasybrowser --session demo click <ref> --expect '{"kind":"text","text":"Results"}'
```

把 tab ID 和 ref 换成上一步返回的值。`--session` 是任务名，同一个任务的命令用同一个名字，它会记住选中的标签和最近一次扫描。每条命令输出一份 JSON，看 `ok` 判断成败。截图、抓包、断点等高级工具先用 `tools` 查找，再用 `describe` 看参数，最后用 `call` 调用。

日常使用时，这些命令由 Agent 按 Skill 里的规则发出，包括怎么选目标、引用什么时候失效、失败后能不能重试。人一般只需要说明任务，再看结果。

## 已知限制

- 没有 JS 覆盖率和 heap snapshot：Chrome 不向扩展开放 Profiler 和 HeapProfiler。CSS 覆盖率、CPU profile 和按构造器的实例计数可以用。
- WebSocket 二进制帧原样返回，不做 zlib/brotli 解压。
- 跨站 iframe 里的 trusted 点击不稳定，有时只到达 iframe 容器，原因未定位。
- 调试会话长时间持有后，`stop` 偶尔超时，原因未定位。
- 调试类工具运行期间，Chrome 顶部会显示调试提示条。

各项的验证过程见 `docs/BROWSER-PLAN.md`。

## 本机连接配置

默认配置即可使用。需要调整时，使用以下环境变量：

| 变量                       | 默认值      | 用途                                                                                        |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `AIEASYBROWSER_HOST`       | `127.0.0.1` | 桥接器监听地址、CLI 连接地址，以及扩展构建时的本机探测地址；只允许回环 host，不带协议或端口 |
| `AIEASYBROWSER_PORT`       | `12307`     | CLI 与 doctor 的连接端口，须与扩展当前使用的端口一致，范围 `1..65535`                       |
| `AIEASYBROWSER_AUTH_TOKEN` | 未设置      | 可选本机 bearer token；桥接器与 CLI 使用同一值，不能包含内部空白                            |
| `AIEASYBROWSER_NODE_PATH`  | 未设置      | Unix 启动器的 Node.js 路径覆盖；Windows 仍只使用 `node_path.txt`                            |

监听端口由扩展通过 Native Messaging 提供，在终端里设置这些变量不会改变已经运行的桥接器。修改 host 时，扩展构建环境与 Native Host 运行环境必须一致。

项目已移除 MCP 入口（`/mcp`、`/sse`、`/messages`）和 STDIO 代理，旧的 `CHROME_MCP_*`、`MCP_HTTP_*` 环境变量不再读取，浏览器能力全部保留在 CLI 里。以前在 Agent 客户端里配置过本项目 MCP 的，删除对应服务项即可，例如 Codex：

```powershell
codex mcp remove aieasybrowser
```

## 连接检查与诊断

运行 `aieasybrowser health`，确认扩展名称为 `AIEasyBrowser`、扩展 ID 为 `coleelkpegcobndoloaofalgnkhiamll`、`nativeHost.serverStatus.isRunning` 为 `true`，`schema.toolCount` 为 49。

安装或启动异常时，在源码根目录执行诊断：

```powershell
pnpm --filter aieasybrowser-bridge exec node dist/cli.js doctor
```

重新构建扩展或重新注册 Native Host 后，都要在扩展管理页点一次“重新加载”。诊断提示 `log lock busy` 时，说明另一个进程正在写日志或诊断，稍后重试即可，不要删除仍有进程持有的 `native-server.log.lock`。

## 边界与权限

AIEasyBrowser 操作的是真实 Chrome profile 和已登录会话。桥接器只监听本机回环地址，只应向可信的本地 Agent 提供 CLI 访问，不提供远程监听配置。

自动连接不等于取消 Chrome 的权限限制。调试类工具会显示 Chrome 的调试提示，也可能与 DevTools 或其他扩展争用同一标签页。网站自身的登录、验证码、Cloudflare 和风控规则仍然生效，复用登录环境不代表能绕过这些检查。扩展不能读取 Chrome 内部页面。

## 开发与测试

在源码根目录执行：

```powershell
pnpm run typecheck
pnpm lint
pnpm test
pnpm run build
```

`pnpm test` 是单元测试，不需要浏览器。真实浏览器验收脚本连接当前运行的桥接器和扩展，运行前先构建、在扩展管理页重新加载扩展，并确认 `aieasybrowser health` 的 `schema.hash` 与本次构建一致：

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

`test:cli-regression` 需要能访问 GitHub，其余脚本只用本机临时网页。脚本只操作自己新开的标签和自己写入的数据，结束时全部清理；失败或清理失败都以非零状态退出。

## 许可证

[MIT](LICENSE)
