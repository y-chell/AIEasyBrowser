# AIEasyBrowser

**只给 Agent 用的 Chrome 浏览器控制桥。** 没有模型，没有聊天侧边栏，没有会话存储，没有工作流编辑器。

Agent 通过 MCP 调用浏览器工具，工具在你的 Chrome 里执行，直接复用当前 profile、Cookie、扩展和登录态。不需要像 Playwright 那样启动独立浏览器，也不需要每次点击授权。

---

## 工作方式

```
MCP 客户端  →  AIEasyBrowser Native Server  →  Chrome Native Messaging  →  扩展  →  当前 Chrome
```

扩展安装并注册 Native Host 后，它会自己连上本地桥接器。之后 Agent 可以直接读页面、点击元素、切换标签、执行 JavaScript、截图、查网络请求、使用浏览器数据。

Native Server 只监听 `127.0.0.1`，默认端口 `12307`。它操作的是你真实登录态，因此 MCP 地址只应提供给可信的本地 Agent。

---

## 能力范围

| 分类       | 工具                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 页面读取   | `chrome_read_page`、`chrome_scan_compact`、`chrome_query_elements`、`chrome_get_element_html`、`chrome_get_web_content`、`chrome_list_frames`                      |
| 交互       | `chrome_click_element`、`chrome_fill_or_select`、`chrome_keyboard`、`chrome_computer`、`chrome_handle_dialog`                                                      |
| 标签与窗口 | `get_windows_and_tabs`、`chrome_navigate`、`chrome_switch_tab`、`chrome_close_tabs`、`chrome_tab_group`、`chrome_wait_for`、`chrome_wait_for_tab`、`chrome_assert` |
| 脚本与调试 | `chrome_javascript`、`chrome_cdp_command`、`chrome_cdp_batch`、`chrome_console`、`chrome_collect_debug_evidence`                                                   |
| 媒体       | `chrome_screenshot`、`performance_start_trace`、`performance_stop_trace`、`performance_analyze_insight`                                                            |
| 网络       | `chrome_network_request`、`chrome_network_capture`                                                                                                                 |
| 文件       | `chrome_upload_file`、`chrome_get_upload_status`、`chrome_handle_download`                                                                                         |
| 数据       | `chrome_history`、`chrome_bookmark_search`、`chrome_bookmark_add`、`chrome_bookmark_delete`、`chrome_clipboard`                                                    |
| 元信息     | `chrome_health`                                                                                                                                                    |

工具目录由 MCP Server 直接发布，共 39 个。项目管理、对话、人工标注、录制回放、工作流都不在范围内。

---

## 安装

环境要求：Node.js 20+、Chrome 或 Chromium、pnpm 8+（源码构建时）。

```powershell
Set-Location -LiteralPath 'E:\xiu\AI Project\AIEasyBrowser'
pnpm install --ignore-scripts
pnpm run build
```

构建产物：

- 扩展：`app/chrome-extension/.output/chrome-mv3`
- Native Server：`app/native-server/dist`

在 `chrome://extensions/` 开启开发者模式，加载 `app/chrome-extension/.output/chrome-mv3`。源码内含固定公钥，扩展 ID 恒为 `coleelkpegcobndoloaofalgnkhiamll`，不需要生成密钥或手填 ID。

注册 Native Messaging host：

```powershell
pnpm --filter aieasybrowser-bridge exec node dist/cli.js register
```

扩展与 Native Server 统一使用 `com.aieasybrowser.nativehost`。注册只针对当前用户的 Chrome，不提权、不做系统级安装、不在安装依赖时改动浏览器注册表。注册后扩展会自动重连，不需要手动刷新扩展界面。

Windows 启动器读取构建或注册时写入的 `node_path.txt`，不依赖 Chrome 继承终端 `PATH`，也不需要 PowerShell。更换或移动 Node.js 后重新执行注册命令即可；记录缺失或无效时启动器会明确报错，不会自动搜索其它安装。

---

## MCP 连接

### Streamable HTTP

```json
{
  "mcpServers": {
    "aieasybrowser": {
      "type": "streamableHttp",
      "url": "http://127.0.0.1:12307/mcp?profile=full"
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

STDIO 模式内部仍会连 `12307` 的 HTTP Server，只是多一层代理，适合只支持 stdio 的客户端。

---

## 工具目录三档

这不是权限分级，也不是三套能力，只决定客户端**初始看到**多少工具定义。

| 档位           | 公开工具数                             | 适用                                       |
| -------------- | -------------------------------------- | ------------------------------------------ |
| `full`（默认） | 39                                     | 主要使用本 MCP，Agent 无需先查工具         |
| `core`         | 15（12 个常用 + 3 个目录工具）         | 降低初始上下文开销，不常用工具先查询再调用 |
| `search`       | 5（健康检查、标签列表 + 3 个目录工具） | 同时连接很多 MCP，初始目录最小             |

三档都能访问全部 39 个工具，缩小目录不删功能。URL 上加 `?profile=core` 或 `?profile=search` 切换，也可以用环境变量 `CHROME_MCP_TOOL_PROFILE`。

---

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

普通 STDIO smoke 只验证协议握手和工具目录，不调用浏览器。真实浏览器验证会临时新建测试标签页、操作测试表单与剪贴板，结束时清理标签页并恢复原剪贴板：

```powershell
pnpm --filter aieasybrowser-bridge smoke:stdio -- --call-health --real-browser
```

---

## 已知行为边界

这些是 Chrome 平台本身的约束，不是本项目缺陷：

- `chrome_keyboard` 只接受键名与组合键（`Enter`、`Tab`、`End`、`Ctrl+C`）。输入纯文本请用 `chrome_computer` 的 `type`，传 `abc` 会返回 `Invalid key string or combination`。
- `chrome_navigate` 传入一个已存在标签的 `tabId` 时激活该标签而非导航。要导航到新地址，用 `chrome_cdp_command` 的 `Page.navigate`，或传 `refresh: true`。
- `chrome_network_capture` 带 `url` 参数会新开标签页，响应里的 `tabId` 是新标签的 id。后续 `stop` 必须用返回的那个 id。
- 剪贴板读写受 Chrome 焦点策略约束，详见 `docs/KNOWN-ISSUES.md`。

---

## 来源与许可

浏览器工具提取自 [mcp-chrome-community](https://github.com/y-chell/mcp-chrome-community) 和 [mcp-chrome](https://github.com/hangwin/mcp-chrome)，保留原 MIT 版权声明。原项目不需要卸载或改动。

MIT License，见 `LICENSE`。
