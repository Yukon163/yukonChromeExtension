(function() {
    'use strict';
    const busyTabs = new Set();
    const sourcePatterns = ['*://*.feishu.cn/*', '*://*.larksuite.com/*', '*://*.larkoffice.com/*'];
    function isSource(url) {
        try {
            const parsed = new URL(url);
            return parsed.protocol === 'https:' && !parsed.username && !parsed.password && /(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(parsed.hostname) && /^\/(docx|wiki|doc)\/[^/]+/.test(parsed.pathname);
        } catch { return false; }
    }
    function isTarget(url) {
        try { const parsed = new URL(url); return parsed.origin === 'https://juejin.cn' && /^\/editor\/drafts\//.test(parsed.pathname); }
        catch { return false; }
    }
    async function page(tabId, method, args) {
        await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['article-page-adapters.js'] });
        const [result] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: (method, args) => window.__yukonArticleAdapters[method](args), args: [method, args] });
        if (!result?.result?.ok) {
            const stage = { checkTarget: '检查掘金编辑器', uploadJuejinImage: '掘金图片上传', importJuejin: '掘金正文导入', inspect: '读取页面控件' }[method] || '页面操作';
            throw new Error(`${stage}：${result?.result?.error || '页面未返回操作结果，请刷新后重试'}`);
        }
        return result.result;
    }
    async function sources() { return (await chrome.tabs.query({ url: sourcePatterns })).filter(tab => isSource(tab.url)); }
    async function waitTab(tabId) {
        for (let i = 0; i < 120; i++) {
            if ((await chrome.tabs.get(tabId)).status === 'complete') return;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw new Error('页面加载超时，请确认已经登录');
    }
    async function activate(tabId) {
        const tab = await chrome.tabs.update(tabId, { active: true });
        if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
        return tab;
    }
    async function progress(tabId, text, step, jobId) { await chrome.tabs.sendMessage(tabId, { type: 'FEISHU_IMPORT_PROGRESS', text, step, jobId }, { frameId: 0 }).catch(() => {}); }
    async function ensureArticleService(tabId, jobId) {
        const current = service => service?.ready && ['article-cli-export', 'article-image-transfer'].every(capability => service.capabilities?.includes(capability));
        let service = await YukonCookieNativeBridge.articlePing();
        if (current(service)) return;
        await progress(tabId, '正在自动更新本机服务，等待重新连接…', 1, jobId);
        try { await YukonCookieNativeBridge.restartService(); }
        catch { throw new Error('本机服务自动更新失败，请稍后重试'); }
        await progress(tabId, '本机服务已重新连接，正在检查导入功能…', 1, jobId);
        service = await YukonCookieNativeBridge.articlePing();
        if (!current(service)) throw new Error('本机服务自动更新后仍未就绪，请稍后重试');
    }
    async function readParts(jobId, assetId) {
        const parts = [];
        let offset = 0;
        for (;;) {
            const part = await YukonCookieNativeBridge.articleRead({ jobId, offset, ...(assetId ? { assetId } : {}) });
            parts.push(part.base64);
            if (part.done) break;
            if (part.nextOffset <= offset) throw new Error('临时文件读取中断');
            offset = part.nextOffset;
        }
        return parts;
    }
    function replaceImageUrls(parts, references, uploaded) {
        const chunks = parts.map(part => Uint8Array.from(atob(part), char => char.charCodeAt(0)));
        const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        let markdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        let previousStart = markdown.length;
        for (const ref of [...references].sort((a, b) => b.start - a.start)) {
            const url = uploaded.get(ref.assetId);
            if (!Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) || ref.start < 0 || ref.end > previousStart || markdown.slice(ref.start, ref.end) !== ref.sourceUrl || !url) throw new Error('图片地址替换未完成，已停止导入以免丢图');
            markdown = markdown.slice(0, ref.start) + url + markdown.slice(ref.end);
            previousStart = ref.start;
        }
        const result = new TextEncoder().encode(markdown);
        if (result.length > 16 * 1024 * 1024) throw new Error('替换图片后的 Markdown 超过 16 MB');
        const encoded = [];
        for (let start = 0; start < result.length; start += 384 * 1024) {
            let binary = '';
            const chunk = result.subarray(start, start + 384 * 1024);
            for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
            encoded.push(btoa(binary));
        }
        return encoded;
    }
    async function run(tabId, sourceUrl) {
        if (!isSource(sourceUrl)) throw new Error('请先选择有效的飞书文档');
        if (busyTabs.has(tabId)) throw new Error('当前草稿正在导入，请稍候');
        busyTabs.add(tabId);
        const jobId = crypto.randomUUID();
        let originalTab, saved = false, result, failure, transferredImages = 0;
        try {
            [originalTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            await page(tabId, 'checkTarget', {});
            await progress(tabId, '检查本机服务与编辑器…', 1, jobId);
            await ensureArticleService(tabId, jobId);
            const candidates = await sources();
            const wanted = new URL(sourceUrl);
            const source = candidates.find(tab => { const url = new URL(tab.url); return url.origin === wanted.origin && url.pathname === wanted.pathname; });
            await progress(tabId, '正在通过飞书 CLI 导出 Markdown…（最多 90 秒）', 2, jobId);
            saved = true;
            const file = await YukonCookieNativeBridge.articleExport({ jobId, sourceUrl, name: source?.title || '' }, (phase, details = {}) => {
                const text = { resolving: '查找飞书 CLI…', exporting: '飞书 CLI 已启动，等待文档导出…（最多 90 秒）', validating: '飞书已返回，正在校验 Markdown 文件…', ready: 'Markdown 已导出，准备读取临时文件…' }[phase];
                if (text) progress(tabId, text, 2, jobId);
                if (phase === 'images' && Number.isInteger(details.current) && Number.isInteger(details.total)) progress(tabId, `正在下载飞书图片（${details.current}/${details.total}）…`, 2, jobId);
            });
            await progress(tabId, `已导出 Markdown（${file.size || 0} 字节），正在读取并导入掘金…`, 3, jobId);
            let parts = await readParts(jobId);
            const uploaded = new Map();
            const assets = file.assets || [];
            if (assets.length) {
                await activate(tabId);
                const uploadStartedAt = Date.now();
                for (const asset of assets) {
                    const remaining = 90000 - (Date.now() - uploadStartedAt);
                    if (remaining <= 0) throw new Error('掘金图片上传超过 90 秒，请检查网络后重试');
                    await progress(tabId, `正在上传图片到掘金（${uploaded.size + 1}/${assets.length}）…`, 3, jobId);
                    const imageParts = await readParts(jobId, asset.id);
                    const image = await page(tabId, 'uploadJuejinImage', { asset, parts: imageParts, timeoutMs: Math.min(45000, remaining) });
                    uploaded.set(image.assetId, image.url);
                }
                parts = replaceImageUrls(parts, file.references, uploaded);
                transferredImages = uploaded.size;
            }
            await progress(tabId, '正在导入掘金编辑器，等待正文载入…', 3, jobId);
            await activate(tabId);
            result = await page(tabId, 'importJuejin', { name: file.name, parts, timeoutMs: 20000 });
        } catch (error) { failure = error; }
        finally {
            if (saved) {
                await progress(tabId, failure ? '导入未完成，正在清理临时文件…' : '正文已载入，正在清理临时文件…', 4, jobId);
                try { await YukonCookieNativeBridge.articleCleanup(jobId); }
                catch { failure = new Error(`${failure ? failure.message + '；' : ''}临时文件清理未完成，本机服务下次启动会补清理`); }
            }
            if (originalTab?.id) await activate(originalTab.id).catch(() => {});
            busyTabs.delete(tabId);
        }
        if (failure) throw failure;
        return { ok: true, imported: true, cleaned: true, imageLinks: result.imageLinks || 0, transferredImages };
    }
    globalThis.YukonFeishuArticleImport = Object.freeze({
        async runFromTool({ sourceUrl, inspect = false }) {
            if (!isSource(sourceUrl)) throw new Error('飞书来源链接无效');
            await chrome.storage.local.set({ feishuJuejinSourceUrl: sourceUrl });
            const { articleImportTestTabId } = await chrome.storage.local.get({ articleImportTestTabId: null });
            let target = articleImportTestTabId ? await chrome.tabs.get(articleImportTestTabId).catch(() => null) : null;
            if (!target || !isTarget(target.url)) {
                target = await chrome.tabs.create({ url: 'https://juejin.cn/editor/drafts/new?v=2', active: false });
                await chrome.storage.local.set({ articleImportTestTabId: target.id });
            }
            await waitTab(target.id);
            if (inspect) {
                return { target: await page(target.id, 'inspect', {}), sourceUrl, exportMode: 'lark-cli' };
            }
            const result = await run(target.id, sourceUrl);
            return { ...result, targetUrl: (await chrome.tabs.get(target.id)).url };
        }
    });
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        const fromTarget = sender.id === chrome.runtime.id && sender.frameId === 0 && sender.tab?.id && isTarget(sender.url);
        if (message?.type === 'FEISHU_IMPORT_SOURCES' && fromTarget) {
            (async () => {
                const tabs = await sources();
                const { feishuJuejinSourceUrl } = await chrome.storage.local.get({ feishuJuejinSourceUrl: '' });
                const unique = new Map();
                for (const { url, title } of tabs) {
                    const parsed = new URL(url);
                    const key = parsed.origin + parsed.pathname;
                    if (!unique.has(key)) unique.set(key, { url, title });
                }
                return { ok: true, sources: [...unique.values()], lastSourceUrl: isSource(feishuJuejinSourceUrl) ? feishuJuejinSourceUrl : '' };
            })().then(sendResponse, () => sendResponse({ ok: false, error: '无法读取已打开的飞书文档' }));
            return true;
        }
        if (message?.type !== 'FEISHU_IMPORT_BEGIN') return false;
        if (!fromTarget) return false;
        (async () => {
            const result = await run(sender.tab.id, message.sourceUrl);
            await chrome.storage.local.set({ feishuJuejinSourceUrl: message.sourceUrl });
            return result;
        })().then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
        return true;
    });
})();
