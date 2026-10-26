# pi permission system

> **如果用neovim的那个权限管理就不需要安装这个了**

## install

```bash
pi install npm:pi-permission-system
```

## config

打开 `nvim ~/.pi/agent/pi-permissions.jsonc`, **越具体、越靠后的匹配优先**.

```json
{
  "defaultPolicy": {
    "tools": "ask",
    "bash": "ask",
    "mcp": "ask",
    "skills": "allow",
    "special": "ask"
  },

  "tools": {
    "*": "ask",

    "read": "allow",
    "grep": "allow",
    "find": "allow",
    "ls": "allow",

    "edit": "ask",
    "write": "ask"
  },

  "bash": {
    "*": "ask",

    "git status": "allow",
    "git diff*": "allow",
    "git log*": "allow",

    "sudo *": "deny",
    "rm -rf *": "deny"
  },

  "special": {
    "external_directory": "ask"
  }
}
```
