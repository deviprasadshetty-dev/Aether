import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StartWebSocketServer, ensurePortAvailable } from "./ws-server";
import { RegisterMcpTools } from "./mcp-server";

const WS_PORT = 3009;

async function main() {
    console.error("Starting MCP Browser Server...");

    // 1. Kill any stale server on the port
    await ensurePortAvailable(WS_PORT);

    // 2. Start WebSocket Server for Extension
    const wsServer = StartWebSocketServer(WS_PORT);

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
