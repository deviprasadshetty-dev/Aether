# Aether - AI Browser Controller

Aether is a Model Context Protocol (MCP) server that lets AI coding agents inspect and control a real browser through the Chrome DevTools Protocol (CDP). It is built for fast, accurate browser automation without requiring a browser extension.

## What It Does

- Launches or connects to Chrome, Edge, Brave, or Firefox with remote debugging.
- Exposes MCP tools for navigation, clicking, typing, form filling, screenshots, tabs, logs, cookies, network controls, PDF printing, and page inspection.
- Uses native CDP input events instead of fragile DOM-only hacks.
- Provides Set-of-Marks style visual element references for screenshot-based workflows.
- Resolves elements by selector, text, role, accessible name, label, placeholder, XPath, coordinates, same-origin iframe content, and shadow DOM content.
- Caches compact page snapshots and invalidates them on DOM/navigation/runtime events for faster repeated actions.

## Quick Start

```bash
npx -y aether-mcp-server
```

Or install globally:

```bash
npm install -g aether-mcp-server
aether-mcp-server
```

### MCP Client Config

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

### CLI Config Fields

Some clients ask for command and arguments separately:

| Field | Value |
|---|---|
| **Command** | `npx` |
| **Arguments** | `-y aether-mcp-server` |

### Install from source

If you prefer to build from source:

```bash
git clone https://github.com/deviprasadshetty-dev/Aether.git
cd Aether/server
npm install
npm run build
node dist/index.js
```

Then configure your MCP client with the absolute path to `dist/index.js`.

## Browser Setup

Aether can launch a clean browser automatically:

```text
launch_browser()
```

You can also choose a browser:

```text
launch_browser(browser="chrome")
launch_browser(browser="edge")
launch_browser(browser="brave")
```

To connect to an existing browser, start it with remote debugging enabled:

```bash
chrome --remote-debugging-port=9222
```

Then call:

```text
connect_browser(mode="connect", port=9222)
```

## Useful Tools

- `browser_status` - compact connection and active-tab status.
- `snapshot_compact` - fast title, URL, readyState, and interactive element list.
- `list_interactive_elements` - element refs for click/fill flows.
- `click_by_ref` - click refs returned by compact snapshots.
- `click_text`, `click_role`, `fill_label` - semantic actions powered by the locator engine.
- `get_state` - optional screenshot, tabs, DOM snapshot, and elements.
- `get_logs`, `get_network_errors` - compact debugging output.
- `act` - broad compatibility action tool for older flows.

## Architecture

```text
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

The server is in `server/src`. The main layers are:

- `index.ts` - starts the MCP server.
- `mcp-server.ts` - registers MCP tools and routes requests.
- `mcp-task-memory.ts` - stores task graph/session history.
- `aether-memory-store.ts` - stores project-local learned lessons and Claude-style `SKILL.md` procedures under `.aether`.
- `mcp-responses.ts` - formats MCP text, JSON, and error responses.
- `cdp-bridge.ts` - maps MCP-style actions to browser operations.
- `cdp-client.ts` - low-level CDP connection, events, and native input.
- `locator-engine.ts` - ranked locator resolution across DOM, shadow DOM, and same-origin frames.
- `page-snapshot-cache.ts` - cached compact snapshots with CDP invalidation hooks.

## Project-Local Learning

Aether can keep lightweight learning inside the project where it is being used:

```text
<project>/.aether/
  memory/
    lessons.jsonl
    learned.json
  skills/
    <skill-name>/SKILL.md
    _registry.json
  memory-config.json
```

Call `configure_aether_memory` with the project root before using learning tools. Aether creates `.aether/` and adds it to `.gitignore` by default, so learned automation notes stay local unless the user deliberately shares them.

The learning layer stores distilled improvements only, not raw browsing logs, screenshots, cookies, form values, or full DOM dumps.

Create a lesson or skill when:

- A complex task succeeded.
- An error was overcome.
- A user-corrected approach worked.
- A non-trivial workflow was discovered.
- The user asks Aether to remember a procedure.

Maintain skills with:

- `keep` when the skill is still valuable.
- `patch` when instructions are outdated or broken.
- `consolidate` when near-duplicates should become one umbrella skill.
- `prune` when a skill is truly stale.

Lessons are capped by `memory-config.json` and compacted into `memory/learned.json`, keeping the project memory small and useful as Aether gets better over time.

## Development

```bash
cd server
npm install
npm run build
npm run start
```

The build command runs TypeScript:

```bash
npm run build
```

## Notes

- Cross-origin iframe contents are protected by browser security rules. Aether can still click by viewport coordinates when an element is visible, but semantic inspection inside cross-origin frames is limited.
- Shadow DOM and same-origin iframe support is available through the locator engine for semantic actions and compact snapshots.
- CAPTCHA detection is exposed as a safeguard. Be careful with automation on sites where interaction is restricted by terms of service.

## License

ISC
