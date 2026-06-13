# Aether — AI Browser Controller

Aether is an MCP (Model Context Protocol) server that lets AI coding agents inspect and control a real browser through the Chrome DevTools Protocol (CDP). No browser extension needed.

## Install

```bash
npx aether-mcp-server
```

Or globally:

```bash
npm install -g aether-mcp-server
aether-mcp-server
```

## MCP Client Config

Add this to your MCP client (Cursor, Claude Code, Codex, KiloCode, etc.):

```json
{
  "mcpServers": {
    "aether-browser": {
      "command": "npx",
      "args": ["-y", "aether-mcp-server"]
    }
  }
}
```

If installed globally:

```json
{
  "mcpServers": {
    "aether-browser": {
      "command": "aether-mcp-server",
      "args": []
    }
  }
}
```

That's it. No cloning. No building. No absolute paths.

## What It Does

- Launches or connects to Chrome, Edge, Brave, or Firefox with remote debugging
- Exposes MCP tools for navigation, clicking, typing, form filling, screenshots, tabs, logs, cookies, network controls, PDF printing, and page inspection
- Uses native CDP input events instead of fragile DOM-only hacks
- Provides Set-of-Marks style visual element references for screenshot-based workflows
- Resolves elements by selector, text, role, accessible name, label, placeholder, XPath, coordinates, same-origin iframe content, and shadow DOM content
- Caches compact page snapshots and invalidates them on DOM/navigation/runtime events

## Browser Setup

Launch a clean browser automatically:

```
launch_browser()
```

Pick a specific browser:

```
launch_browser(browser="chrome")
launch_browser(browser="edge")
launch_browser(browser="brave")
```

Connect to an existing browser with remote debugging:

```bash
chrome --remote-debugging-port=9222
```

Then:

```
connect_browser(mode="connect", port=9222)
```

## Key Tools

- `browser_status` — connection and active tab status
- `snapshot_compact` — title, URL, readyState, and interactive element list
- `list_interactive_elements` — element refs for click/fill flows
- `click_by_ref` — click refs returned by compact snapshots
- `click_text`, `click_role`, `fill_label` — semantic actions powered by the locator engine
- `get_state` — optional screenshot, tabs, DOM snapshot, and elements
- `get_logs`, `get_network_errors` — compact debugging output
- `act` — broad compatibility action tool

## Project-Local Learning

Aether stores learned lessons and skills in `.aether/` inside your project:

```
<project>/.aether/
  memory/
    lessons.jsonl
    learned.json
  skills/
    <skill-name>/SKILL.md
    _registry.json
  memory-config.json
```

Call `configure_aether_memory` with your project root to enable it. Aether creates `.aether/` and adds it to `.gitignore`.

## Environment Variables

| Variable | Purpose |
|---|---|
| `AETHER_MODE` | `"cdp"` (default) or `"extension"` |
| `AETHER_PROJECT_ROOT` | Fallback project root for aether memory |

## Requirements

- Node.js >= 18
- Chrome, Edge, Brave, or Firefox installed locally

## Architecture

```
AI Agent / MCP Client
        |
        | stdio JSON-RPC
        v
Aether MCP Server
        |
        | Chrome DevTools Protocol
        v
Browser Target
```

## License

ISC
