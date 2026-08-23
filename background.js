const FEISHU_COPY_SCRIPT_ID = 'yukon-feishu-copy-permission';
const FEISHU_COPY_SCRIPT = {
    id: FEISHU_COPY_SCRIPT_ID,
    matches: [
        '*://*.feishu.cn/*',
        '*://*.larksuite.com/*',
        '*://*.larkoffice.com/*'
    ],
    js: ['feishu-copy.js'],
    allFrames: true,
    runAt: 'document_start',
    world: 'MAIN',
    persistAcrossSessions: true
};
let feishuCopySyncQueue = Promise.resolve();

function syncFeishuCopyScript(enabled) {
    const shouldEnable = Boolean(enabled);

    feishuCopySyncQueue = feishuCopySyncQueue.then(async () => {
        const registered = await chrome.scripting.getRegisteredContentScripts({
            ids: [FEISHU_COPY_SCRIPT_ID]
        });
        const isRegistered = registered.length > 0;

        if (shouldEnable && !isRegistered) {
            await chrome.scripting.registerContentScripts([FEISHU_COPY_SCRIPT]);
        } else if (!shouldEnable && isRegistered) {
            await chrome.scripting.unregisterContentScripts({ ids: [FEISHU_COPY_SCRIPT_ID] });
        }
    }).catch((error) => {
        console.warn('[yukonChromeExtension] 同步飞书复制权限脚本失败:', error);
    });

    return feishuCopySyncQueue;
}

function syncFeishuCopyScriptFromStorage() {
    chrome.storage.sync.get({ superCopy: false }, (items) => {
        syncFeishuCopyScript(Boolean(items.superCopy));
    });
}

// Listen for messages from content scripts and relay them to all frames in the same tab
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if ((message.type === 'NAV_EPISODE' || message.type === 'SYNC_SPEED') && sender.tab) {
        // Relay the message back to all frames in the same tab
        // For NAV_EPISODE, we might want to keep it to frame 0, but for SYNC_SPEED, we need all frames
        const options = message.type === 'NAV_EPISODE' ? { frameId: 0 } : {};
        chrome.tabs.sendMessage(sender.tab.id, message, options);
    }
    return false; 
});

chrome.commands.onCommand.addListener((command, tab) => {
    if (command !== 'insert-feishu-dollars' || !tab?.id) return;

    chrome.tabs.sendMessage(tab.id, { type: 'OPEN_FEISHU_FORMULA', source: 'command' }, () => {
        if (chrome.runtime.lastError) {
            console.warn('[yukonChromeExtension] open Feishu formula command failed:', chrome.runtime.lastError.message);
        }
    });
});

// Function to apply proxy settings based on mode
function updateProxySettings(mode) {
    let config;
    
    if (mode === 'direct') {
        // No Proxy (Direct)
        config = { mode: "direct" };
    } else {
        // System Proxy
        config = { mode: "system" };
    }

    chrome.proxy.settings.set(
        { value: config, scope: 'regular' },
        function() {
            console.log(`[ProxyManager] Proxy mode set to: ${mode}`);
        }
    );
}

// Initial load on startup
chrome.storage.sync.get({
    proxyMode: 'system'
}, (items) => {
    updateProxySettings(items.proxyMode);
});

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.proxyMode) {
        updateProxySettings(changes.proxyMode.newValue);
    }
    if (area === 'sync' && changes.superCopy) {
        syncFeishuCopyScript(Boolean(changes.superCopy.newValue));
    }
});

chrome.runtime.onInstalled.addListener(() => {
    console.log('yukonChromeExtension installed/updated');
    
    // 初始化或迁移白名单
    chrome.storage.sync.get({ whitelist: ['cycani.org', 'mgnacg.com'] }, (items) => {
        let list = items.whitelist;
        let changed = false;
        
        // 确保 mgnacg.com 在白名单中（针对旧版本升级用户）
        if (!list.includes('mgnacg.com')) {
            list.push('mgnacg.com');
            changed = true;
        }
        
        if (changed) {
            chrome.storage.sync.set({ whitelist: list });
        }
    });

    syncFeishuCopyScriptFromStorage();
});

chrome.runtime.onStartup.addListener(syncFeishuCopyScriptFromStorage);
