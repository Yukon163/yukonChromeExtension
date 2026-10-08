(function() {
    'use strict';
    if (window.__yukonArticleAdapters?.version === 18) return;
    let working = false;
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const visible = node => {
        if (!node || !node.getClientRects().length || getComputedStyle(node).visibility === 'hidden') return false;
        const box = node.getBoundingClientRect();
        const right = box.right ?? box.left + (box.width ?? 1);
        const bottom = box.bottom ?? box.top + (box.height ?? 1);
        return right > 0 && bottom > 0 && box.left < innerWidth && box.top < innerHeight;
    };
    const text = node => (node?.innerText || node?.textContent || '').replace(/\s+/g, '').trim();
    function control(labels, root = document) {
        const wanted = labels.map(label => label.replace(/\s+/g, ''));
        const nodes = [...root.querySelectorAll('[role="menuitem"],button,[role="button"],label,a,[class*="menu-item"],[class*="dropdown-item"]')];
        return nodes.find(node => visible(node) && !node.closest('[contenteditable="true"]') &&
            wanted.includes(text(node)) && !node.disabled && node.getAttribute('aria-disabled') !== 'true');
    }
    function hover(node) {
        if (!node) throw new Error('页面操作入口不存在');
        const box = node.getBoundingClientRect();
        const options = { bubbles: true, view: window, relatedTarget: document.body, clientX: box.left + (box.width || 0) / 2, clientY: box.top + (box.height || 0) / 2 };
        for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) {
            const EventType = type.startsWith('pointer') && window.PointerEvent ? window.PointerEvent : MouseEvent;
            node.dispatchEvent(new EventType(type, { ...options, bubbles: !type.endsWith('enter'), pointerType: 'mouse', isPrimary: true }));
        }
    }
    function click(node) {
        hover(node);
        const box = node.getBoundingClientRect();
        const options = { bubbles: true, cancelable: true, view: window, button: 0, detail: 1, clientX: box.left + (box.width || 0) / 2, clientY: box.top + (box.height || 0) / 2 };
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
            const EventType = type.startsWith('pointer') && window.PointerEvent ? window.PointerEvent : MouseEvent;
            node.dispatchEvent(new EventType(type, { ...options, buttons: type.endsWith('down') ? 1 : 0, pointerType: 'mouse', isPrimary: true }));
        }
        node.click();
    }
    async function until(check, timeout, message) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) { const value = check(); if (value) return value; await pause(100); }
        throw new Error(message);
    }
    function editorText() {
        const editors = [...document.querySelectorAll('.CodeMirror-code,.monaco-editor .view-lines,.ProseMirror,.v-md-textarea,textarea:not([placeholder*="标题"]):not([placeholder*="title"])')];
        return editors.map(node => node.value ?? node.textContent ?? '').join('\n').replace(/[\s\u200b\u00a0]/g, '');
    }
    function checkTarget() {
        if (location.hostname !== 'juejin.cn' || !/^\/editor\/drafts\//.test(location.pathname)) throw new Error('请先进入掘金文章编辑器');
        if (!document.querySelector('input[placeholder*="标题"],textarea[placeholder*="标题"],.CodeMirror,.monaco-editor,.ProseMirror,textarea')) throw new Error('没有找到掘金编辑器，请确认已登录');
        if (editorText()) throw new Error('当前草稿已有正文，请在空白草稿中导入，避免覆盖已有内容');
        return { ok: true };
    }
    function markdownInputs() {
        const native = [...document.querySelectorAll('.article-importer input[type="file"]')];
        if (native.length) return native;
        return [...document.querySelectorAll('input[type="file"]')].filter(node => /(?:\.md\b|markdown)/i.test(node.accept));
    }
    function imageUploader() {
        let node = document.querySelector('.bytemd');
        while (node) {
            const component = node.__vue__;
            if (typeof component?.$props?.uploadImages === 'function') return component.$props.uploadImages;
            if (typeof component?.uploadImages === 'function') return component.uploadImages.bind(component);
            node = node.parentElement;
        }
        return null;
    }
    async function uploadJuejinImage({ asset, parts, timeoutMs = 45000 }) {
        checkTarget();
        const upload = imageUploader();
        if (!upload) throw new Error('没有找到掘金图片上传入口，已停止导入以免丢图');
        if (!/^image-\d+$/.test(asset.id) || !/^image\/(png|jpeg|gif|webp)$/.test(asset.type)) throw new Error('导入图片格式无效');
        const chunks = parts.map(part => Uint8Array.from(atob(part), char => char.charCodeAt(0)));
        const file = new File(chunks, asset.name, { type: asset.type });
        let timer;
        try {
            const result = await Promise.race([
                upload([file]),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('掘金图片上传超时，请检查网络后重试')), timeoutMs); })
            ]);
            const url = result?.[0]?.url;
            if (typeof url !== 'string') throw new Error('掘金没有返回有效的图片地址');
            const parsed = new URL(url);
            if (typeof url !== 'string' || parsed.protocol !== 'https:' || parsed.username || parsed.password || !/(^|\.)(byteimg\.com|juejin\.cn|juejin\.im)$/.test(parsed.hostname)) throw new Error('掘金没有返回有效的图片地址');
            return { ok: true, assetId: asset.id, url };
        } finally { clearTimeout(timer); }
    }
    async function importJuejin({ parts, name, timeoutMs = 20000 }) {
        checkTarget();
        const chunks = parts.map(part => Uint8Array.from(atob(part), char => char.charCodeAt(0)));
        const file = new File(chunks, name, { type: 'text/markdown' });
        const before = editorText();
        let consumed = false;
        const originalClick = HTMLInputElement.prototype.click;
        const originalText = File.prototype.text;
        const hadOwnText = Object.prototype.hasOwnProperty.call(File.prototype, 'text');
        const pickerInputs = new Set();
        const originalReaders = {};
        HTMLInputElement.prototype.click = function(...args) {
            if (this.type === 'file') { pickerInputs.add(this); return; }
            return originalClick.apply(this, args);
        };
        File.prototype.text = function(...args) {
            const promise = originalText.apply(this, args);
            if (this === file) return promise.then(value => { consumed = true; return value; });
            return promise;
        };
        for (const method of ['readAsText', 'readAsArrayBuffer']) {
            originalReaders[method] = FileReader.prototype[method];
            FileReader.prototype[method] = function(blob, ...args) {
                if (blob === file) this.addEventListener('load', () => { consumed = true; }, { once: true });
                return originalReaders[method].call(this, blob, ...args);
            };
        }
        try {
            let inputs = markdownInputs();
            if (!inputs.length) {
                const entry = control(['从 Markdown 导入', '从Markdown导入', '导入 Markdown', '导入本地 Markdown', '本地上传', '本地导入']);
                if (!entry) throw new Error('未找到掘金 Markdown 导入入口，请确认正在使用文章编辑器');
                click(entry);
                inputs = await until(() => {
                    const found = markdownInputs();
                    const picked = [...pickerInputs].filter(node => !/image\//i.test(node.accept));
                    return found.length ? found : picked.length ? picked : null;
                }, 3000, '掘金没有创建 Markdown 文件输入框');
            }
            if (inputs.length !== 1) throw new Error('页面有多个 Markdown 输入框，无法确定导入目标');
            const transfer = new DataTransfer();
            transfer.items.add(file);
            inputs[0].files = transfer.files;
            inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
            await until(() => {
                const dialog = [...document.querySelectorAll('[role="dialog"]')].find(node => visible(node) && /Markdown|导入/.test(text(node)));
                if (dialog) {
                    const confirm = control(['导入', '确定', '确认导入'], dialog);
                    if (confirm) click(confirm);
                }
                return consumed && editorText() && editorText() !== before;
            }, timeoutMs, '尚未确认正文进入掘金编辑器，已停止并清理临时文件');
            const markdown = await originalText.call(file);
            const imageLinks = [...markdown.matchAll(/!\[[^\]]*\]\([^)]*(?:feishu|lark|feishucdn)[^)]*\)/gi)].length;
            return { ok: true, imageLinks };
        } finally {
            HTMLInputElement.prototype.click = originalClick;
            if (hadOwnText) File.prototype.text = originalText;
            else delete File.prototype.text;
            for (const method of Object.keys(originalReaders)) FileReader.prototype[method] = originalReaders[method];
        }
    }
    const safe = method => async args => {
        if (working) return { ok: false, error: '这个页面正在处理另一项导入任务' };
        working = true;
        try { return await method(args); }
        catch (error) { return { ok: false, error: error.message }; }
        finally { working = false; }
    };
    function inspect() {
        const controls = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[title],[aria-label],[data-title],[data-tooltip],[class*="menu"],[class*="upload"],[class*="import"]')]
            .filter(node => visible(node) && node.getBoundingClientRect().top < 220)
            .filter(node => node.children.length < 10 && !node.closest('[contenteditable="true"],.CodeMirror,.monaco-editor,.ProseMirror'))
            .slice(0, 60).map(node => ({ tag: node.tagName, text: text(node).slice(0, 80), label: node.getAttribute('aria-label'), title: node.getAttribute('title'), dataTitle: node.getAttribute('data-title'), className: node.getAttribute('class'), icons: [...node.querySelectorAll('use')].map(icon => icon.getAttribute('href') || icon.getAttribute('xlink:href')) }));
        const inputs = [...document.querySelectorAll('input[type="file"]')].map(node => ({ accept: node.accept, id: node.id, parentClass: node.parentElement?.className }));
        const editors = [...document.querySelectorAll('textarea,[contenteditable="true"],.CodeMirror-code,.cm-content,.monaco-editor .view-lines,.ProseMirror')].map(node => ({ tag: node.tagName, className: node.className, characters: (node.value ?? node.textContent ?? '').replace(/[\s\u200b\u00a0]/g, '').length }));
        const scripts = [...document.querySelectorAll('script[src]')].map(node => node.src).filter(url => /^https:\/\//.test(url)).slice(0, 60);
        const imageControls = [...document.querySelectorAll('.bytemd-toolbar [title],.bytemd-toolbar [data-tippy-content],.bytemd-toolbar [bytemd-tippy-left],.bytemd-toolbar-icon')].map(node => ({ tag: node.tagName, className: node.className, title: node.title, tooltip: node.getAttribute('data-tippy-content'), label: node.getAttribute('aria-label'), tip: node.getAttribute('bytemd-tippy-left') }));
        const previewImages = [...document.querySelectorAll('.bytemd-preview img')].map(node => ({ host: (() => { try { return new URL(node.src).hostname; } catch { return ''; } })(), loaded: node.complete && node.naturalWidth > 0 }));
        return { ok: true, adapterVersion: 18, url: location.href, title: document.title, controls, inputs, editors, scripts, imageControls, nativeImageUploader: !!imageUploader(), previewImages, editorCharacters: editorText().length };
    }
    window.__yukonArticleAdapters = Object.freeze({ version: 18, checkTarget: safe(checkTarget), uploadJuejinImage: safe(uploadJuejinImage), importJuejin: safe(importJuejin), inspect: safe(inspect) });
})();
