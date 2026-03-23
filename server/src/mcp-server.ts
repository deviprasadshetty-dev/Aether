import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { sendCommandToExtension } from "./ws-server";
import * as fs from "fs";
import * as path from "path";

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
let lastKnownCursor: [number, number] = [0, 0];

const Tools = [
    {
        name: "get_task_graph",
        description: "Retrieve the hierarchical task graph for the current session (UFO3 Task Constellation).",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "act",
        description: "Perform an action in the browser. Supports navigation, clicking, typing, scrolling, waiting, and tab management.",
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
                        "screenshot_region", "verify_ui_state"
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
        description: "Get the current state (URL, Title, Screenshot, Interactive Elements with IDs, Logs)",
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
        name: "computer_20241022",
        description: "Native Anthropic Computer Use API implementation for zero-shot browser control.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: [
                        "key", "type", "mouse_move", "left_click", 
                        "left_click_drag", "right_click", "middle_click", 
                        "double_click", "screenshot", "cursor_position"
                    ]
                },
                coordinate: {
                    type: "array",
                    items: { type: "number" }
                },
                text: { type: "string" }
            },
            required: ["action"]
        }
    }
];

export function RegisterMcpTools(server: Server, wsServer: any) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Tools }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const a = args as any;

        try {
            if (name === "get_task_graph") {
                return { content: [{ type: "text", text: JSON.stringify(taskMemory, null, 2) }] };
            }

            if (name === "computer_20241022") {
                const action = a.action;
                let resultMsg = "";
                
                if (action === "screenshot") {
                    const result = await sendCommandToExtension("get_state", {});
                    return { content: [{ type: "image", data: result.screenshot, mimeType: "image/jpeg" }] };
                } 
                
                else if (action === "cursor_position") {
                    return { content: [{ type: "text", text: `Cursor position: ${lastKnownCursor[0]}, ${lastKnownCursor[1]}` }] };
                }

                else if (action === "left_click") {
                    const coord = a.coordinate || lastKnownCursor;
                    await sendCommandToExtension("click", { x: coord[0], y: coord[1], button: "left", clickCount: 1 });
                    lastKnownCursor = [coord[0], coord[1]];
                    resultMsg = `Left clicked at ${coord[0]}, ${coord[1]}`;
                } 
                
                else if (action === "right_click") {
                    const coord = a.coordinate || lastKnownCursor;
                    await sendCommandToExtension("right_click", { x: coord[0], y: coord[1] });
                    lastKnownCursor = [coord[0], coord[1]];
                    resultMsg = `Right clicked at ${coord[0]}, ${coord[1]}`;
                }

                else if (action === "middle_click") {
                    const coord = a.coordinate || lastKnownCursor;
                    await sendCommandToExtension("middle_click", { x: coord[0], y: coord[1] });
                    lastKnownCursor = [coord[0], coord[1]];
                    resultMsg = `Middle clicked at ${coord[0]}, ${coord[1]}`;
                }

                else if (action === "double_click") {
                    const coord = a.coordinate || lastKnownCursor;
                    await sendCommandToExtension("double_click", { x: coord[0], y: coord[1] });
                    lastKnownCursor = [coord[0], coord[1]];
                    resultMsg = `Double clicked at ${coord[0]}, ${coord[1]}`;
                }

                else if (action === "left_click_drag") {
                    if (!a.coordinate) throw new Error("left_click_drag requires coordinate");
                    const startX = lastKnownCursor[0];
                    const startY = lastKnownCursor[1];
                    const endX = a.coordinate[0];
                    const endY = a.coordinate[1];
                    await sendCommandToExtension("drag", { startX, startY, endX, endY });
                    lastKnownCursor = [endX, endY];
                    resultMsg = `Dragged from ${startX}, ${startY} to ${endX}, ${endY}`;
                }

                else if (action === "mouse_move") {
                    if (a.coordinate) {
                        await sendCommandToExtension("mouse_move", { x: a.coordinate[0], y: a.coordinate[1] });
                        lastKnownCursor = [a.coordinate[0], a.coordinate[1]];
                        resultMsg = `Mouse moved to ${a.coordinate[0]}, ${a.coordinate[1]}`;
                    } else {
                        throw new Error("mouse_move requires coordinate");
                    }
                } 
                
                else if (action === "type") {
                    if (a.text) {
                        await sendCommandToExtension("type", { text: a.text });
                        resultMsg = `Typed: ${a.text}`;
                    } else {
                        throw new Error("type requires text");
                    }
                } 
                
                else if (action === "key") {
                    if (a.text) {
                        const parts = a.text.split('+');
                        let key = parts.pop() || "";
                        if (key === "Return") key = "Enter";
                        const modifiers = parts.map((p: string) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
                        await sendCommandToExtension("press_key", { key, modifiers });
                        resultMsg = `Pressed key ${a.text}`;
                    } else {
                        throw new Error("key requires text");
                    }
                } 
                
                else {
                    resultMsg = `Action ${action} is recognized but not fully implemented.`;
                }

                return { content: [{ type: "text", text: resultMsg }] };
            }

            if (name === "get_state") {
                const result = await sendCommandToExtension("get_state", {});
                if (!result) throw new Error("Received empty state from extension");

                const elementsSummary = result.interactiveElements
                    ? result.interactiveElements.map((el: any) => {
                        let desc = `[@${el.id}] ${el.tagName} "${el.text}"`;
                        if (el.type) desc += ` type=${el.type}`;
                        if (el.name) desc += ` name=${el.name}`;
                        if (el.role) desc += ` role=${el.role}`;
                        if (el.value) desc += ` value="${el.value}"`;
                        if (el.checked !== undefined) desc += ` checked=${el.checked}`;
                        if (el.disabled) desc += ` DISABLED`;
                        if (el.x && el.y) desc += ` center=(${el.x},${el.y})`;
                        return desc;
                    }).join("\n")
                    : "No elements found";

                const tabsSummary = result.tabs
                    ? "\n\nOpen Tabs:\n" + result.tabs.map((t: any) => `[${t.id}] ${t.title} ${t.active ? '(Active)' : ''}`).join("\n")
                    : "";

                sessionHistory.unshift({ timestamp: new Date().toISOString(), title: result.title, url: result.url });
                if (sessionHistory.length > 10) sessionHistory.pop();

                return {
                    content: [
                        { type: "text", text: `Title: ${result.title}\nURL: ${result.url}${tabsSummary}\n\nInteractive Elements:\n${elementsSummary}` },
                        { type: "image", data: result.screenshot, mimeType: "image/jpeg" }
                    ],
                };
            }

            if (name === "execute_script") {
                const result = await sendCommandToExtension("evaluate", { script: String(a?.script) });
                return { content: [{ type: "text", text: `Result: ${JSON.stringify(result)}` }] };
            }

            if (name === "cdp_command") {
                const result = await sendCommandToExtension("cdp_command", { command: a.command, args: a.args || {} });
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            }

            if (name === "act") {
                const action = a.action;
                const taskId = Math.random().toString(36).substring(7);
                const currentState = await sendCommandToExtension("get_state", { screenshot: false });
                
                // Track Task (UFO3)
                const node: TaskNode = {
                    id: taskId,
                    action: action,
                    url: currentState.url,
                    timestamp: new Date().toISOString(),
                    parentId: a.parentId,
                    status: 'pending'
                };
                taskMemory.push(node);

                let resultMsg = "";
                const eid = a.elementId ? Number(String(a.elementId).replace('@', '')) : undefined;

                try {
                    if (action === "navigate") {
                        await sendCommandToExtension("navigate", { url: a.value });
                        resultMsg = `Navigated to ${a.value}`;
                    }
                    else if (action === "screenshot_region") {
                        const res = await sendCommandToExtension("screenshot_region", { 
                            x: a.options?.x, y: a.options?.y, 
                            width: a.options?.width, height: a.options?.height 
                        });
                        return { content: [{ type: "image", data: res, mimeType: "image/jpeg" }] };
                    }
                    else if (action === "verify_ui_state") {
                        const res = await sendCommandToExtension("verify_ui_state", { 
                            selector: a.selector, 
                            expectedText: a.value,
                            type: a.assertionType || "visible" 
                        });
                        resultMsg = res.message;
                        if (!res.success) throw new Error(res.message);
                    }
                    else if (action === "click") {
                        if (eid) resultMsg = await sendCommandToExtension("click_element", { id: eid });
                        else if (a.selector) resultMsg = await sendCommandToExtension("click_element_by_selector", { selector: a.selector });
                        else if (a.coordinate) {
                            const [x, y] = a.coordinate.split(',').map(Number);
                            await sendCommandToExtension("click", { x, y });
                            resultMsg = `Clicked at ${x},${y}`;
                        }
                    }
                    else if (action === "type") {
                        await sendCommandToExtension("type", { text: a.text || a.value });
                        resultMsg = `Typed "${a.text || a.value}"`;
                    }
                    // ... (Forward other actions to extension similarly)
                    else {
                        // Default forwarding for existing actions
                        resultMsg = await sendCommandToExtension(action, a);
                    }

                    node.status = 'success';
                } catch (err: any) {
                    node.status = 'failure';
                    node.error = err.message;
                    throw err;
                }

                return { content: [{ type: "text", text: resultMsg }] };
            }

            throw new Error(`Unknown tool: ${name}`);
        } catch (error: any) {
            return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
    });
}
