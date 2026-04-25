import WebSocket from "ws";
import http from "http";
import { spawn, ChildProcess } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

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
                    ]);
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
    return result.result;
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

/**
 * Click at coordinates
 */
async click(x: number, y: number, button: "left" | "middle" | "right" = "left"): Promise<void> {
        await this.sendCommand("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x,
            y,
            button,
            clickCount: 1,
        });
        await this.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x,
            y,
            button,
            clickCount: 1,
        });
    }

    /**
     * Type text using Input.insertText (more reliable than individual key events)
     */
    async typeText(text: string): Promise<void> {
        await this.sendCommand("Input.insertText", { text });
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
    async findAvailableBrowser(): Promise<{ name: 'chrome' | 'edge' | 'brave' | 'firefox'; path: string } | null> {
        const browsers = this.getBrowserPaths();
        
        for (const browser of browsers) {
            for (const p of browser.paths) {
                try {
                    await fs.access(p);
                    return { name: browser.name as 'chrome' | 'edge' | 'brave' | 'firefox', path: p };
                } catch {}
            }
        }
        return null;
    }

    /**
     * Launch browser with auto-detection
     */
    async launchAuto(options?: {
        headless?: boolean;
        userDataDir?: string;
        port?: number;
        browser?: 'chrome' | 'edge' | 'brave' | 'firefox';
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

        const userDataDir = options?.userDataDir ?? path.join(os.tmpdir(), `aether-${browserName}-profile`);
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
