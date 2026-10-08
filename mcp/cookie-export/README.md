# Chrome Cookie 导出 MCP（Windows）

通过当前 Chrome 中的 yukonChromeExtension 读取指定网站的 Cookie，再由本机后台服务保存文件。扩展通过随机令牌认证的本机 WebSocket 连接服务，MCP 通过认证命名管道调用，支持任意 HTTP/HTTPS 网站、父域共享项、不同路径的同名项和 HttpOnly 属性。不会读取或解密 Chrome 的 Cookie 数据库。

## 一次性安装

需要 Node.js 18+ 和 Chrome 116+，并在想导出的 Chrome 用户配置中加载本仓库的扩展。

在本目录运行：

```powershell
npm install --no-audit --no-fund
.\install.ps1
```

安装脚本自动从 Chrome 扩展设置中定位本仓库的扩展 ID，配置当前用户的后台服务并注册 Windows 登录时自动启动。自定义 Chrome 数据目录或无法定位 ID 时可显式传入：

```powershell
.\install.ps1 -ExtensionId '此扩展的32位ID'
# 或
.\install.ps1 -ChromeUserData 'D:\ChromeProfile'
```

到 `chrome://extensions` 重新加载扩展，新版会自动连接本机服务。“更多设置 → Cookie 导出”中显示连接状态，也可点击“连接 MCP 桥接”立即重试。弹窗只保留当前网站的 Cookie 导出入口。Chrome 需要保持运行。服务在登录 Windows 时自动启动，连接断开后扩展会自动重试。手动启动服务可运行 `start-service.ps1`。

在 Codex 中添加本机 stdio MCP，路径按实际安装位置填写：

```powershell
codex mcp add chrome-cookie-export -- 'C:\nvm4w\nodejs\node.exe' 'D:\code\chrome\yukonChromeExtension\mcp\cookie-export\server.mjs'
```

其他 MCP 客户端可使用以下配置：

```json
{
  "mcpServers": {
    "chrome-cookie-export": {
      "command": "C:/nvm4w/nodejs/node.exe",
      "args": ["D:/code/chrome/yukonChromeExtension/mcp/cookie-export/server.mjs"]
    }
  }
}
```

## 工具

`cookie_bridge_status` 返回已连接的 Chrome 会话元数据。多个 Chrome 配置同时连接时，导出必须通过 `session_id` 明确选择目标。

`export_chrome_cookies` 的参数：

| 参数 | 用途 |
| --- | --- |
| `domain` | 必填，域名或 HTTP/HTTPS 网址，如 `juejin.cn` |
| `output_directory` | 可选，本机绝对目录。省略时使用系统临时目录下的 `yukonChromeExtension/cookies` |
| `session_id` | 可选，多个 Chrome 配置连接时指定目标会话 |

调用示例：

```json
{"domain":"juejin.cn","output_directory":"C:/Users/Yukon/AppData/Local/Temp/article-import"}
```

返回文件名、绝对路径、数量和时间；不会把 Cookie 值放进工具结果：

```json
{
  "domain": "juejin.cn",
  "cookie_count": 12,
  "filename": "juejin.cn-20261008T120000000Z-abcd1234.cookies.json",
  "absolute_path": "C:\\Users\\Yukon\\AppData\\Local\\Temp\\article-import\\juejin.cn-20261008T120000000Z-abcd1234.cookies.json",
  "exported_at": "2026-10-08T12:00:00.000Z"
}
```

MCP 每次创建新文件，不覆盖旧快照。域名会标准化，文件名自动生成，输出目录支持中文。导出 JSON 的 `cookies` 数组保留 Chrome Cookie 字段，不生成可能混入不同域名或路径的 Cookie 请求头。

## 命令行脚本

无需手动复制 Cookie，也可以直接运行：

```powershell
node .\export.mjs --status
node .\export.mjs juejin.cn
node .\export.mjs juejin.cn 'C:\Users\Yukon\AppData\Local\Temp\article-import'
```

## 扩展中的自动导出

设置页输入任意域名，点击“立即导出”。弹出页的“导出当前网站”直接读取正在浏览的网站。普通扩展导出直接由本机桥接写入系统临时目录下的 `yukonChromeExtension/cookies/域名.cookies.json` 并覆盖更新，不调用 Chrome 下载、不弹出保存位置选择框；设置页显示实际绝对路径。

为某个站点开启“自动更新这个网站”后，会立即保存，并在该站点 Cookie 变化、Chrome 启动或扩展更新时刷新快照。未选中的站点不会自动写文件。退出登录后也会更新快照，站点 Cookie 全部清除时保存空数组，避免继续使用旧凭据。页面可以逐个停止自动更新。

文件包含明文登录凭据，只写入本机。连接状态和令牌保存在当前用户的 `%LOCALAPPDATA%\YukonChromeCookieExport`，目录限制为当前用户和 SYSTEM。服务只监听 `127.0.0.1` 的本机端口，校验扩展来源和随机令牌，拒绝普通网页来源。扩展连接配置 `cookie-bridge-config.json` 自动生成，限制为当前用户可读，并已加入 Git 忽略规则。MCP 使用独立随机令牌认证的本机命名管道，只返回导出文件元数据。默认读取普通 Chrome 配置的未分区 Cookie；无痕窗口和依赖设备绑定、二次验证的登录态不保证可迁移到其他浏览器。

## 验证

```powershell
npm test
```

测试只使用合成 Cookie 和隔离临时目录，覆盖域名边界、HttpOnly/路径保留、自动更新与停止、写入失败、网页来源与错误令牌拒绝，以及完整 MCP stdio 到本地服务、模拟浏览器和文件链路。测试不会读取真实浏览器 Cookie。

注册变更后，若 MCP 客户端尚未发现工具，重新载入客户端的 MCP 配置或开启新会话。
