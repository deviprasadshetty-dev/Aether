# ⚡ Aether — AI Browser Controller

> **Let AI agents see and control your browser with native precision — no extension needed.**

Aether is a high-performance MCP (Model Context Protocol) server that gives AI agents full browser control using the Chrome DevTools Protocol (CDP). It provides high-fidelity interactions — clicking, typing, scrolling, navigation — with a beautiful visual overlay that shows when the agent is in control.

**New in v2.0:** Extension-less CDP mode with auto-detection for Chrome, Edge, Brave, and Firefox.

---

## ✨ Features

| Feature | Description |
|---|---|
| 🎯 **Set-of-Marks** | Interactive elements are assigned unique IDs for precise clicking |
| 🛡️ **Self-Healing** | Fuzzy text matching + DOM re-scanning if element IDs shift |
| 📸 **State Capture** | Screenshots, interactive elements, open tabs, and logs in one call |
| ⌨️ **Native Input** | CDP-powered typing and clicking — not DOM hacks |
| 🗺️ **Task Constellation** | UFO3-style hierarchical task tracking for complex flows |
| 🤖 **Computer Use API** | Native support for Anthropic's zero-shot coordinate control |
| ⌨️ **Special Keys** | Full support for Enter, Tab, Backspace, Arrows, and Modifiers |
| 🔵 **Visual Overlay** | Animated blue gradient border + "Agent Controlled" badge |
| 💫 **Click Ripples** | Blue ripple animation at click coordinates |
| 🛡️ **Network Control** | Block ads, images, and trackers or mock specific API calls |
| 📱 **Mobile Emulation** | Simulate iPhone/Android viewports and user agents |
| 🧠 **Accessibility Tree** | Semantic page view for better agent understanding |
| 🚀 **No Extension** | Direct CDP connection — no service worker issues |
| 🌐 **Multi-Browser** | Auto-detects Chrome, Edge, Brave, Firefox |

---

## 🏗️ Architecture

### CDP Mode (Default — No Extension)
```
┌─────────────────────┐
│   AI Agent (MCP)    │
│  (Claude, etc.)     │
└─────────┬───────────┘
          │ stdio (JSON-RPC)
┌─────────▼───────────┐
│   Aether MCP Server │
│   (Node.js + TS)    │
└─────────┬───────────┘
          │ CDP (direct connection)
┌─────────▼───────────┐
│   Browser (Chrome,  │
│   Edge, Brave, FF)  │
│  ┌────────────────┐ │
│  │ CDP Protocol   │ │
│  │ DOM + Input    │ │
│  └────────────────┘ │
└─────────────────────┘
```

### Extension Mode (Legacy)
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

### 2. Configure Your MCP Client

Add to your MCP client config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "aether-browser": {
      "command": "node",
      "args": ["<path-to-project>/server/dist/index.js"]
    }
  }
}
```

### 3. Launch a Browser (No Manual Setup Needed!)

Aether auto-detects and launches available browsers:

```
# In your AI agent, use these tools:
list_browsers()                    # See available browsers
launch_browser()                    # Auto-detect & launch
launch_browser(browser="chrome")   # Specify browser
launch_browser(browser="edge")      # Use Microsoft Edge
launch_browser(browser="brave")    # Use Brave
launch_browser(browser="firefox")   # Use Firefox
kill_browser()                     # Kill when done
```

Or connect to an existing browser:
```bash
# Launch browser manually with remote debugging:
chrome --remote-debugging-port=9222
# Then let Aether connect automatically
```

---

## ❓ Why Aether vs. Generic CDP MCPs?

While generic CDP MCP servers exist, they are often just raw protocol wrappers. **Aether is an opinionated Agentic Driver.** We didn't just copy the protocol; we built a high-agency layer on top of it.

| Feature | Aether | Generic CDP |
|---|---|---|
| 👁️ **Visual Grounding** | **Set-of-Marks (SoM)** overlay for zero-shot accuracy | Raw DOM nodes only |
| 🎞️ **Video Understanding** | **Real-time Screencasting** with "Critical Frame" tagging | Static screenshots only |
| 🛡️ **Self-Healing** | Fuzzy matching + DOM re-scanning on ID shifts | Fails if selector changes |
| 🗺️ **Task Memory** | **UFO3 Task Constellation** (hierarchical graphs) | Stateless actions |
| 🤖 **Computer Use** | Native Anthropic `computer_20241022` implementation | Not supported |
| 🕵️ **Stealth** | Automatic `navigator.webdriver` & detection bypass | Transparent bot signature |
| 🚀 **No Extension** | Direct CDP — no service worker issues | Often requires setup |
| 🌐 **Multi-Browser** | Auto-detects Chrome, Edge, Brave, Firefox | Usually Chrome-only |

---

## ⚡ Unique "Super-Agent" Capabilities

### 📽️ Real-Time Video & Screencasting
Unlike other tools that only take static snapshots, Aether can `start_screencast` to stream frames back to the agent. More importantly, it uses **Event-Based Criticality Tagging**: it automatically flags frames that occur within 1 second of an error, click, or navigation, allowing the agent to "rewind" and understand *why* a failure happened in motion.

### 🎯 Set-of-Marks (SoM) Grounding
Aether injects a visual "Set-of-Marks" (inspired by Microsoft Research) directly into the screenshot. Every interactive element gets a numbered badge (e.g., `@12`). The agent sees the badge in the image and can click `@12` directly, bypassing the need to parse thousands of lines of volatile HTML.

### 🗺️ UFO3 Task Constellation
Every action in Aether is part of a hierarchical graph. By passing a `parentId`, agents can build "Task Constellations." If a complex flow (like a multi-page checkout) fails at step 5, the agent can call `get_task_graph` to see exactly where the logic branched and recover with context.

### 🧠 Native Computer Use Support
Aether is one of the first MCP servers to natively support the Anthropic Computer Use API schema. You can use coordinate-based mouse movements and native key-events just like a human, making it compatible with models trained for zero-shot OS control.

### ⚡ The `act` Tool
A unified capability for browser manipulation and inspection:

*   **Navigation**: `navigate`, `new_tab`, `switch_tab`, `close_tab`.
*   **Interaction**: `click`, `type`, `fill`, `select`, `check`, `hover`, `scroll`, `drag_and_drop`.
*   **Verification**: `verify_ui_state` (checks visibility/text), `assert` (built-in testing logic).
*   **CDP Power**: `emulate_network`, `set_geolocation`, `set_timezone`, `print_pdf`.
*   **Debugging**: `get_logs` (console + network), `get_tree` (Accessibility Tree), `get_performance_metrics`.
*   **Advanced**: `mock_network_request`, `upload_file`, `screenshot_region`, `start_screencast`.

### 📸 The `get_state` Tool
The primary way agents "see" the page. Returns:
- **Screenshot**: High-quality JPEG of the active viewport.
- **Interactive Elements**: A list of clickable/typable elements with unique IDs (e.g., `@5`).
- **Open Tabs**: List of all browser tabs with titles and active status.
- **Console Logs**: Recent logs and network errors for debugging.

### 🗺️ The `get_task_graph` Tool
Retrieves the **UFO3 Task Constellation** — a hierarchical record of every action taken in the session, allowing agents to understand their own history and recover from complex failures.

### 🤖 The `computer_20241022` Tool
An implementation of Anthropic's **Computer Use API**. Allows the agent to use coordinate-based mouse moves, clicks, and drags, as well as native keyboard events (`key`, `type`).

---

## ⚡ Advanced Capabilities

### 🛡️ Set-of-Marks & Self-Healing
Aether assigns every interactive element a temporary ID (Set-of-Marks). If an element shifts or the ID becomes stale, Aether automatically performs fuzzy text matching and DOM re-scanning to find the element again before the agent even notices.

### 💉 Stealth & Bot Detection Bypass
Aether injects stealth scripts into every page to disable `navigator.webdriver` and other common bot-detection signals. It uses native CDP events which are harder to detect than DOM-based automation.

### 🌐 Network Mocking & Control
Agents can use `mock_network_request` to intercept and replace API responses. This is invaluable for bypassing paywalls, testing edge cases, or simulating backend data without making real requests.

### 🧠 Semantic Understanding
By exposing the **Accessibility Tree**, Aether allows agents to see the page's structure as a collection of roles (buttons, links, headings) rather than a mess of `<div>` tags.

---

## 🎨 Visual Overlay

When the agent controls the browser, Aether displays:
- **Animated blue gradient border** (blue → purple → cyan)
- **"⚡ Agent Controlled" badge** in the top-right corner
- **Click ripple** — blue expanding circle at click coordinates
- **Typing indicator** — visual feedback when the agent is typing

The overlay auto-hides 3 seconds after the last command to keep the UI clean.

---

## 🔧 Smart Port Management

Aether solves the "stale server" problem:
1. On startup, checks if port 3009 is already in use.
2. Sends an HTTP shutdown request to the existing server (`localhost:3010/shutdown`).
3. Waits for it to exit, then starts fresh.
4. The health endpoint is available at `http://localhost:3010/health`.

---

## 📄 License

MIT
