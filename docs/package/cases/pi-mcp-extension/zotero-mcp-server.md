# zotero mcp server

把 Pi 的 `~/.pi/agent/mcp.json` 写成(ref to [zotero](~/sync/computer/code/notebook/zotero/03_mcp/02_config.md))

```json
{
  "mcpServers": {
    "zotero": {
      "command": "zotero-mcp",
      "args": ["serve"],
      "transport": "stdio",
      "lifecycle": "eager",
      "env": {
        "ZOTERO_LOCAL": "true"
      }
    }
  }
}
```
