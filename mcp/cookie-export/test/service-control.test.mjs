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

test('manual startup uses the saved directory and Node path and serializes concurrent launches', { timeout: 60000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yukon-service-control-test-'));
    const home = path.join(root, 'bridge');
    await mkdir(home);
    const connectionFile = path.join(root, 'cookie-bridge-config.json');
    const configFile = path.join(home, 'service-config.json');
    const daemonFile = path.join(home, 'daemon-state.json');
    const controlFile = path.join(home, 'service-control-state.json');
    const config = { token, allowed_origins: [origin], extension_config: connectionFile, node_path: process.execPath, bridge_home: home };
    await writeFile(configFile, JSON.stringify(config));
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const wscript = path.join(process.env.SystemRoot, 'System32', 'wscript.exe');
    const env = { ...process.env, YUKON_COOKIE_BRIDGE_HOME: home, PATH: path.join(process.env.SystemRoot, 'System32'), TEMP: root, TMP: root };
    const managed = new Set();
    const launch = () => run(wscript, ['//B', '//Nologo', '//E:JScript', path.join(packageRoot, 'start-silent.js'), powershell, home], {
        env: { ...env, YUKON_COOKIE_BRIDGE_HOME: path.join(root, 'wrong-home') }, windowsHide: true, timeout: 25000
    });
    // The installing app may read an AppData alias while a scheduled task sees the
    // actual directory; all child processes must use the saved physical home.
    const aliasedAppData = path.join(root, 'aliased-appdata');
    const aliasHome = path.join(aliasedAppData, 'YukonChromeCookieExport');
    await mkdir(aliasHome, { recursive: true });
    await writeFile(path.join(aliasHome, 'service-config.json'), JSON.stringify(config));
    const launchFromAlias = () => run(powershell, ['-NoProfile', '-File', path.join(packageRoot, 'check-service.ps1')], {
        env: { ...env, LOCALAPPDATA: aliasedAppData, YUKON_COOKIE_BRIDGE_HOME: '' }, windowsHide: true, timeout: 25000
    });
    const states = async () => {
        const daemon = await readReady(daemonFile);
        const control = await readReady(controlFile);
        managed.add(daemon.pid); managed.add(control.pid);
        return { daemon, control };
    };
    t.after(async () => {
        // Capture startup PIDs even if a launch assertion failed partway through.
        for (const file of [daemonFile, controlFile]) {
            try { managed.add(JSON.parse(await readFile(file, 'utf8')).pid); } catch {}
        }
        for (const pid of managed) { try { process.kill(pid); } catch {} }
        const resolved = path.resolve(root);
        assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
        assert.ok(path.basename(resolved).startsWith('yukon-service-control-test-'));
        await rm(resolved, { recursive: true, force: true });
    });
    await Promise.all([launch(), launch()]);
    const first = await states();
    await Promise.all([launchFromAlias(), launch()]);
    assert.deepEqual(await states(), first);
    const firstLog = await readFile(path.join(home, 'service-start.log'), 'utf8');
    assert.equal(firstLog.split('\n').filter(line => line.includes(' started pid=')).length, 2);
    process.kill(first.daemon.pid); process.kill(first.control.pid);
    managed.delete(first.daemon.pid); managed.delete(first.control.pid);
    await Promise.all([launchFromAlias(), launch()]);
    const recovered = await states();
    assert.notEqual(recovered.daemon.pid, first.daemon.pid);
    assert.notEqual(recovered.control.pid, first.control.pid);
    const connection = JSON.parse(await readFile(connectionFile, 'utf8'));
    assert.equal(connection.port, recovered.daemon.port);
    assert.equal(connection.control_port, recovered.control.port);
    const ready = await fetch(`http://127.0.0.1:${recovered.control.port}/restart`, { method: 'OPTIONS', headers: { Origin: origin.slice(0, -1) } });
    assert.equal(ready.status, 204);
    const log = await readFile(path.join(home, 'service-start.log'), 'utf8');
    assert.equal(log.split('\n').filter(line => line.includes(' started pid=')).length, 4);
    assert.ok(!log.includes(token));

    // A missing pinned runtime must produce a useful, secret-free failure log.
    process.kill(recovered.daemon.pid); process.kill(recovered.control.pid);
    managed.delete(recovered.daemon.pid); managed.delete(recovered.control.pid);
    await writeFile(configFile, JSON.stringify({ ...config, node_path: path.join(root, 'missing-node.exe') }));
    await assert.rejects(launch());
    const failedLog = await readFile(path.join(home, 'service-start.log'), 'utf8');
    assert.ok(failedLog.includes('startup failed'));
    assert.ok(failedLog.includes('Configured Node executable is missing'));
    assert.ok(!failedLog.includes(token));
});

test('silent startup creates PowerShell hidden and returns its failure code with Unicode paths', { timeout: 30000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yukon-service-control-test-silent 中文 '));
    t.after(async () => {
        const resolved = path.resolve(root);
        assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
        assert.ok(path.basename(resolved).startsWith('yukon-service-control-test-'));
        await rm(resolved, { recursive: true, force: true });
    });
    await writeFile(path.join(root, 'start-silent.js'), await readFile(path.join(packageRoot, 'start-silent.js')));
    await writeFile(path.join(root, 'check-service.ps1'), `\uFEFFparam([string]$BridgeHome)
$ErrorActionPreference = 'Stop'
try {
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class StartupWindowProbe {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct StartupInfo {
        public uint cb;
        public IntPtr reserved, desktop, title;
        public uint x, y, width, height, charsX, charsY, fill, flags;
        public ushort showWindow, reservedSize;
        public IntPtr reservedBytes, stdin, stdout, stderr;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern void GetStartupInfo(out StartupInfo info);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);
}
'@
$info = New-Object StartupWindowProbe+StartupInfo
[StartupWindowProbe]::GetStartupInfo([ref]$info)
$record = @{initialHidden = (($info.flags -band 1) -ne 0 -and $info.showWindow -eq 0); consoleVisible = [StartupWindowProbe]::IsWindowVisible([StartupWindowProbe]::GetConsoleWindow())}
[IO.File]::WriteAllText((Join-Path $BridgeHome 'window-state.json'), ($record | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
exit 7
} catch {
    [IO.File]::WriteAllText((Join-Path $BridgeHome 'probe-error.txt'), $_.Exception.Message)
    exit 8
}
`);
    const wscript = path.join(process.env.SystemRoot, 'System32', 'wscript.exe');
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let failure;
    try {
        await run(wscript, ['//B', '//Nologo', '//E:JScript', path.join(root, 'start-silent.js'), powershell, root], { windowsHide: true, timeout: 25000 });
    } catch (error) { failure = error; }
    const probeError = await readFile(path.join(root, 'probe-error.txt'), 'utf8').catch(() => '');
    assert.equal(failure?.code, 7, probeError || JSON.stringify({ code: failure?.code, killed: failure?.killed, signal: failure?.signal }));
    const state = JSON.parse(await readFile(path.join(root, 'window-state.json'), 'utf8'));
    assert.equal(state.initialHidden, true);
    assert.equal(state.consoleVisible, false);
});
