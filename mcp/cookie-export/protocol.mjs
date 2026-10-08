import os from 'node:os';

export function encodeNative(message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    if (body.length > 1024 * 1024) throw new Error('Native request is too large');
    const header = Buffer.alloc(4);
    if (os.endianness() === 'LE') header.writeUInt32LE(body.length);
    else header.writeUInt32BE(body.length);
    return Buffer.concat([header, body]);
}

export function nativeDecoder(onMessage) {
    let buffer = Buffer.alloc(0);
    return chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
            const size = os.endianness() === 'LE' ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
            if (size > 64 * 1024 * 1024) throw new Error('Native response is too large');
            if (buffer.length < size + 4) return;
            const message = JSON.parse(buffer.subarray(4, size + 4).toString('utf8'));
            buffer = buffer.subarray(size + 4);
            onMessage(message);
        }
    };
}

export function normalizeDomain(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('请输入网站域名或网址');
    const url = new URL(value.includes('://') ? value.trim() : `https://${value.trim()}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('仅支持不含用户名和密码的 HTTP/HTTPS 网站地址');
    }
    return url.hostname.toLowerCase().replace(/\.$/, '');
}

export function belongsToSite(cookie, domain) {
    const host = cookie.domain.replace(/^\./, '').toLowerCase();
    return host === domain || host.endsWith(`.${domain}`) ||
        (!cookie.hostOnly && domain.endsWith(`.${host}`));
}
