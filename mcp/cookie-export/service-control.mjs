import http from 'node:http';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bridgeHome } from './bridge-client.mjs';

const home = bridgeHome();
const config = JSON.parse(await readFile(path.join(home, 'service-config.json'), 'utf8'));
if (!/^[a-f0-9]{64}$/.test(config.token) || !Array.isArray(config.allowed_origins)) throw new Error('Invalid control configuration');
const statePath = path.join(home, 'service-control-state.json');
const run = promisify(execFile);
let restarting;

function allowedOrigin(origin) {
    return !origin || config.allowed_origins.includes(origin.endsWith('/') ? origin : origin + '/');
}
function authenticated(request) {
    const supplied = Buffer.from(String(request.headers.authorization || ''));
    const expected = Buffer.from(`Bearer ${config.token}`);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function restart() {
    if (restarting) return restarting;
    restarting = (async () => {
        const script = fileURLToPath(new URL('./restart-service.ps1', import.meta.url));
        await run('powershell.exe', ['-NoProfile', '-File', script], {
            windowsHide: true, timeout: 45000, env: process.env
        });
        const state = JSON.parse(await readFile(path.join(home, 'daemon-state.json'), 'utf8'));
        return { pid: state.pid, port: state.port, started_at: state.started_at };
    })();
    try { return await restarting; } finally { restarting = undefined; }
}

const server = http.createServer(async (request, response) => {
    if (!allowedOrigin(request.headers.origin)) { response.writeHead(403); response.end(); return; }
    if (request.headers.origin) response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
    response.setHeader('Vary', 'Origin');
    if (request.method === 'OPTIONS') {
        response.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization' });
        response.end(); return;
    }
    if (!authenticated(request)) { response.writeHead(401); response.end(); return; }
    if (request.method !== 'POST' || request.url !== '/restart') { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
        const result = await restart();
        response.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
        if (process.env.YUKON_COOKIE_CONTROL_TEST_DIAGNOSTICS === '1') process.stderr.write(String(error.stderr || error.message));
        response.writeHead(500);
        response.end(JSON.stringify({ ok: false, error: '服务重启失败，请检查本机服务目录和进程状态' }));
    }
});
server.requestTimeout = 55000;
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
await writeFile(statePath, JSON.stringify({ pid: process.pid, port }), { mode: 0o600 });
let existing = {};
try { existing = JSON.parse(await readFile(config.extension_config, 'utf8')); } catch {}
await writeFile(config.extension_config, JSON.stringify({ ...existing, token: config.token, control_port: port }), { mode: 0o600 });
process.stdout.write('Cookie service control ready\n');
async function close() {
    server.close();
    await unlink(statePath).catch(() => {});
    process.exit(0);
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
