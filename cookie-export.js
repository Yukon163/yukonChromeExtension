(function() {
    'use strict';

    const DIRECTORY = '系统临时目录/yukonChromeExtension/cookies';
    const DEFAULTS = {
        cookieExportAutoSites: [],
        cookieExportFiles: {},
        cookieExportStatuses: {},
        cookieExportLastDomain: 'juejin.cn'
    };
    const MESSAGE_TYPES = new Set([
        'COOKIE_EXPORT_GET_STATE', 'COOKIE_EXPORT_NOW', 'COOKIE_EXPORT_SET_AUTO',
        'COOKIE_EXPORT_SHOW_FILE', 'COOKIE_EXPORT_OPEN_FOLDER'
    ]);
    const timers = new Map();
    let queue = Promise.resolve();

    function normalizeDomain(input) {
        if (typeof input !== 'string' || !input.trim()) throw new Error('请输入网站域名或网址');
        const url = new URL(input.includes('://') ? input.trim() : `https://${input.trim()}`);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
            throw new Error('请输入 HTTP/HTTPS 网站的域名或网址');
        }
        return url.hostname.toLowerCase().replace(/\.$/, '');
    }

    function belongsToSite(cookie, domain) {
        const cookieDomain = cookie.domain.replace(/^\./, '').toLowerCase();
        return cookieDomain === domain || cookieDomain.endsWith(`.${domain}`) ||
            (!cookie.hostOnly && domain.endsWith(`.${cookieDomain}`));
    }

    async function readSnapshot(input) {
        const domain = normalizeDomain(input);
        if (chrome.extension.inIncognitoContext) throw new Error('请在普通 Chrome 窗口中导出');
        const cookies = (await chrome.cookies.getAll({})).filter(cookie => belongsToSite(cookie, domain));
        cookies.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        return { schemaVersion: 1, domain, exportedAt: new Date().toISOString(), cookies };
    }

    // 只在扩展后台暴露，供本机 Native Messaging 桥接复用。
    globalThis.YukonCookieExporter = Object.freeze({ normalizeDomain, readSnapshot });

    async function getState() {
        return { ...await chrome.storage.local.get(DEFAULTS), directory: DIRECTORY };
    }

    async function setStatus(domain, status) {
        const { cookieExportStatuses } = await getState();
        await chrome.storage.local.set({
            cookieExportStatuses: { ...cookieExportStatuses, [domain]: status }
        });
    }

    async function exportSite(domain, { automatic = false, force = false } = {}) {
        if (chrome.extension.inIncognitoContext) throw new Error('请在普通 Chrome 窗口中导出');
        const state = await getState();
        if (automatic && !state.cookieExportAutoSites.includes(domain)) return;

        try {
            // domain 筛选会漏掉父域共享的登录 Cookie。读取后严格按主机关系筛选，
            // 保留父域、子域、路径和同名项；不会拼接可能串域的 Cookie 请求头。
            const snapshot = await readSnapshot(domain);
            const { cookies } = snapshot;
            const bytes = new TextEncoder().encode(JSON.stringify(cookies));
            const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
                .map(value => value.toString(16).padStart(2, '0')).join('');
            if (!force && state.cookieExportFiles[domain]?.hash === hash) return;
            if (automatic && !(await getState()).cookieExportAutoSites.includes(domain)) return;

            await setStatus(domain, { phase: 'saving' });
            const { exportedAt } = snapshot;
            const saved = await YukonCookieNativeBridge.save(snapshot);
            const file = { filename: saved.absolute_path, exportedAt, count: cookies.length, hash };
            const current = await getState();
            await chrome.storage.local.set({
                cookieExportFiles: { ...current.cookieExportFiles, [domain]: file },
                cookieExportStatuses: { ...current.cookieExportStatuses, [domain]: { phase: 'saved' } },
                cookieExportLastDomain: domain
            });
            return file;
        } catch (error) {
            // 不回显底层异常、Cookie 或序列化内容到页面、控制台、同步存储。
            const { cookieMcpBridgeError } = await chrome.storage.local.get({ cookieMcpBridgeError: '' });
            const message = cookieMcpBridgeError
                ? `导出失败：${cookieMcpBridgeError}`
                : '导出未完成，请确认本机桥接已安装并连接，且临时目录可写';
            await setStatus(domain, { phase: 'error', message });
            throw new Error(message);
        }
    }

    function enqueueExport(domain, options) {
        const task = queue.then(() => exportSite(domain, options));
        queue = task.catch(() => {});
        return task;
    }

    function scheduleExport(domain) {
        clearTimeout(timers.get(domain));
        timers.set(domain, setTimeout(() => {
            timers.delete(domain);
            enqueueExport(domain, { automatic: true }).catch(() => {});
        }, 2000));
    }

    async function handleMessage(message) {
        if (message.type === 'COOKIE_EXPORT_GET_STATE') return { ok: true, state: await getState() };
        if (message.type === 'COOKIE_EXPORT_OPEN_FOLDER') {
            await YukonCookieNativeBridge.openFolder();
            return { ok: true };
        }
        const domain = normalizeDomain(message.domain);
        if (message.type === 'COOKIE_EXPORT_NOW') {
            const file = await enqueueExport(domain, { force: true });
            return { ok: true, file, state: await getState() };
        }
        if (message.type === 'COOKIE_EXPORT_SET_AUTO') {
            if (typeof message.enabled !== 'boolean') throw new Error('自动导出开关无效');
            const state = await getState();
            const sites = new Set(state.cookieExportAutoSites);
            if (message.enabled) sites.add(domain);
            else sites.delete(domain);
            await chrome.storage.local.set({
                cookieExportAutoSites: [...sites], cookieExportLastDomain: domain
            });
            return { ok: true, state: await getState() };
        }
        const file = (await getState()).cookieExportFiles[domain];
        if (!file) throw new Error('请先导出这个网站的 Cookie');
        await YukonCookieNativeBridge.showFile(domain);
        return { ok: true };
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!MESSAGE_TYPES.has(message?.type)) return false;
        const settingsUrl = chrome.runtime.getURL('options.html');
        if (sender.id !== chrome.runtime.id ||
            (sender.url !== settingsUrl && !sender.url?.startsWith(`${settingsUrl}?`))) {
            return false;
        }
        handleMessage(message).then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
        return true;
    });

    chrome.cookies.onChanged.addListener(change => {
        if (chrome.extension.inIncognitoContext) return;
        getState().then(state => {
            for (const domain of state.cookieExportAutoSites) {
                if (belongsToSite(change.cookie, domain)) scheduleExport(domain);
            }
        }).catch(() => {});
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.cookieExportAutoSites) return;
        const previous = changes.cookieExportAutoSites.oldValue || [];
        const sites = changes.cookieExportAutoSites.newValue || [];
        for (const domain of previous) {
            if (!sites.includes(domain)) {
                clearTimeout(timers.get(domain));
                timers.delete(domain);
            }
        }
        for (const domain of sites) {
            if (!previous.includes(domain)) enqueueExport(domain, { automatic: true, force: true }).catch(() => {});
        }
    });

    async function exportOnStartup() {
        const state = await getState();
        for (const domain of state.cookieExportAutoSites) {
            enqueueExport(domain, { automatic: true, force: true }).catch(() => {});
        }
    }
    chrome.runtime.onStartup.addListener(() => exportOnStartup().catch(() => {}));
    chrome.runtime.onInstalled.addListener(() => exportOnStartup().catch(() => {}));
})();
