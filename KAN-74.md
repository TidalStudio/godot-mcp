# KAN-74: Implement basic debugger integration (breakpoints, call stack, variables)

**Status:** In Progress  
**Priority:** Low  
**Epic:** KAN-68 - Godot MCP Enhanced Debugging & Validation Tools  
**Repository:** https://github.com/Coding-Solo/godot-mcp

---

## Summary

Implement MCP tools for basic debugger integration: listing breakpoints, viewing call stack when paused, and inspecting local variables.

## Why This Matters

When debugging complex issues, Claude could help analyze program state if it could see the call stack and variable values at breakpoints. Currently requires user to manually relay this information.

---

## Tools to Implement

### 1. `get_breakpoints`

**Inputs:** none

**Output:**
```json
{
  "breakpoints": [
    {
      "script": string,
      "line": int,
      "enabled": bool
    }
  ]
}
```

---

### 2. `get_call_stack`

**Inputs:** none (only works when paused)

**Output:**
```json
{
  "paused": bool,
  "stack": [
    {
      "function": string,
      "script": string,
      "line": int
    }
  ]
}
```

---

### 3. `get_local_variables`

**Inputs:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `stack_frame` | int | optional | Stack frame index (default: 0 for current frame) |

**Output:**
```json
{
  "variables": [
    {
      "name": string,
      "type": string,
      "value": string
    }
  ]
}
```

---

## Technical Notes

- Requires EditorDebugger API access
- Only functional when game is paused at breakpoint
- Variable inspection may have depth limits for complex objects
- **This is the most complex feature** - may require significant editor plugin work

---

## Files to Touch (Coding-Solo/godot-mcp)

| Action | File | Notes |
|--------|------|-------|
| MODIFY | `scripts/godot_operations.gd` | Add debugger operations |
| CREATE | `src/tools/debugger-tools.ts` | Or add to existing tool file |
| MODIFY | `src/index.ts` | Register new tools |

> **Note:** The new MCP server uses a bundled GDScript approach where all operations go through a single `godot_operations.gd` file rather than separate addon files. The original ticket referenced `addons/godot_mcp/` paths which are no longer applicable.

---

## Acceptance Criteria

- [ ] List all breakpoints in project
- [ ] Get call stack when paused at breakpoint
- [ ] Inspect primitive local variables
- [ ] Graceful response when not paused
- [ ] Handle complex objects with reasonable depth limit

---

## Links

- **Jira Ticket:** https://tidalstudios.atlassian.net/browse/KAN-74
- **MCP Server Repo:** https://github.com/Coding-Solo/godot-mcp
