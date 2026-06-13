import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StartWebSocketServer, ensurePortAvailable } from "./ws-server";
import { RegisterMcpTools } from "./mcp-server";
import { getCdpClient } from "./cdp-client";

const WS_PORT = 3009;
const MODE = process.env.AETHER_MODE || "cdp"; // "cdp" or "extension"

// Graceful shutdown handler
async function shutdown() {
    console.error("\n[Server] Shutting down...");
    const client = getCdpClient();
    if (client.isConnected()) {
        console.error("[Server] Killing browser...");
        await client.killBrowser();
    }
    process.exit(0);
}

// Handle shutdown signals and crash events
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
    console.error("[Server] Uncaught Exception:", err);
    shutdown();
});
process.on("unhandledRejection", (reason, promise) => {
    console.error("[Server] Unhandled Rejection at:", promise, "reason:", reason);
    shutdown();
});
process.on("exit", () => {
    const client = getCdpClient();
    if (client.isConnected()) {
        client.disconnect();
    }
});

async function main() {
    console.error(`Starting MCP Browser Server (mode: ${MODE})...`);

    let wsServer: any = null;

    if (MODE === "extension") {
        // 1. Kill any stale server on the port
        await ensurePortAvailable(WS_PORT);

        // 2. Start WebSocket Server for Extension
        wsServer = StartWebSocketServer(WS_PORT);
        console.error("WebSocket server started for extension mode");
    } else {
        console.error("CDP mode enabled - no extension needed");
        console.error("To connect to a browser, use the 'launch_browser' or 'connect_browser' tool");
    }

    // 3. Initialize MCP Server
    const server = new Server(
        {
            name: "mcp-browser-control",
            version: "2.0.0",
        },
        {
            capabilities: {
                tools: {},
            },
        }
    );

    // 4. Register Tools
    RegisterMcpTools(server, wsServer);

    // 5. Connect Transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("MCP Server connected via Stdio");
}

main().catch((err) => {
    console.error("Fatal Error:", err);
    process.exit(1);
});
