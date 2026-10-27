// speckit-rework-gate: targeted tests.
// Covers: 7 tools registered (names/namespace), select validation, input
// auto-open + /speckit.* bypass, assess downstream expansion, out-of-order
// gate -> blocked, full spec->plan->tasks->checklists->open->close path,
// scope enforcement (edit/write/bash/user_bash), tasks.md freeze +
// complete_task, closed-state denial, and pure-function spot checks.
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, makeMockPi, mockCtx, report } from "./helper.mjs";
import gateFactory, {
  OFFICIAL_RE,
  MODIFY_RE,
  scopeMatch,
  inScope,
  classify,
  shellLooksLikeWrite,
  shellWriteTargets,
  analyzeShellWrites,
  outOfScopeTargets,
  normalizeScopeEntry,
  countBoxes,
  hashFile,
  findProjectRoot,
} from "../../agent/extensions/speckit-rework-gate.ts";

// ---------- fixture: minimal eligible Spec Kit project ----------
const base = mkdtempSync(path.join(tmpdir(), "speckit-pi-test-"));
const proj = path.join(base, "proj");
mkdirSync(path.join(proj, ".specify"), { recursive: true });
mkdirSync(path.join(proj, "specs", "001-demo"), { recursive: true });
mkdirSync(path.join(proj, "specs", "002-demo", "checklists"), { recursive: true });
mkdirSync(path.join(proj, "docs"), { recursive: true });
mkdirSync(path.join(proj, "src"), { recursive: true });
writeFileSync(path.join(proj, ".specify", "feature.json"), JSON.stringify({ feature_directory: "specs/001-demo" }, null, 2));
writeFileSync(path.join(proj, "specs", "001-demo", "spec.md"), "# spec\n");
writeFileSync(path.join(proj, "specs", "001-demo", "plan.md"), "# plan\n");
writeFileSync(path.join(proj, "specs", "001-demo", "research.md"), "# research\n");
writeFileSync(path.join(proj, "specs", "001-demo", "tasks.md"), "- [x] 1.1 done task\n- [ ] 2.3 pending task\n");
writeFileSync(path.join(proj, "docs", "app.md"), "# app\n");
writeFileSync(path.join(proj, "src", "impl.ts"), "export const x = 1;\n");
writeFileSync(path.join(proj, "specs", "002-demo", "spec.md"), "# spec2\n");
writeFileSync(path.join(proj, "specs", "002-demo", "plan.md"), "# plan2\n");
writeFileSync(path.join(proj, "specs", "002-demo", "tasks.md"), "- [x] 1.1 done\n");
writeFileSync(path.join(proj, "specs", "002-demo", "checklists", "q.md"), "- [ ] unchecked item\n");

const { pi, handlers, tools } = makeMockPi();
gateFactory(pi);

const TOOL_NAMES = [
  "speckit_rework_list_features",
  "speckit_rework_select_feature",
  "speckit_rework_reset",
  "speckit_rework_assess_impact",
  "speckit_rework_close",
  "speckit_rework_gate",
  "speckit_rework_complete_task",
];
assert(TOOL_NAMES.every((n) => tools.has(n)), "all 7 speckit_rework_* tools registered", [...tools.keys()].join(","));
assert(tools.get("speckit_rework_gate").namespace?.name === "speckit_rework", "tools share the speckit_rework namespace");

function ctxFor(sess) {
  return mockCtx({ cwd: proj, sessionFile: path.join(proj, ".sessions", `${sess}.json`), sessionId: `sess-${sess}` }).ctx;
}
async function callTool(name, params, ctx) {
  return await tools.get(name).execute("t1", params, undefined, undefined, ctx);
}
function payload(res) {
  return JSON.parse(res.content[0].text);
}
async function toolCall(ctx, toolName, input) {
  return await handlers.get("tool_call")[0]({ type: "tool_call", toolCallId: "c1", toolName, input }, ctx);
}
async function inputText(ctx, text) {
  return await handlers.get("input")[0]({ type: "input", text, source: "interactive" }, ctx);
}
async function sysSection(ctx) {
  const event = { type: "before_agent_start", systemPromptOptions: { sections: {} } };
  await handlers.get("before_agent_start")[0](event, ctx);
  return event.systemPromptOptions.sections["speckit-rework-gate"];
}

// ---------- A: input auto-open + /speckit.* bypass ----------
{
  const ctx = ctxFor("A");
  assert((await sysSection(ctx)) === undefined, "A: no section without transaction");
  const r0 = payload(await callTool("speckit_rework_assess_impact", { affectedStages: [], summary: "s", scope: ["docs/**"] }, ctx));
  assert(r0.ok === false, "A: assess without transaction fails");
  await inputText(ctx, "请修复登录 bug，顺便重构一下");
  const r1 = payload(await callTool("speckit_rework_assess_impact", { affectedStages: [], summary: "无上游影响", scope: ["docs/**"] }, ctx));
  assert(r1.ok === true && r1.phase === "implementation-open", "A: modify request auto-opens txn; empty assess opens implementation", JSON.stringify(r1));
  assert(((await sysSection(ctx)) ?? "").includes("phase=implementation-open"), "A: system section reflects open phase");
  await inputText(ctx, "请跑 /speckit.plan 看看");
  const r2 = payload(await callTool("speckit_rework_assess_impact", { affectedStages: [], summary: "s", scope: ["docs/**"] }, ctx));
  assert(r2.ok === false, "A: /speckit.* input clears the transaction (bypass)");
}

// ---------- B: select validation ----------
{
  const ctx = ctxFor("B");
  const r0 = payload(await callTool("speckit_rework_select_feature", { featureDirectory: "specs/nope" }, ctx));
  assert(r0.ok === false && r0.error.includes("unknown feature"), "B: unknown feature rejected");
  const r1 = payload(await callTool("speckit_rework_select_feature", { featureDirectory: "" }, ctx));
  assert(r1.ok === false, "B: empty featureDirectory rejected");
  const r2 = payload(await callTool("speckit_rework_reset", { reason: "x" }, ctx));
  assert(r2.ok === false && r2.error === "no active rework transaction", "B: reset without txn fails");
}

// ---------- C: out-of-order gate -> blocked, then reset + recover ----------
{
  const ctx = ctxFor("C");
  await inputText(ctx, "fix login bug please");
  const a = payload(await callTool("speckit_rework_assess_impact", { affectedStages: ["plan"], summary: "只动 plan", scope: ["docs/**"] }, ctx));
  assert(a.ok === true && JSON.stringify(a.affectedStages) === JSON.stringify(["plan", "tasks", "checklists"]), "C: plan auto-expands downstream", JSON.stringify(a));
  assert(a.phase === "plan-pending", "C: phase is plan-pending");
  const g = payload(await callTool("speckit_rework_gate", { stage: "tasks", decision: "no-change", summary: "skip" }, ctx));
  assert(g.ok === false && g.error.includes("stage out of order"), "C: out-of-order gate blocks the transaction", JSON.stringify(g));
  const denied = await toolCall(ctx, "edit", { path: "docs/app.md", edits: [] });
  assert(denied && denied.block === true && denied.reason.includes("Transaction blocked"), "C: edits denied while blocked");
  const g2 = payload(await callTool("speckit_rework_gate", { stage: "plan", decision: "no-change", summary: "x" }, ctx));
  assert(g2.ok === false && g2.error.includes("transaction blocked"), "C: gates rejected while blocked");
  const r = payload(await callTool("speckit_rework_reset", { reason: "recover" }, ctx));
  assert(r.ok === true && r.reset === true, "C: reset recovers a blocked transaction");
  const s = payload(await callTool("speckit_rework_select_feature", { featureDirectory: "specs/001-demo" }, ctx));
  assert(s.ok === true, "C: re-select after reset works");
}

// ---------- D: full happy path ----------
{
  const ctx = ctxFor("D");
  const s = payload(await callTool("speckit_rework_select_feature", { featureDirectory: "specs/001-demo" }, ctx));
  assert(s.ok === true, "D: select 001-demo");
  const a = payload(
    await callTool("speckit_rework_assess_impact", { affectedStages: ["spec"], summary: "spec 层要改", scope: ["docs/**"] }, ctx),
  );
  assert(a.phase === "spec-pending" && a.affectedStages.length === 4, "D: spec expands to all downstream", JSON.stringify(a));

  assert((await toolCall(ctx, "edit", { path: "specs/001-demo/spec.md", edits: [] })) === undefined, "D: spec writable in spec-pending");
  const denyPlan = await toolCall(ctx, "edit", { path: "specs/001-demo/plan.md", edits: [] });
  assert(denyPlan && denyPlan.block === true && denyPlan.reason.includes("only affected stage spec is writable"), "D: plan denied in spec-pending");
  const denyImpl = await toolCall(ctx, "write", { path: "docs/app.md", content: "x" });
  assert(denyImpl && denyImpl.block === true && denyImpl.reason.includes("only affected stage spec is writable"), "D: impl write blocked in spec-pending");

  const g0 = payload(await callTool("speckit_rework_gate", { stage: "spec", decision: "update", summary: "改了" }, ctx));
  assert(g0.ok === false && g0.error.includes("no stage file changed"), "D: update without change rejected");
  appendFileSync(path.join(proj, "specs", "001-demo", "spec.md"), "\n- change\n");
  const g1 = payload(await callTool("speckit_rework_gate", { stage: "spec", decision: "update", summary: "spec 补充" }, ctx));
  assert(g1.ok === true && g1.phase === "plan-pending", "D: spec gate passes after edit", JSON.stringify(g1));
  const g2 = payload(await callTool("speckit_rework_gate", { stage: "plan", decision: "no-change", summary: "plan 不受影响" }, ctx));
  assert(g2.ok === true && g2.phase === "tasks-pending", "D: plan no-change passes", JSON.stringify(g2));

  assert((await toolCall(ctx, "edit", { path: "specs/001-demo/tasks.md", edits: [] })) === undefined, "D: tasks writable in tasks-pending");
  appendFileSync(path.join(proj, "specs", "001-demo", "tasks.md"), "- [ ] 3.1 extra\n");
  const g3 = payload(await callTool("speckit_rework_gate", { stage: "tasks", decision: "update", summary: "tasks 补充" }, ctx));
  assert(g3.ok === true && g3.phase === "checklists-pending", "D: tasks gate passes", JSON.stringify(g3));
  const g4 = payload(await callTool("speckit_rework_gate", { stage: "checklists", decision: "no-change", summary: "无 checklist" }, ctx));
  assert(g4.ok === true && g4.phase === "implementation-open", "D: checklists skipped, implementation opens", JSON.stringify(g4));

  const frozen = await toolCall(ctx, "edit", { path: "specs/001-demo/tasks.md", edits: [] });
  assert(frozen && frozen.block === true && frozen.reason.includes("complete_task"), "D: tasks.md text frozen once open");
  const c1 = payload(await callTool("speckit_rework_complete_task", { taskId: "2.3" }, ctx));
  assert(c1.ok === true && c1.line.includes("- [x] 2.3"), "D: complete_task checks the box", JSON.stringify(c1));
  const c2 = payload(await callTool("speckit_rework_complete_task", { taskId: "2.3" }, ctx));
  assert(c2.ok === false && c2.error.includes("no unchecked task line"), "D: double complete rejected");

  assert((await toolCall(ctx, "write", { path: "docs/new.md", content: "x" })) === undefined, "D: in-scope write allowed when open");
  const oos = await toolCall(ctx, "write", { path: "src/impl.ts", content: "x" });
  assert(oos && oos.block === true && oos.reason.includes("outside the assessed scope"), "D: out-of-scope write denied when open");
  const frozenSpec = await toolCall(ctx, "edit", { path: "specs/001-demo/spec.md", edits: [] });
  assert(frozenSpec && frozenSpec.block === true && frozenSpec.reason.includes("frozen"), "D: spec frozen when open");
  assert((await toolCall(ctx, "bash", { command: "echo hi > docs/gen.txt" })) === undefined, "D: in-scope shell redirect allowed");
  const badShell = await toolCall(ctx, "bash", { command: "echo hi > src/hack.txt" });
  assert(badShell && badShell.block === true && badShell.reason.includes("src/hack.txt"), "D: out-of-scope shell redirect denied");
  assert((await toolCall(ctx, "bash", { command: "ls -la" })) === undefined, "D: read-only shell passes");
  const outsideShell = await toolCall(ctx, "bash", { command: "echo hi > /tmp/outside.txt" });
  assert(outsideShell && outsideShell.block === true && outsideShell.reason.includes("/tmp/outside.txt"), "D: outside-repo redirect denied");
  let threw = null;
  try {
    await handlers.get("user_bash")[0]({ type: "user_bash", command: "echo hi > src/evil.txt", excludeFromContext: false, cwd: proj }, ctx);
  } catch (e) {
    threw = e;
  }
  assert(threw && String(threw.message).includes("outside assessed scope"), "D: user_bash out-of-scope write throws (blocked)");
  assert((await handlers.get("user_bash")[0]({ type: "user_bash", command: "ls", excludeFromContext: false, cwd: proj }, ctx)) === undefined, "D: user_bash read passes");

  const close = payload(await callTool("speckit_rework_close", { summary: "done" }, ctx));
  assert(close.ok === true && close.phase === "closed", "D: close works from implementation-open");
  const afterClose = await toolCall(ctx, "write", { path: "docs/new2.md", content: "x" });
  assert(afterClose && afterClose.block === true && afterClose.reason.includes("closed"), "D: edits denied after close");
  assert(((await sysSection(ctx)) ?? "").includes("Transaction closed"), "D: system section reports closed");
}

// ---------- E: failing checklists block ----------
{
  const ctx = ctxFor("E");
  const s = payload(await callTool("speckit_rework_select_feature", { featureDirectory: "specs/002-demo" }, ctx));
  assert(s.ok === true, "E: select 002-demo (has failing checklist)");
  const a = payload(await callTool("speckit_rework_assess_impact", { affectedStages: ["checklists"], summary: "x", scope: ["docs/**"] }, ctx));
  assert(a.phase === "checklists-pending", "E: checklists-pending");
  const g = payload(await callTool("speckit_rework_gate", { stage: "checklists", decision: "no-change", summary: "x" }, ctx));
  assert(g.ok === false && g.error.includes("checklists failing"), "E: unchecked checklist blocks implementation", JSON.stringify(g));
}

// ---------- F: pure-function spot checks ----------
assert(scopeMatch("docs/**", "docs/a/b.md") === true, "F: ** crosses directories");
assert(scopeMatch("*.md", "docs/a.md") === false, "F: * does not cross /");
assert(scopeMatch("src/*.ts", "src/a.ts") === true, "F: * matches basename");
assert(scopeMatch("src/*.ts", "src/a/b.ts") === false, "F: * blocked by /");
assert(inScope(["docs/**"], "docs/x.md") === true, "F: inScope true");
assert(classify(proj, "specs/001-demo", ".specify/feature.json").kind === "infra", "F: .specify is infra");
assert(classify(proj, "specs/001-demo", ".opencode/commands/speckit-plan.md").kind === "speckit-cmd", "F: speckit cmd fenced");
assert(classify(proj, "specs/001-demo", "specs/001-demo/spec.md").kind === "spec", "F: current spec classified");
assert(classify(proj, "specs/001-demo", "specs/999-other/spec.md").kind === "spec", "F: other feature frozen as spec");
assert(classify(proj, "specs/001-demo", "docs/app.md").kind === "impl", "F: docs file is impl");
assert(classify(proj, "specs/001-demo", "/etc/passwd").kind === "outside", "F: absolute outside");
assert(shellLooksLikeWrite("sed -e 's/a/b/' -i f") === true, "F: sed ... -i detected");
assert(analyzeShellWrites("sed -i 's/a/b/' f").uncertain === true, "F: sed 直接拒绝（scope 激活时不建模）");
assert(shellLooksLikeWrite("echo hi 2>&1") === false, "F: pure fd dup is not a write (differs from original over-blocking)");
assert(shellLooksLikeWrite("echo hi >&2") === false, "F: fd redirect to stderr is not a write");
assert(shellLooksLikeWrite("echo hi | tee out.txt") === true, "F: tee detected");
assert(shellLooksLikeWrite("ls -la") === false, "F: ls not a write");
assert(shellLooksLikeWrite("echo hello") === false, "F: bare echo not a write");
assert(JSON.stringify(shellWriteTargets("echo hi > docs/a.txt")) === JSON.stringify(["docs/a.txt"]), "F: redirect target parsed");
assert(JSON.stringify(outOfScopeTargets(proj, ["docs/**"], "echo hi > src/x.txt")) === JSON.stringify(["src/x.txt"]), "F: oos target reported");
assert(JSON.stringify(outOfScopeTargets(proj, ["docs/**"], "echo hi > /tmp/x.txt")) === JSON.stringify(["/tmp/x.txt"]), "F: outside-repo absolute denied (hardened)");
assert(normalizeScopeEntry("../x") === null, "F: .. rejected");
assert(normalizeScopeEntry("./docs/**") === "docs/**", "F: ./ normalized");
assert(normalizeScopeEntry("") === null, "F: empty rejected");
assert(countBoxes("- [ ] a\n- [x] b\n").total === 2, "F: countBoxes");
assert(hashFile(path.join(proj, "docs", "app.md")) !== null, "F: hashFile hits");
assert(findProjectRoot(proj) === proj, "F: findProjectRoot hits");
assert(OFFICIAL_RE.test("/speckit.plan") === true, "F: official re");
assert(MODIFY_RE.test("fix login bug") === true && MODIFY_RE.test("今天天气不错") === false, "F: modify re");

// 正则字面量保持与 OpenCode 原插件一致（SHELL_WRITE_RE 已删除：本移植改用
// 可靠词法分析，不再与原正则做字面 parity；删除本身是有意偏离，见 handoff）。
{
  const read = (await import("node:fs")).readFileSync;
  const orig = read("/home/dell/.config/opencode/plugins/speckit-rework-gate.ts", "utf8");
  const port = read("/home/dell/.pi/agent/extensions/speckit-rework-gate.ts", "utf8");
  for (const name of ["OFFICIAL_RE", "MODIFY_RE"]) {
    const re = new RegExp(`(?:export\\s+)?const ${name}\\s*=\\s*(/.*?/;?)`, "s");
    const a = (orig.match(re) || [])[1];
    const b = (port.match(re) || [])[1];
    assert(a !== undefined && a.replace(/;$/, "") === (b || "").replace(/;$/, ""), `F: ${name} literal verbatim`);
  }
  assert(!/export\s+const\s+SHELL_WRITE_RE/.test(port), "F: SHELL_WRITE_RE const removed (lexer replaces regex patchwork)");
}

// ---------- G: 仓库外写入默认拒绝（相对原插件的有意加固，回归锁定） ----------
assert(JSON.stringify(outOfScopeTargets(proj, ["docs/**"], "echo hi > ../evil.txt")) === JSON.stringify(["../evil.txt"]), "G: relative escape denied");
assert(JSON.stringify(outOfScopeTargets(proj, ["docs/**"], "echo hi > ~/evil.txt")) === JSON.stringify(["~/evil.txt"]), "G: home-dir target denied");
assert(JSON.stringify(outOfScopeTargets(proj, ["docs/**"], "echo hi > /dev/null")) === JSON.stringify([]), "G: /dev/null exempt (sole exception)");
assert(JSON.stringify(outOfScopeTargets(proj, ["docs/**"], `echo hi > ${proj}/docs/gen.txt`)) === JSON.stringify([]), "G: in-repo in-scope absolute allowed");
assert(JSON.stringify(outOfScopeTargets(proj, ["docs/**"], `echo hi > ${proj}/src/hack.txt`)) === JSON.stringify(["src/hack.txt"]), "G: in-repo absolute reports repo-relative rel");
{
  // implementation-open：仓库外 edit/write 一律拒绝；读不受影响
  const ctx = ctxFor("G1");
  await callTool("speckit_rework_select_feature", { featureDirectory: "specs/001-demo" }, ctx);
  await callTool("speckit_rework_assess_impact", { affectedStages: [], summary: "x", scope: ["docs/**"] }, ctx);
  const w = await toolCall(ctx, "write", { path: "/tmp/evil.txt", content: "x" });
  assert(w && w.block === true && w.reason.includes("outside the repository"), "G: outside write denied when open", JSON.stringify(w));
  assert(((await sysSection(ctx)) ?? "").includes("denied by default"), "G: system section documents outside default-deny");
  const e = await toolCall(ctx, "edit", { path: "/tmp/evil.txt", edits: [] });
  assert(e && e.block === true && e.reason.includes("phase=implementation-open"), "G: outside edit denied when open");
  const r = await toolCall(ctx, "read", { path: "/etc/hosts" });
  assert(r === undefined, "G: outside read still allowed (reads never gated)");
  const n = await toolCall(ctx, "bash", { command: "echo hi > /dev/null" });
  assert(n === undefined, "G: /dev/null redirect allowed when open");
  const t = await toolCall(ctx, "bash", { command: "echo hi > /tmp/x.txt" });
  assert(t && t.block === true && t.reason.includes("/tmp/x.txt"), "G: /tmp redirect denied when open");
  let threw = null;
  try {
    await handlers.get("user_bash")[0]({ type: "user_bash", command: "echo hi > /tmp/x.txt", excludeFromContext: false, cwd: proj }, ctx);
  } catch (err) {
    threw = err;
  }
  assert(threw && String(threw.message).includes("/tmp/x.txt"), "G: user_bash outside redirect throws");
}
{
  // 门控阶段（spec-pending）：仓库外 edit 同样拒绝
  const ctx = ctxFor("G2");
  await callTool("speckit_rework_select_feature", { featureDirectory: "specs/001-demo" }, ctx);
  await callTool("speckit_rework_assess_impact", { affectedStages: ["spec"], summary: "x", scope: ["docs/**"] }, ctx);
  const e = await toolCall(ctx, "edit", { path: "/tmp/evil.txt", edits: [] });
  assert(e && e.block === true && e.reason.includes("outside the repository"), "G: outside edit denied in gate phase");
}
{
  // blocked 阶段：仓库外写入同样拒绝（与阶段内路径一致从严）
  const ctx = ctxFor("G3");
  await inputText(ctx, "fix login bug please");
  await callTool("speckit_rework_assess_impact", { affectedStages: ["plan"], summary: "x", scope: ["docs/**"] }, ctx);
  await callTool("speckit_rework_gate", { stage: "tasks", decision: "no-change", summary: "x" }, ctx);
  const e = await toolCall(ctx, "write", { path: "/tmp/evil.txt", content: "x" });
  assert(e && e.block === true && e.reason.includes("phase=blocked"), "G: outside write denied while blocked");
}

// ---------- H: tee 全操作数枚举 + 紧贴重定向（原“仅首个 tee 目标”绕过的复现与封堵） ----------
assert(
  JSON.stringify(shellWriteTargets("echo hi | tee /dev/null /tmp/evil")) === JSON.stringify(["/dev/null", "/tmp/evil"]),
  "H: 原绕过载荷现枚举出全部两项目标（旧代码只取 /dev/null 而放行）",
);
assert(
  JSON.stringify(shellWriteTargets("echo hi | tee -a f1 f2")) === JSON.stringify(["f1", "f2"]),
  "H: tee -a 多目标",
);
assert(
  JSON.stringify(shellWriteTargets("echo hi | tee --append 'a b' c")) === JSON.stringify(["a b", "c"]),
  "H: tee 长选项+引号目标",
);
assert(
  JSON.stringify(shellWriteTargets("run | tee f1 > f2 2>err").slice().sort()) === JSON.stringify(["err", "f1", "f2"]),
  "H: tee 与重定向组合全捕获",
);
assert(JSON.stringify(shellWriteTargets("echo x | tee")) === JSON.stringify([]), "H: 无操作数 tee 无目标");
assert(
  JSON.stringify(outOfScopeTargets(proj, ["docs/**"], "echo hi | tee /dev/null /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "H: /dev/null 豁免但同命令的 /tmp 目标仍被拒绝（逐项校验）",
);
assert(
  JSON.stringify(outOfScopeTargets(proj, ["docs/**"], "echo hi | tee /dev/null")) === JSON.stringify([]),
  "H: 纯 tee /dev/null 放行（特判保留的合法性）",
);
assert(
  JSON.stringify(outOfScopeTargets(proj, ["docs/**"], "echo hi 2>/tmp/build.log")) === JSON.stringify(["/tmp/build.log"]),
  "H: 无空格紧贴 2> 捕获",
);
assert(
  JSON.stringify(outOfScopeTargets(proj, ["docs/**"], "echo hi>/tmp/nospace")) === JSON.stringify(["/tmp/nospace"]),
  "H: 无空格紧贴 > 捕获",
);
assert(
  JSON.stringify(shellWriteTargets("if (( x > 3 )); then echo ok; fi")) === JSON.stringify([]),
  "H: ((算术比较)) 不误伤",
);
assert(
  JSON.stringify(shellWriteTargets("echo ${v/>/_}")) === JSON.stringify([]),
  "H: ${参数展开} 不误伤",
);
{
  // 端到端：open 期 tee 混合目标被拦断并点名恶意目标
  const ctx = ctxFor("H1");
  await callTool("speckit_rework_select_feature", { featureDirectory: "specs/001-demo" }, ctx);
  await callTool("speckit_rework_assess_impact", { affectedStages: [], summary: "x", scope: ["docs/**"] }, ctx);
  const t = await toolCall(ctx, "bash", { command: "echo hi | tee docs/a.txt /tmp/evil" });
  assert(t && t.block === true && t.reason.includes("/tmp/evil"), "H: open 期 tee 混合目标拦断", JSON.stringify(t));
  const ok = await toolCall(ctx, "bash", { command: "echo hi | tee docs/a.txt > /dev/null" });
  assert(ok === undefined, "H: open 期全合规 tee+null 放行");
}

// ---------- I: reviewer 新发现载荷（词法重写前的绕过复现 + fail-closed 回归） ----------
assert(
  JSON.stringify(shellWriteTargets("/usr/bin/tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "I: 带路径 tee 调用被捕获（旧 invRe 要求 tee 前为分隔符，漏报）",
);
assert(
  JSON.stringify(shellWriteTargets(`"tee" "/tmp/a b"`)) === JSON.stringify(["/tmp/a b"]),
  "I: 引号包裹的 tee 调用与含空格目标被捕获",
);
assert(
  JSON.stringify(shellWriteTargets("sudo tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "I: sudo 包装的 tee 被捕获",
);
assert(
  JSON.stringify(shellWriteTargets("echo hi >| /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "I: >| noclobber 重定向被捕获（旧 redir/attached 均漏报）",
);
assert(
  JSON.stringify(shellWriteTargets("echo foo> /tmp/bar")) === JSON.stringify(["/tmp/bar"]),
  "I: word> /abs（> 后空格）被捕获（旧两规则各差一边而漏报）",
);
assert(
  JSON.stringify(analyzeShellWrites("echo hi 2>&1").targets) === JSON.stringify([]) &&
    analyzeShellWrites("echo hi 2>&1").uncertain === false,
  "I: 2>&1 纯 fd 复制无目标且不 uncertain（旧 looks-like 误判为写）",
);
assert(
  JSON.stringify(shellWriteTargets("echo hi 2>&1 > /tmp/x")) === JSON.stringify(["/tmp/x"]),
  "I: fd 复制与文件重定向组合只取文件目标",
);
assert(
  JSON.stringify(shellWriteTargets("echo hi >&2")) === JSON.stringify([]),
  "I: >&2 fd 复制无目标",
);
assert(
  JSON.stringify(shellWriteTargets("echo hi &> /tmp/x")) === JSON.stringify(["/tmp/x"]),
  "I: &> 双流重定向被捕获",
);
assert(
  JSON.stringify(shellWriteTargets("echo x | tee -")) === JSON.stringify([]),
  "I: tee 裸 - 表示 stdout，不是文件",
);
assert(
  JSON.stringify(shellWriteTargets(`sh -c 'echo hi > /tmp/evil'`)) === JSON.stringify(["/tmp/evil"]),
  "I: sh -c 内层代码被递归解析",
);
assert(
  JSON.stringify(shellWriteTargets(`eval 'echo hi > /tmp/evil'`)) === JSON.stringify(["/tmp/evil"]),
  "I: eval 参数被递归解析",
);
assert(
  analyzeShellWrites('sh -c "$CMD"').uncertain === true,
  "I: sh -c 动态代码 fail-closed",
);
assert(
  analyzeShellWrites("echo hi > $OUT").uncertain === true,
  "I: 动态重定向目标 fail-closed",
);
assert(
  analyzeShellWrites('echo "hi > /tmp/x').uncertain === true,
  "I: 未闭合引号 fail-closed",
);
assert(
  analyzeShellWrites("echo hi | tee $F").uncertain === true,
  "I: 动态 tee 操作数 fail-closed",
);
assert(
  analyzeShellWrites("tee *.log").uncertain === true,
  "I: glob 写目标 fail-closed",
);
assert(
  JSON.stringify(shellWriteTargets("cat <<EOF > docs/f\nbody > x\nEOF")) === JSON.stringify(["docs/f"]),
  "I: heredoc 主体内的 > 不是重定向",
);
assert(
  JSON.stringify(shellWriteTargets("[[ $a > $b ]] && echo ok")) === JSON.stringify([]),
  "I: [[ ]] 内比较符不是重定向",
);
assert(
  JSON.stringify(shellWriteTargets("cat <<< 'hi > /tmp/x'")) === JSON.stringify([]),
  "I: herestring 数据不是重定向目标",
);
assert(
  analyzeShellWrites("sed -i 's/a/b/' /tmp/f").uncertain === true,
  "I: sed 直接拒绝（不提目标）",
);
assert(
  JSON.stringify(shellWriteTargets("find . -exec tee {} \\; -print")) === JSON.stringify(["{}"]),
  "I: find -exec tee {} 被捕获（未知集合从严）",
);
{
  // 端到端：reviewer 载荷在 open 期被拦断；纯 fd 命令放行（含 review 期）
  const ctx = ctxFor("I1");
  await callTool("speckit_rework_select_feature", { featureDirectory: "specs/001-demo" }, ctx);
  await callTool("speckit_rework_assess_impact", { affectedStages: [], summary: "x", scope: ["docs/**"] }, ctx);
  const t1 = await toolCall(ctx, "bash", { command: "echo hi >| /tmp/evil" });
  assert(t1 && t1.block === true && t1.reason.includes("/tmp/evil"), "I: open 期 >| 拦断", JSON.stringify(t1));
  const t2 = await toolCall(ctx, "bash", { command: "/usr/bin/tee /tmp/evil" });
  assert(t2 && t2.block === true && t2.reason.includes("/tmp/evil"), "I: open 期路径 tee 拦断", JSON.stringify(t2));
  const t3 = await toolCall(ctx, "bash", { command: "echo foo> /tmp/bar" });
  assert(t3 && t3.block === true && t3.reason.includes("/tmp/bar"), "I: open 期 word> /abs 拦断", JSON.stringify(t3));
  const t4 = await toolCall(ctx, "bash", { command: "echo hi 2>&1 | head -5" });
  assert(t4 === undefined, "I: open 期纯 fd 管道放行", JSON.stringify(t4));
  const t5 = await toolCall(ctx, "bash", { command: "sh -c 'echo hi > /tmp/evil'" });
  assert(t5 && t5.block === true && t5.reason.includes("/tmp/evil"), "I: open 期 sh -c 递归拦断", JSON.stringify(t5));
  const t6 = await toolCall(ctx, "bash", { command: "echo hi > $OUT" });
  assert(t6 && t6.block === true && t6.reason.includes("cannot safely determine"), "I: open 期动态目标 fail-closed", JSON.stringify(t6));
}
{
  // review 期（spec-pending）：纯 fd 命令放行，真写照旧拦断
  const ctx = ctxFor("I2");
  await callTool("speckit_rework_select_feature", { featureDirectory: "specs/001-demo" }, ctx);
  await callTool("speckit_rework_assess_impact", { affectedStages: ["spec"], summary: "x", scope: ["docs/**"] }, ctx);
  const ok = await toolCall(ctx, "bash", { command: "echo hi 2>&1 | head -5" });
  assert(ok === undefined, "I: review 期纯 fd 管道放行（原实现误拦）");
  const bad = await toolCall(ctx, "bash", { command: "echo hi > docs/a.txt" });
  assert(bad && bad.block === true && bad.reason.includes("rework review"), "I: review 期真写照旧拦断");
}
{
  // 词法器边界：包装器变体、多行脚本、heredoc 变体、sed -i 组合
  assert(JSON.stringify(shellWriteTargets("sudo -u root tee /tmp/x")) === JSON.stringify(["/tmp/x"]), "I: sudo -u 包装 tee");
  assert(JSON.stringify(shellWriteTargets("VAR=1 FOO=2 tee docs/a")) === JSON.stringify(["docs/a"]), "I: 环境变量前缀后 tee");
  assert(JSON.stringify(shellWriteTargets("if tee docs/a; then x; fi")) === JSON.stringify(["docs/a"]), "I: if 后 tee");
  assert(JSON.stringify(shellWriteTargets("for tee in a b; do echo $tee; done")) === JSON.stringify([]), "I: for 循环变量 tee 非调用");
  assert(JSON.stringify(shellWriteTargets("find . -exec tee {} \\; -print")) === JSON.stringify(["{}"]), "I: find -exec tee {}");
  assert(JSON.stringify(shellWriteTargets("echo hi >>| /tmp/x")) === JSON.stringify(["/tmp/x"]), "I: >>| 追加 noclobber");
  assert(JSON.stringify(shellWriteTargets("tee -- -weird")) === JSON.stringify(["-weird"]), "I: tee -- 后选项即文件");
  assert(JSON.stringify(shellWriteTargets("echo a; echo b > docs/c")) === JSON.stringify(["docs/c"]), "I: 多命令只取写目标");
  assert(JSON.stringify(shellWriteTargets("echo hi < /dev/null")) === JSON.stringify([]), "I: 输入重定向不产生写目标");
  assert(analyzeShellWrites("tee >(cat) f").uncertain === true, "I: tee 进程替换操作数 fail-closed");
  assert(JSON.stringify(shellWriteTargets("cat <<'EOF' > docs/f\nbody > x\nEOF")) === JSON.stringify(["docs/f"]), "I: 引号 heredoc 主体跳过");
  assert(JSON.stringify(shellWriteTargets("echo hi 2>err | tee docs/a")) === JSON.stringify(["err", "docs/a"]), "I: fd 重定向相对目标照常捕获");
  const ctx = ctxFor("I3");
  await callTool("speckit_rework_select_feature", { featureDirectory: "specs/001-demo" }, ctx);
  await callTool("speckit_rework_assess_impact", { affectedStages: [], summary: "x", scope: ["docs/**"] }, ctx);
  const t = await toolCall(ctx, "bash", { command: "sed -i 's/a/b/' /tmp/evil" });
  assert(t && t.block === true && t.reason.includes("sed denied"), "I: open 期 sed 直接拒绝", JSON.stringify(t));
  const ok = await toolCall(ctx, "bash", { command: "sed -n 's/a/b/p' docs/app.md" });
  assert(ok && ok.block === true && ok.reason.includes("sed denied"), "I: open 期只读 sed 同样拒绝", JSON.stringify(ok));
}

// ---------- J: 动态命令词 + 包装器委托 + $(( )) 算术（旧“命令词恒静态”假设的绕过复现） ----------
assert(
  analyzeShellWrites("$T tee /tmp/evil").uncertain === true,
  "J: 动态命令词 $T fail-closed（旧实现按静态 tee 处理而漏过命令未知）",
);
assert(
  analyzeShellWrites("$(echo tee) /tmp/evil").uncertain === true,
  "J: 命令替换作命令词 fail-closed",
);
assert(
  analyzeShellWrites("`echo tee` /tmp/x").uncertain === true,
  "J: 反引号作命令词 fail-closed",
);
assert(
  analyzeShellWrites("${CMD} /tmp/x").uncertain === true,
  "J: 参数展开作命令词 fail-closed",
);
assert(
  analyzeShellWrites("sudo $CMD /tmp/x").uncertain === true,
  "J: 包装器子命令动态 fail-closed",
);
assert(
  analyzeShellWrites("*").uncertain === true,
  "J: glob 命令词 fail-closed",
);
assert(
  JSON.stringify(shellWriteTargets("timeout 5 tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "J: timeout 委托 tee 被透视（旧 WRAPPERS 无 timeout 而漏报）",
);
assert(
  JSON.stringify(shellWriteTargets("stdbuf -o0 tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "J: stdbuf 委托 tee 被透视",
);
assert(
  JSON.stringify(shellWriteTargets("stdbuf -o 0 tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "J: stdbuf 分离参数形式同样透视",
);
assert(
  JSON.stringify(shellWriteTargets("sudo timeout 5 tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "J: 包装器链 sudo→timeout→tee 逐层透视",
);
assert(
  JSON.stringify(shellWriteTargets("timeout 5 sh -c 'echo hi > /tmp/evil'")) === JSON.stringify(["/tmp/evil"]),
  "J: timeout 后的 sh -c 递归复解析",
);
assert(
  JSON.stringify(shellWriteTargets("su -c 'echo hi > /tmp/evil'")) === JSON.stringify(["/tmp/evil"]),
  "J: su -c 代码被复解析",
);
assert(
  JSON.stringify(shellWriteTargets("su root tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "J: su 跳过 user 位置参数后命中 tee",
);
assert(
  analyzeShellWrites("echo hi | xargs tee /tmp/evil").uncertain === true,
  "J: xargs 直接拒绝（不透视子命令）",
);
assert(
  JSON.stringify(shellWriteTargets("time -o /tmp/timing ls")) === JSON.stringify(["/tmp/timing"]),
  "J: time -o 自身输出文件被计入",
);
assert(
  JSON.stringify(shellWriteTargets("echo $((1+2))")) === JSON.stringify([]) &&
    analyzeShellWrites("echo $((1+2))").uncertain === false,
  "J: $(( )) 纯算术不误报、无 uncertain",
);
assert(
  JSON.stringify(shellWriteTargets("echo $((a > b))")) === JSON.stringify([]) &&
    analyzeShellWrites("echo $((a > b))").uncertain === false,
  "J: 算术内部 > 不是重定向（旧实现误作命令替换内重定向）",
);
assert(
  analyzeShellWrites("echo hi > $((1+2))").uncertain === true,
  "J: 算术作重定向目标从严拒绝（不求值）",
);
assert(
  analyzeShellWrites("tee $((1+2))").uncertain === true,
  "J: 算术作 tee 操作数从严拒绝",
);
{
  // 端到端：open 期 timeout 绕过被拦断；动态命令 fail-closed；算术无害放行
  const ctx = ctxFor("J1");
  await callTool("speckit_rework_select_feature", { featureDirectory: "specs/001-demo" }, ctx);
  await callTool("speckit_rework_assess_impact", { affectedStages: [], summary: "x", scope: ["docs/**"] }, ctx);
  const t1 = await toolCall(ctx, "bash", { command: "timeout 5 tee /tmp/evil" });
  assert(t1 && t1.block === true && t1.reason.includes("/tmp/evil"), "J: open 期 timeout 委托拦断", JSON.stringify(t1));
  const t2 = await toolCall(ctx, "bash", { command: "stdbuf -o0 tee /tmp/evil" });
  assert(t2 && t2.block === true && t2.reason.includes("/tmp/evil"), "J: open 期 stdbuf 委托拦断", JSON.stringify(t2));
  const t3 = await toolCall(ctx, "bash", { command: "$T tee /tmp/evil" });
  assert(t3 && t3.block === true && t3.reason.includes("cannot safely determine"), "J: open 期动态命令 fail-closed", JSON.stringify(t3));
  const t4 = await toolCall(ctx, "bash", { command: "sudo $CMD /tmp/x" });
  assert(t4 && t4.block === true && t4.reason.includes("cannot safely determine"), "J: open 期动态子命令 fail-closed", JSON.stringify(t4));
  const ok = await toolCall(ctx, "bash", { command: "echo $((1+2)) > docs/gen.txt" });
  assert(ok === undefined, "J: open 期算术无害命令+合规目标放行", JSON.stringify(ok));
}
{
  // review 期：动态命令与包装器写照旧拦断
  const ctx = ctxFor("J2");
  await callTool("speckit_rework_select_feature", { featureDirectory: "specs/001-demo" }, ctx);
  await callTool("speckit_rework_assess_impact", { affectedStages: ["spec"], summary: "x", scope: ["docs/**"] }, ctx);
  const bad = await toolCall(ctx, "bash", { command: "timeout 5 tee docs/a.txt" });
  assert(bad && bad.block === true && bad.reason.includes("rework review"), "J: review 期包装器写真写照旧拦断");
  const dyn = await toolCall(ctx, "bash", { command: "$T anything" });
  assert(dyn && dyn.block === true && dyn.reason.includes("cannot safely determine"), "J: review 期动态命令照旧拦断");
}

// ---------- K: 包装器取参重构 + 静态写删命令（旧“布尔吞词 / 不可见命令”绕过复现） ----------
// K1 布尔选项不得消耗下一词（旧 flock -s/-x/-u/-n 进 skipNext 会吞掉锁文件，
// tee 被误作前置参数跳过而漏报；旧 command -p/exec -c 同理）
assert(
  JSON.stringify(shellWriteTargets("flock -x /tmp/lock tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: flock -x 为开关，不吞锁文件（旧实现抛异常→全 uncertain，老行为本身即 bug）",
);
assert(
  JSON.stringify(shellWriteTargets("flock -s /tmp/lock tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: flock -s 开关同样不吞词",
);
assert(
  JSON.stringify(shellWriteTargets("command -p tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: command -p 为开关（旧 skipNext 吞掉 tee 而漏报）",
);
assert(
  JSON.stringify(shellWriteTargets("timeout --foreground 5 tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: timeout --foreground 为开关（旧实现吞掉时长 5，tee 被误作时长而漏报）",
);
assert(
  JSON.stringify(shellWriteTargets("timeout -s KILL 5 tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: timeout -s 取参严格消费一词（KILL），时长 5 仍按前置跳过",
);
// K2 runuser 语义：-u 给出来自身份时不再跳 user 位置参数
assert(
  JSON.stringify(shellWriteTargets("runuser -u postgres tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: runuser -u 已给 user，不再跳位置参数（旧双跳吞掉 tee 而漏报）",
);
assert(
  JSON.stringify(shellWriteTargets("runuser --user=root tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: runuser --user= 附带值同样豁免位置跳过",
);
assert(
  JSON.stringify(shellWriteTargets("runuser -upostgres tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: runuser -u 附带值（短簇）同样豁免位置跳过",
);
assert(
  JSON.stringify(shellWriteTargets("runuser postgres tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: runuser 位置 user 照跳，命中真实子命令",
);
// K3 sudo -e / sudoedit：剩余操作数均为待编辑文件（旧实现把文件当子命令而漏报）
assert(
  JSON.stringify(shellWriteTargets("sudo -e /tmp/evil docs/a.txt")) === JSON.stringify(["/tmp/evil", "docs/a.txt"]),
  "K: sudo -e 切编辑模式，文件逐项计入",
);
assert(
  JSON.stringify(shellWriteTargets("sudoedit /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: sudoedit 操作数即文件（旧实现完全不可见）",
);
assert(
  JSON.stringify(shellWriteTargets("sudo -ei /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: sudo -ei 簇中 e 同样切编辑模式",
);
// K4 附带值形式：--command= 复解析、--output= 计入、-cCODE/-oFILE 内联
assert(
  JSON.stringify(shellWriteTargets("su --command='echo hi > /tmp/evil'")) === JSON.stringify(["/tmp/evil"]),
  "K: su --command= 代码被复解析",
);
assert(
  JSON.stringify(shellWriteTargets("su -c'echo hi > /tmp/evil'")) === JSON.stringify(["/tmp/evil"]),
  "K: su -c 附带代码被复解析",
);
assert(
  JSON.stringify(shellWriteTargets("time --output=/tmp/t ls")) === JSON.stringify(["/tmp/t"]),
  "K: time --output= 附带值计入",
);
assert(
  analyzeShellWrites("busybox --install -s /bin").uncertain === true,
  "K: busybox --install 写链接直接拒绝",
);
// K5 新增委托链成员透视（旧实现当普通命令而漏报）
assert(
  JSON.stringify(shellWriteTargets("busybox rm -rf /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: busybox 透视为 rm",
);
assert(
  JSON.stringify(shellWriteTargets("nsenter -t 1 tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: nsenter -t 取参后透视",
);
assert(
  JSON.stringify(shellWriteTargets("doas -u root tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: doas -u 取参后透视",
);
assert(
  JSON.stringify(shellWriteTargets("unshare --propagation slave tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: unshare --propagation 取参后透视",
);
assert(
  JSON.stringify(shellWriteTargets("sudo -p 'prompt' tee /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: sudo -p 取提示词后透视（旧实现 -p 未收录，提示词被误作子命令）",
);
// K6 dd：仅 of= 为写目标（旧实现完全不可见，open 期放行）
assert(
  JSON.stringify(shellWriteTargets("dd if=/dev/zero of=/tmp/evil bs=1M count=1")) === JSON.stringify(["/tmp/evil"]),
  "K: dd of= 被捕获",
);
assert(
  JSON.stringify(shellWriteTargets("dd of=/dev/null if=/dev/zero")) === JSON.stringify(["/dev/null"]),
  "K: dd of=/dev/null 照常提取（分类侧豁免）",
);
assert(
  analyzeShellWrites("dd of=$OUT").uncertain === true,
  "K: dd 动态 of 目标 fail-closed",
);
assert(
  analyzeShellWrites("dd $X").uncertain === true,
  "K: dd 动态裸词可展开为 of=…，fail-closed",
);
assert(
  JSON.stringify(shellWriteTargets("dd if=/dev/zero bs=1M")) === JSON.stringify([]),
  "K: 无 of= 的 dd 无写目标",
);
// K7 touch/rm/mkdir/rmdir/shred/truncate：操作数逐项校验（旧实现完全不可见）
assert(
  JSON.stringify(shellWriteTargets("touch docs/a.txt /tmp/evil")) === JSON.stringify(["docs/a.txt", "/tmp/evil"]),
  "K: touch 多目标逐项计入",
);
assert(
  JSON.stringify(shellWriteTargets("touch -d 2024-01-01 docs/a.txt")) === JSON.stringify(["docs/a.txt"]),
  "K: touch -d 取参不误作文件",
);
assert(
  JSON.stringify(shellWriteTargets("touch --reference docs/a.txt /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: touch --reference 读引用被跳过",
);
assert(
  analyzeShellWrites("touch *.log").uncertain === true,
  "K: touch glob fail-closed",
);
assert(
  JSON.stringify(shellWriteTargets("rm -rf /tmp/evil docs/a.txt")) === JSON.stringify(["/tmp/evil", "docs/a.txt"]),
  "K: rm 删除目标逐项计入（旧实现 review 期放行删除）",
);
assert(
  JSON.stringify(shellWriteTargets("rm -- -foo")) === JSON.stringify(["-foo"]),
  "K: rm -- 后文件名照计",
);
assert(
  analyzeShellWrites("rm $F").uncertain === true,
  "K: rm 动态目标 fail-closed",
);
assert(
  JSON.stringify(shellWriteTargets("mkdir -p docs/newdir /tmp/evil")) === JSON.stringify(["docs/newdir", "/tmp/evil"]),
  "K: mkdir 多目标逐项计入",
);
assert(
  JSON.stringify(shellWriteTargets("rmdir /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: rmdir 目标计入",
);
assert(
  JSON.stringify(shellWriteTargets("shred -u -n 3 /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: shred 开关+取参后命中文件",
);
assert(
  JSON.stringify(shellWriteTargets("truncate -s 1M docs/a.txt")) === JSON.stringify(["docs/a.txt"]),
  "K: truncate -s 取参后命中文件",
);
assert(
  JSON.stringify(shellWriteTargets("truncate --reference docs/a.txt -s 1M /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: truncate --reference 读引用被跳过",
);
assert(
  JSON.stringify(shellWriteTargets("find . -exec rm {} +")) === JSON.stringify(["{}"]),
  "K: -exec rm {} + 中 + 为终止符不计入",
);
// K8 install/cp/mv/ln：dest 规则逐项校验（旧实现 open 期全放行、review 期全放行）
assert(
  JSON.stringify(shellWriteTargets("install -m 0755 -o root src/a /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: install 单源 dest 即文件",
);
assert(
  JSON.stringify(shellWriteTargets("install -d docs/a /tmp/e")) === JSON.stringify(["docs/a", "/tmp/e"]),
  "K: install -d 全为创建目录",
);
assert(
  JSON.stringify(shellWriteTargets("install -t /tmp/bin src/a src/b")) === JSON.stringify(["/tmp/bin/a", "/tmp/bin/b"]),
  "K: install -t 逐源 join",
);
assert(
  JSON.stringify(shellWriteTargets("install -D src/a /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: install -D 开关不影响 dest 判定",
);
assert(
  JSON.stringify(shellWriteTargets("cp -r src/a /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: cp 单源 dest 即文件",
);
assert(
  JSON.stringify(shellWriteTargets("cp src/a src/b /tmp/d/")) === JSON.stringify(["/tmp/d/a", "/tmp/d/b"]),
  "K: cp 多源 dest 为目录，逐源 join",
);
assert(
  JSON.stringify(shellWriteTargets("cp -t /tmp/d src/a src/b")) === JSON.stringify(["/tmp/d/a", "/tmp/d/b"]),
  "K: cp -t 逐源 join",
);
assert(
  JSON.stringify(shellWriteTargets("cp -S .bak src/a /tmp/evil")) === JSON.stringify(["/tmp/evil"]),
  "K: cp -S 取参不误作源",
);
assert(
  JSON.stringify(shellWriteTargets("cp $S docs/d")) === JSON.stringify(["docs/d"]),
  "K: cp 单源动态不影响 dest 位置判定（源为读）",
);
assert(
  JSON.stringify(shellWriteTargets("mv docs/a docs/b")) === JSON.stringify(["docs/a", "docs/b"]),
  "K: mv 源（删除）与 dest（创建）双计入",
);
assert(
  JSON.stringify(shellWriteTargets("mv /tmp/a docs/b")) === JSON.stringify(["/tmp/a", "docs/b"]),
  "K: mv 跨区移动源逐项计入（旧实现不可见）",
);
assert(
  JSON.stringify(shellWriteTargets("mv docs/a docs/b /tmp/d/")) === JSON.stringify(["docs/a", "docs/b", "/tmp/d/", "/tmp/d/a", "/tmp/d/b"]),
  "K: mv 多源：源、dest 目录、join 全计入",
);
assert(
  analyzeShellWrites("mv $S docs/d").uncertain === true,
  "K: mv 动态源（未知删除集合）fail-closed",
);
assert(
  analyzeShellWrites("ln -s docs/a docs/link").uncertain === true,
  "K: ln 直接拒绝（scope 激活时不建模）",
);
assert(
  analyzeShellWrites("ln -s $S docs/link").uncertain === true,
  "K: ln 动态源 fail-closed（旧实现忽略源动态直接放行，M 组收紧）",
);
assert(
  analyzeShellWrites("ln -s src/a src/b /tmp/d/").uncertain === true,
  "K: ln 多源直接拒绝",
);
assert(
  analyzeShellWrites("ln -t /tmp/d src/a src/b").uncertain === true,
  "K: ln -t 直接拒绝",
);
{
  // 端到端：open 期新命令越界拦断、合规放行；review 期删除/新建照旧拦断
  const ctx = ctxFor("K1");
  await callTool("speckit_rework_select_feature", { featureDirectory: "specs/001-demo" }, ctx);
  await callTool("speckit_rework_assess_impact", { affectedStages: [], summary: "x", scope: ["docs/**"] }, ctx);
  const t1 = await toolCall(ctx, "bash", { command: "rm -rf /tmp/evil" });
  assert(t1 && t1.block === true && t1.reason.includes("/tmp/evil"), "K: open 期 rm 越界拦断（旧实现放行）", JSON.stringify(t1));
  const t2 = await toolCall(ctx, "bash", { command: "dd if=/dev/zero of=/tmp/evil bs=1M" });
  assert(t2 && t2.block === true && t2.reason.includes("/tmp/evil"), "K: open 期 dd 越界拦断（旧实现放行）", JSON.stringify(t2));
  const t3 = await toolCall(ctx, "bash", { command: "sudo rm -rf /tmp/evil" });
  assert(t3 && t3.block === true && t3.reason.includes("/tmp/evil"), "K: open 期包装器 rm 越界拦断", JSON.stringify(t3));
  const t4 = await toolCall(ctx, "bash", { command: "flock -x /tmp/lock tee /tmp/evil" });
  assert(t4 && t4.block === true && t4.reason.includes("/tmp/evil"), "K: open 期 flock 开关后委托拦断", JSON.stringify(t4));
  const t5 = await toolCall(ctx, "bash", { command: "touch /tmp/evil" });
  assert(t5 && t5.block === true && t5.reason.includes("/tmp/evil"), "K: open 期 touch 越界拦断", JSON.stringify(t5));
  const t6 = await toolCall(ctx, "bash", { command: "mv docs/a src/b" });
  assert(t6 && t6.block === true && t6.reason.includes("src/b"), "K: open 期 mv 跨 scope 拦断", JSON.stringify(t6));
  const ok0 = await toolCall(ctx, "bash", { command: "mv docs/a docs/b" });
  assert(ok0 === undefined, "K: open 期 scope 内 mv 放行", JSON.stringify(ok0));
  const ok1 = await toolCall(ctx, "bash", { command: "touch docs/new.txt" });
  assert(ok1 === undefined, "K: open 期合规 touch 放行", JSON.stringify(ok1));
  const ok2 = await toolCall(ctx, "bash", { command: "mkdir -p docs/d && touch docs/d/f" });
  assert(ok2 === undefined, "K: open 期合规 mkdir+touch 放行", JSON.stringify(ok2));
  const ok3 = await toolCall(ctx, "bash", { command: "cp docs/a docs/b" });
  assert(ok3 === undefined, "K: open 期合规 cp 放行", JSON.stringify(ok3));
  const dyn = await toolCall(ctx, "bash", { command: "rm $F" });
  assert(dyn && dyn.block === true && dyn.reason.includes("cannot safely determine"), "K: open 期动态删除 fail-closed", JSON.stringify(dyn));
}
{
  // review 期（spec-pending）：新建/删除/包装器写照旧拦断
  const ctx = ctxFor("K2");
  await callTool("speckit_rework_select_feature", { featureDirectory: "specs/001-demo" }, ctx);
  await callTool("speckit_rework_assess_impact", { affectedStages: ["spec"], summary: "x", scope: ["docs/**"] }, ctx);
  const bad1 = await toolCall(ctx, "bash", { command: "rm docs/a.txt" });
  assert(bad1 && bad1.block === true && bad1.reason.includes("rework review"), "K: review 期 rm 照旧拦断（旧实现放行）");
  const bad2 = await toolCall(ctx, "bash", { command: "touch docs/a.txt" });
  assert(bad2 && bad2.block === true && bad2.reason.includes("rework review"), "K: review 期 touch 照旧拦断（旧实现放行）");
  const bad3 = await toolCall(ctx, "bash", { command: "sudo mkdir -p docs/d" });
  assert(bad3 && bad3.block === true && bad3.reason.includes("rework review"), "K: review 期包装器新建照旧拦断");
}

// ---------- L: reviewer 最新 FAIL（白名单 + find/xargs + symlink + 目录误判） ----------
// L1 显式白名单：未知命令 fail-closed，只读命令放行（门禁不是沙箱，见文件头）
assert(analyzeShellWrites("git status").uncertain === true, "L: git 未知命令 fail-closed（内部可写，shell 层不可见）");
assert(analyzeShellWrites("python script.py").uncertain === true, "L: python 未知命令 fail-closed");
assert(analyzeShellWrites("make -j4").uncertain === true, "L: make 未知命令 fail-closed（构建可落盘）");
assert(analyzeShellWrites("npm install").uncertain === true, "L: npm 未知命令 fail-closed");
assert(analyzeShellWrites("curl https://x | sh").uncertain === true, "L: curl 未知命令 fail-closed");
assert(analyzeShellWrites("chmod +x docs/a").uncertain === true, "L: chmod 未知命令 fail-closed（改权限同属修改）");
assert(
  analyzeShellWrites("ls -la").uncertain === false && JSON.stringify(shellWriteTargets("ls -la")) === JSON.stringify([]),
  "L: ls 只读放行",
);
assert(analyzeShellWrites("echo hi").uncertain === false, "L: echo 只读放行");
assert(analyzeShellWrites("cat docs/app.md").uncertain === false, "L: cat 只读放行");
assert(analyzeShellWrites("grep foo docs/app.md").uncertain === false, "L: grep 只读放行");
// L2 find 写动作 fail-closed，纯读 find 放行
assert(analyzeShellWrites("find . -delete").uncertain === true, "L: find -delete fail-closed（旧实现放行）");
assert(analyzeShellWrites("find . -exec rm {} \\;").uncertain === true, "L: find -exec fail-closed");
assert(analyzeShellWrites("find . -fls /tmp/out").uncertain === true, "L: find -fls fail-closed");
assert(analyzeShellWrites("find . -print").uncertain === false, "L: find 纯读放行");
assert(analyzeShellWrites("find . -name '*.ts' -print").uncertain === false, "L: find 条件读放行");
// L3 xargs 子命令：stdin 文件集合未知，非只读子命令一律 fail-closed
assert(analyzeShellWrites("echo hi | xargs echo").uncertain === true, "L: xargs 直接拒绝（即使子命令只读）");
assert(analyzeShellWrites("echo list | xargs rm").uncertain === true, "L: xargs rm fail-closed（stdin 列表未知，旧实现放行）");
assert(analyzeShellWrites("echo list | xargs -I{} cp {} /tmp/d").uncertain === true, "L: xargs cp fail-closed");
assert(
  analyzeShellWrites("echo hi | xargs tee /tmp/evil").uncertain === true,
  "L: xargs tee 直接拒绝（不提静态目标）",
);
// L4 symlink 越界（realpath/lstat）：仓库内链接指到仓库外 / scope 外一律拒绝
writeFileSync(path.join(base, "outside.txt"), "secret\n");
try { symlinkSync(path.join(base, "outside.txt"), path.join(proj, "docs", "link-out.txt")); } catch {}
try { symlinkSync(path.join(proj, "src", "impl.ts"), path.join(proj, "docs", "link-src.ts")); } catch {}
mkdirSync(path.join(proj, "docs", "d"), { recursive: true });
assert(classify(proj, "specs/001-demo", "docs/link-out.txt").kind === "outside", "L: symlink 指到仓库外按 outside");
assert(
  JSON.stringify(outOfScopeTargets(proj, ["docs/**"], "echo hi > docs/link-out.txt")) === JSON.stringify(["docs/link-out.txt"]),
  "L: symlink 外指重定向拒绝",
);
assert(
  JSON.stringify(outOfScopeTargets(proj, ["docs/**"], "echo hi > docs/link-src.ts")) === JSON.stringify(["src/impl.ts"]),
  "L: symlink 指到 scope 外拒绝（返回真实 rel）",
);
// L5 cp/ln/install 目录误判：单源 dest 为已存在目录时 join，动态源此时 fail
assert(
  JSON.stringify(analyzeShellWrites("cp docs/app.md docs/d", 0, proj).targets) === JSON.stringify(["docs/d/app.md"]),
  "L: cp 单源目录 dest join（旧实现误作文件 dest）",
);
assert(
  analyzeShellWrites("cp $S docs/d", 0, proj).uncertain === true,
  "L: cp 动态源 + 目录 dest fail-closed",
);
assert(
  analyzeShellWrites("cp $S docs/newfile", 0, proj).uncertain === true,
  "L: cp 动态源统一拒绝（全参数位动态 fail-closed，不只命令名）",
);
assert(
  JSON.stringify(analyzeShellWrites("cp docs/app.md docs/d/", 0, proj).targets) === JSON.stringify(["docs/d/app.md"]),
  "L: cp 尾斜杠 dest 按目录 join",
);
assert(
  analyzeShellWrites("ln -s docs/app.md docs/d", 0, proj).uncertain === true,
  "L: ln 直接拒绝（目录 join 建模已删除）",
);
assert(
  JSON.stringify(analyzeShellWrites("install docs/app.md docs/d", 0, proj).targets) === JSON.stringify(["docs/d/app.md"]),
  "L: install 单源目录 dest join",
);
assert(
  JSON.stringify(analyzeShellWrites("mv docs/app.md docs/d", 0, proj).targets).includes("docs/d/app.md"),
  "L: mv 目录 dest 一并计入 join",
);
{
  // 端到端：open 期白名单 / find / xargs / symlink / 目录 dest
  const ctx = ctxFor("L1");
  await callTool("speckit_rework_select_feature", { featureDirectory: "specs/001-demo" }, ctx);
  await callTool("speckit_rework_assess_impact", { affectedStages: [], summary: "x", scope: ["docs/**"] }, ctx);
  const u1 = await toolCall(ctx, "bash", { command: "git status" });
  assert(u1 && u1.block === true && u1.reason.includes("unknown command"), "L: open 期 git 拦断", JSON.stringify(u1));
  const u2 = await toolCall(ctx, "bash", { command: "python script.py" });
  assert(u2 && u2.block === true, "L: open 期 python 拦断");
  const ok0 = await toolCall(ctx, "bash", { command: "ls -la" });
  assert(ok0 === undefined, "L: open 期 ls 放行");
  const ok1 = await toolCall(ctx, "bash", { command: "echo hi 2>&1 | head -5" });
  assert(ok1 === undefined, "L: open 期纯 fd 白名单管道放行");
  const f1 = await toolCall(ctx, "bash", { command: "find . -delete" });
  assert(f1 && f1.block === true, "L: open 期 find -delete 拦断");
  const f2 = await toolCall(ctx, "bash", { command: "find . -name '*.ts' -print" });
  assert(f2 === undefined, "L: open 期 find 纯读放行");
  const x1 = await toolCall(ctx, "bash", { command: "echo list | xargs rm" });
  assert(x1 && x1.block === true, "L: open 期 xargs rm 拦断");
  const x2 = await toolCall(ctx, "bash", { command: "echo hi | xargs echo hi" });
  assert(x2 && x2.block === true && x2.reason.includes("xargs denied"), "L: open 期 xargs 直接拒绝");
  const s1 = await toolCall(ctx, "bash", { command: "echo hi > docs/link-out.txt" });
  assert(s1 && s1.block === true, "L: open 期 symlink 外指拦断");
  const s2 = await toolCall(ctx, "write", { path: "docs/link-out.txt", content: "x" });
  assert(s2 && s2.block === true, "L: open 期 symlink 外指 write 拦断");
  const s3 = await toolCall(ctx, "write", { path: "docs/link-src.ts", content: "x" });
  assert(s3 && s3.block === true, "L: open 期 symlink scope 外 write 拦断");
  const c1 = await toolCall(ctx, "bash", { command: "cp docs/app.md docs/d" });
  assert(c1 === undefined, "L: open 期 cp 目录 join 合规放行", JSON.stringify(c1));
  const c2 = await toolCall(ctx, "bash", { command: "cp docs/app.md src" });
  assert(c2 && c2.block === true, "L: open 期 cp 目录 join 越界拦断", JSON.stringify(c2));
}

// ---------- M: reviewer 最新 FAIL（只读选项白名单 + xargs  wrapper 链 + 链接源 + sed w/W/e） ----------
// M1 只读命令选项白名单：未知选项拒绝，输出文件参数计入
assert(analyzeShellWrites("ls --bogus-opt").uncertain === true, "M: ls 未知长选项拒绝");
assert(analyzeShellWrites("ls -Zbogus").uncertain === true, "M: ls 未知短选项拒绝");
assert(analyzeShellWrites("ls --color=auto docs").uncertain === false, "M: ls 已知选项放行");
assert(analyzeShellWrites("grep --bogus foo").uncertain === true, "M: grep 未知选项拒绝");
assert(analyzeShellWrites("echo -z hi").uncertain === true, "M: echo 未知选项拒绝");
assert(
  JSON.stringify(shellWriteTargets("sort -o /tmp/sorted docs/a")) === JSON.stringify(["/tmp/sorted"]),
  "M: sort -o 输出计入",
);
assert(analyzeShellWrites("sort -o $F docs/a").uncertain === true, "M: sort 动态输出拒绝");
assert(
  JSON.stringify(shellWriteTargets("sort --output=/tmp/sorted docs/a")) === JSON.stringify(["/tmp/sorted"]),
  "M: sort --output= 输出计入",
);
assert(
  JSON.stringify(shellWriteTargets("uniq docs/a /tmp/u")) === JSON.stringify(["/tmp/u"]),
  "M: uniq 第二操作数为输出",
);
assert(analyzeShellWrites("uniq docs/a $O").uncertain === true, "M: uniq 动态输出拒绝");
assert(
  JSON.stringify(shellWriteTargets("less -o /tmp/less.log docs/a")) === JSON.stringify(["/tmp/less.log"]),
  "M: less -o 日志输出计入",
);
assert(
  analyzeShellWrites("diff --output=/tmp/d.out docs/a docs/b").uncertain === true,
  "M: diff --output 未知选项拒绝（GNU diff 无此选项，旧空转测试已删除）",
);
assert(
  analyzeShellWrites("diff docs/a docs/b").uncertain === false,
  "M: diff 双操作数允许",
);
// M6 cp 链接模式后置/任意位置探测 + sort 禁用选项
assert(analyzeShellWrites("cp docs/a docs/b -l").uncertain === true, "M: cp 后置 -l 拒绝");
assert(analyzeShellWrites("cp --link docs/a docs/b").uncertain === true, "M: cp --link 拒绝");
assert(analyzeShellWrites("cp docs/a --link docs/b").uncertain === true, "M: cp 操作数间 --link 拒绝");
assert(analyzeShellWrites("cp -al docs/a docs/b").uncertain === true, "M: cp 短簇 -l 拒绝");
assert(analyzeShellWrites("sudo cp -s docs/a docs/b").uncertain === true, "M: 包装器下 cp -s 拒绝");
assert(analyzeShellWrites("env cp -l docs/a docs/b").uncertain === true, "M: 包装器下 cp -l 拒绝");
assert(
  JSON.stringify(analyzeShellWrites("cp -r docs/a docs/b", 0, proj).targets) === JSON.stringify(["docs/b"]),
  "M: cp -r 非链接模式照常建模",
);
assert(
  JSON.stringify(analyzeShellWrites("cp -S .bak docs/a docs/b", 0, proj).targets) === JSON.stringify(["docs/b"]),
  "M: cp -S（大写后缀）非链接模式照常建模",
);
assert(analyzeShellWrites("sort --compress-program=gzip docs/a").uncertain === true, "M: sort compress-program 拒绝");
assert(analyzeShellWrites("sort --temporary-directory=/tmp docs/a").uncertain === true, "M: sort temporary-directory 拒绝");
assert(analyzeShellWrites("sort -T /tmp docs/a").uncertain === true, "M: sort -T 拒绝");
assert(analyzeShellWrites("sort --parallel=4 docs/a").uncertain === true, "M: sort 未核实选项拒绝");
assert(analyzeShellWrites("sort -n -k2,2 docs/a").uncertain === false, "M: sort 核实选项放行");
assert(analyzeShellWrites("sort -n docs/a").uncertain === false, "M: sort 已知选项无输出放行");
assert(analyzeShellWrites("grep -i foo docs/a").uncertain === false, "M: grep 已知选项放行");
assert(analyzeShellWrites("[ -f docs/a ] && echo ok").uncertain === false, "M: [ 测试括号式放行");
assert(analyzeShellWrites("test -f docs/a").uncertain === false, "M: test 自由形放行");
assert(analyzeShellWrites(": ${x:=1}").uncertain === true, "M: : 动态参数统一拒绝");
// M2 xargs 后 wrapper/shell 链直接拒绝
assert(analyzeShellWrites("echo hi | xargs sudo tee /tmp/x").uncertain === true, "M: xargs sudo 链拒绝");
assert(analyzeShellWrites("echo hi | xargs env FOO=1 tee /tmp/x").uncertain === true, "M: xargs env 链拒绝");
assert(analyzeShellWrites("echo hi | xargs sh -c 'echo x'").uncertain === true, "M: xargs sh 链拒绝");
assert(analyzeShellWrites("echo hi | xargs -I REPL sh -c 'echo hi'").uncertain === true, "M: xargs -I sh 链拒绝");
// M3 scope 内禁建指向外部的硬链/软链；ln/cp -l 动态项拒绝
assert(analyzeShellWrites("ln -s /etc/passwd docs/link").uncertain === true, "M: ln 指外部绝对路径拒绝");
assert(analyzeShellWrites("ln -s ../outside docs/link").uncertain === true, "M: ln 指仓库外相对路径拒绝");
assert(analyzeShellWrites("ln -s $S docs/link").uncertain === true, "M: ln 动态源拒绝");
assert(analyzeShellWrites("ln docs/a /tmp/evil").uncertain === true, "M: ln 直接拒绝（即使仓库内源）");
assert(analyzeShellWrites("cp -l $S docs/link").uncertain === true, "M: cp -l 动态源拒绝");
assert(analyzeShellWrites("cp -s /etc/passwd docs/link").uncertain === true, "M: cp -s 指外部拒绝");
assert(
  analyzeShellWrites("cp -l docs/a docs/b", 0, proj).uncertain === true,
  "M: cp -l 直接拒绝（任意位置）",
);
// M4 sed 脚本 w/W 写命令与 s///w 标记、外写拒绝；e 执行递归解析
assert(
  analyzeShellWrites("sed 'w /tmp/evil' docs/a").uncertain === true,
  "M: sed w 直接拒绝（不建模脚本）",
);
assert(
  analyzeShellWrites("sed -n 's/a/b/w /tmp/x' docs/a").uncertain === true,
  "M: sed s///w 直接拒绝",
);
assert(analyzeShellWrites("sed 'w $F' docs/a").uncertain === true, "M: sed 动态 w 目标拒绝");
assert(
  analyzeShellWrites("sed -e 'e touch /tmp/evil' docs/a").uncertain === true,
  "M: sed e 直接拒绝",
);
assert(analyzeShellWrites("sed -e 'e' docs/a").uncertain === true, "M: sed 裸 e（执行模式空间）拒绝");
assert(analyzeShellWrites("sed -n 's/a/b/p' docs/app.md").uncertain === true, "M: sed 直接拒绝（即使只读）");
writeFileSync(path.join(proj, "docs", "w.sed"), "s/a/b/w /tmp/fromfile\n");
assert(
  analyzeShellWrites("sed -f docs/w.sed docs/a", 0, proj).uncertain === true,
  "M: sed -f 直接拒绝",
);
assert(analyzeShellWrites("sed -f /nonexistent_xyz.sed docs/a").uncertain === true, "M: sed -f 不可读拒绝");
// M5 严格参数形态：`-` 仅在确为 stdin 且无文件输出位置时允许；uniq/diff 操作数个数受限
assert(analyzeShellWrites("sort -o /tmp/x -").uncertain === true, "M: sort 输出与 `-` 输入并存拒绝");
assert(analyzeShellWrites("uniq - /tmp/u").uncertain === true, "M: uniq 输出与 `-` 输入并存拒绝");
assert(analyzeShellWrites("sort -o - docs/a").uncertain === false, "M: sort 输出 stdout（`-`）允许");
assert(analyzeShellWrites("uniq docs/a -").uncertain === false, "M: uniq 输出 stdout（`-`）允许");
assert(analyzeShellWrites("cat -").uncertain === false, "M: cat `-`（stdin/stdout）允许");
assert(analyzeShellWrites("uniq docs/a docs/b extra").uncertain === true, "M: uniq 超量操作数拒绝");
assert(analyzeShellWrites("diff docs/a docs/b extra").uncertain === true, "M: diff 超量操作数拒绝");
assert(analyzeShellWrites("diff docs/a docs/b").uncertain === false, "M: diff 双操作数允许");
{
  // 端到端：open 期新向量拦断、合法放行
  const ctx = ctxFor("M1");
  await callTool("speckit_rework_select_feature", { featureDirectory: "specs/001-demo" }, ctx);
  await callTool("speckit_rework_assess_impact", { affectedStages: [], summary: "x", scope: ["docs/**"] }, ctx);
  const b1 = await toolCall(ctx, "bash", { command: "sort -o /tmp/sorted docs/app.md" });
  assert(b1 && b1.block === true && b1.reason.includes("/tmp/sorted"), "M: open 期 sort -o 越界拦断", JSON.stringify(b1));
  const b2 = await toolCall(ctx, "bash", { command: "uniq docs/app.md /tmp/u" });
  assert(b2 && b2.block === true && b2.reason.includes("/tmp/u"), "M: open 期 uniq 输出越界拦断", JSON.stringify(b2));
  const b3 = await toolCall(ctx, "bash", { command: "ls --bogus-opt" });
  assert(b3 && b3.block === true && b3.reason.includes("unknown ls option"), "M: open 期未知选项拦断", JSON.stringify(b3));
  const b4 = await toolCall(ctx, "bash", { command: "echo hi | xargs sudo tee /tmp/x" });
  assert(b4 && b4.block === true, "M: open 期 xargs wrapper 链拦断", JSON.stringify(b4));
  const b5 = await toolCall(ctx, "bash", { command: "ln -s /etc/passwd docs/link" });
  assert(b5 && b5.block === true, "M: open 期外指软链拦断", JSON.stringify(b5));
  const b6 = await toolCall(ctx, "bash", { command: "sed 'w /tmp/evil' docs/a" });
  assert(b6 && b6.block === true && b6.reason.includes("sed denied"), "M: open 期 sed 直接拒绝", JSON.stringify(b6));
  const b7 = await toolCall(ctx, "bash", { command: "cp -l docs/a /tmp/evil" });
  assert(b7 && b7.block === true && b7.reason.includes("cp link mode denied"), "M: open 期 cp -l 直接拒绝", JSON.stringify(b7));
  const ok0 = await toolCall(ctx, "bash", { command: "sort -n docs/app.md | head -5" });
  assert(ok0 === undefined, "M: open 期只读 sort 管道放行", JSON.stringify(ok0));
  const ok1 = await toolCall(ctx, "bash", { command: "[ -f docs/app.md ] && echo ok" });
  assert(ok1 === undefined, "M: open 期 [ 测试放行", JSON.stringify(ok1));
  const n1 = await toolCall(ctx, "bash", { command: "sort -o /tmp/x -" });
  assert(n1 && n1.block === true, "M: open 期 sort 输出+stdin 拒绝", JSON.stringify(n1));
  const n2 = await toolCall(ctx, "bash", { command: "ln -s docs/a docs/b" });
  assert(n2 && n2.block === true && n2.reason.includes("ln denied"), "M: open 期 scope 内建链同样拒绝", JSON.stringify(n2));
  const n3 = await toolCall(ctx, "bash", { command: "sort -o - docs/app.md | head -5" });
  assert(n3 === undefined, "M: open 期 sort stdout 管道放行", JSON.stringify(n3));
  const n4 = await toolCall(ctx, "bash", { command: "cp docs/a docs/b -l" });
  assert(n4 && n4.block === true && n4.reason.includes("cp link mode denied"), "M: open 期 cp 后置 -l 拒绝", JSON.stringify(n4));
  const n5 = await toolCall(ctx, "bash", { command: "sort --compress-program=gzip docs/app.md" });
  assert(n5 && n5.block === true && n5.reason.includes("unknown sort option"), "M: open 期 sort 禁用选项拒绝", JSON.stringify(n5));
  const ok2 = await toolCall(ctx, "bash", { command: "sed -n 's/a/b/p' docs/app.md" });
  assert(ok2 && ok2.block === true && ok2.reason.includes("sed denied"), "M: open 期只读 sed 同样拒绝", JSON.stringify(ok2));
}

// ---------- P: reviewer 最新 FAIL（全参数位动态词统一拒绝 + 环境赋值白名单） ----------
// P1 任何参数位动态词/命令替换/反引号统一 fail-closed（合法静态路径不受影响）
assert(analyzeShellWrites("cat $F").uncertain === true, "P: 只读命令动态操作数拒绝");
assert(analyzeShellWrites("grep $PAT docs/a").uncertain === true, "P: 动态模式拒绝");
assert(analyzeShellWrites("echo $(date)").uncertain === true, "P: 命令替换操作数拒绝");
assert(analyzeShellWrites("echo `date`").uncertain === true, "P: 反引号操作数拒绝");
assert(analyzeShellWrites("sudo -u $U tee docs/a").uncertain === true, "P: 包装器动态取值拒绝");
assert(analyzeShellWrites("sort -k $K docs/a").uncertain === true, "P: 选项动态取值拒绝");
assert(analyzeShellWrites("find $DIR -print").uncertain === true, "P: find 动态操作数拒绝");
assert(analyzeShellWrites("LC_ALL=$X sort docs/a").uncertain === true, "P: 动态赋值拒绝");
assert(analyzeShellWrites("echo $((1+2))").uncertain === false, "P: 纯算术不受影响");
assert(analyzeShellWrites("LC_ALL=C sort -n docs/a").uncertain === false, "P: 静态白名单赋值放行");
// P2 环境赋值显式安全变量白名单；TMPDIR/TMP/TEMP、env 注入、未知变量拒绝
assert(analyzeShellWrites("TZ=UTC date").uncertain === false, "P: TZ 白名单放行");
assert(analyzeShellWrites("FOO=1 echo hi").uncertain === true, "P: 未知变量拒绝");
assert(analyzeShellWrites("TMPDIR=/tmp echo hi").uncertain === true, "P: TMPDIR 拒绝");
assert(analyzeShellWrites("TMP=/tmp echo hi").uncertain === true, "P: TMP 拒绝");
assert(analyzeShellWrites("TEMP=/tmp echo hi").uncertain === true, "P: TEMP 拒绝");
assert(analyzeShellWrites("PATH=/x echo hi").uncertain === true, "P: PATH 拒绝");
assert(analyzeShellWrites("LD_PRELOAD=x echo hi").uncertain === true, "P: LD_PRELOAD 拒绝");
assert(analyzeShellWrites("env FOO=1 echo hi").uncertain === true, "P: env 未知变量拒绝");
assert(analyzeShellWrites("env LC_ALL=C echo hi").uncertain === false, "P: env 白名单变量放行");
assert(analyzeShellWrites("env -S 'A=1' echo hi").uncertain === true, "P: env -S 分裂注入拒绝");
assert(analyzeShellWrites("sudo FOO=1 echo hi").uncertain === true, "P: 包装器下未知变量拒绝");
assert(analyzeShellWrites("sudo LC_ALL=C echo hi").uncertain === false, "P: 包装器下白名单变量放行");
{
  // 端到端：open 期动态/env 向量拦断、合法静态放行
  const ctx = ctxFor("P1");
  await callTool("speckit_rework_select_feature", { featureDirectory: "specs/001-demo" }, ctx);
  await callTool("speckit_rework_assess_impact", { affectedStages: [], summary: "x", scope: ["docs/**"] }, ctx);
  const d1 = await toolCall(ctx, "bash", { command: "cat $F" });
  assert(d1 && d1.block === true && d1.reason.includes("dynamic argument"), "P: open 期动态操作数拦断", JSON.stringify(d1));
  const d2 = await toolCall(ctx, "bash", { command: "echo $(date)" });
  assert(d2 && d2.block === true, "P: open 期命令替换拦断", JSON.stringify(d2));
  const e1 = await toolCall(ctx, "bash", { command: "TMPDIR=/tmp sort docs/app.md" });
  assert(e1 && e1.block === true && e1.reason.includes("unsafe env assignment: TMPDIR"), "P: open 期 TMPDIR 拦断", JSON.stringify(e1));
  const e2 = await toolCall(ctx, "bash", { command: "env -S 'A=1' echo hi" });
  assert(e2 && e2.block === true && e2.reason.includes("env -S"), "P: open 期 env -S 拦断", JSON.stringify(e2));
  const ok0 = await toolCall(ctx, "bash", { command: "LC_ALL=C sort -n docs/app.md | head -5" });
  assert(ok0 === undefined, "P: open 期白名单赋值+静态管线放行", JSON.stringify(ok0));
}

// ---------- Q: reviewer 最新 FAIL（env 选项白名单 + 字面 `$` 区分） ----------
// Q1 env 在 scope 模式下拒绝所有选项，仅明确安全白名单放行（禁止通用跳过；含长选项缩写）
assert(analyzeShellWrites("env -i echo hi").uncertain === false, "Q: env -i 放行");
assert(analyzeShellWrites("env --ignore-environment echo hi").uncertain === false, "Q: env 长选项放行");
assert(analyzeShellWrites("env -u FOO echo hi").uncertain === false, "Q: env -u 取值放行");
assert(analyzeShellWrites("env --argv0 x echo hi").uncertain === false, "Q: env --argv0 放行");
assert(analyzeShellWrites("env -0 -v echo hi").uncertain === false, "Q: env -0/-v 放行");
assert(analyzeShellWrites("env --block-signal echo hi").uncertain === false, "Q: env 信号选项放行");
assert(analyzeShellWrites("env -C /tmp echo hi").uncertain === true, "Q: env -C 改目录拒绝");
assert(analyzeShellWrites("env --chdir=/tmp echo hi").uncertain === true, "Q: env --chdir 拒绝");
assert(analyzeShellWrites("env -x echo hi").uncertain === true, "Q: env 未知短选项拒绝");
assert(analyzeShellWrites("env --debug echo hi").uncertain === true, "Q: env 未知长选项拒绝");
assert(analyzeShellWrites("env --spl echo hi").uncertain === true, "Q: env 长选项缩写拒绝");
assert(analyzeShellWrites("env -S 'A=1' echo hi").uncertain === true, "Q: env -S 分裂拒绝");
assert(analyzeShellWrites("env --split-string='A=1' echo hi").uncertain === true, "Q: env --split-string= 拒绝");
assert(analyzeShellWrites("env -iS'A=1' echo hi").uncertain === true, "Q: env 短簇 S 拒绝");
// Q2 字面 `$` 与真实展开区分（grep/echo/cat 误杀修正）
assert(analyzeShellWrites('echo "total $"').uncertain === false, "Q: 双引号内行尾 `$` 字面放行");
assert(analyzeShellWrites('grep "a$" docs/a').uncertain === false, "Q: 正则行尾 `$` 字面放行");
assert(analyzeShellWrites('echo "a$ b"').uncertain === false, "Q: `$` 后空格字面放行");
assert(analyzeShellWrites('cat "f$.txt"').uncertain === false, "Q: `$` 后标点字面放行");
assert(analyzeShellWrites('echo "a$b"').uncertain === true, "Q: 真实变量展开仍拒绝");
assert(analyzeShellWrites('echo "$HOME"').uncertain === true, "Q: 双引号内变量展开仍拒绝");
assert(analyzeShellWrites('grep "$p" f').uncertain === true, "Q: grep 动态模式仍拒绝");
assert(analyzeShellWrites("echo `date`").uncertain === true, "Q: 反引号仍拒绝");
{
  // 端到端：open 期 env/字面 `$` 向量
  const ctx = ctxFor("Q1");
  await callTool("speckit_rework_select_feature", { featureDirectory: "specs/001-demo" }, ctx);
  await callTool("speckit_rework_assess_impact", { affectedStages: [], summary: "x", scope: ["docs/**"] }, ctx);
  const e1 = await toolCall(ctx, "bash", { command: "env -C /tmp ls -la" });
  assert(e1 && e1.block === true && e1.reason.includes("unknown env option"), "Q: open 期 env -C 拦断", JSON.stringify(e1));
  const e2 = await toolCall(ctx, "bash", { command: "env --spl ls -la" });
  assert(e2 && e2.block === true && e2.reason.includes("unknown env option"), "Q: open 期 env 缩写拦断", JSON.stringify(e2));
  const e3 = await toolCall(ctx, "bash", { command: "env -u FOO ls -la" });
  assert(e3 === undefined, "Q: open 期 env 白名单放行", JSON.stringify(e3));
  const l1 = await toolCall(ctx, "bash", { command: 'grep "a$" docs/app.md' });
  assert(l1 === undefined, "Q: open 期字面 `$` 放行", JSON.stringify(l1));
}

rmSync(base, { recursive: true, force: true });
report("speckit-rework-gate");
