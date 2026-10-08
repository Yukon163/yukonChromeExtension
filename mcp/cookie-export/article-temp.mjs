import { mkdir, readFile, writeFile, realpath, readdir, lstat, rm, open, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exportLarkMarkdown, validateDocumentUrl } from './lark-export.mjs';
import { downloadArticleImages } from './article-images.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const active = new Set();
const operations = new Map();
const rootPath = () => path.join(process.env.YUKON_ARTICLE_TEMP_ROOT || os.tmpdir(), 'yukonChromeExtension', 'article-import');
const MARKER = '.yukon-article-job.json';
function jobPath(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('临时任务 ID 无效');
    return path.join(rootPath(), id);
}
async function ownedJob(id) {
    const folder = jobPath(id);
    if ((await lstat(folder)).isSymbolicLink()) throw new Error('拒绝使用链接目录');
    const [root, resolved] = await Promise.all([realpath(rootPath()), realpath(folder)]);
    if (path.dirname(resolved) !== root) throw new Error('临时目录越界');
    const marker = JSON.parse(await readFile(path.join(resolved, MARKER), 'utf8'));
    if (marker.kind !== 'yukon-article-import' || marker.id !== id || marker.filename !== 'document.md') throw new Error('临时文件归属无效');
    return { folder: resolved, marker, filename: path.join(resolved, marker.filename) };
}
export async function createArticleTemp({ jobId, name, base64 }) {
    if (typeof base64 !== 'string' || base64.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('导出文件无效或超过 16 MB');
    if (typeof name !== 'string' || !/\.(?:md|markdown)$/i.test(name)) throw new Error('飞书没有返回 Markdown 文件');
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > 16 * 1024 * 1024 || bytes.toString('base64') !== base64) throw new Error('导出文件为空或编码无效');
    await mkdir(rootPath(), { recursive: true, mode: 0o700 });
    const folder = jobPath(jobId);
    await mkdir(folder, { mode: 0o700 });
    active.add(jobId);
    try {
        await writeFile(path.join(folder, MARKER), JSON.stringify({ kind: 'yukon-article-import', id: jobId, filename: 'document.md', createdAt: Date.now() }), { flag: 'wx', mode: 0o600 });
        await writeFile(path.join(folder, 'document.md'), bytes, { flag: 'wx', mode: 0o600 });
        return { jobId, name: path.basename(name.replace(/\\/g, '/')), size: bytes.length };
    } catch (error) { await cleanupArticleTemp(jobId).catch(() => {}); throw error; }
}
export async function exportArticleTemp({ jobId, sourceUrl, name }, options = {}) {
    validateDocumentUrl(sourceUrl);
    await mkdir(rootPath(), { recursive: true, mode: 0o700 });
    const folder = jobPath(jobId);
    await mkdir(folder, { mode: 0o700 });
    active.add(jobId);
    try {
        await writeFile(path.join(folder, MARKER), JSON.stringify({ kind: 'yukon-article-import', id: jobId, filename: 'document.md', createdAt: Date.now() }), { flag: 'wx', mode: 0o600 });
        const exported = await exportLarkMarkdown({ sourceUrl, folder }, options);
        const images = await downloadArticleImages(folder, options);
        const nextMarker = path.join(folder, '.yukon-article-job.next.json');
        await writeFile(nextMarker, JSON.stringify({ kind: 'yukon-article-import', id: jobId, filename: 'document.md', createdAt: Date.now(), assets: images.assets }), { flag: 'wx', mode: 0o600 });
        await ownedJob(jobId);
        await rename(nextMarker, path.join(folder, MARKER));
        const displayName = typeof name === 'string' ? name.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '').replace(/[\\/\u0000-\u001f]/g, '_').replace(/\s*[-|]\s*(飞书云文档|飞书|Feishu|Lark).*$/i, '').slice(0, 180) : '';
        return { jobId, name: displayName ? `${displayName}.md` : exported.name, size: exported.size, ...images };
    } catch (error) { await cleanupArticleTemp(jobId).catch(() => {}); throw error; }
}
export async function readArticleChunk({ jobId, offset = 0, assetId }) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('临时文件偏移无效');
    const owned = await ownedJob(jobId);
    if (assetId !== undefined) {
        if (typeof assetId !== 'string' || !/^image-\d+$/.test(assetId)) throw new Error('图片 ID 无效');
        const asset = owned.marker.assets?.find(item => item.id === assetId);
        if (!asset || !/^image-\d+\.(png|jpg|gif|webp)$/.test(asset.name)) throw new Error('图片归属无效');
        const directory = path.join(owned.folder, 'assets');
        if ((await lstat(directory)).isSymbolicLink() || path.dirname(await realpath(directory)) !== owned.folder) throw new Error('图片目录越界');
        owned.filename = path.join(directory, asset.name);
        if (path.dirname(await realpath(owned.filename)) !== await realpath(directory)) throw new Error('图片文件越界');
    }
    if ((await lstat(owned.filename)).isSymbolicLink()) throw new Error('拒绝读取链接文件');
    const file = await open(owned.filename, 'r');
    try {
        const { size } = await file.stat();
        if (offset > size) throw new Error('临时文件偏移越界');
        const buffer = Buffer.alloc(Math.min(384 * 1024, size - offset));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        return { base64: buffer.subarray(0, bytesRead).toString('base64'), nextOffset: offset + bytesRead, done: offset + bytesRead === size };
    } finally { await file.close(); }
}
export async function cleanupArticleTemp(jobId) {
    let owned;
    try { owned = await ownedJob(jobId); }
    catch (error) {
        if (error.code === 'ENOENT') {
            try { await lstat(jobPath(jobId)); }
            catch (missing) { if (missing.code === 'ENOENT') { active.delete(jobId); return { deleted: true }; } }
        }
        throw error;
    }
    // 删除前核对真实绝对路径、父目录和本功能的所有权标记。
    await rm(owned.folder, { recursive: true, force: true });
    active.delete(jobId);
    return { deleted: true };
}
export async function cleanupStaleArticleTemps() {
    let entries;
    try { entries = await readdir(rootPath(), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        if (!entry.isDirectory() || !UUID.test(entry.name) || active.has(entry.name)) continue;
        try { const { marker } = await ownedJob(entry.name); if (Date.now() - marker.createdAt > 60 * 60 * 1000) await cleanupArticleTemp(entry.name); }
        catch { /* 不删除无法验证归属的目录。 */ }
    }
}
export async function handleArticleTemp(message, options = {}) {
    if (message.type === 'ARTICLE_TEMP_PING') return { ready: true, protocolVersion: 3, capabilities: ['article-cli-export', 'article-export-progress', 'article-image-transfer'] };
    jobPath(message.jobId);
    const previous = operations.get(message.jobId) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => {
        if (message.type === 'ARTICLE_TEMP_CREATE') return createArticleTemp(message);
        if (message.type === 'ARTICLE_TEMP_EXPORT') return exportArticleTemp(message, options);
        if (message.type === 'ARTICLE_TEMP_READ') return readArticleChunk(message);
        if (message.type === 'ARTICLE_TEMP_CLEANUP') return cleanupArticleTemp(message.jobId);
        throw new Error('不支持的临时文件操作');
    });
    operations.set(message.jobId, task);
    try { return await task; }
    finally { if (operations.get(message.jobId) === task) operations.delete(message.jobId); }
}
