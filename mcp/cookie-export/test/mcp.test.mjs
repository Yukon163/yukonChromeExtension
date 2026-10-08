import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket from 'ws';
import { nativeDecoder, encodeNative } from '../protocol.mjs';
import { saveSnapshot } from '../files.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const sample = { schemaVersion: 1, domain: 'example.com', cookies: [
    { name: 'sessionid', value: 'synthetic-cookie-never-real', domain: '.example.com', path: '/', httpOnly: true, hostOnly: false }
] };

test('native protocol handles fragmented UTF-8 and multiple frames', () => {
    const messages = [];
    const decode = nativeDecoder(message => messages.push(message));
    const frame = Buffer.concat([encodeNative({ domain: '中文.example' }), encodeNative({ next: true })]);
    for (const byte of frame) decode(Buffer.from([byte]));
    assert.deepEqual(messages, [{ domain: '中文.example' }, { next: true }]);
});

test('saving snapshots creates unique files and rejects mismatched cookie scope', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yukon-cookie-file-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const first = await saveSnapshot(sample, 'example.com', root);
    const second = await saveSnapshot(sample, 'example.com', root);
    assert.notEqual(first.filename, second.filename);
    assert.equal(first.cookie_count, 1);
    assert.ok(!JSON.stringify(first).includes(sample.cookies[0].value));
    const malicious = { ...sample, cookies: [{ ...sample.cookies[0], domain: 'other.com' }] };
    await assert.rejects(saveSnapshot(malicious, 'example.com', root), /不匹配/);
    assert.equal((await readdir(root)).length, 2);
    const stable = await saveSnapshot(sample, 'example.com', root, { overwrite: true });
    await saveSnapshot({ ...sample, cookies: [] }, 'example.com', root, { overwrite: true });
    assert.equal(stable.filename, 'example.com.cookies.json');
    assert.deepEqual(JSON.parse(await readFile(stable.absolute_path, 'utf8')).cookies, []);
    assert.equal((await readdir(root)).length, 3);
});

test('MCP stdio -> authenticated local service -> synthetic browser -> local file returns metadata only', { timeout: 20000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yukon-cookie-mcp-test-'));
    const home = path.join(root, 'bridge');
    await mkdir(home);
    const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';
    const extensionConfig = path.join(root, 'cookie-bridge-config.json');
    const token = 'a'.repeat(64);
    await writeFile(path.join(home, 'service-config.json'), JSON.stringify({ token, allowed_origins: [origin], extension_config: extensionConfig }));
    const env = { ...process.env, YUKON_COOKIE_BRIDGE_HOME: home };
    const host = spawn(process.execPath, [path.join(packageRoot, 'bridge-daemon.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    host.stdout.on('data', chunk => { if (chunk.toString().includes('service ready')) readyResolve(); });
    let stderr = '';
    host.stderr.on('data', chunk => { stderr += chunk.toString(); });
    let browser;
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(packageRoot, 'server.mjs')], env, stderr: 'pipe' });
    const client = new Client({ name: 'cookie-export-offline-test', version: '1.0.0' });
    t.after(async () => {
        await client.close().catch(() => {});
        browser?.terminate();
        host.kill();
        await new Promise(resolve => {
            if (host.exitCode !== null) return resolve();
            host.once('exit', resolve);
            const timer = setTimeout(() => host.kill(), 1000);
            timer.unref();
        });
        await rm(root, { recursive: true, force: true });
    });
    await Promise.race([ready, new Promise((_, reject) => host.once('exit', () => reject(new Error(`Synthetic bridge failed: ${stderr}`))))]);
    const config = JSON.parse(await readFile(extensionConfig, 'utf8'));
    const blockedOrigin = new WebSocket(`ws://127.0.0.1:${config.port}`, { origin: 'https://other.example' });
    blockedOrigin.on('error', () => {});
    const rejectedOrigin = await new Promise(resolve => blockedOrigin.once('unexpected-response', (_, response) => { resolve(response.statusCode); blockedOrigin.terminate(); }));
    assert.equal(rejectedOrigin, 403);
    const wrongToken = new WebSocket(`ws://127.0.0.1:${config.port}`, { origin: origin.slice(0, -1) });
    wrongToken.on('open', () => wrongToken.send(JSON.stringify({ type: 'COOKIE_MCP_HELLO', origin, token: 'b'.repeat(64) })));
    assert.equal(await new Promise(resolve => wrongToken.once('close', code => resolve(code))), 1008);
    browser = new WebSocket(`ws://127.0.0.1:${config.port}`, { origin: origin.slice(0, -1) });
    const browserReady = new Promise(resolve => browser.on('message', bytes => {
        const message = JSON.parse(bytes.toString());
        if (message.type === 'COOKIE_MCP_READY') resolve();
        if (message.type === 'COOKIE_MCP_EXPORT') browser.send(JSON.stringify({ id: message.id, ok: true, snapshot: { ...sample, domain: message.domain } }));
    }));
    browser.on('open', () => browser.send(JSON.stringify({ type: 'COOKIE_MCP_HELLO', origin, token })));
    await browserReady;
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['cookie_bridge_status', 'export_chrome_cookies']);
    const status = await client.callTool({ name: 'cookie_bridge_status', arguments: {} });
    assert.equal(status.structuredContent.connected, true);
    const output = path.join(root, '中文临时目录');
    const exported = await client.callTool({ name: 'export_chrome_cookies', arguments: { domain: 'https://example.com/editor', output_directory: output } });
    assert.ok(!exported.isError);
    assert.equal(exported.structuredContent.cookie_count, 1);
    assert.equal(path.dirname(exported.structuredContent.absolute_path), output);
    assert.equal(path.basename(exported.structuredContent.absolute_path), exported.structuredContent.filename);
    assert.ok(!JSON.stringify(exported).includes(sample.cookies[0].value));
    const saved = JSON.parse(await readFile(exported.structuredContent.absolute_path, 'utf8'));
    assert.equal(saved.cookies[0].value, sample.cookies[0].value);
    assert.equal(saved.cookies[0].httpOnly, true);
    const invalid = await client.callTool({ name: 'export_chrome_cookies', arguments: { domain: 'example.com', output_directory: 'relative-folder' } });
    assert.equal(invalid.isError, true);
    assert.equal((await readdir(output)).length, 1);
});
