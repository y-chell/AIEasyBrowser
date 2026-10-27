<img src="app/chrome-extension/assets/logo.png" alt="AIEasyBrowser logo" width="96">

# AIEasyBrowser

**让 Agent 直接操作你正在使用的 Chrome。**

[English](README.md)

AIEasyBrowser 是面向 Agent 的浏览器控制工具，通过 MCP 把日常使用的 Chrome 变成 AI 可以读取、操作和验证的浏览器环境。已有标签页、登录态和扩展都留在原来的 Chrome profile 中，不必为自动化重新准备一套浏览器。

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

`chrome_scan_compact` 返回有数量上限的页面概览，包含重要文本、表单控件、按钮和元素引用。`chrome_read_page` 提供可见页面的无障碍树，`chrome_query_elements` 提供精确 DOM 查询。

Agent 可以依据元素引用和选择器执行操作，减少只靠截图猜坐标的步骤；需要视觉定位或真实输入事件时，也有截图、鼠标键盘和 CDP 工具。元素引用对应近期页面状态，导航或目标失效后应重新读取，不长期复用过期引用。

### 操作后能等待、验证，失败时有证据

`chrome_wait_for` 等待元素、文本、URL、网络或下载条件，`chrome_assert` 验证预期状态，避免用固定延时猜测页面是否完成。

截图、console、网络抓包和 `chrome_collect_debug_evidence` 为 Agent 提供排错信息，把“点了但没反应”变成可以继续定位的问题。

### 把调用次数花在任务上

默认直接公开全部 39 个浏览器工具，常规操作不需要先搜索工具。紧凑扫描限制页面输出量，`chrome_cdp_batch` 可以在一次工具调用中顺序执行多个 CDP 命令，减少协议往返。需要节省初始工具定义上下文时，也可以选择较小的工具目录。

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
MCP 客户端 -> AIEasyBrowser Native Server -> Chrome Native Messaging -> AIEasyBrowser 扩展 -> 当前 Chrome profile
```

扩展通过 Native Messaging 启动本机桥接器，MCP 客户端再通过 Streamable HTTP 连接。也可以使用项目提供的 STDIO 代理接入；两种方式控制的是同一个 Chrome，不会额外启动浏览器。

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

## MCP 连接

### Codex

根据 [Codex 官方 MCP 文档](https://developers.openai.com/codex/mcp/)，使用以下命令添加 Streamable HTTP 服务：

```powershell
codex mcp add aieasybrowser --url "http://127.0.0.1:12307/mcp?profile=full"
```

对应的 `~/.codex/config.toml` 配置为：

```toml
[mcp_servers.aieasybrowser]
url = "http://127.0.0.1:12307/mcp?profile=full"
```

添加后在新启动的 Codex 会话中使用 `/mcp` 查看连接状态。

### 其他 Streamable HTTP 客户端

默认地址为 `http://127.0.0.1:12307/mcp?profile=full`。对于支持 HTTP 且采用 `mcpServers` 配置格式的客户端：

```json
{
  "mcpServers": {
    "aieasybrowser": {
      "url": "http://127.0.0.1:12307/mcp?profile=full"
    }
  }
}
```

### STDIO

使用项目提供的 STDIO 入口，将示例中的 `C:/path/to/AIEasyBrowser` 替换为源码目录的绝对路径：

```json
{
  "mcpServers": {
    "aieasybrowser": {
      "command": "node",
      "args": ["C:/path/to/AIEasyBrowser/app/native-server/dist/mcp/mcp-server-stdio.js"]
    }
  }
}
```

STDIO 入口是本机 HTTP 桥接器的代理，不负责加载扩展或启动 Native Host。使用前仍需完成扩展加载与注册，并保持 Chrome 和桥接器运行。

## 工具目录

默认使用 `full`。三种 profile 只决定客户端最初看到哪些工具，不是权限等级，也不减少底层浏览器能力。

| Profile  | 初始公开工具数 | 取舍                                                       |
| -------- | -------------- | ---------------------------------------------------------- |
| `full`   | 39             | 直接公开全部浏览器工具，无需先发现工具                     |
| `core`   | 15             | 12 个常用浏览器工具 + 3 个目录工具，减少初始工具定义上下文 |
| `search` | 5              | 健康检查、标签页列表 + 3 个目录工具，初始目录最小          |

HTTP 通过 URL 选择，例如 `?profile=core`；STDIO 通过环境变量 `CHROME_MCP_TOOL_PROFILE` 选择。

`core` 和 `search` 可用 `chrome_search_tools` 搜索完整目录、`chrome_describe_tool` 查询参数，再通过 `chrome_call_tool` 调用未直接公开的工具。较小目录会增加发现和调用步骤，不代表执行更快或更准确；通常优先使用 `full`。

## 连接检查与诊断

让 Agent 调用 `chrome_health`，核对扩展名称为 `AIEasyBrowser`、扩展 ID 为 `coleelkpegcobndoloaofalgnkhiamll`，以及 `nativeHost.serverStatus.isRunning` 为 `true`。`schema.toolCount` 表示扩展支持的完整浏览器工具数，当前为 39，不等同于较小 profile 的初始公开数量。

安装或启动异常时，在源码根目录执行诊断命令：

```powershell
pnpm --filter aieasybrowser-bridge exec node dist/cli.js doctor
```

重新构建扩展后，在扩展管理页点击“重新加载”以应用更新；重新注册 Native Host 后也需要重新加载扩展，使连接使用新的注册信息。

## 边界与权限

AIEasyBrowser 操作的是真实 Chrome profile 和已登录会话。桥接器默认只监听本机回环地址，只应向可信的本地 Agent 提供 MCP 访问。

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
pnpm smoke:stdio
pnpm --filter aieasybrowser-bridge smoke:stdio -- --profile search
pnpm --filter aieasybrowser-bridge smoke:stdio -- --profile core
```

普通 STDIO smoke 检查协议握手和工具目录，不执行真实浏览器动作。安装完成后，可运行端到端浏览器 smoke：

```powershell
pnpm --filter aieasybrowser-bridge smoke:stdio -- --call-health --real-browser
```

该测试会新建临时标签页、操作测试表单与剪贴板，并在结束时清理标签页、恢复原剪贴板。

## 许可证

[MIT](LICENSE)。浏览器工具实现基于 [mcp-chrome-community](https://github.com/y-chell/mcp-chrome-community) 和 [mcp-chrome](https://github.com/hangwin/mcp-chrome)，保留其版权声明。
