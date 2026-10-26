/**
 * formula-style — Pi 本地扩展（OpenCode `plugins/formula-style.ts` 的功能等价改写）。
 *
 * 原插件行为：每次 session `context` 钩子向 system 区追加一段数学公式排版规则。
 * Pi 映射：`before_agent_start` 是 Pi 官方推荐的“改 prompt”位置；把同一段文本写进
 * `systemPromptOptions.sections["formula-style"]`，Pi 会把它渲染成
 * `<formula-style>...</formula-style>` 系统区段，随本轮 transcript 记录并做增量同步。
 *
 * 行为映射：
 * - OpenCode `session.hook("context")` → Pi `pi.on("before_agent_start")`
 * - 触发频率：OpenCode 是每次 LLM 调用前；Pi 是每轮 run 开始时（同一轮内多 turn
 *   共用 run 起始的 prompt）。工具返回里仍能看到阶段变化，属可接受的时机差异。
 * - 文本逐字相同（含 `$ E=mc^2 $` 错误示例与 `\(...\)` 禁令写法）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FORMULA_TEXT =
  "数学公式（含对话回复与写入 Markdown 文件）必须统一使用 LaTeX $ 格式，禁止用纯文本或 Unicode 字符代替公式：行内公式使用 $...$，正确如这是 $E=mc^2$ 公式（$与外侧文字间保留空格、与内侧公式内容间不加空格，$ E=mc^2 $ 为错误写法）；独立成段公式使用 $$...$$（开头 $$、公式内容、结尾 $$ 各自单独成行）。禁止使用 \\(...\\) 或 \\[...\\] 格式。";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    event.systemPromptOptions.sections["formula-style"] = FORMULA_TEXT;
  });
}
