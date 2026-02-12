import { WebSocketServer, WebSocket } from "ws";
import http from "http";

export let activeConnection: WebSocket | null = null;
let messageIdCounter = 0;
const pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

const HEALTH_PORT_OFFSET = 1; // Health endpoint runs on WS_PORT + 1

/**
 * Ensure port is available by killing any stale server
 */
export async function ensurePortAvailable(port: number): Promise<void> {
    return new Promise((resolve) => {
        // Try to connect to the health endpoint of an existing server
        const healthPort = port + HEALTH_PORT_OFFSET;
        const req = http.get(`http://localhost:${healthPort}/shutdown`, (res) => {
            console.error(`[WS] Sent shutdown to existing server on port ${port}`);
            // Wait for it to die
            setTimeout(resolve, 1500);
        });
        req.on("error", () => {
            // No existing server — port is free or ghost-locked
            resolve();
        });
        req.setTimeout(2000, () => {
            req.destroy();
            resolve();
        });
    });
}

export function StartWebSocketServer(port: number) {
    const wss = new WebSocketServer({ port });

    // --- Health / Shutdown HTTP server ---
    const healthPort = port + HEALTH_PORT_OFFSET;
    const healthServer = http.createServer((req, res) => {
        if (req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                status: "ok",
                connected: activeConnection !== null,
                pid: process.pid,
            }));
        } else if (req.url === "/shutdown") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("shutting down");
            console.error("[WS] Received shutdown request. Exiting...");
            setTimeout(() => process.exit(0), 500);
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    healthServer.listen(healthPort, () => {
        console.error(`[WS] Health endpoint on port ${healthPort}`);
    });
    healthServer.on("error", (err: any) => {
        console.error(`[WS] Health server error: ${err.message}`);
    });

    // --- WebSocket Server ---
    wss.on("error", (err: any) => {
        if (err.code === "EADDRINUSE") {
            console.error(`[WS] Port ${port} in use. Will retry after shutdown...`);
            setTimeout(() => {
                wss.close();
                StartWebSocketServer(port);
            }, 2000);
        } else {
            console.error("[WS] Server error:", err.message);
        }
    });

    wss.on("listening", () => {
        console.error(`[WS] WebSocket Server listening on port ${port}`);
    });

    wss.on("connection", (ws) => {
        console.error("[WS] Extension connected");
        activeConnection = ws;

        ws.on("message", (data) => {
            try {
                const message = JSON.parse(data.toString());
                if (message.id !== undefined && pendingRequests.has(message.id)) {
                    const { resolve, reject } = pendingRequests.get(message.id)!;
                    if (message.error) {
                        reject(new Error(message.error));
                    } else {
                        resolve(message.result);
                    }
                    pendingRequests.delete(message.id);
                } else if (message.method === "ping") {
                    // Heartbeat — ignore
                }
            } catch (err) {
                console.error("[WS] Parse error:", err);
            }
        });

        ws.on("close", () => {
            console.error("[WS] Extension disconnected");
            if (activeConnection === ws) {
                activeConnection = null;
            }
            for (const [id, { reject }] of pendingRequests) {
                reject(new Error("Extension disconnected"));
            }
            pendingRequests.clear();
        });

        ws.on("error", (err) => {
            console.error("[WS] Connection error:", err.message);
        });
    });

    return wss;
}

export function sendCommandToExtension(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
        if (!activeConnection || activeConnection.readyState !== WebSocket.OPEN) {
            return reject(new Error("No active extension connection"));
        }

        const id = ++messageIdCounter;
        const timeout = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error(`Command '${method}' timed out after 30s`));
        }, 30000);

        pendingRequests.set(id, {
            resolve: (val) => { clearTimeout(timeout); resolve(val); },
            reject: (err) => { clearTimeout(timeout); reject(err); },
        });

        activeConnection.send(JSON.stringify({ id, method, params }));
    });
}
