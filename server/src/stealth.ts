/**
 * Comprehensive stealth script to bypass bot detection.
 * Inspired by puppeteer-extra-plugin-stealth and modern bot bypass techniques.
 */
export const STEALTH_SCRIPT = `
(function() {
    const safely = (patch) => {
        try {
            patch();
        } catch (error) {
            // Stealth must never break the page's own boot scripts.
            console.debug('[Aether stealth] patch skipped', error);
        }
    };

    // Helper to make overridden functions look native
    const makeNative = (fn, name) => {
        Object.defineProperty(fn, 'name', { value: name, configurable: true });
        Object.defineProperty(fn, 'toString', {
            value: () => \`function \${name}() { [native code] }\`,
            configurable: true,
            writable: true
        });
    };

    // Helper to mock getters native-style
    const mockGetter = (obj, prop, value) => {
        if (!obj) return;
        const desc = Object.getOwnPropertyDescriptor(obj, prop) || {
            configurable: true,
            enumerable: true
        };
        if (desc.configurable === false) return;
        const getter = () => value;
        makeNative(getter, \`get \${prop}\`);
        Object.defineProperty(obj, prop, {
            ...desc,
            get: getter
        });
    };

    // 1. Remove navigator.webdriver (or set to undefined native-style)
    safely(() => mockGetter(navigator, 'webdriver', undefined));

    // 2. Mock chrome.runtime without replacing existing Chrome globals.
    safely(() => {
        const chromeObj = window.chrome || {};
        chromeObj.runtime = chromeObj.runtime || {};
        Object.assign(chromeObj.runtime, {
            OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
            OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
            PlatformArch: { ARM: 'arm', ARM64: 'arm64', X86_32: 'x86-32', X86_64: 'x86-64' },
            PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
            PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
            RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available', THROTTLED: 'throttled' }
        });
        window.chrome = chromeObj;
    });

    // 3. Spoof navigator.languages
    safely(() => mockGetter(navigator, 'languages', ['en-US', 'en']));

    // 4. Spoof navigator.plugins
    safely(() => mockGetter(navigator, 'plugins', (() => {
        const plugins = [
            { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }
        ];
        const p = [...plugins];
        p.item = (i) => plugins[i];
        p.namedItem = (n) => plugins.find(x => x.name === n);
        p.refresh = () => {};
        
        makeNative(p.item, 'item');
        makeNative(p.namedItem, 'namedItem');
        makeNative(p.refresh, 'refresh');
        
        return p;
    })()));

    // 5. Overcome WebGL fingerprinting
    safely(() => {
        const contexts = [window.WebGLRenderingContext, window.WebGL2RenderingContext].filter(Boolean);
        for (const Context of contexts) {
            const getParameter = Context.prototype.getParameter;
            if (typeof getParameter !== 'function') continue;
            Context.prototype.getParameter = function(parameter) {
                // UNMASKED_VENDOR_WEBGL
                if (parameter === 37445) return 'Intel Inc.';
                // UNMASKED_RENDERER_WEBGL
                if (parameter === 37446) return 'Intel(R) Iris(TM) Graphics 6100';
                return getParameter.apply(this, arguments);
            };
            makeNative(Context.prototype.getParameter, 'getParameter');
        }
    });

    // 6. Fix navigator.permissions.query
    safely(() => {
        const permissions = window.navigator.permissions;
        if (!permissions || typeof permissions.query !== 'function') return;
        const originalQuery = permissions.query.bind(permissions);
        permissions.query = (parameters) => (
            parameters && parameters.name === 'notifications' ?
                Promise.resolve({ state: Notification.permission }) :
                originalQuery(parameters)
        );
        makeNative(permissions.query, 'query');
    });

    // 7. Mock navigator.deviceMemory
    safely(() => {
        if (!navigator.deviceMemory) {
            mockGetter(navigator, 'deviceMemory', 8);
        }
    });

    // 8. Mock hardwareConcurrency
    safely(() => {
        if (!navigator.hardwareConcurrency) {
            mockGetter(navigator, 'hardwareConcurrency', 4);
        }
    });

    // 9. Add window.outerHeight and window.outerWidth if missing (common in headless)
    safely(() => {
        if (window.outerHeight === 0) window.outerHeight = window.innerHeight;
        if (window.outerWidth === 0) window.outerWidth = window.innerWidth;
    });
})();
`;
