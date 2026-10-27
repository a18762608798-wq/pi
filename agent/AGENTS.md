# 全局工作规则

## 语言

* 默认使用中文进行分析、说明和回答。除非用户明确要求，不要切换为其他语言。
* 代码、命令、变量名、函数名、库名和专业术语可保留英文。

## 技能调用

* 需要找论文、补参考文献、给任务配文献时，使用 `zotero-paper-hunter` skill（websearch 发现候选，arXiv/出版商页核实元数据，全经 Zotero MCP 去重入库到主题 `paper/inbox`）。
* 需要找书、教材、讲义入库时，使用 `zotero-book-hunter` skill（先查 ISBN 再入库）。
* 只在库内检索已有文献时，用 Zotero 语义搜索，不走 hunter。

## MCP 工具调用

* deferred 服务 `tool_search` 搜不到时先直接调用，能调通就是已加载；报 not found 再用 `tool_search` 载回。不改配置、不杀进程、不绕过 MCP 直读库。

## 文件删除与移动

* 删文件、移文件优先用 git 感知命令（`git rm` / `git mv`），而不是裸 `rm` / `mv`：删除进暂存可回溯，移动保留历史，重命名不会断 `git log --follow`。

## 数学公式

* 数学公式必须统一使用 LaTeX `$` 格式：行内用 `$...$`，独立成段用 `$$` 独占三行，禁止用纯文本或 Unicode 代替。
