import { mkdir, realpath, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { belongsToSite } from './protocol.mjs';

export function defaultExportDirectory() {
    return path.join(os.tmpdir(), 'yukonChromeExtension', 'cookies');
}

export async function saveSnapshot(snapshot, domain, outputDirectory, { overwrite = false } = {}) {
    if (snapshot?.domain !== domain || !Array.isArray(snapshot.cookies) ||
        !snapshot.cookies.every(cookie => typeof cookie.domain === 'string' &&
            typeof cookie.name === 'string' && typeof cookie.value === 'string' && belongsToSite(cookie, domain))) {
        throw new Error('浏览器返回的站点数据不匹配，未保存文件');
    }
    const folder = outputDirectory || defaultExportDirectory();
    if (!path.isAbsolute(folder)) throw new Error('output_directory 必须是本机绝对路径');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const directory = await realpath(folder);
    const exportedAt = new Date().toISOString();
    const basename = domain.replace(/[\[\]:]/g, '_');
    const stamp = exportedAt.replace(/[-:.]/g, '');
    const filename = overwrite ? `${basename}.cookies.json` : `${basename}-${stamp}-${randomUUID().slice(0, 8)}.cookies.json`;
    const absolutePath = path.join(directory, filename);
    const temporaryPath = overwrite ? `${absolutePath}.${randomUUID()}.tmp` : absolutePath;
    try {
        await writeFile(temporaryPath, JSON.stringify({ ...snapshot, exportedAt }, null, 2), {
            encoding: 'utf8', mode: 0o600, flag: 'wx'
        });
        if (overwrite) await rename(temporaryPath, absolutePath);
    } catch (error) {
        if (overwrite) await unlink(temporaryPath).catch(() => {});
        throw error;
    }
    return { domain, cookie_count: snapshot.cookies.length, filename, absolute_path: absolutePath, exported_at: exportedAt };
}
