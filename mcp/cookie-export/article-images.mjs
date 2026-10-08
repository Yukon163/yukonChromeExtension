import { mkdir, readFile, lstat, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { resolveLarkCommand, executeLarkProcess } from './lark-export.mjs';

function withoutCode(markdown) {
    let fence;
    const protectedText = markdown.split(/(?<=\n)/).map(line => {
        const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        const inside = !!fence;
        if (match && !fence) fence = match[1];
        else if (match && match[1][0] === fence?.[0] && match[1].length >= fence.length && /^\s*$/.test(line.slice(match[0].length))) fence = undefined;
        return inside || match ? line.replace(/[^\r\n]/g, ' ') : line;
    }).join('');
    return protectedText.replace(/(`+)([\s\S]*?)\1(?!`)/g, match => match.replace(/[^\r\n]/g, ' '));
}
export function findLarkImages(markdown) {
    const resources = new Map();
    const references = [];
    const pattern = /(!\[(?:\\.|[^\]\\\r\n])*\]\(\s*<?)(https:\/\/[^>\s)]+)(>?(?:[^\r\n)]*)\))/g;
    for (const match of withoutCode(markdown).matchAll(pattern)) {
        let escapes = 0;
        for (let index = match.index - 1; index >= 0 && markdown[index] === '\\'; index--) escapes++;
        if (escapes % 2) continue;
        let url;
        try { url = new URL(match[2]); } catch { continue; }
        if (url.username || url.password || !/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(url.hostname)) continue;
        const token = /^\/file\/([a-zA-Z0-9_-]{8,128})\/?$/.exec(url.pathname)?.[1];
        if (!token) throw new Error('存在无法识别的飞书图片链接，已停止导入以免丢图');
        if (!resources.has(token)) resources.set(token, { id: `image-${resources.size + 1}`, token });
        const start = match.index + match[1].length;
        references.push({ start, end: start + match[2].length, sourceUrl: match[2], assetId: resources.get(token).id });
    }
    if (resources.size > 40) throw new Error('单次导入最多支持 40 张飞书图片');
    return { resources: [...resources.values()], references };
}
function imageFormat(bytes) {
    if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { extension: 'png', type: 'image/png' };
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { extension: 'jpg', type: 'image/jpeg' };
    if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return { extension: 'gif', type: 'image/gif' };
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return { extension: 'webp', type: 'image/webp' };
    throw new Error('飞书图片返回了不支持的格式，已停止导入以免丢图');
}
export async function downloadArticleImages(folder, options = {}) {
    const markdown = await readFile(path.join(folder, 'document.md'), 'utf8');
    const { resources, references } = findLarkImages(markdown);
    if (!resources.length) return { assets: [], references };
    const directory = path.join(folder, 'assets');
    await mkdir(directory, { mode: 0o700 });
    const root = await realpath(directory);
    const resolved = await (options.resolveCommand || resolveLarkCommand)();
    const startedAt = Date.now();
    const assets = [];
    let totalSize = 0;
    for (const resource of resources) {
        const timeout = Math.min(30000, 90000 - (Date.now() - startedAt));
        if (timeout <= 0) throw new Error('飞书图片下载超过 90 秒，请检查网络后重试');
        options.onProgress?.({ phase: 'images', current: assets.length + 1, total: resources.length });
        let output;
        try {
            output = await (options.execute || executeLarkProcess)(resolved.executable, [...resolved.prefix,
                'docs', '+media-download', '--token', resource.token, '--output', `./assets/${resource.id}`,
                '--as', 'user', '--format', 'json'
            ], { cwd: folder, windowsHide: true, timeout, maxBuffer: 1024 * 1024,
                env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }
            });
        } catch { throw new Error(`第 ${assets.length + 1}/${resources.length} 张飞书图片下载失败，请检查 CLI 素材权限和网络后重试`); }
        let result;
        try { result = JSON.parse(output.stdout); } catch { throw new Error('飞书图片下载没有返回有效结果'); }
        if (result.ok !== true || result.identity !== 'user' || typeof result.data?.saved_path !== 'string') throw new Error('飞书图片用户身份下载未完成');
        const filename = result.data.saved_path;
        if (path.dirname(path.resolve(filename)) !== path.resolve(directory) || !new RegExp(`^${resource.id}\\.(png|jpe?g|gif|webp)$`, 'i').test(path.basename(filename))) throw new Error('飞书图片导出路径不匹配');
        const stat = await lstat(filename);
        if (stat.isSymbolicLink() || !stat.isFile() || !stat.size || stat.size > 20 * 1024 * 1024 || path.dirname(await realpath(filename)) !== root) throw new Error('飞书图片文件无效或超过 20 MB');
        totalSize += stat.size;
        if (totalSize > 80 * 1024 * 1024) throw new Error('飞书图片总大小超过 80 MB');
        const format = imageFormat((await readFile(filename)).subarray(0, 16));
        const name = `${resource.id}.${format.extension}`;
        const destination = path.join(root, name);
        if (path.resolve(filename) !== path.resolve(destination)) await rename(filename, destination);
        assets.push({ id: resource.id, name, size: stat.size, type: format.type });
    }
    return { assets, references };
}
