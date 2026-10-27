# AIEasyBrowser

AIEasyBrowser 是一个只面向 Agent 的 Chrome 浏览器控制桥接器。它不运行模型、不提供聊天侧边栏、不保存会话，也不管理工作流。

Agent 通过 MCP 调用浏览器工具，工具在你已经打开的 Chrome 中执行，因此直接复用当前 Chrome profile、Cookie、扩展和登录态。无需 Playwright 那样启动独立浏览器，也无需每次点击授权。

## 工作方式

```text
MCP 客户端 -> AIEasyBrowser Native Server -> Chrome Native Messaging -> AIEasyBrowser 扩展 -> 当前 Chrome
```

首次安装扩展和 Native Server 后，扩展会自动连接本地桥接器。之后 Agent 可以直接读取页面、操作元素、切换标签页、执行 JavaScript、截图、访问网络请求和使用浏览器数据。

## 安装

环境要求：Node.js 20+、Chrome 或 Chromium、pnpm 8+（源码构建时）。

### 从源码构建

```powershell
Set-Location -LiteralPath 'E:\xiu\AI Project\AIEasyBrowser'
pnpm install --ignore-scripts
pnpm run build
```

构建结果：

- 扩展：`app/chrome-extension/.output/chrome-mv3`
- Native Server：`app/native-server/dist`

在 `chrome://extensions/` 开启开发者模式，加载 `app/chrome-extension/.output/chrome-mv3`。源码已包含固定公钥，扩展 ID 为 `coleelkpegcobndoloaofalgnkhiamll`，不需要生成密钥或手填 ID。

注册 Native Messaging host：

```powershell
pnpm --filter aieasybrowser-bridge exec node dist/cli.js register
```

扩展和 Native Server 都会使用 `com.aieasybrowser.nativehost`。注册默认针对当前用户的 Chrome，不自动提权、不进行系统级安装，也不会在包安装时改动浏览器注册表。注册完成后重新加载一次扩展，让它立即连接新 host。之后不需要打开扩展界面、手动连接或反复授权。

Windows 启动器直接使用构建或注册时写入的 `node_path.txt`，不依赖 Chrome 继承终端的 `PATH`，也不需要 PowerShell。更换或移动 Node.js 后，需要重新执行注册命令更新路径；记录缺失或无效时，启动器会明确报错，不自动搜索其他安装。

## MCP 连接

### Streamable HTTP

Native Server 默认监听 `127.0.0.1:12307`，不占用原项目的 `12306`：

```json
{
  "mcpServers": {
    "aieasybrowser": {
      "type": "streamableHttp",
      "url": "http://127.0.0.1:12307/mcp"
    }
  }
}
```

### STDIO

```json
{
  "mcpServers": {
    "aieasybrowser": {
      "command": "node",
      "args": ["E:/xiu/AI Project/AIEasyBrowser/app/native-server/dist/mcp/mcp-server-stdio.js"]
    }
  }
}
```

## 能力范围

- 页面读取、可交互元素扫描、DOM 查询和元素 HTML
- 点击、填写、选择、键盘输入、滚动、拖拽和综合鼠标操作
- 标签页、窗口、标签组、frame、导航和新标签等待
- 截图、JavaScript、CDP、console、性能 trace
- 网络请求、网络抓取、上传、下载和对话框
- 历史记录、书签、剪贴板和用户脚本

工具目录由 MCP Server 直接发布。AIEasyBrowser 不包含模型、对话 UI、人工标注、录制回放或工作流编辑器。

`networkIdle` 等待从调用开始观察目标标签页的请求；默认不计静态资源，可用 `includeStatic` 包含它们。等待成功、超时或取消后都会移除监听器，不会启动、停止或覆盖正在运行的网络抓包。Chrome 未向扩展报告的请求不在观察范围内。

## 安全边界

桥接器默认只监听本机回环地址。它会操作当前 Chrome 的真实登录态，请只把 MCP 地址提供给可信的本地 Agent。

## 开发验证

```powershell
pnpm run typecheck
pnpm lint
pnpm test
pnpm run build
pnpm smoke:stdio
pnpm --filter aieasybrowser-bridge smoke:stdio -- --profile search
pnpm --filter aieasybrowser-bridge smoke:stdio -- --profile core
```

普通 STDIO smoke 只检查协议握手和工具目录，不代表真实浏览器动作已验证。首次安装后，可执行下面的真实浏览器验证；它会临时新建测试标签页、操作测试表单与剪贴板，并在结束时清理标签页和恢复原剪贴板：

```powershell
pnpm --filter aieasybrowser-bridge smoke:stdio -- --call-health --real-browser
```

浏览器工具提取自 [mcp-chrome-community](https://github.com/y-chell/mcp-chrome-community) 和 [mcp-chrome](https://github.com/hangwin/mcp-chrome)，保留原 MIT 版权声明；原项目不需要卸载或改动。

## 2026-10-27 验证记录

- `typecheck`、`lint` 和完整构建通过；WXT 报告扩展产物总大小为 2.1 MB。
- 122 个测试通过：Native Server 101 个，扩展 21 个。新增样本覆盖 Windows 启动器的字节流透传、特殊字符路径、换行、退出码及失败情况，以及路径记录失败时停止注册。
- STDIO smoke 的 `full`、`core`、`search` 均通过，分别公开 39、15、5 个工具；缩减目录的工具搜索和 schema 查询也通过。
- 已核对生成的 MV3 manifest：公钥与固定扩展 ID 一致，不包含 popup、side panel 或 options 页面。

本轮未执行扩展加载、Native Host 注册或真实 Chrome 动作验证。上述 smoke 没有调用浏览器，不代表 Chrome 连接和页面操作已验证；首次安装后按前面的真实浏览器验证步骤完成闭环。

### 2026-10-27 独立版本、图标与工具目录

项目、扩展、Native Server 和 shared 包统一从 `0.1.0` 开始，不再沿用上游的 `1.0.20`。图标原图保存在 `app/chrome-extension/assets/logo.png`，保留透明背景，生成 16、32、48、96、128 像素的 PNG 供 Chrome 使用。

重新构建后，在 `chrome://extensions/` 找到 AIEasyBrowser，点击“重新加载”即可更新版本和图标，无需卸载重装；固定扩展 ID 不变。只加载扩展不等于已经连接 Native Host，还需要完成前面的注册步骤。

#### 工具数量

本次查询旧服务 `http://127.0.0.1:12306/mcp?profile=full` 实际返回 41 个工具，旧扩展的 `chrome_health` 也报告 41 个；没有复现 45 个的目录。旧项目另有动态 `flow.*` 工具机制，总数可能随发布的工作流变化，但没有当时的工具清单，无法断言之前多出的工具是什么。

新项目保留其中 39 个工具及原有参数，仅删除 `chrome_request_element_selection`（让用户手动选元素）和 `chrome_gif_recorder`（GIF 录制），与移除人工标注和录制功能的目标一致。

#### 三种目录的取舍

这不是三个权限等级，也不是三套浏览器能力，只决定 MCP 客户端最初看到多少工具。旧项目当前源码已经支持这三种目录，并非本次重新设计的三级权限系统。

- `full`：默认，直接公开全部 39 个浏览器工具。Agent 无需先查工具，适合主要使用这个浏览器 MCP 的场景。
- `core`：公开 12 个常用浏览器工具，加搜索、参数查询、代理调用三个目录工具，共 15 个。减少初始工具定义的上下文开销；不常用工具需要先查询再调用。
- `search`：只公开健康检查、标签页列表及三个目录工具，共 5 个。初始目录最小，适合同时连接很多 MCP 的客户端，但普通浏览器操作也通常需要先搜索和查询参数，增加调用轮次。

三种目录都能访问保留的全部 39 个浏览器工具，缩小目录并不是删功能。`search` 不保证更快或更准确；只使用本项目时，默认 `full` 就够了。

本次完整构建、扩展类型检查、lint 和 132 个测试通过（Native Server 101 个、扩展 31 个，包含 10 个新增品牌样本）；三种目录的 STDIO smoke 均通过。已核对生成的 manifest 版本为 `0.1.0`、工具栏与扩展图标指向新 PNG、固定扩展 ID 不变。WXT 报告扩展包大小为 1.09 MB。本次未替用户重新加载扩展，也未验证新扩展的真实 Chrome 连接。

### 2026-10-27 真实 Chrome 动作验证（首次闭环）

已完成安装、注册和真实浏览器动作验证。Native Host 注册走 `node dist/cli.js register`，manifest 与注册表指向 `%APPDATA%\Google\Chrome\NativeMessagingHosts\com.aieasybrowser.nativehost.json`，`allowed_origins` 为固定扩展 ID `coleelkpegcobndoloaofalgnkhiamll`。扩展在 host 注册后由自身指数退避重连自动拉起 Native Server（`dist/index.js`，带 `chrome-extension://...` 与 `--parent-window=0` 参数启动），监听 `127.0.0.1:12307`；无需手动重载扩展。

验证方式为 MCP over HTTP 直连 `http://127.0.0.1:12307/mcp?profile=full`，`initialize` → `tools/list` 返回 39 个工具，与目录一致。以下工具经真实 Chrome 动作确认可用（含返回数据核对）：

| 类别       | 已确认工具                                                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 页面读取   | `chrome_read_page`、`chrome_scan_compact`、`chrome_query_elements`、`chrome_get_element_html`、`chrome_get_web_content`、`chrome_list_frames`                                          |
| 交互       | `chrome_fill_or_select`（文本/下拉/复选）、`chrome_click_element`（ref 与坐标两种路径）、`chrome_computer`（`left_click`/`triple_click`/`type`）、`chrome_keyboard`（单键与组合键）    |
| 脚本与调试 | `chrome_javascript`（CDP 引擎）、`chrome_cdp_command`、`chrome_cdp_batch`、`chrome_console`                                                                                            |
| 媒体       | `chrome_screenshot`、`performance_start_trace`/`performance_stop_trace`                                                                                                                |
| 网络       | `chrome_network_request`、`chrome_network_capture`（`includeStatic` 开关均验证）                                                                                                       |
| 文件       | `chrome_upload_file`（页面 `files[0]` 已确实注入）、`chrome_get_upload_status`                                                                                                         |
| 标签与窗口 | `get_windows_and_tabs`、`chrome_navigate`（含 `refresh`、`newWindow`）、`chrome_wait_for`、`chrome_wait_for_tab`、`chrome_tab_group`（`list`/`create`/`ungroup`）、`chrome_close_tabs` |
| 数据       | `chrome_history`、`chrome_bookmark_search`、`chrome_clipboard`（写入）                                                                                                                 |

验证过程中发现并已确认的行为边界：

`chrome_clipboard` 在 `file://` 页面写剪贴板会触发 Chrome 原生授权弹窗（“查看复制到剪贴板的文字和图片”）。弹窗未响应时 `navigator.clipboard.writeText` 的 await 永不 settle，而扩展侧 `runBrowserToolCallWithIsolation` 用 `enqueue('session:' + sessionId)` 串行化同一 MCP session 的全部调用且无超时保护，因此该 session 后续所有调用都会排在挂起的 Promise 后面；服务端 30s 超时只让客户端拿到错误（`Error calling tool: Request timed out after 30000ms`），不会释放扩展侧队列。授权后队列立即恢复。同时确认队列按 MCP session 隔离：新建 HTTP 会话可绕开已堵塞的 session 继续调用（`chrome_health` 11ms 返回）。`file://` 下的 `chrome_clipboard read_text` 两条路径均报 `Document is not focused`，需真实窗口焦点，未视为缺陷。

`chrome_keyboard` 只接受按键名与组合键（`Enter`、`End`、`Ctrl+C`），传裸字符串 `abc` 返回 `Invalid key string or combination`；纯文本输入用 `chrome_computer` 的 `type`。`chrome_navigate` 传入已存在标签的 `tabId` 时会激活该标签而非导航，需要导航时用 `chrome_cdp_command` 的 `Page.navigate` 或 `refresh`。

`chrome_network_capture` 传入 `tabId` 时返回的是另一个 tabId：`start` 带 `url` 参数会新开标签页并在响应里报告新 tabId，后续 `stop` 必须用返回的那个 id；用原 `tabId` 抓取会得到 `requestCount: 0`。

验证结束时测试标签页与窗口已清理，临时文件已删除，用户原有窗口状态已恢复。
