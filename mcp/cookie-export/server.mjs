import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { connectedBrowsers, exportCookies } from './bridge-client.mjs';
import { normalizeDomain } from './protocol.mjs';

const server = new McpServer({ name: 'yukon-chrome-cookie-export', version: '1.0.0' });

function result(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

server.registerTool('cookie_bridge_status', {
    title: '检查 Chrome Cookie 桥接',
    description: '查看已连接的 Chrome 配置会话。只返回会话元数据，不返回 Cookie 值。多个配置时用返回的 session_id 选择目标。',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
}, async () => {
    const browsers = await connectedBrowsers();
    return result({ connected: browsers.length > 0, sessions: browsers.map(browser => browser.info) });
});

server.registerTool('export_chrome_cookies', {
    title: '导出 Chrome 站点 Cookie 到本地文件',
    description: '按用户指定域名读取当前 Chrome 配置的 Cookie，保留父域共享项、子域、路径和 HttpOnly 属性。写入新建的本地 JSON 文件，默认在系统临时目录，也可指定绝对目录。只返回文件名、完整路径、数量和时间，不在工具结果中显示 Cookie 值。用于用户明确要求导出指定网站登录态的场景。',
    inputSchema: {
        domain: z.string().min(1).describe('网站域名或 HTTP/HTTPS 网址，例如 juejin.cn'),
        output_directory: z.string().min(1).optional().describe('本机绝对目录；省略时保存到系统临时目录下的 yukonChromeExtension/cookies'),
        session_id: z.string().optional().describe('多个 Chrome 配置连接时，通过 cookie_bridge_status 选择会话')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
}, async args => {
    try {
        return result(await exportCookies({ ...args, domain: normalizeDomain(args.domain) }));
    } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
});

await server.connect(new StdioServerTransport());
