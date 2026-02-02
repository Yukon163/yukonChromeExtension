(function() {
    let speedTimer = null;
    let isSpeeding = false;
    let originalRate = 1;
    let activeVideo = null;
    const SPEED_UP_RATE = 2.0;
    const LONG_PRESS_THRESHOLD = 250;

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
                    console.log(`[VideoSpeed] 当前域名 ${host} 不在白名单中。如需在当前站点使用，请在插件选项页添加该域名。`);
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
        
        console.log(`[VideoSpeed] 正在发起广播: ${targetText}`);

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
            console.log(`[VideoSpeed] 主页面收到切集指令: ${msg.direction}`);
            executeNavigation(msg.direction);
        } else if (msg.type === 'SYNC_SPEED') {
            handleSyncSpeed(msg);
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
            console.log(`[VideoSpeed] 尝试从 URL 预测下一集...`);
            
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

                console.log(`[VideoSpeed] 预测目标 URL: ${nextFullUrl}`);

                const allLinks = document.querySelectorAll('a[href]');
                for (const a of allLinks) {
                    const aHref = a.getAttribute('href') || '';
                    if (aHref.includes(nextPart) || a.href.includes(nextPart)) {
                        console.log(`[VideoSpeed] 在页面中找到了匹配的 URL 链接!`);
                        targetBtn = a;
                        break;
                    }
                }

                if (!targetBtn) {
                    console.log(`[VideoSpeed] 页面中未找到匹配链接，执行【强制跳转】模式`);
                    showIndicator(`强制跳转至下一集...`);
                    window.location.href = nextFullUrl;
                    return;
                }
            }
        }

        if (targetBtn) {
            console.log(`[VideoSpeed] 定位成功，准备点击:`, targetBtn);
            showIndicator(`跳转至${targetText}...`);
            
            // 针对 a 标签跳转的特殊处理
            const clickTarget = targetBtn.closest('a') || targetBtn.closest('button') || targetBtn;
            
            if (clickTarget.tagName === 'A' && clickTarget.href && !clickTarget.href.includes('javascript:')) {
                console.log(`[VideoSpeed] 检测到链接地址，执行强制跳转: ${clickTarget.href}`);
                window.location.href = clickTarget.href;
            } else {
                clickTarget.click();
            }
            return;
        }
    }

    // 清理界面上的干扰元素 (安全版本：定位特定横幅并移除)
    function cleanupUI() {
        const targetText = 'iOS若播放失败请更换夸克浏览器';
        
        // 1. 寻找包含该文字的特定横幅容器
        const allElements = document.querySelectorAll('div, li, section');
        allElements.forEach(el => {
            // 检查元素自身的文本内容（移除空格）
            const content = (el.innerText || el.textContent || '').replace(/\s+/g, '');
            if (content.includes(targetText)) {
                // 核心判断：如果这个元素包含一个关闭按钮（通常是带有 'fa-close' 或类似类的 i 标签，或者像截图里的红色 X）
                // 或者它是一个明显的提示栏容器
                const hasCloseBtn = el.querySelector('.fa-close, .close, [class*="close"], .fa-times');
                const isTicker = el.classList.contains('player-news') || el.classList.contains('ds-news-list');
                
                if (hasCloseBtn || isTicker) {
                    // 找到了横幅容器，将其隐藏
                    el.style.setProperty('display', 'none', 'important');
                    console.log('[VideoSpeed] 已成功移除干扰横幅');
                } else {
                    // 如果没找到明显的容器，但它确实包含这段文字，且高度较小（横幅特征）
                    const rect = el.getBoundingClientRect();
                    if (rect.height > 0 && rect.height < 100) {
                        el.style.setProperty('display', 'none', 'important');
                    }
                }
            }
        });

        // 2. 备用：TreeWalker 清理残余文字节点
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while(node = walker.nextNode()) {
            if (node.textContent.replace(/\s+/g, '').includes(targetText)) {
                node.textContent = '';
            }
        }
    }

    // 持续监听 DOM 变化以清理新生成的干扰元素
    function observeUI() {
        const observer = new MutationObserver(() => {
            cleanupUI();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // --- 超级复制功能 ---
    function initSuperCopy() {
        const events = ['copy', 'cut', 'paste', 'selectstart', 'contextmenu', 'dragstart', 'mousedown', 'mouseup'];
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
            document.onmousedown = nullifier;
            
            console.log('[PersonalAssistant] 超级复制模式已激活');
        };

        const disable = () => {
            const style = document.getElementById(cssId);
            if (style) style.remove();

            events.forEach(evt => {
                document.removeEventListener(evt, handler, true);
                window.removeEventListener(evt, handler, true);
            });
            console.log('[PersonalAssistant] 超级复制模式已关闭');
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

    async function start() {
        const allowed = await checkPermission();
        if (!allowed) return;

        console.log('[VideoSpeed] 插件已在当前页面激活');
        
        initSuperCopy(); // 启动超级复制功能
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
