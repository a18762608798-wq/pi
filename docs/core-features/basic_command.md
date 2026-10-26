# basic command

```bash
/reload # 重新加载pi 配置
/trust # 是否信任当前项目的pi配置(false则只用全局)

/login # 登录provider
/model # 切换模型
/scoped-models # 设置常用模型列表
/thinking # thinking level
/settings

/tree
/fork
/clone
/name # set name of session
/session # 看当前对话
/new
/resume # 切换对话

/compact

@file  
@dir #上下文引用
```

## scoped-models

/scoped-models = 设置 `Ctrl+P` 快速切模型时的候选名单。

设置的时候简单勾选即可.

## settings

其中 `/settings` 下值得关注的有:

```bash
Default thinking/model # 配置具体模型的默认thinking level
Default project trust # 默认ask
```

对于非交互配置, 默认工具也很值得:

```json
{
  "defaultTools": [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "edit",
    "write"
  ]
}
```

## tree

想把不同尝试放在一起看，用 /tree；想彻底拆成另一个独立任务，用 /fork 或 /clone。
