/**
 * project-lease-guard — Pi 的写入租约守卫（系统级客户端）。
 *
 * 每次工具调用前把 toolName/input 交给系统守卫脚本；守卫只查一次本地
 * Unix socket，不调用模型。写入权属于别人时返回 block，AI 会直接看到理由。
 *
 * 本文件由 `project-lease-guard-enable` 安装到 ~/.pi/agent/extensions/。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";

const GUARD = process.env.PROJECT_LEASE_GUARD_BIN || "/usr/local/bin/project-lease-guard";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    const input = (event as { input?: unknown }).input ?? {};
    const payload = JSON.stringify({
      tool_name: event.toolName,
      tool_input: input,
      cwd: process.cwd(),
    });
    let done;
    try {
      done = spawnSync(GUARD, ["--format", "pi"], {
        input: payload,
        encoding: "utf8",
        timeout: 5000,
      });
    } catch {
      return;
    }
    if (done.status !== 0 || !done.stdout) return;
    try {
      const result = JSON.parse(done.stdout) as { block?: boolean; reason?: string };
      if (result.block) {
        return { block: true, reason: result.reason || "共享项目写入权不在当前用户手中" };
      }
    } catch {
      return;
    }
  });
}
