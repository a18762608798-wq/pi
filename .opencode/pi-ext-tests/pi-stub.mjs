// Minimal runtime stub for "@earendil-works/pi-coding-agent" value imports.
// Only withFileMutationQueue is imported as a value by the ported extensions.
export async function withFileMutationQueue(_filePath, fn) {
  return await fn();
}

export function defineTool(tool) {
  return tool;
}
