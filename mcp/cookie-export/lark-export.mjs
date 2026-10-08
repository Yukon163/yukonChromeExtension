import { access, lstat, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const executeLarkProcess = promisify(execFile);
export function validateDocumentUrl(value) {
    if (typeof value !== 'string') throw new Error('请选择有效的飞书文档');
    let url;
    try { url = new URL(value); } catch { throw new Error('请选择飞书云文档或 Wiki 的 HTTPS 链接'); }
    if (url.protocol !== 'https:' || url.username || url.password || !/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(url.hostname) || !/^\/(docx|wiki|doc)\/[^/]+/.test(url.pathname)) {
        throw new Error('请选择飞书云文档或 Wiki 的 HTTPS 链接');
    }
    return url.href;
}
export async function resolveLarkCommand() {
    const directories = [...new Set([path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter)].filter(Boolean))];
    for (const directory of directories) {
        const entry = path.join(directory, 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
        try { await access(entry); return { executable: process.execPath, prefix: [entry] }; } catch {}
    }
    for (const directory of directories) {
        const binary = path.join(directory, process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli');
        try { await access(binary); return { executable: binary, prefix: [] }; } catch {}
    }
    throw new Error('未找到飞书官方 lark-cli，请先安装 @larksuite/cli');
}
export async function exportLarkMarkdown({ sourceUrl, folder }, options = {}) {
    const url = validateDocumentUrl(sourceUrl);
    const notify = phase => { try { options.onProgress?.(phase); } catch {} };
    notify('resolving');
    const resolved = await (options.resolveCommand || resolveLarkCommand)();
    let output;
    try {
        notify('exporting');
        output = await (options.execute || executeLarkProcess)(resolved.executable, [...resolved.prefix,
            'drive', '+export', '--url', url, '--file-extension', 'markdown', '--as', 'user',
            '--output-dir', '.', '--file-name', 'document.md', '--format', 'json'
        ], {
            cwd: folder, windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024,
            env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }
        });
    } catch (error) {
        if (error.killed || error.code === 'ETIMEDOUT') throw new Error('飞书 CLI 导出超过 90 秒，已停止本次导出，请检查网络后重试');
        let details;
        try { details = JSON.parse(error.stderr || '').error; } catch {}
        if (details?.type === 'authentication' || details?.subtype === 'missing_scope' || details?.type === 'authorization') {
            throw new Error('飞书 CLI 用户授权未完成或缺少文档权限，请先完成 lark-cli 的文档授权');
        }
        throw new Error(details?.message ? `飞书 CLI 导出失败：${details.message.slice(0, 300)}` : '飞书 CLI 导出失败，请检查登录状态、文档权限或网络');
    }
    notify('validating');
    let result;
    try { result = JSON.parse(output.stdout); } catch { throw new Error('飞书 CLI 没有返回有效的导出结果'); }
    if (result.ok !== true || result.identity !== 'user') throw new Error('飞书 CLI 用户身份导出未完成');
    const filename = path.join(folder, 'document.md');
    if ((await lstat(filename)).isSymbolicLink()) throw new Error('拒绝使用链接导出文件');
    const [directory, actual] = await Promise.all([realpath(folder), realpath(filename)]);
    if (path.dirname(actual) !== directory || path.basename(actual) !== 'document.md') throw new Error('导出文件越出临时目录');
    if (result.data?.saved_path && await realpath(result.data.saved_path) !== actual) throw new Error('飞书 CLI 返回的导出路径不匹配');
    const stat = await lstat(filename);
    if (!stat.isFile() || !stat.size || stat.size > 16 * 1024 * 1024) throw new Error('Markdown 导出为空或超过 16 MB');
    const size = stat.size;
    const file = await open(filename, 'r');
    try {
        const header = Buffer.alloc(Math.min(size, 512));
        await file.read(header, 0, header.length, 0);
        if (header.subarray(0, 2).equals(Buffer.from('PK')) || /^\s*(?:\ufeff)?\s*<(?:!doctype\s+html|html\b)/i.test(header.toString('utf8'))) throw new Error('飞书导出返回了压缩包或 HTML 页面，请确认文档支持 Markdown 导出');
    } finally { await file.close(); }
    notify('ready');
    return { name: 'document.md', size };
}
