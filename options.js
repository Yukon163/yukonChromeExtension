let currentWhitelist = [];

// 检测运行模式
const isPopup = new URLSearchParams(window.location.search).get('mode') === 'popup';
if (isPopup) document.body.classList.add('is-popup');

// 显示状态 (带 3D 翻转动画)
function showStatus(msg) {
    const card = document.getElementById('footer-card');
    const statusText = document.getElementById('status-text');
    if (!card || !statusText) return;

    statusText.textContent = msg;
    card.classList.add('showing-status');

    setTimeout(() => {
        card.classList.remove('showing-status');
        // 等待翻转动画完成后清空文字
        setTimeout(() => {
            if (!card.classList.contains('showing-status')) {
                statusText.textContent = '';
            }
        }, 600);
    }, 2000);
}

const popupCardActions = {};
const DEFAULT_FEISHU_FORMULA_SHORTCUTS = Object.freeze({
    openFormula: 'Ctrl+4',
    centerAndOpenFormula: 'Ctrl+5'
});
const SHORTCUT_HELP_TEXT = '点击输入框后直接按下组合键即可保存；按 Esc 取消。建议至少包含 Ctrl、Alt 或 Command。Chrome 保留的组合键还需在 chrome://extensions/shortcuts 中修改扩展快捷键。';

function registerPopupCardAction(moduleId, action) {
    popupCardActions[moduleId] = action;
}

function initPopupCardActions() {
    if (!isPopup) return;

    Object.entries(popupCardActions).forEach(([moduleId, action]) => {
        const card = document.getElementById(moduleId);
        if (!card) return;

        card.classList.add('has-popup-action');
        card.addEventListener('click', (e) => {
            if (e.target.closest('a, button, input, textarea, select')) return;
            action();
        });
    });
}

function getShortcutEventKey(e) {
    if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
    if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);

    const codeKeys = {
        Space: 'Space',
        Slash: '/',
        Backslash: '\\',
        BracketLeft: '[',
        BracketRight: ']',
        Semicolon: ';',
        Quote: "'",
        Comma: ',',
        Period: '.',
        Minus: '-',
        Equal: '=',
        ArrowUp: 'ArrowUp',
        ArrowDown: 'ArrowDown',
        ArrowLeft: 'ArrowLeft',
        ArrowRight: 'ArrowRight'
    };

    return codeKeys[e.code] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
}

function shortcutFromKeyboardEvent(e) {
    const key = getShortcutEventKey(e);
    if (!key || ['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return '';

    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');
    parts.push(key);
    return parts.join('+');
}

function normalizeFeishuFormulaShortcuts(value) {
    if (!value || typeof value !== 'object') {
        return { ...DEFAULT_FEISHU_FORMULA_SHORTCUTS };
    }

    return {
        openFormula: typeof value.openFormula === 'string' && value.openFormula
            ? value.openFormula
            : DEFAULT_FEISHU_FORMULA_SHORTCUTS.openFormula,
        centerAndOpenFormula: typeof value.centerAndOpenFormula === 'string' && value.centerAndOpenFormula
            ? value.centerAndOpenFormula
            : DEFAULT_FEISHU_FORMULA_SHORTCUTS.centerAndOpenFormula
    };
}

// --- 手风琴逻辑 ---
function initAccordion() {
    if (isPopup) {
        const speedHeader = document.querySelector('#module-speed .module-header');
        if (!speedHeader) return;

        speedHeader.addEventListener('click', () => {
            speedHeader.parentElement.classList.toggle('active');
        });
        return;
    }

    document.querySelectorAll('.module-header').forEach(header => {
        header.addEventListener('click', () => {
            const card = header.parentElement;
            const isActive = card.classList.contains('active');
            
            // 关闭其他
            document.querySelectorAll('.module-card').forEach(c => c.classList.remove('active'));
            
            // 切换当前
            if (!isActive) {
                card.classList.add('active');
            }
        });
    });
}

// --- 视频倍速模块逻辑 ---
function renderWhitelist() {
    const list = document.getElementById('whitelist-list');
    list.innerHTML = '';
    currentWhitelist.forEach((domain, index) => {
        const item = document.createElement('div');
        item.className = 'list-item';
        item.innerHTML = `
            <span>${domain}</span>
            <button class="btn-del" data-index="${index}">删除</button>
        `;
        item.querySelector('.btn-del').addEventListener('click', () => {
            currentWhitelist.splice(index, 1);
            chrome.storage.sync.set({ whitelist: currentWhitelist }, renderWhitelist);
        });
        list.appendChild(item);
    });
}

function initSpeedModule() {
    chrome.storage.sync.get({ whitelist: ['cycani.org', 'mgnacg.com'] }, (items) => {
        currentWhitelist = items.whitelist;
        renderWhitelist();
    });

    document.getElementById('add-btn').addEventListener('click', () => {
        const input = document.getElementById('new-domain');
        const domain = input.value.trim().toLowerCase();
        if (domain && !currentWhitelist.includes(domain)) {
            currentWhitelist.push(domain);
            chrome.storage.sync.set({ whitelist: currentWhitelist }, () => {
                renderWhitelist();
                input.value = '';
                showStatus('已添加域名');
            });
        }
    });
}

// --- 代理控制模块逻辑 ---
function initProxyModule() {
    const systemToggle = document.getElementById('proxy-system-toggle');
    const directToggle = document.getElementById('proxy-direct-toggle');
    const badge = document.getElementById('proxy-status-badge');
    
    function updateBadge(mode) {
        if (mode === 'system') {
            badge.textContent = '系统';
            badge.classList.add('active');
        } else {
            badge.textContent = '直连';
            badge.classList.remove('active');
        }
    }

    // 加载当前模式
    chrome.storage.sync.get({ proxyMode: 'system' }, (items) => {
        if (items.proxyMode === 'system') {
            systemToggle.checked = true;
            directToggle.checked = false;
        } else {
            systemToggle.checked = false;
            directToggle.checked = true;
        }
        updateBadge(items.proxyMode);
    });

    function setProxyMode(newMode) {
        chrome.storage.sync.set({ proxyMode: newMode }, () => {
            systemToggle.checked = (newMode === 'system');
            directToggle.checked = (newMode === 'direct');
            updateBadge(newMode);
            showStatus(`已切换为: ${newMode === 'system' ? '系统代理' : '直连'}`);
        });
    }

    function toggleProxyMode() {
        const newMode = badge.textContent === '系统' ? 'direct' : 'system';
        setProxyMode(newMode);
    }

    // 快捷切换状态
    badge.addEventListener('click', (e) => {
        e.stopPropagation(); // 阻止手风琴折叠
        toggleProxyMode();
    });

    // 监听系统代理切换
    systemToggle.addEventListener('change', () => {
        if (systemToggle.checked) {
            directToggle.checked = false;
            setProxyMode('system');
        } else {
            // 如果关掉系统代理，强制打开直连
            directToggle.checked = true;
            setProxyMode('direct');
        }
    });

    // 监听直连切换
    directToggle.addEventListener('change', () => {
        if (directToggle.checked) {
            systemToggle.checked = false;
            setProxyMode('direct');
        } else {
            // 如果关掉直连，强制打开系统代理
            systemToggle.checked = true;
            setProxyMode('system');
        }
    });

    registerPopupCardAction('module-proxy', toggleProxyMode);
}

// --- 超级复制模块逻辑 ---
function initCopyModule() {
    const toggle = document.getElementById('super-copy-toggle');
    const badge = document.getElementById('copy-status-badge');

    function updateBadge(enabled) {
        if (enabled) {
            badge.textContent = '开启';
            badge.classList.add('active');
        } else {
            badge.textContent = '关闭';
            badge.classList.remove('active');
        }
    }
    
    chrome.storage.sync.get({ superCopy: false }, (items) => {
        toggle.checked = items.superCopy;
        updateBadge(items.superCopy);
    });

    function setSuperCopy(enabled) {
        chrome.storage.sync.set({ superCopy: enabled }, () => {
            toggle.checked = enabled;
            updateBadge(enabled);
            showStatus(enabled ? '超级复制已开启；飞书页面刷新后生效' : '超级复制已关闭；飞书页面刷新后完全关闭');
        });
    }

    function toggleSuperCopy() {
        setSuperCopy(!toggle.checked);
    }

    // 快捷切换状态
    badge.addEventListener('click', (e) => {
        e.stopPropagation(); // 阻止手风琴折叠
        toggleSuperCopy();
    });

    toggle.addEventListener('change', () => {
        setSuperCopy(toggle.checked);
    });

    registerPopupCardAction('module-copy', toggleSuperCopy);
}

// --- 强制暗色模式模块逻辑 ---
function initDarkModeModule() {
    const toggle = document.getElementById('dark-mode-toggle');
    const badge = document.getElementById('dark-status-badge');

    function updateBadge(enabled) {
        if (enabled) {
            badge.textContent = '已开启';
            badge.classList.add('active');
        } else {
            badge.textContent = '已关闭';
            badge.classList.remove('active');
        }
    }

    chrome.storage.sync.get({ darkMode: false }, (items) => {
        toggle.checked = items.darkMode;
        updateBadge(items.darkMode);
    });

    function setDarkMode(enabled) {
        chrome.storage.sync.set({ darkMode: enabled }, () => {
            toggle.checked = enabled;
            updateBadge(enabled);
            showStatus(enabled ? '暗色模式已开启' : '暗色模式已关闭');
        });
    }

    function toggleDarkMode() {
        setDarkMode(!toggle.checked);
    }

    badge.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDarkMode();
    });

    toggle.addEventListener('change', () => {
        setDarkMode(toggle.checked);
    });

    registerPopupCardAction('module-dark', toggleDarkMode);
}

// --- CSDN 优化模块逻辑 ---
function initCsdnModule() {
    const toggle = document.getElementById('csdn-optimize-toggle');
    const badge = document.getElementById('csdn-status-badge');

    function updateBadge(enabled) {
        if (enabled) {
            badge.textContent = '已开启';
            badge.classList.add('active');
        } else {
            badge.textContent = '已关闭';
            badge.classList.remove('active');
        }
    }
    
    chrome.storage.sync.get({ csdnOptimize: true }, (items) => {
        toggle.checked = items.csdnOptimize;
        updateBadge(items.csdnOptimize);
    });

    function setCsdnOptimize(enabled) {
        chrome.storage.sync.set({ csdnOptimize: enabled }, () => {
            toggle.checked = enabled;
            updateBadge(enabled);
            showStatus(enabled ? 'CSDN 优化已开启 (刷新生效)' : 'CSDN 优化已关闭 (刷新生效)');
        });
    }

    function toggleCsdnOptimize() {
        setCsdnOptimize(!toggle.checked);
    }

    // 快捷切换状态
    badge.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCsdnOptimize();
    });

    toggle.addEventListener('change', () => {
        setCsdnOptimize(toggle.checked);
    });

    registerPopupCardAction('module-csdn', toggleCsdnOptimize);
}

// --- 飞书公式快捷键模块逻辑 ---
function initShortcutModule() {
    const inputs = Array.from(document.querySelectorAll('.shortcut-input[data-action]'));
    const resetButtons = Array.from(document.querySelectorAll('.shortcut-reset[data-action]'));
    const message = document.getElementById('shortcut-message');
    if (!inputs.length || !message) return;

    let shortcuts = { ...DEFAULT_FEISHU_FORMULA_SHORTCUTS };
    let messageTimer = null;

    function render() {
        inputs.forEach((input) => {
            input.value = shortcuts[input.dataset.action] || '';
        });
    }

    function showShortcutMessage(text, isError = false) {
        clearTimeout(messageTimer);
        message.textContent = text;
        message.style.color = isError ? '#ff7875' : 'var(--accent-color)';

        messageTimer = setTimeout(() => {
            message.textContent = SHORTCUT_HELP_TEXT;
            message.style.color = '';
        }, 3000);
    }

    function saveShortcut(action, shortcut, input) {
        const duplicateAction = Object.keys(shortcuts).find((key) => key !== action && shortcuts[key] === shortcut);
        if (duplicateAction) {
            showShortcutMessage('这个组合键已经分配给另一个公式操作', true);
            input.value = shortcuts[action];
            return;
        }

        shortcuts = { ...shortcuts, [action]: shortcut };
        chrome.storage.sync.set({ feishuFormulaShortcuts: shortcuts }, () => {
            render();
            input.blur();
            showShortcutMessage(`已保存快捷键：${shortcut}`);
        });
    }

    chrome.storage.sync.get({
        feishuFormulaShortcuts: DEFAULT_FEISHU_FORMULA_SHORTCUTS
    }, (items) => {
        shortcuts = normalizeFeishuFormulaShortcuts(items.feishuFormulaShortcuts);
        render();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes.feishuFormulaShortcuts) {
            shortcuts = normalizeFeishuFormulaShortcuts(changes.feishuFormulaShortcuts.newValue);
            render();
        }
    });

    inputs.forEach((input) => {
        input.addEventListener('focus', () => {
            input.classList.add('is-recording');
            input.value = '请按组合键…';
        });

        input.addEventListener('blur', () => {
            input.classList.remove('is-recording');
            input.value = shortcuts[input.dataset.action];
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') return;

            e.preventDefault();
            e.stopPropagation();

            if (e.key === 'Escape') {
                input.blur();
                return;
            }

            const shortcut = shortcutFromKeyboardEvent(e);
            if (!shortcut) return;

            if (!e.ctrlKey && !e.altKey && !e.metaKey) {
                showShortcutMessage('快捷键至少需要 Ctrl、Alt 或 Command 中的一个修饰键', true);
                return;
            }

            saveShortcut(input.dataset.action, shortcut, input);
        });
    });

    resetButtons.forEach((button) => {
        button.addEventListener('click', () => {
            const action = button.dataset.action;
            const shortcut = DEFAULT_FEISHU_FORMULA_SHORTCUTS[action];
            const duplicateAction = Object.keys(shortcuts).find((key) => key !== action && shortcuts[key] === shortcut);
            if (duplicateAction) {
                showShortcutMessage('默认组合键已分配给另一个公式操作，请先修改那个操作', true);
                return;
            }

            shortcuts = { ...shortcuts, [action]: shortcut };
            chrome.storage.sync.set({ feishuFormulaShortcuts: shortcuts }, () => {
                render();
                showShortcutMessage(`已恢复默认快捷键：${shortcut}`);
            });
        });
    });
}

// --- 通用 Cookie 本地导出 ---
function initCookieExportModule() {
    const input = document.getElementById('cookie-export-domain');
    const toggle = document.getElementById('cookie-export-auto');
    const status = document.getElementById('cookie-export-status');
    const autoList = document.getElementById('cookie-export-auto-list');
    const nowButton = document.getElementById('cookie-export-now');
    const quickButton = document.getElementById('cookie-export-quick');
    let state;

    function request(message) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(message, response => {
                if (chrome.runtime.lastError || !response?.ok) {
                    reject(new Error(response?.error || '请在扩展管理页重新加载扩展后再试'));
                } else resolve(response);
            });
        });
    }

    function domainFromInput() {
        const value = input.value.trim();
        if (!value) throw new Error('请输入网站域名或网址');
        const url = new URL(value.includes('://') ? value : `https://${value}`);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
            throw new Error('请输入 HTTP/HTTPS 网站的域名或网址');
        }
        return url.hostname.toLowerCase().replace(/\.$/, '');
    }

    function reportError(error) {
        status.textContent = error.message;
        showStatus(error.message);
    }

    function render() {
        if (!state) return;
        let domain;
        try { domain = domainFromInput(); } catch { toggle.checked = false; return; }
        toggle.checked = state.cookieExportAutoSites.includes(domain);
        const file = state.cookieExportFiles[domain];
        const phase = state.cookieExportStatuses[domain];
        if (phase?.phase === 'saving') status.textContent = '正在保存本地文件…';
        else if (phase?.phase === 'error') status.textContent = phase.message;
        else if (file) {
            const time = new Date(file.exportedAt).toLocaleString();
            status.textContent = file.count
                ? `已保存 ${file.count} 个 Cookie · ${time} · ${file.filename}`
                : `已保存空快照 · ${time} · ${file.filename}。当前 Chrome 配置没有这个网站的 Cookie。`;
        } else status.textContent = '尚未导出这个网站。';
        document.getElementById('cookie-export-show-file').disabled = !file;
        autoList.replaceChildren();
        for (const site of state.cookieExportAutoSites) {
            const row = document.createElement('div');
            row.className = 'list-item';
            const name = document.createElement('span');
            name.textContent = site;
            const stop = document.createElement('button');
            stop.type = 'button';
            stop.className = 'btn-del';
            stop.textContent = '停止自动更新';
            stop.addEventListener('click', () => {
                request({ type: 'COOKIE_EXPORT_SET_AUTO', domain: site, enabled: false })
                    .then(result => { state = result.state; render(); }).catch(reportError);
            });
            row.append(name, stop);
            autoList.appendChild(row);
        }
        autoList.hidden = state.cookieExportAutoSites.length === 0;
    }

    async function exportNow() {
        nowButton.disabled = quickButton.disabled = true;
        try {
            const result = await request({ type: 'COOKIE_EXPORT_NOW', domain: domainFromInput() });
            state = result.state;
            render();
            showStatus(result.file.count ? `已导出 ${result.file.count} 个 Cookie` : '已保存空快照，当前站点没有 Cookie');
        } catch (error) { reportError(error); }
        finally { nowButton.disabled = quickButton.disabled = false; }
    }

    async function exportCurrentSite() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.url || !/^https?:\/\//i.test(tab.url)) {
                throw new Error('请在网站页面点击扩展导出；也可以在下方输入域名');
            }
            input.value = new URL(tab.url).hostname;
            await exportNow();
        } catch (error) { reportError(error); }
    }

    nowButton.addEventListener('click', exportNow);
    input.addEventListener('input', render);
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') exportNow();
    });
    quickButton.addEventListener('click', event => { event.stopPropagation(); exportCurrentSite(); });
    toggle.addEventListener('change', async () => {
        try {
            const result = await request({ type: 'COOKIE_EXPORT_SET_AUTO', domain: domainFromInput(), enabled: toggle.checked });
            state = result.state;
            render();
        } catch (error) { render(); reportError(error); }
    });
    document.getElementById('cookie-export-show-file').addEventListener('click', () => {
        try { request({ type: 'COOKIE_EXPORT_SHOW_FILE', domain: domainFromInput() }).catch(reportError); }
        catch (error) { reportError(error); }
    });
    document.getElementById('cookie-export-open-folder').addEventListener('click', () => {
        request({ type: 'COOKIE_EXPORT_OPEN_FOLDER' }).catch(reportError);
    });
    if (!isPopup) {
        const restartButton = document.getElementById('cookie-mcp-restart');
        restartButton.addEventListener('click', async event => {
            event.stopPropagation();
            restartButton.disabled = true;
            restartButton.textContent = '正在重启…';
            const bridgeStatus = document.getElementById('cookie-mcp-status');
            bridgeStatus.textContent = '正在重启本机服务并恢复连接…';
            try {
                await request({ type: 'COOKIE_MCP_RESTART' });
                bridgeStatus.textContent = '本机服务已重启，连接已恢复。';
            } catch (error) { bridgeStatus.textContent = error.message; }
            finally { restartButton.disabled = false; restartButton.textContent = '重启本机服务'; }
        });
        document.getElementById('cookie-mcp-connect').addEventListener('click', event => {
            event.stopPropagation();
            request({ type: 'COOKIE_MCP_CONNECT' }).catch(reportError);
        });
    }
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (Object.keys(changes).some(key => key.startsWith('cookieExport'))) {
            request({ type: 'COOKIE_EXPORT_GET_STATE' }).then(result => { state = result.state; render(); }).catch(reportError);
        }
        if (!isPopup && (changes.cookieMcpBridgeConnected || changes.cookieMcpBridgeError || changes.cookieMcpBridgeRestarting || changes.cookieMcpBridgeRestartError)) {
            chrome.storage.local.get({ cookieMcpBridgeConnected: false, cookieMcpBridgeError: '', cookieMcpBridgeRestarting: false, cookieMcpBridgeRestartError: '' }, items => renderBridge(items.cookieMcpBridgeConnected, items.cookieMcpBridgeError, items.cookieMcpBridgeRestarting, items.cookieMcpBridgeRestartError));
        }
    });
    function renderBridge(connected, error = '', restarting = false, restartError = '') {
        const text = restarting ? '正在重启本机服务并恢复连接…' : restartError ? `服务重启未完成：${restartError}` : connected
            ? 'MCP 桥接已连接，可以让 AI 导出到临时目录。'
            : `MCP 桥接未连接${error ? `：${error}` : '：首次使用请运行 mcp/cookie-export/install.ps1，再点击连接。'}`;
        document.getElementById('cookie-mcp-status').textContent = text;
        document.getElementById('cookie-mcp-restart').disabled = restarting;
    }
    request({ type: 'COOKIE_EXPORT_GET_STATE' }).then(async result => {
        state = result.state;
        input.value = state.cookieExportLastDomain;
        if (isPopup) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.url && /^https?:\/\//i.test(tab.url)) input.value = new URL(tab.url).hostname;
        }
        render();
    }).catch(reportError);
    if (!isPopup) {
        chrome.storage.local.get({ cookieMcpBridgeConnected: false, cookieMcpBridgeError: '', cookieMcpBridgeRestarting: false, cookieMcpBridgeRestartError: '' }, items => renderBridge(items.cookieMcpBridgeConnected, items.cookieMcpBridgeError, items.cookieMcpBridgeRestarting, items.cookieMcpBridgeRestartError));
    }
    registerPopupCardAction('module-cookie-export', exportCurrentSite);
}

// --- 功能显示管理模块逻辑 ---
function initSettingsModule() {
    const defaultVisibility = { speed: true, proxy: true, copy: true, dark: true, csdn: true };
    const configs = [
        { id: 'visibility-speed', module: 'module-speed', key: 'speed' },
        { id: 'visibility-proxy', module: 'module-proxy', key: 'proxy' },
        { id: 'visibility-copy', module: 'module-copy', key: 'copy' },
        { id: 'visibility-dark', module: 'module-dark', key: 'dark' },
        { id: 'visibility-csdn', module: 'module-csdn', key: 'csdn' }
    ];

    chrome.storage.sync.get({
        visibleModules: defaultVisibility
    }, (items) => {
        const visibility = { ...defaultVisibility, ...items.visibleModules };
        
        configs.forEach(cfg => {
            const checkbox = document.getElementById(cfg.id);
            const moduleEl = document.getElementById(cfg.module);
            
            // 设置勾选框状态
            checkbox.checked = visibility[cfg.key];
            
            // 如果是 Popup 模式，应用显隐
            if (isPopup && !visibility[cfg.key]) {
                moduleEl.classList.add('hidden-in-popup');
            }

            // 监听变化
            checkbox.addEventListener('change', () => {
                visibility[cfg.key] = checkbox.checked;
                chrome.storage.sync.set({ visibleModules: visibility }, () => {
                    showStatus('显示配置已更新');
                });
            });
        });
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initAccordion();
    initSpeedModule();
    initProxyModule();
    initCopyModule();
    initDarkModeModule();
    initCsdnModule();
    initShortcutModule();
    initCookieExportModule();
    initSettingsModule();
    initPopupCardActions();

    // 更多设置跳转
    const moreSettings = document.getElementById('more-settings');
    if (moreSettings) {
        moreSettings.addEventListener('click', (e) => {
            e.preventDefault();
            chrome.runtime.openOptionsPage();
        });
    }
});
