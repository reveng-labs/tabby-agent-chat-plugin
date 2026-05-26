# tabby-agent-chat — install and usage

This file ships with the Tabby plugin `tabby-agent-chat`. While the plugin
is running its path is exported as `TABBY_AGENT_CHAT_INSTALL_INSTRUCTIONS`
so any AI agent running in a Tabby tab can locate it.

## What is this

An MCP (Model Context Protocol) server that lets one AI agent (Claude
Code, Codex, etc.) send messages to other AI agents running in other
terminal tabs **of the same Tabby window**. Useful for orchestrating
multi-agent workflows.

The MCP transport is **stdio**. The agent spawns a small shim binary
(`shim.js`) which proxies JSON-RPC to a Unix socket owned by the Tabby
plugin (on Windows the same shim uses a named pipe). No ports, no
tokens, nothing to re-register when Tabby restarts.

Connection info is in these env vars (present in any shell spawned
inside Tabby after the plugin loads):

    TABBY_AGENT_CHAT_SHIM    absolute path to shim.js — the MCP command
    TABBY_AGENT_CHAT_SOCKET  the UDS / pipe path the shim connects to
    TABBY_AGENT_CHAT_TAB_ID  this tab's id (per-tab, set automatically)

`TABBY_AGENT_CHAT_SOCKET` is **per-window**: each Tabby window allocates
its own socket on startup. Tabs in window A can only talk to tabs in
window A; window B is a completely separate world. This is by design —
agents that need to talk to each other must be opened in the same window.

## Installation

Pick the command for whichever agent CLI you're using. The shim is a
plain node script; both commands register `node $TABBY_AGENT_CHAT_SHIM`
as a stdio MCP server.

### Claude Code

```
claude mcp add --transport stdio --scope user tabby-agent-chat \
  node "$TABBY_AGENT_CHAT_SHIM"
```

### Codex

```
codex mcp add tabby-agent-chat node "$TABBY_AGENT_CHAT_SHIM"
```

The shim resolves the socket path from `$TABBY_AGENT_CHAT_SOCKET` at
spawn time, so the same agent registration keeps working across Tabby
restarts and across windows — the env var follows the shell.

## Tools exposed by this MCP server

* `list_tabs` — returns every terminal tab **in the current window**.
  Each entry has:
    - `id`        stable string id for the tab — always present, use
                  with `send_to_tab` and `rename_tab`
    - `name`      the explicitly-set custom name (via Tabby's Rename
                  right-click or `rename_tab`), or `null` if no custom
                  name was set. The shell's dynamic OSC title is *not*
                  used as a fallback because it's noisy.
    - `processes` `[{pid, ppid, command, cmdline?}]` — the full process
                  tree running in the tab. `cmdline` reveals which
                  agent is running (e.g. `node …/codex`, `claude`)

* `send_to_tab(tab_id, text, [submit=true], [mode="auto"])` — inject text
  into the target tab's stdin. The receiving program cannot distinguish
  this from typed/pasted input. Target must be in the same window.
    - `mode="auto"`      (default) reads xterm.js's bracketed-paste flag
                         and wraps only when the target supports it
    - `mode="paste"`     forces bracketed-paste wrapping
    - `mode="keystrokes"` sends raw bytes for control sequences
                          (e.g. `text="\x03"` for Ctrl-C)
    - `submit=true` (default) appends `\r` so the line is "entered"

* `rename_tab(tab_id, name)` — set a tab's custom name. Names must be
  unique within the window, 1–64 chars, no control characters. Returns
  `{ok, tab_id, name}` or one of: `invalid_args`, `unknown_tab`,
  `name_in_use`, `internal`.

* `new_tab([name])` — open a new local terminal tab **in the same
  window**. Refuses to create more than 64 addressable tabs in this
  window (fork-bomb guard). Optionally sets a custom name in the same
  call.

## Typical use case

User asks one agent: "send X to the agent doing Y".

1. Agent calls `list_tabs`, inspects each tab's processes/cmdline to
   identify which tabs contain which agents.
2. To find which one is working on Y, the agent reads the target
   agent's transcript from its own on-disk store:
     - Claude Code: `~/.claude/projects/<slug>/...`
     - Codex:       `~/.codex/sessions/<id>/...`
3. Agent calls `send_to_tab(tab_id, "X")` to deliver the message.

## Limitations

- Only local terminal tabs are addressable. SSH / serial / telnet tabs
  do not expose a tab id and won't appear in `list_tabs`.
- Shells opened before the plugin loaded won't have the env vars; close
  and reopen the tab to fix.
- WSL agents (Linux agent inside a Windows host's WSL distro) cannot
  reach the Windows-side socket. Use Tabby's native Windows terminal
  for agents that need to drive MCP.
- No cross-window addressing (intentional). If you need two agents to
  message each other, put them in tabs of the same Tabby window.
