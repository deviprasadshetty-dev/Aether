import WebSocket from "ws";
import http from "http";
import { spawn, ChildProcess } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

import { STEALTH_SCRIPT } from "./stealth";
import { SHARED_DOM_HELPERS } from "./element-collector";

interface CdpTarget {
    id: string;
    webSocketDebuggerUrl: string;
    url: string;
    title: string;
    type: string;
}

interface PendingRequest {
    resolve: (val: any) => void;
    reject: (err: any) => void;
    timeout: NodeJS.Timeout;
}

interface WaitForSelectorOptions {
    visible?: boolean;
    stable?: boolean;
}

type BrowserName = 'chrome' | 'edge' | 'brave' | 'firefox';

export interface BrowserProfile {
    browser: BrowserName;
    id: string;
    name: string;
    directory: string;
    userDataDir: string;
    lastActive?: number;
}

export class CdpClient {
    private ws: WebSocket | null = null;
    private messageId = 0;
    private pending = new Map<number, PendingRequest>();
    private chromeProcess: ChildProcess | null = null;
    private targets: CdpTarget[] = [];
    private activeTarget: CdpTarget | null = null;
    private eventListeners = new Map<string, ((params: any) => void)[]>();
    private connected = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private intentionalClose = false;
    private networkTraffic: any[] = [];
    private consoleLogs: any[] = [];
    private readonly MAX_TRAFFIC_LOGS = 100;
    private readonly MAX_CONSOLE_LOGS = 100;
    private mousePosition: { x: number; y: number } | null = null;
    private networkLoggingAttached = false;
    private diagnosticsLoggingAttached = false;

    constructor() {}

    /**
     * Connect to existing Chrome instance on given port
     */
    async connect(port: number = 9222): Promise<void> {
        const targets = await this.listTargets(port);
        if (targets.length === 0) {
            throw new Error(`No targets found on port ${port}. Is Chrome running with --remote-debugging-port=${port}?`);
        }

        // Prefer first page target
        const page = targets.find(t => t.type === "page") || targets[0];
        await this.attachToTarget(page);
    }

    /**
     * Launch a new Chrome instance with remote debugging
     */
    async launch(options?: {
        headless?: boolean;
        userDataDir?: string;
        profileDirectory?: string;
        port?: number;
        extraArgs?: string[];
    }): Promise<void> {
        // Delegate to launchAuto without specifying browser (will auto-detect)
        await this.launchAuto(options);
    }

    /**
     * List available CDP targets (tabs/pages)
     */
    async listTargets(port: number = 9222): Promise<CdpTarget[]> {
        return new Promise((resolve, reject) => {
            const req = http.get(`http://localhost:${port}/json`, (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    try {
                        const targets = JSON.parse(data);
                        this.targets = targets;
                        resolve(targets);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            req.on("error", reject);
            req.setTimeout(3000, () => {
                req.destroy();
                reject(new Error(`Cannot connect to Chrome on port ${port}`));
            });
        });
    }

    /**
     * Attach to a specific target/tab
     */
    async attachToTarget(target: CdpTarget): Promise<void> {
        if (this.ws) {
            this.intentionalClose = true;
            this.ws.close();
            this.ws = null;
        }

        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(target.webSocketDebuggerUrl);

            this.ws.on("open", async () => {
                this.connected = true;
                this.activeTarget = target;
                console.error(`[CDP] Connected to target: ${target.title} (${target.url})`);
                try {
                    // Enable core CDP domains
                    await Promise.all([
                        this.sendCommand("Page.enable"),
                        this.sendCommand("Network.enable"),
                        this.sendCommand("Runtime.enable"),
                        this.sendCommand("DOM.enable"),
                        this.sendCommand("Log.enable").catch(() => {}),
                        this.sendCommand("Animation.enable").catch(() => {}),
                        this.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
                            source: STEALTH_SCRIPT
                        })
                    ]);

                    // Keep animations running. Pausing them can freeze SPA loaders and leave pages looking blank.
                    this.sendCommand("Animation.setPlaybackRate", { playbackRate: 1 }).catch(() => {});

                    this.attachNetworkLogging();
                    this.attachDiagnosticsLogging();

                    console.error("[CDP] Core CDP domains enabled");
                } catch (e) {
                    console.error("[CDP] Failed to enable core domains:", e);
                }
                resolve();
            });

            this.ws.on("message", (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    if (message.id !== undefined && this.pending.has(message.id)) {
                        const { resolve, reject, timeout } = this.pending.get(message.id)!;
                        clearTimeout(timeout);
                        this.pending.delete(message.id);
                        if (message.error) {
                            reject(new Error(message.error.message || JSON.stringify(message.error)));
                        } else {
                            resolve(message.result);
                        }
                    } else if (message.method) {
                        this.emitEvent(message.method, message.params);
                    }
                } catch (e) {
                    console.error("[CDP] Parse error:", e);
                }
            });

            this.ws.on("close", () => {
                this.connected = false;
                console.error("[CDP] Connection closed");
                if (this.intentionalClose) {
                    this.intentionalClose = false;
                    return;
                }
                this.scheduleReconnect();
            });

            this.ws.on("error", (err) => {
                console.error("[CDP] Error:", err.message);
                if (!this.connected) reject(err);
            });
        });
    }

    /**
     * Send a CDP command
     */
    async sendCommand(method: string, params: any = {}): Promise<any> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("CDP not connected. Call connect() or launch() first.");
        }

        const id = ++this.messageId;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`CDP command '${method}' timed out after 30s`));
            }, 30000);

            this.pending.set(id, { resolve, reject, timeout });

            this.ws!.send(JSON.stringify({ id, method, params }));
        });
    }

    /**
     * Navigate to URL
     */
    async navigate(url: string): Promise<void> {
        await this.sendCommand("Page.navigate", { url });
    }

    async navigateAndWait(url: string, timeout: number = 10000): Promise<void> {
        const navPromise = this.waitForNavigation(Math.min(timeout, 10000)).catch(() => undefined);
        await this.navigate(url);
        const completed = await Promise.race([
            navPromise.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), Math.min(timeout, 1500))),
        ]);

        if (!completed) {
            await this.waitForNetworkIdle(300, Math.min(timeout, 2500)).catch(() => {});
        }
    }

    /**
     * Take screenshot
     */
    async screenshot(format: "jpeg" | "png" = "jpeg", quality: number = 80): Promise<string> {
        const result = await this.sendCommand("Page.captureScreenshot", {
            format,
            quality,
            captureBeyondViewport: false,
        });
        return result.data; // base64 encoded
    }

    /**
     * Get interactive elements with Set-of-Marks (SoM) overlay
     * Returns element map with IDs and injects visual markers
     */
    async getInteractiveElements(withSoM: boolean = true): Promise<{
        elements: Array<{
            id: number;
            tag: string;
            text: string;
            selector: string;
            bounds: { x: number; y: number; width: number; height: number };
            attributes: Record<string, string>;
        }>;
        somInjected: boolean;
    }> {
        const result = await this.sendCommand("Runtime.evaluate", {
            expression: `
                (function() {
                    const withSoM = ${JSON.stringify(withSoM)};
                    ${SHARED_DOM_HELPERS}

                    // Remove existing overlays
                    const oldContainer = document.getElementById('aether-som-container');
                    if (oldContainer) oldContainer.remove();
                    document.querySelectorAll('.aether-som-marker').forEach(el => el.remove());

                    let container = null;
                    if (withSoM) {
                        container = document.createElement('div');
                        container.id = 'aether-som-container';
                        container.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 2147483647; pointer-events: none;';
                        document.documentElement.appendChild(container);
                    }

                    const selectors = [
                        'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
                        '[onclick]', '[role="button"]', '[role="link"]', '[role="checkbox"]',
                        '[tabindex]:not([tabindex="-1"])', 'label', 'summary'
                    ].join(', ');
                    
                    const elements = Array.from(document.querySelectorAll(selectors));
                    const docRect = document.documentElement.getBoundingClientRect();
                    
                    let validIndex = 0;
                    const items = elements.map((el) => {
                        const r = el.getBoundingClientRect();
                        const computed = window.getComputedStyle(el);
                        if (computed.display === 'none' || computed.visibility === 'hidden' || r.width === 0 || r.height === 0) {
                            return null;
                        }
                        
                        validIndex++;
                        
                        // Get text content
                        let text = el.innerText || el.textContent || '';
                        text = text.trim().substring(0, 100);
                        
                        // Get a stable selector (shared with the locator engine)
                        const selector = aetherStableSelector(el);
                        
                        if (withSoM && container) {
                            const id = String(validIndex);
                            const w = Math.max(20, id.length * 8 + 14);
                            const marker = document.createElement('div');
                            marker.className = 'aether-som-marker';
                            marker.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="20" style="display:block">'
                                + '<rect width="' + w + '" height="20" rx="10" fill="#1e40af"/>'
                                + '<text x="' + (w / 2) + '" y="10" dominant-baseline="central" text-anchor="middle" font-family="ui-monospace,monospace" font-size="11" font-weight="700" fill="white">' + id + '</text>'
                                + '</svg>';
                            marker.style.cssText = \`
                                position: absolute;
                                left: \${r.left}px;
                                top: \${r.top}px;
                                pointer-events: none;
                                filter: drop-shadow(0 1px 4px rgba(0,0,0,0.35));
                                transform: translate(-4px, -4px);
                            \`;
                            container.appendChild(marker);
                        }

                        return {
                            id: validIndex,
                            tag: el.tagName.toLowerCase(),
                            text: text,
                            selector: selector,
                            bounds: { 
                                x: Math.max(0, r.left - docRect.left), 
                                y: Math.max(0, r.top - docRect.top), 
                                width: r.width, 
                                height: r.height 
                            },
                            attributes: {
                                type: el.getAttribute('type') || '',
                                href: el.getAttribute('href') || '',
                                role: aetherImplicitRole(el),
                                'aria-label': el.getAttribute('aria-label') || ''
                            }
                        };
                    }).filter(x => x !== null);
                    
                    return { items, somInjected: !!(withSoM && container) };
                })()
            `,
            returnByValue: true,
            awaitPromise: true,
        });

        const val = result.result?.value || { items: [], somInjected: false };
        return { elements: val.items, somInjected: val.somInjected };
    }

    /**
     * Remove Set-of-Marks overlay
     */
    async removeSoMOverlay(): Promise<void> {
        await this.sendCommand("Runtime.evaluate", {
            expression: `
                const container = document.getElementById('aether-som-container');
                if (container) container.remove();
                document.querySelectorAll('.aether-som-marker').forEach(el => el.remove());
            `,
        });
    }

    /**
     * Wait for a selector to appear in DOM
     */
    async waitForSelector(selector: string, timeout: number = 10000, options: WaitForSelectorOptions = {}): Promise<boolean> {
        const startTime = Date.now();
        let lastBox: any = null;
        let stableSince = 0;
        
        while (Date.now() - startTime < timeout) {
            const result = await this.sendCommand("Runtime.evaluate", {
                expression: `
                    (function() {
                        const el = document.querySelector(${JSON.stringify(selector)});
                        if (!el) return { found: false };
                        const rect = el.getBoundingClientRect();
                        const computed = window.getComputedStyle(el);
                        const visible = computed.display !== 'none' &&
                            computed.visibility !== 'hidden' &&
                            computed.opacity !== '0' &&
                            rect.width > 0 &&
                            rect.height > 0;
                        return {
                            found: true,
                            visible,
                            box: {
                                x: Math.round(rect.left),
                                y: Math.round(rect.top),
                                width: Math.round(rect.width),
                                height: Math.round(rect.height)
                            }
                        };
                    })()
                `,
                returnByValue: true,
            });
            
            const state = result.result?.value;
            if (state?.found && (!options.visible || state.visible)) {
                if (!options.stable) return true;

                const box = state.box;
                const sameBox = lastBox &&
                    lastBox.x === box.x &&
                    lastBox.y === box.y &&
                    lastBox.width === box.width &&
                    lastBox.height === box.height;
                if (sameBox) {
                    if (!stableSince) stableSince = Date.now();
                    if (Date.now() - stableSince >= 120) return true;
                } else {
                    stableSince = 0;
                    lastBox = box;
                }
            }
            
            await new Promise(r => setTimeout(r, 75));
        }
        
        return false;
    }

    /**
     * Wait for navigation to complete
     */
    async waitForNavigation(timeout: number = 10000): Promise<void> {
        await this.sendCommand("Page.enable", {});
        
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.removeEventListener("Page.loadEventFired", listener);
                reject(new Error("Navigation timeout"));
            }, timeout);
            
            const listener = () => {
                clearTimeout(timeoutId);
                this.removeEventListener("Page.loadEventFired", listener);
                resolve();
            };
            
            this.on("Page.loadEventFired", listener);
        });
    }

    /**
     * Wait for network idle (no requests for specified duration)
     */
    async waitForNetworkIdle(idleTimeout: number = 500, timeout: number = 10000): Promise<void> {
        await this.sendCommand("Network.enable", {});
        
        return new Promise((resolve, reject) => {
            let lastRequestTime = Date.now();
            let idleCheckInterval: NodeJS.Timeout;
            let timeoutId: NodeJS.Timeout;
            
            const resetIdle = () => {
                lastRequestTime = Date.now();
            };
            
            const checkIdle = () => {
                if (Date.now() - lastRequestTime >= idleTimeout) {
                    clearInterval(idleCheckInterval);
                    clearTimeout(timeoutId);
                    this.removeEventListener("Network.requestWillBeSent", resetIdle);
                    this.removeEventListener("Network.responseReceived", resetIdle);
                    resolve();
                }
            };
            
            timeoutId = setTimeout(() => {
                clearInterval(idleCheckInterval);
                this.removeEventListener("Network.requestWillBeSent", resetIdle);
                this.removeEventListener("Network.responseReceived", resetIdle);
                resolve(); // Resolve anyway after timeout
            }, timeout);
            
            idleCheckInterval = setInterval(checkIdle, 100);
            
            this.on("Network.requestWillBeSent", resetIdle);
            this.on("Network.responseReceived", resetIdle);
        });
    }

    private attachNetworkLogging(): void {
        if (this.networkLoggingAttached) return;
        this.networkLoggingAttached = true;

        this.on("Network.requestWillBeSent", (params) => {
            this.networkTraffic.push({
                type: "request",
                requestId: params.requestId,
                url: params.request.url,
                method: params.request.method,
                timestamp: new Date().toISOString(),
            });
            if (this.networkTraffic.length > this.MAX_TRAFFIC_LOGS) this.networkTraffic.shift();
        });

        this.on("Network.responseReceived", (params) => {
            this.networkTraffic.push({
                type: "response",
                requestId: params.requestId,
                url: params.response.url,
                status: params.response.status,
                mimeType: params.response.mimeType,
                timestamp: new Date().toISOString(),
            });
            if (this.networkTraffic.length > this.MAX_TRAFFIC_LOGS) this.networkTraffic.shift();
        });

        this.on("Network.loadingFailed", (params) => {
            this.networkTraffic.push({
                type: "error",
                requestId: params.requestId,
                errorText: params.errorText,
                timestamp: new Date().toISOString(),
            });
            if (this.networkTraffic.length > this.MAX_TRAFFIC_LOGS) this.networkTraffic.shift();
        });
    }

    private attachDiagnosticsLogging(): void {
        if (this.diagnosticsLoggingAttached) return;
        this.diagnosticsLoggingAttached = true;

        const pushLog = (entry: any) => {
            this.consoleLogs.push({ timestamp: new Date().toISOString(), ...entry });
            if (this.consoleLogs.length > this.MAX_CONSOLE_LOGS) this.consoleLogs.shift();
        };

        this.on("Runtime.consoleAPICalled", (params) => {
            pushLog({
                source: "console",
                level: params.type,
                text: (params.args || []).map((arg: any) => arg.value ?? arg.description ?? arg.type).join(" "),
                url: params.stackTrace?.callFrames?.[0]?.url,
                lineNumber: params.stackTrace?.callFrames?.[0]?.lineNumber,
            });
        });

        this.on("Runtime.exceptionThrown", (params) => {
            pushLog({
                source: "exception",
                level: "error",
                text: params.exceptionDetails?.text || params.exceptionDetails?.exception?.description || "Runtime exception",
                url: params.exceptionDetails?.url,
                lineNumber: params.exceptionDetails?.lineNumber,
            });
        });

        this.on("Log.entryAdded", (params) => {
            const entry = params.entry || {};
            pushLog({
                source: entry.source || "log",
                level: entry.level,
                text: entry.text,
                url: entry.url,
                lineNumber: entry.lineNumber,
            });
        });

        this.on("Page.javascriptDialogOpening", (params) => {
            pushLog({
                source: "dialog",
                level: "warning",
                text: `${params.type}: ${params.message}`,
                url: params.url,
            });
        });
    }

    removeEventListener(event: string, listener: (params: any) => void): void {
        const listeners = this.eventListeners.get(event) || [];
        const idx = listeners.indexOf(listener);
        if (idx !== -1) {
            listeners.splice(idx, 1);
        }
    }

    async getTabs(): Promise<CdpTarget[]> {
        return await this.listTargets();
    }

    async switchToTarget(targetId: string, port: number = 9222): Promise<void> {
        const targets = await this.listTargets(port);
        const target = targets.find(t => t.id === targetId);
        if (!target) {
            throw new Error(`Target not found: ${targetId}`);
        }
        await this.attachToTarget(target);
    }

    /**
     * Get a simplified version of the Accessibility Tree for AI agents.
     */
    async getSimplifiedAccessibilityTree(): Promise<any[]> {
        await this.sendCommand("Accessibility.enable");
        const result = await this.sendCommand("Accessibility.getFullAXTree");
        
        if (!result || !result.nodes) return [];

        const nodes = result.nodes;
        const interactiveNodes: any[] = [];
        
        // Map of node IDs for fast lookup
        const nodeMap = new Map();
        nodes.forEach((node: any) => nodeMap.set(node.nodeId, node));

        // Helper to get name from node properties
        const getNodeName = (node: any) => {
            if (node.name?.value) return node.name.value;
            const nameProp = node.properties?.find((p: any) => p.name === "name");
            return nameProp?.value?.value || "";
        };

        // Filter and simplify nodes
        nodes.forEach((node: any) => {
            const role = node.role?.value;
            const name = getNodeName(node);
            
            // Only include interactive or meaningful nodes
            const isInteractive = [
                "button", "link", "checkbox", "radio", "textbox", "searchbox", 
                "combobox", "listbox", "menuitem", "slider", "switch", "tab"
            ].includes(role);

            const hasAction = node.properties?.some((p: any) => 
                ["pressed", "expanded", "selected", "focused"].includes(p.name)
            );

            if (isInteractive || (name && name.length > 0 && role !== "generic" && role !== "none")) {
                interactiveNodes.push({
                    id: node.nodeId,
                    role: role,
                    name: name,
                    description: node.description?.value || "",
                    value: node.value?.value || "",
                    disabled: node.properties?.find((p: any) => p.name === "disabled")?.value?.value || false,
                    focused: node.properties?.find((p: any) => p.name === "focused")?.value?.value || false,
                });
            }
        });

        return interactiveNodes;
    }

    async getNetworkTraffic(): Promise<any[]> {
        return this.networkTraffic;
    }

    async getConsoleLogs(limit: number = 50): Promise<any[]> {
        return this.consoleLogs.slice(-limit);
    }

    /**
     * Get page DOM snapshot
     */
    async getDOMSnapshot(): Promise<any> {
        const result = await this.sendCommand("DOMSnapshot.captureSnapshot", {
            computedStyles: [],
        });
        return result;
    }

    /**
     * Evaluate JavaScript in page context
     */
    async evaluate(expression: string): Promise<any> {
        const result = await this.sendCommand("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
        });
        return result.result?.value !== undefined ? result.result.value : result.result;
    }

// ==================== Runtime Methods ====================
async callFunctionOn(functionDeclaration: string, objectId?: string, returnByValue: boolean = true, awaitPromise: boolean = false): Promise<any> {
    const result = await this.sendCommand("Runtime.callFunctionOn", {
        functionDeclaration, objectId, returnByValue, awaitPromise
    });
    return result.result;
}

async awaitPromise(promiseObjectId: string): Promise<any> {
    const result = await this.sendCommand("Runtime.awaitPromise", { promiseObjectId, returnByValue: true });
    return result.result;
}

async getProperties(objectId: string, ownProperties?: boolean, accessorPropertiesOnly?: boolean, generatePreview?: boolean): Promise<any> {
    return await this.sendCommand("Runtime.getProperties", { objectId, ownProperties, accessorPropertiesOnly, generatePreview });
}

async releaseObject(objectId: string): Promise<void> {
    await this.sendCommand("Runtime.releaseObject", { objectId });
}

// ==================== DOM Methods ====================
async getOuterHTML(nodeId: number): Promise<string> {
    const result = await this.sendCommand("DOM.getOuterHTML", { nodeId });
    return result.outerHTML;
}

async setOuterHTML(nodeId: number, outerHTML: string): Promise<void> {
    await this.sendCommand("DOM.setOuterHTML", { nodeId, outerHTML });
}

async performSearch(query: string, includeUserAgentShadowDOM?: boolean): Promise<{ searchId: string; resultCount: number }> {
    return await this.sendCommand("DOM.performSearch", { query, includeUserAgentShadowDOM });
}

async getSearchResults(searchId: string, fromIndex: number, toIndex: number): Promise<number[]> {
    const result = await this.sendCommand("DOM.getSearchResults", { searchId, fromIndex, toIndex });
    return result.nodeIds;
}

async setAttributeValue(nodeId: number, name: string, value: string): Promise<void> {
    await this.sendCommand("DOM.setAttributeValue", { nodeId, name, value });
}

async removeAttribute(nodeId: number, name: string): Promise<void> {
    await this.sendCommand("DOM.removeAttribute", { nodeId, name });
}

async resolveNode(nodeId: number, objectGroup?: string): Promise<any> {
    const result = await this.sendCommand("DOM.resolveNode", { nodeId, objectGroup });
    return result.object;
}

async requestChildNodes(nodeId: number, depth?: number, pierce?: boolean): Promise<void> {
    await this.sendCommand("DOM.requestChildNodes", { nodeId, depth, pierce });
}

// ==================== Network Methods ====================
async getResponseBody(requestId: string): Promise<{ body: string; base64Encoded: boolean }> {
    return await this.sendCommand("Network.getResponseBody", { requestId });
}

async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    await this.sendCommand("Network.setExtraHTTPHeaders", { headers });
}

async setUserAgentOverride(userAgent: string, acceptLanguage?: string, platform?: string, userAgentMetadata?: any): Promise<void> {
    await this.sendCommand("Network.setUserAgentOverride", { userAgent, acceptLanguage, platform, userAgentMetadata });
}

async setCacheDisabled(cacheDisabled: boolean): Promise<void> {
    await this.sendCommand("Network.setCacheDisabled", { cacheDisabled });
}

async getRequestPostData(requestId: string): Promise<{ postData: string; base64Encoded: boolean }> {
    return await this.sendCommand("Network.getRequestPostData", { requestId });
}

async searchInResponseBody(requestId: string, query: string, caseSensitive?: boolean, isRegex?: boolean): Promise<any> {
    return await this.sendCommand("Network.searchInResponseBody", { requestId, query, caseSensitive, isRegex });
}

async deleteCookies(name: string, url?: string, domain?: string, path?: string, partitionKey?: any): Promise<void> {
    await this.sendCommand("Network.deleteCookies", { name, url, domain, path, partitionKey });
}

async setCookies(cookies: Array<{
    name: string; value: string; url?: string; domain?: string; path?: string;
    secure?: boolean; httpOnly?: boolean; sameSite?: 'Strict' | 'Lax' | 'None';
    expires?: number; priority?: 'Low' | 'Medium' | 'High'; sourceScheme?: 'Unset' | 'NonSecure' | 'Secure';
    sourcePort?: number; partitionKey?: any;
}>): Promise<void> {
    await this.sendCommand("Network.setCookies", { cookies });
}

// ==================== Page Methods ====================
async getFrameTree(): Promise<any> {
    const result = await this.sendCommand("Page.getFrameTree", {});
    return result.frameTree;
}

async printToPDF(options?: any): Promise<string> {
    const result = await this.sendCommand("Page.printToPDF", options || {});
    return result.data;
}

async reload(ignoreCache?: boolean, scriptToEvaluateOnLoad?: string, loaderId?: string): Promise<void> {
    await this.sendCommand("Page.reload", { ignoreCache, scriptToEvaluateOnLoad, loaderId });
}

async bringToFront(): Promise<void> {
    await this.sendCommand("Page.bringToFront", {});
}

async closePage(): Promise<void> {
    await this.sendCommand("Page.close", {});
}

// ==================== DOMStorage Methods ====================
async enableDOMStorage(): Promise<void> {
    await this.sendCommand("DOMStorage.enable", {});
}

async getDOMStorageItems(storageId: { securityOrigin: string; isLocalStorage: boolean }): Promise<Array<[string, string]>> {
    const result = await this.sendCommand("DOMStorage.getDOMStorageItems", { storageId });
    return result.entries;
}

async setDOMStorageItem(storageId: { securityOrigin: string; isLocalStorage: boolean }, key: string, value: string): Promise<void> {
    await this.sendCommand("DOMStorage.setDOMStorageItem", { storageId, key, value });
}

async removeDOMStorageItem(storageId: { securityOrigin: string; isLocalStorage: boolean }, key: string): Promise<void> {
    await this.sendCommand("DOMStorage.removeDOMStorageItem", { storageId, key });
}

async clearDOMStorage(storageId: { securityOrigin: string; isLocalStorage: boolean }): Promise<void> {
    await this.sendCommand("DOMStorage.clear", { storageId });
}

// ==================== CacheStorage Methods ====================
async enableCacheStorage(): Promise<void> {
    await this.sendCommand("CacheStorage.enable", {});
}

async requestCacheNames(securityOrigin?: string): Promise<any> {
    return await this.sendCommand("CacheStorage.requestCacheNames", { securityOrigin });
}

async deleteCache(cacheId: string): Promise<void> {
    await this.sendCommand("CacheStorage.deleteCache", { cacheId });
}

async deleteEntry(cacheId: string, request: string, method?: string): Promise<void> {
    await this.sendCommand("CacheStorage.deleteEntry", { cacheId, request, method });
}

async requestEntries(cacheId: string, skipCount?: number, pageSize?: number): Promise<any> {
    return await this.sendCommand("CacheStorage.requestEntries", { cacheId, skipCount, pageSize });
}

// ==================== Browser Methods ====================
async getBrowserVersion(): Promise<any> {
    return await this.sendCommand("Browser.getVersion", {});
}

async setPermission(permission: string, setting: 'granted' | 'denied' | 'prompt', origin?: string): Promise<void> {
    await this.sendCommand("Browser.setPermission", { permission: { name: permission }, setting, origin });
}

async grantPermissions(permissions: string[], origin?: string): Promise<void> {
    await this.sendCommand("Browser.grantPermissions", { permissions: permissions.map(p => ({ name: p })), origin });
}

async resetPermissions(): Promise<void> {
    await this.sendCommand("Browser.resetPermissions", {});
}

async setDownloadBehavior(behavior: 'deny' | 'allow' | 'default', downloadPath?: string): Promise<void> {
    await this.sendCommand("Browser.setDownloadBehavior", { behavior, downloadPath });
}

// ==================== Emulation Methods ====================
async setDeviceMetricsOverride(options: {
    width: number; height: number; deviceScaleFactor: number; mobile: boolean;
    scale?: number; screenWidth?: number; screenHeight?: number; positionX?: number; positionY?: number;
    dontSetVisibleSize?: boolean; screenOrientation?: { type: string; angle: number };
    viewport?: { x: number; y: number; width: number; height: number; scale: number };
}): Promise<void> {
    await this.sendCommand("Emulation.setDeviceMetricsOverride", options);
}

async emulateUserAgent(userAgent: string, acceptLanguage?: string, platform?: string, userAgentMetadata?: any): Promise<void> {
    await this.sendCommand("Emulation.setUserAgentOverride", { userAgent, acceptLanguage, platform, userAgentMetadata });
}

// ==================== IO Methods ====================
async ioRead(stream: string, offset?: number, size?: number): Promise<{ data: string; base64Encoded: boolean; eof: boolean }> {
    return await this.sendCommand("IO.read", { handle: stream, offset, size });
}

async ioClose(stream: string): Promise<void> {
    await this.sendCommand("IO.close", { handle: stream });
}

// ==================== Security Methods ====================
async enableSecurity(): Promise<void> {
    await this.sendCommand("Security.enable", {});
}

async getSecurityState(): Promise<any> {
    return await this.sendCommand("Security.getSecurityState", {});
}

// ==================== SystemInfo Methods ====================
async getSystemInfo(): Promise<any> {
    return await this.sendCommand("SystemInfo.getInfo", {});
}

async getProcessInfo(): Promise<any> {
    return await this.sendCommand("SystemInfo.getProcessInfo", {});
}

// ==================== Debugger Methods ====================
async enableDebugger(): Promise<void> {
    await this.sendCommand("Debugger.enable", {});
}

async disableDebugger(): Promise<void> {
    await this.sendCommand("Debugger.disable", {});
}

async pauseDebugger(): Promise<void> {
    await this.sendCommand("Debugger.pause", {});
}

async resumeDebugger(): Promise<void> {
    await this.sendCommand("Debugger.resume", {});
}

async stepOver(): Promise<void> {
    await this.sendCommand("Debugger.stepOver", {});
}

async stepInto(): Promise<void> {
    await this.sendCommand("Debugger.stepInto", {});
}

async stepOut(): Promise<void> {
    await this.sendCommand("Debugger.stepOut", {});
}

async setBreakpointByUrl(url: string, lineNumber: number, columnNumber?: number, condition?: string): Promise<{ breakpointId: string }> {
    return await this.sendCommand("Debugger.setBreakpointByUrl", { url, lineNumber, columnNumber, condition });
}

async removeBreakpoint(breakpointId: string): Promise<void> {
    await this.sendCommand("Debugger.removeBreakpoint", { breakpointId });
}

async getScriptSource(scriptId: string): Promise<{ scriptSource: string; bytecode: string }> {
    return await this.sendCommand("Debugger.getScriptSource", { scriptId });
}

// ==================== IndexedDB Methods ====================
async enableIndexedDB(): Promise<void> {
    await this.sendCommand("IndexedDB.enable", {});
}

async disableIndexedDB(): Promise<void> {
    await this.sendCommand("IndexedDB.disable", {});
}

async requestDatabaseNames(securityOrigin: string): Promise<{ databaseNames: string[] }> {
    return await this.sendCommand("IndexedDB.requestDatabaseNames", { securityOrigin });
}

async requestDatabase(securityOrigin: string, databaseName: string): Promise<any> {
    return await this.sendCommand("IndexedDB.requestDatabase", { securityOrigin, databaseName });
}

async requestData(securityOrigin: string, databaseName: string, objectStoreName: string, indexName?: string, idbKeyRange?: any, skipCount?: number, pageSize?: number): Promise<any> {
    return await this.sendCommand("IndexedDB.requestData", {
        securityOrigin, databaseName, objectStoreName, indexName, idbKeyRange, skipCount, pageSize
    });
}

async clearObjectStore(securityOrigin: string, databaseName: string, objectStoreName: string): Promise<void> {
    await this.sendCommand("IndexedDB.clearObjectStore", { securityOrigin, databaseName, objectStoreName });
}

async deleteDatabase(securityOrigin: string, databaseName: string): Promise<void> {
    await this.sendCommand("IndexedDB.deleteDatabase", { securityOrigin, databaseName });
}

// ==================== Memory Methods ====================
async enableMemory(): Promise<void> {
    await this.sendCommand("Memory.enable", {});
}

async getDOMCounters(): Promise<any> {
    return await this.sendCommand("Memory.getDOMCounters", {});
}

async forceGarbageCollection(): Promise<void> {
    await this.sendCommand("Memory.forciblyPurgeJavaScriptMemory", {});
}

async startMemorySampling(samplingInterval?: number, suppressRandomness?: boolean): Promise<void> {
    await this.sendCommand("Memory.startSampling", { samplingInterval, suppressRandomness });
}

async stopMemorySampling(): Promise<{ profile: any }> {
    return await this.sendCommand("Memory.stopSampling", {});
}

// ==================== ServiceWorker Methods ====================
async enableServiceWorker(): Promise<void> {
    await this.sendCommand("ServiceWorker.enable", {});
}

async setForceUpdateOnPageLoad(forceUpdateOnPageLoad: boolean): Promise<void> {
    await this.sendCommand("ServiceWorker.setForceUpdateOnPageLoad", { forceUpdateOnPageLoad });
}

async skipWaiting(activationId?: string): Promise<void> {
    await this.sendCommand("ServiceWorker.skipWaiting", { activationId });
}

// ==================== WebAuthn Methods ====================
async enableWebAuthn(): Promise<void> {
    await this.sendCommand("WebAuthn.enable", {});
}

async addVirtualAuthenticator(options: {
    protocol: string; transport: string; hasResidentKey?: boolean;
    hasUserVerification?: boolean; isUserConsenting?: boolean; isUserVerified?: boolean;
}): Promise<{ authenticatorId: string }> {
    return await this.sendCommand("WebAuthn.addVirtualAuthenticator", options);
}

async removeVirtualAuthenticator(authenticatorId: string): Promise<void> {
    await this.sendCommand("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
}

// ==================== Profiler Methods ====================
async enableProfiler(): Promise<void> {
    await this.sendCommand("Profiler.enable", {});
}

async disableProfiler(): Promise<void> {
    await this.sendCommand("Profiler.disable", {});
}

async startProfiler(): Promise<void> {
    await this.sendCommand("Profiler.start", {});
}

async stopProfiler(): Promise<{ profile: any }> {
    return await this.sendCommand("Profiler.stop", {});
}

async getBestEffortCoverage(): Promise<{ result: any[] }> {
    return await this.sendCommand("Profiler.getBestEffortCoverage", {});
}

async startPreciseCoverage(callCount?: boolean, detailed?: boolean, allowFuntionLocations?: boolean): Promise<void> {
    await this.sendCommand("Profiler.startPreciseCoverage", { callCount, detailed, allowFuntionLocations });
}

async stopPreciseCoverage(): Promise<void> {
    await this.sendCommand("Profiler.stopPreciseCoverage", {});
}

async takePreciseCoverage(): Promise<{ result: any[] }> {
    return await this.sendCommand("Profiler.takePreciseCoverage", {});
}

// ==================== HeapProfiler Methods ====================
async enableHeapProfiler(): Promise<void> {
    await this.sendCommand("HeapProfiler.enable", {});
}

async disableHeapProfiler(): Promise<void> {
    await this.sendCommand("HeapProfiler.disable", {});
}

async heapProfilerCollectGarbage(): Promise<void> {
    await this.sendCommand("HeapProfiler.collectGarbage", {});
}

async getHeapObjectId(objectId: string): Promise<{ heapSnapshotObjectId: string }> {
    return await this.sendCommand("HeapProfiler.getHeapObjectId", { objectId });
}

async getObjectByHeapObjectId(heapSnapshotObjectId: string, objectGroup?: string): Promise<any> {
    return await this.sendCommand("HeapProfiler.getObjectByHeapObjectId", { heapSnapshotObjectId, objectGroup });
}

async getHeapSamplingProfile(): Promise<{ profile: any }> {
    return await this.sendCommand("HeapProfiler.getSamplingProfile", {});
}

async startHeapSampling(samplingInterval?: number, suppressRandomness?: boolean): Promise<void> {
    await this.sendCommand("HeapProfiler.startSampling", { samplingInterval, suppressRandomness });
}

async stopHeapSampling(): Promise<{ profile: any }> {
    return await this.sendCommand("HeapProfiler.stopSampling", {});
}

async takeHeapSnapshot(reportProgress?: boolean, treatGlobalObjectsAsRoots?: boolean, captureNumericValue?: boolean): Promise<void> {
    await this.sendCommand("HeapProfiler.takeHeapSnapshot", { reportProgress, treatGlobalObjectsAsRoots, captureNumericValue });
}

    // Simple multi-octave noise function (fractional Brownian motion approximation)
    private fBm(t: number, octaves: number = 3): number {
        let value = 0;
        let amplitude = 1.0;
        let frequency = 1.0;
        let maxValue = 0;
        for (let j = 0; j < octaves; j++) {
            value += Math.sin(t * frequency * Math.PI * 2 + (j * 12.34)) * amplitude;
            maxValue += amplitude;
            amplitude *= 0.5;
            frequency *= 2.0;
        }
        return value / maxValue;
    }

    /**
     * Click at coordinates with human-like timing, micro-jitter, and optional target width.
     */
    async click(x: number, y: number, button: "left" | "middle" | "right" = "left", targetWidth?: number): Promise<void> {
        const targetX = Math.round(Number(x));
        const targetY = Math.round(Number(y));
        await this.moveMouse(targetX, targetY, targetWidth);

        // Pre-click hover pause — humans don't instantly press after arriving
        await new Promise((r) => setTimeout(r, 80 + Math.random() * 140));

        // Micro-jitter at the moment of click (hand tremor)
        const cx = targetX + Math.round((Math.random() - 0.5) * 3);
        const cy = targetY + Math.round((Math.random() - 0.5) * 3);

        await this.sendCommand("Input.dispatchMouseEvent", {
            type: "mousePressed", x: cx, y: cy, button, clickCount: 1, pointerType: "mouse",
        });
        // Natural hold duration before release
        await new Promise((r) => setTimeout(r, 60 + Math.random() * 110));
        await this.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseReleased", x: cx, y: cy, button, clickCount: 1, pointerType: "mouse",
        });
    }

    /**
     * Move mouse along a cubic Bezier arc with Fitts's Law duration and fractional Brownian motion tremors.
     */
    async moveMouse(x: number, y: number, targetWidth?: number): Promise<void> {
        const targetX = Math.round(Number(x));
        const targetY = Math.round(Number(y));
        const start = this.mousePosition ?? { x: targetX, y: targetY };

        const dist = Math.hypot(targetX - start.x, targetY - start.y);
        if (dist < 2) {
            this.mousePosition = { x: targetX, y: targetY };
            return;
        }

        // Fitts's Law: MT = a + b * log2(2D / W)
        const w = targetWidth ?? 30; // default target width to 30px
        const indexDifficulty = Math.log2(Math.max(1, (2 * dist) / w));
        const movementTime = 150 + 95 * indexDifficulty; // Fitts's MT in ms

        // Human updates motor position every 10-15ms. Compute dynamic step count.
        const steps = Math.max(12, Math.min(60, Math.round(movementTime / 12)));

        // Random cubic Bezier control points — creates an organic arc
        const angle  = Math.atan2(targetY - start.y, targetX - start.x) + Math.PI / 2;
        const spread = dist * (0.25 + Math.random() * 0.35);
        const sign   = Math.random() < 0.5 ? 1 : -1;

        const cp1 = {
            x: start.x + (targetX - start.x) * (0.1 + Math.random() * 0.2) + Math.cos(angle) * spread * sign * (0.3 + Math.random() * 0.7),
            y: start.y + (targetY - start.y) * (0.1 + Math.random() * 0.2) + Math.sin(angle) * spread * sign * (0.3 + Math.random() * 0.7),
        };
        const cp2 = {
            x: start.x + (targetX - start.x) * (0.7 + Math.random() * 0.2) + Math.cos(angle) * spread * sign * (0.05 + Math.random() * 0.35),
            y: start.y + (targetY - start.y) * (0.7 + Math.random() * 0.2) + Math.sin(angle) * spread * sign * (0.05 + Math.random() * 0.35),
        };

        await this.updateMouseOverlay(start.x, start.y).catch(() => {});

        // Unique noise seed for this movement path
        const seedX = Math.random() * 100;
        const seedY = Math.random() * 100;

        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            // Ease-in-out: slow start, fast middle, slow near target
            const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
            const u = 1 - e;
            const px = u*u*u*start.x + 3*u*u*e*cp1.x + 3*u*e*e*cp2.x + e*e*e*targetX;
            const py = u*u*u*start.y + 3*u*u*e*cp1.y + 3*u*e*e*cp2.y + e*e*e*targetY;

            // fractional Brownian motion noise walk (muscle tremor)
            const tremorAmplitude = 1.2;
            const noiseX = this.fBm(t * 8 + seedX, 3) * tremorAmplitude;
            const noiseY = this.fBm(t * 8 + seedY, 3) * tremorAmplitude;

            const cx = Math.round(px + noiseX);
            const cy = Math.round(py + noiseY);

            await this.sendCommand("Input.dispatchMouseEvent", {
                type: "mouseMoved", x: cx, y: cy, button: "none", pointerType: "mouse",
            });
            await this.updateMouseOverlay(cx, cy).catch(() => {});

            // Velocity profile delay: faster in the middle, slower at start/end
            const velocityWeight = Math.sin(t * Math.PI); // bell curve 0 -> 1 -> 0
            const stepDelay = 2 + (1 - velocityWeight) * 12 + Math.random() * 4;

            await new Promise((r) => setTimeout(r, stepDelay));
        }

        this.mousePosition = { x: targetX, y: targetY };
    }

    getMousePosition(): { x: number; y: number } {
        return this.mousePosition ?? { x: 300, y: 300 };
    }

    private async updateMouseOverlay(x: number, y: number): Promise<void> {
        await this.sendCommand("Runtime.evaluate", {
            expression: `
                (function() {
                    const x = ${JSON.stringify(Math.round(x))};
                    const y = ${JSON.stringify(Math.round(y))};
                    let cursor = document.getElementById('__aether_mouse_cursor');
                    if (!cursor) {
                        cursor = document.createElement('div');
                        cursor.id = '__aether_mouse_cursor';
                        cursor.setAttribute('aria-hidden', 'true');
                        cursor.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" style="display:block"><path d="M20.5056 10.7754C21.1225 10.5355 21.431 10.4155 21.5176 10.2459C21.5926 10.099 21.5903 9.92446 21.5115 9.77954C21.4205 9.61226 21.109 9.50044 20.486 9.2768L4.59629 3.5728C4.0866 3.38983 3.83175 3.29835 3.66514 3.35605C3.52029 3.40621 3.40645 3.52004 3.35629 3.6649C3.29859 3.8315 3.39008 4.08635 3.57304 4.59605L9.277 20.4858C9.50064 21.1088 9.61246 21.4203 9.77973 21.5113C9.92465 21.5901 10.0991 21.5924 10.2461 21.5174C10.4157 21.4308 10.5356 21.1223 10.7756 20.5054L13.3724 13.8278C13.4194 13.707 13.4429 13.6466 13.4792 13.5957C13.5114 13.5506 13.5508 13.5112 13.5959 13.479C13.6468 13.4427 13.7072 13.4192 13.828 13.3722L20.5056 10.7754Z" stroke="#111111" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M20.5056 10.7754C21.1225 10.5355 21.431 10.4155 21.5176 10.2459C21.5926 10.099 21.5903 9.92446 21.5115 9.77954C21.4205 9.61226 21.109 9.50044 20.486 9.2768L4.59629 3.5728C4.0866 3.38983 3.83175 3.29835 3.66514 3.35605C3.52029 3.40621 3.40645 3.52004 3.35629 3.6649C3.29859 3.8315 3.39008 4.08635 3.57304 4.59605L9.277 20.4858C9.50064 21.1088 9.61246 21.4203 9.77973 21.5113C9.92465 21.5901 10.0991 21.5924 10.2461 21.5174C10.4157 21.4308 10.5356 21.1223 10.7756 20.5054L13.3724 13.8278C13.4194 13.707 13.4429 13.6466 13.4792 13.5957C13.5114 13.5506 13.5508 13.5112 13.5959 13.479C13.6468 13.4427 13.7072 13.4192 13.828 13.3722L20.5056 10.7754Z" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
                        cursor.style.cssText = [
                            'position: fixed',
                            'left: 0',
                            'top: 0',
                            'transform: translate(-3px, -3px)',
                            'transition: left 70ms linear, top 70ms linear, opacity 120ms ease',
                            'z-index: 2147483647',
                            'pointer-events: none',
                            'opacity: 1'
                        ].join(';');
                        document.documentElement.appendChild(cursor);
                    }
                    cursor.style.left = x + 'px';
                    cursor.style.top = y + 'px';
                    cursor.style.opacity = '1';
                    clearTimeout(window.__aetherMouseCursorTimer);
                    window.__aetherMouseCursorTimer = setTimeout(() => {
                        const current = document.getElementById('__aether_mouse_cursor');
                        if (current) current.style.opacity = '0.55';
                    }, 900);
                    return true;
                })()
            `,
            returnByValue: true,
        });
    }

    private async showScrollIndicator(x: number, y: number, deltaY: number): Promise<void> {
        const isDown = deltaY > 0;
        const chevron = (dy: number, opacity: number) => {
            const d = isDown
                ? `M10,${dy} L16,${dy + 7} L22,${dy}`
                : `M10,${dy + 7} L16,${dy} L22,${dy + 7}`;
            return `<path d="${d}" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="${opacity}"/>`;
        };
        const chevrons = isDown
            ? chevron(4, 0.3) + chevron(15, 0.65) + chevron(26, 1)
            : chevron(26, 0.3) + chevron(15, 0.65) + chevron(4, 1);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="36" style="display:block">${chevrons}</svg>`;

        await this.sendCommand("Runtime.evaluate", {
            expression: `
                (function() {
                    var ind = document.getElementById('__aether_scroll_ind');
                    if (ind) ind.remove();
                    ind = document.createElement('div');
                    ind.id = '__aether_scroll_ind';
                    ind.innerHTML = ${JSON.stringify(svg)};
                    ind.style.cssText = [
                        'position: fixed',
                        'left: ${Math.round(x)}px',
                        'top: ${Math.round(y)}px',
                        'transform: translate(-50%, -50%)',
                        'background: rgba(0,0,0,0.52)',
                        'border-radius: 20px',
                        'padding: 6px 8px',
                        'z-index: 2147483647',
                        'pointer-events: none',
                        'opacity: 1',
                        'transition: opacity 300ms ease'
                    ].join(';');
                    document.documentElement.appendChild(ind);
                    clearTimeout(window.__aetherScrollTimer);
                    window.__aetherScrollTimer = setTimeout(function() {
                        var cur = document.getElementById('__aether_scroll_ind');
                        if (cur) {
                            cur.style.opacity = '0';
                            setTimeout(function() { if (cur.parentNode) cur.parentNode.removeChild(cur); }, 320);
                        }
                    }, 500);
                    return true;
                })()
            `,
            returnByValue: true,
        }).catch(() => {});
    }

    async moveMouseToSelector(selector: string): Promise<boolean> {
        const result = await this.evaluate(`
            (function() {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return null;
                el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) return null;
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            })()
        `);
        if (!result) return false;
        await this.moveMouse(result.x, result.y);
        return true;
    }

    /**
     * Scroll from the current or supplied pointer location using wheel events.
     */
    async wheel(deltaX: number, deltaY: number, x?: number, y?: number): Promise<void> {
        const origin = {
            x: Number(x ?? this.mousePosition?.x ?? 0),
            y: Number(y ?? this.mousePosition?.y ?? 0),
        };
        await this.moveMouse(origin.x, origin.y);
        const dominant = Math.abs(Number(deltaY)) >= Math.abs(Number(deltaX)) ? Number(deltaY) : Number(deltaX);
        if (dominant !== 0) await this.showScrollIndicator(origin.x, origin.y, dominant);

        // Break scroll into irregular chunks — humans don't scroll at perfectly uniform speed
        const totalY = Number(deltaY);
        const totalX = Number(deltaX);
        const totalAbs = Math.max(Math.abs(totalX), Math.abs(totalY));
        const steps = Math.max(1, Math.ceil(totalAbs / (300 + Math.random() * 400)));

        let sentY = 0;
        let sentX = 0;
        for (let step = 0; step < steps; step++) {
            const last = step === steps - 1;
            // Random chunk size with slight ease-in (start slow, then momentum)
            const fraction = last ? 1 : (0.5 + Math.random() * 0.5) / (steps - step);
            const chunkY = last ? totalY - sentY : Math.round(totalY * fraction);
            const chunkX = last ? totalX - sentX : Math.round(totalX * fraction);
            sentY += chunkY;
            sentX += chunkX;

            await this.sendCommand("Input.dispatchMouseWheel", {
                x: origin.x, y: origin.y, deltaX: chunkX, deltaY: chunkY,
            });

            if (!last) {
                await new Promise((r) => setTimeout(r, 40 + Math.random() * 80));
            }
        }
    }

    async typeText(text: string): Promise<void> {
        const ADJACENT_KEYS: Record<string, string> = {
            'a': 'qwsz',
            'b': 'vghn',
            'c': 'xdfv',
            'd': 'ersfxc',
            'e': 'wsdr',
            'f': 'rtgvcd',
            'g': 'tyhbvf',
            'h': 'yujnbg',
            'i': 'ujko',
            'j': 'uikmnh',
            'k': 'ijlm',
            'l': 'okp',
            'm': 'njk',
            'n': 'bhjm',
            'o': 'iklp',
            'p': 'ol',
            'q': 'wa',
            'r': 'edft',
            's': 'wedxza',
            't': 'rfgy',
            'u': 'yhji',
            'v': 'cfgb',
            'w': 'qase',
            'x': 'zsdc',
            'y': 'tghu',
            'z': 'asx',
        };

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            const lowerCh = ch.toLowerCase();

            // ~1.5% chance of typo on lowercase QWERTY letters
            if (ADJACENT_KEYS[lowerCh] && Math.random() < 0.015) {
                const adjList = ADJACENT_KEYS[lowerCh];
                const typoCh = adjList[Math.floor(Math.random() * adjList.length)];
                const resolvedTypo = ch === ch.toUpperCase() ? typoCh.toUpperCase() : typoCh;

                // Type the typo first
                await this.sendCommand("Input.insertText", { text: resolvedTypo });
                // Natural pause for reaction time before correcting
                await new Promise((r) => setTimeout(r, 120 + Math.random() * 150));
                // Delete typo
                await this.pressKey("Backspace");
                // Short typing recovery pause
                await new Promise((r) => setTimeout(r, 80 + Math.random() * 100));
            }

            await this.sendCommand("Input.insertText", { text: ch });

            // Base inter-key delay (~55-90 WPM range)
            let delay = 35 + Math.random() * 75;

            // Longer pause after spaces (word boundary) and punctuation
            if (ch === " ")               delay += 15 + Math.random() * 55;
            if (/[.,!?;:\n]/.test(ch))    delay += 60 + Math.random() * 110;

            // ~3% chance of a "thinking" pause mid-sentence
            if (Math.random() < 0.03)     delay += 250 + Math.random() * 600;

            await new Promise((r) => setTimeout(r, delay));
        }
    }

    async pressKey(key: string, modifiers: string[] = []): Promise<void> {
        const modifierMask = this.modifierMask(modifiers);
        const keyDef = this.keyDefinition(key);
        await this.sendCommand("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: keyDef.key,
            code: keyDef.code,
            windowsVirtualKeyCode: keyDef.windowsVirtualKeyCode,
            nativeVirtualKeyCode: keyDef.windowsVirtualKeyCode,
            modifiers: modifierMask,
        });
        await this.sendCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: keyDef.key,
            code: keyDef.code,
            windowsVirtualKeyCode: keyDef.windowsVirtualKeyCode,
            nativeVirtualKeyCode: keyDef.windowsVirtualKeyCode,
            modifiers: modifierMask,
        });
    }

    private modifierMask(modifiers: string[]): number {
        return modifiers.reduce((mask, modifier) => {
            const key = modifier.toLowerCase();
            if (key === "alt") return mask | 1;
            if (key === "ctrl" || key === "control") return mask | 2;
            if (key === "meta" || key === "cmd" || key === "command") return mask | 4;
            if (key === "shift") return mask | 8;
            return mask;
        }, 0);
    }

    private keyDefinition(key: string): { key: string; code: string; windowsVirtualKeyCode: number } {
        const normalized = key.length === 1 ? key : key.toLowerCase();
        const special: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
            enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
            tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
            escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
            esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
            backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
            delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
            arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
            arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
            arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
            arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
            home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
            end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
            pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
            pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
        };
        if (special[normalized]) return special[normalized];
        const upper = key.toUpperCase();
        const code = /^[A-Z]$/.test(upper) ? `Key${upper}` : /^[0-9]$/.test(key) ? `Digit${key}` : key;
        return { key, code, windowsVirtualKeyCode: upper.charCodeAt(0) };
    }

    /**
     * Enable events
     */
    async enableEvents(events: string[]): Promise<void> {
        for (const event of events) {
            try {
                await this.sendCommand(event, {});
            } catch {
                // Some enable commands have different params
            }
        }
    }

    on(event: string, listener: (params: any) => void): void {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, []);
        }
        this.eventListeners.get(event)!.push(listener);
    }

    private emitEvent(method: string, params: any): void {
        const listeners = this.eventListeners.get(method) || [];
        for (const listener of listeners) {
            try {
                listener(params);
            } catch (e) {
                console.error(`[CDP] Event listener error for ${method}:`, e);
            }
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.activeTarget) {
                console.error("[CDP] Attempting to reconnect...");
                this.attachToTarget(this.activeTarget).catch(() => {});
            }
        }, 2000);
    }

    private async waitForChrome(port: number, timeoutMs: number = 10000): Promise<void> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                await this.listTargets(port);
                return;
            } catch {
                await new Promise((r) => setTimeout(r, 500));
            }
        }
        throw new Error(`Chrome did not start on port ${port} within ${timeoutMs}ms`);
    }

    private getBrowserPaths(): { name: string; paths: string[] }[] {
        const platform = os.platform();
        
        const chromePaths: string[] = [];
        const edgePaths: string[] = [];
        const bravePaths: string[] = [];
        const firefoxPaths: string[] = [];

        if (platform === "win32") {
            chromePaths.push(
                "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
            );
            edgePaths.push(
                "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
                "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
            );
            bravePaths.push(
                "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
                "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
            );
            firefoxPaths.push(
                "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
                "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe"
            );
        } else if (platform === "darwin") {
            chromePaths.push(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Chromium.app/Contents/MacOS/Chromium"
            );
            edgePaths.push(
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
            );
            bravePaths.push(
                "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
            );
            firefoxPaths.push(
                "/Applications/Firefox.app/Contents/MacOS/firefox"
            );
        } else {
            chromePaths.push(
                "/usr/bin/google-chrome",
                "/usr/bin/chromium",
                "/usr/bin/chromium-browser",
                "/snap/bin/chromium"
            );
            edgePaths.push(
                "/usr/bin/microsoft-edge",
                "/snap/bin/microsoft-edge"
            );
            bravePaths.push(
                "/usr/bin/brave-browser",
                "/snap/bin/brave"
            );
            firefoxPaths.push(
                "/usr/bin/firefox",
                "/snap/bin/firefox"
            );
        }

        return [
            { name: "chrome", paths: chromePaths },
            { name: "edge", paths: edgePaths },
            { name: "brave", paths: bravePaths },
            { name: "firefox", paths: firefoxPaths },
        ];
    }

    /**
     * Find first available browser from installed browsers
     */
    async findAvailableBrowser(): Promise<{ name: BrowserName; path: string } | null> {
        const browsers = this.getBrowserPaths();
        
        for (const browser of browsers) {
            for (const p of browser.paths) {
                try {
                    await fs.access(p);
                    return { name: browser.name as BrowserName, path: p };
                } catch {}
            }
        }
        return null;
    }

    private getDefaultUserDataDir(browser: BrowserName): string | null {
        const platform = os.platform();
        if (platform === "win32") {
            const local = process.env.LOCALAPPDATA;
            if (!local) return null;
            if (browser === "brave") return path.join(local, "BraveSoftware", "Brave-Browser", "User Data");
            if (browser === "chrome") return path.join(local, "Google", "Chrome", "User Data");
            if (browser === "edge") return path.join(local, "Microsoft", "Edge", "User Data");
            return null;
        }
        if (platform === "darwin") {
            const home = os.homedir();
            if (browser === "brave") return path.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser");
            if (browser === "chrome") return path.join(home, "Library", "Application Support", "Google", "Chrome");
            if (browser === "edge") return path.join(home, "Library", "Application Support", "Microsoft Edge");
            return null;
        }

        const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
        if (browser === "brave") return path.join(config, "BraveSoftware", "Brave-Browser");
        if (browser === "chrome") return path.join(config, "google-chrome");
        if (browser === "edge") return path.join(config, "microsoft-edge");
        return null;
    }

    async listBrowserProfiles(browser: BrowserName = "brave"): Promise<BrowserProfile[]> {
        const userDataDir = this.getDefaultUserDataDir(browser);
        if (!userDataDir) return [];

        const localStatePath = path.join(userDataDir, "Local State");
        let localState: any;
        try {
            localState = JSON.parse(await fs.readFile(localStatePath, "utf8"));
        } catch {
            return [];
        }

        const infoCache = localState?.profile?.info_cache || {};
        const ordered = localState?.profile?.profiles_order || Object.keys(infoCache);
        const profiles: BrowserProfile[] = [];

        for (const directory of ordered) {
            const cache = infoCache[directory] || {};
            const profilePath = path.join(userDataDir, directory);
            try {
                const stat = await fs.stat(profilePath);
                if (!stat.isDirectory()) continue;
            } catch {
                continue;
            }

            const name = cache.name || cache.shortcut_name || directory;
            profiles.push({
                browser,
                id: `${browser}:${directory}`,
                name,
                directory,
                userDataDir,
                lastActive: typeof cache.active_time === "number" ? cache.active_time : undefined,
            });
        }

        return profiles;
    }

    private async resolveBrowserProfile(options?: {
        browser?: BrowserName;
        profile?: string;
        profileDirectory?: string;
        userDataDir?: string;
    }): Promise<{ userDataDir?: string; profileDirectory?: string; profileName?: string }> {
        if (options?.profileDirectory) {
            return {
                userDataDir: options.userDataDir,
                profileDirectory: options.profileDirectory,
                profileName: options.profileDirectory,
            };
        }

        const profile = options?.profile?.trim();
        if (!profile) {
            return { userDataDir: options?.userDataDir };
        }

        const browser = options?.browser || "brave";
        const profiles = await this.listBrowserProfiles(browser);
        const normalized = profile.toLowerCase();
        const match = profiles.find((p) =>
            p.directory.toLowerCase() === normalized ||
            p.name.toLowerCase() === normalized ||
            p.id.toLowerCase() === `${browser}:${normalized}`
        );

        if (!match) {
            const available = profiles.map((p) => `${p.name} (${p.directory})`).join(", ") || "none found";
            throw new Error(`Profile "${profile}" not found for ${browser}. Available profiles: ${available}`);
        }

        return {
            userDataDir: options?.userDataDir || match.userDataDir,
            profileDirectory: match.directory,
            profileName: match.name,
        };
    }

    /**
     * Launch browser with auto-detection
     */
    async launchAuto(options?: {
        headless?: boolean;
        userDataDir?: string;
        profile?: string;
        profileDirectory?: string;
        port?: number;
        browser?: BrowserName;
        extraArgs?: string[];
    }): Promise<void> {
        const port = options?.port ?? 9222;
        let browserPath: string | null = null;
        let browserName = options?.browser;

        if (browserName) {
            // User specified a browser - find its path
            const browsers = this.getBrowserPaths();
            const browser = browsers.find(b => b.name === browserName);
            if (browser) {
                for (const p of browser.paths) {
                    try {
                        await fs.access(p);
                        browserPath = p;
                        break;
                    } catch {}
                }
            }
            if (!browserPath) {
                throw new Error(`${browserName} not found. Please install it or choose a different browser.`);
            }
        } else {
            // Auto-detect first available browser
            const found = await this.findAvailableBrowser();
            if (!found) {
                throw new Error(
                    "No supported browser found. Please install Chrome, Edge, Brave, or Firefox.\n" +
                    "Or specify a browser path manually."
                );
            }
            browserPath = found.path;
            browserName = found.name;
            console.error(`[CDP] Auto-detected browser: ${browserName}`);
        }

        const profile = await this.resolveBrowserProfile({
            browser: browserName,
            profile: options?.profile,
            profileDirectory: options?.profileDirectory,
            userDataDir: options?.userDataDir,
        });
        const userDataDir = profile.userDataDir ?? path.join(os.tmpdir(), `aether-${browserName}-profile`);
        const headless = options?.headless ?? false;

        const args: string[] = [];
        
        // Firefox doesn't support CDP the same way - use remote debugging
        if (browserName === "firefox") {
            args.push(
                "--remote-debugging-port", port.toString(),
                "--profile", userDataDir,
                ...(headless ? ["--headless"] : []),
                ...(options?.extraArgs || []),
                "about:blank"
            );
        } else {
            // Chromium-based browsers (Chrome, Edge, Brave)
            args.push(
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${userDataDir}`,
                ...(profile.profileDirectory ? [`--profile-directory=${profile.profileDirectory}`] : []),
                "--disable-infobars",
                ...(headless ? ["--headless", "--disable-gpu"] : []),
                ...(options?.extraArgs || []),
                "about:blank"
            );
        }

        this.chromeProcess = spawn(browserPath, args, {
            detached: false,
            stdio: "ignore",
        });

        this.chromeProcess.on("exit", () => {
            this.chromeProcess = null;
            this.connected = false;
        });

        // Wait for browser to start
        await this.waitForChrome(port);
        await this.connect(port);
    }

    /**
     * Kill the browser process
     */
    async killBrowser(): Promise<void> {
        if (this.chromeProcess) {
            console.error("[CDP] Killing browser process...");
            try {
                if (os.platform() === "win32") {
                    spawn("taskkill", ["/pid", this.chromeProcess.pid!.toString(), "/f", "/t"]);
                } else {
                    this.chromeProcess.kill("SIGKILL");
                }
            } catch (e) {
                console.error("[CDP] Error killing browser:", e);
            }
            this.chromeProcess = null;
        }
        await this.disconnect();
    }

    /**
     * List all available browsers on the system
     */
    async listAvailableBrowsers(): Promise<{ name: string; path: string }[]> {
        const browsers = this.getBrowserPaths();
        const available: { name: string; path: string }[] = [];
        
        for (const browser of browsers) {
            for (const p of browser.paths) {
                try {
                    await fs.access(p);
                    available.push({ name: browser.name, path: p });
                    break; // Found one path for this browser
                } catch {}
            }
        }
        return available;
    }

    /**
     * Disconnect and cleanup
     */
    async disconnect(): Promise<void> {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.intentionalClose = true;
            this.ws.close();
            this.ws = null;
        }
        if (this.chromeProcess) {
            this.chromeProcess.kill();
            this.chromeProcess = null;
        }
        this.connected = false;
        this.activeTarget = null;
    }

    isConnected(): boolean {
        return this.connected && this.ws?.readyState === WebSocket.OPEN;
    }

    getActiveTarget(): CdpTarget | null {
        return this.activeTarget;
    }
}

// Singleton instance
let cdpClient: CdpClient | null = null;

export function getCdpClient(): CdpClient {
    if (!cdpClient) {
        cdpClient = new CdpClient();
    }
    return cdpClient;
}

export async function ensureCdpConnected(port?: number): Promise<CdpClient> {
    const client = getCdpClient();
    if (!client.isConnected()) {
        await client.connect(port);
    }
    return client;
}
