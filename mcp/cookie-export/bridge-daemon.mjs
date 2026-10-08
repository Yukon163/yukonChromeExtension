import http from 'node:http';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { bridgeHome } from './bridge-client.mjs';
import { createBrowserSession } from './browser-session.mjs';

const home = bridgeHome();
const config = JSON.parse(await readFile(path.join(home, 'service-config.json'), 'utf8'));
if (!/^[a-f0-9]{64}$/.test(config.token) || !Array.isArray(config.allowed_origins)) throw new Error('Invalid local bridge configuration');
const server = http.createServer((request, response) => { response.writeHead(404); response.end(); });
const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
const sessions = new Set();
const statePath = path.join(home, 'daemon-state.json');

server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;
    if (origin && !config.allowed_origins.includes(origin.endsWith('/') ? origin : origin + '/')) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
    }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
});

sockets.on('connection', ws => {
    let session;
    let authenticating = false;
    const send = message => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
    const deadline = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
    let heartbeat;
    ws.on('error', () => {});
    ws.on('message', async bytes => {
        let message;
        try { message = JSON.parse(bytes.toString('utf8')); } catch { ws.close(1008, 'Invalid request'); return; }
        if (!session) {
            if (authenticating) return;
            const supplied = Buffer.from(typeof message.token === 'string' ? message.token : '');
            const expected = Buffer.from(config.token);
            if (message.type !== 'COOKIE_MCP_HELLO' || supplied.length !== expected.length ||
                !timingSafeEqual(supplied, expected) || !config.allowed_origins.includes(message.origin)) {
                ws.close(1008, 'Authentication failed');
                return;
            }
            authenticating = true;
            try {
                session = await createBrowserSession(send, message.origin);
                sessions.add(session);
                if (ws.readyState !== WebSocket.OPEN) { await session.close(); sessions.delete(session); return; }
                clearTimeout(deadline);
                send({ type: 'COOKIE_MCP_READY' });
                heartbeat = setInterval(() => send({ type: 'COOKIE_MCP_PING' }), 20000);
            } catch { ws.close(1011, 'Session setup failed'); }
        } else {
            session.receive(message).catch(() => ws.close(1011, 'Request failed'));
        }
    });
    ws.on('close', () => {
        clearTimeout(deadline);
        clearInterval(heartbeat);
        if (session) { sessions.delete(session); session.close().catch(() => {}); }
    });
});

await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
let connectionConfig = {};
try { connectionConfig = JSON.parse(await readFile(config.extension_config, 'utf8')); } catch {}
await writeFile(config.extension_config, JSON.stringify({ ...connectionConfig, port, token: config.token }), { mode: 0o600 });
await writeFile(statePath, JSON.stringify({ pid: process.pid, port, started_at: new Date().toISOString() }), { mode: 0o600 });
process.stdout.write('Cookie bridge service ready\n');
async function close() {
    for (const client of sockets.clients) client.terminate();
    await Promise.all([...sessions].map(session => session.close()));
    server.close();
    await unlink(statePath).catch(() => {});
    process.exit(0);
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
