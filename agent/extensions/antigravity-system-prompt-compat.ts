import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Antigravity-only workaround for issue #137. Keep every instruction and tool,
// but move the known Pi system text to the first user turn. This changes prompt
// priority; the user accepted this workaround to restore Hydrogen in Pi.
const SHORT_SYSTEM = "You are a coding agent.";
const OPENERS = [
  "You are a coding assistant running inside pi, a coding agent harness.",
  "You are a coding assistant running inside pi.",
  "You are a coding assistant running inside your development environment.",
  "You are a coding agent helping the user with their project.",
];
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function compatiblePayload(payload: unknown, provider: string | undefined): unknown {
  if (provider !== "antigravity" || !record(payload) || !record(payload.request)) return undefined;
  if (typeof payload.model !== "string" || /image/i.test(payload.model)) return undefined;
  const request = payload.request;
  const system = request.systemInstruction;
  if (!record(system) || !Array.isArray(system.parts) || !system.parts.length) return undefined;
  if (!system.parts.every((part) => record(part) && typeof part.text === "string" && Object.keys(part).every((key) => key === "text"))) return undefined;
  if (!OPENERS.some((opener) => system.parts[0].text.startsWith(opener))) return undefined;
  if (!Array.isArray(request.contents) || !request.contents.every((turn) => record(turn) && Array.isArray(turn.parts))) return undefined;
  const contents = [...request.contents];
  const firstUserIndex = contents.findIndex((turn) => turn.role === "user");
  const instructionParts = [
    { text: "[Operating instructions]" },
    ...system.parts,
    { text: "[/Operating instructions]" },
  ];
  if (firstUserIndex >= 0) {
    const first = contents[firstUserIndex];
    contents[firstUserIndex] = { ...first, parts: [...instructionParts, ...first.parts] };
  } else {
    contents.unshift({ role: "user", parts: instructionParts });
  }
  return {
    ...payload,
    request: {
      ...request,
      contents,
      systemInstruction: { ...system, parts: [{ text: SHORT_SYSTEM }] },
    },
  };
}
export default function(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event, ctx) => {
    if (process.env.PI_ANTIGRAVITY_PROMPT_COMPAT === "0" || process.env.ANTIGRAVITY_PROMPT_GUARD === "off") return;
    return compatiblePayload(event.payload, ctx.model?.provider);
  });
}
