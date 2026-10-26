# agentic-af

> **这个就完全不止权限管理了, 如果不需要需要在config中关闭其他功能.**

## install

```bash
pi install git:github.com/alex35mil/agentic-af
```

然后 `pi config`, 把无关配置关闭, 保留 `permission`

## config

目录: `nvim ~/.pi/agent/permission.settings.json`

写入

```json
{
  "defaultMode": "ask",

  "allow": [
    "read",
    "grep",
    "find",
    "ls",

    "web_search",
    "fetch_content",
    "get_search_content",

    "bash(pwd)",
    "bash(git status*)",
    "bash(git diff*)",
    "bash(git log*)",
    "bash(git show*)",
    "bash(git rev-parse*)",
    "bash(git ls-files*)",
    "bash(git grep*)",
    "bash(rg *)",
    "bash(ls *)"
  ],

  "deny": [
    "bash(sudo *)",
    "bash(rm -rf *)"
  ],

  "ask": [
    "edit",
    "write"
  ]
}
```

## command

`/permission-settings`: 查看最终生效权限.
`/permission-mode`: 临时修改工具权限.
`/permission-toggle-auto-accept`: 暂时一直自动同意.
