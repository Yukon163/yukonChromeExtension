let currentWhitelist = [];

// 显示状态
function showStatus(msg) {
    const status = document.getElementById('status');
    status.textContent = msg;
    setTimeout(() => status.textContent = '', 2000);
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
            badge.classList.remove('active');
        } else {
            badge.textContent = '直连';
            badge.classList.add('active');
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
            badge.textContent = '已开启';
            badge.classList.add('active');
        } else {
            badge.textContent = '已关闭';
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
        const newState = badge.textContent === '已关闭';
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

document.addEventListener('DOMContentLoaded', () => {
    initAccordion();
    initSpeedModule();
    initProxyModule();
    initCopyModule();
});
