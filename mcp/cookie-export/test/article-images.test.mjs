import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { findLarkImages } from '../article-images.mjs';
import { exportArticleTemp, readArticleChunk, cleanupArticleTemp } from '../article-temp.mjs';

const sourceUrl = 'https://my.feishu.cn/wiki/test-document';
const imageUrl = 'https://feishu.cn/file/assetToken123456789';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
test('image discovery preserves Unicode offsets, deduplicates resources and skips code and ordinary links', () => {
    const markdown = `中文\r\n![描述](${imageUrl})\r\n![](<${imageUrl}> "标题")\n[普通链接](${imageUrl})\n\`${'![](' + imageUrl + ')'}\`\n\n\`\`\`md\n![](${imageUrl})\n\`\`\`\n`;
    const found = findLarkImages(markdown);
    assert.equal(found.resources.length, 1);
    assert.equal(found.references.length, 2);
    for (const ref of found.references) assert.equal(markdown.slice(ref.start, ref.end), imageUrl);
    assert.ok(found.references.every(ref => ref.assetId === 'image-1'));
    assert.equal(findLarkImages(`\\![](${imageUrl})`).references.length, 0);
    assert.deepEqual(findLarkImages(`![](https://feishu.cn.evil.example/file/notTrusted123)`), { resources: [], references: [] });
    assert.throws(() => findLarkImages('![](https://feishu.cn/unknown/path)'), /无法识别/);
});

async function temporaryRoot(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yukon-images-test-'));
    const prior = process.env.YUKON_ARTICLE_TEMP_ROOT;
    process.env.YUKON_ARTICLE_TEMP_ROOT = root;
    t.after(async () => { if (prior === undefined) delete process.env.YUKON_ARTICLE_TEMP_ROOT; else process.env.YUKON_ARTICLE_TEMP_ROOT = prior; await rm(root, { recursive: true, force: true }); });
    return root;
}
function fakeCli(markdown, { badImage = false, failDownload = false } = {}) {
    const calls = [];
    return { calls, resolveCommand: async () => ({ executable: 'node', prefix: [] }), execute: async (_, args, options) => {
        calls.push(args);
        if (args[0] === 'drive') {
            await writeFile(path.join(options.cwd, 'document.md'), markdown);
            return { stdout: JSON.stringify({ ok: true, identity: 'user', data: { saved_path: path.join(options.cwd, 'document.md') } }) };
        }
        if (failDownload) throw { stderr: 'private diagnostic' };
        const filename = path.resolve(options.cwd, args[args.indexOf('--output') + 1] + '.png');
        await writeFile(filename, badImage ? '<html>login</html>' : png);
        return { stdout: JSON.stringify({ ok: true, identity: 'user', data: { saved_path: filename, content_type: 'image/png' } }) };
    } };
}
test('official CLI downloads each unique image once, owned reads preserve bytes, and cleanup removes Markdown and assets', async t => {
    const root = await temporaryRoot(t);
    const markdown = `# 原文\r\n\r\n![](${imageUrl})\r\n\r\n![](${imageUrl})\r\n`;
    const options = fakeCli(markdown);
    const progress = [];
    const jobId = randomUUID();
    const result = await exportArticleTemp({ jobId, sourceUrl }, { ...options, onProgress: value => progress.push(value) });
    assert.equal(result.assets.length, 1);
    assert.equal(result.references.length, 2);
    assert.equal(result.assets[0].type, 'image/png');
    assert.equal(options.calls.filter(args => args[0] === 'docs').length, 1);
    const download = options.calls.find(args => args[0] === 'docs');
    assert.deepEqual(download.slice(0, 2), ['docs', '+media-download']);
    assert.equal(download[download.indexOf('--as') + 1], 'user');
    assert.equal(download[download.indexOf('--output') + 1], './assets/image-1');
    const asset = await readArticleChunk({ jobId, assetId: 'image-1' });
    assert.deepEqual(Buffer.from(asset.base64, 'base64'), png);
    const body = await readArticleChunk({ jobId });
    assert.equal(Buffer.from(body.base64, 'base64').toString(), markdown);
    assert.ok(progress.some(value => value.phase === 'images' && value.current === 1 && value.total === 1));
    await assert.rejects(readArticleChunk({ jobId, assetId: '../outside' }), /图片 ID/);
    await assert.rejects(readArticleChunk({ jobId, assetId: 'image-2' }), /归属/);
    await cleanupArticleTemp(jobId);
    assert.deepEqual(await readdir(path.join(root, 'yukonChromeExtension', 'article-import')), []);
});
test('failed downloads and disguised HTML stop export and leave no partial files', async t => {
    const root = await temporaryRoot(t);
    for (const failure of [{ badImage: true }, { failDownload: true }]) {
        const options = fakeCli(`![](${imageUrl})`, failure);
        await assert.rejects(exportArticleTemp({ jobId: randomUUID(), sourceUrl }, options), /图片.*(?:失败|格式)/);
        assert.deepEqual(await readdir(path.join(root, 'yukonChromeExtension', 'article-import')), []);
    }
});
