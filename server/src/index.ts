import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RegisterMcpTools } from "./mcp-server";
import { getCdpClient } from "./cdp-client";
import { createLogger } from "./logger";

const log = createLogger("index");

// Graceful shutdown handler
async function shutdown() {
    log.info("Shutting down...");
    const client = getCdpClient();
    if (client.isConnected()) {
        log.info("Killing browser...");
        await client.killBrowser();
    }
    process.exit(0);
}

// Handle shutdown signals and crash events
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
    log.error("Uncaught Exception", { error: String(err) });
    shutdown();
});
process.on("unhandledRejection", (reason, promise) => {
    log.error("Unhandled Rejection", { reason: String(reason) });
    shutdown();
});
process.on("exit", () => {
    const client = getCdpClient();
    if (client.isConnected()) {
        client.disconnect();
    }
});

async function main() {
    log.info("Starting Aether MCP Browser Server (CDP mode — no extension needed)...");
    log.info("Use 'launch_browser' or 'connect_browser' tool to connect to a browser.");

    // Initialize MCP Server
    const server = new Server(
        {
            name: "aether-mcp-server",
            version: "2.1.0",
        },
        {
            capabilities: {
                tools: {},
            },
        }
    );

    // Register Tools
    RegisterMcpTools(server);

    // Connect Transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("MCP Server connected via Stdio. Ready.");
}

main().catch((err) => {
    log.error("Fatal Error", { error: String(err) });
    process.exit(1);
});
