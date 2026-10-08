(function() {
    'use strict';
    if (window !== window.top || !/^\/editor\/drafts\//.test(location.pathname) || document.getElementById('yukon-feishu-import-host')) return;
    const host = document.createElement('div');
    host.id = 'yukon-feishu-import-host';
    host.style.cssText = 'position:fixed;right:24px;top:78px;z-index:2147483000;font:13px system-ui;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
        <style>
            :host{color:#252933}*{box-sizing:border-box}button,input,select{font:inherit}
            button{border:1px solid #1e80ff;border-radius:6px;background:#fff;color:#1e80ff;padding:8px 14px;cursor:pointer}
            button:disabled{opacity:.5;cursor:default}.primary{background:#1e80ff;color:#fff}.secondary{border-color:#dce0e5;color:#515767}
            .import-progress{width:290px;margin-top:8px;padding:12px;background:#fff;border:1px solid #ddd;border-radius:6px;box-shadow:0 2px 10px #0001}.import-progress[hidden]{display:none}
            .steps{display:flex;gap:6px;list-style:none;padding:0;margin:0 0 10px;font-size:11px;color:#86909c}.steps li{flex:1;border-top:3px solid #e4e6eb;padding-top:5px}.steps li.active{border-color:#1e80ff;color:#1e80ff}.steps li.done{border-color:#00b578;color:#16835d}.steps li.error{border-color:#d93f4c;color:#d93f4c}
            .import-status{line-height:1.6;margin:0;overflow-wrap:anywhere}.import-time{display:block;margin-top:8px;color:#86909c;font-size:11px}dialog{width:min(480px,calc(100vw - 40px));max-height:calc(100vh - 48px);padding:24px;border:1px solid #e4e6eb;border-radius:12px;background:#fff;color:#252933;box-shadow:0 16px 64px #0003;overflow:auto}
            dialog::backdrop{background:#0006}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}h2{margin:0;font-size:18px;font-weight:600}
            .close{border:0;color:#86909c;padding:2px 8px;font-size:24px;line-height:1}.help{margin:0 0 20px;font-size:12px;line-height:1.7;color:#86909c}
            label{display:block;font-weight:500;margin:16px 0 8px}.source-row{display:flex;gap:8px}select,input{min-width:0;width:100%;padding:10px 12px;border:1px solid #dce0e5;border-radius:6px;background:#fff;color:#252933;outline:none}
            select:focus,input:focus{border-color:#1e80ff}.source-row select{flex:1}.source-row button{flex-shrink:0}.picker-status{min-height:20px;font-size:12px;line-height:1.6;color:#86909c;margin:10px 0 0}
            footer{display:flex;gap:10px;justify-content:flex-end;margin-top:24px}
        </style>
        <button type="button" data-action="choose">从飞书导入</button>
        <section class="import-progress" aria-label="导入进度" hidden>
            <ol class="steps" aria-label="导入步骤"><li>1 检查</li><li>2 飞书导出</li><li>3 掘金导入</li><li>4 清理</li></ol>
            <p class="import-status" role="status" aria-live="polite"></p>
            <small class="import-time" aria-live="off"></small>
        </section>
        <dialog aria-labelledby="source-picker-title">
            <form novalidate>
                <header><h2 id="source-picker-title">选择飞书文档</h2><button type="button" class="close" data-action="close" aria-label="关闭文档选择">×</button></header>
                <p class="help">选择当前已打开的飞书文档，或粘贴文档链接。</p>
                <label for="source-documents">已打开的飞书文档</label>
                <div class="source-row"><select id="source-documents"><option value="">请选择文档</option></select><button type="button" class="secondary" data-action="refresh">刷新</button></div>
                <label for="source-link">飞书文档链接</label>
                <input id="source-link" type="url" placeholder="https://…feishu.cn/docx/… 或 /wiki/…" autocomplete="off" spellcheck="false">
                <p class="picker-status" role="status" aria-live="polite"></p>
                <footer><button type="button" class="secondary" data-action="cancel">取消</button><button type="submit" class="primary" disabled>开始导入</button></footer>
            </form>
        </dialog>`;
    const button = root.querySelector('[data-action="choose"]');
    const status = root.querySelector('.import-status');
    const progressPanel = root.querySelector('.import-progress');
    const elapsed = root.querySelector('.import-time');
    const steps = [...root.querySelectorAll('.steps li')];
    const dialog = root.querySelector('dialog');
    const form = root.querySelector('form');
    const select = root.querySelector('select');
    const input = root.querySelector('input');
    const confirm = root.querySelector('[type="submit"]');
    const refresh = root.querySelector('[data-action="refresh"]');
    const pickerStatus = root.querySelector('.picker-status');
    let loading = false;
    let importing = false;
    let currentStep = 1;
    let currentJobId;
    let startedAt;
    let elapsedTimer;
    document.documentElement.appendChild(host);

    function renderElapsed() {
        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        elapsed.textContent = `已用时 ${seconds} 秒${importing ? ` · 当前步骤 ${currentStep}/4` : ''}`;
    }
    function renderSteps({ completed = false, failed = false } = {}) {
        steps.forEach((node, index) => {
            node.className = completed || index + 1 < currentStep ? 'done' : index + 1 === currentStep ? failed ? 'error' : 'active' : '';
            if (importing && index + 1 === currentStep) node.setAttribute('aria-current', 'step');
            else node.removeAttribute('aria-current');
        });
    }

    function selectedUrl() {
        try {
            const url = new URL(input.value.trim());
            if (url.protocol !== 'https:' || url.username || url.password || !/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(url.hostname) || !/^\/(docx|wiki|doc)\/[^/]+/.test(url.pathname)) return '';
            return url.href;
        } catch { return ''; }
    }
    function updateConfirm() { confirm.disabled = importing || loading || !selectedUrl(); }
    async function loadSources() {
        loading = true; refresh.disabled = true; updateConfirm();
        pickerStatus.textContent = '正在读取已打开的文档…';
        try {
            const result = await chrome.runtime.sendMessage({ type: 'FEISHU_IMPORT_SOURCES' });
            if (!result?.ok) throw new Error(result?.error || '无法读取文档列表，请重新加载扩展');
            select.replaceChildren(new Option('请选择文档', ''));
            for (const source of result.sources) select.add(new Option(source.title || source.url, source.url));
            if (!input.value.trim()) input.value = result.lastSourceUrl || (result.sources.length === 1 ? result.sources[0].url : '');
            select.value = input.value.trim();
            pickerStatus.textContent = result.sources.length ? `找到 ${result.sources.length} 个已打开的文档。选好后点击“开始导入”。` : '没有已打开的飞书文档，可以直接粘贴链接。';
        } catch (error) { pickerStatus.textContent = error.message; }
        finally { loading = false; refresh.disabled = false; updateConfirm(); }
    }
    button.addEventListener('click', () => {
        if (importing || dialog.open) return;
        dialog.showModal();
        input.focus();
        loadSources();
    });
    refresh.addEventListener('click', loadSources);
    select.addEventListener('change', () => { input.value = select.value; updateConfirm(); });
    input.addEventListener('input', () => { select.value = input.value.trim(); updateConfirm(); });
    for (const action of ['close', 'cancel']) root.querySelector(`[data-action="${action}"]`).addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { if (!importing) button.focus(); });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const sourceUrl = selectedUrl();
        if (importing || loading || !sourceUrl) { pickerStatus.textContent = '请选择文档或填写有效的飞书文档链接。'; return; }
        importing = true;
        currentStep = 1;
        currentJobId = undefined;
        startedAt = Date.now();
        progressPanel.hidden = false;
        renderSteps();
        renderElapsed();
        elapsedTimer = setInterval(renderElapsed, 1000);
        dialog.close();
        button.disabled = true;
        status.textContent = '准备从飞书导入…';
        try {
            const result = await chrome.runtime.sendMessage({ type: 'FEISHU_IMPORT_BEGIN', sourceUrl });
            if (!result?.ok) throw new Error(result?.error || '导入服务未响应，请重新加载扩展');
            importing = false;
            renderSteps({ completed: true });
            status.textContent = result.transferredImages ? `导入完成，${result.transferredImages} 张图片已转存到掘金，临时文件已删除。` : result.imageLinks ? `导入完成，临时文件已删除。包含 ${result.imageLinks} 个飞书图片链接，请检查预览。` : '导入完成，临时文件已删除。';
        } catch (error) { importing = false; renderSteps({ failed: true }); status.textContent = error.message; }
        finally { clearInterval(elapsedTimer); importing = false; renderElapsed(); button.disabled = false; updateConfirm(); }
    });
    chrome.runtime.onMessage.addListener(message => {
        if (message?.type !== 'FEISHU_IMPORT_PROGRESS' || !importing) return;
        if (currentJobId && message.jobId && message.jobId !== currentJobId) return;
        if (message.jobId) currentJobId = message.jobId;
        if (Number.isInteger(message.step)) {
            if (message.step < currentStep || message.step < 1 || message.step > 4) return;
            currentStep = message.step;
        }
        status.textContent = message.text;
        renderSteps();
        renderElapsed();
    });
})();
