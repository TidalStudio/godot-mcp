# Godot MCP Development Workflow

This document explains how to make changes to the Godot MCP server and test them in Claude Code.

## Prerequisites

- Node.js installed
- Godot 4.x installed (note the path to the executable)
- Claude Code installed

## Project Structure

```
godot-mcp/
├── src/
│   └── index.ts          # Main MCP server source code
├── build/
│   └── index.js          # Compiled output (generated)
├── scripts/
│   └── godot_operations.gd  # GDScript operations file
├── package.json
└── tsconfig.json
```

## Development Workflow

### 1. Make Code Changes

Edit the TypeScript source files in `src/`. The main server logic is in `src/index.ts`.

### 2. Build the Project

After making changes, compile the TypeScript:

```bash
npm run build
```

This will:
- Compile TypeScript files from `src/` to `build/`
- Copy `godot_operations.gd` to `build/scripts/`

### 3. Configure Claude Code to Use Local Build

You need to tell Claude Code where to find the MCP server and Godot executable.

#### Option A: Project-Level Configuration (Recommended)

Edit `~/.claude.json` and add/update the project entry:

```json
{
  "projects": {
    "C:\\Users\\<username>\\Documents\\godot projects": {
      "mcpServers": {
        "godot": {
          "type": "stdio",
          "command": "node",
          "args": [
            "C:\\Users\\<username>\\Documents\\GitHub\\godot-mcp\\build\\index.js"
          ],
          "env": {
            "GODOT_PATH": "C:\\Users\\<username>\\Desktop\\Godot_v4.5.1-stable_win64.exe"
          }
        }
      }
    }
  }
}
```

#### Option B: Claude Desktop Global Configuration

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "godot-mcp": {
      "command": "node",
      "args": ["C:\\Users\\<username>\\Documents\\GitHub\\godot-mcp\\build\\index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "GODOT_PATH": "C:\\Users\\<username>\\Desktop\\Godot_v4.5.1-stable_win64.exe"
      }
    }
  }
}
```

### 4. Restart Claude Code

After building and configuring, restart Claude Code to load the updated MCP server:

- **CLI**: Exit and re-run `claude`
- **VS Code Extension**: Reload the window or restart VS Code
- **Claude Desktop**: Fully quit and restart the application

### 5. Verify the MCP Server is Running

In Claude Code, you can check MCP server status:

```
/mcp
```

Or run diagnostics:

```
/doctor
```

## Quick Development Loop

For rapid iteration:

```bash
# 1. Make changes to src/index.ts
# 2. Build
npm run build

# 3. Restart Claude Code (or reload MCP connection)
# 4. Test your changes
```

## Common Configuration Issues

### Windows `npx` Commands

On Windows, MCP servers using `npx` need the `cmd /c` wrapper:

```json
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "@some/mcp-package"]
}
```

### Godot Path Not Found

Set the `GODOT_PATH` environment variable in the MCP server config to point to your Godot executable.

### Changes Not Appearing

1. Ensure `npm run build` completed successfully
2. Verify the config points to `build/index.js` (not `src/index.ts`)
3. Fully restart Claude Code (not just reload)

## Testing New Tools

### Example: Testing `get_runtime_errors`

1. Create a test Godot project with a script that generates errors:

```gdscript
# error_generator.gd
extends Node

func _ready():
    push_error("Test error message")
    push_warning("Test warning message")
```

2. Use the MCP tools:
   - `run_project` - Start the Godot project
   - `get_runtime_errors` - Capture errors from stderr
   - `stop_project` - Stop the running project

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GODOT_PATH` | Path to Godot executable |
| `MCP_TRANSPORT` | Transport type (usually `stdio`) |
| `DEBUG` | Set to `true` for debug logging |

## File Locations Summary

| File | Purpose |
|------|---------|
| `~/.claude.json` | Claude Code project-level settings |
| `%APPDATA%\Claude\claude_desktop_config.json` | Claude Desktop global MCP config |
| `godot-mcp/build/index.js` | Compiled MCP server entry point |
| `godot-mcp/src/index.ts` | Source code to edit |
