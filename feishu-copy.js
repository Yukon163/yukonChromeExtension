(function installFeishuCopyPermissionHook() {
    'use strict';

    const HOOK_FLAG = '__yukonFeishuCopyPermissionHooked__';
    const PERMISSION_ENDPOINT = /\/space\/api\/[^?#]*permission\/document\/actions\/state\/?/i;

    if (window[HOOK_FLAG]) return;

    Object.defineProperty(window, HOOK_FLAG, {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false
    });

    function isPermissionRequest(url) {
        return PERMISSION_ENDPOINT.test(String(url || ''));
    }

    function unlockCopyAction(actions) {
        if (!actions || typeof actions !== 'object') return false;
        if (actions.copy === 1 || actions.copy === true) return false;

        actions.copy = 1;
        return true;
    }

    function unlockCopyPermission(payload) {
        if (!payload || typeof payload !== 'object') return false;

        let modified = false;
        const visited = new Set();

        function visit(node, depth = 0) {
            if (!node || typeof node !== 'object' || visited.has(node) || depth > 6) return;
            visited.add(node);

            if (node.actions && typeof node.actions === 'object') {
                modified = unlockCopyAction(node.actions) || modified;
            }

            if (Array.isArray(node)) {
                node.forEach((item) => visit(item, depth + 1));
                return;
            }

            for (const key of ['data', 'permission', 'permissions', 'result']) {
                visit(node[key], depth + 1);
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

    // 权限接口或页面结构再次变化时，仍保证普通 DOM 选区可以复制。
    window.addEventListener('copy', forceSelectionCopy, true);
})();
