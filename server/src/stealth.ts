/**
 * Comprehensive stealth script to bypass bot detection.
 * Inspired by puppeteer-extra-plugin-stealth and modern bot bypass techniques.
 */
export const STEALTH_SCRIPT = `
(function() {
    // 1. Remove navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // 2. Mock chrome.runtime
    window.chrome = {
        runtime: {
            OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
            OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
            PlatformArch: { ARM: 'arm', ARM64: 'arm64', X86_32: 'x86-32', X86_64: 'x86-64' },
            PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
            PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
            RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available', THROTTLED: 'throttled' }
        }
    };

    // 3. Spoof navigator.languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

    // 4. Spoof navigator.plugins
    Object.defineProperty(navigator, 'plugins', {
        get: () => {
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
            return p;
        }
    });

    // 5. Overcome WebGL fingerprinting
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
        // UNMASKED_VENDOR_WEBGL
        if (parameter === 37445) return 'Intel Inc.';
        // UNMASKED_RENDERER_WEBGL
        if (parameter === 37446) return 'Intel(R) Iris(TM) Graphics 6100';
        return getParameter.apply(this, arguments);
    };

    // 6. Fix navigator.permissions.query
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
            Promise.resolve({ state: Notification.permission }) :
            originalQuery(parameters)
    );

    // 7. Mock navigator.deviceMemory
    if (!navigator.deviceMemory) {
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    }

    // 8. Mock hardwareConcurrency
    if (!navigator.hardwareConcurrency) {
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
    }

    // 9. Add window.outerHeight and window.outerWidth if missing (common in headless)
    if (window.outerHeight === 0) window.outerHeight = window.innerHeight;
    if (window.outerWidth === 0) window.outerWidth = window.innerWidth;
})();
`;
