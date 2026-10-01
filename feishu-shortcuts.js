(function installFeishuShortcutBridge() {
    'use strict';

    const CENTER_SHORTCUT_REQUEST_EVENT = 'yukon-feishu-center-shortcut-request';
    const HOOK_FLAG = '__yukonFeishuShortcutBridgeInstalled__';

    if (window[HOOK_FLAG]) return;

    Object.defineProperty(window, HOOK_FLAG, {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false
    });

    function createShortcutKeyboardEvent(type) {
        const event = new KeyboardEvent(type, {
            // 真实 Shift+E 的 key 是大写 E，而不是小写 e。
            key: 'E',
            code: 'KeyE',
            ctrlKey: true,
            shiftKey: true,
            altKey: false,
            metaKey: false,
            repeat: false,
            location: KeyboardEvent.DOM_KEY_LOCATION_STANDARD,
            view: window,
            bubbles: true,
            cancelable: true,
            composed: true
        });

        // Chromium 通过构造器创建 KeyboardEvent 时会把旧字段保留为 0，
        // 一些快捷键匹配器仍使用 keyCode / which，因此在页面主世界补齐。
        for (const property of ['keyCode', 'which']) {
            if (event[property] === 69) continue;

            try {
                Object.defineProperty(event, property, {
                    configurable: true,
                    enumerable: true,
                    get: () => 69
                });
            } catch (e) {
                // 标准 key / code 仍可供现代快捷键处理器使用。
            }
        }

        return event;
    }

    document.addEventListener(CENTER_SHORTCUT_REQUEST_EVENT, (request) => {
        request.stopImmediatePropagation();

        const target = request.target instanceof EventTarget ? request.target : document;
        const keydown = createShortcutKeyboardEvent('keydown');
        const handled = !target.dispatchEvent(keydown) || keydown.defaultPrevented;

        target.dispatchEvent(createShortcutKeyboardEvent('keyup'));

        if (handled) request.preventDefault();

        console.debug('[yukonChromeExtension] MAIN world 居中快捷键事件', {
            key: keydown.key,
            code: keydown.code,
            keyCode: keydown.keyCode,
            which: keydown.which,
            defaultPrevented: keydown.defaultPrevented,
            target
        });
    }, true);
})();
