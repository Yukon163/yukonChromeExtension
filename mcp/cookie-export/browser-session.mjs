import { mkdir, writeFile, unlink, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import { bridgeHome } from './bridge-client.mjs';
import { normalizeDomain } from './protocol.mjs';
import { saveSnapshot, defaultExportDirectory } from './files.mjs';
import { handleArticleTemp, cleanupStaleArticleTemps } from './article-temp.mjs';

export async function createBrowserSession(send, origin) {
    await cleanupStaleArticleTemps();
    const sessionId = randomUUID();
    const token = randomBytes(32).toString('hex');
    const pipe = `\\\\.\\pipe\\yukon-cookie-export-${sessionId}`;
    const connectedAt = new Date().toISOString();
    const stateFile = path.join(bridgeHome(), 'connections', `${sessionId}.json`);
    const pending = new Map();
    const sockets = new Set();
    const info = { session_id: sessionId, extension_origin: origin, connected_at: connectedAt };

    function readCookies(domain) {
        return new Promise((resolve, reject) => {
            const id = randomUUID();
            const timer = setTimeout(() => { pending.delete(id); reject(new Error('浏览器响应超时')); }, 15000);
            pending.set(id, { resolve, reject, timer });
            send({ type: 'COOKIE_MCP_EXPORT', id, domain });
        });
    }

    async function request(message) {
        const supplied = Buffer.from(typeof message.token === 'string' ? message.token : '');
        const expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('本机桥接认证失败');
        if (message.method === 'status') return info;
        if (message.method === 'import_article') {
            return new Promise((resolve, reject) => {
                const id = randomUUID();
                const timer = setTimeout(() => { pending.delete(id); reject(new Error('文章导入响应超时')); }, 330000);
                pending.set(id, { resolve, reject, timer, kind: 'article' });
                send({ type: 'ARTICLE_IMPORT_RUN', id, sourceUrl: message.source_url, inspect: !!message.inspect });
            });
        }
        if (message.method !== 'export') throw new Error('不支持的桥接操作');
        const domain = normalizeDomain(message.domain);
        if (message.output_directory !== undefined && (typeof message.output_directory !== 'string' || !path.isAbsolute(message.output_directory))) {
            throw new Error('output_directory 必须是本机绝对路径');
        }
        return saveSnapshot(await readCookies(domain), domain, message.output_directory);
    }

    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.setEncoding('utf8');
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        socket.setTimeout(20000, () => socket.destroy());
        let buffer = '';
        let handled = false;
        socket.on('data', chunk => {
            if (handled) return;
            buffer += chunk;
            if (buffer.length > 64 * 1024) { handled = true; socket.destroy(); return; }
            const index = buffer.indexOf('\n');
            if (index < 0) return;
            handled = true;
            const reply = response => { if (!socket.destroyed) socket.end(JSON.stringify(response) + '\n'); };
            try {
                const message = JSON.parse(buffer.slice(0, index));
                if (message.method === 'import_article') socket.setTimeout(340000);
                request(message).then(result => reply({ ok: true, result }), error => reply({ ok: false, error: error.message }));
            } catch { reply({ ok: false, error: '桥接请求格式无效' }); }
        });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
    await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    await writeFile(stateFile, JSON.stringify({ pipe, token }), { mode: 0o600, flag: 'wx' });

    async function receive(message) {
        if (message?.type === 'COOKIE_MCP_PONG') return;
        if (['ARTICLE_TEMP_PING', 'ARTICLE_TEMP_CREATE', 'ARTICLE_TEMP_EXPORT', 'ARTICLE_TEMP_READ', 'ARTICLE_TEMP_CLEANUP'].includes(message?.type)) {
            try { send({ type: 'COOKIE_MCP_RESULT', id: message.id, ok: true, result: await handleArticleTemp(message, {
                onProgress: progress => send({ type: 'ARTICLE_TEMP_PROGRESS', id: message.id, ...(typeof progress === 'string' ? { phase: progress } : progress) })
            }) }); }
            catch (error) { send({ type: 'COOKIE_MCP_RESULT', id: message.id, ok: false, error: error.message }); }
            return;
        }
        if (['COOKIE_MCP_SAVE', 'COOKIE_MCP_SHOW_FILE', 'COOKIE_MCP_OPEN_FOLDER'].includes(message?.type)) {
            try {
                let result = { ok: true };
                if (message.type === 'COOKIE_MCP_SAVE') {
                    result = await saveSnapshot(message.snapshot, normalizeDomain(message.snapshot?.domain), undefined, { overwrite: true });
                } else {
                    const folder = defaultExportDirectory();
                    await mkdir(folder, { recursive: true, mode: 0o700 });
                    let argument = folder;
                    if (message.type === 'COOKIE_MCP_SHOW_FILE') {
                        const filename = normalizeDomain(message.domain).replace(/[\[\]:]/g, '_') + '.cookies.json';
                        await access(path.join(folder, filename));
                        argument = `/select,${path.join(folder, filename)}`;
                    }
                    const child = spawn('explorer.exe', [argument], { windowsHide: true, detached: true, stdio: 'ignore' });
                    child.on('error', () => {});
                    child.unref();
                }
                send({ type: 'COOKIE_MCP_RESULT', id: message.id, ok: true, result });
            } catch {
                send({ type: 'COOKIE_MCP_RESULT', id: message.id, ok: false, error: '本机保存或目录操作失败，请检查临时目录权限' });
            }
            return;
        }
        const call = pending.get(message?.id);
        if (!call) return;
        pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.ok && call.kind === 'article' && message.result) call.resolve(message.result);
        else if (message.ok && message.snapshot) call.resolve(message.snapshot);
        else call.reject(new Error(call.kind === 'article' ? message.error || '文章导入失败' : '浏览器读取 Cookie 失败，请检查站点域名和扩展权限'));
    }

    async function close() {
        for (const socket of sockets) socket.destroy();
        server.close();
        for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Chrome 已断开连接')); }
        pending.clear();
        await unlink(stateFile).catch(() => {});
    }
    return { receive, close, info };
}
