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
