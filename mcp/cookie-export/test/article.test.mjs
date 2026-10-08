import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { createArticleTemp, readArticleChunk, cleanupArticleTemp } from '../article-temp.mjs';

test('native Markdown temp files round trip in bounded chunks and cleanup removes only owned jobs', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yukon-article-test-'));
    const prior = process.env.YUKON_ARTICLE_TEMP_ROOT;
    process.env.YUKON_ARTICLE_TEMP_ROOT = root;
    t.after(async () => { if (prior === undefined) delete process.env.YUKON_ARTICLE_TEMP_ROOT; else process.env.YUKON_ARTICLE_TEMP_ROOT = prior; await rm(root, { recursive: true, force: true }); });
    const id = randomUUID();
    const markdown = '# 测试文档\n' + '保留原文\n'.repeat(40000);
    const bytes = Buffer.from(markdown);
    const created = await createArticleTemp({ jobId: id, name: '测试.md', base64: bytes.toString('base64') });
    assert.equal(created.size, bytes.length);
    const chunks = [];
    let offset = 0;
    for (;;) { const chunk = await readArticleChunk({ jobId: id, offset }); assert.ok(chunk.base64.length < 600000); chunks.push(Buffer.from(chunk.base64, 'base64')); if (chunk.done) break; offset = chunk.nextOffset; }
    assert.equal(Buffer.concat(chunks).toString('utf8'), markdown);
    await cleanupArticleTemp(id);
    assert.deepEqual(await readdir(path.join(root, 'yukonChromeExtension', 'article-import')), []);
    await assert.rejects(createArticleTemp({ jobId: '../outside', name: 'test.md', base64: 'YQ==' }), /ID/);
    await assert.rejects(createArticleTemp({ jobId: randomUUID(), name: 'test.exe', base64: 'YQ==' }), /Markdown/);
    const unowned = randomUUID();
    await createArticleTemp({ jobId: unowned, name: 'test.md', base64: 'YQ==' });
    await unlink(path.join(root, 'yukonChromeExtension', 'article-import', unowned, '.yukon-article-job.json'));
    await assert.rejects(cleanupArticleTemp(unowned));
    assert.equal(await readFile(path.join(root, 'yukonChromeExtension', 'article-import', unowned, 'document.md'), 'utf8'), 'a');
});

async function flowHarness({ failImport = false, failCreate = false, candidates, oldService = false, withImages = false, failImage = false, failRestart = false, remainsOld = false } = {}) {
    let listener;
    const actions = [];
    const saved = [];
    const storage = { feishuJuejinSourceUrl: 'https://my.feishu.cn/wiki/example' };
    const documents = candidates || [{ id: 2, url: storage.feishuJuejinSourceUrl, title: '示例文档', status: 'complete' }];
    const exportedTabs = [];
    const sourceImage = 'https://feishu.cn/file/imageToken123456789';
    const markdown = `\ufeff# 中文标题\r\n\r\n![](${sourceImage})\r\n\r\n[普通链接](${sourceImage})\r\n\r\n![](${sourceImage})\r\n`;
    const references = [markdown.indexOf(sourceImage), markdown.lastIndexOf(sourceImage)].map(start => ({ start, end: start + sourceImage.length, sourceUrl: sourceImage, assetId: 'image-1' }));
    let importedMarkdown;
    let outdated = oldService;
    const bridge = {
        articlePing: async () => { actions.push('ping'); return outdated ? { ready: true } : { ready: true, capabilities: ['article-cli-export', 'article-image-transfer'] }; },
        restartService: async () => { actions.push('restart'); if (failRestart) throw new Error('Synthetic restart failure'); outdated = remainsOld; },
        articleExport: async args => { saved.push(args); actions.push('export'); if (failCreate) throw new Error('Synthetic export failure'); return { name: '测试.md', ...(withImages ? { assets: [{ id: 'image-1', name: 'image-1.png', type: 'image/png', size: 3 }], references } : {}) }; },
        articleRead: async args => { actions.push(args.assetId ? 'imageRead' : 'read'); return { base64: withImages && !args.assetId ? Buffer.from(markdown).toString('base64') : 'IyBmaXh0dXJl', nextOffset: 9, done: true }; },
        articleCleanup: async () => { actions.push('cleanup'); }
    };
    const chrome = {
        storage: { local: { get: async defaults => ({ ...defaults, ...storage }), set: async values => Object.assign(storage, values) } },
        tabs: {
            query: async query => query.active ? [{ id: 1, url: target.url }] : documents,
            update: async id => { actions.push(`activate:${id}`); return { id }; },
            get: async () => ({ status: 'complete' }), sendMessage: async (_, msg) => actions.push(msg.text), remove: async () => actions.push('close')
        },
        scripting: { executeScript: async args => {
            if (args.files) return [];
            const [method] = args.args;
            actions.push(method);
            if (method === 'uploadJuejinImage') return [{ result: failImage ? { ok: false, error: 'Synthetic image failure' } : { ok: true, assetId: 'image-1', url: 'https://p9-juejin.byteimg.com/transferred.png' } }];
            if (method === 'importJuejin') importedMarkdown = Buffer.concat(args.args[1].parts.map(part => Buffer.from(part, 'base64'))).toString('utf8');
            if (method === 'exportFeishu') { exportedTabs.push(args.target.tabId); return [{ result: { ok: true, name: '测试.md', base64: 'IyBmaXh0dXJl' } }]; }
            return [{ result: failImport && method === 'importJuejin' ? { ok: false, error: 'Synthetic import failure' } : { ok: true } }];
        } },
        runtime: { id: 'unit', getURL: name => 'chrome-extension://unit/' + name, onMessage: { addListener: fn => { listener = fn; } } }
    };
    const context = vm.createContext({ chrome, YukonCookieNativeBridge: bridge, URL, TextDecoder, TextEncoder, atob, btoa, crypto: { randomUUID }, setTimeout });
    vm.runInContext(await readFile(new URL('../../../article-import-flow.js', import.meta.url), 'utf8'), context);
    const target = { id: 'unit', frameId: 0, url: 'https://juejin.cn/editor/drafts/new?v=2', tab: { id: 1 } };
    async function run(sender = target, sourceUrl = 'https://my.feishu.cn/wiki/example') {
        return new Promise(resolve => { if (!listener({ type: 'FEISHU_IMPORT_BEGIN', sourceUrl }, sender, resolve)) resolve(undefined); });
    }
    const list = (sender = target) => new Promise(resolve => { if (!listener({ type: 'FEISHU_IMPORT_SOURCES' }, sender, resolve)) resolve(undefined); });
    return { run, list, actions, saved, storage, exportedTabs, imported: () => importedMarkdown, markdown, sourceImage };
}
test('one-click flow exports through Lark CLI, reads the file, imports, then deletes', async () => {
    const h = await flowHarness();
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(result.cleaned, true);
    const stages = h.actions.filter(value => ['checkTarget', 'ping', 'export', 'read', 'importJuejin', 'cleanup'].includes(value));
    assert.deepEqual(stages, ['checkTarget', 'ping', 'export', 'read', 'importJuejin', 'cleanup']);
    assert.equal(h.saved[0].sourceUrl, 'https://my.feishu.cn/wiki/example');
    assert.ok(!h.actions.includes('exportFeishu'));
    assert.ok(!h.actions.includes('activate:2'));
    assert.ok(h.actions.indexOf('activate:1') < h.actions.indexOf('importJuejin'));
    assert.equal(h.actions.at(-1), 'activate:1');
});

test('image transfer replaces only image URLs while preserving BOM, Unicode, CRLF and ordinary links', async () => {
    const h = await flowHarness({ withImages: true });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(result.transferredImages, 1);
    assert.equal(h.actions.filter(action => action === 'uploadJuejinImage').length, 1);
    assert.equal(h.imported(), h.markdown.replaceAll(`![](${h.sourceImage})`, '![](https://p9-juejin.byteimg.com/transferred.png)'));
    assert.ok(h.actions.indexOf('uploadJuejinImage') < h.actions.indexOf('importJuejin'));
    assert.equal(h.actions.filter(action => action === 'cleanup').length, 1);
});

test('failed image transfer stops before importing incomplete Markdown and still cleans all temporary files', async () => {
    const h = await flowHarness({ withImages: true, failImage: true });
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.match(result.error, /图片上传/);
    assert.ok(!h.actions.includes('importJuejin'));
    assert.equal(h.actions.filter(action => action === 'cleanup').length, 1);
});

test('an older service restarts automatically once and import continues after checking the reconnected service', async () => {
    const h = await flowHarness({ oldService: true });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(h.actions.filter(action => action === 'restart').length, 1);
    assert.deepEqual(h.actions.filter(action => ['ping', 'restart', 'export'].includes(action)), ['ping', 'restart', 'ping', 'export']);
    assert.ok(h.actions.some(action => action.includes('正在自动更新本机服务')));
    assert.ok(!h.actions.some(action => action.includes('更多设置')));
    const current = await flowHarness();
    assert.equal((await current.run()).ok, true);
    assert.ok(!current.actions.includes('restart'));
});

test('failed automatic restart or incompatible replacement stops before export without a restart loop or manual navigation prompt', async () => {
    for (const options of [{ oldService: true, failRestart: true }, { oldService: true, remainsOld: true }]) {
        const h = await flowHarness(options);
        const result = await h.run();
        assert.equal(result.ok, false);
        assert.match(result.error, /自动更新/);
        assert.ok(!result.error.includes('更多设置'));
        assert.equal(h.actions.filter(action => action === 'restart').length, 1);
        assert.ok(!h.actions.includes('export'));
        assert.ok(!h.actions.includes('cleanup'));
        assert.deepEqual(h.saved, []);
    }
});
test('failed import and uncertain file creation still request temporary cleanup; unrelated webpages cannot start jobs', async () => {
    for (const options of [{ failImport: true }, { failCreate: true }]) {
        const h = await flowHarness(options);
        assert.equal((await h.run()).ok, false);
        assert.equal(h.actions.filter(action => action === 'cleanup').length, 1);
    }
    const h = await flowHarness();
    assert.equal(await h.run({ id: 'unit', frameId: 0, url: 'https://example.com/', tab: { id: 1 } }), undefined);
    assert.deepEqual(h.actions, []);
});

test('source picker lists documents without exporting and the confirmed choice overrides the remembered source', async () => {
    const h = await flowHarness({ candidates: [
        { id: 2, url: 'https://my.feishu.cn/wiki/example', title: '上次文档', status: 'complete' },
        { id: 3, url: 'https://my.feishu.cn/docx/chosen', title: '这次选择的文档', status: 'complete' },
        { id: 4, url: 'https://my.feishu.cn/docx/chosen#section', title: '重复标签', status: 'complete' }
    ] });
    const listed = await h.list();
    assert.equal(listed.ok, true);
    assert.equal(listed.sources.length, 2);
    assert.equal(listed.lastSourceUrl, 'https://my.feishu.cn/wiki/example');
    assert.deepEqual(h.actions, []);
    assert.equal((await h.run(undefined, 'https://my.feishu.cn/docx/chosen')).ok, true);
    assert.deepEqual(h.exportedTabs, []);
    assert.equal(h.saved[0].sourceUrl, 'https://my.feishu.cn/docx/chosen');
    assert.equal(h.storage.feishuJuejinSourceUrl, 'https://my.feishu.cn/docx/chosen');
});

test('missing or invalid document selection starts no export and unrelated pages cannot list source documents', async () => {
    const h = await flowHarness();
    for (const source of ['', null, 'https://other.example/docx/not-feishu']) assert.equal((await h.run(undefined, source)).ok, false);
    assert.deepEqual(h.actions, []);
    assert.equal(await h.list({ id: 'unit', frameId: 0, url: 'https://other.example/', tab: { id: 1 } }), undefined);
});
