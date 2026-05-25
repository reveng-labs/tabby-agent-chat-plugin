# tabby-agent-chat — install and usage

This file ships with the Tabby plugin `tabby-agent-chat`. While the plugin
is running, its path is exported as `TABBY_AGENT_CHAT_INSTALL_INSTRUCTIONS`
so any AI agent running in a Tabby tab can locate it.

## What is this

An MCP (Model Context Protocol) server that lets one AI agent (Claude
Code, Codex, etc.) send messages to other AI agents running in other
terminal tabs of the same Tabby window. Useful for orchestrating
multi-agent workflows.

The server is HTTP, bound to 127.0.0.1 only, auth via a per-window
bearer token. Connection info is in these env vars (present in any
shell spawned inside Tabby after the plugin loads):

    TABBY_AGENT_CHAT_URL    full http://127.0.0.1:PORT/mcp URL
    TABBY_AGENT_CHAT_TOKEN  bearer token

## Installation

Run the command for whichever agent CLI you're using. Both commands use
`${VAR}` so the connection info is resolved by the agent itself at
connect time — not baked into the config file. This means the same
config keeps working across Tabby restarts (the port and token change
each run).

### Claude Code

```
claude mcp add --transport http --scope user tabby-agent-chat \
  '${TABBY_AGENT_CHAT_URL}' \
  --header 'Authorization: Bearer ${TABBY_AGENT_CHAT_TOKEN}'
```

### Codex

```
codex mcp add tabby-agent-chat \
  --url "$TABBY_AGENT_CHAT_URL" \
  --bearer-token-env-var TABBY_AGENT_CHAT_TOKEN
```

NOTE: Codex stores `--url` as a literal value; on Tabby restart the URL
goes stale (new port). Re-run the command after each Tabby restart, or
edit `~/.codex/config.toml` to use a stable port if you want a one-time
setup. Token rotation is handled because `--bearer-token-env-var` is read
at runtime.

## Tools exposed by this MCP server

* `list_tabs` — returns every terminal tab in the current Tabby window.
  Each entry has:
    - `id`        stable string id for the tab (use with `send_to_tab`
                  and `rename_tab`)
    - `name`      what the user sees on the tab header: the custom name
                  if one was set (via Tabby's Rename or `rename_tab`),
                  otherwise the auto-title derived from the shell
    - `processes` `[{pid, ppid, command, cmdline?}]` — the full process
                  tree running in the tab. `cmdline` reveals which
                  agent is running (e.g. `node …/codex`, `claude`)

* `send_to_tab(tab_id, text, [submit=true], [mode="auto"])` — inject text
  into the target tab's stdin. The receiving program cannot distinguish
  this from typed/pasted input.
    - `mode="auto"`      (default) reads xterm.js's bracketed-paste flag
                         and wraps only when the target supports it
    - `mode="paste"`     forces bracketed-paste wrapping
    - `mode="keystrokes"` sends raw bytes for control sequences
                          (e.g. `text="\x03"` for Ctrl-C)
    - `submit=true` (default) appends `\r` so the line is "entered"

* `rename_tab(tab_id, name)` — set a tab's custom name. Names must be
  unique among addressable tabs, 1–64 chars, no control characters.
  Returns `{ok, tab_id, name}` or one of the error codes:
  `invalid_args`, `unknown_tab`, `name_in_use`, `internal`.

* `new_tab([name])` — open a new local terminal tab in this window.
  Refuses to create more than 64 addressable tabs (fork-bomb guard).
  Optionally sets a custom name in the same call. Returns
  `{ok, tab_id, name?}` once the new tab has a stable id, or one of:
  `too_many_tabs`, `name_in_use`, `no_local_profile`, `open_failed`,
  `register_timeout`, `internal`.

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
- Each Tabby window runs its own MCP server. Cross-window messaging is
  not supported.
- Shells opened before the plugin loaded won't have the env vars; close
  and reopen the tab to fix.
