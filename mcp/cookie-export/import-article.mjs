import { connectedBrowsers, requestBridge } from './bridge-client.mjs';

try {
    const args = process.argv.slice(2);
    const source = args.find(arg => !arg.startsWith('--'));
    if (!source) throw new Error('用法：node import-article.mjs <飞书文档链接> [--inspect]');
    const browsers = await connectedBrowsers();
    if (browsers.length !== 1) throw new Error('请仅保留一个连接到本机服务的 Chrome 配置');
    const result = await requestBridge(browsers[0].connection, {
        method: 'import_article', source_url: source, inspect: args.includes('--inspect')
    }, { timeoutMs: 345000 });
    console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
