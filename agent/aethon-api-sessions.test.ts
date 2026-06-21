import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { AethonAgentState, type AethonAgentStateOptions } from "./state";
import { buildAethonApi } from "./aethon-api";
import {
  emitSessionEvent,
  handleMirroredTabsChanged,
} from "./aethon-api-sessions";
import type { RuntimeSnapshot } from "./system-prompt";

function opts(root: string): AethonAgentStateOptions {
  return {
    userDir: root,
    stateFile: join(root, "state.json"),
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

function fakeSnapshot(): RuntimeSnapshot {
  return {
    release: false,
    cwd: "/tmp",
    docsDir: undefined,
    projectRoot: undefined,
    userDir: "/tmp",
    stateFile: "/tmp/state.json",
    extensions: [],
    failedExtensions: [],
    disabledExtensions: [],
    themes: [],
    subagents: [],
    components: [],
    layoutSummary: "",
    tabs: [],
    eventHandlers: [],
    slashCommands: [],
    keybindings: [],
    menuItems: [],
    eventRoutes: [],
    eventRoutingMode: "builtin",
    uiState: {},
    layoutStructure: null,
    layoutSlots: null,
    layouts: [],
    frontendModules: [],
    highlightGrammars: [],
    nativeWindows: [],
  };
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "aethon-sessions-api-"));
  const state = new AethonAgentState(opts(root));
  const api = buildAethonApi(state, {
    send: () => {},
    scheduleStateFileWrite: () => {},
    getRuntimeSnapshot: fakeSnapshot,
  });
  return { root, state, api };
}

function fakeTabRecord(messages: unknown[] = [], model = "test/model") {
  return {
    id: "tab-1",
    session: {
      model: {
        provider: model.split("/")[0],
        id: model.split("/").slice(1).join("/"),
      },
      messages,
    },
    toolArgsCache: new Map(),
    promptInFlight: false,
    agentEndFired: false,
    queuedCount: 0,
    toolCardSeq: 0,
    responseMessageSeq: 0,
  };
}

describe("aethon.sessions API", () => {
  it("lists live and discovered sessions with active metadata", async () => {
    const { state, api } = await makeFixture();
    state.tabs.set(
      "live",
      fakeTabRecord([{ role: "user", content: "hi" }]) as never,
    );
    state.tabProjectCwds.set("live", "/repo/live");
    state.discoveredTabs = [
      {
        tabId: "old",
        lastModified: 1234,
        cwd: "/repo/old",
        firstUserMessage: "Earlier prompt",
      },
    ];
    state.frontendState.set("/tabs", [
      {
        id: "live",
        label: "Live tab",
        kind: "agent",
        cwd: "/repo/live",
        model: "openai/gpt-test",
        waiting: false,
        active: true,
      },
      {
        id: "editor-1",
        label: "README.md",
        kind: "editor",
        cwd: "/repo/live",
        active: false,
      },
    ]);

    const sessions = await api.sessions.list();
    expect(sessions).toEqual([
      expect.objectContaining({
        id: "live",
        label: "Live tab",
        active: true,
        model: "openai/gpt-test",
        cwd: "/repo/live",
        messageCount: 1,
      }),
      expect.objectContaining({
        id: "old",
        label: "Earlier prompt",
        active: false,
        cwd: "/repo/old",
        updatedAt: 1234,
      }),
    ]);
    expect(sessions.some((session) => session.id === "editor-1")).toBe(false);
  });

  it("returns the active session summary", async () => {
    const { state, api } = await makeFixture();
    state.tabs.set("a", fakeTabRecord() as never);
    state.tabs.set("b", fakeTabRecord() as never);
    state.frontendState.set("/tabs", [
      { id: "a", label: "A", kind: "agent", active: false },
      { id: "b", label: "B", kind: "agent", active: true },
    ]);

    await expect(api.sessions.getActive()).resolves.toMatchObject({
      id: "b",
      label: "B",
      active: true,
    });
  });

  it("normalizes live pi messages", async () => {
    const { state, api } = await makeFixture();
    state.tabs.set(
      "live",
      fakeTabRecord([
        {
          id: "u1",
          role: "user",
          content:
            "You are in Aethon plan mode. Do not edit files, run shell commands, start implementation tasks, commit, push, or make persistent changes. Inspect read-only context as needed, then propose a concise implementation plan with risks and tests. Wait for the user to switch back to implementation mode or explicitly approve implementation.\n\nUser request:\nhello\n\n<aethon_file_references>\nsecret file body\n</aethon_file_references>",
          createdAt: 10,
        },
        {
          id: "a1",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "plan" },
            { type: "text", text: "world" },
          ],
          createdAt: 20,
        },
      ]) as never,
    );

    await expect(api.sessions.getMessages("live")).resolves.toEqual([
      expect.objectContaining({
        id: "u1",
        role: "user",
        content: "hello",
        text: "hello",
        createdAt: 10,
      }),
      expect.objectContaining({
        id: "a1",
        role: "agent",
        content: "world",
        text: "world",
        thinking: "plan",
        createdAt: 20,
      }),
    ]);
  });

  it("merges durable local transcript entries for live sessions", async () => {
    const { root, state, api } = await makeFixture();
    const sessionDir = join(root, "sessions", "live");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "aethon-chat.jsonl"),
      [
        JSON.stringify({
          type: "aethon_chat",
          id: "local-user",
          role: "user",
          text: "hello",
          attachments: [
            {
              id: "img-1",
              kind: "image",
              path: "/repo/live/screenshot.png",
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 123,
            },
          ],
          createdAt: 10,
          cwd: "/repo/live",
        }),
        JSON.stringify({
          type: "aethon_chat",
          id: "local-system",
          role: "system",
          text: "local only",
          createdAt: 20,
          cwd: "/repo/live",
        }),
      ].join("\n") + "\n",
    );
    state.tabs.set(
      "live",
      fakeTabRecord([
        { id: "u1", role: "user", content: "hello", createdAt: 10 },
      ]) as never,
    );
    state.tabProjectCwds.set("live", "/repo/live");

    await expect(api.sessions.getMessages("live")).resolves.toEqual([
      expect.objectContaining({
        id: "u1",
        role: "user",
        content: "hello",
        attachments: [
          expect.objectContaining({ id: "img-1", mimeType: "image/png" }),
        ],
      }),
      expect.objectContaining({
        id: "local-system",
        role: "system",
        content: "local only",
      }),
    ]);
  });

  it("reads dormant session messages from the supported transcript parser", async () => {
    const { root, state, api } = await makeFixture();
    const sessionDir = join(root, "sessions", "old");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "aethon-chat.jsonl"),
      JSON.stringify({
        type: "aethon_chat",
        id: "m1",
        role: "user",
        text: "from disk",
        createdAt: 42,
        cwd: "/repo/old",
      }) + "\n",
    );
    state.discoveredTabs = [
      { tabId: "old", lastModified: 42, cwd: "/repo/old" },
    ];

    await expect(api.sessions.getMessages("old")).resolves.toEqual([
      expect.objectContaining({
        id: "m1",
        role: "user",
        content: "from disk",
        createdAt: 42,
      }),
    ]);
  });

  it("includes in-flight assistant messages", async () => {
    const { state, api } = await makeFixture();
    const rec = fakeTabRecord([]) as never;
    state.tabs.set("live", rec);

    Object.assign(rec, {
      activeResponseMessageId: "text-stream-1",
      activeResponseText: "streaming answer",
    });

    await expect(api.sessions.getMessages("live")).resolves.toEqual([
      expect.objectContaining({
        id: "text-stream-1",
        role: "agent",
        content: "streaming answer",
      }),
    ]);
  });

  it("prefers in-flight assistant text over persisted deltas with the same id", async () => {
    const { root, state, api } = await makeFixture();
    const sessionDir = join(root, "sessions", "live");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "aethon-chat.jsonl"),
      JSON.stringify({
        type: "aethon_chat",
        id: "text-stream-1",
        role: "agent",
        text: "old partial",
        thinking: "old thought",
        createdAt: 10,
        cwd: "/repo/live",
      }) + "\n",
    );
    const rec = fakeTabRecord([]) as never;
    state.tabs.set("live", rec);
    state.tabProjectCwds.set("live", "/repo/live");
    Object.assign(rec, {
      activeResponseMessageId: "text-stream-1",
      activeResponseText: "new streamed text",
      activeResponseThinking: "new thought",
    });

    await expect(api.sessions.getMessages("live")).resolves.toEqual([
      expect.objectContaining({
        id: "text-stream-1",
        content: "new streamed text",
        text: "new streamed text",
        thinking: "new thought",
        createdAt: 10,
      }),
    ]);
  });

  it("orders in-flight assistant messages after restored history", async () => {
    const { root, state, api } = await makeFixture();
    const sessionDir = join(root, "sessions", "live");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "aethon-chat.jsonl"),
      JSON.stringify({
        type: "aethon_chat",
        id: "local-user",
        role: "user",
        text: "prompt first",
        createdAt: 10,
        cwd: "/repo/live",
      }) + "\n",
    );
    const rec = fakeTabRecord([]) as never;
    state.tabs.set("live", rec);
    state.tabProjectCwds.set("live", "/repo/live");
    Object.assign(rec, {
      activeResponseMessageId: "text-stream-1",
      activeResponseText: "answer second",
    });

    await expect(api.sessions.getMessages("live")).resolves.toEqual([
      expect.objectContaining({ id: "local-user", content: "prompt first" }),
      expect.objectContaining({
        id: "text-stream-1",
        content: "answer second",
      }),
    ]);
  });

  it("does not hide repeated same-content in-flight assistant messages", async () => {
    const { state, api } = await makeFixture();
    const rec = fakeTabRecord([
      { id: "a1", role: "assistant", content: "Done", createdAt: 10 },
    ]) as never;
    state.tabs.set("live", rec);
    Object.assign(rec, {
      activeResponseMessageId: "text-stream-1",
      activeResponseText: "Done",
    });

    await expect(api.sessions.getMessages("live")).resolves.toEqual([
      expect.objectContaining({ id: "a1", content: "Done" }),
      expect.objectContaining({ id: "text-stream-1", content: "Done" }),
    ]);
  });

  it("preserves local metadata for repeated same-content live messages", async () => {
    const { root, state, api } = await makeFixture();
    const sessionDir = join(root, "sessions", "live");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "aethon-chat.jsonl"),
      [
        JSON.stringify({
          type: "aethon_chat",
          id: "local-1",
          role: "user",
          text: "same prompt",
          attachments: [
            {
              id: "img-1",
              kind: "image",
              path: "/repo/live/one.png",
              name: "one.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
          createdAt: 10,
          cwd: "/repo/live",
        }),
        JSON.stringify({
          type: "aethon_chat",
          id: "local-2",
          role: "user",
          text: "same prompt",
          attachments: [
            {
              id: "img-2",
              kind: "image",
              path: "/repo/live/two.png",
              name: "two.png",
              mimeType: "image/png",
              sizeBytes: 2,
            },
          ],
          createdAt: 20,
          cwd: "/repo/live",
        }),
      ].join("\n") + "\n",
    );
    state.tabs.set(
      "live",
      fakeTabRecord([
        { id: "u1", role: "user", content: "same prompt", createdAt: 10 },
        { id: "u2", role: "user", content: "same prompt", createdAt: 20 },
      ]) as never,
    );
    state.tabProjectCwds.set("live", "/repo/live");

    await expect(api.sessions.getMessages("live")).resolves.toEqual([
      expect.objectContaining({
        id: "u1",
        attachments: [expect.objectContaining({ id: "img-1" })],
      }),
      expect.objectContaining({
        id: "u2",
        attachments: [expect.objectContaining({ id: "img-2" })],
      }),
    ]);
  });

  it("contains rejected async session handlers", async () => {
    const { state, api } = await makeFixture();
    const calls: unknown[] = [];
    api.sessions.on("messageAppended", (payload) => {
      calls.push(payload);
      return Promise.reject(new Error("handler failed"));
    });

    emitSessionEvent(state, "messageAppended", {
      sessionId: "live",
      message: { id: "m", role: "user", content: "hi" },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toHaveLength(1);
  });

  it("does not emit sessionChanged for waiting-only frontend tab patches", async () => {
    const { state, api } = await makeFixture();
    state.tabs.set("live", fakeTabRecord() as never);
    state.frontendState.set("/tabs", [
      {
        id: "live",
        label: "Live",
        kind: "agent",
        cwd: "/repo",
        model: "openai/gpt-test",
        active: true,
        waiting: false,
      },
    ]);
    const calls: unknown[] = [];
    api.sessions.on("sessionChanged", (payload) => calls.push(payload));

    handleMirroredTabsChanged(
      state,
      [
        {
          id: "live",
          label: "Live",
          kind: "agent",
          cwd: "/repo",
          model: "openai/gpt-test",
          active: true,
          waiting: false,
        },
      ],
      [
        {
          id: "live",
          label: "Live",
          kind: "agent",
          cwd: "/repo",
          model: "openai/gpt-test",
          active: true,
          waiting: true,
        },
      ],
    );
    await Promise.resolve();

    expect(calls).toEqual([]);
  });

  it("emits sessionChanged for stable frontend tab metadata patches", async () => {
    const { state, api } = await makeFixture();
    state.tabs.set("live", fakeTabRecord() as never);
    state.frontendState.set("/tabs", [
      {
        id: "live",
        label: "Renamed",
        kind: "agent",
        cwd: "/repo",
        model: "openai/gpt-test",
        active: true,
      },
    ]);
    const calls: unknown[] = [];
    api.sessions.on("sessionChanged", (payload) => calls.push(payload));

    handleMirroredTabsChanged(
      state,
      [
        {
          id: "live",
          label: "Live",
          kind: "agent",
          cwd: "/repo",
          model: "openai/gpt-test",
          active: true,
        },
      ],
      [
        {
          id: "live",
          label: "Renamed",
          kind: "agent",
          cwd: "/repo",
          model: "openai/gpt-test",
          active: true,
        },
      ],
    );
    await Promise.resolve();

    expect(calls).toEqual([
      expect.objectContaining({
        session: expect.objectContaining({ id: "live", label: "Renamed" }),
      }),
    ]);
  });

  it("registers project-scoped subscriptions for project unload cleanup", async () => {
    const { state, api } = await makeFixture();
    state.currentExtensionLoadScope = "project";
    const handler = () => {};

    const off = api.sessions.on("messageAppended", handler);

    expect(
      state.sessionEventHandlers.get("messageAppended")?.has(handler),
    ).toBe(true);
    expect(state.projectExtensionTeardowns).toHaveLength(1);
    state.projectExtensionTeardowns[0]?.();
    expect(
      state.sessionEventHandlers.get("messageAppended")?.has(handler),
    ).toBe(false);
    off();
  });

  it("formats a markdown transcript", async () => {
    const { state, api } = await makeFixture();
    state.tabs.set(
      "live",
      fakeTabRecord([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi back" },
      ]) as never,
    );

    await expect(api.sessions.getTranscript("live")).resolves.toBe(
      "## User\n\nhello\n\n## Agent\n\nhi back",
    );
  });
});
