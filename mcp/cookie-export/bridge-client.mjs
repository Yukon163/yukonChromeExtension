import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

export function bridgeHome() {
    return process.env.YUKON_COOKIE_BRIDGE_HOME || path.join(process.env.LOCALAPPDATA || os.homedir(), 'YukonChromeCookieExport');
}

export async function requestBridge(connection, payload) {
    if (typeof connection.token !== 'string' || !/^[a-f0-9]{64}$/.test(connection.token) ||
        typeof connection.pipe !== 'string' || !connection.pipe.startsWith('\\\\.\\pipe\\yukon-cookie-export-')) {
        throw new Error('本机桥接配置无效，请重新运行 install.ps1');
    }
    return new Promise((resolve, reject) => {
        let buffer = '';
        const socket = net.createConnection(connection.pipe);
        socket.setEncoding('utf8');
        const fail = () => { socket.destroy(); reject(new Error('Chrome 桥接未连接，请打开 Chrome 并在扩展弹窗中点击连接本机桥接')); };
        socket.setTimeout(20000, fail);
        socket.once('error', fail);
        socket.once('connect', () => socket.write(JSON.stringify({ token: connection.token, ...payload }) + '\n'));
        socket.on('data', chunk => {
            buffer += chunk;
            if (buffer.length > 128 * 1024) return fail();
            const index = buffer.indexOf('\n');
            if (index === -1) return;
            try {
                const response = JSON.parse(buffer.slice(0, index));
                socket.destroy();
                if (!response.ok) reject(new Error(response.error || '本机导出失败'));
                else resolve(response.result);
            } catch { fail(); }
        });
        socket.once('end', () => { if (!buffer.includes('\n')) fail(); });
    });
}

export async function connectedBrowsers() {
    const directory = path.join(bridgeHome(), 'connections');
    let entries;
    try { entries = await readdir(directory); } catch { return []; }
    const results = await Promise.all(entries.filter(file => /^[a-f0-9-]+\.json$/.test(file)).map(async file => {
        try {
            const connection = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
            const info = await requestBridge(connection, { method: 'status' });
            return { connection, info };
        } catch { return null; }
    }));
    return results.filter(Boolean);
}

export async function exportCookies({ domain, output_directory, session_id }) {
    const browsers = await connectedBrowsers();
    if (browsers.length === 0) throw new Error('Chrome 桥接未连接：先运行 install.ps1，重新加载扩展并等待自动连接');
    if (!session_id && browsers.length > 1) throw new Error('检测到多个 Chrome 配置，请先调用 cookie_bridge_status，再传入目标 session_id');
    const target = session_id ? browsers.find(browser => browser.info.session_id === session_id) : browsers[0];
    if (!target) throw new Error('指定的 Chrome 会话未连接，请重新查询 cookie_bridge_status');
    return requestBridge(target.connection, { method: 'export', domain, output_directory });
}
