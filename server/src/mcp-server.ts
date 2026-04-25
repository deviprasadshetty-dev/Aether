import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getCdpBridge } from "./cdp-bridge";
import { getCdpClient } from "./cdp-client";

interface TaskNode {
    id: string;
    action: string;
    url: string;
    timestamp: string;
    parentId?: string;
    status: 'success' | 'failure' | 'pending';
    error?: string;
}

const taskMemory: TaskNode[] = [];
const sessionHistory: any[] = [];
const MAX_MEMORY = 100;

const Tools = [
    {
        name: "get_task_graph",
        description: "Retrieve the hierarchical task graph for the current session (Aether v2 Task Orbit).",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "act",
        description: "Perform precise, high-speed actions in the browser. Supports navigation, clicking, typing, scrolling, and tab management with atomic verification.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: [
                        "navigate", "click", "type", "fill", "select", "check",
                        "hover", "scroll", "wait", "screenshot",
                        "new_tab", "switch_tab", "close_tab", "drag_and_drop", "upload_file", "get_logs",
                        "get_tree", "get_dom_tree", "configure", "print_pdf", "emulate_network",
                        "get_cookies", "set_cookie", "clear_cache", "set_geolocation", "set_timezone", "get_performance_metrics",
                        "start_screencast", "stop_screencast", "record_session",
                        "mock_network_request", "generate_artifact", "highlight_elements",
                        "assert", "start_tracing", "stop_tracing", "target_auto_attach", "enable_domain", "pause", "resume",
                        "screenshot_region", "verify_ui_state", "get_dom_snapshot", "get_event_listeners",
                        "get_computed_style", "get_network_traffic", "get_network_response",
                        "get_screencast_frames", "get_dom_storage"
                    ],
                    description: "The action to perform."
                },
                selector: { type: "string", description: "CSS selector or text content to interact with." },
                elementId: { type: "string", description: "Element ID from `get_state` (e.g., '@1' or '1'). Preferred over selector." },
                value: { type: "string", description: "Value to type, option to select, or URL to navigate to." },
                assertionType: { type: "string", description: "Assertion type for 'assert' action (e.g., 'element_exists', 'element_not_exists', 'element_contains_text', 'url_contains')." },
                options: { type: "object", description: "Options for the action (e.g., {x, y, width, height} for screenshot_region)." },
                domain: { type: "string", description: "CDP domain to enable (for enable_domain action)." },
                coordinate: { type: "string", description: "X,Y coordinates (e.g., '100,200')." },
                parentId: { type: "string", description: "Parent task ID for hierarchical tracking (UFO3)." },
                tabId: { type: "number", description: "Tab ID for switching/closing." },
                files: { type: "array", items: { type: "string" }, description: "Files for upload_file action" },
                modifiers: { type: "array", items: { type: "string" }, description: "Key modifiers (Ctrl, Alt, etc.)" },

                // Screencast / Record params
                format: { type: "string", description: "Image format (jpeg/png). Default: jpeg" },
                quality: { type: "number", description: "Compression quality (0-100). Default: 50" },
                maxWidth: { type: "number", description: "Max width of the frame. Default: 1024" },
                maxHeight: { type: "number", description: "Max height of the frame. Default: 768" },
                everyNthFrame: { type: "number", description: "Frequency of captured frames. Default: 10" },
                maxFrames: { type: "number", description: "Maximum number of frames to return. Default: all" },
                duration: { type: "number", description: "Duration in ms to record (only for record_session). Default: 5000" },

                // CDP specific params
                cookieName: { type: "string", description: "Name of the cookie to set." },
                cookieValue: { type: "string", description: "Value of the cookie to set." },
                latitude: { type: "number", description: "Latitude for geolocation override." },
                longitude: { type: "number", description: "Longitude for geolocation override." },
                timezoneId: { type: "string", description: "Timezone ID (e.g., 'America/New_York')." },

                // Mocking & Artifact params
                urlPattern: { type: "string", description: "URL pattern to mock (e.g., '*api.example.com*')" },
                mockResponse: { type: "string", description: "Stringified JSON to return as mocked response" },
                markdownSummary: { type: "string", description: "Summary text for the artifact" },
                requestId: { type: "string", description: "Request ID for get_network_response" },

                // Network Emulation params
                offline: { type: "boolean" },
                latency: { type: "number" },
                downloadThroughput: { type: "number" },
                uploadThroughput: { type: "number" },

                // PDF params (subset)
                landscape: { type: "boolean" },
                printBackground: { type: "boolean" },

                // Configuration params
                network: {
                    type: "object",
                    properties: { blockImages: { type: "boolean" }, blockAds: { type: "boolean" }, blockCSS: { type: "boolean" } }
                },
                emulation: {
                    type: "object",
                    properties: { width: { type: "number" }, height: { type: "number" }, mobile: { type: "boolean" }, userAgent: { type: "string" } }
                },
                script: {
                    type: "object",
                    properties: { onLoad: { type: "string" } }
                }
            },
            required: ["action"],
        },
    },
    {
        name: "get_state",
        description: "Capture the current browser state (v2) — includes high-fidelity element map, screenshot, and console logs.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "execute_script",
        description: "Execute arbitrary JavaScript in the browser context.",
        inputSchema: {
            type: "object",
            properties: { script: { type: "string" } },
            required: ["script"],
        },
    },
    {
        name: "cdp_command",
        description: "Execute a raw Chrome DevTools Protocol (CDP) command on the active tab.",
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string", description: "The CDP command method (e.g., 'Network.getCookies')." },
                args: { type: "object", description: "The JSON arguments required by the CDP command." }
            },
            required: ["command"],
        }
    },
    {
        name: "connect_browser",
        description: "Connect to browser. Auto-detects and launches available browser if not connected.",
        inputSchema: {
            type: "object",
            properties: {
                mode: { type: "string", enum: ["connect", "launch", "auto"], description: "Connect to existing or launch new instance (auto = detect & launch)." },
                port: { type: "number", description: "Browser debugging port (default: 9222)." },
                headless: { type: "boolean", description: "Run in headless mode (only for launch mode)." },
                browser: { type: "string", enum: ["chrome", "edge", "brave", "firefox"], description: "Browser to use (default: auto-detect)." }
            }
        }
    },
    {
        name: "launch_browser",
        description: "Launch a browser (auto-detects available browsers if not specified).",
        inputSchema: {
            type: "object",
            properties: {
                browser: { type: "string", enum: ["chrome", "edge", "brave", "firefox"], description: "Browser to launch (default: auto-detect first available)." },
                headless: { type: "boolean", description: "Run in headless mode." },
                port: { type: "number", description: "Debugging port (default: 9222)." }
            }
        }
    },
    {
        name: "kill_browser",
        description: "Kill the launched browser process when done.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "list_browsers",
        description: "List all available browsers on the system.",
        inputSchema: { type: "object", properties: {} }
    },
    // ==================== AGENT-CENTRIC APIs ====================
    {
        name: "agent_action",
        description: "Execute an action and optionally verify UI state. Unified action API that combines action + wait + verify in one call. Returns screenshot after action.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["click", "type", "scroll", "hover", "drag", "key_press"],
                    description: "Action to perform."
                },
                target: {
                    type: "object",
                    properties: {
                        id: { type: "string", description: "Element ID from page_snapshot" },
                        selector: { type: "string", description: "CSS selector" },
                        text: { type: "string", description: "Text to match" },
                        x: { type: "number", description: "X coordinate" },
                        y: { type: "number", description: "Y coordinate" },
                        button: { type: "string", enum: ["left", "middle", "right"] },
                        clickCount: { type: "number" },
                        key: { type: "string", description: "Key to press" },
                        modifiers: { type: "array", items: { type: "string" } }
                    }
                },
                verify: {
                    type: "object",
                    properties: {
                        selector: { type: "string" },
                        expectedText: { type: "string" },
                        type: { type: "string", enum: ["element_exists", "element_contains_text", "text_match", "element_visible"] }
                    }
                },
                waitFor: {
                    type: "object",
                    properties: {
                        type: { type: "string", enum: ["network_idle", "element", "navigation"] },
                        selector: { type: "string" },
                        timeout: { type: "number" }
                    }
                },
                timeout: { type: "number", description: "Timeout in ms (default: 10000)" }
            },
            required: ["action", "target"]
        }
    },
    {
        name: "smart_navigate",
        description: "Navigate to URL with built-in waiting for page stability. Auto-dismisses popups. Returns screenshot of loaded page.",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string", description: "URL to navigate to." },
                waitFor: {
                    type: "object",
                    properties: {
                        type: { type: "string", enum: ["element", "network_idle"] },
                        selector: { type: "string" },
                        timeout: { type: "number" }
                    }
                },
                dismissPopups: { type: "boolean", description: "Auto-dismiss popups (default: true)" },
                screenshot: { type: "boolean", description: "Return screenshot (default: true)" },
                timeout: { type: "number", description: "Navigation timeout in ms (default: 30000)" }
            },
            required: ["url"]
        }
    },
    {
        name: "observe_and_act",
        description: "Execute an action and observe page state changes. Returns before/after snapshots to detect what changed.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "object",
                    properties: {
                        type: { type: "string", enum: ["click", "type"] },
                        selector: { type: "string" },
                        text: { type: "string" }
                    }
                },
                observe: {
                    type: "object",
                    properties: {
                        type: { type: "string", enum: ["dom_change", "network_response"] }
                    }
                },
                returnScreenshot: { type: "boolean", description: "Return screenshots (default: true)" }
            },
            required: ["action"]
        }
    },
    {
        name: "agent_form_fill",
        description: "Intelligently fill form fields. Auto-detects field types (text, select, checkbox, radio, file).",
        inputSchema: {
            type: "object",
            properties: {
                fields: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string" },
                            selector: { type: "string" },
                            type: { type: "string", enum: ["text", "email", "password", "select", "checkbox", "radio", "file", "textarea"] },
                            value: { type: "string" },
                            checked: { type: "boolean" },
                            files: { type: "array", items: { type: "string" } }
                        }
                    },
                    description: "Form fields to fill."
                },
                submitAfterFill: { type: "boolean", description: "Submit form after filling (default: false)" },
                submitSelector: { type: "string", description: "Selector for submit button" }
            },
            required: ["fields"]
        }
    },
    {
        name: "page_snapshot",
        description: "Capture rich page context optimized for LLM consumption. Returns interactive elements, forms, network state, logs, cookies, and storage in one call.",
        inputSchema: {
            type: "object",
            properties: {
                fullPage: { type: "boolean", description: "Full page screenshot (default: false)" },
                includeDOMSnapshot: { type: "boolean", description: "Include full DOM snapshot (default: false)" }
            }
        }
    }
];

export function RegisterMcpTools(server: Server, wsServer: any) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Tools }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const a = args as any;
        const bridge = getCdpBridge();

        try {
            if (name === "get_task_graph") {
                return { content: [{ type: "text", text: JSON.stringify(taskMemory, null, 2) }] };
            }

            if (name === "connect_browser") {
                const mode = a?.mode || "auto";
                const port = a?.port || 9222;
                
                if (mode === "connect") {
                    await bridge.sendCommand("connect", { port });
                    return { content: [{ type: "text", text: "Connected to browser successfully" }] };
                } else if (mode === "launch") {
                    const result = await bridge.launchBrowser({ 
                        browser: a?.browser, 
                        headless: a?.headless, 
                        port 
                    });
                    return { content: [{ type: "text", text: result }] };
                } else {
                    // auto mode - detect and launch
                    const result = await bridge.launchBrowser({ 
                        browser: a?.browser, 
                        headless: a?.headless, 
                        port 
                    });
                    return { content: [{ type: "text", text: result }] };
                }
            }

            if (name === "launch_browser") {
                const result = await bridge.launchBrowser({ 
                    browser: a?.browser, 
                    headless: a?.headless,
                    port: a?.port 
                });
                return { content: [{ type: "text", text: result }] };
            }

            if (name === "kill_browser") {
                const result = await bridge.killBrowser();
                return { content: [{ type: "text", text: result }] };
            }

            if (name === "list_browsers") {
                const browsers = await bridge.listBrowsers();
                if (browsers.length === 0) {
                    return { content: [{ type: "text", text: "No supported browsers found. Please install Chrome, Edge, Brave, or Firefox." }] };
                }
                const list = browsers.map((b: any) => `${b.name}: ${b.path}`).join("\n");
                return { content: [{ type: "text", text: `Available browsers:\n${list}` }] };
            }

            if (name === "get_state") {
                const result = await bridge.sendCommand("get_state", {});
                if (!result) throw new Error("Received empty state");

                sessionHistory.unshift({ timestamp: new Date().toISOString(), title: result.title, url: result.url });
                if (sessionHistory.length > MAX_MEMORY) sessionHistory.pop();

                const content: any[] = [
                    { type: "text", text: `Title: ${result.title}\nURL: ${result.url}` },
                ];
                if (result.screenshot) {
                    content.push({ type: "image", data: result.screenshot, mimeType: "image/jpeg" });
                }

                return { content };
            }

            if (name === "execute_script") {
                const result = await bridge.sendCommand("evaluate", { script: String(a?.script) });
                return { content: [{ type: "text", text: `Result: ${JSON.stringify(result)}` }] };
            }

            if (name === "cdp_command") {
                const result = await bridge.sendCommand("cdp_command", { command: a.command, args: a.args || {} });
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            }

            if (name === "act") {
                const action = a.action;
                const taskId = `v2-${Math.random().toString(36).substring(7)}`;
                
                let currentState = { url: "unknown" };
                try {
                    currentState = await bridge.sendCommand("get_state", { screenshot: false });
                } catch {}

                const node: TaskNode = {
                    id: taskId, action, url: currentState.url, 
                    timestamp: new Date().toISOString(), parentId: a.parentId, status: 'pending'
                };
                taskMemory.push(node);
                if (taskMemory.length > MAX_MEMORY) taskMemory.shift();

                let resultMsg = "";
                const eid = a.elementId ? String(a.elementId).replace('@', '') : undefined;
                
                try {
                    if (action === "click") {
                        if (eid) resultMsg = await bridge.sendCommand("click_element", { id: eid, text: a.value });
                        else if (a.selector) resultMsg = await bridge.sendCommand("click_element_by_selector", { selector: a.selector });
                        else if (a.coordinate) {
                            const [x, y] = String(a.coordinate).split(',').map(Number);
                            resultMsg = await bridge.sendCommand("click", { x, y });
                        } else {
                             resultMsg = await bridge.sendCommand(action, a);
                        }
                    } else if (action === "type") {
                        if (eid || a.selector) await bridge.sendCommand(eid ? "click_element" : "click_element_by_selector", { id: eid, selector: a.selector });
                        resultMsg = await bridge.sendCommand("type", { text: a.value || a.text });
                    } else if (action === "navigate") {
                        resultMsg = await bridge.sendCommand("navigate", { url: a.value });
                    } else {
                        resultMsg = await bridge.sendCommand(action, a);
                    }
                    node.status = 'success';
                } catch (err: any) {
                    node.status = 'failure';
                    node.error = err.message;
                    throw err;
                }

                return { content: [{ type: "text", text: typeof resultMsg === 'string' ? resultMsg : JSON.stringify(resultMsg) }] };
            }

            // ==================== AGENT-CENTRIC APIs ====================
            if (name === "agent_action") {
                const result = await bridge.sendCommand("agent_action", {
                    action: a.action,
                    target: a.target,
                    verify: a.verify,
                    waitFor: a.waitFor,
                    timeout: a.timeout
                });
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            }

            if (name === "smart_navigate") {
                const result = await bridge.sendCommand("smart_navigate", {
                    url: a.url,
                    waitFor: a.waitFor,
                    dismissPopups: a.dismissPopups,
                    screenshot: a.screenshot,
                    timeout: a.timeout
                });
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            }

            if (name === "observe_and_act") {
                const result = await bridge.sendCommand("observe_and_act", {
                    action: a.action,
                    observe: a.observe,
                    returnScreenshot: a.returnScreenshot
                });
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            }

            if (name === "agent_form_fill") {
                const result = await bridge.sendCommand("agent_form_fill", {
                    fields: a.fields,
                    submitAfterFill: a.submitAfterFill,
                    submitSelector: a.submitSelector
                });
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            }

            if (name === "page_snapshot") {
                const result = await bridge.sendCommand("page_snapshot", {
                    fullPage: a.fullPage,
                    includeDOMSnapshot: a.includeDOMSnapshot
                });
                
                const content: any[] = [
                    { type: "text", text: `Title: ${result.title}\nURL: ${result.url}` }
                ];
                if (result.screenshot) {
                    content.push({ type: "image", data: result.screenshot, mimeType: "image/jpeg" });
                }
                if (result.elements) {
                    content.push({ type: "text", text: `\nInteractive Elements: ${JSON.stringify(result.elements, null, 2)}` });
                }
                return { content };
            }

            throw new Error(`Unknown tool: ${name}`);
        } catch (error: any) {
            if (error.message?.includes("not connected") || error.message?.includes("No active extension")) {
                return { content: [{ type: "text", text: `Browser not connected. Use 'connect_browser' tool first to connect or launch Chrome.` }], isError: true };
            }
            return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
    });
}

