import { getCdpClient, CdpClient } from "./cdp-client";

/**
 * Bridge layer that translates old extension-style commands to CDP commands.
 * This allows the MCP server to work without the Chrome extension.
 */
export class CdpBridge {
    private client: CdpClient;

    constructor() {
        this.client = getCdpClient();
    }

    async ensureConnected(): Promise<void> {
        if (!this.client.isConnected()) {
            // Try to connect to existing Chrome on default port
            try {
                await this.client.connect(9222);
            } catch {
                // Chrome not running, launch it
                await this.client.launch({ headless: false });
            }
        }
    }

    async sendCommand(method: string, params: any = {}): Promise<any> {
        switch (method) {
            case "connect":
                return this.connect(params);
            case "get_state":
                await this.ensureConnected();
                return this.getState(params);
            case "navigate":
                await this.ensureConnected();
                return this.navigate(params);
            case "click":
                await this.ensureConnected();
                return this.click(params);
            case "click_element":
                await this.ensureConnected();
                return this.clickElement(params);
            case "click_element_by_selector":
                await this.ensureConnected();
                return this.clickElementBySelector(params);
            case "type":
                await this.ensureConnected();
                return this.type(params);
            case "evaluate":
                await this.ensureConnected();
                return this.evaluate(params);
            case "screenshot":
            case "screenshot_region":
                await this.ensureConnected();
                return this.screenshot(params);
            case "scroll":
                await this.ensureConnected();
                return this.scroll(params);
            case "wait":
                await this.ensureConnected();
                return this.wait(params);
            case "cdp_command":
                await this.ensureConnected();
                return this.cdpCommand(params);
            case "get_dom_snapshot":
                await this.ensureConnected();
                return this.getDomSnapshot(params);
            case "get_tabs":
                await this.ensureConnected();
                return this.getTabs(params);
            case "new_tab":
                await this.ensureConnected();
                return this.newTab(params);
            case "switch_tab":
                await this.ensureConnected();
                return this.switchTab(params);
            case "close_tab":
                await this.ensureConnected();
                return this.closeTab(params);

            // ==================== AGENT-CENTRIC APIs ====================
            case "agent_action":
                await this.ensureConnected();
                return this.agentAction(params);
            case "smart_navigate":
                await this.ensureConnected();
                return this.smartNavigate(params);
            case "observe_and_act":
                await this.ensureConnected();
                return this.observeAndAct(params);
            case "agent_form_fill":
                await this.ensureConnected();
                return this.agentFormFill(params);
            case "page_snapshot":
                await this.ensureConnected();
                return this.pageSnapshot(params);
            default:
                await this.ensureConnected();
                // Try as raw CDP command
                return this.client.sendCommand(method, params);
        }
    }

    private async connect(params: any): Promise<string> {
        const port = params.port || 9222;
        await this.client.connect(port);
        return "Connected to browser";
    }

    private async getState(params: any): Promise<any> {
        const [title, url, screenshot, domSnapshot] = await Promise.all([
            this.client.evaluate("document.title").catch(() => "Unknown"),
            this.client.evaluate("window.location.href").catch(() => "Unknown"),
            this.client.screenshot(params.format, params.quality).catch(() => null),
            this.client.getDOMSnapshot().catch(() => null),
        ]);

        return {
            title,
            url,
            screenshot,
            domSnapshot,
            tabs: [], // TODO: implement tab listing via CDP
        };
    }

    private async navigate(params: any): Promise<string> {
        await this.client.navigate(params.url);
        return "Navigated";
    }

    private async click(params: any): Promise<string> {
        const x = params.x || params.coordinate?.split(',')[0] || 100;
        const y = params.y || params.coordinate?.split(',')[1] || 100;
        await this.client.click(x, y);
        return "Clicked";
    }

    private async clickElement(params: any): Promise<string> {
        // Click by element ID (from SoM) - fallback to coordinate click
        if (params.x !== undefined && params.y !== undefined) {
            await this.client.click(params.x, params.y);
            return "Clicked element";
        }
        return "Element not found";
    }

    private async clickElementBySelector(params: any): Promise<string> {
        const selector = params.selector;
        if (!selector) throw new Error("Selector required");

        // Get element bounds via CDP
        const result = await this.client.sendCommand("Runtime.evaluate", {
            expression: `
                (function() {
                    const el = document.querySelector(${JSON.stringify(selector)});
                    if (!el) return null;
                    const rect = el.getBoundingClientRect();
                    return { x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
                })()
            `,
            returnByValue: true,
        });

        if (result.result?.value) {
            const { x, y } = result.result.value;
            await this.client.click(x, y);
            return "Clicked element by selector";
        }
        throw new Error(`Element not found: ${selector}`);
    }

    private async type(params: any): Promise<string> {
        const text = params.text || params.value || "";
        await this.client.typeText(text);
        return "Typed text";
    }

    private async evaluate(params: any): Promise<any> {
        const result = await this.client.evaluate(params.script);
        return result?.value || result;
    }

    private async screenshot(params: any): Promise<string> {
        const format = params.format === "png" ? "png" : "jpeg";
        const quality = params.quality || 80;
        
        if (params.x !== undefined) {
            // Region screenshot - use CDP clipping
            const result = await this.client.sendCommand("Page.captureScreenshot", {
                format,
                quality,
                clip: {
                    x: params.x,
                    y: params.y,
                    width: params.width || 100,
                    height: params.height || 100,
                    scale: 1,
                },
            });
            return result.data;
        }

        return await this.client.screenshot(format, quality);
    }

    private async scroll(params: any): Promise<string> {
        const x = params.x || 0;
        const y = params.y || 0;
        await this.client.sendCommand("Input.dispatchMouseWheel", {
            x: 0,
            y: 0,
            deltaX: x,
            deltaY: y,
        });
        return "Scrolled";
    }

    private async wait(params: any): Promise<string> {
        const ms = params.ms || params.timeout || 1000;
        await new Promise((r) => setTimeout(r, ms));
        return "Waited";
    }

    private async cdpCommand(params: any): Promise<any> {
        return await this.client.sendCommand(params.command, params.args || {});
    }

    private async getDomSnapshot(params: any): Promise<any> {
        return await this.client.getDOMSnapshot();
    }

    // ==================== AGENT-CENTRIC APIs ====================

    private async agentAction(params: any): Promise<any> {
        const { action, target, verify, waitFor, timeout } = params;

        try {
            // Execute action
            switch (action) {
                case "click":
                    if (target.x !== undefined) {
                        await this.client.click(target.x, target.y, target.button);
                    } else if (target.selector) {
                        // Would need element resolution - use evaluate for now
                        const res = await this.client.evaluate(`
                            (function() {
                                const el = document.querySelector(${JSON.stringify(target.selector)});
                                if (el) {
                                    const rect = el.getBoundingClientRect();
                                    return { x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
                                }
                                return null;
                            })()
                        `);
                        if (res?.value) {
                            await this.client.click(res.value.x, res.value.y);
                        }
                    }
                    break;
                case "type":
                    await this.client.typeText(target.text);
                    break;
                case "scroll":
                    await this.client.sendCommand("Input.dispatchMouseWheel", {
                        x: 0, y: 0, deltaX: target.x || 0, deltaY: target.y || 0
                    });
                    break;
                case "key_press":
                    await this.client.sendCommand("Input.dispatchKeyEvent", {
                        type: "keyDown", text: target.key
                    });
                    await this.client.sendCommand("Input.dispatchKeyEvent", {
                        type: "keyUp", text: target.key
                    });
                    break;
            }

            // Wait for condition
            if (waitFor) {
                if (waitFor.type === "network_idle") {
                    // Simple wait - in production use Network events
                    await new Promise(r => setTimeout(r, waitFor.timeout || 3000));
                } else if (waitFor.type === "element") {
                    await new Promise(r => setTimeout(r, waitFor.timeout || 5000));
                }
            } else {
                await new Promise(r => setTimeout(r, 2000));
            }

            // Verify if requested
            let verification = null;
            if (verify) {
                const res = await this.client.evaluate(`
                    (function() {
                        const el = document.querySelector(${JSON.stringify(verify.selector)});
                        if (!el) return { success: false, message: "Element not found" };
                        const text = (el.innerText || el.textContent || "").trim();
                        const matches = ${JSON.stringify(verify.expectedText)} ? text.includes(${JSON.stringify(verify.expectedText)}) : true;
                        return { success: matches, text, message: matches ? "Verified" : "Text mismatch" };
                    })()
                `);
                verification = res?.value;
            }

            // Get screenshot
            const screenshot = await this.client.screenshot("jpeg", 80).catch(() => null);
            const url = await this.client.evaluate("window.location.href").catch(() => "Unknown");
            const title = await this.client.evaluate("document.title").catch(() => "Unknown");

            return {
                success: true,
                action: `${action} completed`,
                verification,
                screenshot,
                url,
                title
            };

        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    private async smartNavigate(params: any): Promise<any> {
        const { url, waitFor, dismissPopups, screenshot } = params;

        try {
            await this.client.navigate(url);

            // Wait for navigation to complete
            await new Promise(r => setTimeout(r, 3000));

            // Wait for specific condition
            if (waitFor) {
                await new Promise(r => setTimeout(r, waitFor.timeout || 5000));
            }

            const currentUrl = await this.client.evaluate("window.location.href").catch(() => url);
            const title = await this.client.evaluate("document.title").catch(() => "Unknown");
            const screenshotData = screenshot ? await this.client.screenshot("jpeg", 80).catch(() => null) : null;

            return {
                success: true,
                url: currentUrl,
                title,
                screenshot: screenshotData
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    private async observeAndAct(params: any): Promise<any> {
        const { action, observe, returnScreenshot } = params;

        try {
            // Capture before state
            const beforeSnapshot = await this.client.getDOMSnapshot().catch(() => null);
            const beforeScreenshot = returnScreenshot ? await this.client.screenshot("jpeg", 80).catch(() => null) : null;

            // Execute action
            if (action.type === "click" && action.selector) {
                const res = await this.client.evaluate(`
                    (function() {
                        const el = document.querySelector(${JSON.stringify(action.selector)});
                        if (el) {
                            const rect = el.getBoundingClientRect();
                            return { x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
                        }
                        return null;
                    })()
                `);
                if (res?.value) {
                    await this.client.click(res.value.x, res.value.y);
                }
            } else if (action.type === "type" && action.text) {
                await this.client.typeText(action.text);
            }

            // Wait for changes
            await new Promise(r => setTimeout(r, 3000));

            // Capture after state
            const afterSnapshot = await this.client.getDOMSnapshot().catch(() => null);
            const afterScreenshot = returnScreenshot ? await this.client.screenshot("jpeg", 80).catch(() => null) : null;

            return {
                success: true,
                before: { domSnapshot: beforeSnapshot, screenshot: beforeScreenshot },
                after: { domSnapshot: afterSnapshot, screenshot: afterScreenshot },
                changesDetected: beforeSnapshot !== afterSnapshot
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    private async agentFormFill(params: any): Promise<any> {
        const { fields, submitAfterFill, submitSelector } = params;
        const results = [];

        try {
            for (const field of fields) {
                if (field.type === "text" || !field.type) {
                    await this.client.typeText(field.value);
                } else if (field.type === "select") {
                    // For select, we'd need to click and select - simplified
                    await this.client.typeText(field.value);
                } else if (field.type === "checkbox") {
                    // Click checkbox
                    const res = await this.client.evaluate(`
                        (function() {
                            const el = document.querySelector(${JSON.stringify(field.selector || '#' + field.id)});
                            if (el) {
                                const rect = el.getBoundingClientRect();
                                return { x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
                            }
                            return null;
                        })()
                    `);
                    if (res?.value) {
                        await this.client.click(res.value.x, res.value.y);
                    }
                }
                results.push({ field: field.id || field.selector, success: true });
            }

            if (submitAfterFill && submitSelector) {
                const res = await this.client.evaluate(`
                    (function() {
                        const el = document.querySelector(${JSON.stringify(submitSelector)});
                        if (el) {
                            const rect = el.getBoundingClientRect();
                            return { x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
                        }
                        return null;
                    })()
                `);
                if (res?.value) {
                    await this.client.click(res.value.x, res.value.y);
                }
            }

            return { success: true, fieldsFilled: results.length, results };
        } catch (e: any) {
            return { success: false, error: e.message, results };
        }
    }

    private async pageSnapshot(params: any): Promise<any> {
        try {
            const [title, url, screenshot, domSnapshot] = await Promise.all([
                this.client.evaluate("document.title").catch(() => "Unknown"),
                this.client.evaluate("window.location.href").catch(() => "Unknown"),
                this.client.screenshot("jpeg", 80).catch(() => null),
                this.client.getDOMSnapshot().catch(() => null),
            ]);

            return {
                title,
                url,
                screenshot,
                domSnapshot: params.includeDOMSnapshot ? domSnapshot : undefined,
                metadata: {
                    timestamp: Date.now(),
                }
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    private async getTabs(params: any): Promise<any> {
        // Get targets via HTTP endpoint
        const client = getCdpClient();
        const targets = await this.getTargetsViaHttp();
        return targets;
    }

    private async newTab(params: any): Promise<string> {
        const result = await this.client.sendCommand("Target.createTarget", {
            url: params.url || "about:blank",
        });
        return "Created new tab";
    }

    private async switchTab(params: any): Promise<string> {
        // This would need to switch the active CDP connection to another tab
        // For now, just return a message
        return "Tab switching not yet implemented for direct CDP mode";
    }

    private async closeTab(params: any): Promise<string> {
        await this.client.sendCommand("Target.closeTarget", {
            targetId: params.targetId,
        });
        return "Closed tab";
    }

    async launchBrowser(options?: {
        browser?: 'chrome' | 'edge' | 'brave' | 'firefox';
        headless?: boolean;
        port?: number;
    }): Promise<string> {
        const client = getCdpClient();
        await client.launchAuto({
            browser: options?.browser,
            headless: options?.headless,
            port: options?.port,
        });
        return "Browser launched successfully";
    }

    async killBrowser(): Promise<string> {
        const client = getCdpClient();
        await client.killBrowser();
        return "Browser killed";
    }

    async listBrowsers(): Promise<any> {
        const client = getCdpClient();
        return await client.listAvailableBrowsers();
    }

    private async getTargetsViaHttp(): Promise<any[]> {
        // This is a simplified version - in reality we'd need to know the port
        return [];
    }
}

let bridgeInstance: CdpBridge | null = null;

export function getCdpBridge(): CdpBridge {
    if (!bridgeInstance) {
        bridgeInstance = new CdpBridge();
    }
    return bridgeInstance;
}
