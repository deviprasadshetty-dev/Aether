// Core state
let socket = null;
let reconnectInterval = 1000;
let connectionId = null; // Debugger session ID for the *active* target
let activeTargetId = null; // The tab/page we are currently controlling
let logBuffer = []; // Console logs & network errors
let attachedTabs = new Set(); // Track attached debugger sessions
let screencastFrames = []; // Buffer for Page.screencastFrame data
let criticalTimestamps = []; // Timestamps for interesting events (errors/clicks)
let globalMockPattern = null;
let globalMockResponse = null;
let traceBuffer = []; // Buffer for Tracing.dataCollected

// Cache
let activeNetworkRequests = 0;
let executionContexts = new Map(); // tabId -> [ {id, frameId, origin, name} ]
let pingInterval = null;
let agentStopTimeout = null;
let elementPositionCache = new Map(); // id -> {x, y, text, tagName, frameId}

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
                const tabId = activeTargetId ? parseInt(activeTargetId) : (await chrome.tabs.create({ url: params.url })).id;
                activeTargetId = tabId;
                await ensureDebuggerAttached(tabId);
                await notifyContentScript({ type: "update_status", text: "Navigating..." });
                await chrome.tabs.update(tabId, { url: params.url });
                await waitForLoading(tabId);
                result = "Navigated";

            } else if (method === "screenshot_region") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                const res = await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.captureScreenshot", {
                    format: "jpeg",
                    quality: 80,
                    clip: {
                        x: params.x || 0,
                        y: params.y || 0,
                        width: params.width || 100,
                        height: params.height || 100,
                        scale: 1
                    }
                });
                result = res.data;

            } else if (method === "verify_ui_state") {
                result = await verifyUIState(params.selector, params.expectedText, params.type);

            } else if (method === "get_state") {
                result = await getBrowserState(params);

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
                result = JSON.stringify(logBuffer.slice(-50)); 

            } else if (method === "get_accessibility_tree") {
                result = await getAccessibilityTree();

            } else if (method === "get_dom_tree") {
                result = await getDomTree();

            } else if (method === "configure") {
                await configure(params);
                result = "Configured";

            } else if (method === "click") {
                await notifyContentScript({ type: "show_click", x: params.x, y: params.y });
                await simulateClick(params.x, params.y, params.button || "left", params.clickCount || 1);
                result = "Clicked coordinates";

            } else if (method === "double_click") {
                await notifyContentScript({ type: "show_click", x: params.x, y: params.y });
                await simulateClick(params.x, params.y, "left", 2);
                result = "Double clicked";

            } else if (method === "right_click") {
                await notifyContentScript({ type: "show_click", x: params.x, y: params.y });
                await simulateClick(params.x, params.y, "right", 1);
                result = "Right clicked";

            } else if (method === "middle_click") {
                await notifyContentScript({ type: "show_click", x: params.x, y: params.y });
                await simulateClick(params.x, params.y, "middle", 1);
                result = "Middle clicked";

            } else if (method === "drag") {
                await notifyContentScript({ type: "update_status", text: "Dragging..." });
                await simulateDrag(params.startX, params.startY, params.endX, params.endY);
                result = "Dragged";

            } else if (method === "mouse_move") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", { type: "mouseMoved", x: params.x, y: params.y });
                result = "Mouse moved";

            } else if (method === "click_element") {
                result = await smartClickElement(params.id, params.text);

            } else if (method === "click_element_by_selector") {
                result = await smartClickElementBySelector(params.selector);

            } else if (method === "type") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
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
                } catch (e) { }
                await simulateType(params.text);
                result = "Typed";

            } else if (method === "scroll") {
                result = await simulateScroll(params.x, params.y);

            } else if (method === "evaluate") {
                result = await executeScript(params.script);

            } else if (method === "cdp_command") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                result = await chrome.debugger.sendCommand({ tabId: tab.id }, params.command, params.args || {});

            } else if (method === "get_cookies") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                const res = await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.getCookies", { urls: [tab.url] });
                result = res.cookies;

            } else if (method === "set_cookie") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.setCookie", { 
                    name: params.name, 
                    value: params.value, 
                    url: params.url || tab.url 
                });
                result = "Cookie set successfully";

            } else if (method === "clear_cache") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.clearBrowserCache", {});
                result = "Browser cache cleared";

            } else if (method === "set_geolocation") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setGeolocationOverride", { 
                    latitude: params.latitude, 
                    longitude: params.longitude, 
                    accuracy: 100 
                });
                result = `Geolocation overridden to ${params.latitude}, ${params.longitude}`;

            } else if (method === "set_timezone") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setTimezoneOverride", { 
                    timezoneId: params.timezoneId 
                });
                result = `Timezone overridden to ${params.timezoneId}`;

            } else if (method === "get_performance_metrics") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                await chrome.debugger.sendCommand({ tabId: tab.id }, "Performance.enable", {});
                const res = await chrome.debugger.sendCommand({ tabId: tab.id }, "Performance.getMetrics", {});
                result = res.metrics;

            } else if (method === "start_screencast") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                screencastFrames = []; // clear buffer
                await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.startScreencast", {
                    format: params.format || "jpeg",
                    quality: params.quality || 50,
                    maxWidth: params.maxWidth || 1024,
                    maxHeight: params.maxHeight || 768,
                    everyNthFrame: params.everyNthFrame || 10
                });
                result = "Screencast started";

            } else if (method === "stop_screencast") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.stopScreencast", {});
                result = { frames: screencastFrames };
                screencastFrames = []; // clear buffer after sending

            } else if (method === "start_tracing") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                traceBuffer = [];
                await chrome.debugger.sendCommand({ tabId: tab.id }, "Tracing.start", params.options || {});
                result = "Tracing started";

            } else if (method === "stop_tracing") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                await chrome.debugger.sendCommand({ tabId: tab.id }, "Tracing.end", {});
                // Tracing.end is async and triggers tracingComplete event. 
                // We'll wait up to 5s for the buffer to fill.
                await new Promise(r => setTimeout(r, 2000)); 
                result = { traceEvents: traceBuffer };
                traceBuffer = [];

            } else if (method === "target_auto_attach") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                await chrome.debugger.sendCommand({ tabId: tab.id }, "Target.setAutoAttach", {
                    autoAttach: true,
                    waitForDebuggerOnStart: false,
                    flatten: true
                });
                result = "Target auto-attach enabled";

            } else if (method === "enable_domain") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                await chrome.debugger.sendCommand({ tabId: tab.id }, `${params.domain}.enable`, {});
                result = `Domain ${params.domain} enabled`;

            } else if (method === "set_dom_breakpoint") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                // Get nodeId first
                const nodeRes = await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.querySelector", {
                    nodeId: (await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.getDocument", {})).root.nodeId,
                    selector: params.selector
                });
                await chrome.debugger.sendCommand({ tabId: tab.id }, "DOMDebugger.setDOMBreakpoint", {
                    nodeId: nodeRes.nodeId,
                    type: params.type || "subtree-modified"
                });
                result = `DOM breakpoint set on ${params.selector}`;

            } else if (method === "pause") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                await chrome.debugger.sendCommand({ tabId: tab.id }, "Debugger.enable", {});
                await chrome.debugger.sendCommand({ tabId: tab.id }, "Debugger.pause", {});
                result = "Browser execution paused";

            } else if (method === "resume") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                await chrome.debugger.sendCommand({ tabId: tab.id }, "Debugger.resume", {});
                result = "Browser execution resumed";

            } else if (method === "highlight_elements") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                await drawHighlights(tab.id);
                result = "Highlights drawn";

            } else if (method === "mock_network_request") {
                const tab = await getActiveTab();
                await ensureDebuggerAttached(tab.id);
                globalMockPattern = params.urlPattern;
                globalMockResponse = params.mockResponse;
                await chrome.debugger.sendCommand({ tabId: tab.id }, "Fetch.enable", {
                    patterns: [{ urlPattern: params.urlPattern, requestStage: "Response" }]
                });
                result = `Mocking enabled for pattern: ${params.urlPattern}`;

            } else if (method === "press_key") {
                await notifyContentScript({ type: "update_status", text: `Pressing ${params.modifiers?.length ? params.modifiers.join('+') + '+' : ''}${params.key}` });
                await simulateKeyPress(params.key, params.modifiers || []);
                result = "Key pressed";

            } else if (method === "wait_for_element") {
                await notifyContentScript({ type: "update_status", text: "Waiting for element..." });
                result = await waitForElement(params.selector, params.timeout || 10000);

            } else if (method === "wait_for_network_idle") {
                await notifyContentScript({ type: "update_status", text: "Waiting for network idle..." });
                result = await waitForNetworkIdle(params.timeout || 10000);

            } else if (method === "wait_for_navigation") {
                await notifyContentScript({ type: "update_status", text: "Waiting for navigation..." });
                result = await waitForNavigation(params.timeout || 10000);

            } else if (method === "assert") {
                await notifyContentScript({ type: "update_status", text: "Asserting..." });
                result = await performAssertion(params.assertionType, params.selector, params.value);

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
            resetAgentStopTimer();
        } catch (error) {
            console.error("[EXT] Command failed:", error);
            socket.send(JSON.stringify({ id, error: error.message || String(error) }));
        }
    };

    socket.onerror = () => console.error("[EXT] WebSocket error");
    socket.onclose = () => {
        console.log("[EXT] Disconnected from server");
        if (pingInterval) clearInterval(pingInterval);
        scheduleReconnect();
    };
}

function scheduleReconnect() {
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
    } catch (e) { }
}

async function injectContentScript(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content.js"],
        });
    } catch (e) { }
}

connect();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "reconnect") {
        if (socket) socket.close();
        else connect();
    }
    if (msg.type === "keepAlive") {
        // Explicitly respond to keep the SW active for this event
        sendResponse({ status: "alive" });
        return true;
    }
    if (msg.type === "status") {
        sendResponse({ connected: socket && socket.readyState === WebSocket.OPEN });
        return true;
    }
});

async function setupOffscreenDocument(path) {
    if (await chrome.offscreen.hasDocument()) return;
    try {
        await chrome.offscreen.createDocument({
            url: path,
            reasons: [chrome.offscreen.Reason.BLOBS],
            justification: "Keep service worker alive for WebSocket connection",
        });
    } catch (e) { }
}
setupOffscreenDocument("offscreen.html");

async function getActiveTab() {
    if (activeTargetId) {
        try { return await chrome.tabs.get(parseInt(activeTargetId)); }
        catch (e) { activeTargetId = null; }
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url.startsWith("chrome://")) {
        // Find first non-chrome tab
        const allTabs = await chrome.tabs.query({ currentWindow: true });
        const safeTab = allTabs.find(t => !t.url.startsWith("chrome://"));
        if (safeTab) {
            await chrome.tabs.update(safeTab.id, { active: true });
            return safeTab;
        }
        // If no safe tab, create one
        return await chrome.tabs.create({ url: "https://www.google.com" });
    }
    return tab;
}

async function ensureDebuggerAttached(tabId) {
    if (activeTargetId === tabId && connectionId) return;
    if (activeTargetId && activeTargetId !== tabId) {
        try { await chrome.debugger.detach({ tabId: parseInt(activeTargetId) }); } catch (e) { }
    }
    try {
        await chrome.debugger.attach({ tabId }, "1.3");
        activeTargetId = tabId;
        connectionId = tabId;
        await chrome.debugger.sendCommand({ tabId }, "Page.enable");
        await chrome.debugger.sendCommand({ tabId }, "DOM.enable");
        await chrome.debugger.sendCommand({ tabId }, "Page.setLifecycleEventsEnabled", { enabled: true });
        await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
        await enableStealth(tabId);
        await chrome.debugger.sendCommand({ tabId }, "Log.enable");
        await chrome.debugger.sendCommand({ tabId }, "Network.enable");
        if (!attachedTabs.has(tabId)) {
            chrome.debugger.onEvent.addListener(onDebuggerEvent);
            attachedTabs.add(tabId);
        }
    } catch (e) {
        if (!e.message.includes("Already attached")) throw e;
        activeTargetId = tabId;
        connectionId = tabId;
    }
}

function onDebuggerEvent(source, method, params) {
    if (method === "Log.entryAdded") {
        logBuffer.push({ type: "console", level: params.entry.level, text: params.entry.text, timestamp: params.entry.timestamp, url: params.entry.url });
        if (params.entry.level === 'error') criticalTimestamps.push(Date.now());
    }
    if (method === "Runtime.consoleAPICalled") {
        logBuffer.push({ type: "console_api", level: params.type, text: params.args.map(a => a.value || a.description || "").join(" "), timestamp: Date.now() });
        if (params.type === 'error') criticalTimestamps.push(Date.now());
    }
    if (method === "Tracing.dataCollected") {
        if (params.value) traceBuffer.push(...params.value);
    }
    if (method === "Tracing.tracingComplete") {
        // Handled in stop_tracing with a wait
    }
    if (method === "Target.attachedToTarget") {
        logBuffer.push({ type: "target", text: `Auto-attached to target: ${params.targetInfo.url}`, targetId: params.targetInfo.targetId });
    }
    if (method === "Page.javascriptDialogOpening") {
        chrome.debugger.sendCommand({ tabId: source.tabId }, "Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
        criticalTimestamps.push(Date.now());
    }
    if (method === "Page.screencastFrame") {
        if (screencastFrames.length < 1000) {
            const now = Date.now();
            // A frame is critical if it happened within 1s of a critical event
            const isCritical = criticalTimestamps.some(t => Math.abs(now - t) < 1000);
            screencastFrames.push({ 
                data: params.data, 
                metadata: params.metadata, 
                timestamp: now,
                isCritical: isCritical
            });
        }
        chrome.debugger.sendCommand({ tabId: source.tabId }, "Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    }
    if (method === "Fetch.requestPaused") {
        if (globalMockPattern && globalMockResponse) {
            // Check if request matches pattern (naive fallback check if pattern matching needs fine-tuning)
            const isMatch = params.request.url.includes(globalMockPattern.replace(/\*/g, ''));
            if (isMatch) {
                const bodyBase64 = btoa(globalMockResponse);
                chrome.debugger.sendCommand({ tabId: source.tabId }, "Fetch.fulfillRequest", {
                    requestId: params.requestId,
                    responseCode: 200,
                    responseHeaders: [{ name: "Content-Type", value: "application/json" }],
                    body: bodyBase64
                }).catch(() => {});
                return;
            }
        }
        chrome.debugger.sendCommand({ tabId: source.tabId }, "Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
    }
    if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
        activeNetworkRequests = Math.max(0, activeNetworkRequests - 1);
    }
    if (method === "Runtime.executionContextCreated") {
        const tabId = source.tabId;
        if (!executionContexts.has(tabId)) executionContexts.set(tabId, []);
        executionContexts.get(tabId).push(params.context);
    }
    if (method === "Runtime.executionContextsCleared") {
        executionContexts.set(source.tabId, []);
    }
}

async function getBrowserState(options = {}) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);
    
    await notifyContentScript({ type: "update_status", text: "PIERCING FRAMES..." });
    
    const contexts = executionContexts.get(tab.id) || [];
    let allElements = [];
    let idCounter = 1;

    for (const ctx of contexts) {
        try {
            const elements = await extractElementsFromContext(tab.id, ctx.id, idCounter);
            if (elements && elements.length > 0) {
                let offset = { x: 0, y: 0 };
                // If it's an iframe (non-default context), find its offset
                if (ctx.auxData && !ctx.auxData.isDefault) {
                    try {
                        const frameRes = await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.getFrameOwner", { frameId: ctx.auxData.frameId });
                        if (frameRes && frameRes.nodeId) {
                            const boxRes = await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.getBoxModel", { nodeId: frameRes.nodeId });
                            if (boxRes && boxRes.model) {
                                offset.x = boxRes.model.content[0];
                                offset.y = boxRes.model.content[1];
                            }
                        }
                    } catch (e) { /* Parent frame might be restricted */ }
                }
                
                elements.forEach(el => {
                    el.x += offset.x;
                    el.y += offset.y;
                    el.rect.x += offset.x;
                    el.rect.y += offset.y;
                    el.frameId = ctx.auxData?.frameId;
                });
                
                allElements.push(...elements);
                idCounter += elements.length;
            }
        } catch (e) {
            console.warn(`[EXT] Extraction failed for context ${ctx.id}:`, e);
        }
    }

    // Clearance Intelligence (v3.0)
    await notifyContentScript({ type: "update_status", text: "CLEARING POPUPS..." });
    await dismissPopups(tab.id);

    // Capture AXTree (v2.1 Fusion)
    try {
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Accessibility.enable");
        await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.getDocument", { depth: -1, pierce: true }); // Sync nodeIds
        const axRes = await chrome.debugger.sendCommand({ tabId: tab.id }, "Accessibility.getFullAXTree");
        const axNodes = axRes.nodes || [];
        
        for (const axNode of axNodes) {
             // If node is interactive (has role) and not already tracked
             if (axNode.role && ['button', 'link', 'textbox', 'checkbox'].includes(axNode.role.value)) {
                 // Check if we already have an element near this location or with same text
                 const exists = allElements.some(el => el.text === (axNode.name ? axNode.name.value : ''));
                 if (!exists && axNode.backendNodeId) {
                     try {
                        const nodeRes = await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.describeNode", { backendNodeId: axNode.backendNodeId });
                        if (nodeRes.node && nodeRes.node.nodeId) {
                            const boxRes = await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.getBoxModel", { nodeId: nodeRes.node.nodeId });
                            if (boxRes.model) {
                                const id = idCounter++;
                                allElements.push({
                                    id,
                                    tagName: nodeRes.node.localName || "div",
                                    text: axNode.name ? axNode.name.value : "",
                                    x: Math.round(boxRes.model.content[0] + (boxRes.model.content[2] - boxRes.model.content[0]) / 2),
                                    y: Math.round(boxRes.model.content[1] + (boxRes.model.content[5] - boxRes.model.content[1]) / 2),
                                    rect: { x: boxRes.model.content[0], y: boxRes.model.content[1], width: boxRes.model.content[2] - boxRes.model.content[0], height: boxRes.model.content[5] - boxRes.model.content[1] },
                                    role: axNode.role.value,
                                    type: "", value: "", disabled: false, checked: false
                                });
                            }
                        }
                     } catch(e) {}
                 }
             }
        }
    } catch (e) { }

    await drawHighlights(tab.id);
    await new Promise(r => setTimeout(r, 50));
    
    const screenshotResult = await captureScreenshot(tab.id, options.fullPage);
    await clearHighlights(tab.id);
    
    elementPositionCache.clear();
    allElements.forEach(el => elementPositionCache.set(el.id, el));
    const tabs = await chrome.tabs.query({});
    return {
        url: tab.url,
        title: tab.title,
        screenshot: screenshotResult || "",
        interactiveElements: allElements,
        tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active })),
        logs: logBuffer.slice(-20)
    };
}

async function dismissPopups(tabId) {
    const DISMISS_SCRIPT = `(function() {
        const keywords = ['accept', 'agree', 'consent', 'i understand', 'got it', 'close', 'dismiss', 'x'];
        const allButtons = Array.from(document.querySelectorAll('button, [role="button"], a.button, a.btn'));
        for (const btn of allButtons) {
            const text = (btn.innerText || btn.textContent || "").toLowerCase().trim();
            const isDismiss = keywords.some(k => text.includes(k) && text.length < 20);
            if (isDismiss) {
                const style = window.getComputedStyle(btn);
                if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                    btn.click();
                    return "Dismissed: " + text;
                }
            }
        }
    })()`;
    try {
        await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: DISMISS_SCRIPT });
    } catch (e) { }
}

async function extractElementsFromContext(tabId, contextId, startId) {
    const EXTRACTION_SCRIPT = `(function(startId) {
        const interactiveTags = ['a', 'button', 'input', 'textarea', 'select', 'details', 'summary'];
        const elements = [];
        let idCounter = startId;

        function isVisible(el) {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        }

        function walk(root, offset = { x: 0, y: 0 }) {
            const children = root.children || [];
            for (const el of children) {
                if (!isVisible(el)) continue;
                
                const tag = el.tagName.toLowerCase();
                const role = el.getAttribute('role') || '';
                const isInteractive = interactiveTags.includes(tag) || 
                                     el.hasAttribute('onclick') || 
                                     ['button', 'link', 'checkbox', 'radio', 'textbox'].includes(role) ||
                                     el.contentEditable === 'true' ||
                                     window.getComputedStyle(el).cursor === 'pointer';

                if (isInteractive) {
                    const id = idCounter++;
                    el.setAttribute('data-aether-id', id.toString());
                    const rect = el.getBoundingClientRect();
                    elements.push({
                        id: id, tagName: tag,
                        text: (el.innerText || el.textContent || el.value || "").trim().substring(0, 100).replace(/\s+/g, ' '),
                        x: Math.round(rect.left + rect.width / 2 + offset.x),
                        y: Math.round(rect.top + rect.height / 2 + offset.y),
                        rect: { x: rect.left + offset.x, y: rect.top + offset.y, width: rect.width, height: rect.height },
                        role: role, value: el.value || "", disabled: el.disabled || false
                    });
                }
                
                // v3.1 Shadow DOM Piercing (Recursive)
                if (el.shadowRoot) {
                    const shadowRect = el.getBoundingClientRect();
                    walk(el.shadowRoot, { x: offset.x + shadowRect.left, y: offset.y + shadowRect.top });
                }
                walk(el, offset);
            }
        }
        
        walk(document.body);
        return JSON.stringify(elements);
    })(${startId})`;

    try {
        const res = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
            expression: EXTRACTION_SCRIPT,
            contextId: contextId,
            returnByValue: true,
            awaitPromise: true
        });
        return res.result.value ? JSON.parse(res.result.value) : [];
    } catch (e) {
        return [];
    }
}

async function captureScreenshot(tabId, fullPage = false) {
    try {
        const params = fullPage ? { format: "jpeg", quality: 50, captureBeyondViewport: true } : { format: "jpeg", quality: 60 };
        const res = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", params);
        return res.data;
    } catch (e) { return ""; }
}

async function simulateClick(x, y, button = "left", clickCount = 1) {
    const tab = await getActiveTab();
    
    // v2.1 Hit-Testing (v3.0 Resilience)
    try {
        const hitRes = await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.getNodeForLocation", { x, y });
        if (hitRes && hitRes.backendNodeId) {
             // If we're hitting something that isn't what we intended (and it's not a child), we might be obstructed.
        }
    } catch (e) {
        // If hit-test fails or is blocked, throw to trigger smartClick retry
        if (e.message.includes("Node is detached") || e.message.includes("Could not find node")) {
            throw new Error("Target obstructed or moved");
        }
    }

    // Dispatch mouse events in rapid succession for a "snappy" feel
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });
}

async function simulateDrag(startX, startY, endX, endY) {
    const tab = await getActiveTab();
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", { type: "mouseMoved", x: startX, y: startY });
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", { type: "mousePressed", x: startX, y: startY, button: "left", clickCount: 1 });
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", { type: "mouseMoved", x: endX, y: endY, button: "left" });
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", { type: "mouseReleased", x: endX, y: endY, button: "left", clickCount: 1 });
}

async function simulateKeyPress(key, modifiers = []) {
    const tab = await getActiveTab();
    const modifierMask = { 'Alt': 1, 'Control': 2, 'Ctrl': 2, 'Meta': 4, 'Command': 4, 'Shift': 8 };
    let modifiersBitmask = 0;
    modifiers.forEach(m => { modifiersBitmask |= (modifierMask[m] || 0); });

    const keyData = KEY_MAP[key] || { key: key, code: key, keyCode: key.toUpperCase().charCodeAt(0) };
    const eventParams = {
        modifiers: modifiersBitmask,
        key: keyData.key,
        code: keyData.code,
        windowsVirtualKeyCode: keyData.keyCode,
        nativeVirtualKeyCode: keyData.keyCode
    };
    
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", { type: "keyDown", ...eventParams });
    await new Promise(r => setTimeout(r, 20));
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", { type: "keyUp", ...eventParams });
}

async function simulateType(text) {
    const tab = await getActiveTab();
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.insertText", { text });
}

async function fillFormField(id, value, fallbackText) {
    await smartClickElement(id, fallbackText);
    await new Promise(r => setTimeout(r, 50));
    const tab = await getActiveTab();
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
        expression: `(function() {
            const el = document.activeElement;
            if (!el) return;
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                el.focus(); el.select(); document.execCommand('delete', false);
                if (el.value) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
            } else if (el.isContentEditable) {
                el.focus(); document.execCommand('selectAll', false); document.execCommand('delete', false);
            }
        })()`
    });
    await simulateType(value);
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", { expression: `(function() { const el = document.activeElement; if (el) { el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('blur', { bubbles: true })); } })()` });
    return `Filled element ${id} with "${value}"`;
}

async function smartClickElement(id, fallbackText) {
    let target = await resolveElementPosition(id, fallbackText);
    if (!target) throw new Error(`Element ${id} not found.`);
    
    await notifyContentScript({ type: "show_click", x: target.x, y: target.y });
    
    // Stale-Node Recovery Loop (v3.0 Resilience)
    let retry = 0;
    while (retry < 2) {
        try {
            await simulateClick(target.x, target.y);
            // v3.1 Mutation Guard: Verify action result
            await new Promise(r => setTimeout(r, 100)); 
            break;
        } catch (e) {
            if (e.message.includes("obstructed") || e.message.includes("detached")) {
                retry++;
                await new Promise(r => setTimeout(r, 200));
                const newState = await getBrowserState();
                target = newState.interactiveElements.find(el => el.text === target.text);
                if (!target) throw e;
            } else {
                throw e;
            }
        }
    }
    return `Clicked element ${target.text} at ${target.x}, ${target.y}`;
}

async function smartClickElementBySelector(selector) {
    const tab = await getActiveTab();
    const res = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
        expression: `(function() {
            const el = document.querySelector(\`${selector.replace(/`/g, '\\`')}\`);
            if (!el) return null;
            el.scrollIntoView({block: 'center', inline: 'center'});
            const r = el.getBoundingClientRect();
            return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: el.tagName.toLowerCase(), id: el.id, className: el.className });
        })()`,
        returnByValue: true
    });
    const pos = res.result.value ? JSON.parse(res.result.value) : null;
    if (!pos) throw new Error(`Element with selector ${selector} not found.`);
    await notifyContentScript({ type: "show_click", x: pos.x, y: pos.y });
    await simulateClick(pos.x, pos.y);
    return { success: true, elementClicked: `${pos.tag}${pos.id ? '#' + pos.id : ''}${pos.className ? '.' + pos.className.replace(/ /g, '.') : ''}` };
}

async function resolveElementPosition(id, fallbackText) {
    if (id && elementPositionCache.has(Number(id))) {
        const el = elementPositionCache.get(Number(id));
        return { x: el.x, y: el.y, text: el.text };
    }

    const tab = await getActiveTab();
    const res = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
        expression: `(function() {
            let el = document.querySelector('[data-aether-id="${id}"]');
            if (!el && ${fallbackText ? 'true' : 'false'}) {
                const text = \`${fallbackText ? fallbackText.replace(/`/g, '\\`') : ''}\`;
                const xpath = "//button[contains(text(), '" + text + "')] | //a[contains(text(), '" + text + "')] | //*[contains(text(), '" + text + "')]";
                const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                if (result.singleNodeValue) el = result.singleNodeValue;
            }
            if (!el) return null;
            el.scrollIntoView({block: 'center', inline: 'center'});
            const r = el.getBoundingClientRect();
            return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: el.innerText || el.textContent });
        })()`,
        returnByValue: true
    });
    return res.result.value ? JSON.parse(res.result.value) : null;
}

async function getDomTree() {
    const tab = await getActiveTab();
    const res = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
        expression: `(function() {
            function buildNode(el) {
                if (el.nodeType === Node.TEXT_NODE) {
                    const text = el.textContent.trim();
                    return text ? text : null;
                }
                if (el.nodeType !== Node.ELEMENT_NODE) return null;
                const tag = el.tagName.toLowerCase();
                if (tag === 'script' || tag === 'style' || tag === 'svg' || tag === 'path') return null;
                const node = { tag };
                if (el.id) node.id = el.id;
                if (el.className && typeof el.className === 'string') node.class = el.className;
                if (el.hasAttribute('href')) node.href = el.getAttribute('href');
                if (el.hasAttribute('data-aether-id')) node.aetherId = el.getAttribute('data-aether-id');
                const children = [];
                for (let child of el.childNodes) {
                    const childNode = buildNode(child);
                    if (childNode) children.push(childNode);
                }
                if (children.length > 0) {
                    if (children.length === 1 && typeof children[0] === 'string') {
                        node.text = children[0];
                    } else {
                        node.children = children;
                    }
                }
                return node;
            }
            return JSON.stringify(buildNode(document.body));
        })()`,
        returnByValue: true
    });
    return res.result.value ? JSON.parse(res.result.value) : null;
}

async function getAccessibilityTree() {
    const tab = await getActiveTab();
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Accessibility.enable");
    const { nodes } = await chrome.debugger.sendCommand({ tabId: tab.id }, "Accessibility.getFullAXTree");
    const nodeMap = new Map();
    nodes.forEach(n => nodeMap.set(n.nodeId, n));
    function simplify(n) {
        const name = n.name?.value, role = n.role?.value;
        const children = (n.childIds || []).map(id => simplify(nodeMap.get(id))).filter(c => c);
        if (!role && !name && !children.length) return null;
        const clean = { role, name };
        if (children.length) clean.children = children;
        return clean;
    }
    return nodes.filter(n => !n.parentId).map(simplify).filter(n => n);
}

async function enableStealth(tabId) {
    const script = `
        // Comprehensive Stealth Protocol v3.1
        const overwriteLabel = (proto, key, payload) => {
            Object.defineProperty(proto, key, { get: () => payload, configurable: true });
        };
        
        // 1. Hide WebDriver
        const nav = navigator.__proto__;
        delete nav.webdriver;
        overwriteLabel(nav, 'webdriver', false);
        
        // 2. Fix Hardware Profile
        overwriteLabel(nav, 'languages', ['en-US', 'en']);
        overwriteLabel(nav, 'deviceMemory', 8);
        overwriteLabel(nav, 'hardwareConcurrency', 8);
        
        // 3. Emulate Chrome Runtime
        window.chrome = {
            runtime: {
                OnInstalledReason: { INSTALL: 'install', UPDATE: 'update' },
                OnRestartRequiredReason: { APP_UPDATE: 'app_update' },
                PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android' },
                RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update' }
            },
            app: { isInstalled: false }
        };

        // 4. Mock Plugins (Native Profile)
        const mockPlugins = [
            { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Google Chrome PDF Viewer' },
            { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }
        ];

        const pluginArray = Object.create(PluginArray.prototype);
        mockPlugins.forEach((p, i) => {
            const plugin = Object.create(Plugin.prototype);
            overwriteLabel(plugin, 'name', p.name);
            overwriteLabel(plugin, 'filename', p.filename);
            overwriteLabel(plugin, 'description', p.description);
            overwriteLabel(plugin, 'length', 0);
            pluginArray[i] = plugin;
            pluginArray[p.name] = plugin;
        });
        overwriteLabel(pluginArray, 'length', mockPlugins.length);
        overwriteLabel(nav, 'plugins', pluginArray);
        
        // 5. User-Agent Stability (Golden Profile)
        const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
        overwriteLabel(nav, 'userAgent', UA);
        overwriteLabel(nav, 'appVersion', UA.replace('Mozilla/', ''));
    `;
    // Apply globally to every new document
    await chrome.debugger.sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", { source: script });
    // Apply immediately to current execution context
    await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: script });
}

async function executeScript(script) {
    const tab = await getActiveTab();
    const res = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", { expression: script, returnByValue: true });
    return res.result.value;
}

async function selectOption(id, value, fallback) {
    const tab = await getActiveTab();
    const pos = await resolveElementPosition(id, fallback);
    if (!pos) throw new Error(`Element ${id} not found.`);
    const res = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
        expression: `(function() {
            let el = document.querySelector('[data-aether-id="${id}"]');
            if (!el) return false;
            el.focus();
            el.value = "${value}";
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()`,
        returnByValue: true
    });
    return res.result.value ? `Selected option ${value}` : "Failed to select option";
}

async function setCheckbox(id, checked, fallback) {
    const tab = await getActiveTab();
    const pos = await resolveElementPosition(id, fallback);
    if (!pos) throw new Error(`Element ${id} not found.`);
    const res = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
        expression: `(function() {
            let el = document.querySelector('[data-aether-id="${id}"]');
            if (!el) return false;
            el.checked = ${checked};
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()`,
        returnByValue: true
    });
    return res.result.value ? `Checkbox set to ${checked}` : "Failed to set checkbox";
}

async function uploadFile(id, files, fallback) {
    const tab = await getActiveTab();
    const res = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
        expression: `document.querySelector('[data-aether-id="${id}"]')`,
    });
    const objectId = res.result.objectId;
    if (!objectId) throw new Error("File input not found");
    const nodeRes = await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.requestNode", { objectId });
    await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.setFileInputFiles", {
        files: files,
        nodeId: nodeRes.nodeId
    });
    return `Uploaded ${files.length} files`;
}

async function drawHighlights(tabId) {
    const expression = `(function() {
        const existing = document.getElementById('aether-highlights');
        if (existing) existing.remove();
        const container = document.createElement('div');
        container.id = 'aether-highlights';
        container.style.position = 'absolute';
        container.style.top = '0'; container.style.left = '0';
        container.style.width = '100%'; container.style.height = '100%';
        container.style.pointerEvents = 'none'; container.style.zIndex = '2147483647';
        document.body.appendChild(container);

        document.querySelectorAll('[data-aether-id]').forEach(el => {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;
            const box = document.createElement('div');
            box.style.position = 'absolute';
            box.style.left = (rect.left + window.scrollX) + 'px';
            box.style.top = (rect.top + window.scrollY) + 'px';
            box.style.width = rect.width + 'px'; box.style.height = rect.height + 'px';
            box.style.border = '2px solid rgba(59, 130, 246, 0.5)';
            box.style.backgroundColor = 'rgba(59, 130, 246, 0.1)';
            
            const label = document.createElement('div');
            label.innerText = el.getAttribute('data-aether-id');
            label.style.position = 'absolute'; label.style.top = '-18px';
            label.style.backgroundColor = 'rgba(59, 130, 246, 0.9)'; label.style.color = 'white';
            label.style.fontSize = '12px'; label.style.padding = '2px 4px';
            box.appendChild(label);
            container.appendChild(box);
        });
    })()`;
    await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression });
}

async function clearHighlights(tabId) {
    await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: `const e = document.getElementById('aether-highlights'); if (e) e.remove();` });
}

async function hoverElement(id, x, y, fallback) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);
    let tx = x, ty = y;
    if (id) {
        const pos = await resolveElementPosition(id, fallback);
        if (!pos) throw new Error(`Element ${id} not found.`);
        tx = pos.x; ty = pos.y;
    }
    await notifyContentScript({ type: "show_click", x: tx, y: ty });
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", { type: "mouseMoved", x: tx, y: ty });
    return `Hovered at ${tx}, ${ty}`;
}

async function dragAndDrop(sid, tid) {
    const spos = await resolveElementPosition(sid, null);
    const tpos = await resolveElementPosition(tid, null);
    if (!spos || !tpos) throw new Error("Source or target element not found");
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", { type: "mouseMoved", x: spos.x, y: spos.y });
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: spos.x, y: spos.y });
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", { type: "mouseMoved", x: tpos.x, y: tpos.y, button: "left" });
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: tpos.x, y: tpos.y });
    return `Dragged element ${sid} to ${tid}`;
}

async function emulateNetwork(off, lat, d, u) {
    const tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.emulateNetworkConditions", { offline: !!off, latency: lat || 0, downloadThroughput: d || -1, uploadThroughput: u || -1 });
    return "Network conditions emulated";
}

async function printPDF(opts) { const res = await chrome.debugger.sendCommand({ tabId: (await getActiveTab()).id }, "Page.printToPDF", opts); return res.data; }

async function simulateScroll(x, y) { 
    const tab = await getActiveTab();
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 0, y: 0, deltaX: x || 0, deltaY: y || 0 });
    // Minimal wait for scroll to trigger
    await new Promise(r => setTimeout(r, 50)); 
    const res = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", { expression: `JSON.stringify({ scrollY: window.scrollY, innerHeight: window.innerHeight, scrollHeight: document.body.scrollHeight })`, returnByValue: true });
    const info = res.result.value ? JSON.parse(res.result.value) : { scrollY: 0, innerHeight: 0, scrollHeight: 0 };
    return { success: true, scrolledBy: y || x, currentPosition: info.scrollY, isAtBottom: info.scrollY + info.innerHeight >= info.scrollHeight - 10 };
}

async function configure(c) {
    const tab = await getActiveTab();
    if (c.network) {
        let blocked = [];
        if (c.network.blockImages) blocked.push("*.jpg", "*.jpeg", "*.png", "*.gif", "*.webp");
        if (c.network.blockCSS) blocked.push("*.css");
        if (c.network.blockAds) blocked.push("*doubleclick.net*", "*google-analytics.com*", "*tracker*");
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.setBlockedURLs", { urls: blocked });
    }
    if (c.emulation) {
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setDeviceMetricsOverride", { width: c.emulation.width || 1024, height: c.emulation.height || 768, deviceScaleFactor: 1, mobile: !!c.emulation.mobile });
    }
    return "Configuration applied";
}

async function waitForElement(selector, timeoutMs) {
    const tab = await getActiveTab();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const res = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", { expression: `!!document.querySelector(\`${selector.replace(/`/g, '\\`')}\`)`, returnByValue: true });
        if (res.result.value) return { success: true, message: `Found element matching ${selector}` };
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`Timeout waiting for element: ${selector}`);
}

async function waitForNetworkIdle(timeoutMs) {
    const start = Date.now();
    let stableStart = null;
    while (Date.now() - start < timeoutMs) {
        // "Quiet-Wait": ignores minor telemetry pings (<= 2 active)
        if (activeNetworkRequests <= 2) {
            if (!stableStart) stableStart = Date.now();
            else if (Date.now() - stableStart > 500) return { success: true, message: "Network stabilized (Quiet-Wait)" };
        } else { stableStart = null; }
        await new Promise(r => setTimeout(r, 100));
    }
    return { success: false, message: "Network never stabilized" };
}

async function waitForLoading(tabId, timeoutMs = 30000) {
    return new Promise(async (resolve) => {
        const timeout = setTimeout(() => resolve({ success: false, message: "Timeout" }), timeoutMs);
        
        async function check() {
            try {
                const res = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "document.readyState" });
                if (res.result.value === "complete") {
                    // Page is loaded, now wait for network quiet
                    await waitForNetworkIdle(5000);
                    clearTimeout(timeout);
                    resolve({ success: true, message: "Loaded and Stable" });
                } else {
                    setTimeout(check, 500);
                }
            } catch (e) { resolve({ success: false }); }
        }
        check();
    });
}

async function performAssertion(assertionType, selector, value) {
    const tab = await getActiveTab();
    let res = false; let msg = "";
    try {
        if (assertionType === "element_exists") {
            const r = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", { expression: `!!document.querySelector(\`${(selector||"").replace(/`/g, '\\`')}\`)`, returnByValue: true });
            res = !!r.result.value; msg = res ? `Passed: Element ${selector} exists.` : `Failed: Element ${selector} not found.`;
        } 
        else if (assertionType === "element_contains_text") {
            const r = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", { expression: `(function() { const el = document.querySelector(\`${(selector||"").replace(/`/g, '\\`')}\`); return el ? (el.innerText || el.textContent) : null; })()`, returnByValue: true });
            const text = r.result.value;
            if (text === null) { res = false; msg = `Failed: Element ${selector} not found.`; }
            else { res = text.includes(value); msg = res ? `Passed: Contains "${value}".` : `Failed: Found "${text}".`; }
        }
        else if (assertionType === "url_contains") {
            res = tab.url.includes(value); msg = res ? `Passed: URL contains "${value}".` : `Failed: URL is "${tab.url}".`;
        }
    } catch (e) { res = false; msg = `Error: ${e.message}`; }
    if (!res) throw new Error(msg);
    return msg;
}

async function verifyUIState(selector, expectedText, type) {
    const tab = await getActiveTab();
    const expression = `(function() {
        const el = document.querySelector(\`${(selector||"").replace(/`/g, '\\`')}\`);
        if (!el) return { success: false, message: "Element not found" };
        if ("${type}" === "visible") {
            const style = window.getComputedStyle(el);
            const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            return { success: isVisible, message: isVisible ? "Element is visible" : "Element is hidden" };
        }
        if ("${type}" === "text_match") {
            const text = (el.innerText || el.textContent || "").trim();
            const success = text.includes("${expectedText}");
            return { success, message: success ? "Text matches" : "Expected '${expectedText}' but found '" + text + "'" };
        }
        return { success: true, message: "Element exists" };
    })()`;
    const res = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", { expression, returnByValue: true });
    return res.result.value;
}
