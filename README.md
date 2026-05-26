# tabby-agent-chat

MCP server for [Tabby](https://tabby.sh). Lets AI agents (e.g. Claude Code, Codex)
running in different Tabby tabs send each other input.

## Use case

You have several agents running in different Tabby tabs. Ask any one of them to
relay a message to another:

> Tell the agent working on the refactor that the tests are failing on master.

It calls `list_tabs`, identifies the target by the process running in each tab,
and uses `send_to_tab` to type the message into that tab's stdin.

## Install

**1. Install the plugin in Tabby.** Settings → Plugins → search "agent-chat" →
install. Restart Tabby.

**2. Add the MCP to your agent.** In any Tabby tab, run your agent and ask it:

> Install the tabby-agent-chat MCP. See $TABBY_AGENT_CHAT_INSTALL_INSTRUCTIONS

The plugin exports that env var into every shell Tabby spawns. It points at an
`INSTALL.md` shipped inside the plugin.

**3. Restart the agent session.**
