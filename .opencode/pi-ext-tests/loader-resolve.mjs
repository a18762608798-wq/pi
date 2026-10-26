// Resolve hooks for standalone tests (no Pi runtime):
// - "typebox" -> real typebox ESM shipped under agent/npm
// - "@earendil-works/pi-coding-agent" -> local stub (only withFileMutationQueue is used at runtime)
import { pathToFileURL } from "node:url";
import path from "node:path";

const TYPEBOX_ENTRY = "/home/mintusr/.pi/agent/npm/node_modules/typebox/build/index.mjs";
const STUB_URL = pathToFileURL(path.resolve(import.meta.dirname, "pi-stub.mjs")).href;

export async function resolve(specifier, context, next) {
  if (specifier === "typebox") return { url: pathToFileURL(TYPEBOX_ENTRY).href, shortCircuit: true };
  if (
    specifier === "@earendil-works/pi-coding-agent" ||
    specifier === "@earendil-works/pi-ai" ||
    specifier === "@earendil-works/pi-tui"
  ) {
    return { url: STUB_URL, shortCircuit: true };
  }
  return next(specifier, context);
}
