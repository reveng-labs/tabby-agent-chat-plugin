#!/usr/bin/env python3
"""send.py — quick test helper for sending text or raw bytes to a Tabby tab.

Usage:
  send.py text TAB "echo hi"          # text + Enter (bracketed paste)
  send.py keys TAB $'\x03'             # raw keystrokes, no Enter
  send.py keys-sub TAB "ls"           # raw keystrokes + Enter
"""
import json, os, sys, urllib.request

cfg = json.load(open(os.path.expanduser("~/.config/tabby/agent-chat.json")))
PORT, TOKEN = cfg["port"], cfg["token"]

mode_map = {
    "text":     {"mode": "auto",       "submit": True},  # let plugin pick
    "paste":    {"mode": "paste",      "submit": True},  # force wrap
    "keys":     {"mode": "keystrokes", "submit": False},
    "keys-sub": {"mode": "keystrokes", "submit": True},
}

cmd, tab, payload = sys.argv[1], sys.argv[2], sys.argv[3]
body = json.dumps({
    "jsonrpc": "2.0", "id": 1,
    "method": "tools/call",
    "params": {"name": "send_to_tab", "arguments": {"tab_id": tab, "text": payload, **mode_map[cmd]}},
}).encode()
req = urllib.request.Request(
    f"http://127.0.0.1:{PORT}/mcp",
    data=body,
    headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
)
print(urllib.request.urlopen(req).read().decode())
