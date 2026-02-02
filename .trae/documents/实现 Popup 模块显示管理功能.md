## 功能实现计划：Popup 模块显示管理

### 1. 修改清单文件 (Manifest)
- 更新 [manifest.json](file:///d:/code/chrome/yukonChromeExtension/manifest.json)：
  - 将 `action.default_popup` 修改为 `options.html?mode=popup`，以便 JS 识别运行环境。

### 2. 更新设置页 (HTML)
- 更新 [options.html](file:///d:/code/chrome/yukonChromeExtension/options.html)：
  - 在页面底部新增 `module-card`，命名为“功能显示管理”。
  - 添加三个勾选框，分别对应：视频倍速、代理控制、超级复制。
  - 添加 CSS 逻辑：
    - 当 `body` 拥有 `.is-popup` 类时，隐藏“功能显示管理”模块。
    - 当模块被设置为隐藏时，在 Popup 模式下应用 `display: none`。

### 3. 更新交互逻辑 (JS)
- 更新 [options.js](file:///d:/code/chrome/yukonChromeExtension/options.js)：
  - **环境识别**：通过 `URLSearchParams` 检测 `mode=popup`，并给 `body` 加上 `is-popup` 类。
  - **加载配置**：从 `chrome.storage.sync` 读取 `visibleModules`（默认为全选）。
  - **应用显隐**：如果是 Popup 模式，根据配置通过修改样式或类名隐藏对应模块。
  - **保存配置**：监听新模块中勾选框的 `change` 事件，实时保存配置。

### 4. 提交与同步
- 使用符合规范的 commit message 提交更改并推送到远程仓库。
