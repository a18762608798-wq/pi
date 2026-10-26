# Handoff：OpenCode → Pi 迁移（env-ops 执行记录）

## 任务目标
1. 检查 `~/.config/opencode` 与 `~/.pi` 配置现状；2. skills 全局共享；3. OpenCode 全局规则 + Tool Selection Priority 迁入 Pi；4. 安装推荐插件与 Pi Agent Desktop。

## 现状盘点（步骤 1）

### OpenCode（`~/.config/opencode`，git 仓库）
- `opencode.jsonc`：model=`opencode-go/muse-spark-1.3-contributor#xhigh`；compaction(auto, keep=157286, buffer=576717)；providers 4 个 vankit + opencode-go（显式 variants）；experimental.policies 仅放行 opencode-go/4 个 vankit；permissions V2（.env 保护、sudo/rm -rf 等高危 ask）；MCP：playwright + zotero（`ZOTERO_LOCAL=true`，toolsets=`libraries,search-admin,pdf-geometry,discovery`）；plugins：`@upstash/context7-opencode`。
- `AGENTS.md`：中文工作规则 + 3 条技能调用规则（zotero-paper-hunter / zotero-book-hunter / 语义搜索）。
- `agents/`：manager / coder / env-ops / reviewer / speckit-guide（opencode 专属 subagent 机制）。
- `plugins/`：formula-style.ts、manager-gemini-guard.ts、speckit-rework-gate.ts（opencode TS 插件，不兼容 pi）。
- `skills/`：10 个 skill（agent-browser、book-mainline-grasper、env-proxy、find-skills、git-push-all、problem-recorder、product-doc-writer、skill-creator、zotero-book-hunter、zotero-paper-hunter），git 跟踪 36 个文件。

### Pi（`~/.pi`）
- `agent/settings.json`：defaultProvider=`opencode-go`，defaultModel=`muse-spark-1.3-contributor`，defaultThinkingLevel=`xhigh`（模型与 opencode 已对齐）；defaultTools=read,grep,find,ls,bash,edit,write；compaction enabled；packages=`../custom/pi-web-ui`。
- `agent/mcp.json`：原只有 zotero（toolsets=`pdf-geometry,discovery`，无 ZOTERO_LOCAL）。
- `agent/AGENTS.md`：数学公式 LaTeX 规范 / Zotero 直调工具 / 轻量脚本（pixi python 优先）。
- `agent/extensions/`：permission-gate.ts（危险 bash 确认）、protected-paths.ts（.env/.git/node_modules 保护）——对应 opencode permissions 的等价物。
- `agent/skills/`：原为空目录。
- `pi list`：原只有 `../custom/pi-web-ui`。
- pi CLI：v1.3.0，nvm node v24.20.0 下。

## 执行的变更（步骤 2-4）

### 步骤 2：skills 全局共享
- 实体目录：`~/.config/opencode/skills`（git 管理，不动）。
- `rmdir ~/.pi/agent/skills` 后建软链接：`~/.pi/agent/skills -> /home/mintusr/.config/opencode/skills`。
- 验证：`pi -p "列出 skills"` 输出全部 10 个 name，两端同时生效。

### 步骤 3：规则迁移 → `~/.pi/agent/APPEND_SYSTEM.md`（新建）
- 内容 = OpenCode `AGENTS.md` 全部规则（语言 + 技能调用）+ `Tool Selection Priority` 六条（read/edit/write 优先于 bash）。
- 机制确认：pi `dist/core/resource-loader.js` 自动发现 `<agent-dir>/APPEND_SYSTEM.md` 附加到系统提示，无需 trust；项目级 `.pi/APPEND_SYSTEM.md` 会整体覆盖（不合并），注意同名冲突。
- `~/.pi/agent/AGENTS.md`（数学公式 / Zotero / 轻量脚本）保留不动，两文件并行生效。

### 步骤 4a：插件安装（`pi install`，全局 settings）
- `pi install npm:pi-lsp-adapter`（0.1.3，LSP 只读智能：定义/引用/Hover/诊断）
- `pi install npm:pi-web-access`（0.28.0，web 搜索/抓取，对应用户 "web换成1" 的选择）**【已卸载，见第五轮修复】**
- （第一轮当时状态）`pi list` 为：pi-web-ui、npm:pi-lsp-adapter、npm:pi-web-access；settings.packages 三项。
- 冒烟：`pi --no-session --model opencode-go/glm-5.3-flash -p "只回复两个字：好的"` → "好的"，无扩展加载错误。
- 备注：对话还推荐过功能更全的 `pi-lsp-extension`(1.4.0)，按用户点名只装了 pi-lsp-adapter；两个 LSP 扩展功能重叠，不建议同时装。
- koffi 依赖 install-scripts 被 npm 拦截（警告），但扩展加载正常，未影响。

#### 步骤 4a-2：pi-lsp-adapter 语言服务器配置与验证（reviewer 修复项，共三轮）

**最终状态**：Python 诊断（pyright）真实可用；TypeScript/JS 的 tsserver 型 server 在本 Node v24.20.0 环境深层不兼容，已禁用 LSP 路径并用 `tsc --noEmit`（bash）作为可靠 fallback。

第一轮（managed install）：
- 经扩展官方 managed installer（RPC 模式发 `/lsp install <id>`）安装，写入 `~/.pi/agent/lsp/lsp.lock.json`：
  - `pyright`：`pyright@1.1.410`，bin=`~/.pi/agent/lsp/bin/pyright-langserver --stdio`（保留至今）
  - `vtsls`：`@vtsls/language-server@0.3.0` + `typescript@6.0.3`（后已 `/lsp uninstall`）
- **Node 24 patch ①（仍有效）**：`vscode-languageserver@9.0.1` 的 `lib/common/api.js:25` 使用尾斜杠 `require("vscode-languageserver-protocol/")`，Node v24.20.0 严格化抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`；已 patch 为根导入（语义等价）。`/lsp update` 重装后需重打。

第二轮（350ms 修复，reviewer 指出首次诊断返回空）：
- **patch ②（核心修复）**：`pi-lsp-adapter/src/lsp/runtimeManager.ts` 的 `diagnostics()` 原为固定 `delay(350ms)` 后读 publish 缓存——冷启动 server 尚未 publish 必返回空。已改为轮询（100ms 步长、上限 `diagnosticsWaitMs` 默认 350→**2000ms**，首次非空即返回）。实测 pyright 冷启动诊断 durationMs 2490-2740 并命中预埋错误（reportReturnType + hint），证明轮询必要且有效。
- 期间发现：更早"TS2322 双服务器全通"的验证结论是**模型读文件后的自编报告**（RPC 捕获工具原始返回 total=0）；真实基线以上述实测为准。

第三轮（tsserver 型 server 故障定位与收尾）：
- strace 铁证：typescript-language-server@6.0.2（tsls）fork 两个 tsserver（syntax/semantic，ipc 模式）——parent 向 ipc fd 写入 seq0-4 五条消息（configure/compilerOptions/open/geterr），child 响应写回 fd 3，**但 parent 端事件循环从不 read 回包**；强制 stdio 模式（patch useIpc=false，后已还原）则 child fork 镜像秒退 exit 0。vtsls 同样症状（"LSP: 0/7 servers" 永不就绪）。同 Node 的独立 fork 测试（单 child、简单 stdio）收发正常，故障出现在 tsserver 型实现的 fork 复合进程链路，修复半径超出环境层（属上游与 Node v24.20 的兼容问题）。
- 处置：`/lsp uninstall vtsls`（52MB 已释放）；`lsp.json` 中 `tsls` 定义保留（install/command 记录）但 **`filetypes: []` 禁用**，避免空结果误导为"代码无错误"。
- **TS 可靠 fallback**：全局安装 `typescript@6.0.3`（`/home/mintusr/.nvm/versions/node/v24.20.0/bin/tsc`），实测 `tsc --noEmit` 命中 `test.ts(5,14): error TS2322`。TS/JS 类型检查用 bash 跑 `tsc --noEmit`；python 走 LSP（pyright）。

**当前 `~/.pi/agent/lsp.json`**：`installMode: prompt`、`warmup: true`；servers：`vtsls{filetypes:[]}`、`pyright`（绝对 node 覆盖 command）、`tsls{filetypes:[], 绝对 node command}`。

#### 启动警告（每次 pi 启动 stderr，无害，上游包问题）

第五轮卸载 pi-web-access 后仅剩一条：

```text
Warning: Extension package "/home/mintusr/.pi/agent/npm/node_modules/pi-lsp-adapter/package.json": Host-provided extension packages must be declared in peerDependencies with a "*" range, not dependencies: @earendil-works/pi-tui, typebox. Installed copies can bypass the extension loader and create duplicate runtime modules.
```

（pi-web-access 的同类 Warning 已随卸载消失；卸载前为两条，第二条为：`Warning: Extension package ".../pi-web-access/package.json": Host-provided extension packages must be declared in peerDependencies with a "*" range, not dependencies: typebox. ...`）

扩展实际加载正常（冒烟通过），警告源于上游包把宿主依赖放进了 dependencies 而非 peerDependencies。

### 步骤 4b：MCP 对齐（编辑 `~/.pi/agent/mcp.json`，迁移前原版备份：`~/.pi/.opencode/mcp.json.pre-migration.json`）
- zotero 补齐 opencode 同款 env：`ZOTERO_LOCAL=true`、toolsets=`libraries,search-admin,pdf-geometry,discovery`。
- 新增 playwright：`/home/mintusr/.nvm/versions/node/v24.20.0/bin/node` + `…/lib/node_modules/@playwright/mcp/cli.js`（全局安装 `@playwright/mcp@0.0.83`，**绝对路径**，GUI 环境不依赖 PATH/npx），`--browser chromium --headless`，exposure direct。
- 验证：`pi mcp list` → zotero connected 43 tools；playwright connected 25 tools。

### 步骤 4c：Pi Agent Desktop（DLYZZT/pi-desktop）
- 下载 `Pi-Agent-Desktop-0.4.3-x86_64.AppImage` → `~/Applications/`（**190,872,400 bytes ≈ 190.9 MB / 182 MiB**），`chmod +x`。
- 桌面条目：`~/.local/share/applications/pi-agent-desktop.desktop`（Exec 指 AppImage，含官方 MimeType `x-scheme-handler/pi-agent-desktop`；`desktop-file-validate` 通过）。
- 图标：AppImage 提取安装到 `~/.local/share/icons/hicolor/1024x1024/apps/pi-agent-desktop.png`。
- 运行环境：fusermount3 3.14.0（FUSE 可用）；**GUI 实测验证**：`DISPLAY=:0` 启动 AppImage → X11 窗口 `0x5200004 "Pi Agent Desktop" 1280x840` 真实创建（xwininfo 确认），user-data-dir=`~/.config/Pi Agent Desktop`；验证后进程与窗口已完全清理。
- 内置版本核实（app.asar 依赖实测）：Desktop v0.4.3 自带 **`@earendil-works/pi-coding-agent` 1.4.0**（另含 pi-ai/pi-mcp/pi-tui 1.4.0、KaTeX、Mermaid 11.17、electron-updater）。比系统 pi CLI 1.3.0 新；两者共用 `~/.pi/agent`（agent-dir 随 HOME），本迁移全部配置（skills/APPEND_SYSTEM.md/插件/MCP/lsp.json）在桌面端同样生效。

## 版本清单（核实于 2026-10-24/25 实机）
- 系统 pi CLI：**1.3.0**（nvm node v24.20.0 下）
- Pi Agent Desktop：**v0.4.3**（DLYZZT/pi-desktop，AppImage），内置 **@earendil-works/pi-coding-agent 1.4.0**（pi-ai/pi-mcp/pi-tui 1.4.0、KaTeX 0.16.47、Mermaid 11.17.2、electron-updater 6.8.9、typebox 1.3.27）
- pi 插件：pi-lsp-adapter **0.1.3**（`pi-web-ui` 本地包与 `pi-web-access` 0.28.0 已分别于第八轮、第五轮卸载）
- LSP servers：pyright **1.1.410**（可用）；typescript-language-server **6.0.2** + typescript **6.0.3**（安装保留、filetypes 禁用）；vtsls 0.3.0（已卸载）
- MCP：@playwright/mcp **0.0.83**（全局安装，绝对 node 调用）、zotero-mcp（本地）

## 缓存与临时文件删除说明
- 第一轮清理：`/tmp/opencode/db_copy.sqlite`（OpenCode 会话库副本）、`wal_copy.sqlite-wal`、`squashfs-root/`（AppImage 提取）、`mcp.json.bak`。
- 第二轮清理：`squashfs-root/`（重建后）、`asar-out/`（app.asar 解包 ~1GB）、`lsp-install/`（试验脚本）、`desktop-gui.log`。
- 第三轮保留：`/tmp/opencode/lsp-test/`（LSP 验证项目）、`lsp_probe*.py`、`tsls.strace`（复验证据）；`/tmp/opencode/mcp.json.bak` 已删，迁移前 mcp.json 原版持久备份在 `~/.pi/.opencode/mcp.json.pre-migration.json`。
- 同步膨胀防护：`~/.pi/agent/lsp/.gitignore`（`*` + `!.gitignore` + `!lsp.lock.json`）——git 只跟踪豁免的 .gitignore 与 lsp.lock.json（几 KB），63MB 运行时（packages/bin/logs/cache）全部忽略；`git check-ignore` 已验证生效，`agent/npm/` 同构模式（自带 .gitignore）。
- **仓库内 `~/.pi/web-search-cache/` 删除说明**：该目录属 home git 仓库（`.pi/web-search-cache/`，pi-web-access 的运行时缓存）；其中 `mvf49it0tvq14d.json` 早已被删除（`git status` 显示 `D`，尚未提交）。第五轮卸载 pi-web-access 后空目录已一并 `rmdir` 移除——该插件残留全清；`git status` 中的 `D` 记录随之成为对历史文件的删除记录，随下次提交固化。

## Reviewer 修复（第七轮，2026-10-25）：删除 speckit-guide agent（用户确认）
- 用户确认删除：opencode 仓 `agents/speckit-guide.md` 已删除（agents/ 剩 4 个：manager/coder/env-ops/reviewer），配置与文档中 6 处明确引用一并清理（`docs/agents/01-agents.md`、`02-agents-organization.md`、`01-getting-started/config.md` 目录树、`README.md` 目录表），全仓 grep 零残留。
- **加载验证**：`opencode run --model opencode-go/glm-5.3-flash` 冒烟 → "好的"（退出码 0）；未提交的 `D` 删除记录与 skills 迁移变更一并留给主控固化。
- 本"未迁移项"列表已同步更新：speckit-guide 标注用户确认删除、不再列为待迁移项。

## Reviewer 修复（第六轮，2026-10-25）：skills 实体迁至 ~/.agents/skills + 官方 Context7 MCP

### 原生支持核实
- **OpenCode**：官方文档 `docs/01-getting-started/config.md` 与 `docs/skills/skills-definition.md` 明确支持全局 `~/.agents/skills/`（另兼容 `~/.claude/skills`、`opencode.jsonc` 的 `skills` 数组显式路径）。
- **Pi**：源码 `dist/core/package-manager.js`（`userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills")`）原生发现用户级 `~/.agents/skills`；`trust-manager.js` 注明该目录按受信任用户级资源处理（无需 trust 决策）。
- 结论：**两端原生支持，均无需软链接或额外配置**。

### 迁移动作
1. `mv ~/.config/opencode/skills/* ~/.agents/skills/`（10 个 skill 实体）→ 删除 opencode 仓内空目录 `skills/` → 删除 pi 端软链接 `~/.pi/agent/skills`。
2. git 可追踪性（均未自动提交，留给主控 review）：
   - `~/.config/opencode` 仓：`git status` 显示 skills 下 36 个文件 `D`（删除记录）——完整历史仍可 `git log --follow` 回溯；固化命令：`git add -A skills/ && git commit`。
   - home 仓（`/home/mintusr`，白名单式 dotfiles 同步仓，`.gitignore` 已放行 `!/.agents/`）：新实体为 untracked（`?? .agents/skills/`）；固化命令：`git add .agents/skills && git commit`。

### 验证（双端 10 个 skills 发现）
- OpenCode：`opencode run --model opencode-go/glm-5.3-flash "列出 skills"` → **13 个**（10 个迁移实体 + context7-mcp[插件注入] + opencode/report[内置]）✓
- Pi：`pi --no-session -p "列出 skills"` → 恰好 10 个迁移实体 ✓

### Context7 MCP（官方远程，pi 端补配）
- `~/.pi/agent/mcp.json` 新增 `context7`：`url: https://mcp.context7.com/mcp`（官方远程服务，无本地命令 → 无 GUI PATH 依赖；`CONTEXT7_API_KEY` 未设置，匿名限速模式），`exposure: direct`，`description` 中文一句话。
- 连接验证：`pi mcp list --json` → `context7 | enabled: True | state: connected | err: None`（zotero/playwright 同状态）。
- **实际工具调用验证**：`pi -p` 经 flash 调 `resolve-library-id` 查询 'react' → 返回真实数据（`Available Libraries: /reactjs/react.dev`）✓
- OpenCode 端 context7 仍由 `@upstash/context7-opencode` 插件托管，未改动。

### 回归确认（未破坏既有能力）
- LSP：pyright 冷启动诊断仍命中 `reportReturnType` + hint（RPC 捕获原始返回 total=2）✓
- Pi Agent Desktop：AppImage 在位（190,872,400 bytes）✓
- MCP：zotero 43 tools / playwright 25 tools / context7 connected ✓
- Skills：双端 10 个迁移实体 ✓

## Reviewer 修复（第五轮，2026-10-25）：卸载 pi-web-access
- `pi remove npm:pi-web-access`（退出码 0）——settings.packages 当时为 `["../custom/pi-web-ui", "npm:pi-lsp-adapter"]`；`pi list` 一致。
- 残留清理：`~/.pi/agent/npm/node_modules/pi-web-access` 及其 hoisted 依赖随 remove 自动删除；运行时缓存空目录 `~/.pi/web-search-cache/` 已 `rmdir`。
- 冒烟复验：`pi --no-session --model opencode-go/glm-5.3-flash -p "只回复两个字：好的"` → "好的"，stderr 仅剩 pi-lsp-adapter 一条 peerDependencies Warning（退出码 0）。
- Pi Agent Desktop、pi-lsp-adapter、MCP（zotero/playwright）、skills 当时均未改动；`pi-web-ui` 当时仍在，第八轮已卸载。

## Reviewer 修复（第八轮，2026-10-25）：卸载 pi-web-ui
- `pi remove ../custom/pi-web-ui`（退出码 0）——settings.packages 现为 `["npm:pi-lsp-adapter"]`；`pi list` 一致。
- 源码清理：删除前该目录的 git 跟踪文件状态干净，随后 `rm -rf ~/.pi/custom/pi-web-ui`（删除前约 763M，含其自带 `.git`、`node_modules`、`dist`），该路径现已不存在。
- 冒烟复验：`pi --no-session --model opencode-go/glm-5.3-flash -p "只回复两个字：好的"` → “好的”，stderr 仅剩 pi-lsp-adapter 一条 peerDependencies Warning（退出码 0）。
- Pi Agent Desktop、pi-lsp-adapter、MCP、skills 均未改动。

## 用户删除 manager 相关配置（2026-10-25）
- OpenCode 已删除 `agents/manager.md`、`plugins/manager-gemini-guard.ts`；`agents/` 现剩 `coder.md`、`env-ops.md`、`reviewer.md`，`plugins/` 现剩 `formula-style.ts`、`speckit-rework-gate.ts`；`README.md`、`opencode.jsonc` 注释、相关文档已同步，主会话默认直接处理、按需直接调用子 Agent。
- Pi 已删除 `agent/extensions/manager-gemini-guard.ts`、`~/.pi/.opencode/pi-ext-tests/test-manager-gemini-guard.mjs`；`extensions/` 现剩 `formula-style.ts`、`permission-gate.ts`、`protected-paths.ts`、`speckit-rework-gate.ts`；剩余针对性测试现为 `test-formula-style.mjs`、`test-speckit-rework-gate.mjs`。
- 验证：`opencode plugin list` 仅剩 `context7`、`formula-style`、`speckit-rework-gate`；Pi 冒烟正常；剩余测试 `6/6`、`413/413` 通过。
- 历史记录中的 `manager`、`manager-gemini-guard` 均为删除前状态，不再是当前配置；历史测试命令和旧版 `git add` 清单中的已删文件不要再执行。

## 未迁移项（有意为之；2026-10-25 订正：`plugins/` 三项已由 coder 迁为 Pi 本地扩展，见下文“OpenCode 插件 → Pi 扩展移植”；`launch-mode` 经核查在 `opencode.jsonc`/`plugins/` 均不存在，属 opencode 仓 handoff 误记，已在该仓 handoff 中更正）
- opencode `agents/`（coder/env-ops/reviewer）：opencode 专属 subagent，pi 无对应内置；如需子代理可用 `npm:pi-subagents`(0.81.0)。（`manager`、`speckit-guide` 已由用户确认删除，不再列为待迁移项。）
- opencode `plugins/`（speckit-rework-gate、formula-style）：~~opencode TS 插件 API，不兼容 pi 扩展 API~~ → 已移植为 `~/.pi/agent/extensions/` 下同名 Pi 扩展（`manager-gemini-guard` 已按用户要求在两端删除，不再是当前配置）。
- opencode permissions V2：pi 端已有等价 extensions（permission-gate / protected-paths）。
- opencode 的 `experimental.policies` provider 白名单：pi 无对应机制，凭据由 auth.json 控制。

## 验证命令汇总（当前状态，2026-10-25 manager 删除后核准）
- manager 相关配置：OpenCode `agents/` 剩 3 个、`plugins/` 剩 2 个，Pi `extensions/` 剩 4 个，已删路径均不存在 → OK
- `opencode plugin list` → `context7`、`formula-style`、`speckit-rework-gate` → OK
- `opencode run --model opencode-go/glm-5.3-flash "只回复两个字：好的"` → “好的” → OK
- Pi 剩余测试：`test-formula-style.mjs` 6/6、`test-speckit-rework-gate.mjs` 413/413 → OK
- skills：实体在 `~/.agents/skills/`（10 个，两端原生发现；软链接已移除）→ OK
- `pi list` → 1 package（npm:pi-lsp-adapter；第八轮卸载 pi-web-ui 后）→ OK
- `pi mcp list --json` → zotero 43 / playwright 25 / context7 全部 connected → OK（playwright 绝对 node 路径；context7 为官方远程）
- `pi --no-session -p "…"` → 中文回复 + skills 列表 10 项 → OK（退出码 0）
- Context7 实调：`pi -p` 调 `resolve-library-id` 查 'react' → `/reactjs/react.dev` → OK
- LSP 实测（RPC 捕获工具原始返回）：pyright 冷启动命中 reportReturnType + hint（total=2，durationMs 2490-2740）→ OK；test.ts 返回明确失败（"No configured LSP server handles filetype typescript"）→ 不误导
- tsc fallback 实测：`tsc --noEmit` 命中 `test.ts(5,14): error TS2322` → OK
- GUI 实测：`DISPLAY=:0` 启动 AppImage → X11 窗口 1280x840 创建（xwininfo）→ OK，验证后清理
- `desktop-file-validate ~/.local/share/applications/pi-agent-desktop.desktop` → OK
- `git check-ignore -v .pi/agent/lsp/{packages/tsls,bin,lsp.lock.json,.gitignore}` → 运行时忽略 / 豁免文件跟踪 → OK（vtsls 已卸载，示例同步移除）

## 维护备忘
- **Skills 实体已迁 `~/.agents/skills/`**：新增 skill 直接放该目录（两端原生发现）；勿再建 `~/.pi/agent/skills` 软链接。两处 git 变更（opencode 仓 36 个 `D`、home 仓 `?? .agents/skills/`）待主控确认后提交固化。
- **LSP 诊断等待（patch ②）**：`pi update --extensions` 重装 pi-lsp-adapter 会覆盖 `runtimeManager.ts` 的轮询 patch，需重打（diagnostics() 轮询 + 默认 2000ms）。
- **Node 24 patch ①**：vtsls 相关已随卸载失效；若复装 `@vtsls/language-server`，需重打尾斜杠 patch。
- **绝对路径写死**：`~/.pi/agent/lsp.json`（pyright/tsls 的 node）与 `mcp.json`（playwright 的 node + cli.js）均绑定 nvm node v24.20.0；node 主版本升级需同步三处。
- **tsserver 型 server 复启用**：待上游修复 Node v24.20 fork 兼容后，将 `tsls.filetypes` 恢复为 `[javascript, javascriptreact, typescript, typescriptreact]` 即可（安装与 command 均已就绪）。

## OpenCode 插件 → Pi 扩展移植（coder，2026-10-25）

> 删除前状态：下文曾同时移植 `manager-gemini-guard.ts`。用户已要求删除两端 manager 相关配置，当前仅剩 `formula-style.ts`、`speckit-rework-gate.ts` 及其两套测试；历史 `manager` 测试命令、旧版 `git add` 清单中的已删文件不要再执行。

### 新增文件（OpenCode 原插件未动，其他配置未动）
- `~/.pi/agent/extensions/formula-style.ts`（`formula-style` 的等价改写）
- `~/.pi/agent/extensions/manager-gemini-guard.ts`（`manager-gemini-guard` 的尽力改写，部分不等价，已声明）
- `~/.pi/agent/extensions/speckit-rework-gate.ts`（`speckit-rework-gate` 的等价改写，保留 Speckit 流程；未恢复 speckit-guide agent）
- 测试套件 `~/.pi/.opencode/pi-ext-tests/`：`helper.mjs`、`loader-resolve.mjs`、`pi-stub.mjs`、`register.mjs`、`test-formula-style.mjs`、`test-manager-gemini-guard.mjs`、`test-speckit-rework-gate.mjs`（resource-loader 不扫描 `.opencode/`，对 Pi 零影响）

### 行为映射
- formula-style：`session.hook("context")` → `pi.on("before_agent_start")` 改写 `systemPromptOptions.sections["formula-style"]`；注入文本与原文逐字一致（测试做字面比对）；每轮 run 起始注入一次（原为每次 LLM 调用，阶段推进仍经工具返回告知模型）。
- manager-gemini-guard（不等价，诚实降级）：Pi 无 agent 角色，`manager` 例外无对应物，默认按非 manager 全拦，`PI_MANAGER_GEMINI_ALLOW=1` 视为 manager 放行；Pi 处理器抛错只上报不中断，故原“抛错中断”改用三处真拦截——`model_select` 通知+自动回滚、`input` 吞掉本轮（`--model` 直带 Gemini 的兜底）、`session_before_compact` 取消；`title` 钩子无对应物（Pi 不做 LLM 起标题）。
- speckit-rework-gate：7 工具同名同参同描述经 `pi.registerTool` 注册（`speckit_rework` 命名空间，返回仍是 `{"ok",...}` JSON 字符串信封）；`prompt` 钩子 → `input` 事件；`context` 注入 → `before_agent_start` section；`permission/evaluate` → `tool_call` 返回 `{block:true}`（edit/write/含 path 自定义调用 + bash/powershell）与 `user_bash` 抛错；会话键为 `sessionFile ?? sessionId ?? cwd`（无 parent 链，fork/resume 经 `session_start(previousSessionFile)` 继承）；`resolveRoot` 同步化（`ctx.cwd` 上找）；读改写经 `withFileMutationQueue` 与内置 edit/write 互斥（Pi 并行工具调用所需，原插件无此概念）。
- 已知缺口（与原插件一致或已声明）：第三方 MCP 写文件工具无 `path` 字段则不覆盖；Copy-Item（Windows cmdlet，无 POSIX 解析）、awk/sed 脚本内 `w`（非 `-i` 形式）、`source script.sh`/`sh script.sh` 执行脚本文件、未知自定义包装器（内部 wrapper、strace 类、parallel 等）、`env -S` 分裂字符串内的隐含命令不解析写目标——open 期可能漏过（残留缺口，见硬化修复 § 限制）；`blocked` 事务内存态，重启/reload 丢失（与原插件一致）。`tee`/`sed -i`/dd/touch/rm/mkdir/rmdir/shred/truncate/install/cp/mv/ln/sudoedit/委托包装器链均已按新语义解析（有意偏离，测试锁定）。

### 测试（全部通过）
- `node --import ./register.mjs test-formula-style.mjs` → 6/6（含与原文案字面比对）。
- `node --import ./register.mjs test-manager-gemini-guard.mjs` → 19/19（含回滚、`handled`、`cancel:true`、转义口）。（删除前记录；该扩展与测试已删除，不要再执行。）
- `node --import ./register.mjs test-speckit-rework-gate.mjs` → 413/413（A→Q 组：select→assess→四门→open→close 全路径、scope 越界拦截、checklists 失败阻断、输入自开事务与 `/speckit.*` 旁路、OFFICIAL_RE/MODIFY_RE 与原文案字面一致；`SHELL_WRITE_RE` 已删除（零散正则被词法分析取代，删除本身即偏离声明）；G→Q 为各轮硬化回归组，见下）。
- `node --experimental-strip-types --check`：当时 3 个新扩展 + 2 个既有扩展全部通过；删除后当前应为 2 个移植扩展 + 2 个既有扩展。
- 真机 Pi：冒烟 `pi --no-session --model opencode-go/glm-5.3-flash -p` 退出 0，仅既有 pi-lsp-adapter 警告；`--mode json` 转录含 `formula-style` 区段与公式文本；7 个 `speckit_rework_*` 工具经模型列出；`speckit_rework_list_features` 经模型实调返回 `{"ok": false, "error": "not a Spec Kit project"}`；`--model opencode-go/gemini-4-argon-contributor -p hi` 约 4 秒退出 0、全程无模型调用事件（零花费拦截；此前另有一次 180 秒超时未复现，判为偶发启动 stall）。
- OpenCode 侧：除用户删除的 `manager-gemini-guard.ts` 外，其余原插件文件零改动。

### 固化提示（留给主控）
- home 仓：`git add .pi/agent/extensions/formula-style.ts .pi/agent/extensions/speckit-rework-gate.ts .pi/.opencode/pi-ext-tests .pi/.opencode/handoff.md`（`.pi/.opencode/` 目前整目录 untracked；已删的 manager 文件不要再加入清单）。

### 硬化修复（2026-10-25，相对原插件的有意偏离；同日追加 tee 枚举修复；reviewer 复检后改用可靠词法解析）
- 问题 1：原插件对仓库外写入全放行（`outside → continue`：edit 循环 + `outOfScopeTargets` 对 `~`/绝对路径越界/相对路径越界的三处 `continue`），而 scope 只能声明仓库相对 glob——事务存续期间模型可经 `/tmp`、`~/`、`../` 等把写入动作搬到仓库外，绕过门禁与 scope。Pi 移植逐字继承了该行为。
- 问题 2（高危）：`shellWriteTargets` 的 tee 正则用 `/g` 循环但每次都要求字面 `tee` 前缀，第二目标起永远匹配不上——只检查首个 tee 目标。`tee /dev/null /tmp/evil` 只看到 `/dev/null`（恰被豁免）而放行整条命令，`/dev/null` 特判从“无害例外”变成绕过放大器。原插件同式继承此 bug。
- 修复 1：`checkPathWrite` 首判 `outside` 一律拒绝（事务存续的任何阶段，含 blocked/closed）；`outOfScopeTargets` 收紧——仓库外绝对路径、`~/…`、`../…` 越界一律计入 `bad`（原样返回目标）。读操作（read/grep/find/ls、无 path 字段调用）不受影响。
- 修复 2（已废弃，被修复 3 取代；中间态保留在 git 历史中）：tee 逐词枚举 + 紧贴式正则。废弃原因见问题 3。
- 问题 3（reviewer 复检，2026-10-25）：在问题 2 的逐词枚举补丁上继续发现绕过——带路径/引号的 tee 调用（`/usr/bin/tee`、`"tee"`，旧 invRe 要求 tee 前为分隔符而漏报）、`>|`（noclobber，旧 redir/attached 均漏报）、`word> /abs`（`>` 后有空格：旧 redir 要求分隔符在 `>` 前、attached 要求 `>` 紧贴目标，两边各差一步而漏报）、`2>&1` 中 fd 被旧 looks-like 正则误判为文件。结论：零散正则补丁收不完，按指示改用可靠 shell 词法解析，对无法安全解析的一律 fail-closed。
- 修复 3（当前实现，J/K 组继续加固）：手写 shell 分词器 + 结构解析（`analyzeShellWrites`），引号/转义/操作符全感知；`$( )`/反引号/`>( )`/`<( )` 完整复解析；`(( ))`/`[[ ]]`/`$(( ))`/heredoc 主体只做嵌套命令替换扫描（`>` 不再是重定向）；`sh -c`/`eval` 递归复解析；WRAPPER_SPECS 委托包装器表（sudo/doas/su/runuser/chroot/unshare/setsid/flock/timeout/stdbuf/env/nice/ionice/taskset/numactl/nohup/time/command/builtin/exec/xargs/watch/busybox/nsenter）通用透视找真实子命令、`-exec/-ok`、控制保留字后恢复命令位置判定；`sed -i` 文件操作数计入写目标；`time -o` 自身输出计入写目标；`su -c`/`flock -c` 代码参数递归复解析；缺失目标/动态目标（`$`）/glob 目标/算术作目标/未闭合引号或替换/未闭合 heredoc/动态 sh -c 与 eval 参数/动态命令词 → uncertain → 调用侧一律拒绝（fail-closed，递归深度 16 + 全局 try/catch 兜底）。动态命令词豁免唯一的纯算术 `$((…))`（执行数字命令无害；作目标仍从严）。
- 问题 5（2026-10-26 新发现绕过 + 覆盖补齐）：(a) 包装器选项表把多个布尔开关误列为取参选项（flock -s/-x/-u/-n、command -p 等），`flock -x lock tee` 中 -x 吞掉锁文件、tee 被误作前置参数跳过而漏报（flock 例甚至抛异常走兜底）；(b) runuser `-u` 已给用户时仍跳过一个位置参数（双跳吞掉真实子命令）；(c) `sudo -e`/`sudoedit` 的待编辑文件被当子命令而漏报；(d) dd/touch/rm/mkdir/rmdir/shred/truncate/install/cp/mv/ln 等常见静态写删命令完全不可见——open 期放行、review 期亦放行（含 `mv` 改名、`rm` 删除这种破坏性操作）。按“布尔开关绝不消费下一词、取参选项严格消费一个参数、无法判定即拒绝”重构参数解析，并为写删命令逐项校验。
- 修复 5（与修复 3/4 同体，K 组锁定）：WrapperSpec 扩展 shortArg/shortCode/shortOut/shortUser/userOpts/editFlags/conditionalUserSkip（派生自选项表，单测可审计）；选项审计逐项核对 man 用法——布尔开关全部移出 skipNext（flock/command/timeout --foreground 等），可疑的 doas -a/-s、unshare --monotonic 等按开关处理，`su -G`、sudo `-p/-r/-t` 等取参选项补齐；短簇按字母表精确扫描（取参字母末位无附带才消费下一词；-cCODE/--command=CODE 复解析、-oFILE/--output=FILE 计入）；runuser 见 -u（含附带值）即豁免位置跳过；sudo -e（含 -ei 簇）切编辑模式；busybox/nsenter 新纳入透视（busybox --install 写链接直接拒绝）；新增 dd（仅 of=）/touch/rm/mkdir/rmdir/shred/truncate/sudoedit（通用操作数解析）/install/cp/mv/ln（-t/-d/-D dest 规则，mv 源删除一并校验，单源 dest 即文件、多源 join）六组解析器；动态/glob/算术目标一律 uncertain。
- 问题 4（2026-10-25 新发现绕过，同系统性原则封堵，不只补字符串）：(a) 动态命令词 `$T`/`$(…)`/反引号/`${…}` 作命令词时旧实现按静态词走命令判定（动态标记被丢弃），`$T tee /tmp/evil` 直接放行；(b) `timeout`/`stdbuf` 等委托包装器不在旧 WRAPPERS 表（仅 8 个），`timeout 5 tee /tmp/evil` 被当普通命令、tee 落操作数位而漏报——同类 `su -c`、`time -o`、`xargs tee`、`flock`、`unshare` 等全部同理；(c) `$((…))` 算术展开被旧分词器误作 `$(` 命令替换，`echo $((a > b))` 的 `>` 被当重定向而误报目标。按“无法确定最终命令/目标即拒绝”系统处理：命令位/包装器子命令位动态（纯算术除外）一律 uncertain；包装器按 WRAPPER_SPECS 通用透视（选项/前置位置参数/`--`/`-c` 代码/`-o` 输出的统一机制，不是逐个字符串补丁）。
- 修复 4（与修复 3 同体，J 组锁定）：分词器区分 `$((` 与 `$(`（三处：readWord 非引号/dquote/collectCmdSubsts），算术只收集内部嵌套、不推命令体、不置 dynamic（内部含 `$`/反引号则仍置 dynamic）；word token 新增 `arith` 位，目标位（重定向/tee/sed/sh -c/eval/-o 输出）见 arith 即 uncertain，命令位纯 arith 豁免；命令位与包装器子命令位新增 `dynamic command word`/`glob command word` 检查；WRAPPER_SPECS 22 项委托表 + 状态机（skipNext/codeOpts/positionalsToSkip/outputOpts/`--`/登录壳 `-`/`VAR=`/链式包装器）；`-exec` 扩展 `-ok`/`-okdir`；包装器 `-c` 代码与 `time -o` 输出纳入解析。
- 问题 6（reviewer 最新 FAIL，L 组封堵）：(a) scope 激活时 Bash 无白名单——`git status`/`python`/`make`/`npm`/`curl`/`chmod` 等未知命令在 shell 层无目标、旧实现直接放行，但解释器/工具内部可任意写文件；(b) `find . -delete`、`find -exec …` 等写动作旧实现不可见（`-delete` 直接放行，`-exec` 仅靠子命令提目标）；(c) `xargs rm`（stdin 提供文件列表，静态操作数为空）旧实现无目标而放行；(d) 仓库内 symlink 指到仓库外（`docs/link → /tmp/evil`）或 scope 外（`docs/link → src/secret`）时 lexical 判定放行；(e) cp/ln/install 单源 dest 为已存在目录时旧实现误作文件 dest，动态源 basename 未知被忽略。
- 修复 6（L 组锁定，不是沙箱）：新增 `SHELL_SAFE_READONLY` 显式白名单（`ls`/`echo`/`cat`/`head`/`grep` 等只读命令）+ `isKnownShellCommand`，未知命令一律 `unknown command` fail-closed（分析层 uncertain，门禁层阻断；旧 `cmd`/`make` 占位测试改为 `echo`/`ls`）；`find` 独立分支：`FIND_WRITE_ACTIONS`（`-delete`/`-exec`/`-execdir`/`-ok`/`-okdir`/`-fls`/`-fprint*`）任一出现即 fail，纯读 `find -print`/`-name` 放行；`xargs` 子命令非 `SAFE_READONLY`（且非包装器）即 `xargs subcommand may consume stdin` fail-closed（`xargs echo` 放行）；write/edit/bash 路径新增 realpath/lstat 双检（`lexicalAbs`/`realRootOf`/`realAbsForWrite`/`escapesRoot`/`realRelOf`）：`classify` 外越即 outside，`classifyShellTarget`/`checkPathWrite` 另做真实 rel scope 双检；cp/ln/install 线程 root（`analyzeShellWrites(..., _root)` 透传至 `parseShDashC`/`parseEvalArgs`/cmdSubsts/wrapper code）：`isDirLikeTarget`（尾斜杠或 `statSync` 既存目录，symlink 跟随）+ `shellJoinDir`，单源目录 dest join basename、动态源此时 fail，文件 dest 保持源读忽略；mv 双操作数目录 dest 一并计入 join。
- 问题 7（reviewer 最新 FAIL，M 组封堵）：(a) `sort`/`uniq`/`less` 等“只读”命令旧实现跳过全部操作数——`sort -o`、`uniq` 第二操作数、`less -o/-O`、`diff --output` 等输出文件参数不可见，未知选项（如 `--bogus`）直接放行；(b) `xargs` 后接 wrapper/sudo/env 链（`xargs sudo tee`、`xargs env … tee`、`xargs -I{} sh -c`）时 stdin 参数经多层透视无法枚举，旧实现豁免 wrapper 子命令；(c) scope 内可创建指向外部的硬链/软链（`ln -s /etc/passwd docs/link`、`cp -s` 外指），`ln`/`cp -l` 动态源旧实现忽略（`ln -s $S docs/link` 放行）；(d) `sed` 脚本 `w`/`W` 写命令、`s///w` 标记可外写（旧实现仅看 `-i`），`e` 执行、`-f` 脚本文件完全不可见。
- 修复 7（M 组锁定；其中 sed/xargs/ln/cp 链接的目标提取建模已被修复 8 的直接拒绝取代，相关解析器与旧断言已删除/改写，下述建模措辞不再保留）：`SAFE_CMD_OPTS` 逐命令选项白名单 + `parseSafeReadonlyOperands`（保留至今，修复 8 收紧为严格形态，见下）；`test`/`[` 自由形、`:` 空操作、`head/tail -NUM` 放行（保留至今）。
- 问题 8（reviewer 最新 FAIL，N 组封堵，不再支持高风险复杂语义）：(a) sed 全形态（即使只读 `sed -n`）旧实现建模脚本并放行只读者；(b) xargs 全形态旧实现透视子命令（`xargs echo` 放行）；(c) ln 全形态、`cp -l/--link/-s`（任意位置）旧实现建模链接源并放行仓库内源；(d) `sort`/`uniq`/`less`/`diff` 只读解析中 `-` 占位处理不一致（`sort -o -` 把 `-` 误作文件目标），`uniq`/`diff` 操作数个数无约束。
- 修复 8（N 组锁定，不是沙箱）：scope 激活时直接拒绝 sed 全形态、xargs 全形态、ln 全形态、cp 链接模式（`cpLinkMode` 全词扫描任意位置，尊重 `--`），不再做任何目标提取（重定向目标仍常规捕获）；分发层包装器子命令位同样拦截（`sudo sed` 等一并拒绝）；删除死代码 `parseSedOperands`/`stripSedAddressFrag`/`parseSedScriptWrites`/`parseLnOperands`/`checkLinkSource`/`checkLinkSources`（`cpLinkMode` 保留供分发层预检）与 `isKnownShellCommand`；`parseSafeReadonlyOperands` 收紧为严格参数形态——输出 `-` 一律按 stdout（不再误作文件），`-` 输入占位计入操作数位置，`uniq`/`diff` 超量操作数拒绝，有文件输出位置时 `-` 输入占位一律拒绝（`sort -o /tmp/x -`、`uniq - /tmp/u`），无输出时 `-` 照常允许（`sort -o -`、`cat -`）；旧 sed/xargs/ln/cp -l 目标提取测试全部改写为直接拒绝断言，新增 `-`/超量操作数测试；`stateSection` Rules 与文件头同步（deny 措辞，删除建模声明）。

- 问题 9（reviewer 最新 FAIL，O 组封堵）：(a) `cpLinkMode` 旧实现遇首个操作数即停——`cp a b -l`、`cp a --link b` 等后置/任意位置链接开关漏报，包装器下（`sudo cp -s`、`env cp -l`）未单列测试；(b) `sort` 白名单含未核实选项（`--compress-program` 可执行外部程序、`--temporary-directory` 可外写、`--parallel` 等），`uniq --group`（可选参数）误消费下词导致输出漏检，`diff --unified/--context`（可选行数）同理；(c) GNU diff 根本无 `--output` 选项，旧 `diff --output` 测试与文档为空转声明。
- 修复 9（O 组锁定，不是沙箱）：`cpLinkMode` 改写为完整词列扫描（任意位置，尊重 `--`、跳过 `-t/-S` 取值，短簇逐字母、`-S` 与 `-s` 严格区分大小写）；`sort` 白名单收缩为逐个核实项（b/d/f/g/i/M/n/R/r/s/u/V/c/C/h/z/m、-k/-t/-S 取值、-o 输出；`--check` 归 skip；删除 temporary-directory/compress-program/parallel 等），`uniq --group`/`diff --unified/--context` 移入 boolLongs（可选参数不再吞下词）；删除 `diff outLongs`、`diff --output` 测试与全部文档声明（`--output` 未知选项即拒绝）；新增后置/包装器链接测试 8 项、sort 禁用选项测试 5 项、端到端 2 项；旧 `diff --output` 断言改为未知选项拒绝。

- 问题 10（reviewer 最新 FAIL，P 组封堵）：(a) 动态词仅在命令名/特定工具位置拒绝——`cat $F`、`grep $PAT f`、`echo $(date)`、反引号操作数、`sudo -u $U` 取值、`sort -k $K`、`find $DIR`、`VAR=$X` 等参数位动态旧实现按无目标放行；(b) 环境赋值 `VAR=...` 前缀与 `env`/`sudo` 透视链中的 `VAR=` 旧实现一律跳过——TMPDIR/TMP/TEMP（临时文件重定向）、PATH/LD_PRELOAD（加载劫持）、未知变量、`env -S` 分裂字符串（赋值藏匿）均可注入。
- 修复 10（P 组锁定，不是沙箱）：`analyzeShellWritesInner` 主循环前新增全参数位动态扫描——任一 `word` token `dynamic` 即 `dynamic argument` fail-closed（纯 `$((…))` 算术 `dynamic=false` 豁免，合法静态路径不受影响；`echo $((1+2))`、`LC_ALL=C sort` 照常放行）；新增 `SAFE_ENV_VARS` 显式白名单（LC_*/LANG/LANGUAGE/TZ/TERM/NO_COLOR/CLICOLOR/CLICOLOR_FORCE）+ `checkEnvAssignment`——普通分发与包装器透视两处 `VAR=` 分支逐项校验，未知变量（TMPDIR/TMP/TEMP/PATH/LD_PRELOAD 等）一律 `unsafe env assignment` 拒绝；`env` 包装器新增 `-S/--split-string`（含短簇 `S`）直接拒绝（分裂字符串藏匿赋值）；旧 `cp $S` 文件 dest 放行与 `: ${x:=1}` 放行断言按新语义改为拒绝，新增 P 组 27 项（动态 11 项 + env 白名单 11 项 + 端到端 5 项）。

- 问题 11（reviewer 最新 FAIL，Q 组封堵）：(a) `env` 在 scope 模式下对未知 `-x`/长选项走通用跳过（含 `--spl` 等长选项缩写直接放行）；(b) 双引号内字面 `$`（行尾/后跟空格标点）旧实现一律置 dynamic——`echo "total $"`、`grep "a$"` 等只读命令被误杀。
- 修复 11（Q 组锁定，不是沙箱）：`env` 包装器分支改显式安全白名单（`-i/-0/-v` 开关，`-u/--unset/--argv0` 取值，`--ignore-environment/--null/--verbose/--block-signal/--default-signal/--ignore-signal/--help/--version` 开关）——未知短/长选项（含缩写）一律 `unknown env option` 拒绝，禁止通用跳过；`-S/--split-string`（含短簇 `S`）保持直接拒绝；分词器新增 `isShellExpansion`/`hasShellExpansion`（`SHELL_EXPAND_NEXT_BARE` 含引号、`SHELL_EXPAND_NEXT_DQUOTE` 剔除引号）——双引号内 `$"`/`$'` 按字面处理，`$` 后空格/标点/结尾不再置 dynamic，真实展开（变量/特殊参数/`$(`/`${`/反引号）仍拒绝；旧误杀断言改为放行，新增 Q 组 26 项（env 白名单 14 项 + 字面 `$` 8 项 + 端到端 4 项）。- `/dev/null` 特判去留结论（修正旧声明）：保留精确等于 `/dev/null` 的单项跳过，不移除。理由有二：(1) 移除会拦断遍地的 `> /dev/null 2>&1` 合法写法，破坏实现期正常流程；(2) 保留之所以现在安全，是因为枚举已完整且是**逐项**校验——`tee /dev/null /tmp/evil` 中的后者仍被拒绝（H/I 组回归测试锁定）。
  旧声明“枚举完整故安全”仍然成立，但实现已从“正则枚举”升级为“分词器枚举”，特判位置从出站分类收敛到统一的 `classifyShellTarget`。
- 合法例外最小化结论（更新）：edit/write 通道无例外；shell 目标层仅精确 `/dev/null`（`2>&1` 类纯 fd 操作根本不产生目标，连特判都不需要）。`/tmp` 草稿、`~/`、`../` 在事务期间一律拒绝——模型应把草稿写进仓库内 scope 路径，或先 reset/close 事务。
- 系统提示同步：`stateSection` Rules 行追加 outside 默认拒绝 + fail-closed 说明（测试锁定 "denied by default" 仍在）。
- 与 OpenCode 原插件的语义差异（有意，不伪称为等价）：(a) `2>&1`、`>&2` 类纯 fd 操作不再算“写”（原 looks-like 正则误判 → review 期误拦；现精确放行，白名单内只读命令如 `echo hi 2>&1 | head -5` 放行）；(b) 高风险语义直接拒绝：sed 全形态、xargs 全形态、ln 全形态、cp 链接模式 scope 激活时一律拒绝（原插件无此概念）；(c) `echo tee /tmp/x`（tee 仅作其他命令的参数）不再误伤（原正则把参数当目标）；(d) 无法安全判定的命令（未闭合引号/替换、动态重定向目标、动态 tee 操作数、动态 sh -c/eval、glob 写目标、未闭合 heredoc、超深嵌套、未知命令/选项、`find` 写动作）一律拒绝，原插件无此兜底；(e) `>(…)`/`<…>` 进程替换、`sh -c`/`eval` 内层代码被复解析（原插件完全看不见）；(f) 动态命令词一律拒绝、标准委托包装器链透视、`$((…))` 不误报——原插件三处正则对此三类输入或漏或误，无对应行为；(g) dd/touch/rm/mkdir/rmdir/shred/truncate/install/cp/mv/sudoedit/sort -o/uniq 输出/less -o 逐项校验、mv 源删除一并校验、sudo -e 编辑模式——原插件对此类命令完全不可见（open/review 双期放行）；(h) 白名单外未知命令（`git`/`python`/`make`/`npm`/`curl`/`chmod` 等，解释器内部写 shell 层不可见）一律拒绝，只读命令未知选项亦拒绝，旧实现按无目标放行；(i) cp/install 单源 dest 为已存在目录（或尾斜杠）时 join basename，动态源此时拒绝（旧实现误作文件 dest）。
- 限制（已知残留缺口，不伪称完成、不声称 Bash 是完整沙箱）：Copy-Item、awk 脚本内 `w` 命令写文件、`source script.sh`/`sh script.sh` 执行脚本文件、未知自定义包装器（公司内部 wrapper、strace/ltrace/gdb 类调试器透传、GNU parallel 等任务分发器）、`env -S` 分裂字符串内的隐含命令，均不解析写目标——open 期可能漏过；Bash 门禁只收敛入口，模型应优先用 edit/write 工具。
  `echo x>src/evil` 这类无空格紧贴相对路径、`word> /abs`、`>|`、带路径/引号 tee、`find -exec tee {}`（现按 `find` 写动作直接拒绝，不再仅靠提 `{}`）、`xargs tee`（现按 stdin 未知集合从严）、标准委托链（timeout/stdbuf/sudo/su/runuser/chroot/unshare/setsid/flock/time/env/nice/ionice/taskset/numactl/nohup/command/builtin/exec/watch/busybox/nsenter）、dd/touch/rm/mkdir/rmdir/shred/truncate/install/cp/mv/ln/sudoedit 均已被分词器/WRAPPER_SPECS/新解析器覆盖，不再是缺口。`>(…)` 进程替换内层已复解析，不再是过度拦断。`blocked` 事务内存态。
- 测试：speckit 套件 76→90（G 组）→103（H 组）→149（I 组 46 项）→175（J 组 26 项）→245（K 组 70 项）→287（L 组 42 项）→333（M 组 46 项）→344（N 组 11 项）→360（O 组 16 项）→387（P 组 27 项）→413（新增 Q 组 26 项：env 白名单 14 项 + 字面 `$` 8 项 + 端到端 4 项；动态 11 项 + env 白名单 11 项 + 端到端 5 项；旧 `cp $S` 文件 dest 与 `: ${x}` 放行断言按新语义改为拒绝；旧 `cmd`/`make` 占位断言改为白名单内 `echo`/`ls`；H 组 `sed -i` 旧 quirk 断言已删除（sed 直接拒绝）；`SHELL_WRITE_RE` 字面 parity 检查已删除并断言其不存在，OFFICIAL_RE/MODIFY_RE 仍与原文案字面一致）；formula 6/6 仍过（guard 19/19 为删除前记录；该扩展与测试已删除）；`--strip-types --check` 删除前五扩展全过，删除后当前四个扩展已复验通过；
  真机 Pi 冒烟（flash 回“好的”，exit 0，仅既有 pi-lsp-adapter 警告；在 K 组加固后复验通过）。
- OpenCode 侧：原插件三文件零改动（本修复仅收紧 Pi 移植，不碰原插件）。
