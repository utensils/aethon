import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
  type TabRecord,
} from "./state";
import { buildSessionTitleTools } from "./session-title-tool";
import { tabSessionDir } from "./tab-lifecycle";

const roots: string[] = [];

const baseOpts: AethonAgentStateOptions = {
  userDir: "/tmp/aethon-test",
  stateFile: "/tmp/aethon-test/state.json",
  sessionsDir: "/tmp/aethon-test/sessions",
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

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "aethon-session-title-tool-"));
  roots.push(root);
  const state = new AethonAgentState({
    ...baseOpts,
    userDir: root,
    stateFile: join(root, "state.json"),
    sessionsDir: join(root, "sessions"),
  });
  const sent: Record<string, unknown>[] = [];
  const setSessionName = vi.fn();
  state.tabs.set("tab-1", {
    id: "tab-1",
    session: { setSessionName } as unknown as TabRecord["session"],
    toolArgsCache: new Map(),
    promptInFlight: false,
    agentEndFired: false,
    queuedCount: 0,
    toolCardSeq: 0,
    responseMessageSeq: 0,
  });
  const sessionDir = tabSessionDir(state, "tab-1");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "session.jsonl"),
    `${JSON.stringify({ type: "session", id: "s", cwd: "/repo/a" })}\n`,
    "utf8",
  );
  return {
    state,
    sent,
    setSessionName,
    deps: { send: (m: Record<string, unknown>) => sent.push(m) },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function getTool(state: AethonAgentState, deps: { send: (m: Record<string, unknown>) => void }) {
  const tool = buildSessionTitleTools(state, deps, "tab-1").find(
    (t) => t.name === "setSessionTabTitle",
  );
  if (!tool) throw new Error("setSessionTabTitle not registered");
  return tool;
}

describe("buildSessionTitleTools", () => {
  it("registers the silent session-title tool", async () => {
    const { state, deps } = await makeFixture();

    expect(buildSessionTitleTools(state, deps, "tab-1").map((t) => t.name)).toEqual([
      "setSessionTabTitle",
    ]);
  });

  it("sets the Aethon label, pi session name, discovered metadata, and bridge event", async () => {
    const { state, deps, sent, setSessionName } = await makeFixture();

    const result = await getTool(state, deps).execute("call-1", {
      title: "  Refactor auth flow  ",
    });

    expect(setSessionName).toHaveBeenCalledWith("Refactor auth flow");
    await expect(
      readFile(join(tabSessionDir(state, "tab-1"), "label.txt"), "utf8"),
    ).resolves.toBe("Refactor auth flow\n");
    expect(state.discoveredTabs).toHaveLength(1);
    expect(state.discoveredTabs[0]).toMatchObject({
      tabId: "tab-1",
      cwd: "/repo/a",
      customLabel: "Refactor auth flow",
    });
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "session_label_changed",
        tabId: "tab-1",
        label: "Refactor auth flow",
        session: expect.objectContaining({
          tabId: "tab-1",
          customLabel: "Refactor auth flow",
        }),
      }),
    );
    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, title: "Refactor auth flow" }, null, 2),
        },
      ],
      details: { ok: true, title: "Refactor auth flow" },
    });
  });

  it("keeps discovered tabs sorted after metadata refresh", async () => {
    const { state, deps } = await makeFixture();
    state.discoveredTabs = [
      { tabId: "tab-2", lastModified: 1, cwd: "/repo/newer" },
      { tabId: "tab-1", lastModified: 0, cwd: "/repo/old" },
    ];

    await getTool(state, deps).execute("call-1", {
      title: "Prompt polish",
    });

    expect(state.discoveredTabs.map((tab) => tab.tabId)).toEqual([
      "tab-1",
      "tab-2",
    ]);
  });

  it("rejects an empty title", async () => {
    const { state, deps } = await makeFixture();

    await expect(
      getTool(state, deps).execute("call-1", { title: "   " }),
    ).rejects.toThrow("setSessionTabTitle: title required");
  });
});
