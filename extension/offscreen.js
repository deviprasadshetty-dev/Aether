setInterval(async () => {
    try {
        await chrome.runtime.sendMessage({ type: 'keepAlive' });
    } catch (e) {
        // Extension might be reloading or disconnected
        console.warn('Keep-alive ping failed:', e);
    }
}, 20000); // 20 seconds (safe margin under 30s)
