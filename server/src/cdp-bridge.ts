import { getCdpClient, CdpClient } from "./cdp-client";
import { detectAndSolve, SolverOptions } from "./captcha-solver";

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
            case "browser_status":
                return this.browserStatus(params);
            case "snapshot_compact":
                await this.ensureConnected();
                return this.snapshotCompact(params);
            case "list_interactive_elements":
                await this.ensureConnected();
                return this.listInteractiveElements(params);
            case "click_by_ref":
                await this.ensureConnected();
                return this.clickByRef(params);
            case "click_by_selector":
                await this.ensureConnected();
                return this.clickBySelector(params);
            case "fill_by_selector":
                await this.ensureConnected();
                return this.fillBySelector(params);
            case "wait_for_selector":
                await this.ensureConnected();
                return this.waitForSelectorCompact(params);
            case "wait_for_text":
                await this.ensureConnected();
                return this.waitForText(params);
            case "get_network_errors":
                await this.ensureConnected();
                return this.getNetworkErrors(params);
            case "detect_captcha":
                await this.ensureConnected();
                return this.detectCaptcha();
            case "solve_captcha":
                await this.ensureConnected();
                return this.solveCaptchaAction(params);
            case "browser_intent":
                await this.ensureConnected();
                await this.ensureNoCaptcha("browser_intent");
                return this.browserIntent(params);
            case "get_logs":
                await this.ensureConnected();
                return this.getLogs(params);
            case "press_key":
            case "key_combo":
                await this.ensureConnected();
                await this.ensureNoCaptcha("press_key");
                return this.pressKey(params);
            case "click_text":
                await this.ensureConnected();
                await this.ensureNoCaptcha("click_text");
                return this.clickText(params);
            case "click_role":
                await this.ensureConnected();
                await this.ensureNoCaptcha("click_role");
                return this.clickRole(params);
            case "fill_label":
                await this.ensureConnected();
                await this.ensureNoCaptcha("fill_label");
                return this.fillLabel(params);
            case "element_at_point":
                await this.ensureConnected();
                return this.elementAtPoint(params);
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
                await this.ensureNoCaptcha("click");
                return this.click(params);
            case "click_element":
                await this.ensureConnected();
                await this.ensureNoCaptcha("click_element");
                return this.clickElement(params);
            case "click_element_by_selector":
                await this.ensureConnected();
                await this.ensureNoCaptcha("click_element_by_selector");
                return this.clickElementBySelector(params);
            case "type":
                await this.ensureConnected();
                await this.ensureNoCaptcha("type");
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
            case "start_screencast":
                await this.ensureConnected();
                return this.startScreencast(params);
            case "stop_screencast":
                await this.ensureConnected();
                return this.stopScreencast(params);
            case "record_session":
                await this.ensureConnected();
                return this.recordSession(params);
            case "sample_visual_frames":
                await this.ensureConnected();
                return this.sampleVisualFrames(params);
            case "start_tracing":
                await this.ensureConnected();
                return this.startTracing(params);
            case "stop_tracing":
                await this.ensureConnected();
                return this.stopTracing(params);
            case "get_performance_metrics":
                await this.ensureConnected();
                return this.getPerformanceMetrics(params);
            case "hover":
                await this.ensureConnected();
                await this.ensureNoCaptcha("hover");
                return this.hover(params);
            case "drag_and_drop":
                await this.ensureConnected();
                await this.ensureNoCaptcha("drag_and_drop");
                return this.dragAndDrop(params);

            // ==================== MISSING ACT TOOL ACTIONS ====================
            case "fill":
                await this.ensureConnected();
                await this.ensureNoCaptcha("fill");
                return this.fillInput(params);
            case "select":
                await this.ensureConnected();
                await this.ensureNoCaptcha("select");
                return this.selectOption(params);
            case "check":
                await this.ensureConnected();
                await this.ensureNoCaptcha("check");
                return this.checkElement(params);
            case "get_tree":
                await this.ensureConnected();
                return this.getAccessibilityTree(params);
            case "get_dom_tree":
                await this.ensureConnected();
                return this.getDOMTree(params);
            case "assert":
                await this.ensureConnected();
                return this.assertCondition(params);
            case "get_cookies":
                await this.ensureConnected();
                return this.getCookies(params);
            case "set_cookie":
                await this.ensureConnected();
                return this.setCookie(params);
            case "clear_cache":
                await this.ensureConnected();
                return this.clearCache(params);
            case "set_geolocation":
                await this.ensureConnected();
                return this.setGeolocation(params);
            case "set_timezone":
                await this.ensureConnected();
                return this.setTimezone(params);
            case "emulate_network":
                await this.ensureConnected();
                return this.emulateNetworkConditions(params);
            case "print_pdf":
                await this.ensureConnected();
                return this.printPDF(params);
            case "highlight_elements":
                await this.ensureConnected();
                return this.highlightElements(params);
            case "verify_ui_state":
                await this.ensureConnected();
                return this.verifyUIState(params);
            case "get_dom_storage":
                await this.ensureConnected();
                return this.getDOMStorage(params);
            case "get_network_traffic":
                await this.ensureConnected();
                return this.getNetworkTraffic(params);
            case "get_network_response":
                await this.ensureConnected();
                return this.getNetworkResponse(params);
            case "mock_network_request":
                await this.ensureConnected();
                return this.mockNetworkRequest(params);
            case "get_computed_style":
                await this.ensureConnected();
                return this.getComputedStyle(params);
            case "get_event_listeners":
                await this.ensureConnected();
                return this.getEventListeners(params);
            case "get_screencast_frames":
                await this.ensureConnected();
                return this.getScreencastFrames(params);
            case "upload_file":
                await this.ensureConnected();
                await this.ensureNoCaptcha("upload_file");
                return this.uploadFile(params);
            case "configure":
                await this.ensureConnected();
                return this.configureBrowser(params);

            // ==================== AGENT-CENTRIC APIs ====================
            case "agent_action":
                await this.ensureConnected();
                await this.ensureNoCaptcha("agent_action");
                return this.agentAction(params);
            case "smart_navigate":
                await this.ensureConnected();
                return this.smartNavigate(params);
            case "observe_and_act":
                await this.ensureConnected();
                await this.ensureNoCaptcha("observe_and_act");
                return this.observeAndAct(params);
            case "agent_form_fill":
                await this.ensureConnected();
                await this.ensureNoCaptcha("agent_form_fill");
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

    private async browserStatus(params: any): Promise<any> {
        const connected = this.client.isConnected();
        const activeTarget = this.client.getActiveTarget();
        let targets: any[] | undefined;

        if (connected && params.includeTargets) {
            targets = await this.client.getTabs().catch(() => []);
        }

        return {
            connected,
            activeTarget: activeTarget ? {
                id: activeTarget.id,
                type: activeTarget.type,
                title: activeTarget.title,
                url: activeTarget.url
            } : null,
            targets
        };
    }

    private async snapshotCompact(params: any): Promise<any> {
        const maxElements = Math.max(0, Math.min(Number(params.maxElements ?? 30), 100));
        const includeText = params.includeText !== false;
        const [title, url, readyState, elements] = await Promise.all([
            this.client.evaluate("document.title").catch(() => "Unknown"),
            this.client.evaluate("window.location.href").catch(() => "Unknown"),
            this.client.evaluate("document.readyState").catch(() => "unknown"),
            this.getCompactElements(maxElements, includeText, false).catch(() => [])
        ]);

        return {
            title,
            url,
            readyState,
            elementCount: elements.length,
            elements
        };
    }

    private async listInteractiveElements(params: any): Promise<any> {
        const maxElements = Math.max(0, Math.min(Number(params.maxElements ?? 50), 200));
        const elements = await this.getCompactElements(maxElements, true, !!params.withOverlay);
        return {
            count: elements.length,
            elements
        };
    }

    private async getCompactElements(maxElements: number, includeText: boolean, withOverlay: boolean): Promise<any[]> {
        const result = await this.client.sendCommand("Runtime.evaluate", {
            expression: `
                (function() {
                    const max = ${JSON.stringify(maxElements)};
                    const includeText = ${JSON.stringify(includeText)};
                    const selectors = [
                        'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
                        '[onclick]', '[role="button"]', '[role="link"]', '[role="checkbox"]',
                        '[tabindex]:not([tabindex="-1"])', 'label', 'summary'
                    ].join(', ');

                    function cssPath(el) {
                        if (el.id) return '#' + CSS.escape(el.id);
                        const path = [];
                        while (el && el.nodeType === Node.ELEMENT_NODE && el !== document.body) {
                            let selector = el.nodeName.toLowerCase();
                            if (el.classList && el.classList.length) {
                                selector += '.' + Array.from(el.classList).slice(0, 2).map(c => CSS.escape(c)).join('.');
                            }
                            const parent = el.parentElement;
                            if (parent) {
                                const siblings = Array.from(parent.children).filter(child => child.nodeName === el.nodeName);
                                if (siblings.length > 1) selector += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
                            }
                            path.unshift(selector);
                            el = parent;
                        }
                        return path.length ? path.join(' > ') : '';
                    }

                    return Array.from(document.querySelectorAll(selectors)).map((el, index) => {
                        const rect = el.getBoundingClientRect();
                        const computed = window.getComputedStyle(el);
                        const visible = computed.display !== 'none' && computed.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
                        if (!visible) return null;
                        const selector = cssPath(el);
                        if (!selector) return null;
                        const text = ((el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '') + '').trim().replace(/\\s+/g, ' ').substring(0, 120);
                        return {
                            ref: 'css:' + selector,
                            index: index + 1,
                            tag: el.tagName.toLowerCase(),
                            role: el.getAttribute('role') || '',
                            type: el.getAttribute('type') || '',
                            name: el.getAttribute('name') || '',
                            text: includeText ? text : undefined,
                            bounds: {
                                x: Math.round(rect.left),
                                y: Math.round(rect.top),
                                width: Math.round(rect.width),
                                height: Math.round(rect.height)
                            }
                        };
                    }).filter(Boolean).slice(0, max);
                })()
            `,
            returnByValue: true,
            awaitPromise: true
        });

        const elements = result.result?.value || [];

        if (withOverlay && elements.length > 0) {
            await this.client.getInteractiveElements(true).catch(() => ({ elements: [], somInjected: false }));
        }

        return elements;
    }

    private async clickByRef(params: any): Promise<any> {
        const ref = String(params.ref || "");
        if (!ref) throw new Error("ref required");

        if (ref.startsWith("css:")) {
            return this.clickBySelector({ selector: ref.slice(4), timeout: params.timeout });
        }

        if (ref.startsWith("@") || ref.startsWith("som:")) {
            const id = ref.replace(/^som:/, "").replace(/^@/, "");
            await this.clickElement({ id });
            return { success: true, ref };
        }

        throw new Error(`Unsupported element ref: ${ref}`);
    }

    private async clickBySelector(params: any): Promise<any> {
        const selector = params.selector;
        if (!selector) throw new Error("selector required");
        const found = await this.client.waitForSelector(selector, params.timeout || 5000, { visible: params.visible !== false, stable: params.stable === true });
        if (!found) return { success: false, selector, message: "Selector not found before timeout" };

        const before = await this.captureActionFacts();
        await this.clickElementBySelector({ selector });
        const after = await this.captureActionFacts(selector);
        return { success: true, selector, facts: this.diffActionFacts(before, after) };
    }

    private async fillBySelector(params: any): Promise<any> {
        const selector = params.selector;
        const value = params.value ?? "";
        if (!selector) throw new Error("selector required");
        const found = await this.client.waitForSelector(selector, params.timeout || 5000, { visible: params.visible !== false, stable: params.stable === true });
        if (!found) return { success: false, selector, message: "Selector not found before timeout" };

        await this.client.moveMouseToSelector(selector).catch(() => {});

        const focused = await this.client.evaluate(`
            (function() {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return false;
                el.focus();
                if ('value' in el) {
                    el.value = '';
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }
                return true;
            })()
        `);

        if (!focused) return { success: false, selector, message: "Selector could not be focused" };
        const before = await this.captureActionFacts(selector);
        await this.client.typeText(String(value));
        const after = await this.captureActionFacts(selector);
        return { success: true, selector, length: String(value).length, facts: this.diffActionFacts(before, after) };
    }

    private async waitForSelectorCompact(params: any): Promise<any> {
        const selector = params.selector;
        if (!selector) throw new Error("selector required");
        const found = await this.client.waitForSelector(selector, params.timeout || 5000, { visible: params.visible === true, stable: params.stable === true });
        return { success: found, selector };
    }

    private async getLogs(params: any): Promise<any> {
        const limit = Math.max(1, Math.min(Number(params.limit ?? 50), 100));
        const logs = await this.client.getConsoleLogs(limit);
        return { count: logs.length, logs };
    }

    private async pressKey(params: any): Promise<any> {
        const key = String(params.key || params.value || "");
        if (!key) throw new Error("key required");
        const modifiers = Array.isArray(params.modifiers) ? params.modifiers.map(String) : [];
        const before = await this.captureActionFacts();
        await this.client.pressKey(key, modifiers);
        const after = await this.captureActionFacts();
        return { success: true, key, modifiers, facts: this.diffActionFacts(before, after) };
    }

    private async clickText(params: any): Promise<any> {
        const resolved = await this.resolveNaturalTarget({
            target: params.text || params.value || params.target,
            role: params.role,
            timeout: params.timeout || 5000,
            includeCandidates: params.includeCandidates
        });
        if (!resolved.success) return resolved;
        const before = await this.captureActionFacts();
        await this.clickElementBySelector({ selector: resolved.selector });
        const after = await this.captureActionFacts(resolved.selector);
        return { success: true, selector: resolved.selector, matchedBy: resolved.matchedBy, facts: this.diffActionFacts(before, after) };
    }

    private async clickRole(params: any): Promise<any> {
        const resolved = await this.resolveNaturalTarget({
            target: params.name || params.text || params.target || "",
            role: params.role,
            timeout: params.timeout || 5000,
            includeCandidates: params.includeCandidates
        });
        if (!resolved.success) return resolved;
        const before = await this.captureActionFacts();
        await this.clickElementBySelector({ selector: resolved.selector });
        const after = await this.captureActionFacts(resolved.selector);
        return { success: true, selector: resolved.selector, matchedBy: resolved.matchedBy, facts: this.diffActionFacts(before, after) };
    }

    private async fillLabel(params: any): Promise<any> {
        const resolved = await this.resolveNaturalTarget({
            target: params.label || params.target,
            role: params.role || "textbox",
            timeout: params.timeout || 5000,
            includeCandidates: params.includeCandidates
        });
        if (!resolved.success) return resolved;
        return this.fillBySelector({ selector: resolved.selector, value: params.value ?? "", timeout: params.timeout || 5000 });
    }

    private async elementAtPoint(params: any): Promise<any> {
        const x = Number(params.x ?? String(params.coordinate || "").split(",")[0]);
        const y = Number(params.y ?? String(params.coordinate || "").split(",")[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x/y or coordinate required");
        return await this.client.evaluate(`
            (function() {
                const el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
                if (!el) return { found: false };
                const rect = el.getBoundingClientRect();
                function cssPath(node) {
                    if (node.id) return '#' + CSS.escape(node.id);
                    const path = [];
                    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
                        let selector = node.nodeName.toLowerCase();
                        if (node.classList && node.classList.length) {
                            selector += '.' + Array.from(node.classList).slice(0, 2).map(c => CSS.escape(c)).join('.');
                        }
                        const parent = node.parentElement;
                        if (parent) {
                            const siblings = Array.from(parent.children).filter(child => child.nodeName === node.nodeName);
                            if (siblings.length > 1) selector += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
                        }
                        path.unshift(selector);
                        node = parent;
                    }
                    return path.join(' > ');
                }
                return {
                    found: true,
                    selector: cssPath(el),
                    tag: el.tagName.toLowerCase(),
                    text: String(el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').substring(0, 160),
                    role: el.getAttribute('role') || '',
                    bounds: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
                };
            })()
        `);
    }

    private async waitForText(params: any): Promise<any> {
        const text = String(params.text || "");
        if (!text) throw new Error("text required");
        const timeout = params.timeout || 5000;
        const start = Date.now();

        while (Date.now() - start < timeout) {
            const found = await this.client.evaluate(`
                (document.body && document.body.innerText || '').includes(${JSON.stringify(text)})
            `).catch(() => false);
            if (found) return { success: true, text };
            await new Promise(r => setTimeout(r, 200));
        }

        return { success: false, text, message: "Text not found before timeout" };
    }

    private async getNetworkErrors(params: any): Promise<any> {
        const limit = Math.max(1, Math.min(Number(params.limit ?? 20), 100));
        const errors = (await this.client.getNetworkTraffic())
            .filter((entry: any) => entry.type === "error" || entry.status >= 400)
            .slice(-limit);

        return {
            count: errors.length,
            errors
        };
    }

    private async detectCaptcha(): Promise<any> {
        return await this.client.evaluate(`
            (function() {
                const selectors = [
                    'iframe[src*="recaptcha"]',
                    'iframe[src*="hcaptcha"]',
                    'iframe[src*="challenges.cloudflare.com"]',
                    'iframe[src*="arkoselabs"]',
                    'iframe[src*="funcaptcha"]',
                    '[class*="g-recaptcha"]',
                    '[class*="h-captcha"]',
                    '[data-sitekey]',
                    '[id*="captcha" i]',
                    '[class*="captcha" i]',
                    '[aria-label*="captcha" i]'
                ];
                const textPatterns = [
                    /captcha/i,
                    /i am not a robot/i,
                    /verify you are human/i,
                    /verify that you are human/i,
                    /security check/i,
                    /human verification/i,
                    /cloudflare.*verify/i
                ];

                function visible(el) {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return style.display !== 'none' &&
                        style.visibility !== 'hidden' &&
                        rect.width > 0 &&
                        rect.height > 0;
                }

                const selectorMatches = selectors.flatMap((selector) =>
                    Array.from(document.querySelectorAll(selector))
                        .filter(visible)
                        .slice(0, 5)
                        .map((el) => {
                            const rect = el.getBoundingClientRect();
                            return {
                                selector,
                                tag: el.tagName.toLowerCase(),
                                text: String(el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').substring(0, 160),
                                src: el.getAttribute('src') || '',
                                bounds: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
                            };
                        })
                );

                const bodyText = String(document.body?.innerText || '').replace(/\\s+/g, ' ').substring(0, 5000);
                const textMatches = textPatterns
                    .filter((pattern) => pattern.test(bodyText))
                    .map((pattern) => pattern.toString());

                const detected = selectorMatches.length > 0 || textMatches.length > 0;
                return {
                    detected,
                    captchaRequired: detected,
                    message: detected ? 'CAPTCHA detected. Manual solve required before continuing.' : 'No CAPTCHA detected.',
                    matches: selectorMatches,
                    textMatches,
                    url: window.location.href,
                    title: document.title
                };
            })()
        `).catch((error: any) => ({
            detected: false,
            captchaRequired: false,
            message: `CAPTCHA detection failed: ${error.message}`
        }));
    }

    private async ensureNoCaptcha(action: string): Promise<void> {
        const result = await this.detectCaptcha();
        if (result.detected) {
            const error: any = new Error("CAPTCHA detected. Manual solve required before continuing.");
            error.captcha = {
                ...result,
                blockedAction: action
            };
            throw error;
        }
    }

    private async solveCaptchaAction(params: any): Promise<any> {
        const pageUrl: string = params.pageUrl || await this.client.evaluate("window.location.href").catch(() => "");
        const opts: SolverOptions = {
            useService:   params.useService,
            service:      params.service,
            apiKey:       params.apiKey,
            timeout:      params.timeout,
            pollInterval: params.pollInterval,
            waitAfterClick: params.waitAfterClick,
        };
        const evaluate   = (script: string) => this.client.evaluate(script);
        const sendCommand = (method: string, p: any) => this.client.sendCommand(method, p);
        const mouse      = this.client.getMousePosition();
        return await detectAndSolve(evaluate, sendCommand, pageUrl, mouse, opts);
    }

    private async browserIntent(params: any): Promise<any> {
        const intent = String(params.intent || "").toLowerCase();
        const timeout = params.timeout || 7000;

        if (intent === "navigate") {
            const url = params.value || params.target;
            if (!url) throw new Error("value or target required for navigate intent");
            await this.navigate({ url: String(url), timeout });
            return this.intentResult(true, intent, undefined, { url });
        }

        if (intent === "inspect") {
            const snapshot = await this.snapshotCompact({ maxElements: params.maxElements ?? 30, includeText: true });
            return this.intentResult(true, intent, undefined, snapshot);
        }

        if (intent === "wait_for") {
            const expected = params.value || params.target;
            if (!expected) throw new Error("value or target required for wait_for intent");
            const result = await this.waitForText({ text: expected, timeout });
            return this.intentResult(result.success, intent, undefined, result);
        }

        const resolved = await this.resolveNaturalTarget({
            target: params.target,
            role: params.role,
            timeout,
            includeCandidates: params.includeCandidates
        });

        if (!resolved.success) {
            return this.intentResult(false, intent, undefined, {
                message: resolved.message,
                candidates: params.includeCandidates ? resolved.candidates : undefined
            });
        }

        const selector = resolved.selector;

        if (intent === "click") {
            await this.clickElementBySelector({ selector });
        } else if (intent === "fill") {
            await this.fillBySelector({ selector, value: params.value ?? "", timeout });
        } else if (intent === "select") {
            await this.selectOption({ selector, value: params.value ?? "" });
        } else if (intent === "check") {
            await this.checkElement({ selector });
        } else {
            throw new Error(`Unsupported browser intent: ${intent}`);
        }

        let verification: any = undefined;
        if (params.verify) {
            verification = await this.waitForText({ text: params.verify, timeout }).catch((error: any) => ({
                success: false,
                error: error.message
            }));
        }

        return this.intentResult(true, intent, resolved, {
            selector,
            ref: `css:${selector}`,
            verification,
            candidates: params.includeCandidates ? resolved.candidates : undefined
        });
    }

    private intentResult(success: boolean, intent: string, resolved?: any, extra: any = {}): any {
        return {
            success,
            intent,
            target: resolved?.target,
            matchedBy: resolved?.matchedBy,
            confidence: resolved?.confidence,
            ...extra
        };
    }

    private async captureActionFacts(selector?: string): Promise<any> {
        return await this.client.evaluate(`
            (function() {
                const selector = ${JSON.stringify(selector || "")};
                const active = document.activeElement;
                const target = selector ? document.querySelector(selector) : active;
                const visibleErrors = Array.from(document.querySelectorAll('[role="alert"], .error, .errors, [aria-invalid="true"]'))
                    .filter((el) => {
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
                    })
                    .map((el) => String(el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' '))
                    .filter(Boolean)
                    .slice(0, 5);

                function describe(el) {
                    if (!el) return null;
                    return {
                        tag: el.tagName.toLowerCase(),
                        id: el.id || '',
                        name: el.getAttribute('name') || '',
                        role: el.getAttribute('role') || '',
                        type: el.getAttribute('type') || '',
                        value: 'value' in el ? String(el.value || '') : '',
                        checked: 'checked' in el ? !!el.checked : undefined,
                        selectedIndex: 'selectedIndex' in el ? el.selectedIndex : undefined,
                        text: String(el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').substring(0, 160)
                    };
                }

                return {
                    url: window.location.href,
                    title: document.title,
                    readyState: document.readyState,
                    focused: describe(active),
                    target: describe(target),
                    visibleErrors
                };
            })()
        `).catch(() => ({}));
    }

    private diffActionFacts(before: any, after: any): any {
        return {
            urlChanged: before?.url !== after?.url,
            titleChanged: before?.title !== after?.title,
            focused: after?.focused,
            target: after?.target,
            valueChanged: before?.target?.value !== after?.target?.value,
            checkedChanged: before?.target?.checked !== after?.target?.checked,
            selectedIndexChanged: before?.target?.selectedIndex !== after?.target?.selectedIndex,
            visibleErrors: after?.visibleErrors || []
        };
    }

    private async resolveNaturalTarget(params: any): Promise<any> {
        const target = String(params.target || "").trim();
        const role = params.role ? String(params.role).toLowerCase() : "";
        const timeout = params.timeout || 7000;
        const start = Date.now();

        if (!target && !role) {
            return { success: false, message: "target or role required" };
        }

        while (Date.now() - start < timeout) {
            const result = await this.client.sendCommand("Runtime.evaluate", {
                expression: `
                    (function() {
                        const target = ${JSON.stringify(target)};
                        const targetLower = target.toLowerCase();
                        const roleHint = ${JSON.stringify(role)};
                        const selectors = [
                            'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
                            '[onclick]', '[role]', '[tabindex]:not([tabindex="-1"])', 'label', 'summary'
                        ].join(', ');

                        function cssPath(el) {
                            if (el.id) return '#' + CSS.escape(el.id);
                            const path = [];
                            while (el && el.nodeType === Node.ELEMENT_NODE && el !== document.body) {
                                let selector = el.nodeName.toLowerCase();
                                if (el.classList && el.classList.length) {
                                    selector += '.' + Array.from(el.classList).slice(0, 2).map(c => CSS.escape(c)).join('.');
                                }
                                const parent = el.parentElement;
                                if (parent) {
                                    const siblings = Array.from(parent.children).filter(child => child.nodeName === el.nodeName);
                                    if (siblings.length > 1) selector += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
                                }
                                path.unshift(selector);
                                el = parent;
                            }
                            return path.length ? path.join(' > ') : '';
                        }

                        function visible(el) {
                            const rect = el.getBoundingClientRect();
                            const computed = window.getComputedStyle(el);
                            return computed.display !== 'none' &&
                                computed.visibility !== 'hidden' &&
                                computed.opacity !== '0' &&
                                rect.width > 0 &&
                                rect.height > 0;
                        }

                        function inferRole(el) {
                            const explicit = (el.getAttribute('role') || '').toLowerCase();
                            if (explicit) return explicit;
                            const tag = el.tagName.toLowerCase();
                            const type = (el.getAttribute('type') || '').toLowerCase();
                            if (tag === 'button' || type === 'button' || type === 'submit') return 'button';
                            if (tag === 'a') return 'link';
                            if (tag === 'textarea') return 'textbox';
                            if (tag === 'select') return 'combobox';
                            if (tag === 'input' && ['checkbox', 'radio'].includes(type)) return type;
                            if (tag === 'input') return 'textbox';
                            return tag;
                        }

                        function labelFor(el) {
                            if (el.id) {
                                const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
                                if (label) return label.innerText || label.textContent || '';
                            }
                            const wrappingLabel = el.closest('label');
                            return wrappingLabel ? (wrappingLabel.innerText || wrappingLabel.textContent || '') : '';
                        }

                        function norm(value) {
                            return String(value || '').trim().replace(/\\s+/g, ' ');
                        }

                        function scoreField(value, weightExact, weightIncludes) {
                            const text = norm(value);
                            const lower = text.toLowerCase();
                            if (!targetLower) return { score: 0, by: '' };
                            if (lower === targetLower) return { score: weightExact, by: 'exact' };
                            if (lower.includes(targetLower)) return { score: weightIncludes, by: 'contains' };
                            if (targetLower.includes(lower) && lower.length >= 3) return { score: Math.max(1, weightIncludes - 1), by: 'contained_by_target' };
                            return { score: 0, by: '' };
                        }

                        const candidates = Array.from(document.querySelectorAll(selectors)).map((el) => {
                            if (!visible(el)) return null;
                            const selector = cssPath(el);
                            if (!selector) return null;

                            const inferredRole = inferRole(el);
                            const fields = [
                                ['selector', selector, 12, 10],
                                ['aria-label', el.getAttribute('aria-label'), 11, 9],
                                ['label', labelFor(el), 11, 9],
                                ['placeholder', el.getAttribute('placeholder'), 10, 8],
                                ['name', el.getAttribute('name'), 9, 7],
                                ['text', el.innerText || el.textContent, 8, 6],
                                ['value', el.getAttribute('value'), 7, 5],
                                ['title', el.getAttribute('title'), 6, 4]
                            ];

                            let score = 0;
                            let matchedBy = '';
                            for (const [field, value, exact, includes] of fields) {
                                const match = scoreField(value, exact, includes);
                                if (match.score > score) {
                                    score = match.score;
                                    matchedBy = field + ':' + match.by;
                                }
                            }

                            if (roleHint) {
                                if (inferredRole === roleHint) score += 4;
                                else if (roleHint === 'textbox' && ['input', 'textarea'].includes(el.tagName.toLowerCase())) score += 3;
                                else score -= 2;
                            }

                            const rect = el.getBoundingClientRect();
                            return {
                                selector,
                                role: inferredRole,
                                tag: el.tagName.toLowerCase(),
                                type: el.getAttribute('type') || '',
                                text: norm(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder')).substring(0, 120),
                                matchedBy,
                                score,
                                bounds: {
                                    x: Math.round(rect.left),
                                    y: Math.round(rect.top),
                                    width: Math.round(rect.width),
                                    height: Math.round(rect.height)
                                }
                            };
                        }).filter(Boolean).sort((a, b) => b.score - a.score);

                        return candidates;
                    })()
                `,
                returnByValue: true,
                awaitPromise: true
            });

            const candidates = result.result?.value || [];
            const best = candidates[0];

            if (best && best.score > 0) {
                return {
                    success: true,
                    target,
                    selector: best.selector,
                    matchedBy: best.matchedBy,
                    confidence: Math.min(1, best.score / 16),
                    candidates: params.includeCandidates ? candidates.slice(0, 10) : undefined
                };
            }

            await new Promise(r => setTimeout(r, 200));
        }

        return { success: false, target, message: "No matching visible element found" };
    }

    private async getState(params: any): Promise<any> {
        const includeScreenshot = params.screenshot === true;
        const includeDomSnapshot = params.domSnapshot === true || params.includeDOMSnapshot === true;
        const includeElements = params.elements !== false;
        const includeSoM = params.som === true || params.withOverlay === true;
        const includeTabs = params.tabs === true;

        const [title, url, screenshot, domSnapshot, elements, tabs] = await Promise.all([
            this.client.evaluate("document.title").catch(() => "Unknown"),
            this.client.evaluate("window.location.href").catch(() => "Unknown"),
            includeScreenshot ? this.client.screenshot(params.format, params.quality).catch(() => null) : Promise.resolve(null),
            includeDomSnapshot ? this.client.getDOMSnapshot().catch(() => null) : Promise.resolve(null),
            includeElements ? this.client.getInteractiveElements(includeSoM).catch(() => ({ elements: [], somInjected: false })) : Promise.resolve({ elements: [], somInjected: false }),
            includeTabs ? this.client.getTabs().catch(() => []) : Promise.resolve([]),
        ]);

        return {
            title,
            url,
            screenshot,
            domSnapshot,
            elements: elements.elements,
            somInjected: elements.somInjected,
            tabs,
        };
    }

    private async navigate(params: any): Promise<string> {
        await this.client.navigateAndWait(params.url, params.timeout || 10000);
        return "Navigated";
    }

    private async waitForPageSettled(timeout: number = 10000): Promise<void> {
        try {
            await this.client.waitForNavigation(Math.min(timeout, 10000));
        } catch {
            await this.client.waitForNetworkIdle(300, Math.min(timeout, 2500)).catch(() => {});
        }
    }

    private async click(params: any): Promise<string> {
        const x = params.x || params.coordinate?.split(',')[0] || 100;
        const y = params.y || params.coordinate?.split(',')[1] || 100;
        await this.client.click(x, y);
        return "Clicked";
    }

    private async clickElement(params: any): Promise<string> {
        // Click by element ID (from SoM) - resolves ID to coordinates
        if (params.id !== undefined) {
            const result = await this.client.evaluate(`
                (function() {
                    const targetId = Number(${JSON.stringify(String(params.id).replace(/@/g, ''))});
                    const selectors = [
                        'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
                        '[onclick]', '[role="button"]', '[role="link"]', '[role="checkbox"]',
                        '[tabindex]:not([tabindex="-1"])', 'label', 'summary'
                    ].join(', ');
                    const elements = Array.from(document.querySelectorAll(selectors)).filter((el) => {
                        const rect = el.getBoundingClientRect();
                        const computed = window.getComputedStyle(el);
                        return computed.display !== 'none' &&
                            computed.visibility !== 'hidden' &&
                            rect.width > 0 &&
                            rect.height > 0;
                    });
                    const el = elements[targetId - 1];
                    if (el) {
                        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                        const rect = el.getBoundingClientRect();
                        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                    }
                    return null;
                })()
            `);
            
            if (result) {
                await this.client.click(result.x, result.y, params.button);
                return `Clicked element @${params.id}`;
            }
            
            // Fallback: try to find element by selector or text
            if (params.selector) {
                return this.clickElementBySelector({ selector: params.selector });
            }
            if (params.text) {
                return this.clickElementByText({ text: params.text });
            }
        }
        
        // Fallback to coordinate click
        if (params.x !== undefined && params.y !== undefined) {
            await this.client.click(params.x, params.y);
            return "Clicked at coordinates";
        }
        
        throw new Error("Element not found: no valid id, selector, text, or coordinates provided");
    }

    private async clickElementByText(params: any): Promise<string> {
        const result = await this.client.evaluate(`
            (function() {
                const text = ${JSON.stringify(params.text)};
                const elements = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick]'));
                const el = elements.find(e => (e.innerText || e.textContent || '').includes(text));
                if (el) {
                    const rect = el.getBoundingClientRect();
                    return { x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
                }
                return null;
            })()
        `);
        
        if (result) {
            await this.client.click(result.x, result.y);
            return `Clicked element with text: ${params.text}`;
        }
        throw new Error(`Element with text not found: ${params.text}`);
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
                    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                    const rect = el.getBoundingClientRect();
                    const computed = window.getComputedStyle(el);
                    if (computed.display === 'none' || computed.visibility === 'hidden' || rect.width === 0 || rect.height === 0) return null;
                    return { x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
                })()
            `,
            returnByValue: true,
        });

        if (result.result?.value) {
            const { x, y } = result.result.value;
            await this.client.click(x, y, params.button);
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
        return await this.client.evaluate(params.script);
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
        const originX = params.originX ?? params.mouseX ?? params.options?.originX;
        const originY = params.originY ?? params.mouseY ?? params.options?.originY;
        await this.client.wheel(x, y, originX, originY);
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
        const timeoutMs = timeout || 10000;

        try {
            // Execute action with proper element resolution
            switch (action) {
                case "click":
                    if (target.id) {
                        await this.clickElement({ id: target.id, button: target.button });
                    } else if (target.selector) {
                        // Wait for selector if needed
                        await this.client.waitForSelector(target.selector, 5000);
                        await this.clickElementBySelector({ selector: target.selector, button: target.button });
                    } else if (target.x !== undefined) {
                        await this.client.click(target.x, target.y, target.button);
                    }
                    break;

                case "type":
                    if (target.selector) {
                        await this.client.waitForSelector(target.selector, 5000);
                        await this.client.moveMouseToSelector(target.selector).catch(() => {});
                        await this.client.evaluate(`
                            (function() {
                                const el = document.querySelector(${JSON.stringify(target.selector)});
                                if (el) { el.value = ''; el.focus(); }
                            })()
                        `);
                    }
                    await this.client.typeText(target.text || target.value || "");
                    break;

                case "scroll":
                    await this.client.sendCommand("Input.dispatchMouseWheel", {
                        x: target.x || 0, y: target.y || 0, 
                        deltaX: target.deltaX || 0, deltaY: target.deltaY || target.y || 0
                    });
                    break;

                case "key_press":
                    await this.client.sendCommand("Input.dispatchKeyEvent", {
                        type: "keyDown", text: target.key, key: target.key
                    });
                    await this.client.sendCommand("Input.dispatchKeyEvent", {
                        type: "keyUp", text: target.key, key: target.key
                    });
                    break;

                case "hover":
                    await this.client.moveMouse(target.x || 0, target.y || 0);
                    break;

                case "drag":
                    const sx = target.startX || target.x || 0;
                    const sy = target.startY || target.y || 0;
                    const ex = target.endX || sx + 100;
                    const ey = target.endY || sy + 100;
                    
                    await this.client.moveMouse(sx, sy);
                    await this.client.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: sx, y: sy, button: "left", clickCount: 1 });
                    await this.client.moveMouse(ex, ey);
                    await this.client.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: ex, y: ey, button: "left", clickCount: 1 });
                    break;
            }

            // Wait for condition with proper waiting mechanisms
            if (waitFor) {
                if (waitFor.type === "network_idle") {
                    await this.client.waitForNetworkIdle(500, waitFor.timeout || 3000);
                } else if (waitFor.type === "element") {
                    if (waitFor.selector) {
                        await this.client.waitForSelector(waitFor.selector, waitFor.timeout || 5000);
                    } else {
                        await new Promise(r => setTimeout(r, waitFor.timeout || 3000));
                    }
                } else if (waitFor.type === "navigation") {
                    try {
                        await this.client.waitForNavigation(waitFor.timeout || 10000);
                    } catch {
                        // Navigation might have already completed
                    }
                }
            } else {
                // Default wait for stability
                await new Promise(r => setTimeout(r, 500));
            }

            // Verify if requested
            let verification = null;
            if (verify) {
                if (verify.type === "element_exists") {
                    const res = await this.client.evaluate(`
                        (function() {
                            const el = document.querySelector(${JSON.stringify(verify.selector)});
                            return { success: !!el, exists: !!el, message: el ? "Element exists" : "Element not found" };
                        })()
                    `);
                    verification = res;
                } else if (verify.type === "element_contains_text") {
                    const res = await this.client.evaluate(`
                        (function() {
                            const el = document.querySelector(${JSON.stringify(verify.selector)});
                            if (!el) return { success: false, message: "Element not found" };
                            const text = (el.innerText || el.textContent || "").trim();
                            const matches = text.includes(${JSON.stringify(verify.expectedText || verify.text || "")});
                            return { success: matches, text, message: matches ? "Verified" : "Text mismatch" };
                        })()
                    `);
                    verification = res;
                } else if (verify.selector) {
                    // Simple existence check
                    const res = await this.client.evaluate(`
                        (function() {
                            return !!document.querySelector(${JSON.stringify(verify.selector)});
                        })()
                    `);
                    verification = { success: !!res, selector: verify.selector };
                }
            }

            // Get screenshot
            const screenshot = params.screenshot === true ? await this.client.screenshot("jpeg", 70).catch(() => null) : null;
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
        const { url, waitFor, dismissPopups, screenshot, timeout } = params;
        const timeoutMs = timeout || 30000;

        try {
            await this.client.navigateAndWait(url, timeoutMs);

            // Dismiss popups if requested
            if (dismissPopups !== false) {
                await this.client.evaluate(`
                    (function() {
                        // Try to find and click common close buttons
                        const selectors = [
                            '[aria-label*="close" i]', '[aria-label*="dismiss" i]',
                            '.close', '.dismiss', '.modal-close',
                            'button[class*="close"]', '[data-dismiss="modal"]'
                        ];
                        for (const sel of selectors) {
                            const el = document.querySelector(sel);
                            if (el && el.offsetParent !== null) {
                                el.click();
                                return true;
                            }
                        }
                        return false;
                    })()
                `).catch(() => {});
            }

            // Wait for specific condition
            if (waitFor) {
                if (waitFor.type === "network_idle") {
                    await this.client.waitForNetworkIdle(500, waitFor.timeout || 3000);
                } else if (waitFor.type === "element" && waitFor.selector) {
                    await this.client.waitForSelector(waitFor.selector, waitFor.timeout || 5000);
                }
            }

            const currentUrl = await this.client.evaluate("window.location.href").catch(() => url);
            const title = await this.client.evaluate("document.title").catch(() => "Unknown");
            const screenshotData = screenshot === true ? await this.client.screenshot("jpeg", 70).catch(() => null) : null;

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
            const [beforeFacts, beforeScreenshot] = await Promise.all([
                this.captureActionFacts(action.selector),
                returnScreenshot === true ? this.client.screenshot("jpeg", 70).catch(() => null) : Promise.resolve(null),
            ]);

            if (action.type === "click" && action.selector) {
                await this.client.waitForSelector(action.selector, 5000, { visible: true, stable: true });
                await this.clickElementBySelector({ selector: action.selector });
            } else if (action.type === "type" && action.text) {
                if (action.selector) {
                    await this.fillBySelector({ selector: action.selector, value: action.text, timeout: 5000 });
                } else {
                    await this.client.typeText(action.text);
                }
            }

            if (observe?.type === "dom_change") {
                await this.client.waitForNetworkIdle(300, 3000).catch(() => {});
            } else if (observe?.type === "network_response") {
                await this.client.waitForNetworkIdle(500, 5000).catch(() => {});
            } else {
                await new Promise(r => setTimeout(r, 300));
            }

            const [afterFacts, afterScreenshot] = await Promise.all([
                this.captureActionFacts(action.selector),
                returnScreenshot === true ? this.client.screenshot("jpeg", 70).catch(() => null) : Promise.resolve(null),
            ]);

            const facts = this.diffActionFacts(beforeFacts, afterFacts);
            const changesDetected = facts.urlChanged || facts.titleChanged || facts.valueChanged || facts.checkedChanged || facts.selectedIndexChanged;

            return {
                success: true,
                before: { facts: beforeFacts, screenshot: beforeScreenshot },
                after: { facts: afterFacts, screenshot: afterScreenshot },
                changesDetected,
                facts,
                navigationOccurred: facts.urlChanged,
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    private simpleDiff(before: string, after: string): number {
        // Simple Levenshtein distance for change detection
        if (before === after) return 0;
        const len = Math.max(before.length, after.length);
        let diff = 0;
        for (let i = 0; i < len; i++) {
            if (before[i] !== after[i]) diff++;
        }
        return diff;
    }

    private async agentFormFill(params: any): Promise<any> {
        const { fields, submitAfterFill, submitSelector } = params;
        const results = [];

        try {
            for (const field of fields) {
                const selector = field.selector || (field.id ? `#${field.id}` : undefined);
                if (!selector && field.type !== "file") {
                    results.push({ field: field.id || field.selector, success: false, error: "Missing selector or id" });
                    continue;
                }

                if (["text", "email", "password", "textarea"].includes(field.type) || !field.type) {
                    await this.fillBySelector({ selector, value: field.value ?? "", timeout: field.timeout || 5000 });
                } else if (field.type === "select") {
                    await this.selectOption({ selector, value: field.value ?? "" });
                } else if (field.type === "checkbox" || field.type === "radio") {
                    if (field.checked === false) {
                        await this.setChecked({ selector, checked: false });
                    } else {
                        await this.checkElement({ selector });
                    }
                } else if (field.type === "file") {
                    await this.uploadFile({ selector, files: field.files || [] });
                } else {
                    await this.fillBySelector({ selector, value: field.value ?? "", timeout: field.timeout || 5000 });
                }
                results.push({ field: field.id || field.selector, selector, success: true });
            }

            if (submitAfterFill && submitSelector) {
                await this.clickElementBySelector({ selector: submitSelector });
            }

            return { success: true, fieldsFilled: results.length, results };
        } catch (e: any) {
            return { success: false, error: e.message, results };
        }
    }

    private async pageSnapshot(params: any): Promise<any> {
        try {
            const includeScreenshot = params.screenshot === true;
            const includeCookies = params.cookies === true;
            const includeAccessibilityTree = params.accessibilityTree === true;
            const [title, url, screenshot, domSnapshot, elements, forms, cookies, axTree] = await Promise.all([
                this.client.evaluate("document.title").catch(() => "Unknown"),
                this.client.evaluate("window.location.href").catch(() => "Unknown"),
                includeScreenshot ? this.client.screenshot(params.fullPage ? "jpeg" : "jpeg", 70).catch(() => null) : Promise.resolve(null),
                params.includeDOMSnapshot ? this.client.getDOMSnapshot().catch(() => null) : Promise.resolve(undefined),
                this.client.getInteractiveElements(false).catch(() => ({ elements: [] })),
                this.client.evaluate(`
                    (function() {
                        const forms = Array.from(document.querySelectorAll('form'));
                        return forms.map((form, idx) => {
                            const inputs = Array.from(form.querySelectorAll('input, select, textarea'));
                            return {
                                id: 'form-' + idx,
                                action: form.action,
                                method: form.method,
                                inputs: inputs.map(input => ({
                                    type: input.type || 'text',
                                    name: input.name || '',
                                    id: input.id || '',
                                    required: input.required,
                                    placeholder: input.placeholder || ''
                                }))
                            };
                        });
                    })()
                `).catch(() => ({ value: [] })),
                includeCookies ? this.client.sendCommand("Network.getCookies", {}).catch(() => ({ cookies: [] })) : Promise.resolve({ cookies: [] }),
                includeAccessibilityTree ? this.client.getSimplifiedAccessibilityTree().catch(() => []) : Promise.resolve([]),
            ]);

            return {
                title,
                url,
                screenshot,
                elements: elements.elements,
                accessibilityTree: axTree,
                forms: forms || [],
                cookies: cookies.cookies || [],
                domSnapshot: params.includeDOMSnapshot ? domSnapshot : undefined,
                metadata: {
                    timestamp: Date.now(),
                    elementCount: elements.elements.length,
                }
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    // ==================== SELF-HEALING SELECTOR RESOLUTION ====================
    
    async resolveSelector(params: any): Promise<{ selector: string; method: string; confidence: number }> {
        const { originalSelector, text, fuzzyMatch } = params;
        
        // Try original selector first
        if (originalSelector) {
            const exists = await this.client.evaluate(`
                !!document.querySelector(${JSON.stringify(originalSelector)})
            `);
            if (exists) {
                return { selector: originalSelector, method: "exact", confidence: 1.0 };
            }
        }
        
        // Try fuzzy text matching if enabled
        if (fuzzyMatch !== false && text) {
            const result = await this.client.evaluate(`
                (function() {
                    const searchText = ${JSON.stringify(text)};
                    const searchLower = String(searchText || '').trim().toLowerCase();
                    const elements = Array.from(document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [onclick]')).filter((el) => {
                        const rect = el.getBoundingClientRect();
                        const computed = window.getComputedStyle(el);
                        return computed.display !== 'none' && computed.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
                    });

                    function cssPath(el) {
                        if (el.id) return '#' + CSS.escape(el.id);
                        const path = [];
                        while (el && el.nodeType === Node.ELEMENT_NODE && el !== document.body) {
                            let selector = el.nodeName.toLowerCase();
                            if (el.classList && el.classList.length) {
                                selector += '.' + Array.from(el.classList).slice(0, 2).map(c => CSS.escape(c)).join('.');
                            }
                            const parent = el.parentElement;
                            if (parent) {
                                const siblings = Array.from(parent.children).filter(child => child.nodeName === el.nodeName);
                                if (siblings.length > 1) selector += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
                            }
                            path.unshift(selector);
                            el = parent;
                        }
                        return path.length ? path.join(' > ') : '';
                    }

                    function textFor(el) {
                        return String(
                            el.innerText ||
                            el.textContent ||
                            el.getAttribute('aria-label') ||
                            el.getAttribute('placeholder') ||
                            el.getAttribute('name') ||
                            ''
                        ).trim();
                    }
                    
                    // Exact match first
                    let best = elements.find(el => textFor(el).toLowerCase() === searchLower);
                    if (best) return { selector: cssPath(best), confidence: 1.0 };
                    
                    // Partial match
                    best = elements.find(el => {
                        const value = textFor(el).toLowerCase();
                        return searchLower.length >= 3 && value.includes(searchLower);
                    });
                    if (best) return { selector: cssPath(best), confidence: 0.8 };
                    
                    // Fuzzy match (Levenshtein distance)
                    let minDist = Infinity;
                    let bestEl = null;
                    elements.forEach(el => {
                        const elText = textFor(el);
                        if (!elText || Math.abs(elText.length - searchText.length) > 8) return;
                        const dist = levenshteinDistance(searchText, elText);
                        if (dist < minDist && dist <= 3) {
                            minDist = dist;
                            bestEl = el;
                        }
                    });
                    
                    if (bestEl) return { selector: cssPath(bestEl), confidence: 0.6 };
                    
                    return null;
                    
                    function levenshteinDistance(a, b) {
                        if (a.length === 0) return b.length;
                        if (b.length === 0) return a.length;
                        const matrix = [];
                        for (let i = 0; i <= b.length; i++) matrix[i] = [i];
                        for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
                        for (let i = 1; i <= b.length; i++) {
                            for (let j = 1; j <= a.length; j++) {
                                matrix[i][j] = b.charAt(i-1) === a.charAt(j-1) ? matrix[i-1][j-1] : 
                                    Math.min(matrix[i-1][j-1] + 1, matrix[i][j-1] + 1, matrix[i-1][j] + 1);
                            }
                        }
                        return matrix[b.length][a.length];
                    }
                })()
            `);
            
            if (result) {
                return { selector: result.selector, method: "fuzzy", confidence: result.confidence };
            }
        }
        
        throw new Error(`Could not resolve selector. Original: ${originalSelector}, Text: ${text}`);
    }

    private async getTabs(params: any): Promise<any> {
        const result = await this.client.sendCommand("Target.getTargets", {});
        return result.targetInfos || [];
    }

    private async newTab(params: any): Promise<string> {
        const result = await this.client.sendCommand("Target.createTarget", {
            url: params.url || "about:blank",
        });
        return result.targetId ? `Created new tab: ${result.targetId}` : "Created new tab";
    }

    private async switchTab(params: any): Promise<string> {
        if (!params.targetId) throw new Error("targetId required to switch tabs");
        await this.client.sendCommand("Target.activateTarget", { targetId: params.targetId });
        await this.client.switchToTarget(params.targetId, params.port || 9222);
        return `Switched to tab ${params.targetId}`;
    }

    private async closeTab(params: any): Promise<string> {
        await this.client.sendCommand("Target.closeTarget", {
            targetId: params.targetId,
        });
        return "Closed tab";
    }

    private async startScreencast(params: any): Promise<string> {
        this.screencastFrames = [];
        if (!this.screencastFrameListener) {
            this.screencastFrameListener = async (event: any) => {
                this.screencastFrames.push(event.data);
                const maxFrames = params.maxFrames || 100;
                if (this.screencastFrames.length > maxFrames) {
                    this.screencastFrames.splice(0, this.screencastFrames.length - maxFrames);
                }
                try {
                    await this.client.sendCommand("Page.screencastFrameAck", { sessionId: event.sessionId });
                } catch {}
            };
            this.client.on("Page.screencastFrame", this.screencastFrameListener);
        }
        await this.client.sendCommand("Page.startScreencast", {
            format: params.format || "jpeg",
            quality: params.quality || 80,
            everyNthFrame: params.everyNthFrame || 1
        });
        return "Started screencast";
    }

    private async stopScreencast(params: any): Promise<string> {
        await this.client.sendCommand("Page.stopScreencast", {});
        if (this.screencastFrameListener) {
            this.client.removeEventListener("Page.screencastFrame", this.screencastFrameListener);
            this.screencastFrameListener = null;
        }
        return "Stopped screencast";
    }

    private async recordSession(params: any): Promise<any> {
        const duration = params.duration || 5000;
        const frames: string[] = [];
        
        const onFrame = async (event: any) => {
            frames.push(event.data);
            try {
                await this.client.sendCommand("Page.screencastFrameAck", { sessionId: event.sessionId });
            } catch {}
        };
        
        this.client.on("Page.screencastFrame", onFrame);
        
        await this.startScreencast(params);
        await new Promise(r => setTimeout(r, duration));
        await this.stopScreencast(params);
        this.client.removeEventListener("Page.screencastFrame", onFrame);
        
        return {
            frames,
            frameCount: frames.length,
            duration
        };
    }

    private async sampleVisualFrames(params: any): Promise<any> {
        const duration = Math.max(250, Math.min(Number(params.duration ?? 1500), 10000));
        const maxFrames = Math.max(1, Math.min(Number(params.maxFrames ?? 4), 12));
        const frames: string[] = [];
        const timestamps: string[] = [];

        const onFrame = async (event: any) => {
            if (frames.length < maxFrames) {
                frames.push(event.data);
                timestamps.push(new Date().toISOString());
            }
            await this.client.sendCommand("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
        };

        this.client.on("Page.screencastFrame", onFrame);
        await this.client.sendCommand("Page.startScreencast", {
            format: params.format || "jpeg",
            quality: Math.max(20, Math.min(Number(params.quality ?? 45), 80)),
            maxWidth: Math.max(320, Math.min(Number(params.maxWidth ?? 800), 1280)),
            maxHeight: Math.max(240, Math.min(Number(params.maxHeight ?? 600), 900)),
            everyNthFrame: Math.max(1, Math.min(Number(params.everyNthFrame ?? 3), 10))
        });

        try {
            await new Promise(r => setTimeout(r, duration));
        } finally {
            await this.client.sendCommand("Page.stopScreencast", {}).catch(() => {});
            this.client.removeEventListener("Page.screencastFrame", onFrame);
        }

        return {
            success: true,
            frameCount: frames.length,
            duration,
            format: params.format || "jpeg",
            timestamps,
            frames
        };
    }

    private async startTracing(params: any): Promise<string> {
        await this.client.sendCommand("Tracing.start", { categories: params.categories || "devtools.timeline" });
        return "Started tracing";
    }

    private async stopTracing(params: any): Promise<any> {
        await this.client.sendCommand("Tracing.end", {});
        return "Stopped tracing";
    }

    private async getPerformanceMetrics(params: any): Promise<any> {
        await this.client.sendCommand("Performance.enable", {});
        const result = await this.client.sendCommand("Performance.getMetrics", {});
        return result.metrics;
    }

    private async hover(params: any): Promise<string> {
        const x = params.x || (params.coordinate ? Number(params.coordinate.split(',')[0]) : 100);
        const y = params.y || (params.coordinate ? Number(params.coordinate.split(',')[1]) : 100);
        await this.client.moveMouse(x, y);
        return "Hovered";
    }

    private async dragAndDrop(params: any): Promise<string> {
        const startX = params.startX || 0;
        const startY = params.startY || 0;
        const endX = params.endX || 0;
        const endY = params.endY || 0;
        
        await this.client.moveMouse(startX, startY);
        await this.client.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: startX, y: startY, button: "left", clickCount: 1 });
        await this.client.moveMouse(endX, endY);
        await this.client.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: endX, y: endY, button: "left", clickCount: 1 });
        return "Dragged and dropped";
    }

    // ==================== MISSING ACT TOOL ACTION IMPLEMENTATIONS ====================

    private async fillInput(params: any): Promise<string> {
        const selector = params.selector;
        const text = params.value || params.text || "";
        
        if (selector) {
            // Wait for element and clear it first
            await this.client.waitForSelector(selector);
            await this.client.moveMouseToSelector(selector).catch(() => {});
            await this.client.evaluate(`
                (function() {
                    const el = document.querySelector(${JSON.stringify(selector)});
                    if (el) {
                        el.value = '';
                        el.focus();
                        return true;
                    }
                    return false;
                })()
            `);
        }
        
        await this.client.typeText(text);
        return `Filled with: ${text}`;
    }

    private async selectOption(params: any): Promise<string> {
        const selector = params.selector;
        const value = params.value || "";
        
        if (!selector) throw new Error("Selector required for select action");
        
        await this.client.waitForSelector(selector);
        const selectInfo = await this.client.evaluate(`
            (function() {
                const select = document.querySelector(${JSON.stringify(selector)});
                if (!select) return { success: false, error: "Element not found" };
                if (select.tagName.toLowerCase() !== 'select') return { success: false, error: "Element is not a select" };
                if (select.disabled) return { success: false, error: "Element is disabled" };
                const wanted = ${JSON.stringify(value)};
                const options = Array.from(select.options || []);
                const index = options.findIndex((option) =>
                    option.value === wanted ||
                    option.text === wanted ||
                    option.label === wanted
                );
                return {
                    success: true,
                    selectedValue: select.value,
                    index,
                    optionCount: options.length,
                    wantedValue: index >= 0 ? options[index].value : wanted,
                };
            })()
        `);

        if (!selectInfo?.success) throw new Error(selectInfo?.error || "Failed to inspect select");
        if (selectInfo.selectedValue === selectInfo.wantedValue) {
            return `Selected option: ${value}`;
        }

        if (selectInfo.index >= 0 && selectInfo.index <= 40) {
            try {
                await this.clickElementBySelector({ selector });
                await this.client.pressKey("Home");
                for (let i = 0; i < selectInfo.index; i++) {
                    await this.client.pressKey("ArrowDown");
                }
                await this.client.pressKey("Enter");

                const verified = await this.client.evaluate(`
                    (function() {
                        const select = document.querySelector(${JSON.stringify(selector)});
                        return select ? select.value : null;
                    })()
                `);
                if (verified === selectInfo.wantedValue) {
                    return `Selected option: ${value}`;
                }
            } catch {
                // Fall back to direct value setting below for reliability.
            }
        }

        const result = await this.client.evaluate(`
            (function() {
                const select = document.querySelector(${JSON.stringify(selector)});
                if (!select) return { success: false, error: "Element not found" };
                select.value = ${JSON.stringify(selectInfo.wantedValue)};
                select.dispatchEvent(new Event('input', { bubbles: true }));
                select.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true, selectedValue: select.value };
            })()
        `);

        if (result?.success) return `Selected option: ${value}`;
        throw new Error(result?.error || "Failed to select option");
    }

    private async checkElement(params: any): Promise<string> {
        const selector = params.selector;
        
        if (!selector) throw new Error("Selector required for check action");

        return this.setChecked({ selector, checked: true });
    }

    private async setChecked(params: any): Promise<string> {
        const selector = params.selector;
        if (!selector) throw new Error("Selector required for checked state");

        await this.client.waitForSelector(selector);
        const before = await this.client.evaluate(`
            (function() {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return { success: false, error: "Element not found" };
                if (el.type !== 'checkbox' && el.type !== 'radio') return { success: false, error: "Element is not a checkbox or radio" };
                if (el.disabled) return { success: false, error: "Element is disabled" };
                return { success: true, checked: !!el.checked, type: el.type };
            })()
        `);
        if (!before?.success) throw new Error(before?.error || "Failed to inspect checked state");

        const wanted = !!params.checked;
        if (before.checked === wanted) return `Checked state set to ${wanted}`;

        if (!(before.type === "radio" && !wanted)) {
            try {
                await this.clickElementBySelector({ selector });
                const afterClick = await this.client.evaluate(`
                    (function() {
                        const el = document.querySelector(${JSON.stringify(selector)});
                        return el ? !!el.checked : null;
                    })()
                `);
                if (afterClick === wanted) return `Checked state set to ${wanted}`;
            } catch {
                // Fall back to direct state setting below for reliability.
            }
        }

        const result = await this.client.evaluate(`
            (function() {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return { success: false, error: "Element not found" };
                if (el.type !== 'checkbox' && el.type !== 'radio') return { success: false, error: "Element is not a checkbox or radio" };
                el.checked = ${JSON.stringify(!!params.checked)};
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true, checked: el.checked };
            })()
        `);
        if (result?.success) return `Checked state set to ${!!params.checked}`;
        throw new Error(result?.error || "Failed to set checked state");
    }

    private async getAccessibilityTree(params: any): Promise<any> {
        return await this.client.getSimplifiedAccessibilityTree();
    }

    private async getDOMTree(params: any): Promise<any> {
        const result = await this.client.getDOMSnapshot();
        return result;
    }

    private async assertCondition(params: any): Promise<any> {
        const assertionType = params.assertionType || "element_exists";
        const selector = params.selector;
        const expectedText = params.expectedText || params.value || "";
        
        const result = await this.client.evaluate(`
            (function() {
                const selector = ${JSON.stringify(selector)};
                const type = ${JSON.stringify(assertionType)};
                const expectedText = ${JSON.stringify(expectedText)};
                
                const el = selector ? document.querySelector(selector) : null;
                
                switch(type) {
                    case 'element_exists':
                        return { success: !!el, message: el ? 'Element exists' : 'Element not found' };
                    case 'element_not_exists':
                        return { success: !el, message: !el ? 'Element does not exist' : 'Element found' };
                    case 'element_contains_text':
                        if (!el) return { success: false, message: 'Element not found' };
                        const text = (el.innerText || el.textContent || '').trim();
                        const matches = text.includes(expectedText);
                        return { success: matches, message: matches ? 'Text matches' : 'Text does not match', actualText: text };
                    case 'url_contains':
                        const urlMatches = window.location.href.includes(expectedText);
                        return { success: urlMatches, message: urlMatches ? 'URL contains text' : 'URL does not contain text' };
                    default:
                        return { success: false, message: 'Unknown assertion type' };
                }
            })()
        `);
        
        return result || { success: false, message: "Assertion failed" };
    }

    private async getCookies(params: any): Promise<any> {
        const result = await this.client.sendCommand("Network.getCookies", {
            urls: [await this.client.evaluate("window.location.href").catch(() => "*") || "*"],
        });
        return result.cookies || [];
    }

    private async setCookie(params: any): Promise<string> {
        const cookies = [{
            name: params.cookieName || params.name,
            value: params.cookieValue || params.value,
            url: params.url || await this.client.evaluate("window.location.href").catch(() => undefined),
            domain: params.domain,
            path: params.path || "/",
            secure: params.secure || false,
            httpOnly: params.httpOnly || false,
        }];
        
        await this.client.sendCommand("Network.setCookies", { cookies });
        return "Cookie set";
    }

    private async clearCache(params: any): Promise<string> {
        await this.client.sendCommand("Network.clearBrowserCache", {});
        await this.client.sendCommand("Network.clearBrowserCookies", {});
        return "Cache cleared";
    }

    private async setGeolocation(params: any): Promise<string> {
        await this.client.sendCommand("Emulation.setGeolocationOverride", {
            latitude: params.latitude,
            longitude: params.longitude,
            accuracy: params.accuracy || 100,
        });
        return `Geolocation set to ${params.latitude}, ${params.longitude}`;
    }

    private async setTimezone(params: any): Promise<string> {
        await this.client.sendCommand("Emulation.setTimezoneOverride", {
            timezoneId: params.timezoneId,
        });
        return `Timezone set to ${params.timezoneId}`;
    }

    private async emulateNetworkConditions(params: any): Promise<string> {
        await this.client.sendCommand("Network.emulateNetworkConditions", {
            offline: params.offline || false,
            latency: params.latency || 0,
            downloadThroughput: params.downloadThroughput || 0,
            uploadThroughput: params.uploadThroughput || 0,
        });
        return "Network conditions emulated";
    }

    private async printPDF(params: any): Promise<string> {
        const result = await this.client.sendCommand("Page.printToPDF", {
            landscape: params.landscape || false,
            printBackground: params.printBackground || false,
            ...params.options,
        });
        return result.data; // base64 PDF
    }

    private async highlightElements(params: any): Promise<any> {
        const result = await this.client.getInteractiveElements(true);
        return {
            success: true,
            elements: result.elements,
            message: `Highlighted ${result.elements.length} elements`,
        };
    }

    private async verifyUIState(params: any): Promise<any> {
        const selector = params.selector;
        const expectedText = params.expectedText || params.value || "";
        
        const result = await this.client.evaluate(`
            (function() {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return { exists: false, visible: false };
                
                const rect = el.getBoundingClientRect();
                const computed = window.getComputedStyle(el);
                const visible = rect.width > 0 && rect.height > 0 && 
                              computed.display !== 'none' && 
                              computed.visibility !== 'hidden' &&
                              computed.opacity !== '0';
                
                return {
                    exists: true,
                    visible,
                    text: (el.innerText || el.textContent || '').trim().substring(0, 200),
                    bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
                };
            })()
        `);
        
        return result || { exists: false, visible: false };
    }

    private async getDOMStorage(params: any): Promise<any> {
        await this.client.sendCommand("DOMStorage.enable", {});
        const origin = params.origin || await this.client.evaluate("window.location.origin").catch(() => "");
        
        const result = await this.client.sendCommand("DOMStorage.getDOMStorageItems", {
            storageId: { securityOrigin: origin, isLocalStorage: params.type !== 'session' },
        });
        
        return result.entries || [];
    }

    private async getNetworkTraffic(params: any): Promise<any[]> {
        return await this.client.getNetworkTraffic();
    }

    private async getNetworkResponse(params: any): Promise<any> {
        const requestId = params.requestId;
        if (!requestId) throw new Error("requestId required");
        
        const result = await this.client.sendCommand("Network.getResponseBody", { requestId });
        return result;
    }

    private async mockNetworkRequest(params: any): Promise<string> {
        const urlPattern = params.urlPattern;
        const mockResponse = params.mockResponse;

        if (!urlPattern) throw new Error("urlPattern required");

        this.mockRoutes.push({
            pattern: urlPattern,
            response: mockResponse || "{}"
        });

        await this.client.sendCommand("Fetch.enable", {
            patterns: this.mockRoutes.map(route => ({ urlPattern: route.pattern }))
        });

        if (!this.mockRouteListener) {
            this.mockRouteListener = async (event: any) => {
                const route = this.mockRoutes.find(item => this.matchesUrlPattern(event.request.url, item.pattern));
                if (!route) {
                    await this.client.sendCommand("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {});
                    return;
                }

                await this.client.sendCommand("Fetch.fulfillRequest", {
                    requestId: event.requestId,
                    responseCode: 200,
                    responseHeaders: [
                        { name: "Content-Type", value: "application/json" },
                        { name: "Access-Control-Allow-Origin", value: "*" }
                    ],
                    body: Buffer.from(route.response).toString("base64")
                }).catch(() => {});
            };
            this.client.on("Fetch.requestPaused", this.mockRouteListener);
        }

        return `Mocking enabled for pattern: ${urlPattern}`;
    }

    private matchesUrlPattern(url: string, pattern: string): boolean {
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
        return new RegExp(`^${escaped}$`).test(url);
    }

    private async getComputedStyle(params: any): Promise<any> {
        const selector = params.selector;
        const property = params.property;
        
        if (!selector) throw new Error("Selector required");
        
        const result = await this.client.evaluate(`
            (function() {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return null;
                const style = window.getComputedStyle(el);
                ${property ? `return style.getPropertyValue(${JSON.stringify(property)});` : `return JSON.parse(JSON.stringify(style));`}
            })()
        `);
        
        return result;
    }

    private async getEventListeners(params: any): Promise<any> {
        const selector = params.selector;
        if (!selector) throw new Error("Selector required");
        
        const result = await this.client.evaluate(`
            (function() {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return null;
                // getEventListeners is Chrome DevTools specific, not available in page context
                return { message: "getEventListeners requires DevTools protocol, not available in page context" };
            })()
        `);
        
        return result;
    }

    private screencastFrames: string[] = [];
    private screencastFrameListener: ((event: any) => void) | null = null;
    private mockRoutes: Array<{ pattern: string; response: string }> = [];
    private mockRouteListener: ((event: any) => void) | null = null;

    private async getScreencastFrames(params: any): Promise<any> {
        const maxFrames = params.maxFrames || this.screencastFrames.length;
        const frames = this.screencastFrames.slice(-maxFrames);
        
        return {
            frameCount: frames.length,
            frames,
            message: `Retrieved ${frames.length} frames`
        };
    }

    private async uploadFile(params: any): Promise<string> {
        const selector = params.selector;
        const files = params.files || [];
        
        if (!selector) throw new Error("Selector required for upload_file action");
        if (!files.length) throw new Error("No files specified");
        
        // Click the file input to activate it
        const result = await this.client.evaluate(`
            (function() {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return { success: false, error: "Element not found" };
                if (el.type !== 'file') return { success: false, error: "Element is not a file input" };
                el.style.display = 'block'; // Make sure it's visible
                el.click();
                return { success: true };
            })()
        `);
        
        if (!result?.success) {
            throw new Error(result?.error || "Failed to activate file input");
        }

        const documentResult = await this.client.sendCommand("DOM.getDocument", {});
        const queryResult = await this.client.sendCommand("DOM.querySelector", {
            nodeId: documentResult.root.nodeId,
            selector
        });

        if (!queryResult.nodeId) {
            throw new Error(`File input not found: ${selector}`);
        }

        await this.client.sendCommand("DOM.setFileInputFiles", {
            files,
            nodeId: queryResult.nodeId
        });

        return "File upload completed";
    }

    private async configureBrowser(params: any): Promise<any> {
        const { network, emulation, script } = params;
        const results: string[] = [];
        
        // Configure network settings
        if (network) {
            if (network.blockImages) {
                await this.client.sendCommand("Network.setBlockedURLs", {
                    urls: ["*.jpg", "*.jpeg", "*.png", "*.gif", "*.webp", "*.svg"]
                });
                results.push("Blocked images");
            }
            if (network.blockCSS) {
                await this.client.sendCommand("Network.setBlockedURLs", {
                    urls: ["*.css"]
                });
                results.push("Blocked CSS");
            }
            if (network.blockAds) {
                await this.client.sendCommand("Network.setBlockedURLs", {
                    urls: ["*doubleclick.net*", "*googlesyndication.com*", "*adservice.*"]
                });
                results.push("Blocked ads");
            }
        }
        
        // Configure emulation settings
        if (emulation) {
            if (emulation.width && emulation.height) {
                await this.client.sendCommand("Emulation.setDeviceMetricsOverride", {
                    width: emulation.width,
                    height: emulation.height,
                    deviceScaleFactor: emulation.scale || 1,
                    mobile: emulation.mobile || false,
                });
                results.push(`Emulated device: ${emulation.width}x${emulation.height}`);
            }
            if (emulation.userAgent) {
                await this.client.sendCommand("Emulation.setUserAgentOverride", {
                    userAgent: emulation.userAgent,
                });
                results.push("Set custom user agent");
            }
        }
        
        // Configure scripts
        if (script?.onLoad) {
            await this.client.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
                source: script.onLoad,
            });
            results.push("Added script to run on new documents");
        }
        
        return {
            success: true,
            configured: results,
            message: results.join(", ") || "No configuration applied"
        };
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
