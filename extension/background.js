// Core state
let socket = null;
let reconnectInterval = 1000;
let connectionId = null; // Debugger session ID for the *active* target
let activeTargetId = null; // The tab/page we are currently controlling
let logBuffer = []; // Console logs & network errors

// Cache
let elementPositionCache = new Map(); // id -> {x, y, text, tagName, frameId}
let pingInterval = null;
let agentStopTimeout = null;

// --- Key code mappings for special keys ---
const KEY_MAP = {
    "Enter": { key: "Enter", code: "Enter", keyCode: 13 },
    "Tab": { key: "Tab", code: "Tab", keyCode: 9 },
    "Backspace": { key: "Backspace", code: "Backspace", keyCode: 8 },
    "Delete": { key: "Delete", code: "Delete", keyCode: 46 },
    "Escape": { key: "Escape", code: "Escape", keyCode: 27 },
    "ArrowUp": { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    "ArrowDown": { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    "ArrowLeft": { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    "ArrowRight": { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    "Home": { key: "Home", code: "Home", keyCode: 36 },
    "End": { key: "End", code: "End", keyCode: 35 },
    "PageUp": { key: "PageUp", code: "PageUp", keyCode: 33 },
    "PageDown": { key: "PageDown", code: "PageDown", keyCode: 34 },
    "Space": { key: " ", code: "Space", keyCode: 32 },
    " ": { key: " ", code: "Space", keyCode: 32 },
};

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
                await notifyContentScript({ type: "update_status", text: "Navigating..." });
                await chrome.tabs.update(activeTargetId ? parseInt(activeTargetId) : undefined, { url: params.url });
                // Simple wait for load — improved auto-wait handles the rest
                await new Promise(r => setTimeout(r, 2000));
                result = "Navigated";

            } else if (method === "get_state") {
                result = await getBrowserState();

            } else if (method === "new_tab") {
                const tab = await chrome.tabs.create({ url: params.url || "about:blank" });
                await ensureDebuggerAttached(tab.id);
                result = `Created new tab with ID ${tab.id}`;

            } else if (method === "switch_tab") {
                const tabId = parseInt(params.tabId);
                await chrome.tabs.update(tabId, { active: true });
                await ensureDebuggerAttached(tabId);
                result = `Switched to tab ${tabId}`;

            } else if (method === "close_tab") {
                const tabId = parseInt(params.tabId);
                await chrome.tabs.remove(tabId);
                result = `Closed tab ${tabId}`;

            } else if (method === "get_logs") {
                result = JSON.stringify(logBuffer.slice(-50)); // Last 50 logs

            } else if (method === "get_accessibility_tree") {
                result = await getAccessibilityTree();

            } else if (method === "configure") {
                result = await applyConfiguration(params);

            } else if (method === "click") {
                await notifyContentScript({ type: "show_click", x: params.x, y: params.y });
                await simulateClick(params.x, params.y);
                result = "Clicked coordinates";

            } else if (method === "click_element") {
                result = await smartClickElement(params.id, params.text);

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

            } else if (method === "press_key") {
                await notifyContentScript({ type: "update_status", text: `Pressing ${params.modifiers?.length ? params.modifiers.join('+') + '+' : ''}${params.key}` });
                await simulateKeyPress(params.key, params.modifiers || []);
                result = "Key pressed";

            } else if (method === "wait_for_element") {
                await notifyContentScript({ type: "update_status", text: "Waiting for element..." });
                result = await waitForElement(params.selector, params.timeout || 10000);

            } else if (method === "click_and_wait") {
                await notifyContentScript({ type: "update_status", text: "Clicking and waiting..." });
                result = await clickAndWait(params.id, params.text, params.timeout || 10000);

            } else if (method === "fill_form") {
                await notifyContentScript({ type: "update_status", text: "Filling field..." });
                result = await fillFormField(params.id, params.value, params.text);

            } else if (method === "select_option") {
                await notifyContentScript({ type: "update_status", text: "Selecting option..." });
                result = await selectOption(params.id, params.value, params.text);

            } else if (method === "set_checkbox") {
                await notifyContentScript({ type: "update_status", text: "Setting checkbox..." });
                result = await setCheckbox(params.id, params.checked, params.text);

            } else if (method === "upload_file") {
                await notifyContentScript({ type: "update_status", text: "Uploading file..." });
                result = await uploadFile(params.id, params.files, params.text);

            } else if (method === "hover") {
                await notifyContentScript({ type: "update_status", text: "Hovering..." });
                result = await hoverElement(params.id, params.x, params.y, params.text);

            } else if (method === "drag_and_drop") {
                await notifyContentScript({ type: "update_status", text: "Dragging..." });
                result = await dragAndDrop(params.sourceId, params.targetId, params.sourceText, params.targetText);
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

// ======================================================================
//  CORE CONNECTION & TARGET MANAGEMENT
// ======================================================================

// ======================================================================
//  CORE CONNECTION & TARGET MANAGEMENT
// ======================================================================



async function getActiveTab() {
    if (activeTargetId) {
        try {
            const tab = await chrome.tabs.get(parseInt(activeTargetId));
            return tab;
        } catch (e) { activeTargetId = null; }
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
}

async function ensureDebuggerAttached(tabId) {
    if (activeTargetId === tabId && connectionId) return;

    // If attached to another tab, detach first (simplification for now)
    if (activeTargetId && activeTargetId !== tabId) {
        try { await chrome.debugger.detach({ tabId: parseInt(activeTargetId) }); } catch (e) { }
    }

    try {
        const debugTarget = { tabId: tabId };
        await chrome.debugger.attach(debugTarget, "1.3");
        activeTargetId = tabId;
        connectionId = tabId;

        // Enable domains
        await chrome.debugger.sendCommand(debugTarget, "Page.enable");
        await chrome.debugger.sendCommand(debugTarget, "DOM.enable");
        await chrome.debugger.sendCommand(debugTarget, "Runtime.enable");
        await chrome.debugger.sendCommand(debugTarget, "Log.enable");
        await chrome.debugger.sendCommand(debugTarget, "Network.enable");

        // Enable Fetch for interception if configured
        await chrome.debugger.sendCommand(debugTarget, "Fetch.enable", {
            patterns: [{ urlPattern: "*" }]
        });

        // Listen for events
        chrome.debugger.onEvent.addListener(onDebuggerEvent);

        console.log(`[EXT] Attached to tab ${tabId}`);
    } catch (e) {
        if (!e.message.includes("Already attached")) {
            console.error("[EXT] Failed to attach:", e);
            throw e;
        }
        activeTargetId = tabId;
        connectionId = tabId;
    }
}


// Config state
let networkConfig = { blockImages: false, blockAds: false, blockCSS: false };
let scriptConfig = { onLoad: null };

async function sendCommand(method, params = {}) {
    const tab = await getActiveTab();
    if (!tab) throw new Error("No active tab found");

    await ensureDebuggerAttached(tab.id);
    return chrome.debugger.sendCommand({ tabId: tab.id }, method, params);
}

// ======================================================================
//  EVENT HANDLING (LOGS & NETWORK)
// ======================================================================

function onDebuggerEvent(source, method, params) {
    // Console logs
    if (method === "Log.entryAdded") {
        logBuffer.push({
            type: "console",
            level: params.entry.level,
            text: params.entry.text,
            timestamp: params.entry.timestamp,
            url: params.entry.url
        });
    }

    // Runtime console API (log, warn, error from JS)
    if (method === "Runtime.consoleAPICalled") {
        const text = params.args.map(a => a.value || a.description || "").join(" ");
        logBuffer.push({
            type: "console_api",
            level: params.type,
            text: text,
            timestamp: Date.now()
        });
    }

    // Network errors
    if (method === "Network.loadingFailed") {
        logBuffer.push({
            type: "network_error",
            text: `Failed to load ${params.type}: ${params.errorText}`,
            url: "unknown",
            timestamp: Date.now()
        });
    }

    // Network Interception
    if (method === "Fetch.requestPaused") {
        const { requestId, request, resourceType } = params;
        handleNetworkRequest(source.tabId, requestId, request.url, resourceType);
    }
}

async function handleNetworkRequest(tabId, requestId, url, resourceType) {
    let shouldBlock = false;

    // 1. Block Images
    if (networkConfig.blockImages && (resourceType === "Image" || resourceType === "Media")) {
        shouldBlock = true;
    }

    // 2. Block CSS
    if (networkConfig.blockCSS && (resourceType === "Stylesheet" || resourceType === "Font")) {
        shouldBlock = true;
    }

    // 3. Block Ads (Simple keyword matching for now)
    if (networkConfig.blockAds) {
        const adKeywords = ["doubleclick", "ads", "analytics", "tracker", "facebook.com/tr", "google-analytics"];
        if (adKeywords.some(k => url.includes(k))) {
            shouldBlock = true;
        }
    }

    try {
        if (shouldBlock) {
            await chrome.debugger.sendCommand({ tabId }, "Fetch.failRequest", {
                requestId,
                errorReason: "BlockedByClient"
            });
        } else {
            await chrome.debugger.sendCommand({ tabId }, "Fetch.continueRequest", {
                requestId
            });
        }
    } catch (e) {
        // Request might have been handled already or closed
    }
}

// ======================================================================
//  SMART WAIT — replace setTimeout with real page load detection
// ======================================================================

async function waitForPageLoad(tabId, timeout = 15000) {
    await ensureDebuggerAttached(tabId);

    return new Promise((resolve) => {
        let settled = false;
        let networkIdleTimer = null;
        let pendingRequests = 0;

        const done = () => {
            if (settled) return;
            settled = true;
            chrome.debugger.onEvent.removeListener(eventHandler);
            if (networkIdleTimer) clearTimeout(networkIdleTimer);
            resolve();
        };

        // Timeout fallback
        const fallbackTimer = setTimeout(() => {
            console.warn("[EXT] waitForPageLoad: timeout reached, proceeding anyway");
            done();
        }, timeout);

        const resetNetworkIdle = () => {
            if (networkIdleTimer) clearTimeout(networkIdleTimer);
            networkIdleTimer = setTimeout(() => {
                // No network activity for 500ms → consider loaded
                if (pendingRequests <= 0) {
                    clearTimeout(fallbackTimer);
                    done();
                }
            }, 500);
        };

        const eventHandler = (source, method, params) => {
            if (source.tabId !== tabId) return;

            if (method === "Page.loadEventFired") {
                // Page fully loaded — wait a tiny bit more for network idle
                resetNetworkIdle();
            } else if (method === "Page.lifecycleEvent" && params?.name === "networkIdle") {
                clearTimeout(fallbackTimer);
                // Give DOM a moment to settle
                setTimeout(done, 200);
            } else if (method === "Network.requestWillBeSent") {
                pendingRequests++;
            } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
                pendingRequests = Math.max(0, pendingRequests - 1);
                if (pendingRequests === 0) resetNetworkIdle();
            }
        };

        chrome.debugger.onEvent.addListener(eventHandler);

        // Enable Network domain for request tracking
        chrome.debugger.sendCommand({ tabId }, "Network.enable").catch(() => { });
    });
}

/**
 * Wait for URL or significant DOM change after an action.
 */
async function waitForPageChange(urlBefore, timeout = 10000) {
    const startTime = Date.now();
    const tab = await getActiveTab();

    while (Date.now() - startTime < timeout) {
        await new Promise(r => setTimeout(r, 300));
        const currentTab = await getActiveTab();

        // URL changed = navigation happened
        if (currentTab.url !== urlBefore) {
            await waitForPageLoad(currentTab.id, timeout - (Date.now() - startTime));
            return;
        }
    }

    // Even if URL didn't change, wait for any pending loads
    await new Promise(r => setTimeout(r, 500));
}

// ======================================================================
//  SPECIAL KEY SUPPORT
// ======================================================================

async function simulateKeyPress(key, modifiers = []) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    const mapped = KEY_MAP[key];
    const keyName = mapped ? mapped.key : key;
    const code = mapped ? mapped.code : `Key${key.toUpperCase()}`;
    const keyCode = mapped ? mapped.keyCode : key.toUpperCase().charCodeAt(0);

    const modifierFlags = {
        alt: modifiers.includes("Alt"),
        ctrl: modifiers.includes("Ctrl") || modifiers.includes("Control"),
        meta: modifiers.includes("Meta") || modifiers.includes("Command"),
        shift: modifiers.includes("Shift"),
    };

    const modifierBitmask =
        (modifierFlags.alt ? 1 : 0) |
        (modifierFlags.ctrl ? 2 : 0) |
        (modifierFlags.meta ? 4 : 0) |
        (modifierFlags.shift ? 8 : 0);

    // Press modifier keys first
    for (const mod of modifiers) {
        const modKey = KEY_MAP[mod] || { key: mod, code: mod, keyCode: 0 };
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            key: modKey.key || mod,
            code: modKey.code || mod,
            windowsVirtualKeyCode: modKey.keyCode || 0,
            nativeVirtualKeyCode: modKey.keyCode || 0,
            modifiers: modifierBitmask,
        });
    }

    // Press the main key
    const isChar = !mapped && key.length === 1;
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: keyName,
        code: code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        modifiers: modifierBitmask,
    });

    // For printable characters, dispatch a char event too
    if (isChar && !modifierFlags.ctrl && !modifierFlags.meta) {
        const charToSend = modifierFlags.shift ? key.toUpperCase() : key;
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
            type: "char",
            text: charToSend,
            unmodifiedText: key,
            key: charToSend,
            code: code,
            modifiers: modifierBitmask,
        });
    }

    // Release main key
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: keyName,
        code: code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        modifiers: modifierBitmask,
    });

    // Release modifier keys in reverse
    for (const mod of [...modifiers].reverse()) {
        const modKey = KEY_MAP[mod] || { key: mod, code: mod, keyCode: 0 };
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
            type: "keyUp",
            key: modKey.key || mod,
            code: modKey.code || mod,
            windowsVirtualKeyCode: modKey.keyCode || 0,
            nativeVirtualKeyCode: modKey.keyCode || 0,
            modifiers: 0,
        });
    }
}

// ======================================================================
//  SELF-HEALING ELEMENT CLICK
// ======================================================================

/**
 * Click an element by ID, with self-healing fallback:
 * 1. Try cached position
 * 2. Re-scan DOM and retry cached position
 * 3. Fuzzy match by text content
 */
async function smartClickElement(id, fallbackText) {
    let pos = elementPositionCache.get(id);

    // Step 1: If not in cache, re-scan the DOM
    if (!pos) {
        console.warn(`[EXT] Element ${id} not in cache. Re-scanning DOM...`);
        await getBrowserState(); // refreshes the cache
        pos = elementPositionCache.get(id);
    }

    // Step 2: If still not found and we have fallback text, fuzzy match
    if (!pos && fallbackText) {
        console.warn(`[EXT] Element ${id} still not found. Fuzzy matching by text: "${fallbackText}"...`);
        pos = await findElementByText(fallbackText);
    }

    if (!pos) {
        throw new Error(`Element ${id} not found even after re-scan and fuzzy match. Call get_state to refresh.`);
    }

    await notifyContentScript({ type: "show_click", x: pos.x, y: pos.y });
    await simulateClick(pos.x, pos.y);
    return `Clicked element ${id}`;
}

/**
 * Find an element by its visible text content. Returns {x, y} or null.
 */
async function findElementByText(searchText) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    const evalResult = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
        expression: `(function() {
            const search = ${JSON.stringify(searchText)}.toLowerCase().trim();
            const candidates = document.querySelectorAll(
                'a, button, input, textarea, select, label, summary, ' +
                '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="option"], ' +
                '[onclick], [tabindex], [contenteditable="true"]'
            );
            let bestMatch = null;
            let bestScore = Infinity;
            
            for (const el of candidates) {
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) continue;
                
                const style = window.getComputedStyle(el);
                if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
                
                const elText = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').toLowerCase().trim();
                
                if (elText === search) {
                    // Exact match
                    return JSON.stringify({
                        x: Math.round(rect.x + rect.width / 2),
                        y: Math.round(rect.y + rect.height / 2)
                    });
                }
                
                if (elText.includes(search) || search.includes(elText)) {
                    const score = Math.abs(elText.length - search.length);
                    if (score < bestScore) {
                        bestScore = score;
                        bestMatch = {
                            x: Math.round(rect.x + rect.width / 2),
                            y: Math.round(rect.y + rect.height / 2)
                        };
                    }
                }
            }
            
            return bestMatch ? JSON.stringify(bestMatch) : null;
        })()`,
        returnByValue: true
    });

    if (evalResult?.result?.value) {
        return JSON.parse(evalResult.result.value);
    }
    return null;
}

// ======================================================================
//  WAIT FOR ELEMENT
// ======================================================================

/**
 * Poll for a CSS selector to appear in the DOM and be visible.
 */
async function waitForElement(selector, timeout = 10000) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    const startTime = Date.now();
    const pollInterval = 500;

    while (Date.now() - startTime < timeout) {
        const evalResult = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
            expression: `(function() {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return null;
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return null;
                const style = window.getComputedStyle(el);
                if (style.visibility === 'hidden' || style.display === 'none') return null;
                return JSON.stringify({
                    found: true,
                    text: (el.innerText || el.value || '').slice(0, 100).trim(),
                    x: Math.round(rect.x + rect.width / 2),
                    y: Math.round(rect.y + rect.height / 2)
                });
            })()`,
            returnByValue: true
        });

        if (evalResult?.result?.value) {
            const data = JSON.parse(evalResult.result.value);
            return `Element found: "${data.text}" at (${data.x}, ${data.y})`;
        }

        await new Promise(r => setTimeout(r, pollInterval));
    }

    throw new Error(`Timed out waiting for element "${selector}" after ${timeout}ms`);
}

// ======================================================================
//  COMPOUND ACTIONS
// ======================================================================

/**
 * Click an element and wait for page change (navigation or significant DOM update).
 */
async function clickAndWait(id, fallbackText, timeout = 10000) {
    const tabBefore = await getActiveTab();
    const urlBefore = tabBefore.url;

    await smartClickElement(id, fallbackText);
    await waitForPageChange(urlBefore, timeout);

    const tabAfter = await getActiveTab();
    return `Clicked element ${id} and waited. URL: ${tabAfter.url}`;
}

/**
 * Focus a form field, clear it, then type a new value.
 * Uses CDP-native Input.insertText for reliable text entry across all frameworks.
 */
async function fillFormField(id, value, fallbackText) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    // Step 1: Click to focus the element (with mouseMoved for realism)
    await smartClickElement(id, fallbackText);
    await new Promise(r => setTimeout(r, 150));

    // Step 2: Clear existing value using execCommand (fires proper events)
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
        expression: `(function() {
            const el = document.activeElement;
            if (!el) return 'no_active';
            
            // For input/textarea: select all text and delete
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                el.select();
                document.execCommand('delete', false);
                // Double-check: if value still exists, force-clear via property setter
                if (el.value) {
                    const nativeSet = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                    )?.set || Object.getOwnPropertyDescriptor(
                        window.HTMLTextAreaElement.prototype, 'value'
                    )?.set;
                    if (nativeSet) nativeSet.call(el, '');
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                }
            } else if (el.isContentEditable) {
                document.execCommand('selectAll', false);
                document.execCommand('delete', false);
            }
            return 'cleared';
        })()`,
        returnByValue: true
    });
    await new Promise(r => setTimeout(r, 50));

    // Step 3: Insert text using Input.insertText (atomic, works with React/Vue/Angular)
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.insertText", { text: value });
    await new Promise(r => setTimeout(r, 50));

    // Step 4: Fire change + blur events to trigger validation
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
        expression: `(function() {
            const el = document.activeElement;
            if (!el) return;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
        })()`,
        returnByValue: true
    });

    return `Filled element ${id} with "${value}"`;
}

// ======================================================================
//  SELECT OPTION
// ======================================================================

/**
 * Select an option in a <select> dropdown by value or visible text.
 */
async function selectOption(id, value, fallbackText) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    // Click to open the select
    await smartClickElement(id, fallbackText);
    await new Promise(r => setTimeout(r, 100));

    const evalResult = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
        expression: `(function() {
            const el = document.activeElement;
            if (!el || el.tagName !== 'SELECT') return JSON.stringify({ error: 'Not a select element' });
            
            const searchVal = ${JSON.stringify(value)};
            let found = false;
            
            // Try matching by value first
            for (let i = 0; i < el.options.length; i++) {
                if (el.options[i].value === searchVal) {
                    el.selectedIndex = i;
                    found = true;
                    break;
                }
            }
            
            // Then try matching by visible text
            if (!found) {
                const searchLower = searchVal.toLowerCase().trim();
                for (let i = 0; i < el.options.length; i++) {
                    if (el.options[i].text.toLowerCase().trim() === searchLower) {
                        el.selectedIndex = i;
                        found = true;
                        break;
                    }
                }
            }
            
            // Partial match as last resort
            if (!found) {
                const searchLower = searchVal.toLowerCase().trim();
                for (let i = 0; i < el.options.length; i++) {
                    if (el.options[i].text.toLowerCase().trim().includes(searchLower)) {
                        el.selectedIndex = i;
                        found = true;
                        break;
                    }
                }
            }
            
            if (!found) return JSON.stringify({ error: 'Option not found: ' + searchVal });
            
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return JSON.stringify({ selected: el.options[el.selectedIndex].text });
        })()`,
        returnByValue: true
    });

    const data = JSON.parse(evalResult?.result?.value || '{}');
    if (data.error) throw new Error(data.error);
    return `Selected "${data.selected}" in element ${id}`;
}

// ======================================================================
//  SET CHECKBOX / RADIO
// ======================================================================

/**
 * Set a checkbox or radio button to a specific checked state.
 */
async function setCheckbox(id, checked, fallbackText) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    // Get element position
    let pos = elementPositionCache.get(id);
    if (!pos) {
        await getBrowserState();
        pos = elementPositionCache.get(id);
    }
    if (!pos && fallbackText) {
        pos = await findElementByText(fallbackText);
    }
    if (!pos) throw new Error(`Element ${id} not found for checkbox toggle`);

    const evalResult = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
        expression: `(function() {
            // Find the element at the cached position via coordinates
            const el = document.elementFromPoint(${pos.x}, ${pos.y});
            if (!el) return JSON.stringify({ error: 'Element not found at position' });
            
            // Find the actual input (might be a label wrapping the input)
            let input = el;
            if (el.tagName !== 'INPUT') {
                input = el.querySelector('input[type="checkbox"], input[type="radio"]') || el.closest('label')?.querySelector('input') || el;
            }
            
            if (input.tagName !== 'INPUT' || (input.type !== 'checkbox' && input.type !== 'radio')) {
                return JSON.stringify({ error: 'Not a checkbox or radio: ' + input.tagName + '[type=' + input.type + ']' });
            }
            
            const desired = ${JSON.stringify(checked)};
            if (input.checked !== desired) {
                input.checked = desired;
                input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return JSON.stringify({ checked: input.checked, type: input.type });
        })()`,
        returnByValue: true
    });

    const data = JSON.parse(evalResult?.result?.value || '{}');
    if (data.error) throw new Error(data.error);
    return `Set ${data.type} element ${id} to ${data.checked ? 'checked' : 'unchecked'}`;
}

// ======================================================================
//  UPLOAD FILE
// ======================================================================

/**
 * Set files on a file input element using CDP DOM.setFileInputFiles.
 */
async function uploadFile(id, files, fallbackText) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    let pos = elementPositionCache.get(id);
    if (!pos) {
        await getBrowserState();
        pos = elementPositionCache.get(id);
    }
    if (!pos && fallbackText) {
        pos = await findElementByText(fallbackText);
    }
    if (!pos) throw new Error(`File input element ${id} not found`);

    // Resolve the DOM node at the position
    const nodeResult = await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.getNodeForLocation", {
        x: pos.x,
        y: pos.y
    });

    if (!nodeResult?.backendNodeId) {
        throw new Error(`Could not resolve DOM node for file input at (${pos.x}, ${pos.y})`);
    }

    // Set the files using CDP
    await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.setFileInputFiles", {
        files: Array.isArray(files) ? files : [files],
        backendNodeId: nodeResult.backendNodeId
    });

    return `Set ${Array.isArray(files) ? files.length : 1} file(s) on element ${id}`;
}

// ======================================================================
//  HOVER
// ======================================================================

/**
 * Hover over an element or coordinates using CDP mouseMoved events.
 */
async function hoverElement(id, x, y, fallbackText) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    let targetX = x, targetY = y;

    // If element ID is provided, resolve its position
    if (id !== undefined && id !== null) {
        let pos = elementPositionCache.get(id);
        if (!pos) {
            await getBrowserState();
            pos = elementPositionCache.get(id);
        }
        if (!pos && fallbackText) {
            pos = await findElementByText(fallbackText);
        }
        if (!pos) throw new Error(`Element ${id} not found for hover`);
        targetX = pos.x;
        targetY = pos.y;
    }

    if (targetX === undefined || targetY === undefined) {
        throw new Error('Hover requires either element id or x,y coordinates');
    }

    // Dispatch mouseMoved to trigger CSS :hover and JS mouseenter/mouseover
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: targetX,
        y: targetY
    });

    await notifyContentScript({ type: "show_click", x: targetX, y: targetY });
    return `Hovered at (${targetX}, ${targetY})`;
}

// ======================================================================
//  DRAG AND DROP
// ======================================================================

/**
 * Drag from one element/position to another using CDP mouse events.
 */
async function dragAndDrop(sourceId, targetId, sourceText, targetText) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    // Resolve source position
    let srcPos = elementPositionCache.get(sourceId);
    if (!srcPos) {
        await getBrowserState();
        srcPos = elementPositionCache.get(sourceId);
    }
    if (!srcPos && sourceText) srcPos = await findElementByText(sourceText);
    if (!srcPos) throw new Error(`Source element ${sourceId} not found for drag`);

    // Resolve target position
    let tgtPos = elementPositionCache.get(targetId);
    if (!tgtPos) tgtPos = elementPositionCache.get(targetId);
    if (!tgtPos && targetText) tgtPos = await findElementByText(targetText);
    if (!tgtPos) throw new Error(`Target element ${targetId} not found for drop`);

    // Simulate drag: mouseDown on source → mouseMoved to target → mouseUp on target
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x: srcPos.x, y: srcPos.y
    });
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
        type: "mousePressed", x: srcPos.x, y: srcPos.y, button: "left", clickCount: 1
    });
    await new Promise(r => setTimeout(r, 100));

    // Move in steps for realistic drag
    const steps = 5;
    for (let i = 1; i <= steps; i++) {
        const ratio = i / steps;
        const midX = Math.round(srcPos.x + (tgtPos.x - srcPos.x) * ratio);
        const midY = Math.round(srcPos.y + (tgtPos.y - srcPos.y) * ratio);
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
            type: "mouseMoved", x: midX, y: midY, button: "left"
        });
        await new Promise(r => setTimeout(r, 30));
    }

    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: tgtPos.x, y: tgtPos.y, button: "left", clickCount: 1
    });

    return `Dragged element ${sourceId} to element ${targetId}`;
}

// ======================================================================
//  ACCESSIBILITY TREE
// ======================================================================

async function getAccessibilityTree() {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    // Enable Accessibility domain
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Accessibility.enable");

    // Fetch the full tree
    const { nodes } = await chrome.debugger.sendCommand({ tabId: tab.id }, "Accessibility.getFullAXTree");

    // Simplify the tree
    // 1. Create a map for quick lookup
    const nodeMap = new Map();
    nodes.forEach(node => nodeMap.set(node.nodeId, node));

    // 2. Build the tree structure
    const rootNodes = [];
    nodes.forEach(node => {
        if (!node.parentId) {
            rootNodes.push(node);
        }
    });

    // 3. Recursive simplifier
    function simplifyNode(node) {
        // Filter out irrelevant nodes (generic containers without names/roles)
        // Keep if it has a name, value, or interesting role
        const interestingRoles = [
            "button", "link", "input", "checkbox", "radio", "slider", "textbox",
            "listbox", "combobox", "menuitem", "tab", "treeitem", "heading", "image"
        ];

        const name = node.name ? node.name.value : "";
        const role = node.role ? node.role.value : "";
        const value = node.value ? node.value.value : "";
        const description = node.description ? node.description.value : "";

        const isInteresting =
            interestingRoles.includes(role) ||
            (name && name.length > 0) ||
            (value && value.length > 0) ||
            node.childIds?.length > 0; // Keep parents of interesting nodes

        if (!isInteresting) return null;

        const children = (node.childIds || [])
            .map(id => nodeMap.get(id))
            .filter(n => n)
            .map(simplifyNode)
            .filter(n => n);

        // If a node is generic and only has one child, flatten it (optional optimization)
        // For now, keep structure but minimize keys

        // Remove empty children array to save space
        const cleanNode = {
            role: role,
            name: name,
        };

        if (value) cleanNode.value = value;
        if (description) cleanNode.description = description;
        if (children.length > 0) cleanNode.children = children;

        // Map backend NodeID if available (for future highlighting)
        if (node.backendDOMNodeId) cleanNode.backendId = node.backendDOMNodeId;

        return cleanNode;
    }

    const simplifiedTree = rootNodes.map(simplifyNode).filter(n => n);
    return simplifiedTree;
}

// ... existing code ...

// Update executeCommand or main message handler (depending on structure)
// I need to see where to insert the handler logic.




// CDP sendCommand wrapper (assuming it's defined elsewhere or will be added)
// For now, using chrome.debugger.sendCommand directly as in original code
async function sendCommand(method, params) {
    const tab = await getActiveTab();
    return chrome.debugger.sendCommand({ tabId: tab.id }, method, params);
}

async function getBrowserState() {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    // Get screenshot
    let base64Data = "";
    try {
        const screenshotUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 60 });
        base64Data = screenshotUrl.split(",")[1];
    } catch (e) {
        console.warn("Screenshot failed", e);
        base64Data = "";
    }

    let rawElements = [];
    try {
        const evalResult = await sendCommand("Runtime.evaluate", {
            expression: `
                (function() {
                    const results = [];
                    let counter = 0;
                    
                    function processDoc(doc, frameId) {
                        try {
                            const elements = doc.querySelectorAll('*');
                            elements.forEach((el) => {
                                // Filter interesting elements
                                const tag = el.tagName.toLowerCase();
                                const role = el.getAttribute('role');
                                const isInteractive = 
                                    ['a', 'button', 'input', 'textarea', 'select', 'label', 'details', 'summary'].includes(tag) ||
                                    el.hasAttribute('onclick') || 
                                    role === 'button' || role === 'link' || role === 'checkbox' || role === 'menuitem' || 
                                    role === 'tab' || role === 'combobox' || role === 'option' ||
                                    el.getAttribute('contenteditable') === 'true';
                                
                                if (!isInteractive && tag !== 'iframe') return;

                                const rect = el.getBoundingClientRect();
                                if (rect.width <= 0 || rect.height <= 0) return;
                                
                                const style = window.getComputedStyle(el);
                                if (style.visibility === 'hidden' || style.display === 'none') return;
                                
                                counter++;
                                let text = "";
                                if (tag === 'input' || tag === 'textarea') {
                                    text = el.value || el.placeholder || "";
                                } else if (tag === 'select') {
                                    text = el.options[el.selectedIndex]?.text || "";
                                } else {
                                    text = el.innerText || el.textContent || el.getAttribute('aria-label') || "";
                                }
                                text = text.slice(0, 100).trim().replace(/\\s+/g, ' ');

                                results.push({
                                    id: counter,
                                    tagName: tag,
                                    text: text,
                                    x: Math.round(rect.x + rect.width / 2),
                                    y: Math.round(rect.y + rect.height / 2),
                                    frameId: frameId,
                                    // Metadata
                                    name: el.getAttribute('name') || '',
                                    role: role || '',
                                    ariaLabel: el.getAttribute('aria-label') || '',
                                    disabled: el.disabled || false,
                                    value: (tag === 'input' || tag === 'textarea') ? el.value : undefined,
                                    checked: (el.type === 'checkbox' || el.type === 'radio') ? el.checked : undefined,
                                    selectedOption: tag === 'select' && el.selectedIndex >= 0 ? el.options[el.selectedIndex]?.text : undefined,
                                    placeholder: el.getAttribute('placeholder') || '',
                                    required: el.required || false,
                                    type: el.type || ''
                                });

                                // Recurse into iframes
                                if (tag === 'iframe') {
                                    try {
                                        if (el.contentDocument) {
                                            processDoc(el.contentDocument, "iframe-" + counter);
                                        }
                                    } catch (e) { /* blocked cross-origin */ }
                                }
                            });
                        } catch (e) { /* skip faulty doc */ }
                    }
                    
                    processDoc(document, "main");
                    return JSON.stringify(results);
                })()
            `,
            returnByValue: true
        });

        if (evalResult?.result?.value) {
            rawElements = JSON.parse(evalResult.result.value);
        }
    } catch (e) { console.error("Extraction failed", e); }

    elementPositionCache.clear();
    rawElements.forEach(el => {
        elementPositionCache.set(el.id, el);
    });

    // Get list of open tabs
    const tabs = await chrome.tabs.query({});
    const tabList = tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active }));

    // Clean elements
    const cleanElements = rawElements.map(el => {
        const clean = { ...el };
        Object.keys(clean).forEach(k => {
            if (clean[k] === undefined || clean[k] === '' || clean[k] === false) delete clean[k];
        });
        return clean;
    });

    return {
        url: tab.url,
        title: tab.title,
        screenshot: base64Data,
        interactiveElements: cleanElements,
        tabs: tabList,
        logs: logBuffer.slice(-20)
    };
}

async function simulateClick(x, y) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);
    // Move mouse first — some sites only register clicks preceded by mouseMoved
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x, y
    });
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
    // Use CDP Input.insertText — inserts text atomically, works with React/Vue/Angular
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.insertText", { text });
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
    });
    return result?.result?.value;
}

// ======================================================================
//  ACCESSIBILITY TREE
// ======================================================================

async function getAccessibilityTree() {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    // Enable Accessibility domain
    try {
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Accessibility.enable");
    } catch (e) {
        console.warn("Failed to enable Accessibility", e);
    }

    // Fetch the full tree
    let nodes = [];
    try {
        const res = await chrome.debugger.sendCommand({ tabId: tab.id }, "Accessibility.getFullAXTree");
        nodes = res.nodes;
    } catch (e) {
        console.error("Failed to get AXTree", e);
        return { error: "Failed to get accessibility tree: " + e.message };
    }

    // Simplify the tree
    // 1. Create a map for quick lookup
    const nodeMap = new Map();
    nodes.forEach(node => nodeMap.set(node.nodeId, node));

    // 2. Build the tree structure
    const rootNodes = [];
    nodes.forEach(node => {
        if (!node.parentId) {
            rootNodes.push(node);
        }
    });

    // 3. Recursive simplifier
    function simplifyNode(node) {
        // Filter out irrelevant nodes (generic containers without names/roles)
        // Keep if it has a name, value, or interesting role
        const interestingRoles = [
            "button", "link", "input", "checkbox", "radio", "slider", "textbox",
            "listbox", "combobox", "menuitem", "tab", "treeitem", "heading", "image", "statictext"
        ];

        const name = node.name ? node.name.value : "";
        const role = node.role ? node.role.value : "";
        const value = node.value ? node.value.value : "";
        const description = node.description ? node.description.value : "";

        // Check if interesting
        let isInteresting =
            interestingRoles.includes(role) ||
            (name && name.length > 0) ||
            (value && value.length > 0);

        // Also keep if it has interesting children (we need to traverse down first)
        const children = (node.childIds || [])
            .map(id => nodeMap.get(id))
            .filter(n => n)
            .map(simplifyNode) // Recurse
            .filter(n => n);   // Keep only non-null children

        if (children.length > 0) isInteresting = true;

        if (!isInteresting) return null;

        // Clean up node
        const cleanNode = {
            role: role,
        };

        if (name) cleanNode.name = name;
        if (value) cleanNode.value = value;
        if (description) cleanNode.description = description;
        if (children.length > 0) cleanNode.children = children;
        if (node.backendDOMNodeId) cleanNode.backendId = node.backendDOMNodeId;

        return cleanNode;
    }

    const simplifiedTree = rootNodes.map(simplifyNode).filter(n => n);
    return simplifiedTree;
}

// ======================================================================
//  CONFIGURATION HANDLER
// ======================================================================

async function applyConfiguration(config) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    let messages = [];

    // 1. Network Configuration
    if (config.network) {
        networkConfig = { ...networkConfig, ...config.network };
        messages.push(`Network config updated: ${JSON.stringify(networkConfig)}`);
    }

    // 2. Emulation Configuration
    if (config.emulation) {
        const { width, height, mobile, userAgent } = config.emulation;

        if (width || height || mobile !== undefined) {
            await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setDeviceMetricsOverride", {
                width: width || 1920,
                height: height || 1080,
                deviceScaleFactor: mobile ? 3 : 1,
                mobile: mobile || false
            });
            messages.push("Device metrics overridden");
        }

        if (userAgent) {
            await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setUserAgentOverride", {
                userAgent: userAgent
            });
            messages.push("User Agent overridden");
        }
    }

    // 3. Script Injection
    if (config.script && config.script.onLoad) {
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.addScriptToEvaluateOnNewDocument", {
            source: config.script.onLoad
        });
        messages.push("Script injected on new document");
    }

    return messages.join("; ");
}
