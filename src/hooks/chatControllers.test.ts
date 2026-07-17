import { describe, expect, it } from "vitest";

import { makeEmptyTab, type Tab } from "../types/tab";
import type { ChatMessage } from "../types/a2ui";
import { withQueue, queueOf } from "./chatQueue";
import { buildSendMessageRequest } from "./chatTransport";
import { parseModelIdWithThinking } from "./chatModelSelection";
import { diagnosticMatchesTab } from "./stopPrompt";
import { buildChatMarkdown } from "./chatExport";

describe("chat queue helpers", () => {
  it("keeps queuedMessages and queueCount in sync", () => {
    const tab = makeEmptyTab("tab-1", "Tab 1");
    const queued = [
      { id: "q1", content: "one", attachments: [] },
      { id: "q2", content: "two", attachments: [] },
    ];

    const next = withQueue(tab, queued);

    expect(next.queuedMessages).toEqual(queued);
    expect(next.queueCount).toBe(2);
    const legacyTab = {
      ...(tab as unknown as Record<string, unknown>),
    };
    delete legacyTab.queuedMessages;
    expect(queueOf(legacyTab as unknown as Tab)).toEqual([]);
  });
});

describe("chat transport payload builder", () => {
  it("prefers tab-scoped transport fields over root fallbacks", () => {
    const attachment = {
      id: "img-1",
      kind: "image" as const,
      path: "/tmp/image.png",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 123,
    };
    const tab: Tab = {
      ...makeEmptyTab("tab-1", "Tab 1"),
      cwd: "/repo/project",
      model: "openai-codex/gpt-5.5",
      thinkingLevel: "high",
      planMode: true,
      hardEnforceProjectRoot: true,
      authProfileId: "openai-secondary",
    };

    expect(
      buildSendMessageRequest({
        message: "hidden bridge body",
        tabId: "tab-1",
        mode: "steer",
        attachments: [attachment],
        targetTab: tab,
        state: {
          model: "anthropic/claude-opus-4-7",
          thinkingLevel: "low",
        },
        suppressUserSessionEvent: true,
        controlRequestId: "ctrl-1",
      }),
    ).toEqual({
      message: "hidden bridge body",
      tabId: "tab-1",
      mode: "steer",
      planMode: true,
      attachments: [attachment],
      cwd: "/repo/project",
      model: "openai-codex/gpt-5.5",
      thinkingLevel: "high",
      suppressUserSessionEvent: true,
      hardEnforce: true,
      authProfileId: "openai-secondary",
      controlRequestId: "ctrl-1",
    });
  });

  it("falls back to root model/reasoning and omits empty optional fields", () => {
    expect(
      buildSendMessageRequest({
        message: "hello",
        tabId: "tab-1",
        mode: "normal",
        attachments: [],
        targetTab: makeEmptyTab("tab-1", "Tab 1"),
        state: { model: "openai/gpt-5.5", thinkingLevel: "medium" },
        suppressUserSessionEvent: false,
      }),
    ).toEqual({
      message: "hello",
      tabId: "tab-1",
      mode: "normal",
      planMode: false,
      model: "openai/gpt-5.5",
      thinkingLevel: "medium",
      suppressUserSessionEvent: false,
    });
  });
});

describe("chat model selection helpers", () => {
  it("extracts Codex reasoning suffixes without touching other colon model ids", () => {
    expect(parseModelIdWithThinking("openai-codex/gpt-5.5:high")).toEqual({
      modelId: "openai-codex/gpt-5.5",
      thinkingLevel: "high",
    });
    expect(parseModelIdWithThinking("openai-codex/gpt-5.6-sol:ultra")).toEqual({
      modelId: "openai-codex/gpt-5.6-sol",
      thinkingLevel: "ultra",
    });
    expect(parseModelIdWithThinking("ollama/foo:high")).toEqual({
      modelId: "ollama/foo:high",
    });
  });
});

describe("stop prompt diagnostics", () => {
  it("matches legacy and tab-scoped diagnostic keys", () => {
    expect(diagnosticMatchesTab({ key: "tab:abc" }, "abc")).toBe(true);
    expect(diagnosticMatchesTab({ key: "other", tab_id: "abc" }, "abc")).toBe(true);
    expect(diagnosticMatchesTab({ key: "other", tabId: "abc" }, "abc")).toBe(true);
    expect(diagnosticMatchesTab({ key: "__global__" }, "default")).toBe(
      true,
    );
    expect(diagnosticMatchesTab({ key: "__global__" }, "abc")).toBe(false);
  });
});

describe("chat export markdown", () => {
  it("formats messages and thinking blocks deterministically", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", text: "hello\r\nthere" },
      { id: "a1", role: "agent", text: "done", thinking: "plan\r\nsteps" },
    ];

    expect(
      buildChatMarkdown("Tab 1", messages, new Date("2026-01-02T03:04:05Z")),
    ).toBe(
      "# Tab 1\n\n" +
        "_Exported from Aethon · 2026-01-02T03:04:05.000Z_\n\n" +
        "### user\n\nhello\nthere\n\n" +
        "### agent\n\n<thinking>\nplan\nsteps\n</thinking>\n\ndone\n",
    );
  });
});
