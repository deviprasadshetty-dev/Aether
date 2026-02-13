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
| 🛡️ **Network Control** | Block ads, images, and trackers for 10x speed |
| 📱 **Mobile Emulation** | Simulate iPhone/Android viewports and user agents |
| 💉 **Script Injection** | Inject stealth scripts before page load |
| 🧠 **Accessibility Tree** | Semantic page view for better agent understanding |

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
└─── Network/Fetch ───┘
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

Aether simplifies browser automation into a single, intuitive interface for your AI agent.

### ⚡ The `act` Tool
One tool to rule them all. Instead of juggling 20 different tool definitions, Aether provides a unified `act()` capability that handles:

*   **Navigation**: Go to any URL.
*   **Interaction**: Click, type, scroll, and drag with human-like input.
*   **State Analysis**: Retrieve screenshots, accessibility trees, and logs in one go.
*   **Tab Management**: Create, switch, and close tabs effortlessly.

---

## ⚡ Advanced Capabilities

### 🛡️ Active Network Control
Block ads, trackers, and heavy media to speed up automation 10x. Aether lets you define exactly what resources to load.

### 📱 Device Emulation & Stealth
Impersonate mobile devices (iPhone/Android) or modify your User Agent to access simplified layouts and avoid detection.

### 🧠 Deep Accessibility Understanding
Unlike basic HTML dumps, Aether reads the browser's internal Accessibility Tree to understand the *semantics* of a page—just like a screen reader, but for AI.

### 💉 Script Injection
Inject custom JavaScript *before* page load to modify the environment or add helper functions seamlessly.

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
