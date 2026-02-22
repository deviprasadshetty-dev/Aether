import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { sendCommandToExtension } from "./ws-server";

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
                        "get_tree", "configure", "print_pdf", "emulate_network"
                    ],
                    description: "The action to perform."
                },
                selector: { type: "string", description: "CSS selector or text content to interact with." },
                elementId: { type: "number", description: "Element ID from `get_state` (preferred over selector)." },
                value: { type: "string", description: "Value to type, option to select, or URL to navigate to." },
                coordinate: { type: "string", description: "X,Y coordinates (e.g., '100,200')." },
                tabId: { type: "number", description: "Tab ID for switching/closing." },
                files: { type: "array", items: { type: "string" }, description: "Files for upload_file action" },
                modifiers: { type: "array", items: { type: "string" }, description: "Key modifiers (Ctrl, Alt, etc.)" },

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
                        let desc = `[${el.id}] ${el.tagName} "${el.text}"`;
                        if (el.type) desc += ` type=${el.type}`;
                        if (el.name) desc += ` name=${el.name}`;
                        if (el.role) desc += ` role=${el.role}`;
                        if (el.value) desc += ` value="${el.value}"`;
                        if (el.checked !== undefined) desc += ` checked=${el.checked}`;
                        if (el.selectedOption) desc += ` selected="${el.selectedOption}"`;
                        if (el.disabled) desc += ` DISABLED`;
                        if (el.required) desc += ` REQUIRED`;
                        // Add coordinates for agent awareness
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

            if (name === "act") {
                const action = a.action;
                console.error(`[MCP] Act: ${action}`, JSON.stringify(a));

                let resultMsg = "";
                const textFallback = a.selector || (a.value && isNaN(Number(a.value)) ? String(a.value) : "");

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
                    if (a.elementId) {
                        resultMsg = await sendCommandToExtension("click_element", { id: Number(a.elementId), text: textFallback });
                    } else if (a.coordinate) {
                        const [x, y] = a.coordinate.split(',').map(Number);
                        await sendCommandToExtension("click", { x, y });
                        resultMsg = `Clicked at ${x},${y}`;
                    } else {
                        throw new Error("Click requires elementId or coordinate");
                    }
                }
                else if (action === "type") {
                    await sendCommandToExtension("type", { text: a.text || a.value });
                    resultMsg = `Typed "${a.text || a.value}"`;
                }
                else if (action === "fill") {
                    if (!a.elementId) throw new Error("Fill requires elementId");
                    resultMsg = await sendCommandToExtension("fill_form", { id: Number(a.elementId), value: a.value, text: textFallback });
                }
                else if (action === "select") {
                    if (!a.elementId) throw new Error("Select requires elementId");
                    resultMsg = await sendCommandToExtension("select_option", { id: Number(a.elementId), value: a.value, text: textFallback });
                }
                else if (action === "check") {
                    if (!a.elementId) throw new Error("Check requires elementId");
                    resultMsg = await sendCommandToExtension("set_checkbox", { id: Number(a.elementId), checked: a.value === "true" || a.value === true, text: textFallback });
                }
                else if (action === "upload_file") {
                    if (!a.elementId) throw new Error("Upload requires elementId");
                    resultMsg = await sendCommandToExtension("upload_file", { id: Number(a.elementId), files: a.files, text: textFallback });
                }
                else if (action === "drag_and_drop") {
                    if (!a.elementId || !a.value) throw new Error("Drag requires elementId (source) and value (targetId)");
                    resultMsg = await sendCommandToExtension("drag_and_drop", { sourceId: Number(a.elementId), targetId: Number(a.value) });
                }
                else if (action === "hover") {
                    if (a.elementId) {
                        resultMsg = await sendCommandToExtension("hover", { id: Number(a.elementId), text: textFallback });
                    } else if (a.coordinate) {
                        const [x, y] = a.coordinate.split(',').map(Number);
                        resultMsg = await sendCommandToExtension("hover", { x, y });
                    }
                }
                else if (action === "scroll") {
                    if (a.coordinate) {
                        const [x, y] = a.coordinate.split(',').map(Number);
                        await sendCommandToExtension("scroll", { x, y });
                        resultMsg = "Scrolled";
                    }
                }

                // --- UTILS ---
                else if (action === "wait") {
                    if (a.selector) {
                        resultMsg = await sendCommandToExtension("wait_for_element", { selector: a.selector });
                    } else {
                        // Default generic wait? Or error?
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
                else if (action === "configure") {
                    const configParams = {
                        network: a.network,
                        emulation: a.emulation,
                        script: a.script
                    };
                    resultMsg = await sendCommandToExtension("configure", configParams);
                }
                else if (action === "print_pdf") {
                    // Expects optional parameters matching Page.printToPDF
                    const pdfBase64 = await sendCommandToExtension("print_pdf", { ...a });

                    if (typeof pdfBase64 === 'string') {
                        const buffer = Buffer.from(pdfBase64, 'base64');
                        const filename = `page_${Date.now()}.pdf`;
                        const fs = require('fs');
                        const path = require('path');
                        // Save to current working directory of the server
                        const filePath = path.join(process.cwd(), filename);
                        fs.writeFileSync(filePath, buffer);
                        resultMsg = `PDF saved to: ${filePath}`;
                    } else {
                        resultMsg = "Failed to generate PDF data";
                    }
                }
                else if (action === "emulate_network") {
                    // Expects offline, latency, etc.
                    resultMsg = await sendCommandToExtension("emulate_network", {
                        offline: a.offline,
                        latency: a.latency,
                        downloadThroughput: a.downloadThroughput,
                        uploadThroughput: a.uploadThroughput
                    });
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
