import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { sendCommandToExtension } from "./ws-server";

const Tools = [
    {
        name: "navigate",
        description: "Navigate the browser to a specific URL",
        inputSchema: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
        },
    },
    {
        name: "get_state",
        description: "Get the current state (URL, Title, Screenshot, Interactive Elements with IDs)",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "click",
        description: "Click at specific coordinates (Fallback)",
        inputSchema: {
            type: "object",
            properties: { x: { type: "number" }, y: { type: "number" } },
            required: ["x", "y"],
        },
    },
    {
        name: "click_element",
        description: "Click an element by its ID (Preferred). Use get_state to find IDs.",
        inputSchema: {
            type: "object",
            properties: { id: { type: "number" } },
            required: ["id"],
        },
    },
    {
        name: "type",
        description: "Type text into the browser",
        inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
        },
    },
    {
        name: "scroll",
        description: "Scroll to specific coordinates",
        inputSchema: {
            type: "object",
            properties: { x: { type: "number" }, y: { type: "number" } },
            required: ["x", "y"],
        },
    },
    {
        name: "evaluate",
        description: "Execute JavaScript in the browser",
        inputSchema: {
            type: "object",
            properties: { script: { type: "string" } },
            required: ["script"],
        },
    },
];

export function RegisterMcpTools(server: Server, wsServer: any) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Tools }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        try {
            if (name === "navigate") {
                console.error(`[MCP] Navigating to ${args?.url}`);
                await sendCommandToExtension("navigate", { url: String(args?.url) });
                return { content: [{ type: "text", text: `Navigated to ${args?.url}` }] };
            }

            if (name === "get_state") {
                console.error("[MCP] Requesting state...");
                const result = await sendCommandToExtension("get_state", {});
                console.error("[MCP] State received. Keys:", result ? Object.keys(result) : "null");

                if (!result) throw new Error("Received empty state from extension");

                const elementsSummary = result.interactiveElements
                    ? result.interactiveElements.map((el: any) => `[${el.id}] ${el.tagName} "${el.text}"`).join("\n")
                    : "No elements found";

                return {
                    content: [
                        { type: "text", text: `Title: ${result.title}\nURL: ${result.url}\n\nInteractive Elements:\n${elementsSummary}` },
                        { type: "image", data: result.screenshot, mimeType: "image/jpeg" }
                    ],
                };
            }

            if (name === "click") {
                await sendCommandToExtension("click", { x: Number(args?.x), y: Number(args?.y) });
                return { content: [{ type: "text", text: `Clicked ${args?.x}, ${args?.y}` }] };
            }

            if (name === "click_element") {
                const msg = await sendCommandToExtension("click_element", { id: Number(args?.id) });
                return { content: [{ type: "text", text: msg }] };
            }

            if (name === "type") {
                await sendCommandToExtension("type", { text: String(args?.text) });
                return { content: [{ type: "text", text: `Typed: "${args?.text}"` }] };
            }

            if (name === "scroll") {
                await sendCommandToExtension("scroll", { x: Number(args?.x), y: Number(args?.y) });
                return { content: [{ type: "text", text: `Scrolled` }] };
            }

            if (name === "evaluate") {
                const result = await sendCommandToExtension("evaluate", { script: String(args?.script) });
                return { content: [{ type: "text", text: `Result: ${JSON.stringify(result)}` }] };
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
