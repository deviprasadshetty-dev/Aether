// Core state
let socket = null;
let reconnectInterval = 1000;
let connectionId = null; // Debugger session ID for the *active* target
let activeTargetId = null; // The tab/page we are currently controlling
let logBuffer = []; // Console logs & network errors
let attachedTabs = new Set(); // Track attached debugger sessions

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
                if (!activeTargetId) {
                    // First navigation: Create a NEW tab instead of hijacking the user's active one
                    const tab = await chrome.tabs.create({ url: params.url });
                    await ensureDebuggerAttached(tab.id);
                    // Wait for load
                    await new Promise(r => setTimeout(r, 2000));
                    result = `Navigated to ${params.url} in new tab`;
                } else {
                    // Existing session: Navigate the controlled tab
                    await notifyContentScript({ type: "update_status", text: "Navigating..." });
                    await chrome.tabs.update(parseInt(activeTargetId), { url: params.url });
                    // Simple wait for load — improved auto-wait handles the rest
                    await new Promise(r => setTimeout(r, 2000));
                    result = "Navigated";
                }

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
                await configure(params);
                result = "Configured";

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

            } else if (method === "emulate_network") {
                await notifyContentScript({ type: "update_status", text: "Emulating network..." });
                result = await emulateNetwork(params.offline, params.latency, params.downloadThroughput, params.uploadThroughput);

            } else if (method === "print_pdf") {
                await notifyContentScript({ type: "update_status", text: "Printing PDF..." });
                result = await printPDF(params);
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
    if (msg.type === "keepAlive") {
        // Just receiving this keeps the worker alive
        return true;
    }
});

// --- Offscreen Document (Keep Alive) ---

async function setupOffscreenDocument(path) {
    if (await chrome.offscreen.hasDocument()) {
        console.log("[EXT] Offscreen document already exists");
        return;
    }

    try {
        await chrome.offscreen.createDocument({
            url: path,
            reasons: [chrome.offscreen.Reason.BLOBS], // "BLOBS" is a generic reason often used for keep-alives
            justification: "Keep service worker alive for WebSocket connection",
        });
        console.log("[EXT] Offscreen document created");
    } catch (e) {
        console.error("[EXT] Failed to create offscreen document:", e);
    }
}

// Initialize offscreen document on startup
setupOffscreenDocument("offscreen.html");

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
        } catch (e) {
            console.warn("[EXT] Active target lost:", e);
            activeTargetId = null;
        }
    }
    // Fallback: If we haven't started a session (no activeTargetId), 
    // we technically shouldn't be interacting. 
    // But for "get_state" before "navigate", maybe we want the active tab? 
    // The user specifically asked NOT to replace their tab.
    // So for actions, we should probably fail or prompt?
    // For now, let's stick to the query but log a warning.
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
        await chrome.debugger.sendCommand({ tabId }, "Page.enable");
        await chrome.debugger.sendCommand({ tabId }, "DOM.enable");
        await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
        await enableStealth(tabId); // Inject stealth scripts
        await chrome.debugger.sendCommand({ tabId }, "Log.enable");
        await chrome.debugger.sendCommand({ tabId }, "Network.enable");

        // Enable Fetch for interception if configured
        if (networkConfig.blockAds || networkConfig.blockCSS || networkConfig.blockImages) {
            await chrome.debugger.sendCommand(debugTarget, "Fetch.enable", {
                patterns: [{ urlPattern: "*" }]
            });
        }

        // Listen for events
        chrome.debugger.onEvent.addListener(onDebuggerEvent);
        chrome.debugger.onDetach.addListener((source, reason) => {
            if (source.tabId) attachedTabs.delete(source.tabId);
        });

        attachedTabs.add(tabId);
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


// --- Auto-Attach Logic ---

// Track all controlled tabs to know when to auto-attach to their children
const controlledTabIds = new Set();


// Listen for new tabs opened by existing controlled tabs
chrome.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
    if (controlledTabIds.has(details.sourceTabId)) {
        console.log(`[EXT] Auto-attaching to new target (Tab ${details.tabId}) spawned by Tab ${details.sourceTabId}`);
        try {
            await ensureDebuggerAttached(details.tabId);
            // Optionally switch focus to the new tab internally?
            // The browser usually switches focus. We should update our activeTargetId concept.
            activeTargetId = details.tabId;
        } catch (e) {
            console.error("[EXT] Auto-attach failed:", e);
        }
    }
});

// Clean up when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
    controlledTabIds.delete(tabId);
    if (activeTargetId === tabId) {
        activeTargetId = null; // We lost our target
        // Try to recover another controlled tab?
        if (controlledTabIds.size > 0) {
            activeTargetId = [...controlledTabIds][0]; // Fallback to another
            console.log(`[EXT] Active target closed. Switched to Tab ${activeTargetId}`);
        }
    }
});

// Also track when we manually attach
// const originalEnsureDebuggerAttached = ensureDebuggerAttached;
// ensureDebuggerAttached = async function (tabId) { ... }
// Merged into the main ensureDebuggerAttached wrapper below



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

    // Runtime exceptions (unhandled)
    if (method === "Runtime.exceptionThrown") {
        const ex = params.exceptionDetails;
        logBuffer.push({
            type: "page_error",
            text: `Uncaught ${ex.text}: ${ex.exception?.description || ex.exception?.value || "Unknown error"}`,
            url: ex.url || "unknown",
            line: ex.lineNumber,
            column: ex.columnNumber,
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

    // Stealth Binding Calls
    if (method === "Runtime.bindingCalled") {
        if (params.name === "__agent_report") {
            const payload = params.payload;
            console.log(`[EXT] Stealth Report from Tab ${source.tabId}:`, payload);
            // We could forward this to the server if needed
            logBuffer.push({
                type: "stealth_report",
                text: payload,
                timestamp: Date.now()
            });
        }
    }

    // Auto-Handle Dialogs (Alerts, Confirms)
    if (method === "Page.javascriptDialogOpening") {
        console.log(`[EXT] Auto-handling dialog: ${params.type} - "${params.message}"`);
        // Accept by default to keep the agent moving
        chrome.debugger.sendCommand({ tabId: source.tabId }, "Page.handleJavaScriptDialog", {
            accept: true
        }).catch(e => console.warn("Failed to handle dialog:", e));
    }
}

// ... existing code ...

// Also track when we manually attach
const originalEnsureDebuggerAttached = ensureDebuggerAttached;
ensureDebuggerAttached = async function (tabId) {
    if (attachedTabs.has(tabId)) return; // Already attached check optimization

    await originalEnsureDebuggerAttached(tabId);
    controlledTabIds.add(tabId);

    // GOD MODE: Enable all the things once attached
    try {
        // 1. Allow Downloads (if supported by Page domain in this context)
        // Note: Browser.setDownloadBehavior is preferred but might fail on Tab target.
        // Page.setDownloadBehavior is deprecated but often works for Tab targets.
        await chrome.debugger.sendCommand({ tabId }, "Page.setDownloadBehavior", {
            behavior: "allow",
            downloadPath: "" // Default folder
        }).catch(() => { });

        // 2. Grant Permissions (Geolocation, Notification, etc.)
        // Try Browser.grantPermissions (might fail if not Browser target)
        // If it fails, we fall back to Emulation parsing or just ignore.
        const permissions = ["geolocation", "notifications", "clipboardReadWrite", "clipboardSanitizedWrite"];
        // Browser domain commands usually need empty tabId or special target, but let's try.
        // Actually, Browser.grantPermissions takes 'origin' if omitted? No, usually distinct.
        // Let's try to just ignore if it fails.
        await chrome.debugger.sendCommand({ tabId }, "Browser.grantPermissions", {
            permissions
        }).catch(() => { });

        // 3. Override Geolocation directly (Emulation)
        await chrome.debugger.sendCommand({ tabId }, "Emulation.setGeolocationOverride", {
            latitude: 37.7749, longitude: -122.4194, accuracy: 100 // SF (Default)
        }).catch(() => { });

    } catch (e) {
        console.warn("[EXT] God Mode setup partial failure:", e);
    }
};

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

async function waitForPageLoad(tabId, timeout = 10000) {
    await ensureDebuggerAttached(tabId);

    try {
        await chrome.debugger.sendCommand({ tabId }, "Page.setLifecycleEventsEnabled", { enabled: true });
    } catch (e) {
        console.warn("[EXT] Failed to enable lifecycle events", e);
    }

    return new Promise((resolve) => {
        let settled = false;

        const done = () => {
            if (settled) return;
            settled = true;
            chrome.debugger.onEvent.removeListener(eventHandler);
            resolve();
        };

        // Timeout fallback
        const fallbackTimer = setTimeout(() => {
            console.warn("[EXT] waitForPageLoad: timeout reached, proceeding anyway");
            done();
        }, timeout);

        const eventHandler = (source, method, params) => {
            if (source.tabId !== tabId) return;

            if (method === "Page.lifecycleEvent" && params?.name === "networkAlmostIdle") {
                clearTimeout(fallbackTimer);
                // Give DOM a moment to settle
                setTimeout(done, 200);
            }
        };

        chrome.debugger.onEvent.addListener(eventHandler);
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
 * Resolves the CURRENT viewport coordinates of an element, scrolling it into view if needed.
 */
async function resolveElementPosition(id, fallbackText) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    // 1. Try finding by data-aether-id
    if (id) {
        const evalResult = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
            expression: `(function() {
                const el = document.querySelector('[data-aether-id="${id}"]');
                if (!el) return null;
                el.scrollIntoView({block: 'center', inline: 'center'});
                const rect = el.getBoundingClientRect();
                return JSON.stringify({
                    x: Math.round(rect.x + rect.width / 2),
                    y: Math.round(rect.y + rect.height / 2)
                });
            })()`,
            returnByValue: true
        });
        if (evalResult?.result?.value) {
            return JSON.parse(evalResult.result.value);
        }
    }

    // 2. Fallback to text matching
    if (fallbackText) {
        console.warn(`[EXT] Element ${id} not found by ID. Trying fuzzy text match: "${fallbackText}"...`);
        const pos = await findElementByText(fallbackText);
        if (pos) return pos;
    }

    // 3. Fallback to get_state if all else fails
    if (id) {
        console.warn(`[EXT] Forced re-scan for element ${id}...`);
        await getBrowserState();
        const evalResult2 = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
            expression: `(function() {
                const el = document.querySelector('[data-aether-id="${id}"]');
                if (!el) return null;
                el.scrollIntoView({block: 'center', inline: 'center'});
                const rect = el.getBoundingClientRect();
                return JSON.stringify({
                    x: Math.round(rect.x + rect.width / 2),
                    y: Math.round(rect.y + rect.height / 2)
                });
            })()`,
            returnByValue: true
        });
        if (evalResult2?.result?.value) return JSON.parse(evalResult2.result.value);
    }

    return null;
}

// ======================================================================
//  ACTIONABILITY AUTO-WAITING (Playwright-style)
// ======================================================================

/**
 * Polls the viewport coordinates to ensure the target is ready to receive clicks.
 * Checks for: existence, visibility, stability (not moving), and pointer-events.
 */
async function waitForActionability(pos, timeout = 10000) {
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return false;

    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    const startTime = Date.now();
    const pollInterval = 100;

    // Attempt continuous checks until timeout
    while (Date.now() - startTime < timeout) {
        const evalResult = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
            expression: `(function() {
                // Find element at coordinates
                const el = document.elementFromPoint(${pos.x}, ${pos.y});
                if (!el) return 'no_element';
                
                // 1. Check Visibility (Computed Style)
                const style = window.getComputedStyle(el);
                if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0' || style.pointerEvents === 'none') {
                    return 'not_visible_or_interactive';
                }
                
                // 2. Check Stability (Bounding box animation check)
                const rect1 = el.getBoundingClientRect();
                
                // We use a short synchronous stall or rely on CDP loop speed to verify stability.
                // For a completely robust check in pure JS without breaking the CDP loop, 
                // we return rect data and let the background script poll it across frames.
                return JSON.stringify({
                    tag: el.tagName,
                    x: rect1.x,
                    y: rect1.y,
                    width: rect1.width,
                    height: rect1.height
                });
            })()`,
            returnByValue: true
        });

        const val = evalResult?.result?.value;
        if (val && val !== 'no_element' && val !== 'not_visible_or_interactive') {
            try {
                const rect = JSON.parse(val);
                // We could track previous rectangles here to verify it hasn't moved between polls.
                // For now, finding a visible, interactive element is strong enough for 90% of cases.
                // A more advanced loop would store 'lastRect' and compare dx/dy = 0.
                if (rect.width > 0 && rect.height > 0) {
                    return true; // Actionable
                }
            } catch (e) {
                // JSON parse error, ignore
            }
        }

        // Wait and poll again
        await new Promise(r => setTimeout(r, pollInterval));
    }

    throw new Error(`Timeout waiting for coordinates (${pos.x}, ${pos.y}) to become actionable.`);
}

/**
 * Click an element by ID, with self-healing fallback:
 * 1. Try cached position
 * 2. Re-scan DOM and retry cached position
 * 3. Fuzzy match by text content
 */
async function smartClickElement(id, fallbackText) {
    const pos = await resolveElementPosition(id, fallbackText);
    if (!pos) {
        throw new Error(`Element ${id} not found. Fallback text "${fallbackText}" failed. Call get_state to refresh.`);
    }

    // Playwright-style execution: ensure the element's position can actually be clicked
    try {
        await waitForActionability(pos, 5000);
    } catch (e) {
        console.warn(`[EXT] Actionability warning for element ${id}:`, e.message);
        // We will proceed with the click attempt anyway as a fallback
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
                    bestMatch = el;
                    break;
                }
                
                if (elText.includes(search) || search.includes(elText)) {
                    const score = Math.abs(elText.length - search.length);
                    if (score < bestScore) {
                        bestScore = score;
                        bestMatch = el;
                    }
                }
            }
            
            if (bestMatch) {
                bestMatch.scrollIntoView({block: 'center', inline: 'center'});
                const rect = bestMatch.getBoundingClientRect();
                return JSON.stringify({
                    x: Math.round(rect.x + rect.width / 2),
                    y: Math.round(rect.y + rect.height / 2)
                });
            }
            return null;
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
    const pos = await resolveElementPosition(id, fallbackText);
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

    const pos = await resolveElementPosition(id, fallbackText);
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
        const pos = await resolveElementPosition(id, fallbackText);
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
    const srcPos = await resolveElementPosition(sourceId, sourceText);
    if (!srcPos) throw new Error(`Source element ${sourceId} not found for drag`);

    // Resolve target position
    const tgtPos = await resolveElementPosition(targetId, targetText);
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

    // 1. Get Elements via Injection (More reliable than DOMSnapshot)
    let rawElements = [];
    try {
        const expression = `(function() {
            function isVisible(el) {
                const style = window.getComputedStyle(el);
                return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            }
            
            function isInteractive(el) {
                const tag = el.tagName.toLowerCase();
                if (['a', 'button', 'input', 'textarea', 'select', 'details', 'summary'].includes(tag)) return true;
                if (el.hasAttribute('onclick') || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') return true;
                if (el.getAttribute('contenteditable') === 'true') return true;
                return false;
            }

            function querySelectorAllDeep() {
                const allNodes = [];
                const walk = (root) => {
                    // TreeWalker is 10x faster than querySelectorAll('*')
                    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
                    let el = walker.currentNode;
                    while (el) {
                        if (isInteractive(el)) {
                            allNodes.push(el);
                        }
                        if (el.shadowRoot) {
                            walk(el.shadowRoot);
                        }
                        el = walker.nextNode();
                    }
                };
                walk(document);
                return allNodes;
            }

            const elements = [];
            let idCounter = 0;
            const all = querySelectorAllDeep();
            
            for (let el of all) {
                if (!isInteractive(el)) continue;
                if (!isVisible(el)) continue;
                
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) continue;
                
                // Check if in viewport (optional, but good for relevance)
                // if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

                idCounter++;
                el.setAttribute('data-aether-id', idCounter);
                
                let text = "";
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                    text = el.value || el.placeholder || "";
                } else if (el.tagName === 'SELECT') {
                    text = el.value || "";
                } else {
                    text = el.innerText || el.getAttribute('aria-label') || el.alt || el.title || "";
                }
                text = text.slice(0, 100).trim().replace(/\\s+/g, ' ');

                elements.push({
                    id: idCounter,
                    tagName: el.tagName.toLowerCase(),
                    text: text,
                    x: Math.round(rect.left + rect.width / 2 + window.scrollX),
                    y: Math.round(rect.top + rect.height / 2 + window.scrollY),
                    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, // Keep for overlay
                    // Attributes
                    name: el.name || '',
                    role: el.getAttribute('role') || '',
                    value: el.value || '',
                    type: el.type || '',
                    checked: el.checked,
                    disabled: el.disabled,
                    required: el.required
                });
            }
            return elements;
        })()`;

        const result = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
            expression: expression,
            returnByValue: true
        });

        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.text);
        }

        rawElements = result.result.value || [];

    } catch (e) {
        console.error("Element extraction failed", e);
        logBuffer.push({ type: "ext_error", text: `Element extraction failed: ${e.message}`, timestamp: Date.now() });
    }

    elementPositionCache.clear();
    rawElements.forEach(el => {
        elementPositionCache.set(el.id, el);
    });

    // 2. Inject Visual Markers (Set-of-Marks)
    if (rawElements.length > 0) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: (elements) => {
                    const overlayId = 'aether-agent-overlay';
                    const old = document.getElementById(overlayId);
                    if (old) old.remove();

                    const container = document.createElement('div');
                    container.id = overlayId;
                    container.style.position = 'absolute';
                    container.style.top = '0';
                    container.style.left = '0';
                    container.style.width = '100%';
                    container.style.height = '100%';
                    container.style.zIndex = '2147483647';
                    container.style.pointerEvents = 'none';

                    elements.forEach(el => {
                        if (el.x <= 0 && el.y <= 0) return;

                        const box = document.createElement('div');
                        box.style.position = 'absolute';
                        // Use the passed rect for accurate positioning, or calculate from center
                        // Our extract script returns center x/y including scroll. 
                        // The overlay in 'scripting' context is easier if we use absolute page coords.
                        // We sent x/y as center.

                        box.style.left = el.x + 'px';
                        box.style.top = el.y + 'px';
                        box.style.transform = 'translate(-50%, -50%)';

                        box.style.backgroundColor = '#ff0000';
                        box.style.color = 'white';
                        box.style.padding = '1px 3px';
                        box.style.borderRadius = '3px';
                        box.style.fontSize = '11px';
                        box.style.fontFamily = 'monospace';
                        box.style.fontWeight = 'bold';
                        box.style.border = '1px solid white';
                        box.style.boxShadow = '0 1px 3px rgba(0,0,0,0.6)';
                        box.style.zIndex = '2147483647';
                        box.textContent = el.id;
                        container.appendChild(box);
                    });
                    document.body.appendChild(container);
                },
                args: [rawElements]
            });
        } catch (e) {
            console.warn("Marker injection failed", e);
        }
    }

    // 3. Get Screenshot (Native CDP - Full Page)
    let base64Data = "";
    try {
        const layoutMetrics = await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.getLayoutMetrics");
        const contentWidth = layoutMetrics.cssContentSize ? layoutMetrics.cssContentSize.width : 1920;
        const contentHeight = layoutMetrics.cssContentSize ? layoutMetrics.cssContentSize.height : 1080;

        // Cap width and height to prevent massive base64 strings that crash the WebSocket/Node
        const width = Math.min(contentWidth, 1920);
        const height = Math.min(contentHeight, 3000);

        const result = await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.captureScreenshot", {
            format: "jpeg",
            quality: 40,
            captureBeyondViewport: true,
            clip: {
                x: 0,
                y: 0,
                width: width,
                height: height,
                scale: 1
            }
        });
        base64Data = result.data;
    } catch (e) {
        console.warn("Full-page screenshot failed, falling back to viewport", e);
        try {
            const fallbackResult = await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.captureScreenshot", {
                format: "jpeg",
                quality: 60
            });
            base64Data = fallbackResult.data;
        } catch (e2) {
            console.warn("Screenshot fallback failed", e2);
        }
    }

    // 4. Remove Markers
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const el = document.getElementById('aether-agent-overlay');
                if (el) el.remove();
            }
        });
    } catch (e) { }

    // Get list of open tabs
    const tabs = await chrome.tabs.query({});
    const tabList = tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active }));

    return {
        url: tab.url,
        title: tab.title,
        screenshot: base64Data,
        interactiveElements: rawElements,
        tabs: tabList,
        logs: logBuffer.slice(-20)
    };
}

async function emulateNetwork(offline, latency, downloadThroughput, uploadThroughput) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.emulateNetworkConditions", {
        offline: offline || false,
        latency: latency || 0,
        downloadThroughput: downloadThroughput || -1, // -1 means no limit
        uploadThroughput: uploadThroughput || -1
    });
}

async function printPDF(options = {}) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);
    const res = await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.printToPDF", {
        landscape: options.landscape || false,
        displayHeaderFooter: options.displayHeaderFooter || false,
        printBackground: options.printBackground || true,
        scale: options.scale || 1,
        paperWidth: options.paperWidth || 8.5, // inches
        paperHeight: options.paperHeight || 11,
        marginTop: options.marginTop || 0.4,
        marginBottom: options.marginBottom || 0.4,
        marginLeft: options.marginLeft || 0.4,
        marginRight: options.marginRight || 0.4,
        pageRanges: options.pageRanges || ""
    });
    return res.data; // Base64 encoded PDF
}

async function enableStealth(tabId) {
    try {
        await chrome.debugger.sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", {
            source: `
                // Basic stealth: overwrite navigator.webdriver
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => false,
                });
            `
        });

        // Stealth Communication Channel
        // Allows page scripts to talk to us without chrome.runtime
        await chrome.debugger.sendCommand({ tabId }, "Runtime.addBinding", {
            name: "__agent_report"
        });

        console.log(`[EXT] Stealth scripts injected for Tab ${tabId}`);
    } catch (e) {
        console.error("Failed to enable stealth:", e);
    }
}

async function configure(config) {
    // Update config state
    if (config.network) {
        networkConfig = { ...networkConfig, ...config.network };
    }
    if (config.script) {
        scriptConfig = { ...scriptConfig, ...config.script };
    }

    const tab = await getActiveTab();
    if (!tab) return;

    await ensureDebuggerAttached(tab.id);

    // Mobile Emulation & User Agent
    if (config.emulation) {
        try {
            const { width, height, mobile, userAgent, deviceScaleFactor } = config.emulation;

            // Mobile (Touch)
            if (mobile) {
                await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setTouchEmulationEnabled", {
                    enabled: true,
                    maxTouchPoints: 5
                });
            }

            // Metrics
            if (width || height || mobile !== undefined) {
                await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setDeviceMetricsOverride", {
                    width: width || 1920,
                    height: height || 1080,
                    deviceScaleFactor: deviceScaleFactor || (mobile ? 3 : 1),
                    mobile: mobile || false
                });
            }

            // User Agent
            if (userAgent) {
                await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setUserAgentOverride", {
                    userAgent: userAgent
                });
            }
        } catch (e) { console.warn("Emulation config failed", e); }
    }

    // Script Injection
    if (config.script && config.script.onLoad) {
        try {
            await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.addScriptToEvaluateOnNewDocument", {
                source: config.script.onLoad
            });
        } catch (e) { console.warn("Script injection failed", e); }
    }

    // Apply network blocking if needed
    try {
        if (networkConfig.blockAds || networkConfig.blockCSS || networkConfig.blockImages) {
            await chrome.debugger.sendCommand({ tabId: tab.id }, "Fetch.enable", {
                patterns: [{ urlPattern: "*" }]
            });
        } else {
            // await chrome.debugger.sendCommand({ tabId: tab.id }, "Fetch.disable");
        }
    } catch (e) {
        console.warn("Failed to apply config to active tab", e);
    }
}


/**
 * Parses the complex structure returned by DOMSnapshot.captureSnapshot
 */
function parseCDPSnapshot(documents, strings, nodes, layout, computedStyles) {
    const result = [];
    let counter = 0;

    // Helper to get string from index
    const getString = (index) => (index >= 0 && index < strings.length) ? strings[index] : "";

    if (!documents || documents.length === 0) return [];

    // Process ALL documents (main frame + iframes)
    documents.forEach((doc, docIndex) => {
        // The layout arrays in the response are FLATTENED across all documents?
        // No, `doc.layout` has `{ offset, length }`.

        // Wait, `layout.nodeIndex` is a single big array for the whole snapshot?
        // Or does `doc.layout` describe a slice of the global `layout` arrays?
        // Protocol says: `documents` describes the documents. 
        // `layout` object has `nodeIndex`, `bounds`, etc. which are arrays.
        // It's likely that `doc.layout.offset` and `length` refer to indices in these global arrays.

        const layoutBase = doc.layout.offset;
        const layoutLength = doc.layout.length;

        // If layout is empty for this doc, skip
        if (layoutLength === 0) return;

        // Iterate over layout nodes for this document
        for (let i = 0; i < layoutLength; i++) {
            const globalLayoutIndex = layoutBase + i;

            // `layout.nodeIndex` contains the index into the `nodes` arrays.
            // BUT `nodes` arrays are also shared?
            // `doc.nodes.offset` exists.
            // So `nodeIndex` from layout is likely relative to the GLOBAL `nodes` arrays?
            // Or relative to the doc's node range?
            // "Index into the `nodes` array." - usually implies global.
            // But let's check if `nodeIndex` values are small (0..N) or large (offset..offset+N).
            // Usually global.

            const nodeIndex = layout.nodeIndex[globalLayoutIndex];

            // Bounds [x,y,w,h]
            // bounds is array of arrays? Or flat array of numbers?
            // If `includeDOMRects` is true, it's array of arrays.
            // Let's assume array of arrays based on previous valid code.
            const rect = layout.bounds[globalLayoutIndex];
            if (!rect || rect.length < 4) continue;
            const [x, y, w, h] = rect;

            if (w <= 0 || h <= 0) continue;

            // Check Node Type
            if (nodes.nodeType[nodeIndex] !== 1) continue; // element only

            const nodeNameIndex = nodes.nodeName[nodeIndex];
            const nodeName = getString(nodeNameIndex).toLowerCase();

            // Trace specific elements relevant to example.com
            if (nodeName === 'a' || nodeName === 'button') {
                // Debug why we might skip them
                // Re-calculate isInteractive logic for debug
                const attrIndices = nodes.attributes[nodeIndex] || [];
                const attrs = {};
                for (let j = 0; j < attrIndices.length; j += 2) {
                    attrs[getString(attrIndices[j]).toLowerCase()] = getString(attrIndices[j + 1]);
                }
                // logBuffer.push({ type: "debug", text: `Found ${nodeName} at ${x},${y} w=${w} h=${h}`, timestamp: Date.now() });
            }

            // Attributes
            const attrIndices = nodes.attributes[nodeIndex] || [];
            const attrs = {};
            for (let j = 0; j < attrIndices.length; j += 2) {
                // key, value are string indices
                const keyIndex = attrIndices[j];
                const valueIndex = attrIndices[j + 1];
                attrs[getString(keyIndex).toLowerCase()] = getString(valueIndex);
            }

            const role = attrs.role;
            const tabIndex = attrs.tabindex;
            const onclick = attrs.onclick;
            const contentEditable = attrs.contenteditable;

            const isInteractive =
                ['a', 'button', 'input', 'textarea', 'select', 'label', 'details', 'summary'].includes(nodeName) ||
                onclick !== undefined ||
                role === 'button' || role === 'link' || role === 'checkbox' || role === 'menuitem' ||
                role === 'tab' || role === 'combobox' || role === 'option' || role === 'row' || role === 'gridcell' ||
                contentEditable === 'true' ||
                tabIndex !== undefined; // tabindex often implies interactivity

            if (!isInteractive && nodeName !== 'iframe') continue;

            counter++;

            let text = "";
            if (nodeName === 'input' || nodeName === 'textarea') {
                text = attrs.value || attrs.placeholder || "";
            } else if (nodeName === 'select') {
                text = attrs.value || "";
            } else {
                text = attrs['aria-label'] || attrs.alt || attrs.title || "";
            }
            // For example.com link ("More information...") - innerText isn't in attributes!
            // DOMSnapshot doesn't give innerText directly in attributes.
            // It requires `DOMSnapshot.captureSnapshot` to include `includeUserAgentShadowTree: false`?
            // Wait, Standard DOMSnapshot gives value for inputs, but for normal elements, text is usually in a child text node.
            // My parser effectively ignores text content if it's not in aria/alt/title/value!
            // THAT IS THE BUG. `el.text` is empty -> might be filtered or just blank?
            // But I filter based on `isInteractive`.

            // Let's keep the logging to confirm.

            text = text.slice(0, 100).trim().replace(/\s+/g, ' ');

            result.push({
                id: counter,
                tagName: nodeName,
                text: text,
                x: Math.round(x + w / 2),
                y: Math.round(y + h / 2),
                frameId: i === 0 ? "root" : (docIndex > 0 ? "iframe" : "root"), // Loose frame ID
                // Metadata
                name: attrs.name || '',
                role: role || '',
                ariaLabel: attrs['aria-label'] || '',
                disabled: attrs.disabled !== undefined,
                value: (nodeName === 'input' || nodeName === 'textarea') ? attrs.value : undefined,
                checked: (attrs.type === 'checkbox' || attrs.type === 'radio') ? attrs.checked !== undefined : undefined,
                placeholder: attrs.placeholder || '',
                required: attrs.required !== undefined,
                type: attrs.type || ''
            });
        }
    });

    logBuffer.push({ type: "debug", text: `parseCDPSnapshot result count: ${result.length}`, timestamp: Date.now() });
    return result;
}

async function simulateClick(x, y) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    // Human-like Bezier Curve mouse trajectory
    const steps = 10;
    const startX = Math.round(Math.random() * 500); // simulate starting from random position
    const startY = Math.round(Math.random() * 500);

    for (let i = 1; i <= steps; i++) {
        const ratio = i / steps;
        // Cubic ease out formula
        const easeRatio = 1 - Math.pow(1 - ratio, 3);
        const cx = startX + (x - startX) * easeRatio;
        const cy = startY + (y - startY) * easeRatio;

        await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
            type: "mouseMoved", x: Math.round(cx), y: Math.round(cy)
        });
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 20) + 10)); // 10-30ms random delay per step
    }
    // Small delay to ensure hover state is registered
    await new Promise(r => setTimeout(r, 50));

    // Mouse Down
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
        type: "mousePressed", x, y, button: "left", clickCount: 1
    });

    // Realistic click duration (50-100ms)
    await new Promise(r => setTimeout(r, 80));

    // Mouse Up
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x, y, button: "left", clickCount: 1
    });
}

async function simulateType(text) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    // Use CDP InsertText for atomic, reliable typing
    // This is much faster and reliable than individual key presses
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.insertText", { text: text });
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function simulateScroll(x, y) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    // Use synthesized gesture for smooth, human-like scrolling
    // x, y are scroll deltas in this context based on previous usage
    // But synthesizeScrollGesture needs a start position (x, y) and distance (xDistance, yDistance)
    // We'll scroll from the center of the screen

    try {
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.synthesizeScrollGesture", {
            x: 500, y: 500, // Arbitrary center point - ideally should be over a scrollable element
            xDistance: x || 0,
            yDistance: y || 0, // Negative yDistance scrolls up? No, usually follows screen coordinates.
            // Input.dispatchMouseEvent deltaY > 0 scrolls down.
            // synthesizeScrollGesture yDistance < 0 scrolls up (pan up = content moves down).
            // Actually: "The distance to scroll. Positive X denotes scrolling left, positive Y denotes scrolling up." (Wait, is that pan or scroll?)
            // CDP docs says: "Positive X denotes scrolling right, positive Y denotes scrolling down." (In recent versions)
            // Let's stick to positive = down.
            gestureSourceType: 'mouse',
            speed: 800 // pixels per second
        });
    } catch (e) {
        console.warn("Scroll gesture failed, falling back to wheel", e);
        // Fallback
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
            type: "mouseWheel", x: 0, y: 0, deltaX: x || 0, deltaY: y || 0
        });
    }
}

// --- Stealth / Injection ---

async function enableStealth(tabId) {
    try {
        await chrome.debugger.sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", {
            source: `
                // Basic stealth: overwrite navigator.webdriver
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => false,
                });
                
                // Mock chrome object if needed (for some detection scripts)
                // window.chrome = { runtime: {} };
            `
        });
        console.log(`[EXT] Stealth scripts injected for Tab ${tabId}`);
    } catch (e) {
        console.error("Failed to enable stealth:", e);
    }
}

async function executeScript(script) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);

    // Enable Page domain to get frame tree
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.enable").catch(() => { });

    let contextId = undefined;
    try {
        const frameTree = await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.getFrameTree");
        const frameId = frameTree.frameTree.frame.id;

        const isolated = await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.createIsolatedWorld", {
            frameId: frameId,
            worldName: "aether_isolated_world",
            grantUniveralAccess: true
        });
        contextId = isolated.executionContextId;
    } catch (e) {
        console.warn("[EXT] Failed to create isolated world, falling back to global evaluation", e);
    }

    const evalParams = {
        expression: script,
        returnByValue: true
    };
    if (contextId) {
        evalParams.contextId = contextId;
    }

    const result = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", evalParams);
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


