(function() {
    'use strict';
    let socket;
    let connecting;
    let retryTimer;
    const pending = new Map();
    function updateStatus(connected, error = '') {
        chrome.storage.local.set({ cookieMcpBridgeConnected: connected, cookieMcpBridgeError: error }).catch(() => {});
    }
    function connect() {
        if (chrome.extension.inIncognitoContext) return Promise.reject(new Error('请使用普通 Chrome 窗口'));
        if (socket?.readyState === WebSocket.OPEN && !connecting) return Promise.resolve();
        if (connecting) return connecting;
        clearTimeout(retryTimer);
        connecting = new Promise(async (resolve, reject) => {
            let deadline;
            try {
                const response = await fetch(chrome.runtime.getURL('cookie-bridge-config.json'), { cache: 'no-store' });
                const config = await response.json();
                if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid local configuration');
                const connection = new WebSocket(`ws://127.0.0.1:${config.port}`);
                socket = connection;
                deadline = setTimeout(() => connection.close(), 5000);
                connection.onopen = () => connection.send(JSON.stringify({ type: 'COOKIE_MCP_HELLO', token: config.token, origin: chrome.runtime.getURL('') }));
                connection.onmessage = async event => {
                    let message;
                    try { message = JSON.parse(event.data); } catch { return; }
                    if (message.type === 'COOKIE_MCP_READY') {
                        clearTimeout(deadline); connecting = undefined; updateStatus(true); resolve();
                    } else if (message.type === 'COOKIE_MCP_PING') {
                        connection.send(JSON.stringify({ type: 'COOKIE_MCP_PONG' }));
                    } else if (message.type === 'COOKIE_MCP_RESULT') {
                        const call = pending.get(message.id);
                        if (call) { pending.delete(message.id); clearTimeout(call.timer); if (message.ok) call.resolve(message.result); else call.reject(new Error(message.error || '本机保存失败')); }
                    } else if (message.type === 'COOKIE_MCP_EXPORT' && typeof message.id === 'string' && message.id.length <= 100) {
                        try {
                            const snapshot = await YukonCookieExporter.readSnapshot(message.domain);
                            if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ id: message.id, ok: true, snapshot }));
                        } catch {
                            if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ id: message.id, ok: false, error: '无法读取指定站点 Cookie' }));
                        }
                    }
                };
                connection.onerror = () => {};
                connection.onclose = event => {
                    clearTimeout(deadline);
                    if (socket === connection) socket = undefined;
                    connecting = undefined;
                    const error = event.code === 1008 ? '本机服务认证失败，请重新运行安装脚本' : '本机服务尚未连接，请确认后台服务已启动';
                    updateStatus(false, error); reject(new Error(error));
                    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error(error)); }
                    pending.clear();
                    retryTimer = setTimeout(() => connect().catch(() => {}), 5000);
                };
            } catch {
                connecting = undefined;
                const error = '找不到本机服务配置，请先运行安装脚本';
                updateStatus(false, error); reject(new Error(error));
                retryTimer = setTimeout(() => connect().catch(() => {}), 5000);
            }
        });
        return connecting;
    }
    async function request(type, values = {}) {
        await connect();
        return new Promise((resolve, reject) => {
            const id = crypto.randomUUID();
            const timer = setTimeout(() => { pending.delete(id); reject(new Error('本机服务响应超时')); }, 15000);
            pending.set(id, { resolve, reject, timer });
            try { socket.send(JSON.stringify({ type, id, ...values })); }
            catch { clearTimeout(timer); pending.delete(id); reject(new Error('本机服务尚未连接')); }
        });
    }
    globalThis.YukonCookieNativeBridge = Object.freeze({
        save: snapshot => request('COOKIE_MCP_SAVE', { snapshot }),
        showFile: domain => request('COOKIE_MCP_SHOW_FILE', { domain }),
        openFolder: () => request('COOKIE_MCP_OPEN_FOLDER')
    });
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type !== 'COOKIE_MCP_CONNECT') return false;
        const url = chrome.runtime.getURL('options.html');
        if (sender.id !== chrome.runtime.id || (sender.url !== url && !sender.url?.startsWith(`${url}?`))) return false;
        connect().then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: error.message }));
        return true;
    });
    connect().catch(() => {});
})();
