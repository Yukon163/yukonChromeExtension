(function installFeishuCopyPermissionHook() {
    'use strict';

    const HOOK_FLAG = '__yukonFeishuCopyPermissionHooked__';
    const PERMISSION_ENDPOINTS = [
        /\/space\/api\/[^?#]*permission\/document\/actions\/state\/?/i,
        /\/base\/ssr\/header(?:[/?#]|$)/i
    ];

    if (window[HOOK_FLAG]) return;

    Object.defineProperty(window, HOOK_FLAG, {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false
    });

    function isPermissionRequest(url) {
        const requestUrl = String(url || '');
        return PERMISSION_ENDPOINTS.some((pattern) => pattern.test(requestUrl));
    }

    function isBitablePage() {
        return /^\/(?:base|app)\//i.test(location.pathname);
    }

    function unlockCopyAction(actions) {
        if (!actions || typeof actions !== 'object') return false;

        let modified = false;

        if (actions.copy !== 1 && actions.copy !== true) {
            actions.copy = 1;
            modified = true;
        }

        // Base 的网格剪贴板同时要求 contentCopy 与 export。
        // 文档页只需 copy；限定到 Base / AppMode，避免扩大普通文档能力。
        if (isBitablePage() && actions.export !== 1 && actions.export !== true) {
            actions.export = 1;
            modified = true;
        }

        return modified;
    }

    function unlockCopyPermission(payload) {
        if (!payload || typeof payload !== 'object') return false;

        let modified = false;
        const visited = new Set();

        function visit(node, depth = 0) {
            if (!node || typeof node !== 'object' || visited.has(node) || depth > 6) return;
            visited.add(node);

            for (const key of ['actions', 'Actions']) {
                if (node[key] && typeof node[key] === 'object') {
                    modified = unlockCopyAction(node[key]) || modified;
                }
            }

            if (Array.isArray(node)) {
                node.forEach((item) => visit(item, depth + 1));
                return;
            }

            // Base 首屏权限位于 data.__HEADER_PERMS__.authPerm.Actions；
            // 文档接口则通常位于 data.actions。权限响应内统一递归处理。
            for (const value of Object.values(node)) {
                visit(value, depth + 1);
            }
        }

        visit(payload);
        return modified;
    }

    function installXhrHook() {
        const nativeOpen = XMLHttpRequest.prototype.open;

        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            const requestUrl = String(url || '');

            if (isPermissionRequest(requestUrl)) {
                this.addEventListener('readystatechange', () => {
                    if (this.readyState !== XMLHttpRequest.DONE) return;

                    try {
                        let rawResponse;
                        try {
                            rawResponse = this.responseText;
                        } catch {
                            rawResponse = this.response;
                        }

                        const payload = typeof rawResponse === 'string'
                            ? JSON.parse(rawResponse)
                            : rawResponse;

                        if (!unlockCopyPermission(payload)) return;

                        const serialized = JSON.stringify(payload);
                        Object.defineProperty(this, 'responseText', {
                            get: () => serialized,
                            configurable: true
                        });
                        Object.defineProperty(this, 'response', {
                            get: () => this.responseType === 'json' ? payload : serialized,
                            configurable: true
                        });
                        console.log('[yukonChromeExtension] 飞书复制权限已解锁', {
                            bitable: isBitablePage()
                        });
                    } catch (error) {
                        console.debug('[yukonChromeExtension] 飞书 XHR 复制权限响应处理失败:', error);
                    }
                }, true);
            }

            return nativeOpen.call(this, method, url, ...rest);
        };
    }

    function installFetchHook() {
        const nativeFetch = window.fetch;
        if (typeof nativeFetch !== 'function') return;

        window.fetch = async function(input, init) {
            const requestUrl = String(typeof input === 'string' ? input : input?.url || '');
            const response = await nativeFetch.call(this, input, init);
            if (!isPermissionRequest(requestUrl)) return response;

            try {
                const payload = await response.clone().json();
                if (!unlockCopyPermission(payload)) return response;

                const headers = new Headers(response.headers);
                headers.delete('content-length');
                headers.delete('content-encoding');
                if (!headers.has('content-type')) {
                    headers.set('content-type', 'application/json; charset=utf-8');
                }

                return new Response(JSON.stringify(payload), {
                    status: response.status,
                    statusText: response.statusText,
                    headers
                });
            } catch (error) {
                console.debug('[yukonChromeExtension] 飞书 fetch 复制权限响应处理失败:', error);
                return response;
            }
        };
    }

    function getSelectionPayload() {
        const selection = window.getSelection?.();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

        const text = selection.toString();
        const container = document.createElement('div');

        for (let index = 0; index < selection.rangeCount; index += 1) {
            container.appendChild(selection.getRangeAt(index).cloneContents());
        }

        const html = container.innerHTML;
        if (!text && !html) return null;
        return { text, html };
    }

    function forceSelectionCopy(event) {
        const payload = getSelectionPayload();
        if (!payload || !event.clipboardData) return;

        try {
            event.clipboardData.clearData();
            event.clipboardData.setData('text/plain', payload.text);
            if (payload.html) event.clipboardData.setData('text/html', payload.html);
            event.preventDefault();
            event.stopImmediatePropagation();
        } catch (error) {
            console.debug('[yukonChromeExtension] 飞书选区复制兜底失败:', error);
        }
    }

    installXhrHook();
    installFetchHook();

    console.log('[yukonChromeExtension] 飞书复制权限钩子已安装');

    // 权限接口或页面结构再次变化时，仍保证普通 DOM 选区可以复制。
    window.addEventListener('copy', forceSelectionCopy, true);
})();
