// CSDN 优化模块

(function() {
    'use strict';

    // 检查是否开启 CSDN 优化
    chrome.storage.sync.get({ csdnOptimize: true }, (items) => {
        if (!items.csdnOptimize) return;

        console.log('CSDN Optimizer: 模块已启动');
        initLinkOptimizer();
        initContentCleaner();
    });

    // 1. 链接跳转优化
    function initLinkOptimizer() {
        if (window.location.hostname === 'link.csdn.net') {
            const params = new URLSearchParams(window.location.search);
            const target = params.get('target');
            if (target) {
                const decodedUrl = decodeURIComponent(target);
                console.log('CSDN Optimizer: 正在跳转到 ->', decodedUrl);
                window.location.replace(decodedUrl);
            }
        }
    }

    // 2. 内容净化与去广告逻辑
    function initContentCleaner() {
        console.log('CSDN Optimizer: 开始净化页面...');

        // 解除复制限制
        const events = ['copy', 'cut', 'contextmenu', 'selectstart', 'mousedown', 'mouseup', 'keydown', 'keypress', 'keyup'];
        events.forEach(event => {
            document.documentElement.addEventListener(event, function(e) {
                e.stopPropagation();
            }, { capture: true });
        });

        // 定时清理任务
        const cleanInterval = setInterval(() => {
            // 移除代码块上的限制
            document.querySelectorAll('.hljs-button').forEach(btn => {
                btn.removeAttribute('onclick');
                btn.removeAttribute('data-report-click');
                btn.setAttribute('data-title', '可直接复制');
                
                // 重新绑定复制逻辑
                btn.onclick = function(e) {
                    e.stopPropagation();
                    const pre = this.closest('pre');
                    if (pre) {
                        const code = pre.querySelector('code').innerText;
                        navigator.clipboard.writeText(code).then(() => {
                            this.setAttribute('data-title', '复制成功！');
                            setTimeout(() => this.setAttribute('data-title', '可直接复制'), 2000);
                        });
                    }
                };
            });

            // 移除拦截逻辑
            if (window.articleType) window.articleType = 0;
            
            // 强制允许滚动
            document.body.style.overflow = 'auto';
            document.documentElement.style.overflow = 'auto';

        }, 1000);

        // 10秒后停止高频检查
        setTimeout(() => clearInterval(cleanInterval), 10000);
    }
})();
