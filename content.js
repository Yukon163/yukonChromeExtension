(function() {
    let speedTimer = null;
    let isSpeeding = false;
    let originalRate = 1;
    let activeVideo = null;
    let mouseTimer = null;
    const SPEED_UP_RATE = 2.0;
    const LONG_PRESS_THRESHOLD = 250;
    const HIDE_MOUSE_DELAY = 3000; // 3秒无操作隐藏鼠标
    const FEISHU_FORMULA_SEARCH = '/公式';
    const FEISHU_FORMULA_LABEL_PATTERN = /(?:添加\s*)?(?:LaTeX\s*)?公式/i;
    const FEISHU_DOC_PATH_PATTERN = /^\/(?:docx|docs|wiki|sheets|base|mindnotes|mindnote|slides|file|drive|space|minutes)\//;
    let lastFeishuFormulaOpenAt = 0;
    let isOpeningFeishuFormula = false;

    // 深度搜索所有 Shadow DOM 寻找 video
    function findVideoRecursively(root) {
        let video = root.querySelector('video');
        if (video) return video;

        const allElements = root.querySelectorAll('*');
        for (const el of allElements) {
            if (el.shadowRoot) {
                video = findVideoRecursively(el.shadowRoot);
                if (video) return video;
            }
        }
        return null;
    }

    function getVideo() {
        // 1. 检查已知活跃视频
        if (activeVideo && document.contains(activeVideo)) return activeVideo;

        // 2. 查找常规 DOM
        let video = document.querySelector('video');
        
        // 3. 查找 Shadow DOM
        if (!video) {
            video = findVideoRecursively(document);
        }

        // 4. 如果找到多个，返回正在播放的
        if (!video) {
            const allVideos = Array.from(document.querySelectorAll('video'));
            video = allVideos.find(v => !v.paused) || allVideos[0];
        }

        if (video) activeVideo = video;
        return video;
    }

    async function checkPermission() {
        return new Promise((resolve) => {
chrome.storage.sync.get({
                whitelist: ['cycani.org', 'mgnacg.com']
            }, (items) => {
                const host = window.location.hostname;
                const ref = document.referrer ? new URL(document.referrer).hostname : '';
                
                const isMatch = (h) => items.whitelist.some(d => {
                    const cleanH = h.replace(/^www\./, '');
                    const cleanD = d.replace(/^www\./, '');
                    return cleanH === cleanD || h.endsWith('.' + cleanD);
                });

                const allowed = isMatch(host) || (window.self !== window.top && isMatch(ref));
                if (!allowed && window.self === window.top) {
                    console.log(`[yukonChromeExtension] 当前域名 ${host} 不在白名单中。如需在当前站点使用，请在插件选项页添加该域名。`);
                }
                resolve(allowed);
            });
        });
    }

    function showIndicator(text, persistent = false) {
        let indicator = document.getElementById('cyc-speed-indicator');
        if (!indicator) {
            // 注入动画样式
            const style = document.createElement('style');
            style.textContent = `
                @keyframes cyc-arrow-flow {
                    0%, 100% { opacity: 0.2; }
                    50% { opacity: 1; }
                }
                .cyc-arrow {
                    animation: cyc-arrow-flow 2s infinite;
                }
                .cyc-arrow:nth-child(1) { animation-delay: 0s; }
                .cyc-arrow:nth-child(2) { animation-delay: 0.3s; }
                .cyc-arrow:nth-child(3) { animation-delay: 0.6s; }
            `;
            document.head.appendChild(style);

            indicator = document.createElement('div');
            indicator.id = 'cyc-speed-indicator';
            Object.assign(indicator.style, {
                position: 'fixed',
                top: '60px',
                left: '50%',
                transform: 'translateX(-50%)',
                background: 'rgba(0, 0, 0, 0.65)',
                color: '#ffffff',
                padding: '8px 16px',
                borderRadius: '4px',
                zIndex: '2147483647',
                fontSize: '14px',
                fontWeight: '400',
                pointerEvents: 'none',
                fontFamily: 'pingfang sc, helvetica neue, hiragino sans gb, microsoft yahei, arial, sans-serif',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                transition: 'opacity 0.2s',
                opacity: '0'
            });
            document.body.appendChild(indicator);
        }
        
        const isSpeedingNow = text.includes('X') || text.includes('倍速');
        
        // 仿B站三箭头流光动画
        let innerHTML = '';
        if (isSpeedingNow) {
            innerHTML = `
                <div style="display:flex; color:white;">
                    <svg class="cyc-arrow" width="12" height="12" viewBox="0 0 24 24"><path fill="currentColor" d="M8,5V19L19,12L8,5Z" /></svg>
                    <svg class="cyc-arrow" width="12" height="12" viewBox="0 0 24 24" style="margin-left:-4px;"><path fill="currentColor" d="M8,5V19L19,12L8,5Z" /></svg>
                    <svg class="cyc-arrow" width="12" height="12" viewBox="0 0 24 24" style="margin-left:-4px;"><path fill="currentColor" d="M8,5V19L19,12L8,5Z" /></svg>
                </div>
                <span>倍速播放中</span>
            `;
        } else {
            innerHTML = `<span>${text}</span>`;
        }
        
        indicator.innerHTML = innerHTML;
        indicator.style.display = 'flex';
        indicator.offsetHeight; 
        indicator.style.opacity = '1';
        
        if (!persistent) {
            setTimeout(() => {
                if (!isSpeeding) hideIndicator();
            }, 1500);
        }
    }

    function hideIndicator() {
        const indicator = document.getElementById('cyc-speed-indicator');
        if (indicator) {
            indicator.style.opacity = '0';
            setTimeout(() => {
                if (indicator.style.opacity === '0') indicator.style.display = 'none';
            }, 200);
        }
    }

    function handleEpisode(direction) {
        const isNext = direction === 'next';
        const targetText = isNext ? '下集' : '上集';
        
        console.log(`[yukonChromeExtension] 正在发起广播: ${targetText}`);

        // 尝试向后台发送消息进行中转
        try {
            chrome.runtime.sendMessage({
                type: 'NAV_EPISODE',
                direction: direction
            }, () => {
                // 忽略回调错误，因为我们只是为了触发后台的中转
                if (chrome.runtime.lastError) {
                    // 如果中转失败（比如插件刚更新），尝试在当前页面直接执行
                    if (window === window.top) executeNavigation(direction);
                }
            });
        } catch (e) {
            // 最后的保底：如果环境彻底失效，且在主页面，则直接尝试
            if (window === window.top) executeNavigation(direction);
        }
    }

    // 监听广播
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'NAV_EPISODE' && window === window.top) {
            console.log(`[yukonChromeExtension] 主页面收到切集指令: ${msg.direction}`);
            executeNavigation(msg.direction);
        } else if (msg.type === 'SYNC_SPEED') {
            handleSyncSpeed(msg);
        } else if (msg.type === 'OPEN_FEISHU_FORMULA') {
            if (isFeishuDocPage() && (msg.source !== 'command' || hasFeishuEditingFocus())) {
                openFeishuFormulaBlock();
            }
        }
    });

    function handleSyncSpeed(msg) {
        const video = getVideo();
        
        if (msg.action === 'start') {
            if (video && !isSpeeding) {
                isSpeeding = true;
                originalRate = video.playbackRate;
                video.playbackRate = SPEED_UP_RATE;
                if (video.paused) {
                    video.play();
                }
            }
            // 无论是否有视频，只要是当前活动的 Frame（或者所有 Frame）都显示指示器
            // 这样用户能感知到按键被触发了
            showIndicator(`>> ${SPEED_UP_RATE}X`, true);
        } else if (msg.action === 'stop') {
            if (video && isSpeeding) {
                video.playbackRate = originalRate;
            }
            isSpeeding = false;
            hideIndicator();
        } else if (msg.action === 'seek') {
            if (video) {
                video.currentTime += msg.seconds;
            }
            showIndicator(`+${msg.seconds}s`);
        }
    }

    function isFeishuDocPage() {
        const host = window.location.hostname.replace(/^www\./, '');
        const isFeishuHost = host === 'feishu.cn' || host.endsWith('.feishu.cn') ||
            host === 'larksuite.com' || host.endsWith('.larksuite.com');

        if (!isFeishuHost) return false;

        return host === 'docs.feishu.cn' ||
            host.endsWith('.docs.feishu.cn') ||
            FEISHU_DOC_PATH_PATTERN.test(window.location.pathname);
    }

    function getDeepActiveElement() {
        let active = document.activeElement;

        while (active && active.shadowRoot && active.shadowRoot.activeElement) {
            active = active.shadowRoot.activeElement;
        }

        return active;
    }

    function isTextInput(el) {
        if (!el) return false;
        if (el.tagName === 'TEXTAREA') return true;
        if (el.tagName !== 'INPUT') return false;

        const type = (el.getAttribute('type') || 'text').toLowerCase();
        return ['text', 'search', 'url', 'tel', 'password', 'email'].includes(type);
    }

    function setNativeInputValue(el, value) {
        const prototype = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

        if (valueSetter) valueSetter.call(el, value);
        else el.value = value;
    }

    function insertIntoTextInput(el, text) {
        if (el.disabled || el.readOnly) return false;

        const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
        const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
        const nextValue = el.value.slice(0, start) + text + el.value.slice(end);
        const nextCursor = start + text.length;

        setNativeInputValue(el, nextValue);
        try {
            el.setSelectionRange(nextCursor, nextCursor);
        } catch (e) {
            // 部分输入类型不支持选区设置，值已经写入即可。
        }
        el.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            composed: true,
            inputType: 'insertText',
            data: text
        }));
        return true;
    }

    function getEditableElement(node) {
        if (!node) return null;
        const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        return el ? el.closest('[contenteditable="true"], [contenteditable="plaintext-only"]') : null;
    }

    function isInsideEditableElement(el) {
        return Boolean(el?.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]'));
    }

    function insertIntoContentEditable(text) {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return false;

        const editable = getEditableElement(selection.anchorNode);
        if (!editable || editable !== getEditableElement(selection.focusNode)) return false;

        const range = selection.getRangeAt(0);
        range.deleteContents();

        const textNode = document.createTextNode(text);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);

        selection.removeAllRanges();
        selection.addRange(range);

        editable.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            composed: true,
            inputType: 'insertText',
            data: text
        }));
        return true;
    }

    function insertTextAtCursor(text) {
        try {
            if (document.queryCommandSupported?.('insertText') && document.execCommand('insertText', false, text)) {
                return true;
            }
        } catch (e) {
            // 某些页面会禁用 execCommand，继续走输入框和 contenteditable 兜底。
        }

        const active = getDeepActiveElement();
        if (isTextInput(active) && insertIntoTextInput(active, text)) {
            return true;
        }

        return insertIntoContentEditable(text);
    }

    function getTextInputTarget() {
        const active = getDeepActiveElement();
        if (isTextInput(active)) return active;

        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
            return getEditableElement(selection.anchorNode);
        }

        return isInsideEditableElement(active) ? active.closest('[contenteditable="true"], [contenteditable="plaintext-only"]') : null;
    }

    function getKeyInfo(char) {
        if (char === '/') {
            return { key: '/', code: 'Slash' };
        }

        return { key: char, code: '' };
    }

    function dispatchTextInputEvents(target, char) {
        if (!target) return { keydownPrevented: false, keypressPrevented: false, beforeInputPrevented: false };

        const { key, code } = getKeyInfo(char);
        const keydown = new KeyboardEvent('keydown', {
            key,
            code,
            bubbles: true,
            cancelable: true,
            composed: true
        });
        const keydownPrevented = !target.dispatchEvent(keydown);

        const keypress = new KeyboardEvent('keypress', {
            key,
            code,
            bubbles: true,
            cancelable: true,
            composed: true
        });
        const keypressPrevented = !target.dispatchEvent(keypress);

        const beforeInput = new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            composed: true,
            inputType: 'insertText',
            data: char
        });
        const beforeInputPrevented = !target.dispatchEvent(beforeInput);

        return { keydownPrevented, keypressPrevented, beforeInputPrevented };
    }

    function dispatchTextKeyup(target, char) {
        if (!target) return;

        const { key, code } = getKeyInfo(char);
        target.dispatchEvent(new KeyboardEvent('keyup', {
            key,
            code,
            bubbles: true,
            cancelable: true,
            composed: true
        }));
    }

    function typeCharacterLikeKeyboard(char) {
        const target = getTextInputTarget();
        const { keydownPrevented, keypressPrevented, beforeInputPrevented } = dispatchTextInputEvents(target, char);

        if (!keydownPrevented && !keypressPrevented && !beforeInputPrevented) {
            insertTextAtCursor(char);
        }

        dispatchTextKeyup(target, char);
        return true;
    }

    function hasFeishuEditingFocus() {
        if (!document.hasFocus()) return false;

        const active = getDeepActiveElement();
        if (isTextInput(active) || isInsideEditableElement(active)) return true;

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return false;

        const anchorEditable = getEditableElement(selection.anchorNode);
        const focusEditable = getEditableElement(selection.focusNode);
        return Boolean(anchorEditable && anchorEditable === focusEditable);
    }

    function wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function isVisibleElement(el) {
        if (!el || !(el instanceof Element)) return false;

        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) {
            return false;
        }

        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function getElementText(el) {
        return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function getClickableElement(el) {
        if (!el) return null;
        return el.closest('button, [role="button"], [role="menuitem"], [role="option"], [tabindex], li, a') || el;
    }

    function collectElementsDeep(root, selector, results = []) {
        if (!root?.querySelectorAll) return results;

        root.querySelectorAll('*').forEach(el => {
            if (el.matches(selector)) results.push(el);
            if (el.shadowRoot) collectElementsDeep(el.shadowRoot, selector, results);
        });

        return results;
    }

    function clickElement(el) {
        if (!isVisibleElement(el)) return false;

        const rect = el.getBoundingClientRect();
        const options = {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            button: 0,
            buttons: 1
        };

        el.dispatchEvent(new MouseEvent('mousemove', options));
        el.dispatchEvent(new MouseEvent('mousedown', options));
        el.dispatchEvent(new MouseEvent('mouseup', { ...options, buttons: 0 }));
        if (typeof el.click === 'function') el.click();
        return true;
    }

    function isFeishuFormulaEditorOpen() {
        const candidates = collectElementsDeep(document, 'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], div, span');

        return candidates.some(el => {
            if (!isVisibleElement(el)) return false;

            const placeholder = el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || '';
            const text = getElementText(el);

            return placeholder.includes('请输入公式') ||
                text.includes('请输入公式') ||
                text.includes('按 ESC 完成输入');
        });
    }

    function isLikelyInteractiveElement(el) {
        if (!el) return false;
        const className = el.className?.toString() || '';
        const style = window.getComputedStyle(el);

        return ['BUTTON', 'A', 'LI'].includes(el.tagName) ||
            el.hasAttribute('role') ||
            el.hasAttribute('tabindex') ||
            style.cursor === 'pointer' ||
            /menu|dropdown|popover|toolbar|slash|command|item|option/i.test(className);
    }

    function getFormulaMenuItemClickTarget(el) {
        let best = getClickableElement(el);
        let bestArea = 0;
        let current = el;
        let depth = 0;

        while (current && current !== document.body && depth < 8) {
            if (isVisibleElement(current)) {
                const text = getElementText(current);
                const rect = current.getBoundingClientRect();
                const looksLikeMenuRow = text &&
                    text.length <= 100 &&
                    FEISHU_FORMULA_LABEL_PATTERN.test(text) &&
                    rect.width >= 80 &&
                    rect.height >= 24 &&
                    rect.height <= 80;

                if (looksLikeMenuRow) {
                    const area = rect.width * rect.height;
                    if (isLikelyInteractiveElement(current) || area > bestArea) {
                        best = current;
                        bestArea = area;
                    }
                }
            }

            current = current.parentElement;
            depth += 1;
        }

        return best || el;
    }

    function clickFeishuFormulaMenuItem(strict = false) {
        const candidates = collectElementsDeep(document, 'button, [role="button"], [role="menuitem"], [role="option"], li, div, span');
        const matches = candidates
            .filter(isVisibleElement)
            .filter(el => !isInsideEditableElement(el))
            .map(el => ({ el, text: getElementText(el) }))
            .filter(({ text }) => {
                if (!text || text.length > 80) return false;
                if (text.includes('帮助') || text.includes('ESC') || text.includes('请输入公式')) return false;
                return FEISHU_FORMULA_LABEL_PATTERN.test(text);
            })
            .filter(({ el, text }) => {
                if (/LaTeX/i.test(text) || text.includes('添加')) return true;
                if (strict) return false;

                const clickTarget = getClickableElement(el);
                return isLikelyInteractiveElement(clickTarget) || isLikelyInteractiveElement(el);
            })
            .sort((a, b) => {
                const aScore = Number(/LaTeX/i.test(a.text)) + Number(a.text.includes('添加'));
                const bScore = Number(/LaTeX/i.test(b.text)) + Number(b.text.includes('添加'));
                return bScore - aScore;
            });

        for (const { el } of matches) {
            const clickTarget = getFormulaMenuItemClickTarget(el);
            if (clickElement(clickTarget)) return true;
        }

        return false;
    }

    async function typeTextAtCursor(text) {
        let inserted = false;

        for (const char of text) {
            inserted = typeCharacterLikeKeyboard(char) || inserted;
            if (char === '/') await wait(35);
        }

        return inserted;
    }

    async function clickFeishuFormulaMenuItemUntilOpen(strict = false, attempts = 4) {
        for (let i = 0; i < attempts; i += 1) {
            if (clickFeishuFormulaMenuItem(strict)) {
                await wait(150);
                if (isFeishuFormulaEditorOpen()) return true;
                return true;
            }

            await wait(100);
        }

        return false;
    }

    async function openFeishuFormulaBlock() {
        const now = Date.now();
        if (isOpeningFeishuFormula || now - lastFeishuFormulaOpenAt < 300) return false;

        isOpeningFeishuFormula = true;
        lastFeishuFormulaOpenAt = now;

        try {
            if (isFeishuFormulaEditorOpen()) return true;

            if (await clickFeishuFormulaMenuItemUntilOpen(true, 1)) return true;

            await typeTextAtCursor(FEISHU_FORMULA_SEARCH);
            await wait(250);

            if (await clickFeishuFormulaMenuItemUntilOpen(false, 5)) return true;

            return false;
        } finally {
            isOpeningFeishuFormula = false;
        }
    }

    function initFeishuDollarShortcut() {
        if (!isFeishuDocPage()) return;

        window.addEventListener('keydown', (e) => {
            if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat) return;
            if (e.code !== 'Digit4' && e.key !== '4') return;

            e.preventDefault();
            e.stopImmediatePropagation();
            openFeishuFormulaBlock();
        }, true);

        console.log('[yukonChromeExtension] 飞书云文档 Ctrl+4 公式块快捷输入已激活');
    }

    function executeNavigation(direction) {
        const isNext = direction === 'next';
        const targetText = isNext ? '下集' : '上集';

        // 1. 深度搜索
        function findElementDeep(root, target) {
            const isNext = target === '下集';
            // 优先查找真正的链接和按钮
            const clickables = root.querySelectorAll('a, button');
            for (const el of clickables) {
                const text = (el.innerText || el.textContent || '').trim();
                const className = (el.className || '').toString().toLowerCase();
                const href = (el.getAttribute('href') || '');
                
                // 排除干扰项：收藏按钮、报错按钮、分享按钮、javascript脚本链接
                if (className.includes('collection') || className.includes('report') || 
                    className.includes('share') || href.includes('javascript:')) {
                    continue;
                }

                // 核心判定：必须包含目标文字，且不能太长
                if (text.includes(target) && text.length < 10) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) return el;
                }
            }

            // 如果没找到，尝试在特定的容器内找
            const functionZone = root.querySelector('.anthology-header .function');
            if (functionZone) {
                const zoneLinks = functionZone.querySelectorAll('a');
                for (const el of zoneLinks) {
                    const href = (el.getAttribute('href') || '');
                    if (href.includes('javascript:')) continue;
                    
                    // 通常结构是 [上集, 收藏, 报错, 分享, 下集]
                    // 也可以根据位置尝试，但文本识别更准
                    if (el.innerText.includes(target)) return el;
                }
            }
            
            // 递归 Shadow DOM
            const all = root.querySelectorAll('*');
            for (const el of all) {
                if (el.shadowRoot) {
                    const found = findElementDeep(el.shadowRoot, target);
                    if (found) return found;
                }
            }
            return null;
        }

        let targetBtn = findElementDeep(document, targetText);

        // 2. URL 预测逻辑 (支持多网站模式)
        if (!targetBtn && isNext) {
            console.log(`[yukonChromeExtension] 尝试从 URL 预测下一集...`);
            
            let match = window.location.href.match(/(.*\/watch\/\d+\/\d+\/)(\d+)(\.html)/); // 模式 A: cycani
            if (!match) {
                match = window.location.href.match(/(.*\/bangumi\/\d+-\d+-)(\d+)(\/?)/); // 模式 B: mgnacg
            }

            if (match) {
                const prefix = match[1];
                const currentNum = parseInt(match[2]);
                const nextNum = currentNum + 1;
                const suffix = match[3];
                const nextFullUrl = prefix + nextNum + suffix;
                const nextPart = nextNum + suffix;

                console.log(`[yukonChromeExtension] 预测目标 URL: ${nextFullUrl}`);

                const allLinks = document.querySelectorAll('a[href]');
                for (const a of allLinks) {
                    const aHref = a.getAttribute('href') || '';
                    if (aHref.includes(nextPart) || a.href.includes(nextPart)) {
                        console.log(`[yukonChromeExtension] 在页面中找到了匹配的 URL 链接!`);
                        targetBtn = a;
                        break;
                    }
                }

                if (!targetBtn) {
                    console.log(`[yukonChromeExtension] 页面中未找到匹配链接，执行【强制跳转】模式`);
                    showIndicator(`强制跳转至下一集...`);
                    window.location.href = nextFullUrl;
                    return;
                }
            }
        }

        if (targetBtn) {
            console.log(`[yukonChromeExtension] 定位成功，准备点击:`, targetBtn);
            showIndicator(`跳转至${targetText}...`);
            
            // 针对 a 标签跳转的特殊处理
            const clickTarget = targetBtn.closest('a') || targetBtn.closest('button') || targetBtn;
            
            if (clickTarget.tagName === 'A' && clickTarget.href && !clickTarget.href.includes('javascript:')) {
                console.log(`[yukonChromeExtension] 检测到链接地址，执行强制跳转: ${clickTarget.href}`);
                window.location.href = clickTarget.href;
            } else {
                clickTarget.click();
            }
            return;
        }
    }

    // 清理界面上的干扰元素 (安全版本：仅针对特定横幅)
    function cleanupUI() {
        const targetText = 'iOS若播放失败请更换夸克浏览器';
        
        // 1. 寻找直接包含该文字的特定横幅容器
        const allElements = document.querySelectorAll('div, li, section');
        allElements.forEach(el => {
            // 检查元素是否直接包含该文本节点，避免误伤父级大容器
            const hasDirectText = Array.from(el.childNodes).some(node => 
                node.nodeType === Node.TEXT_NODE && node.textContent.includes(targetText)
            );

            if (hasDirectText) {
                const rect = el.getBoundingClientRect();
                // 横幅通常高度较小且包含关闭按钮特征
                const hasCloseBtn = el.querySelector('.fa-close, .close, [class*="close"], .fa-times');
                const isTicker = el.classList.contains('player-news') || el.classList.contains('ds-news-list');
                
                if (hasCloseBtn || isTicker || (rect.height > 0 && rect.height < 100)) {
                    el.style.setProperty('display', 'none', 'important');
                    console.log('[yukonChromeExtension] 已成功移除干扰横幅');
                }
            }
        });
    }

    // 持续监听 DOM 变化以清理新生成的干扰元素
    function observeUI() {
        const observer = new MutationObserver(() => {
            cleanupUI();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // --- 强制暗色模式 ---
    function initDarkMode() {
        const cssId = 'yukon-force-dark-mode-css';
        const className = 'yukon-force-dark-mode';

        const ensureStyle = () => {
            if (document.getElementById(cssId)) return;

            const style = document.createElement('style');
            style.id = cssId;
            style.textContent = `
                html.${className} {
                    background-color: #ffffff !important;
                    color-scheme: dark !important;
                    filter: invert(1) hue-rotate(180deg) !important;
                }
                html.${className} body {
                    background-color: #ffffff !important;
                    color: #111111 !important;
                }
                html.${className} input,
                html.${className} textarea,
                html.${className} select,
                html.${className} button {
                    background-color: #f2f2f2 !important;
                    color: #111111 !important;
                    border-color: #bbbbbb !important;
                }
                html.${className} img,
                html.${className} picture,
                html.${className} video,
                html.${className} canvas,
                html.${className} object,
                html.${className} embed,
                html.${className} [style*="background-image"] {
                    filter: invert(1) hue-rotate(180deg) !important;
                }
            `;
            (document.head || document.documentElement).appendChild(style);
        };

        const setEnabled = (enabled) => {
            if (enabled) {
                ensureStyle();
                document.documentElement.classList.add(className);
            } else {
                document.documentElement.classList.remove(className);
                const style = document.getElementById(cssId);
                if (style) style.remove();
            }
        };

        chrome.storage.sync.get({ darkMode: false }, (items) => {
            setEnabled(Boolean(items.darkMode));
        });

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'sync' && changes.darkMode) {
                setEnabled(Boolean(changes.darkMode.newValue));
            }
        });
    }

    // --- 超级复制功能 ---
    function initSuperCopy() {
        // 只拦截关键的复制保护事件，移除 mousedown/mouseup 以免干扰播放器控制
        const events = ['copy', 'cut', 'paste', 'selectstart', 'contextmenu', 'dragstart'];
        const handler = (e) => {
            e.stopPropagation();
            e.stopImmediatePropagation();
            return true;
        };

        const cssId = 'cyc-super-copy-css';
        const enable = () => {
            // 1. 强制注入 CSS 允许选择
            if (!document.getElementById(cssId)) {
                const style = document.createElement('style');
                style.id = cssId;
                style.textContent = `
                    * {
                        user-select: text !important;
                        -webkit-user-select: text !important;
                        -moz-user-select: text !important;
                        -ms-user-select: text !important;
                    }
                `;
                document.head.appendChild(style);
            }

            // 2. 拦截并停止所有阻止复制的事件
            events.forEach(evt => {
                document.addEventListener(evt, handler, true);
                window.addEventListener(evt, handler, true);
            });

            // 3. 覆盖 document 上的原生处理器
            const nullifier = () => true;
            document.oncontextmenu = nullifier;
            document.onselectstart = nullifier;
            document.oncopy = nullifier;
            
            console.log('[yukonChromeExtension] 超级复制模式已激活');
        };

        const disable = () => {
            const style = document.getElementById(cssId);
            if (style) style.remove();

            events.forEach(evt => {
                document.removeEventListener(evt, handler, true);
                window.removeEventListener(evt, handler, true);
            });
            console.log('[yukonChromeExtension] 超级复制模式已关闭');
        };

        // 初始加载
        chrome.storage.sync.get({ superCopy: false }, (items) => {
            if (items.superCopy) enable();
        });

        // 监听开关变化
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'sync' && changes.superCopy) {
                if (changes.superCopy.newValue) enable();
                else disable();
            }
        });
    }

    // --- 自动隐藏鼠标功能 ---
    function initAutoHideMouse() {
        const cssId = 'yukon-hide-mouse-css';
        if (!document.getElementById(cssId)) {
            const style = document.createElement('style');
            style.id = cssId;
            style.textContent = `
                .yukon-hide-cursor {
                    cursor: none !important;
                }
            `;
            document.head.appendChild(style);
        }

        const showMouse = () => {
            document.documentElement.classList.remove('yukon-hide-cursor');
            clearTimeout(mouseTimer);
            
            // 仅在全屏模式下启动隐藏计时器
            if (document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement) {
                mouseTimer = setTimeout(() => {
                    document.documentElement.classList.add('yukon-hide-cursor');
                }, HIDE_MOUSE_DELAY);
            }
        };

        window.addEventListener('mousemove', showMouse, true);
        document.addEventListener('fullscreenchange', showMouse);
        document.addEventListener('webkitfullscreenchange', showMouse);
        document.addEventListener('mozfullscreenchange', showMouse);
    }

    async function start() {
        initDarkMode(); // 暗色模式作用于所有可注入页面，不受视频白名单限制
        initFeishuDollarShortcut(); // 飞书云文档快捷输入不受视频白名单限制

        const allowed = await checkPermission();
        if (!allowed) return;

        console.log('[yukonChromeExtension] 插件已在当前页面激活');
        
        initSuperCopy(); // 启动超级复制功能
        initAutoHideMouse(); // 启动自动隐藏鼠标功能
        cleanupUI();
        observeUI(); // 开启持续监听

        // 关键：在捕获阶段监听，并且始终拦截 ArrowRight
        window.addEventListener('keydown', (e) => {
            if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

            if (e.code === 'ArrowRight') {
                // 只要在白名单页面，一律拦截默认行为和后续传播
                e.preventDefault();
                e.stopImmediatePropagation();

                if (e.repeat) return;

                // 统一通过广播处理
                if (!speedTimer) {
                    speedTimer = setTimeout(() => {
                        speedTimer = null; // 标记长按已开启
                        chrome.runtime.sendMessage({ type: 'SYNC_SPEED', action: 'start' });
                    }, LONG_PRESS_THRESHOLD);
                }
            }

            if (e.key === '[') handleEpisode('prev');
            if (e.key === ']') handleEpisode('next');
        }, true);

        window.addEventListener('keyup', (e) => {
            if (e.code === 'ArrowRight') {
                e.preventDefault();
                e.stopImmediatePropagation();

                if (speedTimer) {
                    clearTimeout(speedTimer);
                    speedTimer = null;
                    // 短按：广播快进
                    chrome.runtime.sendMessage({ type: 'SYNC_SPEED', action: 'seek', seconds: 5 });
                } else {
                    // 长按结束：广播停止
                    chrome.runtime.sendMessage({ type: 'SYNC_SPEED', action: 'stop' });
                }
            }
        }, true);

        // 倍速保活逻辑
        setInterval(() => {
            if (isSpeeding) {
                const v = getVideo();
                if (v && v.playbackRate !== SPEED_UP_RATE) {
                    v.playbackRate = SPEED_UP_RATE;
                }
            }
        }, 400);
    }

    start();
})();
