/**
 * speckit-rework-gate — Pi 本地扩展（OpenCode `plugins/speckit-rework-gate.ts` 的功能等价改写）。
 *
 * 已有 Spec Kit feature 的返工门禁：正常 `/speckit.*` 流程完全旁路；
 * 普通修改请求必须先评估上游影响，只对受影响层及其下游依赖过门，之后才允许碰实现层。
 * 无紧急绕过。只在检测到 Spec Kit 项目时生效。
 *
 * OpenCode → Pi 行为映射（详见 handoff）：
 * - `tool.transform` 注册 7 工具 → `pi.registerTool` × 7（同名、同描述、同参数约束，
 *   归入 `speckit_rework` 命名空间；返回体仍是 `{ok,...}` JSON 字符串，只是装进
 *   Pi 的 `content: [{type:"text"}]` 信封，`details` 携带同一对象）。
 * - `session.hook("prompt")` → `pi.on("input")`（用户输入前；Pi 无 subagent 转发，
 *   仅用户/RPC/扩展输入触发）。
 * - `session.hook("context")` 的 system 注入 → `pi.on("before_agent_start")` 改写
 *   `systemPromptOptions.sections["speckit-rework-gate"]`（每轮 run 起始注入一次，
 *   而非每次 LLM 调用；阶段推进仍经工具返回告知模型）。
 * - `permission.hook("evaluate")` 的 edit/shell 拦截 → `pi.on("tool_call")` 返回
 *   `{block:true, reason}`（edit/write/带 path 的自定义工具走路径分类；
 *   bash/powershell 走 shell 写命令启发式；`!` 前缀命令走 `user_bash` 抛错拦截）。
 * - 会话身份：OpenCode 用 sessionID + parentID 链继承事务；Pi 用
 *   `sessionFile ?? sessionId ?? cwd` 做键，无父子链。fork/resume 时经
 *   `session_start(previousSessionFile)` 继承，其余情况不继承。
 * - `resolveRoot`：Pi 单 cwd 模型，直接从 `ctx.cwd` 向上找 `.specify`+`specs`，
 *   无需异步 parent 链查询（同步实现）。
 *
 * 明确不等价（已报告，不伪称完成）：
 * 1. OpenCode `edit` 动作覆盖所有写文件通道；Pi 第三方 MCP 写文件工具若不用
 *    `path` 命名字段，则不在拦截范围内（本扩展只处理 edit/write/bash/
 *    powershell/含字符串 path 的自定义调用 + user_bash）。
 *    Bash 侧只做“门禁”（scope 白名单 + 已知写命令解析 + 全参数位动态拒绝 +
 *    环境赋值白名单 + fail-closed），不是完整沙箱：解释器内部写
 *    （`python -c 'open(...)'`、`node -e`、`perl`、`curl | sh` 落盘、
 *    `git checkout`、`npm install` 等）一律按未知命令拒绝，任何参数位的
 *    动态词/命令替换/反引号一律拒绝，非白名单环境赋值（TMPDIR/TMP/TEMP、
 *    PATH/LD_PRELOAD、未知变量、`env -S` 分裂注入）一律拒绝，
 *    但模型仍应优先用 edit/write 工具；残留缺口见下。
 * 2. shell 写检测相对原插件做了有意加强（原为三处正则启发式，见 handoff）：
 *    本移植用手写 shell 词法分析器（引号/转义/操作符/命令替换/算术/测试括号/
 *    heredoc 全感知）替代零散正则，并对无法安全解析的命令 fail-closed。
 *    与原插件的已知语义差异：(a) `2>&1`、`>&2` 等纯 fd 操作不再算“写”
 *    （原 looks-like-write 误判 → review 期误拦；现精确放行）；
 *    (b) 高风险语义直接拒绝：sed 全形态、xargs 全形态、ln 全形态、
 *    cp 链接模式（-l/--link/-s 任意位置）scope 激活时一律拒绝（原插件无此概念）；
 *    (c) `echo tee /tmp/x`（tee 仅作其他
 *    命令的参数）不再误伤（原正则把参数当目标）；(d) 无法安全判定的命令
 *    （未闭合引号/替换、动态重定向目标、动态 tee 操作数、动态 sh -c/eval、
 *    glob 写目标、未闭合 heredoc、动态命令词、超深嵌套）一律拒绝，原插件无此兜底。
 *    (e) 动态命令词（`$T`、`$(…)`、反引号、`${…}` 作命令词）按“最终命令未知”
 *    拒绝；`$((…))` 纯算术展开单独区分、正确跳过（不误作命令替换、不触发
 *    动态命令拒绝，内部 `>` 不视为重定向）；(f) 委托包装器链
 *    （sudo/doas/su/runuser/chroot/unshare/setsid/flock/timeout/stdbuf/env/nice/
 *    ionice/taskset/numactl/nohup/time/command/builtin/exec/xargs/watch/busybox/nsenter）按
 *    WRAPPER_SPECS 通用机制透视找真实子命令（含 `-c` 代码、`-o` 自身输出、
 *    前置位置参数、`--`、sudo -e 编辑模式、runuser 条件 user 跳过），子命令动态则拒绝——
 *    不是只补 timeout/stdbuf 两个字符串。布尔开关绝不消费下一词
 *    （如 flock -x、command -p、timeout --foreground），取参选项严格消费一个参数；
 *    无法判定时拒绝。
 *    (g) 常见静态写删命令逐项校验：dd（仅 of=）、touch/rm/mkdir/rmdir/shred/truncate/
 *    sudoedit（操作数即文件，动态/glob/算术从严）、install/cp/mv（-t/-d/-D 规则，
 *    mv 的源删除同属修改一并校验；cp 链接模式直接拒绝）。原插件对此类命令
 *    完全不可见（open 期放行、review 期亦放行）。
 *    (h) 高风险复杂语义直接拒绝（不再建模）：sed 全形态、xargs 全形态、
 *    硬链/软链创建（ln 全形态、cp -l/--link/-s/--symbolic-link 任意位置）。
 * 3. `blocked` 事务在 Pi 重启/扩展 reload 后消失（内存态，与原插件一致）。
 * 4. 有意加固（相对原插件的偏离，非等价）：原插件对仓库外写入全放行
 *    （`outside → continue` 三处：edit 循环 + outOfScopeTargets 的 `~`/绝对路径越界/
 *    相对路径越界），scope 又只能声明仓库相对 glob，构成绕过。本移植在事务存续
 *    的任何阶段默认拒绝仓库外写入（checkPathWrite 首判 + outOfScopeTargets 收紧）；
 *    唯一明确最小例外是精确等于 `/dev/null` 的单个目标（空设备汇点，无持久化；
 *    枚举完整后逐项校验，`tee /dev/null /tmp/evil` 中的后者仍被拒绝——移除特判会
 *    拦断遍地的 `> /dev/null 2>&1` 合法写法，故保留精确匹配而非移除）。
 *    shell 目标提取覆盖带路径/引号的 tee 调用（`/usr/bin/tee`、`"tee"`）、
 *    `>|`、`word> /abs` 紧贴与空格形式、`>(…)` 进程替换内命令（复解析）；
 *    `(( x > 3 ))` 算术比较、`[[ … ]]` 测试、`$((…))` 算术展开、`<<<` herestring、
 *    heredoc 主体不视为写（主体内命令替换仍复解析）。
 *    读操作（read/grep/find/ls 及无 path 字段的调用）不受影响。
 * 5. 残留缺口（记录在案，不伪称完成、不声称 Bash 是完整沙箱）：Copy-Item、
 *    awk 脚本内 `w` 命令写文件、`source script.sh`/`sh script.sh` 执行脚本文件、
 *    未知自定义包装器（如公司内部 wrapper、strace/ltrace/gdb 类调试器透传、
 *    GNU parallel 等任务分发器）、`env -S` 分裂字符串内的隐含命令，
 *    均不解析写目标——open 期可能漏过。
 *    `echo x>src/evil` 这类无空格紧贴相对路径、`find -exec`（按 `find` 写动作
 *    直接拒绝）、标准委托链（timeout/stdbuf/sudo/su/runuser/
 *    chroot/unshare/setsid/flock/time/env/nice/ionice/taskset/numactl/nohup/
 *    command/builtin/exec/watch/busybox/nsenter）、dd/touch/rm/mkdir/rmdir/
 *    shred/truncate/install/cp/mv/sudoedit/sort -o/uniq 输出/less -o
 *    均已被分词器/WRAPPER_SPECS/新解析器覆盖，不再是缺口（GNU diff 无 --output
 *    文件输出选项，不设此模型）；
 *    sed/xargs/ln/cp 链接模式 scope 激活时直接拒绝（不建模）。
 *    scope 激活时（implementation-open）Bash 另做显式白名单：
 *    仅 SAFE_READONLY（逐命令严格选项形态：未知选项拒绝，sort -o/uniq 输出/
 *    less -o 计入写目标，uniq 第二操作数为输出、uniq/diff 操作数个数受限，`-` 仅在
 *    确为 stdin 且无文件输出位置时允许；test/[ 自由形）+ 已建模写命令放行，
 *    未知命令、`find` 写动作一律 fail-closed；任何参数位动态词/命令替换/
 *    反引号一律拒绝（纯静态路径与纯 `$((…))` 算术除外）；环境赋值仅
 *    SAFE_ENV_VARS 白名单放行（TMPDIR/TMP/TEMP、`env -S`、未知变量拒绝）。
 *    write/edit/bash 路径另做 realpath/lstat symlink 越界检查：
 *    仓库内 symlink 指到仓库外（或指到 scope 外）一律拒绝。
 *    cp/install 单源 dest 为已存在目录（或尾斜杠）时 join basename，
 *    动态源此时 fail-closed（目录误判修复）。
 *    本扩展是门禁不是沙箱：Bash 仍有残留缺口，模型应优先用 edit/write 工具。
 */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export type Stage = "spec" | "plan" | "tasks" | "checklists";
export type Phase =
  | "needs-feature"
  | "impact-pending"
  | "spec-pending"
  | "plan-pending"
  | "tasks-pending"
  | "checklists-pending"
  | "implementation-open"
  | "closed"
  | "blocked";

export interface Txn {
  root: string;
  featureDir: string; // 相对项目根，如 specs/001-foo
  phase: Phase;
  affectedStages: Stage[];
  scope: string[]; // 评估时申报的可写文件 glob（仓库相对），实现阶段硬约束
  snapshots: Record<string, string>; // relpath -> sha256，门之间做 hash 对比
  summaries: Partial<Record<Stage | "impact", string>>;
  blockReason?: string;
}

const MAX_SESSIONS = 200;
const txns = new Map<string, Txn>();
const rootCache = new Map<string, string | null>();

export const OFFICIAL_RE = /speckit[\.\-:]/i;
export const MODIFY_RE =
  /修|改|增|加|重构|实现|修复|删|优化|调整|更新|补丁|支持|完成|迁移|重写|fix|bug|implement|refactor|rework|revise|polish|optimiz|add|update|change|modify|support|feature|migrat|rewrit/i;

export function touchTxn(sessionKey: string, txn: Txn) {
  txns.delete(sessionKey);
  txns.set(sessionKey, txn);
  if (txns.size > MAX_SESSIONS) {
    const oldest = txns.keys().next().value;
    if (oldest) txns.delete(oldest);
  }
}

export function deleteTxn(txn: Txn) {
  for (const [sessionKey, candidate] of txns.entries()) {
    if (candidate === txn) txns.delete(sessionKey);
  }
}

function cacheRoot(sessionKey: string, root: string | null) {
  rootCache.delete(sessionKey);
  rootCache.set(sessionKey, root);
  if (rootCache.size > MAX_SESSIONS) {
    const oldest = rootCache.keys().next().value;
    if (oldest) rootCache.delete(oldest);
  }
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function hashFile(abs: string): string | null {
  try {
    if (!statSync(abs).isFile()) return null;
    return sha256(readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

// 目录整体 hash（用于 contracts/ 等目录）：排序后拼接文件 hash。
export function hashDir(abs: string): string | null {
  try {
    if (!statSync(abs).isDirectory()) return null;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        const p = path.join(dir, name);
        try {
          const st = statSync(p);
          if (st.isDirectory()) walk(p);
          else if (st.isFile()) files.push(p);
        } catch {
          // 忽略单个不可读文件
        }
      }
    };
    walk(abs);
    if (files.length === 0) return "empty-dir";
    return sha256(files.map((f) => `${f}:${hashFile(f)}`).join("\n"));
  } catch {
    return null;
  }
}

export function hashPath(abs: string): string | null {
  try {
    const st = statSync(abs);
    return st.isDirectory() ? hashDir(abs) : hashFile(abs);
  } catch {
    return null;
  }
}

export function findProjectRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 6; i++) {
    try {
      if (
        statSync(path.join(dir, ".specify")).isDirectory() &&
        statSync(path.join(dir, "specs")).isDirectory()
      ) {
        return dir;
      }
    } catch {
      // 继续向上找
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function readFeaturePointer(root: string): string {
  try {
    const raw = readFileSync(path.join(root, ".specify", "feature.json"), "utf8");
    const data = JSON.parse(raw) as { feature_directory?: unknown };
    return typeof data.feature_directory === "string" ? data.feature_directory : "";
  } catch {
    return "";
  }
}

export interface FeatureCandidate {
  directory: string;
  hasSpec: boolean;
  hasPlan: boolean;
  hasTasks: boolean;
  completedTasks: number;
  eligible: boolean;
  reason: string;
}

export function countBoxes(text: string): { total: number; checked: number } {
  const total = (text.match(/^- \[[ xX]\]/gm) ?? []).length;
  const checked = (text.match(/^- \[[xX]\]/gm) ?? []).length;
  return { total, checked };
}

export function listFeatures(root: string): FeatureCandidate[] {
  const specsDir = path.join(root, "specs");
  let names: string[] = [];
  try {
    names = readdirSync(specsDir)
      .filter((n) => {
        try {
          return statSync(path.join(specsDir, n)).isDirectory() && !n.startsWith(".");
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
  return names.map((n) => {
    const dir = path.posix.join("specs", n);
    const abs = path.join(root, dir);
    const hasSpec = hashFile(path.join(abs, "spec.md")) !== null;
    const hasPlan = hashFile(path.join(abs, "plan.md")) !== null;
    const hasTasks = hashFile(path.join(abs, "tasks.md")) !== null;
    let completedTasks = 0;
    if (hasTasks) {
      try {
        completedTasks = countBoxes(readFileSync(path.join(abs, "tasks.md"), "utf8")).checked;
      } catch {
        completedTasks = 0;
      }
    }
    const eligible = hasSpec && hasPlan && hasTasks && completedTasks > 0;
    let reason = "ok";
    if (!hasSpec || !hasPlan || !hasTasks) reason = "missing-artifacts";
    else if (completedTasks === 0) reason = "never-implemented";
    return {
      directory: dir,
      hasSpec,
      hasPlan,
      hasTasks,
      completedTasks,
      eligible,
      reason,
    };
  });
}

export function pointedEligibleFeature(root: string): FeatureCandidate | null {
  const pointer = readFeaturePointer(root);
  if (!pointer) return null;
  const normalized = path.posix.normalize(pointer.replace(/\\/g, "/"));
  if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) return null;
  const feature = listFeatures(root).find((candidate) => candidate.directory === normalized);
  return feature?.eligible ? feature : null;
}

export function snapshotFeature(root: string, featureDir: string): Record<string, string> {
  const snap: Record<string, string> = {};
  const take = (rel: string) => {
    const h = hashPath(path.join(root, rel));
    if (h !== null) snap[rel] = h;
  };
  take(path.posix.join(featureDir, "spec.md"));
  take(path.posix.join(featureDir, "plan.md"));
  take(path.posix.join(featureDir, "research.md"));
  take(path.posix.join(featureDir, "data-model.md"));
  take(path.posix.join(featureDir, "quickstart.md"));
  take(path.posix.join(featureDir, "contracts"));
  take(path.posix.join(featureDir, "tasks.md"));
  return snap;
}

export function stageFiles(featureDir: string, stage: Stage): string[] {
  if (stage === "spec") return [path.posix.join(featureDir, "spec.md")];
  if (stage === "tasks") return [path.posix.join(featureDir, "tasks.md")];
  return [
    path.posix.join(featureDir, "plan.md"),
    path.posix.join(featureDir, "research.md"),
    path.posix.join(featureDir, "data-model.md"),
    path.posix.join(featureDir, "quickstart.md"),
    path.posix.join(featureDir, "contracts"),
  ];
}

export function phaseForStage(stage: Stage): Phase {
  return `${stage}-pending` as Phase;
}

export function nextAffectedPhase(txn: Txn, current: Stage): Phase {
  const index = txn.affectedStages.indexOf(current);
  const next = txn.affectedStages[index + 1];
  return next ? phaseForStage(next) : "implementation-open";
}

export function expectedStage(phase: Phase): Stage | null {
  if (phase === "spec-pending") return "spec";
  if (phase === "plan-pending") return "plan";
  if (phase === "tasks-pending") return "tasks";
  if (phase === "checklists-pending") return "checklists";
  return null;
}

// checklist 只读扫描：无 checklists 目录 / 无有效 checkbox 则跳过；
// 只要存在一个未勾选就阻止实现。
export function scanChecklists(
  root: string,
  featureDir: string,
): {
  skipped: boolean;
  pass: boolean;
  detail: string;
} {
  const dir = path.join(root, featureDir, "checklists");
  try {
    if (!statSync(dir).isDirectory()) return { skipped: true, pass: true, detail: "no checklists dir" };
  } catch {
    return { skipped: true, pass: true, detail: "no checklists dir" };
  }
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((n) => n.endsWith(".md"))
      .sort();
  } catch {
    return { skipped: true, pass: true, detail: "unreadable checklists dir" };
  }
  let total = 0;
  let unchecked = 0;
  const perFile: string[] = [];
  for (const f of files) {
    try {
      const text = readFileSync(path.join(dir, f), "utf8");
      const { total: t, checked: c } = countBoxes(text);
      total += t;
      unchecked += t - c;
      perFile.push(`${f}: ${c}/${t}`);
    } catch {
      // 忽略单个不可读文件
    }
  }
  if (total === 0) return { skipped: true, pass: true, detail: "no checkbox items" };
  return {
    skipped: false,
    pass: unchecked === 0,
    detail: perFile.join("; "),
  };
}

export type PathKind =
  | { kind: "outside" }
  | { kind: "infra" }
  | { kind: "speckit-cmd" }
  | { kind: "spec"; stage: Stage; rel: string }
  | { kind: "impl"; rel: string };

// ---- symlink 越界防护（realpath/lstat） ----
//  lexical 上在仓库内，但经 symlink 解析后落到仓库外的写入一律视为 outside。
//  只对已存在前缀做解析（新建文件看父目录）；解析失败时若存在 symlink 成分
//  则从严视为越界（fail-closed），否则按 lexical 判定。
function lexicalAbs(root: string, resource: string): string {
  return path.isAbsolute(resource) ? path.normalize(resource) : path.join(root, resource);
}

function realRootOf(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

// 最长已存在前缀的 realpath + 剩余后缀；返回 null 表示无法安全解析。
function realAbsForWrite(root: string, absLex: string): string | null {
  let cur = absLex;
  const suffix: string[] = [];
  for (;;) {
    try {
      lstatSync(cur);
      break;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      suffix.unshift(path.basename(cur));
      cur = parent;
      // 走到 root 上方仍不存在：按 lexical 交给上层 outside 判定
      if (suffix.length > 64) return null;
    }
  }
  let realPrefix: string;
  try {
    realPrefix = realpathSync(cur);
  } catch {
    // 已存在但 realpath 失败（如悬空 symlink）：从严视为不可解析
    return null;
  }
  return suffix.length > 0 ? path.join(realPrefix, ...suffix) : realPrefix;
}

function escapesRoot(root: string, absLex: string): boolean {
  const rr = realRootOf(root);
  const realAbs = realAbsForWrite(root, absLex);
  if (realAbs === null) {
    // 无法解析时检查是否有 symlink 成分：有则从严越界，无则按 lexical
    try {
      let cur = absLex;
      for (let d = 0; d < 64; d++) {
        try {
          const st = lstatSync(cur);
          if (st.isSymbolicLink()) return true;
        } catch {
          // 不存在则向上
        }
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
        try {
          lstatSync(cur);
        } catch {
          continue;
        }
        // 继续向上找 symlink
      }
      return false;
    } catch {
      return true;
    }
  }
  const rel = path.relative(rr, realAbs);
  return rel === "" ? false : rel.startsWith("..") || path.isAbsolute(rel);
}

// 真实位置（realpath 解析后）相对 root 的 posix rel；无法解析返回 null。
export function realRelOf(root: string, resource: string): string | null {
  const absLex = lexicalAbs(root, resource);
  const realAbs = realAbsForWrite(root, absLex);
  if (realAbs === null) return null;
  const rr = realRootOf(root);
  const rel = path.relative(rr, realAbs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join(path.posix.sep);
}

export function classify(root: string, featureDir: string, resource: string): PathKind {
  const abs = lexicalAbs(root, resource);
  const rel = path.relative(root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return { kind: "outside" };
  if (escapesRoot(root, abs)) return { kind: "outside" };
  const parts = rel.split(path.sep);
  if (parts[0] === ".specify") return { kind: "infra" };
  if (parts[0] === ".opencode" && parts[1] === "commands" && (parts[2] ?? "").startsWith("speckit")) {
    return { kind: "speckit-cmd" };
  }
  const posix = rel.split(path.sep).join(path.posix.sep);
  const feat = featureDir.split(path.sep).join(path.posix.sep);
  if (posix === `${feat}/spec.md`) return { kind: "spec", stage: "spec", rel: posix };
  if (
    posix === `${feat}/plan.md` ||
    posix === `${feat}/research.md` ||
    posix === `${feat}/data-model.md` ||
    posix === `${feat}/quickstart.md` ||
    posix === `${feat}/contracts` ||
    posix.startsWith(`${feat}/contracts/`)
  ) {
    return { kind: "spec", stage: "plan", rel: posix };
  }
  if (posix === `${feat}/tasks.md`) return { kind: "spec", stage: "tasks", rel: posix };
  if (posix === `${feat}/checklists` || posix.startsWith(`${feat}/checklists/`)) {
    return { kind: "spec", stage: "checklists", rel: posix };
  }
  // 其他 feature 的产物一律视为冻结的 spec 工件
  if (posix.startsWith("specs/")) return { kind: "spec", stage: "spec", rel: posix };
  return { kind: "impl", rel: posix };
}

// shell 写检测不再使用 SHELL_WRITE_RE（已删除：逐个打补丁永远收不完，且
// `2>&1` 误判、`>|`/`word> /abs`/带路径 tee 等绕过收不完）。
// 统一走下面的 analyzeShellWrites() 可靠词法分析；shellLooksLikeWrite 保留
// 兼容签名，语义变为“存在静态写目标或无法安全判定”。

// scope glob 匹配：支持 **、*、?，仓库相对路径，统一用 posix 分隔符。
export function scopeMatch(glob: string, relPosix: string): boolean {
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  const p = relPosix.replace(/\\/g, "/");
  if (g === p) return true;
  // 转正则：先占位 **，再处理 * ?，最后还原 ** 为 .*
  const PH = "\u0000";
  let re = g.replace(/\*\*/g, PH).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  re = re.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  re = re.split(PH).join(".*");
  try {
    return new RegExp(`^${re}$`).test(p);
  } catch {
    return false;
  }
}

export function inScope(scope: string[], relPosix: string): boolean {
  return scope.some((g) => scopeMatch(g, relPosix));
}

// ================= shell 可靠词法分析（替代零散正则） =================
// 动因：重定向/tee 的写法太多（`>|`、`word> /abs`、带路径/引号的 tee 命令、
// fd 复制 `2>&1`、紧贴式 `2>f`……），逐个打正则补丁永远收不完，且每个补丁都
// 可能误伤合法写法。此处实现一个小而完备的分词器 + 结构解析：单/双引号、
// 转义、操作符、$( )/反引号/${ }/算术/测试括号/heredoc 全感知；
// 凡无法安全判定写目标的一律 uncertain → 调用侧 fail-closed（默认拒绝）。
export interface ShellAnalysis {
  /** 静态可判定的文件写目标（原样，未归一化；去重、保序） */
  targets: string[];
  /** true = 存在无法安全判定的写行为，调用侧必须拒绝 */
  uncertain: boolean;
  /** uncertain 原因（稳定短语，便于测试与排错） */
  reasons: string[];
}

type ShellTok =
  | { kind: "word"; value: string; dynamic: boolean; glob: boolean; arith: boolean }
  | { kind: "op"; value: string }
  | { kind: "subst"; text: string };

interface ShellScan {
  tokens: ShellTok[];
  /** 需完整复解析的命令型替换体（$( )、反引号、>( )、<( ) 内部原文） */
  cmdSubsts: string[];
  uncertain: boolean;
  reasons: string[];
}

// 配对结构扫描：s[start] 为开标记之后的位置（`$(` / `${` /反引号/`((`/`[[`/
// `>(`/`<( 之内），mode 决定闭合规则。返回闭合符之后的位置。
function balanceSpan(s: string, start: number, mode: "paren" | "brace" | "dquote" | "backtick" | "squote" | "test"): { end: number; ok: boolean } {
  const n = s.length;
  let depth = 1;
  let i = start;
  const isParen = mode === "paren";
  while (i < n) {
    const c = s[i];
    if (mode === "squote") {
      if (c === "'") return { end: i + 1, ok: true };
      i++;
      continue;
    }
    if (mode === "dquote" || mode === "backtick") {
      const closer = mode === "dquote" ? '"' : "`";
      if (c === "\\") { i += 2; continue; }
      if (c === closer) return { end: i + 1, ok: true };
      if (c === "$" && (s[i + 1] === "(" || s[i + 1] === "{")) {
        const r = balanceSpan(s, i + 2, s[i + 1] === "(" ? "paren" : "brace");
        if (!r.ok) return { end: n, ok: false };
        i = r.end;
        continue;
      }
      if (c === "`") {
        const r = balanceSpan(s, i + 1, "backtick");
        if (!r.ok) return { end: n, ok: false };
        i = r.end;
        continue;
      }
      i++;
      continue;
    }
    if (c === "\\") { i += 2; continue; }
    if (c === "'") {
      const r = balanceSpan(s, i + 1, "squote");
      if (!r.ok) return { end: n, ok: false };
      i = r.end;
      continue;
    }
    if (c === '"') {
      const r = balanceSpan(s, i + 1, "dquote");
      if (!r.ok) return { end: n, ok: false };
      i = r.end;
      continue;
    }
    if (c === "`") {
      const r = balanceSpan(s, i + 1, "backtick");
      if (!r.ok) return { end: n, ok: false };
      i = r.end;
      continue;
    }
    if (c === "$" && (s[i + 1] === "(" || s[i + 1] === "{")) {
      const r = balanceSpan(s, i + 2, s[i + 1] === "(" ? "paren" : "brace");
      if (!r.ok) return { end: n, ok: false };
      i = r.end;
      continue;
    }
    if (isParen) {
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) return { end: i + 1, ok: true };
      }
      i++;
      continue;
    }
    if (mode === "brace") {
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return { end: i + 1, ok: true };
      }
      i++;
      continue;
    }
    // test 模式：找 "]]"
    if (c === "]" && s[i + 1] === "]") return { end: i + 2, ok: true };
    i++;
  }
  return { end: n, ok: false };
}

// 从文本中提取顶层命令替换体（$( )、反引号、>( )、<( ) 内部原文）。
// ${ } / $(( )) / (( )) / [[ ]] / heredoc 主体内部如含命令替换也一并提取。
// 单双引号内的命令替换同样会被执行，一并提取；返回 balanced 标识配对完整性。
function collectCmdSubsts(text: string, out: { inners: string[]; ok: boolean }): void {
  const n = text.length;
  let i = 0;
  const scanDquote = (): boolean => {
    // s[i] === '"'；收集其中嵌套的命令替换，返回配对是否完整
    // $(( )) 算术展开不是命令替换：只扫描其内部嵌套，不把整体当命令体。
    let j = i + 1;
    while (j < n) {
      const c = text[j];
      if (c === "\\") { j += 2; continue; }
      if (c === '"') { i = j + 1; return true; }
      if (c === "$" && text[j + 1] === "(" && text[j + 2] === "(") {
        const r = balanceSpan(text, j + 2, "paren");
        if (!r.ok) { out.ok = false; return false; }
        collectCmdSubsts(text.slice(j + 2, r.end - 1), out);
        j = r.end;
        continue;
      }
      if (c === "$" && (text[j + 1] === "(" || text[j + 1] === "{")) {
        const r = balanceSpan(text, j + 2, text[j + 1] === "(" ? "paren" : "brace");
        if (!r.ok) { out.ok = false; return false; }
        if (text[j + 1] === "(") out.inners.push(text.slice(j + 2, r.end - 1));
        else collectCmdSubsts(text.slice(j + 2, r.end - 1), out);
        j = r.end;
        continue;
      }
      if (c === "`") {
        const r = balanceSpan(text, j + 1, "backtick");
        if (!r.ok) { out.ok = false; return false; }
        out.inners.push(text.slice(j + 1, r.end - 1));
        j = r.end;
        continue;
      }
      j++;
    }
    out.ok = false;
    return false;
  };
  while (i < n) {
    const c = text[i];
    if (c === "'") {
      const r = balanceSpan(text, i + 1, "squote");
      if (!r.ok) { out.ok = false; break; }
      i = r.end;
      continue;
    }
    if (c === '"') {
      if (!scanDquote()) break;
      continue;
    }
    if (c === "\\") { i += 2; continue; }
    if (c === "`") {
      const r = balanceSpan(text, i + 1, "backtick");
      if (!r.ok) { out.ok = false; break; }
      out.inners.push(text.slice(i + 1, r.end - 1));
      i = r.end;
      continue;
    }
    if (c === "$" && text[i + 1] === "(" && text[i + 2] === "(") {
      // $(( )) 算术展开：只收集内部嵌套命令替换，不把整体当命令体
      const r = balanceSpan(text, i + 2, "paren");
      if (!r.ok) { out.ok = false; break; }
      collectCmdSubsts(text.slice(i + 2, r.end - 1), out);
      i = r.end;
      continue;
    }
    if (c === "$" && text[i + 1] === "(") {
      const r = balanceSpan(text, i + 2, "paren");
      if (!r.ok) { out.ok = false; break; }
      out.inners.push(text.slice(i + 2, r.end - 1));
      i = r.end;
      continue;
    }
    if (c === "$" && text[i + 1] === "{") {
      const r = balanceSpan(text, i + 2, "brace");
      if (!r.ok) { out.ok = false; break; }
      collectCmdSubsts(text.slice(i + 2, r.end - 1), out);
      i = r.end;
      continue;
    }
    if ((c === ">" || c === "<") && text[i + 1] === "(") {
      const r = balanceSpan(text, i + 2, "paren");
      if (!r.ok) { out.ok = false; break; }
      out.inners.push(text.slice(i + 2, r.end - 1));
      i = r.end;
      continue;
    }
    i++;
  }
}

// shell 分词器：引号/转义/操作符全感知；heredoc 主体直接跳过（只扫描其中的
// 命令替换）；算术 (( ))、测试 [[ ]]、${ } 只做嵌套命令替换扫描，不解析内部。
function tokenizeShell(src: string): ShellScan {
  const tokens: ShellTok[] = [];
  const cmdSubsts: string[] = [];
  const reasons: string[] = [];
  let uncertain = false;
  const fail = (r: string) => { uncertain = true; reasons.push(r); };
  const collectInto = (text: string) => {
    const out = { inners: [] as string[], ok: true };
    collectCmdSubsts(text, out);
    cmdSubsts.push(...out.inners);
    if (!out.ok) fail("unbalanced substitution");
  };
  const n = src.length;
  let i = 0;
  const isSpace = (c: string) => c === " " || c === "\t" || c === "\r" || c === "\n";
  // 在 token 起始位置尝试匹配操作符（含 fd 前缀与 >| / &> 等），返回操作符原文或 null
  const matchOp = (p: number): string | null => {
    const rest3 = src.slice(p, p + 3);
    if (rest3 === "<<-" || rest3 === "&>>" || rest3 === "<<<" || rest3 === ">>|") return rest3;
    const rest2 = src.slice(p, p + 2);
    if (rest2 === "||" || rest2 === "&&" || rest2 === ";;" || rest2 === ">>" || rest2 === ">|" || rest2 === ">&" || rest2 === "<&" || rest2 === "<>" || rest2 === "&>" || rest2 === "<<" || rest2 === ">(" || rest2 === "<(") return rest2;
    const c = src[p];
    if (c === "|" || c === "&" || c === ";" || c === "(" || c === ")" || c === "{" || c === "}" || c === "!" || c === "<" || c === ">") return c;
    return null;
  };
  const skipLineComment = () => {
    while (i < n && src[i] !== "\n") i++;
  };
  // 解析一个词（含引号/转义/命令替换；返回 null 表示后面紧跟操作符或结束）
  // $(( )) 算术展开单独处理：只扫描内部嵌套命令替换，不把整体当命令体，
  // 不置 dynamic（纯算术的词 остаet arith=true；命令位置凭此豁免，目标位置仍从严）。
  const readWord = (): { value: string; dynamic: boolean; glob: boolean; quoted: boolean; arith: boolean } | null => {
    let value = "";
    let dynamic = false;
    let glob = false;
    let quoted = false;
    let arith = false;
    let advanced = false;
    // $(( )) 消费：返回是否成功；成功则收集内部嵌套、置 arith，不置 dynamic
    //（内部含 $/反引号时除外：那仍是动态，置 dynamic 以便命令位置从严）。
    const consumeArith = (pos: number): number | null => {
      const r = balanceSpan(src, pos + 2, "paren");
      if (!r.ok) { fail("unbalanced substitution"); return null; }
      const inner = src.slice(pos + 2, r.end - 1);
      collectInto(inner);
      arith = true;
      if (hasShellExpansion(inner)) dynamic = true;
      return r.end;
    };
    for (;;) {
      if (i >= n) break;
      const c = src[i];
      if (isSpace(c) || c === ";" || c === "&" || c === "|" || c === "<" || c === ">") break;
      if (c === "(" || c === ")" || c === "{" || c === "}" || c === "!") break;
      // 注意：行中 `#`（如 `a#b`）按 shell 语义是字面量，只有词首 `#` 才是注释；
      // 注释只在主循环 token 起始处识别，此处不截断，避免吞掉其后的真重定向。
      if (c === "'") {
        quoted = true;
        const r = balanceSpan(src, i + 1, "squote");
        if (!r.ok) { fail("unbalanced quote"); i = n; break; }
        value += src.slice(i + 1, r.end - 1);
        i = r.end;
        advanced = true;
        continue;
      }
      if (c === '"') {
        quoted = true;
        // 双引号内：处理转义，收集嵌套命令替换，$ 视为动态
        let j = i + 1;
        let closed = false;
        while (j < n) {
          const d = src[j];
          if (d === "\\" && j + 1 < n && "\"$`\\\n".includes(src[j + 1])) {
            value += src[j + 1] === "\n" ? "" : src[j + 1];
            j += 2;
            continue;
          }
          if (d === "\\") { value += "\\"; j++; continue; }
          if (d === '"') { closed = true; j++; break; }
          if (d === "$" && src[j + 1] === "(" && src[j + 2] === "(") {
            const r = balanceSpan(src, j + 2, "paren");
            if (!r.ok) { fail("unbalanced substitution"); j = n; break; }
            collectInto(src.slice(j + 2, r.end - 1));
            arith = true;
            if (hasShellExpansion(src.slice(j + 2, r.end - 1))) dynamic = true;
            j = r.end;
            continue;
          }
          if (d === "$" && (src[j + 1] === "(" || src[j + 1] === "{")) {
            const r = balanceSpan(src, j + 2, src[j + 1] === "(" ? "paren" : "brace");
            if (!r.ok) { fail("unbalanced substitution"); j = n; break; }
            if (src[j + 1] === "(") cmdSubsts.push(src.slice(j + 2, r.end - 1));
            else collectInto(src.slice(j + 2, r.end - 1));
            dynamic = true;
            j = r.end;
            continue;
          }
          if (d === "`") {
            const r = balanceSpan(src, j + 1, "backtick");
            if (!r.ok) { fail("unbalanced substitution"); j = n; break; }
            cmdSubsts.push(src.slice(j + 1, r.end - 1));
            dynamic = true;
            j = r.end;
            continue;
          }
          if (d === "$" && isShellExpansion(src, j, true)) dynamic = true;
          value += d;
          j++;
        }
        if (!closed) fail("unbalanced quote");
        i = j;
        advanced = true;
        continue;
      }
      if (c === "\\" && i + 1 < n) {
        value += src[i + 1];
        if (src[i + 1] === "\n") { /* 行续接 */ }
        i += 2;
        advanced = true;
        continue;
      }
      if (c === "`") {
        const r = balanceSpan(src, i + 1, "backtick");
        if (!r.ok) { fail("unbalanced substitution"); i = n; break; }
        cmdSubsts.push(src.slice(i + 1, r.end - 1));
        dynamic = true;
        i = r.end;
        advanced = true;
        continue;
      }
      if (c === "$" && src[i + 1] === "(" && src[i + 2] === "(") {
        const ne = consumeArith(i);
        if (ne === null) { i = n; break; }
        i = ne;
        advanced = true;
        continue;
      }
      if (c === "$" && src[i + 1] === "(") {
        const r = balanceSpan(src, i + 2, "paren");
        if (!r.ok) { fail("unbalanced substitution"); i = n; break; }
        cmdSubsts.push(src.slice(i + 2, r.end - 1));
        dynamic = true;
        i = r.end;
        advanced = true;
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        const r = balanceSpan(src, i + 2, "brace");
        if (!r.ok) { fail("unbalanced substitution"); i = n; break; }
        collectInto(src.slice(i + 2, r.end - 1));
        dynamic = true;
        i = r.end;
        advanced = true;
        continue;
      }
      if ((c === ">" || c === "<") && src[i + 1] === "(") {
        const r = balanceSpan(src, i + 2, "paren");
        if (!r.ok) { fail("unbalanced substitution"); i = n; break; }
        cmdSubsts.push(src.slice(i + 2, r.end - 1));
        dynamic = true;
        i = r.end;
        advanced = true;
        continue;
      }
      if (c === "$" && isShellExpansion(src, i)) dynamic = true;
      if (c === "*" || c === "?" || c === "[") glob = true;
      value += c;
      i++;
      advanced = true;
    }
    if (!advanced) return null;
    return { value, dynamic, glob, quoted, arith };
  };
  // heredoc 主体延迟跳过：`<<EOF > f` 中定界符后同一行的剩余部分（`> f`）
  // 仍是正常 token，必须继续解析；主体跳过推迟到换行时按登记顺序执行。
  interface PendingHeredoc { stripTabs: boolean; delimiter: string; quoted: boolean }
  const pending: PendingHeredoc[] = [];
  const queueHeredoc = (stripTabs: boolean, delimiter: string, delimQuoted: boolean) => {
    if (delimiter === "") { fail("missing heredoc delimiter"); return; }
    pending.push({ stripTabs, delimiter, quoted: delimQuoted });
  };
  const flushHeredocs = () => {
    while (pending.length > 0) {
      const h = pending.shift()!;
      // i 当前停在换行符处（或行尾）：越过换行进入主体首行，逐行找定界行
      if (i < n && src[i] === "\n") i++;
      const bodyStart = i;
      for (;;) {
        if (i >= n) { fail("unclosed heredoc"); break; }
        let lineEnd = src.indexOf("\n", i);
        if (lineEnd === -1) lineEnd = n;
        let line = src.slice(i, lineEnd);
        if (h.stripTabs) line = line.replace(/^\t+/, "");
        line = line.replace(/\r$/, "");
        if (line === h.delimiter) {
          i = lineEnd < n ? lineEnd + 1 : n;
          break;
        }
        i = lineEnd < n ? lineEnd + 1 : n;
      }
      if (!h.quoted) collectInto(src.slice(bodyStart, i));
    }
  };
  while (i < n) {
    const c = src[i];
    if (c === "\n") { flushHeredocs(); tokens.push({ kind: "op", value: ";" }); i++; continue; } // 换行即命令分隔；先按序跳过 pending heredoc 主体
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "#" ) { skipLineComment(); continue; }
    // 算术 ((...))：整体跳过，只扫描内部嵌套命令替换；随后视为命令结束
    if (c === "(" && src[i + 1] === "(") {
      const r = balanceSpan(src, i + 2, "paren");
      if (!r.ok) { fail("unbalanced bracket"); i = n; break; }
      collectInto(src.slice(i + 2, r.end - 1));
      i = r.end;
      tokens.push({ kind: "op", value: "(())" });
      continue;
    }
    // 测试 [[...]]：整体跳过，只扫描内部嵌套命令替换
    if (c === "[" && src[i + 1] === "[") {
      const r = balanceSpan(src, i + 2, "test");
      if (!r.ok) { fail("unbalanced bracket"); i = n; break; }
      collectInto(src.slice(i + 2, r.end - 2));
      i = r.end;
      tokens.push({ kind: "op", value: "[[]]" });
      continue;
    }
    // fd 前缀数字：2>、10>> 等（其后必须紧跟重定向操作符，否则只是普通词）
    const fdM = /^(\d+)(?=[<>])/.exec(src.slice(i));
    if (fdM) {
      const op = matchOp(i + fdM[1].length);
      if (op && (op === ">" || op === ">>" || op === ">|" || op === "<" || op === "<<" || op === "<<-" || op === ">&" || op === "<&" || op === "<>")) {
        // heredoc 带 fd？`2<<EOF` 非法，但按 heredoc 处理更安全（跳主体）
        if (op === "<<" || op === "<<-") {
          tokens.push({ kind: "op", value: fdM[1] + op });
          i += fdM[1].length + op.length;
          while (i < n && (src[i] === " " || src[i] === "\t")) i++;
          const dw = readWord();
          if (!dw) { fail("missing heredoc delimiter"); break; }
          if (dw.dynamic || dw.glob || dw.arith) { fail("dynamic heredoc delimiter"); i = n; break; }
          tokens.push({ kind: "word", value: dw.value, dynamic: dw.dynamic, glob: false, arith: false });
          queueHeredoc(op === "<<-", dw.value, dw.quoted);
          continue;
        }
        tokens.push({ kind: "op", value: fdM[1] + op });
        i += fdM[1].length + op.length;
        continue;
      }
      // 不是重定向：数字按普通词处理（如下面的 readWord）
    }
    const op = matchOp(i);
    if (op) {
      if (op === "<<" || op === "<<-") {
        tokens.push({ kind: "op", value: op });
        i += op.length;
        while (i < n && (src[i] === " " || src[i] === "\t")) i++;
        const dw = readWord();
        if (!dw) { fail("missing heredoc delimiter"); break; }
        if (dw.dynamic || dw.glob || dw.arith) { fail("dynamic heredoc delimiter"); i = n; break; }
        tokens.push({ kind: "word", value: dw.value, dynamic: dw.dynamic, glob: false, arith: false });
        queueHeredoc(op === "<<-", dw.value, dw.quoted);
        continue;
      }
      tokens.push({ kind: "op", value: op });
      i += op.length;
      continue;
    }
    const w = readWord();
    if (!w) { i++; continue; }
    tokens.push({ kind: "word", value: w.value, dynamic: w.dynamic, glob: w.glob, arith: w.arith });
  }
  if (pending.length > 0) fail("unclosed heredoc");
  return { tokens, cmdSubsts, uncertain, reasons };
}

// 结构解析：从 token 流提取静态文件写目标；无法安全判定时 uncertain。
// 规则：
// - 写重定向 `>` `>>` `>|` `&>` `&>>` `N>` `N>>` `N>|` `<>` + 目标词 → 目标计入；
//   `>&word` / `N>&word` 中 word 为纯数字或 `-` → fd 复制/关闭，不计入，否则按文件计入；
//   `<` / `N<` / `<<` / `<<-` / `<<<` / `<&` 为读入，不计入（heredoc 主体已在分词时跳过）。
// - 缺失目标 / 动态目标（$）/ glob 目标 / 算术展开目标 → uncertain（fail-closed）。
// - tee：命令位置（或包装器链之后）的 basename 为 tee 的词（含路径/引号形式），
//   其后操作数逐个判定：-x/--xxx 跳过，`--` 后全为操作数，裸 `-` 为 stdout 不计入，
//   动态/glob/算术操作数 → uncertain。
// - `sed -i`（含 -i/--in-place/合并短选项）：其文件操作数为写入目标。
// - `sh|bash|dash|ksh|zsh|fish -c code`、`eval args`：递归解析 code。
// - 动态命令词（`$T`、`$(…)`、反引号、`${…}`、`$VAR` 等，`$((…))` 纯算术除外）：
//   最终执行什么命令无法确定 → uncertain。glob 命令词同理。
// - 委托包装器（sudo/timeout/stdbuf/env/…）：按 WRAPPER_SPECS 跳过选项与前置位置参数
//   找到真实子命令后递归判定；子命令动态/缺失参数结构无法确定 → uncertain。
//   未知自定义包装器不在此表，属已知残留缺口（见文件头），不伪称覆盖。
// （ShellAnalysis 接口定义见上文“可靠词法分析”一节。）

const SHELL_REDIRECT_WRITE = new Set([">", ">>", ">|", ">>|", "&>", "&>>", "<>"]);
const SHELL_REDIRECT_FD = new Set([">&", "<&"]);
const SHELL_REDIRECT_READ = new Set(["<", "<<", "<<-", "<<<"]);
const SHELL_RESET_TRUE = new Set(["if", "while", "until", "then", "do", "else", "elif", "fi", "done", "esac"]);
const SHELL_RESET_FALSE = new Set(["for", "case", "select", "function", "in"]);
// -exec/-execdir/-ok/-okdir 后是 find 要执行的命令（操作数位置上单独处理，见主循环末尾）
interface WrapperSpec {
  /** 取单独参数的选项（精确词，如 -u、--signal）：严格消费其后一词 */
  skipNext: Set<string>;
  /** 短选项中取参数的字母（如 u、s）：簇内剩余部分为附带参数，否则消费下一词 */
  shortArg: Set<string>;
  /** 参数为 shell 代码的选项（精确词，如 -c、--command）：对其参数递归解析 */
  codeOpts: Set<string>;
  /** 短选项中参数为代码的字母（如 c） */
  shortCode: Set<string>;
  /** 参数本身就是文件写目标的选项（精确词，如 time -o）：其参数计入 targets */
  outputOpts: Set<string>;
  /** 短选项中参数为写目标的字母（如 o） */
  shortOut: Set<string>;
  /** 取用户名/身份的选项（runuser -u）：一旦出现，前置 user 位置参数不再跳过 */
  userOpts: Set<string>;
  /** 短选项中取用户的字母 */
  shortUser: Set<string>;
  /** 切到“编辑文件”模式的标志（sudo -e/--edit）：其后操作数均为待编辑文件 */
  editFlags: Set<string>;
  /** 短选项中切编辑模式的字母（如 e） */
  shortEdit: Set<string>;
  /** 子命令前需跳过的前置位置参数个数（如 timeout 的 DURATION、chroot 的 NEWROOT） */
  positionalsToSkip: number;
  /** 为 true 时：仅当未见 userOpts 才跳过 user 位置参数（runuser） */
  conditionalUserSkip: boolean;
}
function spec(
  skipNext: string[],
  codeOpts: string[] = [],
  positionalsToSkip = 0,
  outputOpts: string[] = [],
  userOpts: string[] = [],
  editFlags: string[] = [],
  conditionalUserSkip = false,
): WrapperSpec {
  const shorts = (words: string[]): Set<string> => {
    const s = new Set<string>();
    for (const word of words) {
      if (/^-[A-Za-z]$/.test(word)) s.add(word[1]);
    }
    return s;
  };
  return {
    skipNext: new Set(skipNext),
    shortArg: shorts(skipNext),
    codeOpts: new Set(codeOpts),
    shortCode: shorts(codeOpts),
    outputOpts: new Set(outputOpts),
    shortOut: shorts(outputOpts),
    userOpts: new Set(userOpts),
    shortUser: shorts(userOpts),
    editFlags: new Set(editFlags),
    shortEdit: shorts(editFlags),
    positionalsToSkip,
    conditionalUserSkip,
  };
}
// 委托执行包装器表：覆盖标准工具链中的同类委托。
// 审计原则（逐项核对 man 用法）：布尔开关绝不进 skipNext（否则吞掉真实子命令）；
// 只有“必需带参”的选项才进 skipNext/codeOpts/outputOpts（可选参数一律按开关处理，
// 附带值形式 `--opt=val` 整体跳过无遗漏）。未知自定义包装器仍是残留缺口。
const WRAPPER_SPECS: Record<string, WrapperSpec> = {
  // sudo -e/--edit 为 sudoedit 模式：其后操作数均为待编辑文件（editFlags 切模式）；
  // -G 不存在（误列会吞命令，已删）；-p/-r/-t 取参已补；--preserve-env 等可选参数按开关处理。
  sudo: spec(["-u", "-U", "-g", "-C", "-D", "--close-from", "--chdir", "-p", "--prompt", "-r", "--role", "-t", "--type", "--user", "--group", "--command-timeout"], [], 0, [], [], ["-e", "--edit"]),
  doas: spec(["-u", "-C"]),
  // --session-command 若存在即取命令串（与 -c 同类），故归 codeOpts 而非 skipNext。
  su: spec(["-s", "--shell", "-g", "--group", "-G", "--supplementary-group"], ["-c", "--command", "--session-command"], 1),
  runuser: spec(["-s", "--shell", "-g", "--group", "-G", "--supplementary-group", "-u", "--user"], ["-c", "--command", "--session-command"], 1, [], ["-u", "--user"], [], true),
  chroot: spec(["--userspec", "--groups"], [], 1),
  unshare: spec(["--map-user", "--map-group", "--map-users", "--map-groups", "--setuid", "--setgid", "--propagation"]),
  setsid: spec([]),
  // flock 布尔开关（-s/-x/-u/-n/--verbose 等）绝不能进 skipNext：`flock -x lock tee` 中
  // 若 -x 吞掉 lock，tee 会被误作前置参数跳过而漏报——本轮重构的核心 bug 类。
  flock: spec(["-w", "--timeout", "-E", "--conflict-exit-code", "-o", "--close"], ["-c", "--command"], 1),
  timeout: spec(["-s", "--signal", "--kill-after", "-k"], [], 1),
  stdbuf: spec(["-i", "--input", "-o", "--output", "-e", "--error"]),
  env: spec(["-u", "--unset", "-C", "--chdir", "--argv0", "-S", "--split-string", "--block-signal", "--default-signal", "--ignore-signal"]),
  nice: spec(["-n", "--adjustment"]),
  ionice: spec(["-c", "--class", "-n", "--classdata", "-p", "--pid"]),
  taskset: spec(["-c", "--cpu-list", "-p", "--pid"]),
  numactl: spec(["--cpunodebind", "--physcpubind", "--membind", "--preferred", "--interleave", "--length", "--offset", "--shmid"]),
  nohup: spec([]),
  time: spec(["-f", "--format"], [], 0, ["-o", "--output"]),
  // command -p 是开关（-p tee 中 tee 仍是子命令），skipNext 必须为空。
  command: spec([]),
  builtin: spec([]),
  exec: spec(["-a"]),
  xargs: spec(["-a", "--arg-file", "-d", "--delimiter", "-E", "--eof", "-I", "--replace", "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars", "--process-slot-var"]),
  watch: spec(["-n", "--interval"]),
  // busybox applet 委托：`busybox rm -rf /tmp/x` 透视为 rm；--install 写链接直接拒绝。
  busybox: spec([]),
  nsenter: spec(["-t", "--target", "-S", "--setuid", "-G", "--setgid", "-r", "--root", "-w", "--wd"]),
};
const SHELL_SHELLS = new Set(["sh", "bash", "dash", "ksh", "zsh", "fish"]);
const SHELL_TEE_STOPS = new Set(["in", "do", "then", "else", "elif", "fi", "done", "esac", ";"]);

// ---- Bash 显式白名单（scope 激活时） ----
// SAFE_READONLY：本身永不写文件的只读命令（shell 层重定向/已知写命令仍单独判定）。
// 已建模写命令（tee/sed/dd/touch/rm/mkdir/rmdir/shred/truncate/sudoedit/
// install/cp/mv + sh -c/eval + find（受限）+ wrappers 透视）走各自解析。
// 其余一切未知命令（git/python/node/npm/curl/make/chmod/tar/...）一律
// fail-closed。本扩展是门禁不是沙箱：白名单只收敛 Bash 入口，解释器内部写
// 必须走 edit/write 工具，见文件头。
// 只读命令并非无条件放行：逐命令选项白名单（未知选项拒绝），带文件输出的
// 选项/操作数（sort -o/--output、uniq 第二操作数、less -o/-O；GNU diff 无 --output）
// 计入写目标；test/[ 表达式与 `:` 为自由形（只读断言，操作数忽略）。
const SHELL_SAFE_READONLY = new Set([
  "ls", "echo", "printf", "cat", "head", "tail", "grep", "rg", "ag",
  "wc", "sort", "uniq", "cut", "tr", "seq", "dirname", "basename",
  "pwd", "whoami", "id", "uname", "date", "true", "false", "test",
  "which", "file", "stat", "diff", "cmp", "less", "more", "nl", "od",
]);

interface SafeSpec {
  boolShorts: Set<string>;
  argShorts: Set<string>; // 附带或下词（非文件参数：数字/格式/模式，忽略）
  outShorts: Set<string>; // 附带或下词（文件写目标，计入）
  boolLongs: Set<string>;
  skipLongs: Set<string>; // 下词或 =附带（非文件参数，忽略）
  outLongs: Set<string>; // 下词或 =附带（文件写目标，计入）
  uniqOutput?: boolean; // 第二操作数为输出文件（uniq）
  freeform?: boolean; // 操作数不校验（test/[ 表达式、`:`，只读）
}

function safeSpec(
  boolShorts: string,
  argShorts: string,
  outShorts: string,
  boolLongs: string[],
  skipLongs: string[],
  outLongs: string[],
  extra?: Partial<SafeSpec>,
): SafeSpec {
  return {
    boolShorts: new Set(boolShorts),
    argShorts: new Set(argShorts),
    outShorts: new Set(outShorts),
    boolLongs: new Set(boolLongs),
    skipLongs: new Set(skipLongs),
    outLongs: new Set(outLongs),
    ...extra,
  };
}

// 各只读命令选项白名单：只收录常见安全选项，未知选项一律拒绝（fail-closed）。
// 输出语义：sort -o/--output、less -o/-O 为写目标；uniq 第二操作数为输出；
// 操作数为输出文件；其余操作数均为读入/文本/数字，直接忽略。
const SAFE_CMD_OPTS: Record<string, SafeSpec> = {
  ls: safeSpec("lartSXv1mGidFpqQUcuxCkLHfog", "wT", "", ["all", "almost-all", "long", "human-readable", "recursive", "reverse", "classify", "directory", "inode", "numeric-uid-gid", "no-group", "help", "version", "escape", "literal", "dired"], ["color", "width", "format", "sort", "time", "hide", "ignore", "indicator-style", "quoting-style", "block-size", "tabsize", "time-style"], []),
  echo: safeSpec("neE", "", "", ["help", "version"], [], []),
  printf: safeSpec("", "", "", ["help", "version"], [], []),
  cat: safeSpec("nbseETvA", "", "", ["number-nonblank", "number", "squeeze-blank", "show-ends", "show-tabs", "show-all", "show-nonprinting", "help", "version"], [], []),
  head: safeSpec("ncqv", "nc", "", ["lines", "bytes", "quiet", "verbose", "help", "version", "zero-terminated"], ["lines", "bytes"], []),
  tail: safeSpec("ncqvf", "nc", "", ["lines", "bytes", "quiet", "verbose", "follow", "help", "version", "zero-terminated", "retry", "follow"], ["lines", "bytes", "max-unchanged-stats", "sleep-interval", "pid"], []),
  grep: safeSpec("ivclnhHrREFGPqsoxwLZUbaI", "efmABCDd", "", ["ignore-case", "invert-match", "count", "files-with-matches", "line-number", "no-filename", "with-filename", "recursive", "extended-regexp", "fixed-strings", "basic-regexp", "perl-regexp", "quiet", "silent", "word-regexp", "line-regexp", "only-matching", "files-without-match", "null", "byte-offset", "binary-files", "devices", "directories", "dereference-recursive", "no-messages", "help", "version", "color", "include", "exclude", "exclude-dir", "label", "mmap"], ["regexp", "file", "max-count", "after-context", "before-context", "context", "exclude", "include", "exclude-dir", "label", "color", "binary-files", "devices", "directories"], []),
  rg: safeSpec("ivlncuaz", "emtABCgM", "", ["ignore-case", "invert-match", "files-with-matches", "line-number", "count", "no-messages", "help", "version", "fixed-strings", "word-regexp", "follow"], ["regexp", "type", "glob", "max-count", "after-context", "before-context", "context", "engine", "max-columns"], []),
  ag: safeSpec("ilnca", "G", "", ["ignore-case", "files-with-matches", "line-number", "count", "follow", "help", "version", "nobreak", "noheading"], ["ignore", "ignore-dir"], []),
  wc: safeSpec("cmlwL", "", "", ["bytes", "chars", "lines", "words", "max-line-length", "help", "version"], ["files0-from"], []),
  // sort：仅收录逐个核实的只读排序选项；写临时文件/执行外部程序的一律不收录
  // （--temporary-directory、--compress-program、--parallel 等未知即拒绝）。
  sort: safeSpec("bdfgiMnRrsuVchCzm", "ktS", "o", ["ignore-leading-blanks", "dictionary-order", "ignore-case", "ignore-nonprinting", "numeric-sort", "general-numeric-sort", "human-numeric-sort", "month-sort", "version-sort", "random-sort", "reverse", "unique", "stable", "merge", "zero-terminated", "help", "version"], ["key", "field-separator", "buffer-size", "check"], ["output"]),
  uniq: safeSpec("cdui", "w", "", ["count", "repeated", "unique", "ignore-case", "help", "version", "all-repeated", "group", "zero-terminated"], [], [], { uniqOutput: true }),
  cut: safeSpec("bcfds", "bcfd", "", ["bytes", "characters", "fields", "delimiter", "only-delimited", "complement", "help", "version", "zero-terminated"], ["delimiter", "output-delimiter"], []),
  tr: safeSpec("cdstu", "", "", ["complement", "delete", "squeeze-repeats", "truncate-set1", "help", "version"], [], []),
  seq: safeSpec("fsw", "fs", "", ["format", "separator", "equal-width", "help", "version"], ["format", "separator"], []),
  dirname: safeSpec("", "", "", ["zero", "help", "version"], [], []),
  basename: safeSpec("s", "s", "", ["suffix", "multiple", "zero", "help", "version"], ["suffix"], []),
  pwd: safeSpec("LP", "", "", ["logical", "physical", "help", "version"], [], []),
  whoami: safeSpec("", "", "", ["help", "version"], [], []),
  id: safeSpec("unGgrZ", "", "", ["user", "group", "groups", "real", "help", "version", "zero"], [], []),
  uname: safeSpec("asnrvmpio", "", "", ["all", "kernel-name", "nodename", "kernel-release", "kernel-version", "machine", "processor", "hardware-platform", "operating-system", "help", "version"], [], []),
  date: safeSpec("uR", "", "", ["universal", "rfc-2822", "rfc-3339", "iso-8601", "help", "version"], ["date", "file", "iso-8601"], []),
  true: safeSpec("", "", "", ["help", "version"], [], []),
  false: safeSpec("", "", "", ["help", "version"], [], []),
  test: safeSpec("", "", "", [], [], [], { freeform: true }),
  which: safeSpec("a", "", "", ["help", "version", "show-dot", "show-tilde", "skip-alias", "skip-functions", "skip-dot"], [], []),
  file: safeSpec("biLhz", "fm", "", ["brief", "mime", "keep-going", "no-buffer", "raw", "help", "version", "dereference", "uncompress", "separator", "files-from", "mime-type", "mime-encoding", "extension", "preserve-date"], ["separator", "files-from"], []),
  stat: safeSpec("cftL", "c", "", ["format", "filesystem", "printf", "terse", "help", "version", "dereference"], ["format", "printf"], []),
  // diff：GNU diff 无 --output 文件输出选项（只有 stdout），不设 outLongs；
  // --unified/--context 取可选行数（=附带或无参），整体跳过。
  diff: safeSpec("ucqribBqs", "UCD", "", ["unified", "context", "brief", "recursive", "ignore-case", "ignore-all-space", "ignore-blank-lines", "strip-trailing-cr", "help", "version", "from-file", "to-file", "normal", "side-by-side", "report-identical-files", "no-dereference"], ["label"], []),
  cmp: safeSpec("ls", "", "", ["verbose", "silent", "help", "version"], ["bytes"], []),
  less: safeSpec("NSRFXMIigp", "", "oO", ["LINE-NUMBERS", "RAW-CONTROL-CHARS", "quit-if-one-screen", "no-init", "help", "version"], ["pattern", "prompt", "quote"], []),
  more: safeSpec("dfpcsu", "p", "", ["help", "version"], [], []),
  nl: safeSpec("", "bfhnsvwi", "", ["body-numbering", "footer-numbering", "header-numbering", "number-format", "number-separator", "starting-line-number", "number-width", "join-blank-lines", "help", "version"], ["body-numbering", "footer-numbering", "header-numbering", "number-format", "number-separator", "starting-line-number", "number-width"], []),
  od: safeSpec("Av", "AjNt", "", ["address-radix", "skip-bytes", "read-bytes", "format", "output-duplicates", "help", "version", "traditional"], ["address-radix", "skip-bytes", "read-bytes", "format", "width", "strings"], []),
};

// 环境赋值显式安全变量白名单：仅下列无文件/代码加载影响的显示类变量允许
// 前缀赋值（`VAR=... cmd`）与 `env`/`sudo` 等透视链中的 `VAR=` 赋值；
// TMPDIR/TMP/TEMP（临时文件重定向）、PATH/LD_PRELOAD 类加载劫持变量及一切
// 未知变量一律拒绝（env 注入封堵）。值含动态词另由全参数位动态规则拒绝。
const SAFE_ENV_VARS = new Set([
  "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY",
  "LC_NUMERIC", "LC_TIME", "LANG", "LANGUAGE", "TZ", "TERM",
  "NO_COLOR", "CLICOLOR", "CLICOLOR_FORCE",
]);

function checkEnvAssignment(word: string, fail: (r: string) => void): void {
  const name = word.slice(0, word.indexOf("="));
  if (!SAFE_ENV_VARS.has(name)) fail(`unsafe env assignment: ${name}`);
}

// 真实 shell 展开判定：`$` 后跟变量名/特殊参数/替换起始符才是展开；
// 其余（空格、引号、标点、结尾等）为字面 `$`，不置 dynamic（避免 grep/echo/cat 误杀）。
// 反引号恒为命令替换（动态）。注意：本判定面向分词后的裸片段；单引号内
// 的 `$` 由引号分支直接保持静态，不经过此处。
const SHELL_EXPAND_NEXT_BARE = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_{$(#?-$!@*'\"".split(""),
);
// 双引号内 `$"`/`$'` 为字面（ANSI-C/本地化引号仅在引号外生效），故剔除引号；
const SHELL_EXPAND_NEXT_DQUOTE = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_{$(#?-$!@*".split(""),
);
function isShellExpansion(str: string, dollarPos: number, inDquote = false): boolean {
  const nx = str[dollarPos + 1];
  if (nx === undefined) return false;
  return (inDquote ? SHELL_EXPAND_NEXT_DQUOTE : SHELL_EXPAND_NEXT_BARE).has(nx);
}
function hasShellExpansion(s: string): boolean {
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") { k++; continue; }
    if (c === "`") return true;
    if (c === "$" && isShellExpansion(s, k)) return true;
  }
  return false;
}

// 只读命令操作数解析：选项白名单校验 + 输出文件提取；读操作数全部忽略。
// 返回消费结束位置；未知选项/动态输出一律 fail（调用侧拒绝）。
function parseSafeReadonlyOperands(
  toks: ShellTok[],
  start: number,
  targets: string[],
  fail: (r: string) => void,
  base: string,
): number {
  const spec = SAFE_CMD_OPTS[base];
  if (!spec) { fail(`unknown command: ${base}`); return start; }
  if (spec.freeform) {
    // test/[ 表达式、`:`：只读断言/空操作，操作数整体忽略（读入不设门）。
    let i = start;
    while (i < toks.length && toks[i].kind === "word") i++;
    return i;
  }
  let i = start;
  const n = toks.length;
  let dashdash = false;
  let pending: "skip" | "out" | null = null;
  let hasDashInput = false; // `-` 输入占位（stdin 语义）
  let hasFileOutput = false; // 文件写位置（sort -o/uniq 第二操作数/less -o，`-`/null 除外）
  const operands: Extract<ShellTok, { kind: "word" }>[] = [];
  const isOpTok = (t: ShellTok) => t.kind === "op" || t.kind === "subst";
  // 输出文件记录：`-`/null 表示 stdout/空设备（无文件）；其余计入写目标并标记。
  const noteOutput = (v: string): void => {
    if (!v || v === "-" || v === "/dev/null") return;
    targets.push(v);
    hasFileOutput = true;
  };
  while (i < n) {
    const t = toks[i];
    if (isOpTok(t)) break;
    const ww = t as Extract<ShellTok, { kind: "word" }>;
    const w = ww.value;
    if (pending === "skip") { pending = null; i++; continue; }
    if (pending === "out") {
      pending = null;
      if (ww.dynamic || ww.arith) fail(`dynamic ${base} output`);
      else if (ww.glob) fail(`glob ${base} output`);
      else noteOutput(w);
      i++;
      continue;
    }
    if (!dashdash && w === "--") { dashdash = true; i++; continue; }
    if (w === "-") { hasDashInput = true; operands.push(ww); i++; continue; } // stdin/stdout 占位：操作数位置保留（uniq 第二操作数判定用），是否允许见末尾严格规则
    if (!dashdash && /^-\d+$/.test(w)) { i++; continue; } // head/tail 旧式 -NUM
    if (!dashdash && w.startsWith("--")) {
      const eq = w.indexOf("=");
      const opt = eq >= 0 ? w.slice(0, eq) : w;
      const val = eq >= 0 ? w.slice(eq + 1) : null;
      const name = opt.slice(2);
      if (spec.outLongs.has(name)) {
        if (val !== null) {
          if (!val) fail(`missing ${base} output`);
          else if (/[$`]/.test(val)) fail(`dynamic ${base} output`);
          else if (/[*?[]/.test(val)) fail(`glob ${base} output`);
          else noteOutput(val);
        } else pending = "out";
        i++;
        continue;
      }
      if (spec.skipLongs.has(name)) { i++; continue; } // =附带或无参，整体跳过
      if (spec.boolLongs.has(name)) { i++; continue; }
      fail(`unknown ${base} option: ${opt}`);
      i++;
      continue;
    }
    if (!dashdash && /^-[A-Za-z][\s\S]*$/.test(w) && w !== "-") {
      let k = 1;
      let advanced = true;
      while (k < w.length) {
        const ch = w[k];
        const rest = w.slice(k + 1);
        if (spec.outShorts.has(ch)) {
          if (rest) {
            if (/[$`]/.test(rest)) fail(`dynamic ${base} output`);
            else if (/[*?[]/.test(rest)) fail(`glob ${base} output`);
            else noteOutput(rest);
          } else pending = "out";
          break;
        }
        if (spec.argShorts.has(ch)) {
          if (!rest) pending = "skip";
          break;
        }
        if (spec.boolShorts.has(ch)) { k++; continue; }
        fail(`unknown ${base} option: -${ch}`);
        break;
      }
      void advanced;
      i++;
      continue;
    }
    if (!dashdash && /^-/.test(w) && w !== "-") { fail(`unknown ${base} option: ${w}`); i++; continue; }
    operands.push(ww);
    i++;
  }
  if (pending === "out") fail(`missing ${base} output`);
  if (spec.uniqOutput && operands.length >= 2) {
    const o = operands[1];
    if (o.dynamic || o.arith) fail("dynamic uniq output");
    else if (o.glob) fail("glob uniq output");
    else noteOutput(o.value);
  }
  // 严格参数形态：uniq 最多 2 操作数，diff 最多 2 操作数。
  if (base === "uniq" && operands.length > 2) fail("too many uniq operands");
  if (base === "diff" && operands.length > 2) fail("too many diff operands");
  // `-` 严格规则：仅在确为 stdin（输入位）且不存在文件输出位置时允许；
  // 输出为 `-`/null（stdout/空设备）不算文件输出位置。
  // 其余读操作数（输入文件/模式/数字）全部忽略：读不设门。
  if (hasDashInput && hasFileOutput) fail(`stdin marker with output present: ${base}`);
  return i;
}

// find 写动作：任一出现即 fail-closed（即使子命令看起来只读，stdin/动作集合未知）。
const FIND_WRITE_ACTIONS = new Set([
  "-delete", "-exec", "-execdir", "-ok", "-okdir",
  "-fls", "-fprint", "-fprint0", "-fprintf",
]);

// cp/install 目录误判修复：dest 为已存在目录（或尾斜杠）时真实写入是 join。
function isDirLikeTarget(root: string | undefined, raw: string): boolean {
  if (raw.endsWith("/")) return true;
  if (!root) return false;
  if (raw === "~" || raw.startsWith("~/")) return false;
  if (raw === "/dev/null" || raw.toUpperCase() === "NUL") return false;
  let abs: string;
  if (path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) abs = path.normalize(raw);
  else abs = path.join(root, raw);
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function shellJoinDir(dir: string, src: string): string {
  const b = (() => {
    const k = src.replace(/\\/g, "/");
    const s = k.endsWith("/") ? k.slice(0, -1) : k;
    const q = s.lastIndexOf("/");
    return q >= 0 ? s.slice(q + 1) : s;
  })();
  return dir.replace(/\/+$/, "") + "/" + b;
}

// “操作数即文件”命令的选项表：布尔开关不在 skipNext 中（绝不吞下一词），
// 只有必需带参选项才列入（附带值形式整体跳过无遗漏）。
const SIMPLE_FILE_CMD_OPTS: Record<string, { skipNext: Set<string>; argChars: Set<string> }> = {
  // touch -d/-r 取参（-r 为读引用，跳过）；-t 取时间戳；--time 取参
  touch: { skipNext: new Set(["-d", "--date", "-r", "--reference", "--time", "-t"]), argChars: new Set(["d", "r", "t"]) },
  // rm/rmdir：全为开关，无取参选项
  rm: { skipNext: new Set(), argChars: new Set() },
  rmdir: { skipNext: new Set(), argChars: new Set() },
  // mkdir -m 取模式
  mkdir: { skipNext: new Set(["-m", "--mode"]), argChars: new Set(["m"]) },
  // shred -n/-s 取数，--random-source 取读路径（跳过）；-u/-z 等为开关
  shred: { skipNext: new Set(["-n", "--iterations", "-s", "--size", "--random-source"]), argChars: new Set(["n", "s"]) },
  // truncate -s 取尺寸，-r 取读引用（跳过）
  truncate: { skipNext: new Set(["-s", "--size", "-r", "--reference"]), argChars: new Set(["s", "r"]) },
  // sudoedit：操作数均为待编辑文件
  sudoedit: { skipNext: new Set(["-C", "-D", "-g", "-p", "-u"]), argChars: new Set(["C", "D", "g", "p", "u"]) },
};

function shellBasename(word: string): string {
  const k = word.replace(/\\/g, "/");
  const p = k.lastIndexOf("/");
  return p >= 0 ? k.slice(p + 1) : k;
}

export function analyzeShellWrites(command: string, _depth = 0, _root?: string): ShellAnalysis {
  if (_depth > 16) return { targets: [], uncertain: true, reasons: ["analysis depth exceeded"] };
  try {
    return analyzeShellWritesInner(command, _depth, _root);
  } catch {
    return { targets: [], uncertain: true, reasons: ["analysis exception (fail-closed)"] };
  }
}

function analyzeShellWritesInner(command: string, _depth: number, _root?: string): ShellAnalysis {
  const targets: string[] = [];
  const reasons: string[] = [];
  let uncertain = false;
  const fail = (r: string) => { uncertain = true; reasons.push(r); };
  const scan = tokenizeShell(command);
  if (scan.uncertain) {
    uncertain = true;
    reasons.push(...scan.reasons);
  }
  // 命令替换体（$( )、反引号、>( )、<( ) 内部）完整复解析
  const seenSub = new Set<string>();
  const parseSubsts = (list: string[], depth: number) => {
    if (depth > 4) { fail("nested substitution too deep"); return; }
    for (const inner of list) {
      if (seenSub.has(inner)) continue;
      seenSub.add(inner);
      const a = analyzeShellWrites(inner, _depth + 1, _root);
      targets.push(...a.targets);
      if (a.uncertain) {
        uncertain = true;
        reasons.push(...a.reasons);
      }
    }
  };
  parseSubsts(scan.cmdSubsts, 0);

  const toks = scan.tokens;
  // scope 激活时统一规则：任何参数位的动态词（`$` 展开/命令替换/反引号）
  // 一律 fail-closed，不只命令名/特定工具；纯静态路径不受影响。
  //（纯 `$((…))` 算术 dynamic=false，不在此列。）
  for (const dt of toks) {
    if (dt.kind === "word" && (dt as Extract<ShellTok, { kind: "word" }>).dynamic) {
      fail("dynamic argument");
      break;
    }
  }
  let expectCommand = true;
  let wrapperMode = false;
  let wrapperSpec: WrapperSpec | null = null;
  let wrapperName = "";
  let wrapperPosSkipped = 0;
  let wrapperPosToSkip = 0;
  let wrapperUserSeen = false;
  let wrapperEditMode = false;
  let wrapperNoOpts = false;
  let pendingOutputOpt = false;
  let skipNext = false;
  // 进入包装器：初始化全部透视状态
  const enterWrapper = (next: WrapperSpec, name: string) => {
    wrapperMode = true;
    wrapperSpec = next;
    wrapperName = name;
    wrapperPosSkipped = 0;
    wrapperPosToSkip = next.positionalsToSkip;
    wrapperUserSeen = false;
    wrapperEditMode = false;
    wrapperNoOpts = false;
    skipNext = false;
    pendingOutputOpt = false;
    expectCommand = true;
  };
  const leaveWrapper = () => {
    wrapperMode = false;
    wrapperSpec = null;
    wrapperName = "";
    wrapperPosSkipped = 0;
    wrapperPosToSkip = 0;
    wrapperUserSeen = false;
    wrapperEditMode = false;
    wrapperNoOpts = false;
    skipNext = false;
    pendingOutputOpt = false;
  };
  // 包装器代码参数复解析（su -c / --command= / -cCODE / flock -c 等）
  const parseWrapperCode = (codeTok: Extract<ShellTok, { kind: "word" }>): void => {
    if (codeTok.dynamic || codeTok.glob || codeTok.arith) fail("dynamic wrapper code");
    else {
      const a = analyzeShellWrites(codeTok.value, _depth + 1, _root);
      targets.push(...a.targets);
      if (a.uncertain) fail("unparseable wrapper code");
    }
    expectCommand = false;
    leaveWrapper();
  };
  let i = 0;
  const n = toks.length;
  const isWord = (t: ShellTok): t is Extract<ShellTok, { kind: "word" }> => t.kind === "word";
  const isOp = (t: ShellTok): t is Extract<ShellTok, { kind: "op" }> => t.kind === "op";
  // 消费一个简单命令的剩余词（eval 用），返回词表
  while (i < n) {
    const t = toks[i];
    if (isOp(t)) {
      // fd 前缀归一化（`2>`、`10>>`、`2>&` 等）：判定只看操作符本体
      const v = t.value.replace(/^\d+(?=[<>|&])/, "");
      // heredoc 定界词 / herestring 数据词：分词时已以 word token 紧跟其后，
      // 此处整体跳过（定界词不是目标；herestring 数据词已做替换体扫描）
      if (v === "<<" || v === "<<-" || v === "<<<") {
        i++;
        if (i < n && isWord(toks[i])) i++;
        continue;
      }
      // 写重定向
      if (SHELL_REDIRECT_WRITE.has(v)) {
        i++;
        if (i >= n || !isWord(toks[i])) { fail("missing redirect target"); break; }
        const w = toks[i] as Extract<ShellTok, { kind: "word" }>;
        if (!w.value && !w.dynamic && !w.glob && !w.arith) { i++; continue; } // 空目标：shell 报错、无写入
        if (w.dynamic) fail("dynamic redirect target");
        else if (w.glob) fail("glob redirect target");
        else if (w.arith) fail("dynamic redirect target");
        else if (w.value === "/dev/null") { /* 唯一显式例外：空设备汇点 */ }
        else targets.push(w.value);
        i++;
        continue;
      }
      // >& / <&：纯数字或 "-" → fd 操作；否则按文件
      if (SHELL_REDIRECT_FD.has(v)) {
        i++;
        if (i >= n || !isWord(toks[i])) { fail("missing redirect target"); break; }
        const w = toks[i] as Extract<ShellTok, { kind: "word" }>;
        if (/^\d+$/.test(w.value) || w.value === "-") { i++; continue; }
        if (v === ">&") {
          if (!w.value && !w.dynamic && !w.glob && !w.arith) { i++; continue; }
          if (w.dynamic) fail("dynamic redirect target");
          else if (w.glob) fail("glob redirect target");
          else if (w.arith) fail("dynamic redirect target");
          else if (w.value === "/dev/null") { /* 例外 */ }
          else targets.push(w.value);
        }
        // <&word：读入文件，非写通道，忽略（替换体已单独复解析）
        i++;
        continue;
      }
      // 读重定向：跳过目标词（<<< 的数据词；< 的输入文件）
      if (SHELL_REDIRECT_READ.has(v)) { i++; continue; }
      // 其他操作符：重置命令位置
      expectCommand = true;
      leaveWrapper();
      i++;
      continue;
    }
    // subst token：已在上方复解析；占一个命令位置（若位于命令首则其后为参数）
    if (t.kind === "subst") { expectCommand = false; leaveWrapper(); i++; continue; }
    // word token
    const wt = t as Extract<ShellTok, { kind: "word" }>;
    const w = wt.value;
    if (expectCommand || wrapperMode) {
      if (!wrapperMode && SHELL_RESET_FALSE.has(w)) { expectCommand = false; i++; continue; }
      if (!wrapperMode && SHELL_RESET_TRUE.has(w)) { i++; continue; }
      if (wrapperMode && wrapperSpec) {
        const spec = wrapperSpec;
        if (skipNext) { skipNext = false; i++; continue; }
        if (!wrapperNoOpts && w === "--") { wrapperNoOpts = true; i++; continue; }
        // su 的登录壳 "-"：跳过，保持包装器态
        if (w === "-" && !wrapperNoOpts) { i++; continue; }
        // busybox --install 创建全部 applet 链接：本身就是写操作，直接拒绝
        if (w === "--install" && wrapperName === "busybox") { fail("busybox install creates links"); i++; continue; }
        // env：scope 模式下拒绝所有选项，仅明确安全白名单放行，禁止通用跳过
        //（含长选项缩写 `--spl` 一律按未知拒绝；-S/--split-string 藏匿赋值直接拒绝）。
        // 安全集：-i/-0/-v（开关）、-u/--unset/--argv0（取值，下词）、
        // --ignore-environment/--null/--verbose/--block-signal/--default-signal/
        // --ignore-signal/--help/--version（开关，=附带整体跳过）。
        // -C/--chdir（改执行目录，相对路径决议失效）、--debug 等未核实项一律拒绝。
        if (wrapperName === "env" && !wrapperNoOpts) {
          if (w === "-S" || w === "--split-string" || w.startsWith("--split-string=")) { fail("env -S hides assignments"); i++; continue; }
          if (/^-[A-Za-z]*S[\s\S]*$/.test(w) && w !== "-" && !w.startsWith("--")) { fail("env -S hides assignments"); i++; continue; }
          if (w === "-i" || w === "-0" || w === "-v") { i++; continue; }
          if (w === "-u" || w === "--unset" || w === "--argv0") { skipNext = true; i++; continue; }
          if (w === "--ignore-environment" || w === "--null" || w === "--verbose" ||
            w === "--block-signal" || w === "--default-signal" || w === "--ignore-signal" ||
            w === "--help" || w === "--version") { i++; continue; }
          if (w.startsWith("--")) {
            const eq = w.indexOf("=");
            const name = (eq >= 0 ? w.slice(0, eq) : w).slice(2);
            if (name === "unset" || name === "argv0") {
              if (eq < 0) skipNext = true;
              i++;
              continue;
            }
            if (name === "ignore-environment" || name === "null" || name === "verbose" ||
              name === "block-signal" || name === "default-signal" || name === "ignore-signal" ||
              name === "help" || name === "version") { i++; continue; }
            fail(`unknown env option: --${name}`);
            i++;
            continue;
          }
          if (/^-[A-Za-z][\s\S]*$/.test(w) && w !== "-") {
            let k = 1;
            while (k < w.length) {
              const ch = w[k];
              const rest = w.slice(k + 1);
              if (ch === "i" || ch === "0" || ch === "v") { k++; continue; }
              if (ch === "u") {
                if (!rest) skipNext = true;
                break;
              }
              fail(`unknown env option: -${ch}`);
              break;
            }
            i++;
            continue;
          }
        }
        // sudo -e/--edit（精确词）：切到编辑文件模式，其后操作数均为待编辑文件
        if (!wrapperNoOpts && spec.editFlags.has(w)) { wrapperEditMode = true; i++; continue; }
        if (!wrapperNoOpts && (w === "-c" || w === "--command" || w === "--session-command")) {
          if (spec.codeOpts.has(w)) {
            i++;
            if (i >= n || !isWord(toks[i])) { fail("missing wrapper code argument"); break; }
            parseWrapperCode(toks[i] as Extract<ShellTok, { kind: "word" }>);
            i++;
            continue;
          }
        }
        // 长选项附带值：--command=CODE 复解析 / --output=FILE 计入 / 其余整体跳过
        if (!wrapperNoOpts && w.startsWith("--") && w.includes("=")) {
          const eq = w.indexOf("=");
          const opt = w.slice(0, eq);
          const val = w.slice(eq + 1);
          if (spec.codeOpts.has(opt)) {
            if (!val) { fail("missing wrapper code argument"); i++; continue; }
            const tmp: Extract<ShellTok, { kind: "word" }> = { kind: "word", value: val, dynamic: false, glob: false, arith: false };
            // 附带值是分词器已切出的静态片段：含 $/反引号/通配则从严
            if (/[$`]/.test(val)) tmp.dynamic = true;
            if (/[*?[]/.test(val)) tmp.glob = true;
            parseWrapperCode(tmp);
            i++;
            continue;
          }
          if (spec.outputOpts.has(opt)) {
            if (!val) { i++; continue; }
            if (val !== "/dev/null") targets.push(val);
            i++;
            continue;
          }
          if (spec.userOpts.has(opt) || spec.skipNext.has(opt)) {
            if (spec.userOpts.has(opt)) wrapperUserSeen = true;
            i++;
            continue;
          }
          i++;
          continue;
        }
        if (!wrapperNoOpts && spec.skipNext.has(w)) {
          // 取参选项严格消费下一词；若同时是取用户选项，豁免前置 user 位置参数
          if (spec.userOpts.has(w)) wrapperUserSeen = true;
          skipNext = true;
          i++;
          continue;
        }
        if (!wrapperNoOpts && spec.outputOpts.has(w)) { pendingOutputOpt = true; i++; continue; }
        if (!wrapperNoOpts && spec.userOpts.has(w)) {
          // -u/--user user：给出来自身份，前置 user 位置参数不再跳过（runuser）
          wrapperUserSeen = true;
          skipNext = true;
          i++;
          continue;
        }
        // 短选项簇/附带值（如 -uroot、-sKILL、-cCODE、-oFILE）：按字母表精确扫描。
        // 布尔开关字母只跳过本词；取参字母：簇内剩余为附带参数，否则严格消费下一词。
        if (!wrapperNoOpts && /^-[A-Za-z][\s\S]*$/.test(w) && w !== "-" && !w.startsWith("--")) {
          let k = 1;
          let iAdvanced = false;
          while (k < w.length) {
            const ch = w[k];
            const rest = w.slice(k + 1);
            if (spec.shortEdit.has(ch)) { wrapperEditMode = true; k++; continue; }
            if (spec.shortCode.has(ch)) {
              if (rest) {
                const tmp: Extract<ShellTok, { kind: "word" }> = { kind: "word", value: rest, dynamic: /[$`]/.test(rest), glob: /[*?[]/.test(rest), arith: false };
                parseWrapperCode(tmp);
              } else {
                i++;
                if (i >= n || !isWord(toks[i])) { fail("missing wrapper code argument"); iAdvanced = true; break; }
                parseWrapperCode(toks[i] as Extract<ShellTok, { kind: "word" }>);
                i++;
                iAdvanced = true;
              }
              break;
            }
            if (spec.shortOut.has(ch)) {
              const file = rest;
              if (file) {
                if (file !== "/dev/null") targets.push(file);
              } else {
                pendingOutputOpt = true;
              }
              break;
            }
            if (spec.shortUser.has(ch)) {
              wrapperUserSeen = true;
              if (!rest) skipNext = true;
              break;
            }
            if (spec.shortArg.has(ch)) {
              if (!rest) skipNext = true;
              break;
            }
            k++; // 开关/未知字母：只跳过本词
          }
          if (!iAdvanced) i++;
          continue;
        }
        if (!wrapperNoOpts && /^-/.test(w) && w !== "-") { i++; continue; } // 其他 -x 形式：开关，整体跳过
        if (pendingOutputOpt) {
          // time -o FILE：FILE 是包装器自身的写目标
          pendingOutputOpt = false;
          if (wt.dynamic || wt.glob || wt.arith) fail("dynamic wrapper output");
          else if (w && w !== "/dev/null") targets.push(w);
          i++;
          continue;
        }
        if (wrapperEditMode) {
          // sudo -e 模式：操作数均为待编辑文件
          if (wt.dynamic || wt.glob || wt.arith) fail("dynamic edit operand");
          else if (w) targets.push(w);
          i++;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { checkEnvAssignment(w, fail); i++; continue; }
        const effectiveSkip = spec.conditionalUserSkip && wrapperUserSeen ? 0 : wrapperPosToSkip;
        if (wrapperPosSkipped < effectiveSkip) {
          wrapperPosSkipped++;
          i++;
          continue;
        }
        // 子命令位置：动态/glob 则最终命令无法确定 → fail-closed；
        // 纯算术 $((…)) 除外（执行数字命令无害，见分词器 arith 豁免）。
        if (wt.dynamic) { fail("dynamic command word"); expectCommand = false; leaveWrapper(); i++; continue; }
        if (wt.glob) { fail("glob command word"); expectCommand = false; leaveWrapper(); i++; continue; }
        if (!w) { expectCommand = false; leaveWrapper(); i++; continue; }
        const base = shellBasename(w);
        // 高风险复杂语义直接拒绝（不再透视/建模）：xargs（stdin 未知集合 +
        // wrapper/shell 链无法枚举）、sed（脚本 w/W/e）、硬链/软链创建（ln 全形态）。
        if (base === "xargs" || base === "sed" || base === "ln") {
          fail(`${base} denied when scope is active; use edit/write tools instead`);
          expectCommand = false;
          leaveWrapper();
          i++;
          continue;
        }
        if (base in WRAPPER_SPECS) {
          enterWrapper(WRAPPER_SPECS[base], base);
          i++;
          continue;
        }
        leaveWrapper();
        // 落到命令判定（复用下方同一词的 dispatch）
      }
      const tok = t as Extract<ShellTok, { kind: "word" }>;
      // `[` 测试括号式：整体消费至 `]`（只读断言，操作数忽略；`[[ ]]` 已在分词层跳过）。
      if (w === "[") {
        let j = i + 1;
        while (j < n) {
          const u = toks[j];
          if (u.kind === "op") break;
          if (u.kind === "word" && (u as Extract<ShellTok, { kind: "word" }>).value === "]") { j++; break; }
          j++;
        }
        i = j;
        expectCommand = false;
        continue;
      }
      // 命令位置动态/glob 检查：$T、$(…)、反引号、${…} 等作命令词时最终命令未知 → 拒绝；
      // 纯 $((…)) 算术除外（arith=true 且 dynamic=false，执行数字无害）。
      if (tok.dynamic) { fail("dynamic command word"); expectCommand = false; i++; continue; }
      if (tok.glob) { fail("glob command word"); expectCommand = false; i++; continue; }
      if (!w) { expectCommand = false; i++; continue; } // 纯算术/空命令词：无害
      const base = shellBasename(w);
      // 高风险复杂语义直接拒绝（不再透视/建模）：xargs、sed、硬链/软链创建（ln 全形态）。
      // cp 链接模式（-l/--link/-s/--symbolic-link 任意位置）同样直接拒绝；普通 cp 仍按 dest 建模。
      if (base === "xargs" || base === "sed" || base === "ln") {
        fail(`${base} denied when scope is active; use edit/write tools instead`);
        expectCommand = false;
        i++;
        continue;
      }
      if (base === "cp" && cpLinkMode(toks, i + 1)) {
        fail("cp link mode denied when scope is active; use edit/write tools instead");
        expectCommand = false;
        i++;
        continue;
      }
      if (base in WRAPPER_SPECS) {
        enterWrapper(WRAPPER_SPECS[base], base);
        i++;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { checkEnvAssignment(w, fail); i++; continue; }
      // find：写动作（-delete/-exec/-ok/-fls/-fprint…）一律 fail-closed；
      // 纯读 find（-print/-name/-type…）放行。-exec 子命令仍走常规透视提目标。
      if (base === "find") {
        let k = i + 1;
        while (k < n && toks[k].kind === "word") {
          const fw = (toks[k] as Extract<ShellTok, { kind: "word" }>).value;
          if (FIND_WRITE_ACTIONS.has(fw)) { fail(`find write action: ${fw}`); break; }
          if (fw === ";" || fw === "+") break;
          // 操作符/管道前停：保守起见只扫同一简单命令
          k++;
          // 遇到 -- 等不影响判定，继续扫
        }
        expectCommand = false;
        i++;
        continue;
      }
      if (base in SIMPLE_FILE_CMD_OPTS) {
        const so = SIMPLE_FILE_CMD_OPTS[base];
        i = parseSimpleFileOperands(toks, i + 1, targets, fail, { kind: base, skipNext: so.skipNext, argChars: so.argChars });
        expectCommand = false;
        continue;
      }
      if (base === "dd") {
        i = parseDdOperands(toks, i + 1, targets, fail);
        expectCommand = false;
        continue;
      }
      if (base === "install") {
        i = parseInstallOperands(toks, i + 1, targets, fail, _root);
        expectCommand = false;
        continue;
      }
      if (base === "cp") {
        i = parseCpOperands(toks, i + 1, targets, fail, _root);
        expectCommand = false;
        continue;
      }
      if (base === "mv") {
        i = parseMvOperands(toks, i + 1, targets, fail, _root);
        expectCommand = false;
        continue;
      }
      if (base === "tee") {
        i = parseTeeOperands(toks, i + 1, targets, fail);
        expectCommand = false;
        continue;
      }
      if (SHELL_SHELLS.has(base)) {
        i = parseShDashC(toks, i + 1, targets, fail, _depth, _root);
        expectCommand = false;
        continue;
      }
      if (base === "eval") {
        i = parseEvalArgs(toks, i + 1, targets, fail, _depth, _root);
        expectCommand = false;
        continue;
      }
      if (base === ":") {
        // 空操作：只读，操作数整体忽略。
        let j = i + 1;
        while (j < n && toks[j].kind === "word") j++;
        i = j;
        expectCommand = false;
        continue;
      }
      // 显式白名单：只读命令按选项白名单解析（未知选项/输出文件拒绝）；
      // 未知命令（git/python/node/make/curl/chmod…）可能在解释器/工具内部
      // 写文件，shell 层不可见 → fail-closed。本扩展是门禁不是沙箱，见文件头。
      if (SHELL_SAFE_READONLY.has(base)) {
        i = parseSafeReadonlyOperands(toks, i + 1, targets, fail, base);
        expectCommand = false;
        continue;
      }
      {
        fail(`unknown command: ${base}`);
        expectCommand = false;
        i++;
        continue;
      }
    }
    // 操作数位置：find -exec/-execdir/-ok/-okdir 后是待执行命令；其余忽略（替换体已单独处理）
    if (w === "-exec" || w === "-execdir" || w === "-ok" || w === "-okdir") { expectCommand = true; }
    i++;
  }
  return { targets: [...new Set(targets)], uncertain, reasons: [...new Set(reasons)] };
}

// tee 操作数扫描：返回消费结束位置。选项跳过，`--` 后全为文件，裸 `-` 为 stdout。
function parseTeeOperands(
  toks: ShellTok[],
  start: number,
  targets: string[],
  fail: (r: string) => void,
): number {
  let i = start;
  const n = toks.length;
  let dashdash = false;
  const isOpTok = (t: ShellTok) => t.kind === "op" || t.kind === "subst";
  while (i < n) {
    const t = toks[i];
    if (t.kind === "op" && (t.value === ">(" || t.value === "<(")) {
      // tee 的进程替换操作数：输出交由子进程，无法判定去向 → fail-closed
      fail("process substitution tee operand");
      break;
    }
    if (t.kind === "op" && t.value === "{") {
      // 花括号组（如 find -exec tee {} \; 中的 {}）：运行时展开，未知文件集合，
      // 原样计入（scope 必然不命中 → 拒绝，fail-closed）。
      let j = i + 1;
      let depth = 1;
      let lit = "{";
      let closed = false;
      while (j < n) {
        const u = toks[j];
        if (u.kind === "op" && u.value === "{") { depth++; lit += "{"; }
        else if (u.kind === "op" && u.value === "}") {
          depth--;
          lit += "}";
          if (depth === 0) { closed = true; break; }
        } else if (u.kind === "word") {
          if (u.dynamic || u.glob || u.arith || /[$*?[\]]/.test(u.value)) {
            fail("dynamic tee operand");
            lit = "";
            break;
          }
          lit += u.value;
        } else {
          break; // 其他操作符/替换体：无法解析组内容，停
        }
        j++;
      }
      if (closed && lit) targets.push(lit);
      if (!closed) break;
      i = j + 1;
      continue;
    }
    if (isOpTok(t)) break;
    const w = (t as Extract<ShellTok, { kind: "word" }>).value;
    if (!dashdash && SHELL_TEE_STOPS.has(w)) break;
    if (!dashdash && w === "--") { dashdash = true; i++; continue; }
    if (!dashdash && w === "-") { i++; continue; }
    if (!dashdash && /^-[^\s]+$/.test(w) && w !== "-") { i++; continue; }
    if (w === "+") break; // find -exec … {} + 终止符
    const ww = t as Extract<ShellTok, { kind: "word" }>;
    if (ww.dynamic || ww.arith) { fail("dynamic tee operand"); i++; continue; }
    if (ww.glob) { fail("glob tee operand"); i++; continue; }
    if (!w) { i++; continue; } // 空操作数：shell 报错、无写入
    targets.push(w);
    i++;
  }
  return i;
}

// sh -c 递归：定位 -c/--command 的代码词并复解析；动态代码 → uncertain。
function parseShDashC(
  toks: ShellTok[],
  start: number,
  targets: string[],
  fail: (r: string) => void,
  depth: number,
  _root?: string,
): number {
  let i = start;
  const n = toks.length;
  const isOpTok = (t: ShellTok) => t.kind === "op" || t.kind === "subst";
  while (i < n) {
    const t = toks[i];
    if (isOpTok(t)) return i;
    const w = (t as Extract<ShellTok, { kind: "word" }>).value;
    if (w === "-c" || w === "--command") {
      i++;
      if (i >= n || toks[i].kind !== "word") { fail("missing sh -c code"); return i; }
      const code = toks[i] as Extract<ShellTok, { kind: "word" }>;
      if (code.dynamic || code.glob || code.arith) fail("dynamic sh -c code");
      else {
        const a = analyzeShellWrites(code.value, depth + 1, _root);
        targets.push(...a.targets);
        if (a.uncertain) {
          fail("unparseable sh -c code");
        }
      }
      return i + 1;
    }
    if (/^-[a-zA-Z]+$/.test(w) && w.includes("c")) {
      // 合并短选项 -lc 等：代码在下一个词
      i++;
      if (i >= n || toks[i].kind !== "word") { fail("missing sh -c code"); return i; }
      const code = toks[i] as Extract<ShellTok, { kind: "word" }>;
      if (code.dynamic || code.glob || code.arith) fail("dynamic sh -c code");
      else {
        const a = analyzeShellWrites(code.value, depth + 1, _root);
        targets.push(...a.targets);
        if (a.uncertain) fail("unparseable sh -c code");
      }
      return i + 1;
    }
    i++;
  }
  return i;
}

// eval 参数递归：剩余词 join 后整体复解析；任一动态/glob/算术词 → uncertain。
function parseEvalArgs(
  toks: ShellTok[],
  start: number,
  targets: string[],
  fail: (r: string) => void,
  depth: number,
  _root?: string,
): number {
  let i = start;
  const n = toks.length;
  const words: string[] = [];
  while (i < n && toks[i].kind === "word") {
    const w = toks[i] as Extract<ShellTok, { kind: "word" }>;
    if (w.dynamic || w.arith) fail("dynamic eval argument");
    else if (w.glob) fail("glob eval argument");
    words.push(w.value);
    i++;
  }
  if (words.length > 0) {
    const a = analyzeShellWrites(words.join(" "), depth + 1, _root);
    targets.push(...a.targets);
    if (a.uncertain) fail("unparseable eval argument");
  }
  return i;
}

// 花括号组（如 find -exec cmd {} \; 中的 {}）：运行时展开，未知文件集合，
// 原样计入（scope 必然不命中 → 拒绝，fail-closed）。返回组后位置；-1 表示停。
function parseBraceFileGroup(
  toks: ShellTok[],
  start: number,
  targets: string[],
  fail: (r: string) => void,
  kind: string,
): number {
  const n = toks.length;
  let j = start + 1;
  let depth = 1;
  let lit = "{";
  let closed = false;
  while (j < n) {
    const u = toks[j];
    if (u.kind === "op" && u.value === "{") { depth++; lit += "{"; }
    else if (u.kind === "op" && u.value === "}") {
      depth--;
      lit += "}";
      if (depth === 0) { closed = true; break; }
    } else if (u.kind === "word") {
      if (u.dynamic || u.glob || u.arith || /[$*?[\]]/.test(u.value)) {
        fail(`dynamic ${kind} operand`);
        return -1;
      }
      lit += u.value;
    } else {
      return -1; // 其他操作符/替换体：无法解析组内容，停
    }
    j++;
  }
  if (!closed) return -1;
  if (lit) targets.push(lit);
  return j + 1;
}

// 通用“操作数即文件”解析（touch/rm/mkdir/rmdir/shred/truncate/sudoedit）。
// 选项按“开关整体跳过 / 取参严格消费一词（簇内附带值整体跳过）”处理；
// `--` 后全为操作数；文件操作数逐项计入，动态/glob/算术 → uncertain。
function parseSimpleFileOperands(
  toks: ShellTok[],
  start: number,
  targets: string[],
  fail: (r: string) => void,
  o: { kind: string; skipNext: Set<string>; argChars: Set<string> },
): number {
  let i = start;
  const n = toks.length;
  let dashdash = false;
  let skipOne = false;
  const isOpTok = (t: ShellTok) => t.kind === "op" || t.kind === "subst";
  const isFileWord = (t: ShellTok): boolean => {
    if (t.kind !== "word") return false;
    const w = (t as Extract<ShellTok, { kind: "word" }>).value;
    if (!dashdash && (w === "--" || SHELL_TEE_STOPS.has(w))) return false;
    return true;
  };
  void isFileWord;
  while (i < n) {
    const t = toks[i];
    if (t.kind === "op" && (t.value === ">(" || t.value === "<(")) {
      fail(`process substitution ${o.kind} operand`);
      break;
    }
    if (t.kind === "op" && t.value === "{") {
      const r = parseBraceFileGroup(toks, i, targets, fail, o.kind);
      if (r < 0) break;
      i = r;
      continue;
    }
    if (isOpTok(t)) break;
    const ww = t as Extract<ShellTok, { kind: "word" }>;
    const w = ww.value;
    if (skipOne) { skipOne = false; i++; continue; }
    if (!dashdash && w === "--") { dashdash = true; i++; continue; }
    if (!dashdash && SHELL_TEE_STOPS.has(w)) break;
    if (!dashdash && w.startsWith("--")) {
      if (w.includes("=")) { i++; continue; } // 附带值整体跳过
      if (o.skipNext.has(w)) skipOne = true;
      i++;
      continue;
    }
    if (!dashdash && /^-[A-Za-z].*$/.test(w) && w !== "-") {
      // 短选项簇：取参字母仅在“末位无附带”时消费下一词
      let k = 1;
      while (k < w.length) {
        const ch = w[k];
        if (o.argChars.has(ch)) {
          if (k + 1 >= w.length) skipOne = true;
          break;
        }
        k++;
      }
      i++;
      continue;
    }
    if (!dashdash && /^-/.test(w) && w !== "-") { i++; continue; } // 其他 -x：开关，整体跳过
    if (w === "+") break; // find -exec … {} + 终止符
    if (ww.dynamic || ww.arith) { fail(`dynamic ${o.kind} operand`); i++; continue; }
    if (ww.glob) { fail(`glob ${o.kind} operand`); i++; continue; }
    if (!w) { i++; continue; }
    targets.push(w);
    i++;
  }
  return i;
}

// dd：仅 of= 为写目标（of 与 of= 空值时取下一词）；if= 为读跳过；
// 其他 KEY=VAL 跳过；动态词一律 uncertain（可展开为 of=…）；裸词非法，忽略。
function parseDdOperands(
  toks: ShellTok[],
  start: number,
  targets: string[],
  fail: (r: string) => void,
): number {
  let i = start;
  const n = toks.length;
  const isOpTok = (t: ShellTok) => t.kind === "op" || t.kind === "subst";
  // 取下一词为文件（of 的分离形式）；调用时 i 指向 of/of=，返回其后位置。
  const takeNext = (what: string): number => {
    const j = i + 1;
    if (j >= n || toks[j].kind !== "word") { fail(`missing dd ${what} target`); return j; }
    const f = toks[j] as Extract<ShellTok, { kind: "word" }>;
    if (f.dynamic || f.glob || f.arith) fail(`dynamic dd ${what} target`);
    else if (f.value) targets.push(f.value);
    else fail(`missing dd ${what} target`);
    return j + 1;
  };
  while (i < n) {
    const t = toks[i];
    if (isOpTok(t)) break;
    const ww = t as Extract<ShellTok, { kind: "word" }>;
    const w = ww.value;
    if (w === "--") { i++; continue; }
    if (ww.dynamic || ww.glob || ww.arith) { fail("dynamic dd operand"); i++; continue; }
    if (w === "of") { i = takeNext("of"); continue; }
    if (w.startsWith("of=")) {
      const rest = w.slice(3);
      if (rest) { targets.push(rest); i++; }
      else i = takeNext("of");
      continue;
    }
    if (w === "if" || w.startsWith("if=")) {
      // 读入：跳过（if 裸词时其文件在下一词，同样跳过；读路径不设门）
      i = w === "if" ? i + 2 : i + 1;
      continue;
    }
    i++; // 其他 KEY=VAL / 开关 / 非法裸词：无写目标
  }
  return i;
}

// 取 -t/--target-directory 参数（精确词取下一词；--target-directory=DIR 与 -tDIR 内联）。
// 返回 { dir, next, stop }：stop 为 true 时调用侧应 break（缺参数已 fail）。
function takeTargetDir(
  toks: ShellTok[],
  i: number,
  w: string,
  fail: (r: string) => void,
  kind: string,
): { dir: string | null; next: number; stop: boolean } {
  const n = toks.length;
  if (w === "-t" || w === "--target-directory") {
    const j = i + 1;
    if (j >= n || toks[j].kind !== "word") { fail(`missing ${kind} target directory`); return { dir: null, next: j, stop: true }; }
    const d = toks[j] as Extract<ShellTok, { kind: "word" }>;
    if (d.dynamic || d.glob || d.arith) { fail(`dynamic ${kind} target directory`); return { dir: null, next: j + 1, stop: true }; }
    if (!d.value) { fail(`missing ${kind} target directory`); return { dir: null, next: j + 1, stop: true }; }
    return { dir: d.value, next: j + 1, stop: false };
  }
  if (w.startsWith("--target-directory=")) {
    const dir = w.slice("--target-directory=".length);
    if (!dir) { fail(`missing ${kind} target directory`); return { dir: null, next: i + 1, stop: true }; }
    return { dir, next: i + 1, stop: false };
  }
  if (/^-t[^t\s]/.test(w)) {
    // -tDIR 附带形式（-t 唯一以 t 开头的取参短选项）
    const dir = w.slice(2);
    if (!dir) { fail(`missing ${kind} target directory`); return { dir: null, next: i + 1, stop: true }; }
    return { dir, next: i + 1, stop: false };
  }
  return { dir: null, next: i, stop: false };
}

// 收集命令剩余操作数（含 --、-t/--target-directory 提取、动态检查）。
// 返回 { files, targetDir, next, stopped }。
function collectFileArgs(
  toks: ShellTok[],
  start: number,
  fail: (r: string) => void,
  o: { kind: string; skipNext: Set<string>; argChars: Set<string>; dirFlag: Set<string>; noDirFlag: Set<string> },
): { files: Extract<ShellTok, { kind: "word" }>[]; targetDir: string | null; dirMode: boolean; next: number } {
  let i = start;
  const n = toks.length;
  const files: Extract<ShellTok, { kind: "word" }>[] = [];
  let targetDir: string | null = null;
  let dirMode = false;
  let dashdash = false;
  let skipOne = false;
  const isOpTok = (t: ShellTok) => t.kind === "op" || t.kind === "subst";
  while (i < n) {
    const t = toks[i];
    if (t.kind === "op" && (t.value === ">(" || t.value === "<(")) {
      fail(`process substitution ${o.kind} operand`);
      break;
    }
    if (t.kind === "op" && t.value === "{") {
      // 花括号组不入 files（调用侧无法拼路径）：按未知集合 fail-closed
      fail(`dynamic ${o.kind} operand`);
      break;
    }
    if (isOpTok(t)) break;
    const ww = t as Extract<ShellTok, { kind: "word" }>;
    const w = ww.value;
    if (skipOne) { skipOne = false; i++; continue; }
    if (!dashdash && w === "--") { dashdash = true; i++; continue; }
    if (!dashdash && SHELL_TEE_STOPS.has(w)) break;
    if (!dashdash && (w === "-t" || w === "--target-directory" || w.startsWith("--target-directory=") || /^-t[^t\s]/.test(w))) {
      const r = takeTargetDir(toks, i, w, fail, o.kind);
      i = r.next;
      if (r.stop) break;
      targetDir = r.dir;
      continue;
    }
    if (!dashdash && o.dirFlag.has(w)) { dirMode = true; i++; continue; }
    if (!dashdash && o.noDirFlag.has(w)) { i++; continue; }
    if (!dashdash && w.startsWith("--")) {
      if (w.includes("=")) { i++; continue; }
      if (o.skipNext.has(w)) skipOne = true;
      i++;
      continue;
    }
    if (!dashdash && /^-[A-Za-z].*$/.test(w) && w !== "-") {
      let k = 1;
      while (k < w.length) {
        const ch = w[k];
        if (o.argChars.has(ch)) {
          if (k + 1 >= w.length) skipOne = true;
          break;
        }
        k++;
      }
      i++;
      continue;
    }
    if (!dashdash && /^-/.test(w) && w !== "-") { i++; continue; }
    if (w === "+") break; // find -exec … {} + 终止符
    files.push(ww);
    i++;
  }
  return { files, targetDir, dirMode, next: i };
}


// install/cp/mv 的 dest 计算：-t 模式 join(dir, basename)；-d 模式全为目标；
// 否则末操作数为 dest（多源时 dest 为目录，逐项 join）。
// 目录误判修复：单源 dest 为已存在目录（或尾斜杠）时真实写入是 join，
// 此时动态源 basename 未知 → fail-closed；文件 dest 时动态源不影响目标（源为读）。
function pushDestTargets(
  files: Extract<ShellTok, { kind: "word" }>[],
  targetDir: string | null,
  dirMode: boolean,
  targets: string[],
  fail: (r: string) => void,
  kind: string,
  _root?: string,
): void {
  const base = (p: string): string => {
    const k = p.replace(/\\/g, "/");
    const s = k.endsWith("/") ? k.slice(0, -1) : k;
    const q = s.lastIndexOf("/");
    return q >= 0 ? s.slice(q + 1) : s;
  };
  if (targetDir !== null) {
    for (const f of files) {
      if (f.dynamic || f.glob || f.arith) { fail(`dynamic ${kind} operand`); continue; }
      if (!f.value) continue;
      const b = base(f.value);
      if (!b || b === "." || b === "..") { fail(`dynamic ${kind} operand`); continue; }
      targets.push(targetDir.replace(/\/+$/, "") + "/" + b);
    }
    return;
  }
  if (dirMode) {
    for (const f of files) {
      if (f.dynamic || f.glob || f.arith) { fail(`dynamic ${kind} operand`); continue; }
      if (!f.value) continue;
      targets.push(f.value);
    }
    return;
  }
  if (files.length === 0) return;
  if (files.length === 1) {
    const d = files[0];
    if (d.dynamic || d.glob || d.arith) { fail(`dynamic ${kind} operand`); return; }
    if (d.value) targets.push(d.value);
    return;
  }
  const dest = files[files.length - 1];
  if (dest.dynamic || dest.glob || dest.arith) { fail(`dynamic ${kind} operand`); return; }
  if (!dest.value) { fail(`dynamic ${kind} operand`); return; }
  if (files.length === 2) {
    // 单源：dest 为目录时真实写入是 dest/basename(src)，动态源此时未知 → 拒绝；
    // dest 为文件时 dest 即目标（源为读，动态不影响）。
    if (isDirLikeTarget(_root, dest.value)) {
      const src = files[0];
      if (src.dynamic || src.glob || src.arith || !src.value) { fail(`dynamic ${kind} operand`); return; }
      const b = base(src.value);
      if (!b || b === "." || b === "..") { fail(`dynamic ${kind} operand`); return; }
      targets.push(shellJoinDir(dest.value, src.value));
      return;
    }
    targets.push(dest.value);
    return;
  }
  for (const f of files.slice(0, -1)) {
    if (f.dynamic || f.glob || f.arith) { fail(`dynamic ${kind} operand`); continue; }
    if (!f.value) continue;
    const b = base(f.value);
    if (!b || b === "." || b === "..") { fail(`dynamic ${kind} operand`); continue; }
    targets.push(dest.value.replace(/\/+$/, "") + "/" + b);
  }
}

// install：写目标为 dest（-t/-d 模式见 pushDestTargets）；源读不计入。
// 源动态不影响目标位置判定：单源文件 dest 时忽略源动态；多源/-t/目录 dest 时
// 需 basename，动态源 fail（目录误判修复）。
function parseInstallOperands(
  toks: ShellTok[],
  start: number,
  targets: string[],
  fail: (r: string) => void,
  _root?: string,
): number {
  const o = {
    kind: "install",
    skipNext: new Set(["-m", "--mode", "-o", "--owner", "-g", "--group", "-S", "--suffix"]),
    argChars: new Set(["m", "o", "g", "S", "t"]),
    dirFlag: new Set(["-d", "--directory"]),
    noDirFlag: new Set(["-D", "--no-target-directory", "-T"]),
  };
  const r = collectFileArgs(toks, start, fail, o);
  const { files, targetDir, dirMode } = r;
  if (targetDir === null && !dirMode && files.length <= 1) return r.next; // 缺 dest：shell 报错、无写入
  if (targetDir === null && !dirMode) {
    // dest 确定性检查 + 源 basename 需求检查
    const dest = files[files.length - 1];
    if (dest.dynamic || dest.glob || dest.arith || !dest.value) { fail("dynamic install operand"); return r.next; }
    if (files.length > 2) {
      for (const f of files.slice(0, -1)) {
        if (f.dynamic || f.glob || f.arith || !f.value) { fail("dynamic install operand"); return r.next; }
      }
    }
    pushDestTargets(files, targetDir, dirMode, targets, fail, "install", _root);
    return r.next;
  }
  if (targetDir !== null) {
    for (const f of files) {
      if (f.dynamic || f.glob || f.arith || !f.value) { fail("dynamic install operand"); return r.next; }
    }
  }
  if (dirMode) {
    for (const f of files) {
      if (f.dynamic || f.glob || f.arith || !f.value) { fail("dynamic install operand"); return r.next; }
    }
  }
  pushDestTargets(files, targetDir, dirMode, targets, fail, "install", _root);
  return r.next;
}

// cp：写目标为 dest（-t 模式 join）；源为读，不计入（单源文件 dest 时源动态直接忽略，目录 dest 见 pushDestTargets）。
// 链接模式（-l/--link、-s/--symbolic-link）创建硬链/软链：源逐项校验（动态/外部一律拒绝）。
// cp 链接模式预检：扫描同一简单命令的完整词列（任意位置），
// `-l/--link/-s/--symbolic-link`（含短簇）任一出现即命中；尊重 `--`（其后全为
// 文件名）、跳过 `-t/--target-directory` 与 `-S/--suffix` 的取值。
// 注意 `-S`（大写，后缀）与 `-s`（小写，软链）严格区分。
function cpLinkMode(toks: ShellTok[], start: number): boolean {
  let i = start;
  const n = toks.length;
  let dashdash = false;
  let skipOne = false; // -t/-S 的取值
  while (i < n && toks[i].kind === "word") {
    const w = (toks[i] as Extract<ShellTok, { kind: "word" }>).value;
    if (skipOne) { skipOne = false; i++; continue; }
    if (!dashdash && w === "--") { dashdash = true; i++; continue; }
    if (dashdash) { i++; continue; } // -- 后全为文件名，不再是选项
    if (w === "-l" || w === "--link" || w === "-s" || w === "--symbolic-link") return true;
    if (w === "-t" || w === "--target-directory" || w === "-S" || w === "--suffix") { skipOne = true; i++; continue; }
    if (w.startsWith("--target-directory=") || w.startsWith("--suffix=")) { i++; continue; }
    if (w.startsWith("--")) { i++; continue; }
    if (/^-[A-Za-z]+$/.test(w)) {
      // 短簇逐字母扫描：l/s 即链接模式；t/S 取值（簇内剩余为附带值，
      // 否则消费下词），其余字母继续。
      let k = 1;
      while (k < w.length) {
        const ch = w[k];
        if (ch === "l" || ch === "s") return true;
        if (ch === "t" || ch === "S") {
          if (k + 1 >= w.length) skipOne = true;
          break;
        }
        k++;
      }
      i++;
      continue;
    }
    i++; // 操作数/其他 -x：继续扫描（任意位置）
  }
  return false;
}

function parseCpOperands(
  toks: ShellTok[],
  start: number,
  targets: string[],
  fail: (r: string) => void,
  _root?: string,
): number {
  const o = {
    kind: "cp",
    skipNext: new Set(["-S", "--suffix", "-t", "--target-directory"]),
    argChars: new Set(["S", "t"]),
    dirFlag: new Set<string>(),
    noDirFlag: new Set(["-T", "--no-target-directory"]),
  };
  const r = collectFileArgs(toks, start, fail, o);
  const { files, targetDir } = r;
  if (targetDir === null && files.length <= 1) return r.next;
  if (targetDir === null) {
    const dest = files[files.length - 1];
    if (dest.dynamic || dest.glob || dest.arith || !dest.value) { fail("dynamic cp operand"); return r.next; }
    if (files.length > 2) {
      for (const f of files.slice(0, -1)) {
        if (f.dynamic || f.glob || f.arith || !f.value) { fail("dynamic cp operand"); return r.next; }
      }
    }
    // 单源文件 dest：源为读，动态不影响目标判定（目录 dest 见 pushDestTargets）。
    pushDestTargets(files, targetDir, false, targets, fail, "cp", _root);
    return r.next;
  }
  for (const f of files) {
    if (f.dynamic || f.glob || f.arith || !f.value) { fail("dynamic cp operand"); return r.next; }
  }
  pushDestTargets(files, targetDir, false, targets, fail, "cp", _root);
  return r.next;
}

// mv：dest 规则同 cp；且源文件被删除（同属修改），逐项计入 scope 校验。
function parseMvOperands(
  toks: ShellTok[],
  start: number,
  targets: string[],
  fail: (r: string) => void,
  _root?: string,
): number {
  const o = {
    kind: "mv",
    skipNext: new Set(["-S", "--suffix", "-t", "--target-directory"]),
    argChars: new Set(["S", "t"]),
    dirFlag: new Set<string>(),
    noDirFlag: new Set(["-T", "--no-target-directory", "--strip-trailing-slashes"]),
  };
  const r = collectFileArgs(toks, start, fail, o);
  const { files, targetDir } = r;
  if (targetDir === null && files.length <= 1) return r.next;
  // 源动态/glob 不可枚举被删集合 → uncertain（fail-closed）
  for (const f of files) {
    if (f.dynamic || f.glob || f.arith || !f.value) { fail("dynamic mv operand"); return r.next; }
  }
  // 源逐项计入（删除同属修改）
  for (const f of files) {
    if (f.value) targets.push(f.value);
  }
  if (targetDir !== null) {
    const base = (p: string): string => {
      const k = p.replace(/\\/g, "/");
      const s = k.endsWith("/") ? k.slice(0, -1) : k;
      const q = s.lastIndexOf("/");
      return q >= 0 ? s.slice(q + 1) : s;
    };
    for (const f of files) {
      const b = base(f.value);
      if (!b || b === "." || b === "..") { fail("dynamic mv operand"); continue; }
      targets.push(targetDir.replace(/\/+$/, "") + "/" + b);
    }
    return r.next;
  }
  if (files.length === 1) return r.next; // 已计入源；单操作数无 dest（shell 报错）
  const dest = files[files.length - 1];
  if (files.length === 2) {
    // dest 已作为源计入；dest 为目录时真实目标是 dest/basename(src)，一并计入。
    if (isDirLikeTarget(_root, dest.value)) {
      const src = files[0];
      targets.push(shellJoinDir(dest.value, src.value));
    }
    return r.next;
  }
  const base = (p: string): string => {
    const k = p.replace(/\\/g, "/");
    const s = k.endsWith("/") ? k.slice(0, -1) : k;
    const q = s.lastIndexOf("/");
    return q >= 0 ? s.slice(q + 1) : s;
  };
  for (const f of files.slice(0, -1)) {
    const b = base(f.value);
    if (!b || b === "." || b === "..") { fail("dynamic mv operand"); continue; }
    targets.push(dest.value.replace(/\/+$/, "") + "/" + b);
  }
  return r.next;
}

// 从 shell 命令中提取显式写/删目标（重定向 > >>、tee/dd of=/touch/rm/mkdir/
// rmdir/shred/truncate/install/cp/mv/sudoedit/sort -o/uniq 输出/less -o
// 的文件操作数；sed/xargs/ln/cp 链接模式 scope 激活时直接拒绝，不在此提取）。
// awk 脚本内写、source/sh 执行脚本文件、未知自定义包装器等不解析：
// 缺口由 edit 钩子与 fail-closed 覆盖（无法安全判定时 uncertain → 调用侧拒绝）。
export function shellWriteTargets(command: string): string[] {
  return analyzeShellWrites(command).targets;
}

// 是否“看起来像写”：存在静态写目标，或命令无法被安全解析。
export function shellLooksLikeWrite(command: string): boolean {
  try {
    const a = analyzeShellWrites(command);
    return a.targets.length > 0 || a.uncertain;
  } catch {
    return true;
  }
}

// 单个 shell 写目标的归类：返回 null 表示放行（/dev/null 精确豁免；
// NUL 大小写变体视为 Windows 空设备同样豁免），否则返回应报告的 bad 条目。
// 原插件对仓库外/`~`/越界 `..` 一律不管（放行），本移植收紧为默认拒绝
// （scope 只能声明仓库相对 glob，仓库外不可能合规）。
// 另做 symlink 双检：lexical 在 scope 内但 realpath 落到 scope 外/仓库外同样拒绝。
function classifyShellTarget(root: string, scope: string[], raw: string): string | null {
  const t = raw.replace(/\\/g, "/");
  if (t === "/dev/null" || t.toUpperCase() === "NUL") return null;
  if (t === "~" || t.startsWith("~/")) return t;
  let rel: string;
  if (path.posix.isAbsolute(t) || /^[A-Za-z]:\//.test(t)) {
    const r = path.relative(root, path.normalize(t));
    if (r === "" || r.startsWith("..") || path.isAbsolute(r)) return t;
    rel = r.split(path.sep).join(path.posix.sep);
  } else {
    rel = path.posix.normalize(t);
    if (rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel)) return t;
  }
  // symlink 越界：仓库内路径经解析落到仓库外 → 拒绝（返回原样目标）。
  try {
    if (escapesRoot(root, lexicalAbs(root, t))) return t;
  } catch {
    return t;
  }
  if (!inScope(scope, rel)) return rel;
  // symlink scope 双检：真实位置超出 scope 同样拒绝（返回真实 rel 以便定位）。
  const realRel = realRelOf(root, t);
  if (realRel !== null && realRel !== rel && !inScope(scope, realRel)) return realRel;
  return null;
}

// 写目标落在仓库内但超出 scope 时返回它们；落在仓库外默认拒绝并返回原样目标。
// 移除 `/dev/null` 特判的代价是 `> /dev/null 2>&1` 这类遍地合法写法在实现期全被拦断，
// 故保留精确匹配特判而非移除——保留之所以安全，是因为枚举已完整：逐项校验下
// `tee /dev/null /tmp/evil` 中的后者仍被拒绝（回归测试锁定）。
// 无法安全解析的命令返回哨兵条目（调用侧视为 bad，fail-closed）。
export function outOfScopeTargets(root: string, scope: string[], command: string): string[] {
  const a = analyzeShellWrites(command, 0, root);
  if (a.uncertain) return [`<unparseable: ${a.reasons.join("; ")}>`];
  const bad: string[] = [];
  for (const raw of a.targets) {
    const b = classifyShellTarget(root, scope, raw);
    if (b !== null) bad.push(b);
  }
  return [...new Set(bad)];
}

export function normalizeScopeEntry(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!t || t.startsWith("..") || t.startsWith("/") || t.includes("\u0000")) return null;
  return t;
}

type SessionLike = Pick<ExtensionContext, "sessionManager" | "cwd">;

export function sessionKey(ctx: SessionLike): string {
  try {
    const f = ctx.sessionManager.getSessionFile();
    if (typeof f === "string" && f.length > 0) return `file:${f}`;
  } catch {
    // 忽略：回退到 sessionId / cwd
  }
  try {
    const id = ctx.sessionManager.getSessionId();
    if (typeof id === "string" && id.length > 0) return `id:${id}`;
  } catch {
    // 忽略：回退到 cwd
  }
  return `cwd:${ctx.cwd}`;
}

export function resolveRoot(ctx: SessionLike, sessionKeyStr: string): string | null {
  const cached = rootCache.get(sessionKeyStr);
  if (cached !== undefined) return cached;
  // Pi 单 cwd 模型：直接从当前工作目录向上找项目根（原插件沿 parentID 链
  // 查询子 session 的做法在此无对应物，fork/resume 由 session_start 继承事务）。
  const root = findProjectRoot(ctx.cwd);
  cacheRoot(sessionKeyStr, root);
  return root;
}

export function getActiveTxn(sessionKeyStr: string): Txn | undefined {
  return txns.get(sessionKeyStr);
}

function toolText(data: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...data });
}

function toolFail(error: string): { content: [{ type: "text"; text: string }]; details: Record<string, unknown> } {
  const text = JSON.stringify({ ok: false, error });
  return { content: [{ type: "text", text }], details: { ok: false, error } };
}

function toolOk(data: Record<string, unknown>): { content: [{ type: "text"; text: string }]; details: Record<string, unknown> } {
  const text = toolText(data);
  return { content: [{ type: "text", text }], details: { ok: true, ...data } };
}

function blockTxn(txn: Txn, sessionKeyStr: string, reason: string): { content: [{ type: "text"; text: string }]; details: Record<string, unknown> } {
  txn.phase = "blocked";
  txn.blockReason = reason;
  touchTxn(sessionKeyStr, txn);
  return toolFail(`rework blocked: ${reason}`);
}

function rejectStage(reason: string) {
  return toolFail(reason);
}

function stateSection(txn: Txn): string {
  const lines = [
    "[speckit-rework-gate] Rework transaction state machine (authoritative):",
    `phase=${txn.phase} feature=${txn.featureDir || "(unselected)"}`,
    "Rules: /speckit.* commands bypass this plugin. Before implementation, call speckit_rework_assess_impact with affectedStages, scope (repo-relative writable globs), and explain why omitted stages are unaffected. Only affected stages and their downstream dependencies are gated, in spec -> plan -> tasks -> checklists order. An empty affectedStages list opens the implementation after the assessment. Close with speckit_rework_close when done. Writes outside the repo are denied by default while a transaction is active (only /dev/null redirect is allowed); scope globs are repo-relative. Symlinked paths are resolved (realpath/lstat): a repo-relative path that resolves outside the repo or outside scope is denied.",
    "Never create features, never switch git branches, never bypass the impact assessment. Shell redirect/tee/dd/touch/rm/mkdir/install/cp/mv/sudoedit/sort -o/uniq/less -o targets outside scope are denied; sed, xargs and link creation (ln, cp -l/--link/-s) are denied when scope is active; Bash allows only an explicit whitelist (read-only commands with strict per-command option shapes, plus modeled writes), unknown commands/options, find write actions, `-` stdin markers with output present, any dynamic word/command substitution/backquote in any argument position, and non-whitelisted env assignments (TMPDIR/TMP/TEMP, env -S, unknown vars) are denied fail-closed; static paths and SAFE_ENV_VARS are unaffected; other shell file writes (Copy-Item/cmdlets, awk w commands, sourced scripts) are not auto-checked, prefer edit tools. Commands whose write targets cannot be safely parsed are denied (fail-closed). This gate is not a sandbox. Blocked transactions stay blocked unless explicitly reset.",
  ];
  if (txn.summaries.impact) lines.push(`impactAssessment=${txn.summaries.impact}`);
  if (txn.affectedStages.length > 0) lines.push(`affectedStages=${txn.affectedStages.join(",")}`);
  if (txn.scope.length > 0) lines.push(`scope=${txn.scope.join(",")}`);
  if (txn.phase === "blocked" && txn.blockReason) lines.push(`blockReason=${txn.blockReason}`);
  if (txn.phase === "closed") {
    lines.push("Transaction closed. Further edits require speckit_rework_select_feature + speckit_rework_assess_impact.");
  }
  if (txn.phase === "implementation-open") {
    lines.push(
      "Implementation is open for this session. tasks.md checkbox updates only via speckit_rework_complete_task; task text is frozen. If implementation reveals an upstream artifact was missed, stop implementation and start a new rework assessment.",
    );
  }
  return lines.join("\n");
}

// 路径写拦截（edit/write/含 path 的自定义工具共用；返回 block 原因或 undefined=放行）。
// 加固（相对原插件的有意偏离，见 handoff）：仓库外路径默认拒绝——原插件 `outside → continue`
// 允许任何仓库外写入（全阶段），scope 又只能声明仓库相对 glob，构成绕过。本移植在事务
// 存续的任何阶段一律拒绝仓库外写入；唯一明确最小例外是 shell 重定向到 /dev/null
//（空设备汇点，无持久化，见 outOfScopeTargets）。
function checkPathWrite(txn: Txn, resource: string): string | undefined {
  const kind = classify(txn.root, txn.featureDir || "specs/__unselected__", resource);
  if (kind.kind === "outside") {
    return `[speckit-rework-gate] ${resource} is outside the repository (${txn.root}). Writes outside the repo are denied by default while a rework transaction is active (phase=${txn.phase}); scope only covers repo-relative paths. Keep rework writes inside the repo, or reset/close the transaction first.`;
  }
  if (kind.kind === "infra" || kind.kind === "speckit-cmd") {
    return "[speckit-rework-gate] Spec Kit infrastructure is always read-only in rework mode.";
  }
  if (txn.phase === "blocked" || txn.phase === "needs-feature" || txn.phase === "closed") {
    return txn.phase === "blocked"
      ? `[speckit-rework-gate] Transaction blocked: ${txn.blockReason ?? "unknown"}. No edits allowed.`
      : txn.phase === "closed"
        ? "[speckit-rework-gate] Transaction closed. Further edits require speckit_rework_select_feature + speckit_rework_assess_impact."
        : "[speckit-rework-gate] Select a feature first via speckit_rework_list_features + speckit_rework_select_feature. No edits allowed before that.";
  }
  if (txn.phase === "implementation-open") {
    if (kind.kind === "spec") {
      return kind.stage === "tasks"
        ? "[speckit-rework-gate] tasks.md text is frozen. Use speckit_rework_complete_task for checkbox updates."
        : "[speckit-rework-gate] Spec artifacts are frozen once implementation is open.";
    }
    if (kind.kind === "impl" && !inScope(txn.scope, kind.rel)) {
      return `[speckit-rework-gate] ${kind.rel} is outside the assessed scope [${txn.scope.join(", ")}]. Re-run speckit_rework_assess_impact with an expanded scope.`;
    }
    if (kind.kind === "impl") {
      // symlink scope 双检：真实位置超出 scope 同样拒绝。
      const realRel = realRelOf(txn.root, resource);
      if (realRel !== null && realRel !== kind.rel && !inScope(txn.scope, realRel)) {
        return `[speckit-rework-gate] ${resource} resolves to ${realRel}, outside the assessed scope [${txn.scope.join(", ")}]. Re-run speckit_rework_assess_impact with an expanded scope.`;
      }
    }
    return undefined;
  }
  if (txn.phase === "impact-pending") {
    return "[speckit-rework-gate] Implementation and artifact edits are blocked until speckit_rework_assess_impact records the upstream impact assessment.";
  }
  const expected = expectedStage(txn.phase);
  if (kind.kind === "impl" || kind.kind === "spec") {
    const allowedWrite = kind.kind === "spec" && kind.stage === expected;
    if (!allowedWrite) {
      return `[speckit-rework-gate] Phase=${txn.phase}: only affected stage ${expected} is writable now. Implementation edits stay blocked until the declared affected stages pass.`;
    }
  }
  return undefined;
}

// shell 写拦截（bash/powershell 共用；返回 block 原因或 undefined=放行）。
// 先做词法分析：无法安全解析（uncertain）一律拒绝；纯 fd 操作（2>&1 等）
// 无文件目标且命令全在白名单内，直接放行（原插件 looks-like-write 会误拦，属有意修正）。
// 白名单外未知命令 / find 写动作 / xargs 非只读子命令在分析层已置 uncertain。
function checkShellWrite(txn: Txn, command: string): string | undefined {
  const a = analyzeShellWrites(command, 0, txn.root);
  if (a.uncertain) {
    return `[speckit-rework-gate] Shell command denied: cannot safely determine write targets (${a.reasons.join("; ")}). Simplify the command (avoid dynamic paths, unbalanced quotes, eval/sh -c with variables) or reset/close the transaction first.`;
  }
  if (a.targets.length === 0) return undefined;
  if (txn.phase === "implementation-open") {
    const bad: string[] = [];
    for (const raw of a.targets) {
      const b = classifyShellTarget(txn.root, txn.scope, raw);
      if (b !== null) bad.push(b);
    }
    if (bad.length > 0) {
      return `[speckit-rework-gate] Shell write target outside assessed scope: ${[...new Set(bad)].join(", ")}. Scope=[${txn.scope.join(", ")}]. Re-run speckit_rework_assess_impact with an expanded scope.`;
    }
    return undefined;
  }
  return `[speckit-rework-gate] Shell writes are blocked during rework review (phase=${txn.phase}). Complete the upstream impact assessment and any declared stage gates first.`;
}

export default function (pi: ExtensionAPI) {
  const NS = { name: "speckit_rework", description: "Spec Kit rework gates: feature select and stage checks" } as const;

  pi.registerTool({
    name: "speckit_rework_list_features",
    label: "Speckit Rework: List Features",
    description:
      "List existing Spec Kit features with rework eligibility. Call this first when handling an ordinary modification request in a Spec Kit project.",
    parameters: Type.Object({}, { additionalProperties: false }),
    namespace: { ...NS },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const key = sessionKey(ctx);
      const root = resolveRoot(ctx, key);
      if (!root) return toolFail("not a Spec Kit project");
      return toolOk({ pointer: readFeaturePointer(root), features: listFeatures(root) });
    },
  });

  pi.registerTool({
    name: "speckit_rework_select_feature",
    label: "Speckit Rework: Select Feature",
    description:
      "Select the existing feature for this rework. Writes .specify/feature.json pointer only, never creates features or switches git branches. Feature must come from speckit_rework_list_features.",
    parameters: Type.Object(
      {
        featureDirectory: Type.String({
          description: "Feature directory relative to project root, e.g. specs/001-user-auth",
        }),
      },
      { additionalProperties: false },
    ),
    namespace: { ...NS },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const key = sessionKey(ctx);
      const root = resolveRoot(ctx, key);
      if (!root) return toolFail("not a Spec Kit project");
      const raw = (params as { featureDirectory?: unknown }).featureDirectory;
      if (typeof raw !== "string" || raw.length === 0) {
        return toolFail("featureDirectory is required");
      }
      const normalized = path.posix.normalize(raw.replace(/\\/g, "/"));
      if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) {
        return toolFail("featureDirectory must be a specs/ relative path");
      }
      const hit = listFeatures(root).find((f) => f.directory === normalized);
      if (!hit) {
        return toolFail(`unknown feature '${normalized}'. Use speckit_rework_list_features and never create features in rework mode.`);
      }
      if (!hit.hasSpec || !hit.hasPlan || !hit.hasTasks) {
        return toolFail(
          `feature '${normalized}' misses spec/plan/tasks artifacts. Stop and ask the user to run the matching /speckit.* command.`,
        );
      }
      if (hit.completedTasks === 0) {
        return toolFail(
          `feature '${normalized}' has no completed tasks, so it never went through implement. Rework mode refused; use the normal /speckit.* flow.`,
        );
      }
      const pointerAbs = path.join(root, ".specify", "feature.json");
      try {
        await withFileMutationQueue(pointerAbs, async () => {
          let pointer: Record<string, unknown> = {};
          try {
            pointer = JSON.parse(readFileSync(pointerAbs, "utf8")) as Record<string, unknown>;
          } catch {
            pointer = {};
          }
          pointer.feature_directory = normalized;
          writeFileSync(pointerAbs, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
        });
      } catch (e) {
        return toolFail(`cannot write feature pointer: ${String(e)}`);
      }
      touchTxn(key, {
        root,
        featureDir: normalized,
        phase: "impact-pending",
        affectedStages: [],
        scope: [],
        snapshots: snapshotFeature(root, normalized),
        summaries: {},
      });
      return toolOk({
        featureDirectory: normalized,
        next: "call speckit_rework_assess_impact with affectedStages AND scope (repo-relative writable globs) before editing",
      });
    },
  });

  pi.registerTool({
    name: "speckit_rework_reset",
    label: "Speckit Rework: Reset",
    description:
      "Explicitly reset the current rework transaction after a recoverable gate error or when abandoning the rework.",
    parameters: Type.Object(
      {
        reason: Type.String({ description: "Why the current rework transaction is being reset" }),
      },
      { additionalProperties: false },
    ),
    namespace: { ...NS },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const key = sessionKey(ctx);
      const txn = getActiveTxn(key);
      if (!txn) return toolFail("no active rework transaction");
      const reason = (params as { reason?: unknown }).reason;
      if (typeof reason !== "string" || reason.trim().length === 0) {
        return toolFail("reason is required");
      }
      deleteTxn(txn);
      return toolOk({
        reset: true,
        featureDirectory: txn.featureDir,
        reason: reason.trim(),
        next: "call speckit_rework_select_feature again",
      });
    },
  });

  pi.registerTool({
    name: "speckit_rework_assess_impact",
    label: "Speckit Rework: Assess Impact",
    description:
      "Record which upstream artifacts are affected before implementation. The plugin automatically includes downstream dependent stages and only gates those stages; an empty list opens implementation after recording the rationale.",
    parameters: Type.Object(
      {
        affectedStages: Type.Array(
          Type.Union([Type.Literal("spec"), Type.Literal("plan"), Type.Literal("tasks"), Type.Literal("checklists")]),
          { description: "Stages that need changes; downstream dependent stages are added automatically." },
        ),
        summary: Type.String({
          description: "Impact assessment, including why omitted stages do not need changes.",
        }),
        scope: Type.Array(Type.String(), {
          description:
            "REQUIRED: repo-relative file globs writable during implementation (e.g. ['docs/paper-outline.md', 'scripts/plot_*.py']). Writes outside scope are denied once implementation opens.",
        }),
      },
      { additionalProperties: false },
    ),
    namespace: { ...NS },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const key = sessionKey(ctx);
      const txn = getActiveTxn(key);
      const parsed = params as { affectedStages?: unknown; summary?: unknown; scope?: unknown };
      if (!txn || txn.phase !== "impact-pending") {
        return toolFail("impact assessment is only accepted before rework stage gates");
      }
      if (
        !Array.isArray(parsed.affectedStages) ||
        parsed.affectedStages.some(
          (stage) => stage !== "spec" && stage !== "plan" && stage !== "tasks" && stage !== "checklists",
        )
      ) {
        return toolFail("affectedStages must contain only spec, plan, tasks or checklists");
      }
      if (typeof parsed.summary !== "string" || parsed.summary.trim().length === 0) {
        return toolFail("summary is required and must explain why omitted stages are unaffected");
      }
      if (!Array.isArray(parsed.scope) || parsed.scope.length === 0) {
        return toolFail("scope is required: list repo-relative writable file globs for this implementation");
      }
      const scope: string[] = [];
      for (const entry of parsed.scope as unknown[]) {
        const n = normalizeScopeEntry(entry);
        if (n === null) {
          return toolFail(`invalid scope entry '${String(entry)}': must be a repo-relative path glob`);
        }
        scope.push(n);
      }
      const affected = new Set(parsed.affectedStages as Stage[]);
      if (affected.has("spec")) {
        affected.add("plan");
        affected.add("tasks");
        affected.add("checklists");
      }
      if (affected.has("plan")) {
        affected.add("tasks");
        affected.add("checklists");
      }
      if (affected.has("tasks")) affected.add("checklists");
      txn.affectedStages = (["spec", "plan", "tasks", "checklists"] as Stage[]).filter((stage) =>
        affected.has(stage),
      );
      txn.summaries = { ...txn.summaries, impact: parsed.summary.trim() };
      txn.scope = scope;
      txn.phase = txn.affectedStages.length > 0 ? phaseForStage(txn.affectedStages[0]) : "implementation-open";
      touchTxn(key, txn);
      return toolOk({
        affectedStages: txn.affectedStages,
        phase: txn.phase,
        next: txn.affectedStages[0] ?? "implementation",
      });
    },
  });

  pi.registerTool({
    name: "speckit_rework_close",
    label: "Speckit Rework: Close",
    description:
      "Close the current rework transaction after implementation is done. After closing, all edits are blocked until a new select + impact assessment.",
    parameters: Type.Object(
      {
        summary: Type.String({ description: "What was implemented within the declared scope." }),
      },
      { additionalProperties: false },
    ),
    namespace: { ...NS },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const key = sessionKey(ctx);
      const txn = getActiveTxn(key);
      if (!txn) return toolFail("no active rework transaction");
      if (txn.phase !== "implementation-open") {
        return toolFail(`cannot close from phase ${txn.phase}`);
      }
      const summary = (params as { summary?: unknown }).summary;
      if (typeof summary !== "string" || summary.trim().length === 0) {
        return toolFail("summary is required");
      }
      txn.summaries.impact = `${txn.summaries.impact ?? ""} [closed] ${summary.trim()}`;
      txn.phase = "closed";
      touchTxn(key, txn);
      return toolOk({
        phase: txn.phase,
        next: "implementation closed; call speckit_rework_select_feature + speckit_rework_assess_impact before further edits",
      });
    },
  });

  pi.registerTool({
    name: "speckit_rework_gate",
    label: "Speckit Rework: Gate",
    description:
      "Submit one affected rework stage at a time in dependency order. Only stages declared by speckit_rework_assess_impact are gated; update requires files to change and no-change requires them unchanged.",
    parameters: Type.Object(
      {
        stage: Type.String({ description: "One of: spec, plan, tasks, checklists" }),
        decision: Type.String({
          description: "update if this change required editing the stage, else no-change",
        }),
        summary: Type.String({ description: "Why this decision was made" }),
      },
      { additionalProperties: false },
    ),
    namespace: { ...NS },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const key = sessionKey(ctx);
      const txn = getActiveTxn(key);
      const parsed = params as { stage?: unknown; decision?: unknown; summary?: unknown };
      if (!txn) return toolFail("no active rework transaction for this session");
      if (txn.phase === "blocked") {
        return toolFail(`transaction blocked: ${txn.blockReason ?? "unknown"}`);
      }
      if (txn.phase === "implementation-open" || txn.phase === "needs-feature" || txn.phase === "closed") {
        return toolFail(`gate not accepted in phase ${txn.phase}`);
      }
      if (parsed.stage !== "spec" && parsed.stage !== "plan" && parsed.stage !== "tasks" && parsed.stage !== "checklists") {
        return toolFail("stage must be spec, plan, tasks or checklists");
      }
      if (parsed.decision !== "update" && parsed.decision !== "no-change") {
        return toolFail("decision must be update or no-change");
      }
      if (typeof parsed.summary !== "string" || parsed.summary.trim().length === 0) {
        return toolFail("summary is required");
      }
      const expected = expectedStage(txn.phase);
      if (parsed.stage !== expected) {
        return blockTxn(
          txn,
          key,
          `stage out of order: got ${String(parsed.stage)}, expected ${expected}. Stages must follow dependency order: spec -> plan -> tasks -> checklists.`,
        );
      }
      if (parsed.stage === "checklists") {
        const scan = scanChecklists(txn.root, txn.featureDir);
        if (!scan.pass) {
          return blockTxn(txn, key, `checklists failing: ${scan.detail}. Implementation refused.`);
        }
        txn.summaries.checklists = scan.skipped ? `skipped (${scan.detail})` : `passed (${scan.detail})`;
        txn.phase = nextAffectedPhase(txn, "checklists");
        touchTxn(key, txn);
        return toolOk({
          phase: txn.phase,
          checklists: scan.skipped ? `skipped: ${scan.detail}` : `passed: ${scan.detail}`,
          next: txn.phase === "implementation-open" ? "implementation" : expectedStage(txn.phase),
        });
      }
      const files = stageFiles(txn.featureDir, parsed.stage);
      const before = txn.snapshots;
      const now: Record<string, string | null> = {};
      for (const rel of files) now[rel] = hashPath(path.join(txn.root, rel));
      const changed = files.filter((rel) => (before[rel] ?? null) !== (now[rel] ?? null));
      const othersChanged = Object.keys(before).filter(
        (rel) => !files.includes(rel) && before[rel] !== hashPath(path.join(txn.root, rel)),
      );
      if (othersChanged.length > 0) {
        return blockTxn(
          txn,
          key,
          `files outside stage ${parsed.stage} changed during this stage: ${othersChanged.join(", ")}.`,
        );
      }
      if (parsed.decision === "update" && changed.length === 0) {
        return rejectStage(`stage ${parsed.stage} reported update but no stage file changed.`);
      }
      if (parsed.decision === "no-change" && changed.length > 0) {
        return rejectStage(`stage ${parsed.stage} reported no-change but files changed: ${changed.join(", ")}.`);
      }
      txn.summaries[parsed.stage] = parsed.summary;
      for (const rel of files) {
        const h = now[rel];
        if (h === null) delete txn.snapshots[rel];
        else txn.snapshots[rel] = h;
      }
      txn.phase = nextAffectedPhase(txn, parsed.stage);
      touchTxn(key, txn);
      return toolOk({
        phase: txn.phase,
        changed,
        next: txn.phase === "implementation-open" ? "implementation" : expectedStage(txn.phase),
      });
    },
  });

  pi.registerTool({
    name: "speckit_rework_complete_task",
    label: "Speckit Rework: Complete Task",
    description:
      "Mark one tasks.md task as done during the implementation phase. Only checkbox toggles are allowed; task text can never be edited in rework implementation.",
    parameters: Type.Object(
      {
        taskId: Type.String({ description: "Substring identifying one unchecked task line, e.g. 2.3" }),
      },
      { additionalProperties: false },
    ),
    namespace: { ...NS },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const key = sessionKey(ctx);
      const txn = getActiveTxn(key);
      if (!txn || txn.phase !== "implementation-open") {
        return toolFail("tasks can only be checked off after gates open implementation");
      }
      const taskId = (params as { taskId?: unknown }).taskId;
      if (typeof taskId !== "string" || taskId.trim().length === 0) {
        return toolFail("taskId is required");
      }
      const tasksRel = path.posix.join(txn.featureDir, "tasks.md");
      const tasksAbs = path.join(txn.root, tasksRel);
      let line: string;
      try {
        await withFileMutationQueue(tasksAbs, async () => {
          let text: string;
          try {
            text = readFileSync(tasksAbs, "utf8");
          } catch (e) {
            throw new Error(`cannot read tasks.md: ${String(e)}`);
          }
          const lines = text.split("\n");
          const hits: number[] = [];
          lines.forEach((ln, i) => {
            if (/^- \[ \]/.test(ln) && ln.includes(taskId)) hits.push(i);
          });
          if (hits.length === 0) throw new Error(`no unchecked task line contains '${taskId}'`);
          if (hits.length > 1) throw new Error(`ambiguous taskId '${taskId}', matches ${hits.length} lines`);
          lines[hits[0]] = lines[hits[0]].replace("- [ ]", "- [x]");
          try {
            writeFileSync(tasksAbs, lines.join("\n"), "utf8");
          } catch (e) {
            throw new Error(`cannot write tasks.md: ${String(e)}`);
          }
          line = lines[hits[0]].trim();
          const h = hashFile(tasksAbs);
          if (h !== null) txn.snapshots[tasksRel] = h;
          touchTxn(key, txn);
        });
      } catch (e) {
        return toolFail(String(e instanceof Error ? e.message : e));
      }
      return toolOk({ line: line! });
    },
  });

  // 原 prompt 钩子：普通修改请求自动开启事务；/speckit.* 完全旁路并清事务。
  pi.on("input", async (event, ctx) => {
    const text = event.text ?? "";
    const key = sessionKey(ctx);
    if (OFFICIAL_RE.test(text)) {
      // 正常 Spec Kit 流程：插件完全旁路，清除返工事务。
      const existing = getActiveTxn(key);
      if (existing) deleteTxn(existing);
      else txns.delete(key);
      return undefined;
    }
    if (!MODIFY_RE.test(text)) return undefined;
    const root = resolveRoot(ctx, key);
    if (!root) return undefined;
    const existing = getActiveTxn(key);
    // An active or blocked transaction is never replaced by a later prompt.
    // Recovery is explicit: use speckit_rework_reset, select the feature again,
    // or use /speckit.*. A closed transaction is finished and may be replaced.
    if (existing && existing.phase !== "closed") return undefined;
    if (existing) deleteTxn(existing);
    const feature = pointedEligibleFeature(root);
    // The normal Spec Kit flow and not-yet-implemented features are outside
    // this plugin's scope. The official feature pointer is the authority for
    // deciding which already-implemented feature a rework request targets.
    if (!feature) return undefined;
    touchTxn(key, {
      root,
      featureDir: feature.directory,
      phase: "impact-pending",
      affectedStages: [],
      scope: [],
      snapshots: snapshotFeature(root, feature.directory),
      summaries: {},
    });
    return undefined;
  });

  // 原 context 钩子：把状态机权威说明注入系统提示（Pi 每轮 run 起始注入一次）。
  pi.on("before_agent_start", async (event, ctx) => {
    const txn = getActiveTxn(sessionKey(ctx));
    if (!txn) return undefined;
    event.systemPromptOptions.sections["speckit-rework-gate"] = stateSection(txn);
    return undefined;
  });

  // fork/resume 继承事务（替代原 parentID 链；new/startup/reload 不继承）。
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "resume" && event.reason !== "fork") return undefined;
    const prev = event.previousSessionFile;
    if (!prev) return undefined;
    const prevTxn = txns.get(`file:${prev}`);
    if (!prevTxn) return undefined;
    touchTxn(sessionKey(ctx), prevTxn);
    return undefined;
  });

  // 原 permission/evaluate 钩子：edit/shell 写拦截。
  pi.on("tool_call", async (event, ctx) => {
    const txn = getActiveTxn(sessionKey(ctx));
    if (!txn) return undefined;
    const name = event.toolName;

    if (name === "bash" || name === "powershell") {
      const command = (event.input as { command?: unknown }).command;
      if (typeof command !== "string") return undefined;
      const reason = checkShellWrite(txn, command);
      return reason ? { block: true as const, reason } : undefined;
    }

    if (name === "edit" || name === "write") {
      const resource = (event.input as { path?: unknown }).path;
      if (typeof resource !== "string") return undefined;
      const reason = checkPathWrite(txn, resource);
      return reason ? { block: true as const, reason } : undefined;
    }

    // 第三方写文件工具的尽力覆盖：含字符串 path 字段的自定义调用同样分类。
    //（原插件 edit 动作的全通道覆盖在此无完全对应物，属已知缺口，见文件头。）
    if (name !== "read" && name !== "grep" && name !== "find" && name !== "ls") {
      const maybePath = (event.input as Record<string, unknown>).path;
      if (typeof maybePath !== "string") return undefined;
      const reason = checkPathWrite(txn, maybePath);
      return reason ? { block: true as const, reason } : undefined;
    }
    return undefined;
  });

  // `!` 前缀的用户 shell：写命令才拦截；Pi user_bash 以抛错表示拦截。
  pi.on("user_bash", async (event, ctx) => {
    const txn = getActiveTxn(sessionKey(ctx));
    if (!txn) return undefined;
    const reason = checkShellWrite(txn, event.command);
    if (reason) throw new Error(reason);
    return undefined;
  });
}
