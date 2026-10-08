import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBrowserSession } from '../browser-session.mjs';
import { handleArticleTemp } from '../article-temp.mjs';

test('authenticated browser session carries Markdown temp create/read/delete without affecting Cookie protocol', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yukon-article-bridge-test-'));
    const oldBridge = process.env.YUKON_COOKIE_BRIDGE_HOME;
    const oldTemp = process.env.YUKON_ARTICLE_TEMP_ROOT;
    process.env.YUKON_COOKIE_BRIDGE_HOME = root;
    process.env.YUKON_ARTICLE_TEMP_ROOT = root;
    const replies = [];
    const session = await createBrowserSession(message => replies.push(message), 'chrome-extension://unit/');
    t.after(async () => {
        await session.close();
        if (oldBridge === undefined) delete process.env.YUKON_COOKIE_BRIDGE_HOME; else process.env.YUKON_COOKIE_BRIDGE_HOME = oldBridge;
        if (oldTemp === undefined) delete process.env.YUKON_ARTICLE_TEMP_ROOT; else process.env.YUKON_ARTICLE_TEMP_ROOT = oldTemp;
        await rm(root, { recursive: true, force: true });
    });
    const jobId = randomUUID();
    const markdown = '# 桥接测试\n';
    await session.receive({ type: 'ARTICLE_TEMP_PING', id: 'ping' });
    assert.equal(replies.at(-1).result.protocolVersion, 3);
    assert.ok(replies.at(-1).result.capabilities.includes('article-cli-export'));
    await session.receive({ type: 'ARTICLE_TEMP_CREATE', id: 'create', jobId, name: '测试.md', base64: Buffer.from(markdown).toString('base64') });
    assert.equal(replies.at(-1).ok, true);
    assert.equal(replies.at(-1).result.name, '测试.md');
    await session.receive({ type: 'ARTICLE_TEMP_READ', id: 'read', jobId, offset: 0 });
    assert.equal(Buffer.from(replies.at(-1).result.base64, 'base64').toString('utf8'), markdown);
    await session.receive({ type: 'ARTICLE_TEMP_CLEANUP', id: 'delete', jobId });
    assert.equal(replies.at(-1).result.deleted, true);
    assert.deepEqual(await readdir(path.join(root, 'yukonChromeExtension', 'article-import')), []);
    await session.receive({ type: 'ARTICLE_TEMP_READ', id: 'bad', jobId: '../outside', offset: 0 });
    assert.equal(replies.at(-1).ok, false);
    await session.receive({ type: 'ARTICLE_TEMP_EXPORT', id: 'bad-export', jobId: randomUUID(), sourceUrl: 'https://other.example/wiki/test' });
    assert.equal(replies.at(-1).id, 'bad-export');
    assert.equal(replies.at(-1).ok, false);
    assert.match(replies.at(-1).error, /飞书云文档/);
    assert.deepEqual(await readdir(path.join(root, 'yukonChromeExtension', 'article-import')), []);
});

test('cleanup queued while creation is running waits for writes and leaves no Markdown residue', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yukon-article-queue-test-'));
    const old = process.env.YUKON_ARTICLE_TEMP_ROOT;
    process.env.YUKON_ARTICLE_TEMP_ROOT = root;
    t.after(async () => { if (old === undefined) delete process.env.YUKON_ARTICLE_TEMP_ROOT; else process.env.YUKON_ARTICLE_TEMP_ROOT = old; await rm(root, { recursive: true, force: true }); });
    const jobId = randomUUID();
    const creation = handleArticleTemp({ type: 'ARTICLE_TEMP_CREATE', jobId, name: 'test.md', base64: Buffer.alloc(512 * 1024, 97).toString('base64') });
    const deletion = handleArticleTemp({ type: 'ARTICLE_TEMP_CLEANUP', jobId });
    await Promise.all([creation, deletion]);
    assert.deepEqual(await readdir(path.join(root, 'yukonChromeExtension', 'article-import')), []);
});
