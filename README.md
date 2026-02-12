# ⚡ Aether — AI Browser Controller

> **Let AI agents see and control your browser with native precision.**

Aether is an MCP (Model Context Protocol) server + Chrome Extension that gives AI agents full browser control using the Chrome DevTools Protocol (CDP). It provides high-fidelity interactions — clicking, typing, scrolling, navigation — with a beautiful visual overlay that shows when the agent is in control.

---

## ✨ Features

| Feature | Description |
|---|---|
| 🎯 **Set-of-Marks** | Interactive elements are assigned unique IDs for precise clicking |
| 📸 **State Capture** | Screenshots + interactive element list in a single call |
| ⌨️ **Native Input** | CDP-powered typing and clicking — not DOM hacks |
| 🔵 **Visual Overlay** | Animated blue gradient border + "Agent Controlled" badge |
| 💫 **Click Ripples** | Blue ripple animation at click coordinates |
| 🔄 **Smart Port Reuse** | Auto-kills stale servers — no manual process management |
| 🔌 **Auto-Reconnect** | Extension reconnects automatically with exponential backoff |

---

## 🏗️ Architecture

```
┌─────────────────────┐
│   AI Agent (MCP)    │
│  (Claude, etc.)     │
└─────────┬───────────┘
          │ stdio (JSON-RPC)
┌─────────▼───────────┐
│   Aether MCP Server │
│   (Node.js + TS)    │
│   Port 3010: Health │
└─────────┬───────────┘
          │ WebSocket (Port 3009)
┌─────────▼───────────┐
│  Chrome Extension   │
│  (Service Worker)   │
│  ┌────────────────┐ │
│  │ CDP Commands   │ │
│  │ Visual Overlay │ │
│  └────────────────┘ │
└─────────────────────┘
```

---

## 🚀 Quick Start

### 1. Install & Build the Server

```bash
cd server
npm install
npm run build
```

### 2. Load the Chrome Extension

1. Open `chrome://extensions`
2. Enable **Developer Mode**
3. Click **Load Unpacked** → select the `extension/` folder
4. You should see **"Aether — AI Browser Controller"** appear

### 3. Configure Your MCP Client

Add to your MCP client config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "browser-control": {
      "command": "node",
      "args": ["<path-to-project>/server/dist/index.js"]
    }
  }
}
```

### 4. Use It

The AI agent now has access to these tools:

---

## 🛠️ MCP Tools

| Tool | Description | Parameters |
|---|---|---|
| `navigate` | Navigate to a URL | `url: string` |
| `get_state` | Get screenshot + interactive elements | — |
| `click` | Click at coordinates | `x: number, y: number` |
| `click_element` | Click element by ID (preferred) | `id: number` |
| `type` | Type text with native key events | `text: string` |
| `scroll` | Scroll the page | `x: number, y: number` |
| `evaluate` | Execute JavaScript in the page | `script: string` |

### Example Workflow

```
1. navigate("https://google.com")
2. get_state()             → returns screenshot + elements with IDs
3. click_element(3)        → clicks the search input (ID 3)
4. type("AI browser control")
5. click_element(4)        → clicks the search button
```

---

## 🎨 Visual Overlay

When the agent controls the browser, Aether displays:

- **Animated blue gradient border** (blue → purple → cyan)
- **"⚡ Agent Controlled" badge** in the top-right corner
- **Click ripple** — blue expanding circle at click coordinates
- **Typing indicator** — cursor animation near the active input

The overlay auto-hides 3 seconds after the last command.

---

## 🔧 Smart Port Management

Aether solves the "stale server" problem:

1. On startup, checks if port 3009 is already in use
2. Sends an HTTP shutdown request to the existing server (`localhost:3010/shutdown`)
3. Waits for it to exit, then starts fresh
4. No more manual `taskkill` or port conflicts

The health endpoint is available at `http://localhost:3010/health`.

---

## 📁 Project Structure

```
aether/
├── extension/               # Chrome Extension (Manifest V3)
│   ├── manifest.json        # Extension config
│   ├── background.js        # Service worker — WebSocket + CDP
│   ├── content.js           # Visual overlay injection
│   ├── popup.html           # Extension popup UI
│   └── popup.js             # Popup logic
├── server/                  # MCP Server (TypeScript)
│   ├── src/
│   │   ├── index.ts         # Entry point
│   │   ├── mcp-server.ts    # MCP tool definitions
│   │   └── ws-server.ts     # WebSocket + health endpoint
│   ├── package.json
│   └── tsconfig.json
└── .gitignore
```

---

## 🐛 Troubleshooting

| Problem | Solution |
|---|---|
| `No active extension connection` | Reload the extension at `chrome://extensions` |
| `Context server request timeout` | Kill stale node processes: `tasklist \| findstr node` → `taskkill /PID <pid> /F` |
| Extension shows "Disconnected" | Check if the server is running: `netstat -ano \| findstr :3009` |
| `No tabs found` | Make sure Chrome has at least one open tab |

---

## 📄 License

MIT
