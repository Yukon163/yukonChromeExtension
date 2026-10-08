import { connectedBrowsers, exportCookies } from './bridge-client.mjs';
import { normalizeDomain } from './protocol.mjs';

try {
    const [domain, outputDirectory] = process.argv.slice(2);
    if (domain === '--status') {
        const browsers = await connectedBrowsers();
        console.log(JSON.stringify({ connected: browsers.length > 0, sessions: browsers.map(browser => browser.info) }, null, 2));
    } else {
        if (!domain) throw new Error('用法：node export.mjs <域名或网址> [本机绝对输出目录]，或 node export.mjs --status');
        console.log(JSON.stringify(await exportCookies({ domain: normalizeDomain(domain), output_directory: outputDirectory }), null, 2));
    }
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
