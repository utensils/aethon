import { describe, expect, it } from "vitest";
import type { AethonAgentState } from "../state";
import { VoiceBrain, type BrainSession } from "./brain";
import { VOICE_BRAIN_PREAMBLE } from "./prompt";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

type SentMessage = Record<string, unknown>;

/** Deterministic BrainSession: `respond` scripts what the model "does" when
 *  prompted (emit deltas, call tools, hang, throw). */
class FakeSession implements BrainSession {
  promptCalls: string[] = [];
  aborted = 0;
  disposed = 0;
  respond:
    | ((prompt: string, session: FakeSession) => Promise<void> | void)
    | undefined;
  private listener: ((ev: { type: string } & Record<string, unknown>) => void)
    | undefined;
  private hangResolve: (() => void) | undefined;

  subscribe(
    listener: (ev: { type: string } & Record<string, unknown>) => void,
  ): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  async prompt(text: string): Promise<void> {
    this.promptCalls.push(text);
    if (this.respond) {
      await this.respond(text, this);
      return;
    }
    // Default: hang until abort.
    await new Promise<void>((resolve) => {
      this.hangResolve = resolve;
    });
  }

  abort(): Promise<void> {
    this.aborted += 1;
    this.hangResolve?.();
    this.hangResolve = undefined;
    return Promise.resolve();
  }

  dispose(): void {
    this.disposed += 1;
  }

  emitText(delta: string): void {
    this.listener?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta },
    });
  }

  emitEnd(messages: unknown[] = []): void {
    this.listener?.({ type: "agent_end", messages });
  }
}

function makeState(): AethonAgentState {
  return { tabs: new Map() } as unknown as AethonAgentState;
}

function makeBrain(session: FakeSession) {
  const sent: SentMessage[] = [];
  const startCalls: Record<string, unknown>[] = [];
  let capturedTools: ToolDefinition[] = [];
  const brain = new VoiceBrain(
    makeState(),
    {
      send: (obj) => sent.push(obj),
      startTask: (input) => {
        startCalls.push(input);
        return Promise.resolve({ ok: true, data: { tabId: "tab-7" } });
      },
    },
    (options) => {
      capturedTools = options.customTools;
      return Promise.resolve(session);
    },
  );
  return {
    brain,
    sent,
    startCalls,
    tools: () => capturedTools,
  };
}

async function until(
  condition: () => boolean,
  what: string,
  ms = 2_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const ofType = (sent: SentMessage[], type: string) =>
  sent.filter((message) => message.type === type);

describe("VoiceBrain turns", () => {
  it("streams deltas and ends with the accumulated reply", async () => {
    const session = new FakeSession();
    session.respond = (_prompt, s) => {
      s.emitText("Sure, ");
      s.emitText("starting now.");
      s.emitEnd();
    };
    const { brain, sent } = makeBrain(session);

    brain.handleTurn({ type: "voice_turn", text: "fix the tests", context: {} });
    await until(() => ofType(sent, "voice_brain_end").length === 1, "end");

    expect(ofType(sent, "voice_brain_delta").map((m) => m.text)).toEqual([
      "Sure, ",
      "starting now.",
    ]);
    expect(ofType(sent, "voice_brain_end")[0]?.text).toBe(
      "Sure, starting now.",
    );
    expect(ofType(sent, "voice_brain_error")).toHaveLength(0);
  });

  it("sends the preamble on the first prompt only", async () => {
    const session = new FakeSession();
    session.respond = (_prompt, s) => {
      s.emitText("ok");
      s.emitEnd();
    };
    const { brain, sent } = makeBrain(session);

    brain.handleTurn({ type: "voice_turn", text: "one", context: {} });
    await until(() => ofType(sent, "voice_brain_end").length === 1, "end 1");
    brain.handleTurn({ type: "voice_turn", text: "two", context: {} });
    await until(() => ofType(sent, "voice_brain_end").length === 2, "end 2");

    expect(session.promptCalls[0]).toContain(VOICE_BRAIN_PREAMBLE);
    expect(session.promptCalls[1]).not.toContain(VOICE_BRAIN_PREAMBLE);
  });

  it("reports dispatches made during the turn on voice_brain_end", async () => {
    const session = new FakeSession();
    const h = makeBrain(session);
    session.respond = async (_prompt, s) => {
      const dispatch = h
        .tools()
        .find((tool) => tool.name === "dispatch_task") as unknown as {
        execute: (...args: unknown[]) => Promise<unknown>;
      };
      await dispatch.execute(
        "call-1",
        { prompt: "do the thing", label: "the thing" },
        undefined,
        undefined,
      );
      s.emitText("On it.");
      s.emitEnd();
    };

    h.brain.handleTurn({
      type: "voice_turn",
      text: "please do the thing",
      context: { projectPath: "/repo", defaultModel: "anthropic/claude-x" },
    });
    await until(() => ofType(h.sent, "voice_brain_end").length === 1, "end");

    expect(h.startCalls).toHaveLength(1);
    expect(ofType(h.sent, "voice_brain_end")[0]?.dispatched).toEqual({
      tabId: "tab-7",
      label: "the thing",
    });
  });

  it("supersedes an in-flight turn without a stale terminal event", async () => {
    const session = new FakeSession();
    const { brain, sent } = makeBrain(session);

    // First turn hangs (default respond) until superseded.
    brain.handleTurn({ type: "voice_turn", text: "first", context: {} });
    await until(() => session.promptCalls.length === 1, "first prompt");

    session.respond = (_prompt, s) => {
      s.emitText("second reply");
      s.emitEnd();
    };
    brain.handleTurn({ type: "voice_turn", text: "second", context: {} });
    await until(() => ofType(sent, "voice_brain_end").length === 1, "end");

    expect(session.aborted).toBeGreaterThanOrEqual(1);
    expect(ofType(sent, "voice_brain_end")).toHaveLength(1);
    expect(ofType(sent, "voice_brain_end")[0]?.text).toBe("second reply");
    expect(ofType(sent, "voice_brain_error")).toHaveLength(0);
  });

  it("emits voice_brain_error when the prompt rejects and retries the preamble", async () => {
    const session = new FakeSession();
    let failures = 0;
    session.respond = (_prompt, s) => {
      if (failures === 0) {
        failures += 1;
        throw new Error("provider exploded");
      }
      s.emitText("recovered");
      s.emitEnd();
    };
    const { brain, sent } = makeBrain(session);

    brain.handleTurn({ type: "voice_turn", text: "hello", context: {} });
    await until(() => ofType(sent, "voice_brain_error").length === 1, "error");
    expect(ofType(sent, "voice_brain_error")[0]?.message).toContain(
      "provider exploded",
    );

    brain.handleTurn({ type: "voice_turn", text: "again", context: {} });
    await until(() => ofType(sent, "voice_brain_end").length === 1, "recovery");
    // The failed first prompt didn't burn the preamble.
    expect(session.promptCalls[1]).toContain(VOICE_BRAIN_PREAMBLE);
  });

  it("falls back to agent_end text when no deltas streamed", async () => {
    const session = new FakeSession();
    session.respond = (_prompt, s) => {
      s.emitEnd([
        { role: "assistant", content: [{ type: "text", text: "from end" }] },
      ]);
    };
    const { brain, sent } = makeBrain(session);
    brain.handleTurn({ type: "voice_turn", text: "hi", context: {} });
    await until(() => ofType(sent, "voice_brain_end").length === 1, "end");
    expect(ofType(sent, "voice_brain_end")[0]?.text).toBe("from end");
  });
});

describe("VoiceBrain task events", () => {
  it("prompts a summary with the known label and marks the task done", async () => {
    const session = new FakeSession();
    const h = makeBrain(session);
    // Seed a dispatch first.
    session.respond = async (_prompt, s) => {
      const dispatch = h
        .tools()
        .find((tool) => tool.name === "dispatch_task") as unknown as {
        execute: (...args: unknown[]) => Promise<unknown>;
      };
      await dispatch.execute(
        "call-1",
        { prompt: "fix flaky test" },
        undefined,
        undefined,
      );
      s.emitText("Dispatched.");
      s.emitEnd();
    };
    h.brain.handleTurn({
      type: "voice_turn",
      text: "fix the flaky test",
      context: { projectPath: "/repo", defaultModel: "m/x" },
    });
    await until(() => ofType(h.sent, "voice_brain_end").length === 1, "turn");

    session.respond = (_prompt, s) => {
      s.emitText("All done, tests are green.");
      s.emitEnd();
    };
    h.brain.handleTaskEvent({
      type: "voice_task_event",
      taskTabId: "tab-7",
      status: "completed",
      finalText: "Fixed by adding waitFor. All 42 tests pass.",
    });
    await until(
      () => ofType(h.sent, "voice_brain_end").length === 2,
      "summary",
    );

    const summaryPrompt = session.promptCalls[1] ?? "";
    expect(summaryPrompt).toContain("system note");
    expect(summaryPrompt).toContain("fix flaky test");
    expect(summaryPrompt).toContain("All 42 tests pass.");
    expect(h.brain.isDispatchedTab("tab-7")).toBe(true);
  });
});
