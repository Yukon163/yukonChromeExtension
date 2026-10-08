import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const script = await readFile(new URL('../../../feishu-juejin-button.js', import.meta.url), 'utf8');
const first = 'https://my.feishu.cn/wiki/first';
const second = 'https://my.feishu.cn/docx/second';
const settle = () => new Promise(resolve => setImmediate(resolve));
function picker({ sources = [{ title: '文档一', url: first }, { title: '<img src=x onerror=alert(1)>', url: second }], lastSourceUrl = '', begin } = {}) {
    const dom = new JSDOM('<html><body></body></html>', { url: 'https://juejin.cn/editor/drafts/new?v=2', runScripts: 'outside-only' });
    const win = dom.window;
    const messages = [];
    const timers = new Map();
    let listener;
    win.setInterval = callback => { const id = {}; timers.set(id, callback); return id; };
    win.clearInterval = id => timers.delete(id);
    let root;
    const attach = win.Element.prototype.attachShadow;
    win.Element.prototype.attachShadow = function(options) { root = attach.call(this, options); return root; };
    win.HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); };
    win.HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); this.dispatchEvent(new win.Event('close')); };
    win.chrome = { runtime: {
        sendMessage: async message => {
            messages.push(message);
            if (message.type === 'FEISHU_IMPORT_SOURCES') return { ok: true, sources, lastSourceUrl };
            return begin ? begin(message) : { ok: true, imageLinks: 0 };
        }, onMessage: { addListener: fn => { listener = fn; } }
    } };
    win.eval(script);
    return { dom, win, root, messages, timers, emit: message => listener(message), tick: () => { for (const callback of timers.values()) callback(); } };
}

test('Juejin button opens selection first, cancellation exports nothing and confirmation sends only the chosen document', async t => {
    const h = picker();
    t.after(() => h.dom.window.close());
    h.root.querySelector('[data-action="choose"]').click();
    await settle();
    assert.equal(h.root.querySelector('dialog').open, true);
    assert.deepEqual(h.messages.map(message => message.type), ['FEISHU_IMPORT_SOURCES']);
    assert.equal(h.root.querySelector('select').options.length, 3);
    assert.equal(h.root.querySelector('select').options[2].textContent, '<img src=x onerror=alert(1)>');
    assert.equal(h.root.querySelector('img'), null);
    h.root.querySelector('[data-action="cancel"]').click();
    assert.equal(h.root.querySelector('dialog').open, false);
    assert.equal(h.messages.some(message => message.type === 'FEISHU_IMPORT_BEGIN'), false);
    h.root.querySelector('[data-action="choose"]').click();
    await settle();
    const select = h.root.querySelector('select');
    select.value = second;
    select.dispatchEvent(new h.win.Event('change'));
    assert.equal(h.root.querySelector('[type="submit"]').disabled, false);
    h.root.querySelector('form').dispatchEvent(new h.win.Event('submit', { cancelable: true }));
    await settle();
    const starts = h.messages.filter(message => message.type === 'FEISHU_IMPORT_BEGIN');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].sourceUrl, second);
    assert.equal(h.root.querySelector('dialog').open, false);
    assert.equal(h.root.querySelector('.import-status').textContent, '导入完成，临时文件已删除。');
});

test('progress shows real stages and elapsed time, ignores stale updates and stops its timer on completion', async t => {
    let resolveImport;
    const h = picker({ sources: [{ title: '测试', url: first }], begin: () => new Promise(resolve => { resolveImport = resolve; }) });
    t.after(() => h.dom.window.close());
    let now = 1000;
    h.win.Date.now = () => now;
    h.root.querySelector('[data-action="choose"]').click();
    await settle();
    h.root.querySelector('form').dispatchEvent(new h.win.Event('submit', { cancelable: true }));
    await settle();
    assert.equal(h.root.querySelector('.import-progress').hidden, false);
    assert.equal(h.timers.size, 1);
    h.emit({ type: 'FEISHU_IMPORT_PROGRESS', step: 2, jobId: 'current', text: '等待飞书响应' });
    now += 15000;
    h.tick();
    assert.match(h.root.querySelector('.import-time').textContent, /15 秒.*2\/4/);
    assert.equal(h.root.querySelectorAll('.steps li')[1].className, 'active');
    h.emit({ type: 'FEISHU_IMPORT_PROGRESS', step: 3, jobId: 'unrelated', text: '其他任务' });
    assert.equal(h.root.querySelector('.import-status').textContent, '等待飞书响应');
    h.emit({ type: 'FEISHU_IMPORT_PROGRESS', step: 3, jobId: 'current', text: '导入掘金' });
    h.emit({ type: 'FEISHU_IMPORT_PROGRESS', step: 2, jobId: 'current', text: '迟到的导出回调' });
    assert.equal(h.root.querySelector('.import-status').textContent, '导入掘金');
    resolveImport({ ok: true });
    await settle();
    assert.equal(h.timers.size, 0);
    assert.ok([...h.root.querySelectorAll('.steps li')].every(node => node.className === 'done'));
    h.emit({ type: 'FEISHU_IMPORT_PROGRESS', step: 4, jobId: 'current', text: '迟到的清理回调' });
    assert.equal(h.root.querySelector('.import-status').textContent, '导入完成，临时文件已删除。');
});

test('picker accepts a pasted cloud-document URL when no document tab is open and rejects unrelated links', async t => {
    const h = picker({ sources: [] });
    t.after(() => h.dom.window.close());
    h.root.querySelector('[data-action="choose"]').click();
    await settle();
    const input = h.root.querySelector('input');
    input.value = 'https://other.example/docx/not-feishu';
    input.dispatchEvent(new h.win.Event('input'));
    assert.equal(h.root.querySelector('[type="submit"]').disabled, true);
    input.value = first;
    input.dispatchEvent(new h.win.Event('input'));
    assert.equal(h.root.querySelector('[type="submit"]').disabled, false);
    h.root.querySelector('form').dispatchEvent(new h.win.Event('submit', { cancelable: true }));
    await settle();
    assert.equal(h.messages.find(message => message.type === 'FEISHU_IMPORT_BEGIN').sourceUrl, first);
});
