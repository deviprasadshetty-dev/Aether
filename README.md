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
cd server
npm install
npm run build
node dist/index.js
```

Most MCP clients should run the built server directly:

```json
{
  "mcpServers": {
    "aether-browser": {
      "command": "node",
      "args": ["D:/brain/reddit-bot/server/dist/index.js"]
    }
  }
}
```

Replace the path with your own absolute path if the repository lives somewhere else.

## One-Click Install

The easiest install path is a small local script. It clones or updates Aether, installs dependencies, builds the server, and prints the MCP config entry.

Windows PowerShell:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/deviprasadshetty-dev/Aether---AI-Browser-Controller/main/scripts/install.ps1)))
```

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/deviprasadshetty-dev/Aether---AI-Browser-Controller/main/scripts/install.sh | bash
```

To also write into a specific MCP config file, pass the config path.

Windows PowerShell:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/deviprasadshetty-dev/Aether---AI-Browser-Controller/main/scripts/install.ps1))) -ConfigPath "$HOME\.cursor\mcp.json"
```

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/deviprasadshetty-dev/Aether---AI-Browser-Controller/main/scripts/install.sh | bash -s -- --config-path "$HOME/.cursor/mcp.json"
```

Use the actual config path for Cursor, Claude Code, Codex, or KiloCode on your machine. The script preserves existing `mcpServers` entries and only adds or updates `aether-browser`.

### Cloudflare Workers

Cloudflare Workers are useful for hosting a one-click installer page or redirecting to the latest raw install script. They are not a good place to run Aether itself because Aether needs:

- stdio MCP transport to the local AI client
- local Node.js execution
- access to the user's local browser
- Chrome DevTools Protocol ports
- process launching for `launch_browser`
- local filesystem paths for config and profile support

A good Cloudflare Worker setup would be:

```text
install.aether.dev/windows  -> redirects to scripts/install.ps1
install.aether.dev/unix     -> redirects to scripts/install.sh
install.aether.dev          -> simple page with copy-paste commands
```

See `workers/install-redirect-worker.js` for a minimal Worker that does exactly this.

Deploy it with Wrangler:

```bash
npx wrangler deploy
```

That gives a clean one-click distribution experience while the MCP server still runs where it must run: on the user's machine.

## One-Prompt Install For Coding Agents

Paste one of these prompts into Cursor, Claude Code, Codex, or KiloCode from the machine where you want Aether installed. The agent should clone/build this MCP server and add it to that tool's MCP configuration.

### Cursor

```text
Install the Aether browser MCP server for Cursor.

1. Clone or use this repository: <AETHER_REPO_URL_OR_LOCAL_PATH>
2. In the server directory, run npm install and npm run build.
3. Add an MCP server named "aether-browser" to Cursor's MCP config.
4. Use command "node" and args ["<ABSOLUTE_PATH_TO_REPO>/server/dist/index.js"].
5. Verify the config is valid JSON and tell me the exact config file you changed.
```

### Claude Code

```text
Install the Aether browser MCP server for Claude Code.

1. Clone or use this repository: <AETHER_REPO_URL_OR_LOCAL_PATH>
2. Run npm install and npm run build inside server.
3. Add an MCP server named "aether-browser" that runs:
   node <ABSOLUTE_PATH_TO_REPO>/server/dist/index.js
4. Preserve any existing MCP servers in the config.
5. Verify by showing the final aether-browser MCP entry.
```

### Codex

```text
Install the Aether browser MCP server for Codex.

1. Clone or use this repository: <AETHER_REPO_URL_OR_LOCAL_PATH>
2. Build it with:
   cd server
   npm install
   npm run build
3. Register an MCP server named "aether-browser" with command "node" and args ["<ABSOLUTE_PATH_TO_REPO>/server/dist/index.js"].
4. Keep existing MCP configuration entries unchanged.
5. Confirm the absolute path exists and the TypeScript build succeeds.
```

### KiloCode

```text
Install the Aether browser MCP server for KiloCode.

1. Clone or use this repository: <AETHER_REPO_URL_OR_LOCAL_PATH>
2. Run npm install and npm run build in the server directory.
3. Add a KiloCode MCP entry named "aether-browser".
4. Configure it to run:
   node <ABSOLUTE_PATH_TO_REPO>/server/dist/index.js
5. Do not remove existing MCP servers. Report the changed config path and the final entry.
```

## Common MCP Config Entry

Use this entry if your MCP client accepts a JSON config:

```json
{
  "aether-browser": {
    "command": "node",
    "args": ["<ABSOLUTE_PATH_TO_REPO>/server/dist/index.js"]
  }
}
```

Some clients wrap servers under `mcpServers`:

```json
{
  "mcpServers": {
    "aether-browser": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_REPO>/server/dist/index.js"]
    }
  }
}
```

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
