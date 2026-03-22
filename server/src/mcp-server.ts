import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { sendCommandToExtension } from "./ws-server";
import * as fs from "fs";
import * as path from "path";

const Tools = [
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
                        "start_screencast", "stop_screencast",
                        "mock_network_request", "generate_artifact", "highlight_elements"
                    ],
                    description: "The action to perform."
                },
                selector: { type: "string", description: "CSS selector or text content to interact with." },
                elementId: { type: "string", description: "Element ID from `get_state` (e.g., '@1' or '1'). Preferred over selector." },
                value: { type: "string", description: "Value to type, option to select, or URL to navigate to." },
                coordinate: { type: "string", description: "X,Y coordinates (e.g., '100,200')." },
                tabId: { type: "number", description: "Tab ID for switching/closing." },
                files: { type: "array", items: { type: "string" }, description: "Files for upload_file action" },
                modifiers: { type: "array", items: { type: "string" }, description: "Key modifiers (Ctrl, Alt, etc.)" },

                // Screencast params
                format: { type: "string", description: "Image format (jpeg/png). Default: jpeg" },
                quality: { type: "number", description: "Compression quality (0-100). Default: 50" },
                maxWidth: { type: "number", description: "Max width of the frame. Default: 1024" },
                maxHeight: { type: "number", description: "Max height of the frame. Default: 768" },
                everyNthFrame: { type: "number", description: "Frequency of captured frames. Default: 10" },

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
    }
];

export function RegisterMcpTools(server: Server, wsServer: any) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Tools }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const a = args as any;

        try {
            if (name === "get_state") {
                console.error("[MCP] Requesting state...");
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
                        if (el.selectedOption) desc += ` selected="${el.selectedOption}"`;
                        if (el.disabled) desc += ` DISABLED`;
                        if (el.required) desc += ` REQUIRED`;
                        // Coordinates help agent understand spatial layout
                        if (el.x && el.y) desc += ` center=(${el.x},${el.y})`;
                        return desc;
                    }).join("\n")
                    : "No elements found";

                const tabsSummary = result.tabs
                    ? "\n\nOpen Tabs:\n" + result.tabs.map((t: any) => `[${t.id}] ${t.title} ${t.active ? '(Active)' : ''}`).join("\n")
                    : "";

                const logsSummary = result.logs && result.logs.length > 0
                    ? "\n\nRecent Logs:\n" + result.logs.map((l: any) => `[${l.type}] ${l.text}`).join("\n")
                    : "";

                return {
                    content: [
                        { type: "text", text: `Title: ${result.title}\nURL: ${result.url}${tabsSummary}\n\nInteractive Elements:\n${elementsSummary}${logsSummary}` },
                        { type: "image", data: result.screenshot, mimeType: "image/jpeg" }
                    ],
                };
            }

            if (name === "execute_script") {
                const result = await sendCommandToExtension("evaluate", { script: String(a?.script) });
                return { content: [{ type: "text", text: `Result: ${JSON.stringify(result)}` }] };
            }

            if (name === "cdp_command") {
                console.error(`[MCP] Executing CDP Command: ${a.command}`);
                const result = await sendCommandToExtension("cdp_command", { command: a.command, args: a.args || {} });
                return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
            }

            if (name === "act") {
                const action = a.action;
                console.error(`[MCP] Act: ${action}`, JSON.stringify(a));

                let resultMsg = "";
                const textFallback = a.selector || (a.value && isNaN(Number(a.value)) ? String(a.value) : "");
                
                // Parse elementId (handle both '@1' and '1')
                const parseId = (id: string | number | undefined) => {
                    if (id === undefined) return undefined;
                    const s = String(id);
                    return Number(s.startsWith('@') ? s.slice(1) : s);
                };
                const eid = parseId(a.elementId);

                // --- NAVIGATION & TABS ---
                if (action === "navigate") {
                    await sendCommandToExtension("navigate", { url: a.value });
                    resultMsg = `Navigated to ${a.value}`;
                }
                else if (action === "new_tab") {
                    resultMsg = await sendCommandToExtension("new_tab", { url: a.value || "about:blank" });
                }
                else if (action === "switch_tab") {
                    resultMsg = await sendCommandToExtension("switch_tab", { tabId: Number(a.tabId) });
                }
                else if (action === "close_tab") {
                    resultMsg = await sendCommandToExtension("close_tab", { tabId: Number(a.tabId) });
                }

                // --- INTERACTION ---
                else if (action === "click") {
                    if (eid) {
                        resultMsg = await sendCommandToExtension("click_element", { id: eid, text: textFallback });
                    } else if (a.selector) {
                        resultMsg = await sendCommandToExtension("click_element_by_selector", { selector: a.selector });
                    } else if (a.coordinate) {
                        const [x, y] = a.coordinate.split(',').map(Number);
                        await sendCommandToExtension("click", { x, y });
                        resultMsg = `Clicked at ${x},${y}`;
                    } else {
                        throw new Error("Click requires elementId, selector, or coordinate");
                    }
                }
                else if (action === "type") {
                    await sendCommandToExtension("type", { text: a.text || a.value });
                    resultMsg = `Typed "${a.text || a.value}"`;
                }
                else if (action === "fill") {
                    if (!eid) throw new Error("Fill requires elementId");
                    resultMsg = await sendCommandToExtension("fill_form", { id: eid, value: a.value, text: textFallback });
                }
                else if (action === "select") {
                    if (!eid) throw new Error("Select requires elementId");
                    resultMsg = await sendCommandToExtension("select_option", { id: eid, value: a.value, text: textFallback });
                }
                else if (action === "check") {
                    if (!eid) throw new Error("Check requires elementId");
                    resultMsg = await sendCommandToExtension("set_checkbox", { id: eid, checked: a.value === "true" || a.value === true, text: textFallback });
                }
                else if (action === "upload_file") {
                    if (!eid) throw new Error("Upload requires elementId");
                    resultMsg = await sendCommandToExtension("upload_file", { id: eid, files: a.files, text: textFallback });
                }
                else if (action === "drag_and_drop") {
                    if (!eid || !a.value) throw new Error("Drag requires elementId (source) and value (targetId)");
                    resultMsg = await sendCommandToExtension("drag_and_drop", { sourceId: eid, targetId: parseId(a.value) });
                }
                else if (action === "hover") {
                    if (eid) {
                        resultMsg = await sendCommandToExtension("hover", { id: eid, text: textFallback });
                    } else if (a.coordinate) {
                        const [x, y] = a.coordinate.split(',').map(Number);
                        resultMsg = await sendCommandToExtension("hover", { x, y });
                    }
                }
                else if (action === "scroll") {
                    const scrollValue = a.value ? Number(a.value) : 500;
                    if (a.coordinate) {
                        const [x, y] = a.coordinate.split(',').map(Number);
                        resultMsg = await sendCommandToExtension("scroll", { x, y });
                    } else {
                        resultMsg = await sendCommandToExtension("scroll", { x: 0, y: scrollValue });
                    }
                }

                // --- UTILS ---
                else if (action === "wait") {
                    if (a.selector) {
                        resultMsg = await sendCommandToExtension("wait_for_element", { selector: a.selector });
                    } else {
                        throw new Error("Wait requires selector");
                    }
                }
                else if (action === "get_logs") {
                    resultMsg = await sendCommandToExtension("get_logs", {});
                }
                else if (action === "get_tree") {
                    const tree = await sendCommandToExtension("get_accessibility_tree", {});
                    resultMsg = JSON.stringify(tree, null, 2);
                }
                else if (action === "get_dom_tree") {
                    const tree = await sendCommandToExtension("get_dom_tree", {});
                    resultMsg = JSON.stringify(tree, null, 2);
                }
                else if (action === "configure") {
                    const configParams = {
                        network: a.network,
                        emulation: a.emulation,
                        script: a.script
                    };
                    resultMsg = await sendCommandToExtension("configure", configParams);
                }
                else if (action === "print_pdf") {
                    const pdfBase64 = await sendCommandToExtension("print_pdf", { ...a });
                    if (typeof pdfBase64 === 'string') {
                        const buffer = Buffer.from(pdfBase64, 'base64');
                        const filename = `page_${Date.now()}.pdf`;
                        const fs = require('fs');
                        const path = require('path');
                        const filePath = path.join(process.cwd(), filename);
                        fs.writeFileSync(filePath, buffer);
                        resultMsg = `PDF saved to: ${filePath}`;
                    } else {
                        resultMsg = "Failed to generate PDF data";
                    }
                }
                else if (action === "emulate_network") {
                    resultMsg = await sendCommandToExtension("emulate_network", {
                        offline: a.offline,
                        latency: a.latency,
                        downloadThroughput: a.downloadThroughput,
                        uploadThroughput: a.uploadThroughput
                    });
                }
                // --- CDP SPECIFIC ACTIONS ---
                else if (action === "get_cookies") {
                    resultMsg = await sendCommandToExtension("get_cookies", {});
                }
                else if (action === "set_cookie") {
                    resultMsg = await sendCommandToExtension("set_cookie", { name: a.cookieName, value: a.cookieValue, url: a.value });
                }
                else if (action === "clear_cache") {
                    resultMsg = await sendCommandToExtension("clear_cache", {});
                }
                else if (action === "set_geolocation") {
                    resultMsg = await sendCommandToExtension("set_geolocation", { latitude: a.latitude, longitude: a.longitude });
                }
                else if (action === "set_timezone") {
                    resultMsg = await sendCommandToExtension("set_timezone", { timezoneId: a.timezoneId });
                }
                else if (action === "get_performance_metrics") {
                    resultMsg = await sendCommandToExtension("get_performance_metrics", {});
                }
                else if (action === "start_screencast") {
                    resultMsg = await sendCommandToExtension("start_screencast", {
                        format: a.format || "jpeg",
                        quality: a.quality || 50,
                        maxWidth: a.maxWidth || 1024,
                        maxHeight: a.maxHeight || 768,
                        everyNthFrame: a.everyNthFrame || 10
                    });
                }
                else if (action === "stop_screencast") {
                    const response: any = await sendCommandToExtension("stop_screencast", {});
                    if (response && response.frames) {
                        const contentBlocks: any[] = [{ type: "text", text: `Screencast stopped. Captured ${response.frames.length} frames.` }];
                        // Map each frame to an image block
                        response.frames.forEach((frame: any) => {
                            contentBlocks.push({
                                type: "image",
                                data: frame.data,
                                mimeType: `image/${a.format || 'jpeg'}`
                            });
                        });
                        return { content: contentBlocks };
                    } else {
                        resultMsg = "Screencast stopped, but no frames were returned.";
                    }
                }
                else if (action === "mock_network_request") {
                    resultMsg = await sendCommandToExtension("mock_network_request", { urlPattern: a.urlPattern, mockResponse: a.mockResponse });
                }
                else if (action === "highlight_elements") {
                    resultMsg = await sendCommandToExtension("highlight_elements", {});
                }
                else if (action === "generate_artifact") {
                    const summary = a.markdownSummary || "Browser testing artifact.";
                    const artifactPath = path.join(process.cwd(), `artifact-${Date.now()}.md`);
                    fs.writeFileSync(artifactPath, `# Browser Artifact\n\n${summary}`);
                    resultMsg = `Artifact generated at ${artifactPath}`;
                }
                else {
                    throw new Error(`Unknown action type: ${action}`);
                }

                return {
                    content: [
                        { type: "text", text: typeof resultMsg === 'string' ? resultMsg : JSON.stringify(resultMsg) }
                    ]
                };
            }

            throw new Error(`Unknown tool: ${name}`);

        } catch (error: any) {
            console.error("[MCP] Error:", error);
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
}
