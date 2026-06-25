import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AethonAgentStateOptions } from "./state";

const mocks = vi.hoisted(() => {
  process.env.AETHON_WORKER_TAB_ID = "test-worker";
  return {
    createAgentSession: vi.fn(),
  };
});

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: mocks.createAgentSession,
  };
});

const { AethonAgentState } = await import("./state");
const { ensureTab } = await import("./tab-lifecycle/lifecycle");

afterAll(() => {
  delete process.env.AETHON_WORKER_TAB_ID;
});

function baseOpts(root: string): AethonAgentStateOptions {
  return {
    userDir: join(root, "user"),
    stateFile: join(root, "user", "state.json"),
    sessionsDir: join(root, "sessions"),
    docsDir: undefined,
    projectRoot: undefined,
    releaseMode: false,
    bootLayoutFile: undefined,
    layoutSlotsFile: undefined,
    statePayloadWarnBytes: 64 * 1024,
    statePayloadHardBytes: 512 * 1024,
    statePayloadWarnKb: 64,
    statePayloadHardKb: 512,
  };
}

function makeSession() {
  return {
    agent: { beforeToolCall: undefined },
    bindExtensions: vi.fn(() => Promise.resolve()),
    getAvailableThinkingLevels: () => ["off", "medium"],
    model: { id: "gpt-5.5", provider: "openai-codex", name: "GPT-5.5" },
    subscribe: vi.fn(),
    thinkingLevel: "medium",
  };
}

function makeResourceLoader() {
  return {
    extendResources: vi.fn(),
    getAgentsFiles: vi.fn(() => ({ agentsFiles: [] })),
    getAppendSystemPrompt: vi.fn(() => []),
    getExtensions: vi.fn(() => ({ extensions: [], errors: [] })),
    getPrompts: vi.fn(() => ({ prompts: [], diagnostics: [] })),
    getSkills: vi.fn(() => ({ skills: [], diagnostics: [] })),
    getSystemPrompt: vi.fn(() => undefined),
    getThemes: vi.fn(() => ({ themes: [], diagnostics: [] })),
    reload: vi.fn(() => Promise.resolve()),
  };
}

describe("ensureTab extension binding", () => {
  beforeEach(() => {
    mocks.createAgentSession.mockReset();
  });

  it("binds pi extensions so session_start handlers initialize adapter state", async () => {
    const root = mkdtempSync(join(tmpdir(), "aethon-tab-bind-"));
    const state = new AethonAgentState(baseOpts(root));
    state.authProfiles = { profiles: [], defaultByProvider: {} };
    state.authStorage = {} as never;
    state.modelRegistry = {
      getAll: () => [],
      getAvailable: () => [],
    } as never;
    state.settingsManager = {
      getDefaultModel: () => undefined,
      getDefaultProvider: () => undefined,
      getEnabledModels: () => [],
    } as never;
    const resourceLoader = makeResourceLoader();
    state.resourceLoader = resourceLoader as never;

    const session = makeSession();
    mocks.createAgentSession.mockImplementation((config) => {
      session.bindExtensions.mockImplementationOnce(() => {
        config.resourceLoader.extendResources({
          skillPaths: [
            {
              path: join(root, "project", ".pi-skill"),
              metadata: { scope: "temporary", source: "test" },
            },
          ],
        });
        return Promise.resolve();
      });
      return Promise.resolve({ session });
    });

    const deps = { send: vi.fn() };
    await ensureTab(state, deps, "tab-1", {
      cwdOverride: join(root, "project"),
    });

    expect(mocks.createAgentSession).toHaveBeenCalledOnce();
    expect(session.bindExtensions).toHaveBeenCalledWith({
      onError: expect.any(Function),
    });
    expect(session.subscribe).toHaveBeenCalledBefore(session.bindExtensions);
    expect(resourceLoader.extendResources).not.toHaveBeenCalled();
    expect(state.tabs.get("tab-1")?.session).toBe(session);
  });
});
