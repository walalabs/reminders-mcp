# reminders-mcp

MCP plugin exposing Apple Reminders to a Claude Code agent. Pure tool-based plugin (no channel events) — the agent calls these tools when it needs to view or modify reminders.

Used today by Mira on Luna for tracking Arshad's personal/work reminders that auto-sync to his iPhone via iCloud.

## Tools

- `list_lists()` — return all Reminders lists on the system (e.g., `Luna`, `Work`, `Home`).
- `list_reminders(list?)` — show reminders, optionally filtered to one list.
- `create_reminder(list, title, notes?, due?, priority?)` — add a reminder.
- `complete_reminder(id)` — mark a reminder done.
- `delete_reminder(id)` — remove a reminder.

The plugin wraps macOS Reminders via AppleScript / `osascript`. Tools that mutate require the macOS Automation permission to be granted to the terminal running Claude Code.

## Requirements

- macOS (Reminders.app + AppleScript)
- iCloud signed in on the host (so reminders sync to Arshad's iPhone)
- [Bun](https://bun.sh) runtime
- Full Disk Access and Automation permissions for the terminal running Claude Code

## Setup

```bash
bun install
```

### Claude Code `.mcp.json`

```json
{
  "mcpServers": {
    "reminders": {
      "type": "stdio",
      "command": "/Users/claudewala/.bun/bin/bun",
      "args": ["/Users/claudewala/luna-plugins/reminders-mcp/server.ts"],
      "alwaysLoad": true
    }
  }
}
```

No env vars needed — the plugin discovers Reminders lists at runtime.

## Scope notes

- **Luna-only** by design — iCloud Reminders is a macOS-native feature. Linux hosts (titan, ariel, dione, janus) can't access it.
- **Currently wired for Mira only.** Other luna agents could use it if their workflow needs reminder management, but it's not in their default tool surface.
- The iCloud-Reminders ↔ iPhone sync is one-way visibility — reminders created here show up on Arshad's iPhone within seconds, and vice versa.
