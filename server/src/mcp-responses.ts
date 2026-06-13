export function textContent(text: string): { content: Array<{ type: "text"; text: string }> } {
    return { content: [{ type: "text", text }] };
}

export function jsonContent(value: unknown, pretty: boolean = false): { content: Array<{ type: "text"; text: string }> } {
    return textContent(JSON.stringify(value, null, pretty ? 2 : 0));
}

export function toolError(error: any): { content: Array<{ type: "text"; text: string }>; isError: true } {
    if (error?.captcha) {
        return { content: [{ type: "text", text: JSON.stringify(error.captcha) }], isError: true };
    }
    if (error?.message?.includes("not connected") || error?.message?.includes("No active extension")) {
        return { content: [{ type: "text", text: "Browser not connected. Use 'connect_browser' tool first to connect or launch Chrome." }], isError: true };
    }
    return { content: [{ type: "text", text: `Error: ${error?.message || String(error)}` }], isError: true };
}
