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

// --- 手风琴逻辑 ---
function initAccordion() {
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

    // 快捷切换状态
    badge.addEventListener('click', (e) => {
        e.stopPropagation(); // 阻止手风琴折叠
        const newMode = badge.textContent === '系统' ? 'direct' : 'system';
        chrome.storage.sync.set({ proxyMode: newMode }, () => {
            systemToggle.checked = (newMode === 'system');
            directToggle.checked = (newMode === 'direct');
            updateBadge(newMode);
            showStatus(`已切换为: ${newMode === 'system' ? '系统代理' : '直连'}`);
        });
    });

    // 监听系统代理切换
    systemToggle.addEventListener('change', () => {
        if (systemToggle.checked) {
            directToggle.checked = false;
            chrome.storage.sync.set({ proxyMode: 'system' }, () => {
                updateBadge('system');
                showStatus('已切换为: 系统代理');
            });
        } else {
            // 如果关掉系统代理，强制打开直连
            directToggle.checked = true;
            chrome.storage.sync.set({ proxyMode: 'direct' }, () => {
                updateBadge('direct');
                showStatus('已切换为: 直连');
            });
        }
    });

    // 监听直连切换
    directToggle.addEventListener('change', () => {
        if (directToggle.checked) {
            systemToggle.checked = false;
            chrome.storage.sync.set({ proxyMode: 'direct' }, () => {
                updateBadge('direct');
                showStatus('已切换为: 直连');
            });
        } else {
            // 如果关掉直连，强制打开系统代理
            systemToggle.checked = true;
            chrome.storage.sync.set({ proxyMode: 'system' }, () => {
                updateBadge('system');
                showStatus('已切换为: 系统代理');
            });
        }
    });
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

    // 快捷切换状态
    badge.addEventListener('click', (e) => {
        e.stopPropagation(); // 阻止手风琴折叠
        const newState = badge.textContent === '关闭';
        chrome.storage.sync.set({ superCopy: newState }, () => {
            toggle.checked = newState;
            updateBadge(newState);
            showStatus(newState ? '超级复制已开启' : '超级复制已关闭');
        });
    });

    toggle.addEventListener('change', () => {
        const enabled = toggle.checked;
        chrome.storage.sync.set({ superCopy: enabled }, () => {
            updateBadge(enabled);
            showStatus(enabled ? '超级复制已开启' : '超级复制已关闭');
        });
    });
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

    // 快捷切换状态
    badge.addEventListener('click', (e) => {
        e.stopPropagation();
        const newState = badge.textContent === '已关闭';
        chrome.storage.sync.set({ csdnOptimize: newState }, () => {
            toggle.checked = newState;
            updateBadge(newState);
            showStatus(newState ? 'CSDN 优化已开启 (刷新生效)' : 'CSDN 优化已关闭 (刷新生效)');
        });
    });

    toggle.addEventListener('change', () => {
        const enabled = toggle.checked;
        chrome.storage.sync.set({ csdnOptimize: enabled }, () => {
            updateBadge(enabled);
            showStatus(enabled ? 'CSDN 优化已开启 (刷新生效)' : 'CSDN 优化已关闭 (刷新生效)');
        });
    });
}

// --- 功能显示管理模块逻辑 ---
function initSettingsModule() {
    const configs = [
        { id: 'visibility-speed', module: 'module-speed', key: 'speed' },
        { id: 'visibility-proxy', module: 'module-proxy', key: 'proxy' },
        { id: 'visibility-copy', module: 'module-copy', key: 'copy' },
        { id: 'visibility-csdn', module: 'module-csdn', key: 'csdn' }
    ];

    chrome.storage.sync.get({
        visibleModules: { speed: true, proxy: true, copy: true, csdn: true }
    }, (items) => {
        const visibility = items.visibleModules;
        
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
    initCsdnModule();
    initSettingsModule();

    // 更多设置跳转
    const moreSettings = document.getElementById('more-settings');
    if (moreSettings) {
        moreSettings.addEventListener('click', (e) => {
            e.preventDefault();
            chrome.runtime.openOptionsPage();
        });
    }
});
