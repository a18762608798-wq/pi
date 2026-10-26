// Shared mocks + tiny assertion harness for Pi extension tests.
export let passed = 0;
export let failed = 0;

export function assert(cond, name, extra) {
  if (cond) {
    passed += 1;
    console.log(`ok - ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL - ${name}${extra !== undefined ? ` :: ${extra}` : ""}`);
  }
}

export function makeMockPi() {
  const handlers = new Map();
  const tools = new Map();
  const setModelCalls = [];
  const pi = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    async setModel(model) {
      setModelCalls.push(model);
      return true;
    },
  };
  return { pi, handlers, tools, setModelCalls };
}

export function mockCtx({ cwd = "/tmp", sessionFile = undefined, sessionId = "test-session", model = undefined, hasUI = true } = {}) {
  const notifications = [];
  return {
    ctx: {
      cwd,
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => sessionId,
        getCwd: () => cwd,
      },
      model,
      hasUI,
      ui: {
        notify: (msg, type) => notifications.push({ msg, type }),
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
      },
    },
    notifications,
  };
}

export function report(suite) {
  console.log(`--- ${suite}: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exitCode = 1;
}
