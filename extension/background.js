let socket = null;
let reconnectInterval = 1000;
let attachedTabId = null;
let elementPositionCache = new Map(); // id -> {x, y}
let pingInterval = null;
let agentStopTimeout = null;

function connect() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }

    try {
        socket = new WebSocket("ws://localhost:3009");
    } catch (e) {
        console.error("[EXT] Failed to create WebSocket:", e);
        scheduleReconnect();
        return;
    }

    socket.onopen = () => {
        console.log("[EXT] Connected to MCP Server");
        reconnectInterval = 1000;
        pingInterval = setInterval(() => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ method: "ping" }));
            }
        }, 20000);
    };

    socket.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        const { id, method, params } = message;
        if (id === undefined || method === undefined) return;

        try {
            // Show agent overlay
            await notifyContentScript({ type: "agent_start" });
            resetAgentStopTimer();

            let result = null;
            if (method === "navigate") {
                const tab = await getActiveTab();
                await chrome.tabs.update(tab.id, { url: params.url });
                await new Promise(resolve => setTimeout(resolve, 2000));
                // Re-inject content script on new page
                await injectContentScript(tab.id);
                result = "Navigated";
            } else if (method === "get_state") {
                result = await getBrowserState();
            } else if (method === "click") {
                await notifyContentScript({ type: "show_click", x: params.x, y: params.y });
                await simulateClick(params.x, params.y);
                result = "Clicked coordinates";
            } else if (method === "click_element") {
                const pos = elementPositionCache.get(params.id);
                if (pos) {
                    await notifyContentScript({ type: "show_click", x: pos.x, y: pos.y });
                }
                result = await clickElement(params.id);
            } else if (method === "type") {
                // Find active element position for type indicator
                const tab = await getActiveTab();
                try {
                    const focusResult = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
                        expression: `(function() {
                            const el = document.activeElement;
                            if (el) {
                                const r = el.getBoundingClientRect();
                                return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y) });
                            }
                            return null;
                        })()`,
                        returnByValue: true
                    });
                    if (focusResult?.result?.value) {
                        const pos = JSON.parse(focusResult.result.value);
                        await notifyContentScript({ type: "show_type", x: pos.x, y: pos.y });
                    }
                } catch (e) { /* Non-critical */ }
                await simulateType(params.text);
                result = "Typed";
            } else if (method === "scroll") {
                await simulateScroll(params.x, params.y);
                result = "Scrolled";
            } else if (method === "evaluate") {
                result = await executeScript(params.script);
            }

            socket.send(JSON.stringify({ id, result }));

            // Schedule agent overlay hide
            resetAgentStopTimer();
        } catch (error) {
            console.error("[EXT] Command failed:", error);
            socket.send(JSON.stringify({ id, error: error.message || String(error) }));
        }
    };

    socket.onerror = (err) => {
        console.error("[EXT] WebSocket error");
    };

    socket.onclose = () => {
        console.log("[EXT] Disconnected from server");
        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
        }
        scheduleReconnect();
    };
}

function scheduleReconnect() {
    console.log(`[EXT] Reconnecting in ${reconnectInterval}ms...`);
    setTimeout(() => connect(), reconnectInterval);
    reconnectInterval = Math.min(reconnectInterval * 2, 10000);
}

function resetAgentStopTimer() {
    if (agentStopTimeout) clearTimeout(agentStopTimeout);
    agentStopTimeout = setTimeout(async () => {
        await notifyContentScript({ type: "agent_stop" });
    }, 3000);
}

async function notifyContentScript(msg) {
    try {
        const tab = await getActiveTab();
        // Ensure content script is injected
        await injectContentScript(tab.id);
        await chrome.tabs.sendMessage(tab.id, msg);
    } catch (e) {
        // Non-critical — page might not support content scripts (e.g. chrome:// pages)
    }
}

async function injectContentScript(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content.js"],
        });
    } catch (e) {
        // Already injected or restricted page
    }
}

connect();

// --- Message Listeners ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "reconnect") {
        console.log("[EXT] Manual reconnect requested");
        if (socket) socket.close();
        else connect();
    }
    if (msg.type === "status") {
        sendResponse({
            connected: socket && socket.readyState === WebSocket.OPEN
        });
        return true;
    }
});

// --- Helper Functions ---

async function getActiveTab() {
    let tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) {
        tabs = await chrome.tabs.query({ active: true });
    }
    if (!tabs || tabs.length === 0) {
        tabs = await chrome.tabs.query({});
    }
    if (!tabs || tabs.length === 0) throw new Error("No tabs found");
    return tabs[0];
}

async function ensureDebuggerAttached(tabId) {
    if (attachedTabId === tabId) return;
    if (attachedTabId) {
        try { await chrome.debugger.detach({ tabId: attachedTabId }); } catch (e) { }
    }
    try {
        await chrome.debugger.attach({ tabId }, "1.3");
        attachedTabId = tabId;
        await chrome.debugger.sendCommand({ tabId }, "DOM.enable");
        await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    } catch (e) {
        if (e.message && e.message.includes("Already attached")) {
            attachedTabId = tabId;
        } else {
            console.warn("[EXT] Debugger attach warning:", e.message || e);
        }
    }
}

async function getBrowserState() {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    const screenshotUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 60 });
    const base64Data = screenshotUrl.split(",")[1];

    let rawElements = [];
    try {
        const evalResult = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
            expression: `
                (function() {
                    const elements = document.querySelectorAll('a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick]');
                    const results = [];
                    let counter = 0;
                    elements.forEach((el) => {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && 
                            rect.top >= 0 && rect.left >= 0 && 
                            rect.bottom <= window.innerHeight && rect.right <= window.innerWidth) {
                            
                            const style = window.getComputedStyle(el);
                            if (style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0') {
                                counter++;
                                results.push({
                                    id: counter,
                                    tagName: el.tagName.toLowerCase(),
                                    text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').slice(0, 50).trim(),
                                    type: el.type || '',
                                    x: Math.round(rect.x + rect.width / 2),
                                    y: Math.round(rect.y + rect.height / 2)
                                });
                            }
                        }
                    });
                    return JSON.stringify(results);
                })()
            `,
            returnByValue: true
        });

        if (evalResult && evalResult.result && evalResult.result.value) {
            rawElements = JSON.parse(evalResult.result.value);
        }
    } catch (e) {
        console.error("[EXT] Failed to extract elements:", e);
    }

    elementPositionCache.clear();
    rawElements.forEach(el => {
        elementPositionCache.set(el.id, { x: el.x, y: el.y });
    });

    return {
        url: tab.url,
        title: tab.title,
        screenshot: base64Data,
        interactiveElements: rawElements
    };
}

async function clickElement(id) {
    const pos = elementPositionCache.get(id);
    if (!pos) throw new Error(`Element ${id} not found in current state. Call get_state first.`);
    await simulateClick(pos.x, pos.y);
    return `Clicked element ${id}`;
}

async function simulateClick(x, y) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
        type: "mousePressed", x, y, button: "left", clickCount: 1
    });
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x, y, button: "left", clickCount: 1
    });
}

async function simulateType(text) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);
    for (const char of text) {
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
            type: "keyDown", text: char, unmodifiedText: char, key: char
        });
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
            type: "keyUp", text: char, unmodifiedText: char, key: char
        });
    }
}

async function simulateScroll(x, y) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x: 0, y: 0, deltaX: 0, deltaY: y
    });
}

async function executeScript(script) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);
    const result = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
        expression: script,
        returnByValue: true
    });
    return result?.result?.value;
}
