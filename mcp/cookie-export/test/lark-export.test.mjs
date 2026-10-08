import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { exportLarkMarkdown } from '../lark-export.mjs';
import { exportArticleTemp, readArticleChunk, cleanupArticleTemp } from '../article-temp.mjs';

const sourceUrl = 'https://my.feishu.cn/wiki/test-document?fromScene=spaceOverview';
const command = async () => ({ executable: 'node', prefix: ['cli-runner.js'] });
async function directory(t) {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'yukon-lark-test-'));
    t.after(() => rm(folder, { recursive: true, force: true }));
    return folder;
}
function runner(bytes, overrides = {}) {
    return async (_, args, options) => {
        await writeFile(path.join(options.cwd, 'document.md'), bytes);
        return { stdout: JSON.stringify({ ok: true, identity: 'user', data: { saved_path: path.join(options.cwd, 'document.md') }, ...overrides }) };
    };
}
test('CLI exports a Wiki as the user with relative output paths and preserves Markdown bytes', async t => {
    const folder = await directory(t);
    const bytes = Buffer.from('# 标题\r\n\r\n| 表格 | 代码 |\r\n| --- | --- |\r\n| 原文 | `a` |\r\n');
    const execute = runner(bytes);
    const phases = [];
    const result = await exportLarkMarkdown({ sourceUrl, folder }, {
        resolveCommand: command,
        onProgress: phase => phases.push(phase),
        execute: async (executable, args, options) => {
            assert.equal(executable, 'node');
            assert.deepEqual(args, ['cli-runner.js', 'drive', '+export', '--url', sourceUrl, '--file-extension', 'markdown', '--as', 'user', '--output-dir', '.', '--file-name', 'document.md', '--format', 'json']);
            assert.equal(options.cwd, folder);
            assert.equal(options.windowsHide, true);
            assert.equal(options.timeout, 90000);
            return execute(executable, args, options);
        }
    });
    assert.equal(result.size, bytes.length);
    assert.deepEqual(await readFile(path.join(folder, 'document.md')), bytes);
    assert.deepEqual(phases, ['resolving', 'exporting', 'validating', 'ready']);
});
test('CLI rejects invalid source URLs before launching any command', async t => {
    const folder = await directory(t);
    let launched = false;
    for (const url of ['not a url', 'http://my.feishu.cn/wiki/test', 'https://my.feishu.cn.evil.example/wiki/test', 'https://user:password@my.feishu.cn/docx/test', 'https://my.feishu.cn/sheets/test']) {
        await assert.rejects(exportLarkMarkdown({ sourceUrl: url, folder }, { resolveCommand: async () => { launched = true; return command(); } }));
    }
    assert.equal(launched, false);
});
test('CLI rejects wrong identities, mismatched paths, empty files, ZIP and error HTML', async t => {
    const folder = await directory(t);
    const cases = [
        [Buffer.from('# test'), { identity: 'bot' }, /用户身份/],
        [Buffer.from('# test'), { data: { saved_path: folder } }, /路径不匹配/],
        [Buffer.alloc(0), {}, /为空/],
        [Buffer.from('PK\u0003\u0004'), {}, /压缩包/],
        [Buffer.from('\ufeff<!doctype html><html>login</html>'), {}, /HTML/]
    ];
    for (const [bytes, overrides, message] of cases) {
        await assert.rejects(exportLarkMarkdown({ sourceUrl, folder }, { resolveCommand: command, execute: runner(bytes, overrides) }), message);
    }
});
test('CLI errors omit raw output and translate missing authorization', async t => {
    const folder = await directory(t);
    await assert.rejects(exportLarkMarkdown({ sourceUrl, folder }, {
        resolveCommand: command, execute: async () => { throw { stderr: JSON.stringify({ error: { type: 'authorization', subtype: 'missing_scope', message: 'private diagnostic' } }) }; }
    }), /用户授权/);
    await assert.rejects(exportLarkMarkdown({ sourceUrl, folder }, {
        resolveCommand: command, execute: async () => ({ stdout: 'private malformed output' })
    }), /有效的导出结果/);
    await assert.rejects(exportLarkMarkdown({ sourceUrl, folder }, {
        resolveCommand: command, execute: async () => { throw { killed: true, stderr: 'private output' }; }
    }), /超过 90 秒/);
});
test('CLI temp job cleans failed exports and successful jobs read unchanged bytes before cleanup', async t => {
    const root = await directory(t);
    const prior = process.env.YUKON_ARTICLE_TEMP_ROOT;
    process.env.YUKON_ARTICLE_TEMP_ROOT = root;
    t.after(() => { if (prior === undefined) delete process.env.YUKON_ARTICLE_TEMP_ROOT; else process.env.YUKON_ARTICLE_TEMP_ROOT = prior; });
    const parent = path.join(root, 'yukonChromeExtension', 'article-import');
    const failedId = randomUUID();
    await assert.rejects(exportArticleTemp({ jobId: failedId, sourceUrl }, {
        resolveCommand: command, execute: async (_, args, options) => { await writeFile(path.join(options.cwd, 'partial.md'), 'partial'); throw new Error('synthetic'); }
    }), /导出失败/);
    assert.deepEqual(await readdir(parent), []);
    const bytes = Buffer.from('# 测试\n\n正文保持原样\n');
    const jobId = randomUUID();
    const result = await exportArticleTemp({ jobId, sourceUrl, name: '测试文档 - 飞书云文档' }, { resolveCommand: command, execute: runner(bytes) });
    assert.equal(result.name, '测试文档.md');
    assert.equal(result.size, bytes.length);
    const chunk = await readArticleChunk({ jobId });
    assert.equal(chunk.done, true);
    assert.deepEqual(Buffer.from(chunk.base64, 'base64'), bytes);
    await cleanupArticleTemp(jobId);
    assert.deepEqual(await readdir(parent), []);
});
