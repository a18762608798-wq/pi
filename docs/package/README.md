# introduction

关系如下:

```bash
package
├── extension
├── skill
├── prompt
└── theme
```

常用命令:

```bash
# 安装
pi install npm:包名
# GitHub 包也可以
pi install git:github.com/user/repo
# 甚至可以试用
pi -e npm:某个包

# 查看已安装
pi list

# 启用/禁用某个包里的具体资源
pi config

# 删除
pi remove npm:包名

# 更新所有 package
pi update --extensions
```

## pi install

- 全局npm位置: `~/.pi/agent/npm/`
- git package: `~/.pi/agent/git/`

## pi config

可以启动package中的某一模块而非全部组分.
