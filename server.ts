#!/usr/bin/env bun
/**
 * reminders-mcp — MCP server for Apple Reminders via AppleScript.
 *
 * Agents create/read/complete/delete reminders. Users see them on their iPhone
 * via iCloud shared lists. No polling, no real-time — agents write, humans read.
 *
 * Requires: macOS with Reminders.app, TCC permission for Reminders + Automation.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { execFile } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execFile)

// --- AppleScript helpers ---

async function runAppleScript(script: string): Promise<string> {
  try {
    const { stdout } = await exec('osascript', ['-e', script], { timeout: 15000 })
    return stdout.trim()
  } catch (err: any) {
    const msg = err.stderr || err.message || String(err)
    throw new Error(`AppleScript failed: ${msg}`)
  }
}

// Escape strings for AppleScript
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// Parse AppleScript date string to ISO
function parseDate(input: string): string {
  // AppleScript returns dates like "Friday, April 18, 2026 at 9:00:00 AM"
  const d = new Date(input.replace(' at ', ' '))
  return isNaN(d.getTime()) ? input : d.toISOString()
}

// --- MCP Server ---

const server = new Server(
  { name: 'reminders', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      'Apple Reminders MCP. Creates and manages reminders on the local Mac, which sync to the user\'s iPhone via iCloud shared lists.',
      '',
      'Use list_lists to see available lists. Use create_reminder to add tasks. Use list_reminders to check what\'s pending.',
      '',
      'Reminders sync to the user\'s iPhone automatically via iCloud. This is a write-heavy tool — agents create reminders, the user manages them on their phone.',
    ].join('\n'),
  },
)

// --- Tools ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_lists',
      description: 'List all Reminder lists available on this Mac.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'list_reminders',
      description: 'List reminders in a specific list. Returns incomplete reminders by default.',
      inputSchema: {
        type: 'object',
        properties: {
          list: {
            type: 'string',
            description: 'Name of the Reminders list',
          },
          include_completed: {
            type: 'boolean',
            description: 'Include completed reminders (default: false)',
          },
        },
        required: ['list'],
      },
    },
    {
      name: 'create_reminder',
      description: 'Create a new reminder in a specific list.',
      inputSchema: {
        type: 'object',
        properties: {
          list: {
            type: 'string',
            description: 'Name of the Reminders list',
          },
          title: {
            type: 'string',
            description: 'Reminder title',
          },
          notes: {
            type: 'string',
            description: 'Additional notes/details',
          },
          due_date: {
            type: 'string',
            description: 'Due date in ISO 8601 format (e.g. 2026-04-20T09:00:00)',
          },
          priority: {
            type: 'number',
            description: 'Priority: 0 = none, 1 = high, 5 = medium, 9 = low',
          },
        },
        required: ['list', 'title'],
      },
    },
    {
      name: 'complete_reminder',
      description: 'Mark a reminder as completed.',
      inputSchema: {
        type: 'object',
        properties: {
          list: {
            type: 'string',
            description: 'Name of the Reminders list',
          },
          title: {
            type: 'string',
            description: 'Title of the reminder to complete',
          },
        },
        required: ['list', 'title'],
      },
    },
    {
      name: 'delete_reminder',
      description: 'Delete a reminder permanently.',
      inputSchema: {
        type: 'object',
        properties: {
          list: {
            type: 'string',
            description: 'Name of the Reminders list',
          },
          title: {
            type: 'string',
            description: 'Title of the reminder to delete',
          },
        },
        required: ['list', 'title'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'list_lists': {
        const script = `
          tell application "Reminders"
            set output to ""
            repeat with l in every list
              set output to output & name of l & "\\n"
            end repeat
            return output
          end tell
        `
        const result = await runAppleScript(script)
        const lists = result.split('\n').filter(Boolean)
        if (lists.length === 0) {
          return { content: [{ type: 'text', text: '(no lists found)' }] }
        }
        return { content: [{ type: 'text', text: lists.map(l => `- ${l}`).join('\n') }] }
      }

      case 'list_reminders': {
        const list = esc(args.list as string)
        const includeCompleted = args.include_completed === true
        const filter = includeCompleted
          ? ''
          : 'whose completed is false'
        const script = `
          tell application "Reminders"
            set output to ""
            set theList to list "${list}"
            repeat with r in (every reminder of theList ${filter})
              set rName to name of r
              set rCompleted to completed of r
              set rPriority to priority of r
              set rBody to body of r
              try
                set rDue to due date of r as string
              on error
                set rDue to "none"
              end try
              set output to output & rName & "\\t" & rCompleted & "\\t" & rDue & "\\t" & rPriority & "\\t" & rBody & "\\n"
            end repeat
            return output
          end tell
        `
        const result = await runAppleScript(script)
        const lines = result.split('\n').filter(Boolean)
        if (lines.length === 0) {
          return { content: [{ type: 'text', text: `(no reminders in "${args.list}")` }] }
        }
        const formatted = lines.map(line => {
          const [title, completed, due, priority, ...notesParts] = line.split('\t')
          const notes = notesParts.join('\t')
          const status = completed === 'true' ? '[x]' : '[ ]'
          const dueStr = due && due !== 'none' ? ` (due: ${parseDate(due)})` : ''
          const priStr = priority && priority !== '0'
            ? ` [P${priority === '1' ? 'high' : priority === '5' ? 'med' : 'low'}]`
            : ''
          const noteStr = notes && notes !== 'missing value' ? `\n    ${notes}` : ''
          return `${status} ${title}${dueStr}${priStr}${noteStr}`
        })
        return { content: [{ type: 'text', text: formatted.join('\n') }] }
      }

      case 'create_reminder': {
        const list = esc(args.list as string)
        const title = esc(args.title as string)
        const notes = args.notes ? esc(args.notes as string) : ''
        const priority = (args.priority as number) ?? 0
        const dueDate = args.due_date as string | undefined

        let props = `{name:"${title}", body:"${notes}", priority:${priority}}`

        // Build the script with optional due date
        let script: string
        if (dueDate) {
          // Parse ISO date for AppleScript
          const d = new Date(dueDate)
          if (isNaN(d.getTime())) throw new Error(`Invalid due_date: ${dueDate}`)
          // AppleScript date format
          const asDate = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
          script = `
            tell application "Reminders"
              set dueD to date "${asDate}"
              set newR to make new reminder at end of list "${list}" with properties {name:"${title}", body:"${notes}", priority:${priority}, due date:dueD}
              return name of newR
            end tell
          `
        } else {
          script = `
            tell application "Reminders"
              set newR to make new reminder at end of list "${list}" with properties ${props}
              return name of newR
            end tell
          `
        }

        const result = await runAppleScript(script)
        return { content: [{ type: 'text', text: `created: ${result} in "${args.list}"` }] }
      }

      case 'complete_reminder': {
        const list = esc(args.list as string)
        const title = esc(args.title as string)
        const script = `
          tell application "Reminders"
            set theList to list "${list}"
            set theReminder to (first reminder of theList whose name is "${title}" and completed is false)
            set completed of theReminder to true
            return name of theReminder
          end tell
        `
        const result = await runAppleScript(script)
        return { content: [{ type: 'text', text: `completed: ${result}` }] }
      }

      case 'delete_reminder': {
        const list = esc(args.list as string)
        const title = esc(args.title as string)
        const script = `
          tell application "Reminders"
            set theList to list "${list}"
            delete (first reminder of theList whose name is "${title}")
            return "ok"
          end tell
        `
        await runAppleScript(script)
        return { content: [{ type: 'text', text: `deleted: ${title} from "${args.list}"` }] }
      }

      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }],
      isError: true,
    }
  }
})

// --- Lifecycle ---

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('reminders-mcp: shutting down\n')
  setTimeout(() => process.exit(0), 2000)
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

process.on('unhandledRejection', err => {
  process.stderr.write(`reminders-mcp: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`reminders-mcp: uncaught exception: ${err}\n`)
})

// --- Start ---

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write('reminders-mcp: server started\n')
