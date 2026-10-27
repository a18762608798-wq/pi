// formula-style: targeted tests.
// 1) registers exactly one before_agent_start handler (and nothing else);
// 2) injected text is verbatim-identical to the OpenCode original's string;
// 3) works when sections is initially empty; returns no override.
import { readFileSync } from "node:fs";
import { assert, makeMockPi, mockCtx, report } from "./helper.mjs";
import formulaFactory, { FORMULA_TEXT } from "../../agent/extensions/formula-style.ts";

const { pi, handlers } = makeMockPi();
formulaFactory(pi);

assert(handlers.size === 1 && handlers.has("before_agent_start"), "only before_agent_start is subscribed");
assert(handlers.get("before_agent_start").length === 1, "exactly one before_agent_start handler");

// Verbatim equivalence with the OpenCode original: extract its TS string literal.
const orig = readFileSync("/home/dell/.config/opencode/plugins/formula-style.ts", "utf8");
const m = orig.match(/const text =\s*"((?:[^"\\]|\\.)*)"/s);
assert(m !== null, "original text literal found");
const expected = m[1].replace(/\\\\/g, "\\").replace(/\\"/g, '"');
assert(FORMULA_TEXT === expected, "injected text is verbatim-identical to OpenCode original", `len ${FORMULA_TEXT.length} vs ${expected.length}`);

const { ctx } = mockCtx();
const event = { type: "before_agent_start", systemPromptOptions: { sections: {} } };
await handlers.get("before_agent_start")[0](event, ctx);
assert(event.systemPromptOptions.sections["formula-style"] === FORMULA_TEXT, "section injected into systemPromptOptions");
assert(!("systemPrompt" in event) || event.systemPrompt === undefined, "no opaque systemPrompt override (section diff preserved)");

report("formula-style");
