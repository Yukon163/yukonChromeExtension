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
                    } else if (message.type === 'ARTICLE_TEMP_PROGRESS') {
                        const call = pending.get(message.id);
                        if (call?.onProgress && ['resolving', 'exporting', 'validating', 'ready', 'images'].includes(message.phase)) {
                            try { call.onProgress(message.phase, { current: message.current, total: message.total }); } catch {}
                        }
                    } else if (message.type === 'COOKIE_MCP_RESULT') {
                        const call = pending.get(message.id);
                        if (call) { pending.delete(message.id); clearTimeout(call.timer); if (message.ok) call.resolve(message.result); else call.reject(new Error(message.error || '本机保存失败')); }
                    } else if (message.type === 'ARTICLE_IMPORT_RUN' && typeof message.id === 'string' && message.id.length <= 100) {
                        try {
                            const result = await YukonFeishuArticleImport.runFromTool({ sourceUrl: message.sourceUrl, inspect: !!message.inspect });
                            if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ id: message.id, ok: true, result }));
                        } catch (error) {
                            if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ id: message.id, ok: false, error: error.message }));
                        }
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
    async function request(type, values = {}, { onProgress } = {}) {
        await connect();
        return new Promise((resolve, reject) => {
            const id = crypto.randomUUID();
            const timeout = type === 'ARTICLE_TEMP_EXPORT' ? 200000 : 15000;
            const timer = setTimeout(() => { pending.delete(id); reject(new Error('本机服务响应超时')); }, timeout);
            pending.set(id, { resolve, reject, timer, onProgress });
            try { socket.send(JSON.stringify({ type, id, ...values })); }
            catch { clearTimeout(timer); pending.delete(id); reject(new Error('本机服务尚未连接')); }
        });
    }
    globalThis.YukonCookieNativeBridge = Object.freeze({
        save: snapshot => request('COOKIE_MCP_SAVE', { snapshot }),
        showFile: domain => request('COOKIE_MCP_SHOW_FILE', { domain }),
        openFolder: () => request('COOKIE_MCP_OPEN_FOLDER'),
        articlePing: () => request('ARTICLE_TEMP_PING'),
        restartService: () => restartService(),
        articleCreate: values => request('ARTICLE_TEMP_CREATE', values),
        articleExport: (values, onProgress) => request('ARTICLE_TEMP_EXPORT', values, { onProgress }),
        articleRead: values => request('ARTICLE_TEMP_READ', values),
        articleCleanup: jobId => request('ARTICLE_TEMP_CLEANUP', { jobId })
    });
    let restartTask;
    async function restartService() {
        if (restartTask) return restartTask;
        restartTask = (async () => {
            const configResponse = await fetch(chrome.runtime.getURL('cookie-bridge-config.json'), { cache: 'no-store' });
            const config = await configResponse.json();
            if (!Number.isInteger(config.control_port) || config.control_port < 1 || config.control_port > 65535 || !/^[a-f0-9]{64}$/.test(config.token)) {
                throw new Error('本机服务控制器尚未安装，请更新一次本机服务');
            }
            await chrome.storage.local.set({ cookieMcpBridgeRestarting: true, cookieMcpBridgeError: '', cookieMcpBridgeRestartError: '' });
            try {
                let response;
                try {
                    response = await fetch(`http://127.0.0.1:${config.control_port}/restart`, {
                        method: 'POST', headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(50000)
                    });
                } catch (error) {
                    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('重启请求超时，请稍后重试');
                    throw new Error('无法连接本机重启控制器，请稍后重试；仍失败时请运行 mcp/cookie-export/start-service.ps1');
                }
                if (!response.ok) throw new Error('本机服务重启失败，请检查服务控制器');
                const result = await response.json();
                if (!result.ok) throw new Error('本机服务重启失败');
                if (socket) {
                    const oldSocket = socket;
                    await new Promise(resolve => { oldSocket.addEventListener('close', resolve, { once: true }); oldSocket.close(); });
                }
                clearTimeout(retryTimer);
                await connect();
                return result;
            } catch (error) {
                await chrome.storage.local.set({ cookieMcpBridgeRestartError: error.message });
                throw error;
            } finally {
                await chrome.storage.local.set({ cookieMcpBridgeRestarting: false });
            }
        })();
        try { return await restartTask; } finally { restartTask = undefined; }
    }
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!['COOKIE_MCP_CONNECT', 'COOKIE_MCP_RESTART'].includes(message?.type)) return false;
        const url = chrome.runtime.getURL('options.html');
        if (sender.id !== chrome.runtime.id || (sender.url !== url && !sender.url?.startsWith(`${url}?`))) return false;
        const action = message.type === 'COOKIE_MCP_RESTART' ? restartService() : connect();
        action.then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: error.message }));
        return true;
    });
    connect().catch(() => {});
})();
