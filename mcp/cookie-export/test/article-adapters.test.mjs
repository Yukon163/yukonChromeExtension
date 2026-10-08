import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const code = await readFile(new URL('../../../article-page-adapters.js', import.meta.url), 'utf8');
function fixture(html, url) {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    win.Element.prototype.getClientRects = function() { return this.style.display === 'none' ? [] : [{ top: 0, left: 900 }]; };
    win.Element.prototype.getBoundingClientRect = () => ({ top: 0, left: 900 });
    return dom;
}

function juejinFixture(native = false) {
    const inputs = native ? '<div class="coverselector_container"><input id="cover" type="file"></div><div class="article-importer"><input id="file" type="file"></div>' : '<input id="file" type="file" accept=".md">';
    const dom = fixture('<input placeholder="请输入文章标题"><textarea id="editor"></textarea>' + inputs, 'https://juejin.cn/editor/drafts/new?v=2');
    const win = dom.window;
    const fileLists = new WeakMap();
    Object.defineProperty(win.HTMLInputElement.prototype, 'files', { configurable: true, get() { return fileLists.get(this) || []; }, set(value) { fileLists.set(this, value); } });
    win.DataTransfer = class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } };
    win.File.prototype.text = function() { return new Promise((resolve, reject) => { const reader = new win.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(this); }); };
    win.document.getElementById('file').onchange = event => {
        const reader = new win.FileReader();
        reader.onload = () => { win.document.getElementById('editor').value = reader.result; };
        reader.readAsText(event.target.files[0]);
    };
    win.eval(code);
    return dom;
}

test('Juejin adapter uses its native file change reader, preserves UTF-8 and confirms editor content', async t => {
    const dom = juejinFixture();
    t.after(() => dom.window.close());
    const win = dom.window;
    const originalReader = win.FileReader.prototype.readAsText;
    const originalText = win.File.prototype.text;
    const markdown = '# 标题\n\n![图片](https://my.feishu.cn/drive/image/test)\n';
    const result = await win.__yukonArticleAdapters.importJuejin({ name: '标题.md', parts: [Buffer.from(markdown).toString('base64')], timeoutMs: 2000 });
    assert.equal(result.ok, true);
    assert.equal(result.imageLinks, 1);
    assert.equal(win.document.getElementById('editor').value, markdown);
    assert.equal(win.FileReader.prototype.readAsText, originalReader);
    assert.equal(win.File.prototype.text, originalText);
});

test('image transfer delegates to Juejin native uploader with the original binary and does not edit the draft', async t => {
    const dom = juejinFixture();
    t.after(() => dom.window.close());
    const win = dom.window;
    const bytemd = win.document.createElement('div');
    bytemd.className = 'bytemd';
    win.document.body.append(bytemd);
    const bytes = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
    let received;
    bytemd.__vue__ = { $props: { uploadImages: async files => {
        received = files[0];
        const contents = await new Promise(resolve => { const reader = new win.FileReader(); reader.onload = () => resolve(new Uint8Array(reader.result)); reader.readAsArrayBuffer(received); });
        assert.deepEqual(Buffer.from(contents), bytes);
        return [{ url: 'https://p9-juejin.byteimg.com/image-native.png' }];
    } } };
    const result = await win.__yukonArticleAdapters.uploadJuejinImage({ asset: { id: 'image-1', name: 'image-1.png', type: 'image/png' }, parts: [bytes.toString('base64')], timeoutMs: 2000 });
    assert.equal(result.ok, true);
    assert.equal(result.assetId, 'image-1');
    assert.equal(received.type, 'image/png');
    assert.equal(win.document.getElementById('editor').value, '');
});

test('image upload refuses existing draft content before contacting the uploader', async t => {
    const dom = juejinFixture();
    t.after(() => dom.window.close());
    const win = dom.window;
    win.document.getElementById('editor').value = '已有正文';
    const result = await win.__yukonArticleAdapters.uploadJuejinImage({ asset: { id: 'image-1', type: 'image/png' }, parts: [] });
    assert.equal(result.ok, false);
    assert.match(result.error, /已有正文/);
});

test('Juejin adapter refuses existing draft text and does not dispatch a file change', async t => {
    const dom = juejinFixture();
    t.after(() => dom.window.close());
    const win = dom.window;
    win.document.getElementById('editor').value = '用户已有正文';
    let changed = false;
    win.document.getElementById('file').addEventListener('change', () => { changed = true; });
    const result = await win.__yukonArticleAdapters.importJuejin({ name: 'test.md', parts: ['YQ=='], timeoutMs: 2000 });
    assert.equal(result.ok, false);
    assert.match(result.error, /已有正文/);
    assert.equal(changed, false);
    assert.equal(win.document.getElementById('editor').value, '用户已有正文');
});

test('Juejin native importer with an empty accept attribute is selected without touching the cover upload', async t => {
    const dom = juejinFixture(true);
    t.after(() => dom.window.close());
    const win = dom.window;
    let coverChanged = false;
    win.document.getElementById('cover').addEventListener('change', () => { coverChanged = true; });
    const markdown = '# 原生本地上传\n\n正文\n';
    const result = await win.__yukonArticleAdapters.importJuejin({ name: 'test.md', parts: [Buffer.from(markdown).toString('base64')], timeoutMs: 2000 });
    assert.equal(result.ok, true);
    assert.equal(coverChanged, false);
    assert.equal(win.document.getElementById('editor').value, markdown);
});
