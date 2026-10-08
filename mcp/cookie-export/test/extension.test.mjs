import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

function event() {
    const listeners = new Set();
    return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
        emit: (...args) => { for (const fn of listeners) fn(...args); }, listeners };
}

async function harness(cookies = []) {
    const storage = {};
    const downloads = [];
    const blobs = new Map();
    const debounce = new Map();
    const changed = event();
    const messages = event();
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    let failDownload = false;
    const chrome = {
        extension: { inIncognitoContext: false },
        storage: {
            local: {
                get: async defaults => ({ ...structuredClone(defaults), ...structuredClone(storage) }),
                set: async values => {
                    const changes = {};
                    for (const [key, value] of Object.entries(values)) {
                        changes[key] = { oldValue: storage[key], newValue: structuredClone(value) };
                        storage[key] = structuredClone(value);
                    }
                    changed.emit(changes, 'local');
                }
            }, onChanged: changed
        },
        cookies: { getAll: async () => structuredClone(cookies), onChanged: event() },
        offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
        runtime: {
            id: extensionId, getURL: resource => `chrome-extension://${extensionId}/${resource}`,
            getContexts: async () => [], onMessage: messages, onStartup: event(), onInstalled: event(),
            sendMessage: async message => {
                if (message.type === 'CREATE_COOKIE_EXPORT_BLOB') {
                    const url = `blob:chrome-extension://${extensionId}/${blobs.size}`;
                    blobs.set(url, message.json);
                    return { url };
                }
                blobs.delete(message.url);
                return { ok: true };
            }
        },
        downloads: {
            onChanged: event(),
            download: async options => {
                const snapshot = JSON.parse(blobs.get(options.url));
                const id = downloads.length + 1;
                downloads.push({ id, options, snapshot, state: failDownload ? 'interrupted' : 'complete',
                    filename: `C:\\Downloads\\${options.filename.replaceAll('/', '\\')}` });
                return id;
            },
            search: async ({ id }) => downloads.filter(item => item.id === id),
            show: async () => {}, showDefaultFolder: () => {}
        }
    };
    const context = vm.createContext({ chrome, URL, TextEncoder, Uint8Array, crypto: webcrypto,
        YukonCookieNativeBridge: {
            save: async snapshot => {
                if (failDownload) throw new Error('Synthetic write failure');
                const saved = { snapshot: structuredClone(snapshot), filename: `C:\\Temp\\${snapshot.domain}.cookies.json` };
                downloads.push(saved);
                return { absolute_path: saved.filename, cookie_count: snapshot.cookies.length };
            }, showFile: async () => {}, openFolder: async () => {}
        },
        setTimeout: (fn, delay) => {
            if (delay !== 2000) return setTimeout(fn, delay);
            const id = {};
            debounce.set(id, fn);
            return id;
        },
        clearTimeout: id => { if (!debounce.delete(id)) clearTimeout(id); }
    });
    vm.runInContext(await readFile(new URL('../../../cookie-export.js', import.meta.url), 'utf8'), context);
    async function request(type, extra = {}, sender = { id: extensionId, url: chrome.runtime.getURL('options.html') }) {
        return new Promise(resolve => {
            const listener = [...messages.listeners][0];
            if (!listener({ type, ...extra }, sender, resolve)) resolve(undefined);
        });
    }
    const flush = async () => {
        await new Promise(resolve => setImmediate(resolve));
        for (const fn of [...debounce.values()]) fn();
        debounce.clear();
    };
    return { context, chrome, request, storage, downloads, blobs, debounce, flush,
        setCookies: value => { cookies = value; }, failDownload: () => { failDownload = true; } };
}

async function until(check) {
    for (let attempt = 0; attempt < 1000; attempt++) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error('Test export did not settle');
}

const fixture = [
    { name: 'sessionid', value: 'fixture-login', domain: '.example.com', path: '/', hostOnly: false, httpOnly: true, secure: true },
    { name: 'sessionid', value: 'fixture-path', domain: 'api.example.com', path: '/editor', hostOnly: true, httpOnly: true },
    { name: 'other', value: 'fixture-unrelated', domain: 'other.com', path: '/', hostOnly: true },
    { name: 'lookalike', value: 'fixture-lookalike', domain: 'evil-example.com', path: '/', hostOnly: false },
    { name: 'parent-host-only', value: 'fixture-parent', domain: 'example.com', path: '/', hostOnly: true }
];

test('site export includes shared parent and distinct paths, without unrelated hosts or exposed values', async () => {
    const h = await harness(fixture);
    const result = await h.request('COOKIE_EXPORT_NOW', { domain: 'https://API.EXAMPLE.COM/editor' });
    assert.equal(result.ok, true);
    assert.equal(result.file.count, 2);
    assert.deepEqual(h.downloads[0].snapshot.cookies.map(cookie => cookie.value).sort(), ['fixture-login', 'fixture-path']);
    assert.equal(h.downloads[0].snapshot.cookies.find(cookie => cookie.value === 'fixture-login').httpOnly, true);
    assert.equal(h.downloads[0].filename, 'C:\\Temp\\api.example.com.cookies.json');
    assert.equal(h.blobs.size, 0);
    assert.ok(!JSON.stringify(result).includes('fixture-login'));
    assert.ok(!JSON.stringify(h.storage).includes('fixture-login'));
});

test('web content scripts cannot request export or enable automatic export', async () => {
    const h = await harness(fixture);
    const response = await h.request('COOKIE_EXPORT_NOW', { domain: 'example.com' }, {
        id: h.chrome.runtime.id, url: 'https://example.com/', tab: { id: 1 }
    });
    assert.equal(response, undefined);
    assert.equal(h.downloads.length, 0);
});

test('automatic export tracks selected sites, debounces changes, clears logout data and stops when disabled', async () => {
    const h = await harness(fixture);
    await h.request('COOKIE_EXPORT_SET_AUTO', { domain: 'api.example.com', enabled: true });
    await until(() => h.storage.cookieExportFiles?.['api.example.com']);
    assert.equal(h.downloads.length, 1);
    h.chrome.cookies.onChanged.emit({ cookie: fixture[2] });
    await h.flush();
    assert.equal(h.downloads.length, 1);
    h.setCookies([]);
    h.chrome.cookies.onChanged.emit({ cookie: fixture[0], removed: true });
    h.chrome.cookies.onChanged.emit({ cookie: fixture[1], removed: true });
    await h.flush();
    await until(() => h.storage.cookieExportFiles?.['api.example.com']?.count === 0);
    assert.equal(h.downloads.length, 2);
    assert.deepEqual(h.downloads[1].snapshot.cookies, []);
    await h.request('COOKIE_EXPORT_SET_AUTO', { domain: 'api.example.com', enabled: false });
    h.chrome.cookies.onChanged.emit({ cookie: fixture[0] });
    await h.flush();
    assert.equal(h.downloads.length, 2);
});

test('failed native saves are reported as failures and do not publish a saved file', async () => {
    const h = await harness(fixture);
    h.failDownload();
    const response = await h.request('COOKIE_EXPORT_NOW', { domain: 'example.com' });
    assert.equal(response.ok, false);
    assert.equal(h.storage.cookieExportFiles?.['example.com'], undefined);
    assert.equal(h.storage.cookieExportStatuses['example.com'].phase, 'error');
    assert.equal(h.blobs.size, 0);
});

test('local bridge authenticates, reports disconnection and rejects website control messages', async () => {
    const messages = event();
    const storage = {};
    const instances = [];
    const timers = new Map();
    class FakeSocket {
        static OPEN = 1;
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.sent = [];
            instances.push(this);
            queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
        }
        send(text) {
            const message = JSON.parse(text);
            this.sent.push(message);
            if (message.type === 'COOKIE_MCP_HELLO') queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: 'COOKIE_MCP_READY' }) }));
        }
        close() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
    }
    const chrome = {
        extension: { inIncognitoContext: false },
        storage: { local: { set: async values => Object.assign(storage, values) } },
        runtime: { id: 'unit', getURL: path => `chrome-extension://unit/${path}`, onMessage: messages }
    };
    const context = vm.createContext({ chrome, crypto: webcrypto, WebSocket: FakeSocket,
        fetch: async () => ({ json: async () => ({ port: 12345, token: 'a'.repeat(64) }) }),
        setTimeout: fn => { const id = {}; timers.set(id, fn); return id; },
        clearTimeout: id => timers.delete(id), YukonCookieExporter: {}
    });
    vm.runInContext(await readFile(new URL('../../../cookie-local-bridge.js', import.meta.url), 'utf8'), context);
    await until(() => storage.cookieMcpBridgeConnected);
    assert.equal(instances[0].url, 'ws://127.0.0.1:12345');
    assert.equal(instances[0].sent[0].origin, 'chrome-extension://unit/');
    assert.equal(instances[0].sent[0].token, 'a'.repeat(64));
    const listener = [...messages.listeners][0];
    listener({ type: 'COOKIE_MCP_CONNECT' }, { id: 'unit', url: 'https://example.com', tab: { id: 1 } }, () => {});
    assert.equal(instances.length, 1);
    instances[0].close();
    assert.equal(storage.cookieMcpBridgeConnected, false);
    assert.ok(storage.cookieMcpBridgeError.includes('未连接'));
    assert.ok(!JSON.stringify(storage).includes('a'.repeat(64)));
});
