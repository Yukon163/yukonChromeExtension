import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';
const token = 'a'.repeat(64);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function readReady(file, validate = () => true) {
    for (let attempt = 0; attempt < 100; attempt++) {
        try { const value = JSON.parse(await readFile(file, 'utf8')); if (validate(value)) return value; } catch {}
        await delay(50);
    }
    throw new Error('Test service did not become ready');
}
async function stop(child) {
    if (!child || child.exitCode !== null) return;
    child.kill();
    await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 1000).unref(); });
}

test('authenticated settings restart changes only the owned service and preserves exports', { timeout: 30000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yukon-service-control-test-'));
    const home = path.join(root, 'bridge');
    await mkdir(home);
    const connectionFile = path.join(root, 'cookie-bridge-config.json');
    const stateFile = path.join(home, 'daemon-state.json');
    const controlFile = path.join(home, 'service-control-state.json');
    const savedFile = path.join(root, 'saved.cookies.json');
    const saved = '{"cookies":[{"value":"synthetic-login"}]}';
    await writeFile(savedFile, saved);
    await writeFile(path.join(home, 'service-config.json'), JSON.stringify({ token, allowed_origins: [origin], extension_config: connectionFile }));
    const env = { ...process.env, YUKON_COOKIE_BRIDGE_HOME: home, YUKON_ARTICLE_TEMP_ROOT: path.join(root, 'articles'), YUKON_COOKIE_CONTROL_TEST_DIAGNOSTICS: '1', TEMP: root, TMP: root };
    const daemon = spawn(process.execPath, [path.join(packageRoot, 'bridge-daemon.mjs')], { env, windowsHide: true, stdio: 'ignore' });
    const control = spawn(process.execPath, [path.join(packageRoot, 'service-control.mjs')], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let controlErrors = '';
    control.stderr.on('data', bytes => { controlErrors += bytes.toString(); });
    let browser;
    let restartedPid;
    let unrelated;
    t.after(async () => {
        browser?.terminate();
        if (restartedPid) await run('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${Number(restartedPid)} -Force -ErrorAction SilentlyContinue`], { windowsHide: true }).catch(() => {});
        await Promise.all([stop(daemon), stop(control), stop(unrelated)]);
        const resolved = path.resolve(root);
        assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
        assert.ok(path.basename(resolved).startsWith('yukon-service-control-test-'));
        await rm(resolved, { recursive: true, force: true });
    });
    const oldState = await readReady(stateFile, value => value.pid === daemon.pid);
    const controller = await readReady(controlFile, value => value.pid === control.pid);
    const url = `http://127.0.0.1:${controller.port}/restart`;
    const deniedOrigin = await fetch(url, { method: 'POST', headers: { Origin: 'https://other.example', Authorization: `Bearer ${token}` } });
    assert.equal(deniedOrigin.status, 403);
    const deniedToken = await fetch(url, { method: 'POST', headers: { Origin: origin.slice(0, -1), Authorization: 'Bearer invalid' } });
    assert.equal(deniedToken.status, 401);
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).pid, oldState.pid);
    const response = await fetch(url, { method: 'POST', headers: { Origin: origin.slice(0, -1), Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200, controlErrors);
    const result = await response.json();
    restartedPid = result.pid;
    assert.equal(result.ok, true);
    assert.notEqual(result.pid, oldState.pid);
    assert.equal(await readFile(savedFile, 'utf8'), saved);
    const connection = JSON.parse(await readFile(connectionFile, 'utf8'));
    assert.equal(connection.control_port, controller.port);
    assert.equal(connection.port, result.port);
    assert.ok(!JSON.stringify(result).includes(token));
    browser = new WebSocket(`ws://127.0.0.1:${result.port}`, { origin: origin.slice(0, -1) });
    await new Promise((resolve, reject) => {
        browser.on('error', reject);
        browser.on('open', () => browser.send(JSON.stringify({ type: 'COOKIE_MCP_HELLO', origin, token })));
        browser.on('message', bytes => { if (JSON.parse(bytes).type === 'COOKIE_MCP_READY') resolve(); });
    });
    unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    await delay(100);
    await writeFile(stateFile, JSON.stringify({ pid: unrelated.pid }));
    const refused = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(refused.status, 500);
    assert.equal(unrelated.exitCode, null);
});
