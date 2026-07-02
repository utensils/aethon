/**
 * The voice brain — a persistent pi session that converses with the user by
 * voice, dispatches real work to work-agent tabs, and summarizes results
 * back into speakable prose.
 *
 * One in-memory session per bridge process (global bridge only — the Rust
 * router never sends voice_* messages to tab workers). The session persists
 * across turns so announcements stay grounded in conversation context
 * ("that flaky-test fix you asked for is done"). Prompts are fire-and-forget
 * from the dispatcher (mirroring chat.ts) — deltas stream out as
 * `voice_brain_delta`, and each turn terminates with exactly one
 * `voice_brain_end` or `voice_brain_error`.
 */

import {
  SessionManager,
  createAgentSession,
} from "@mariozechner/pi-coding-agent";
import type { AethonAgentState } from "../state";
import { extractAgentEndError } from "../agent-errors";
import { logger } from "../logger";
import { resolveModelServices } from "../subagents/inline-runner";
import {
  extractLastAssistantText,
  handleSubagentEvent,
} from "../subagents/progress-events";
import { withTimeout } from "../subagents/timeout";
import {
  buildTaskEventPrompt,
  buildTurnPrompt,
} from "./prompt";
import type {
  VoiceTaskEventMessage,
  VoiceTurnContext,
  VoiceTurnMessage,
} from "./protocol";
import {
  buildVoiceBrainTools,
  type DispatchedTask,
} from "./tools";

/** A spoken reply should come fast; a brain turn that runs this long is
 *  wedged, not thinking. */
const VOICE_BRAIN_TIMEOUT_MS = 120_000;

export interface VoiceBrainDeps {
  send: (obj: Record<string, unknown>) => void;
  /** `aethon.tasks.start`-shaped launcher (the real one comes from
   *  buildTasksApi; tests inject a fake). */
  startTask: (input: {
    projectPath: string;
    prompt: string;
    model: string;
    activate: boolean;
    label?: string;
  }) => Promise<{ ok: boolean; error?: string; data?: unknown }>;
  /** Steer an existing task tab (`aethon.tasks.sendFollowup`). */
  sendFollowup: (input: {
    tabId: string;
    prompt: string;
  }) => Promise<{ ok: boolean; error?: string; data?: unknown }>;
}

/** Structural slice of pi's AgentSession the brain needs — keeps tests to a
 *  four-method fake. */
export interface BrainSession {
  subscribe(
    listener: (event: { type: string } & Record<string, unknown>) => void,
  ): () => void;
  prompt(text: string): Promise<unknown>;
  abort(): Promise<unknown>;
  dispose(): void;
}

export type BrainSessionFactory = (options: {
  modelId: string | undefined;
  cwd: string;
  customTools: ReturnType<typeof buildVoiceBrainTools>;
}) => Promise<BrainSession>;

export class VoiceBrain {
  private readonly state: AethonAgentState;
  private readonly deps: VoiceBrainDeps;
  private readonly createSession: BrainSessionFactory;

  private session: BrainSession | undefined;
  private sessionModelKey: string | undefined;
  private unsubscribe: (() => void) | undefined;
  private context: VoiceTurnContext = {};
  private readonly dispatched = new Map<string, DispatchedTask>();

  /** Monotonic turn id; stale turns must not emit terminal events. */
  private generation = 0;
  private turnActive = false;
  /** Completion/error announcements that arrived mid-turn, delivered once
   *  the active turn settles (never allowed to supersede a user exchange). */
  private deferredTaskPrompts: string[] = [];
  private firstPrompt = true;
  private replyText = "";
  private endError: string | undefined;
  private lastDispatched: { tabId: string; label: string } | undefined;

  constructor(
    state: AethonAgentState,
    deps: VoiceBrainDeps,
    createSession?: BrainSessionFactory,
  ) {
    this.state = state;
    this.deps = deps;
    this.createSession =
      createSession ?? ((options) => this.defaultCreateSession(options));
  }

  /** User finished a spoken turn. Fire-and-forget (dispatcher must not block
   *  on a whole model turn — mirrors handleChat). */
  handleTurn(msg: VoiceTurnMessage): void {
    this.context = { ...this.context, ...msg.context };
    void this.runPrompt(
      buildTurnPrompt(msg.text, this.context, this.firstPrompt),
    );
  }

  /** A dispatched work agent finished a turn — or, for `progress` events,
   *  is still mid-task (those must not flip the tracked status).
   *
   *  A task event must never SUPERSEDE the user's in-flight exchange the way
   *  a fresh voice turn does — a background task finishing mid-answer would
   *  silently cancel the answer. While a turn is active the announcement is
   *  parked and delivered after the current turn settles (progress digests
   *  are dropped instead — they're periodic, the next tick re-reports). */
  handleTaskEvent(msg: VoiceTaskEventMessage): void {
    const known = this.dispatched.get(msg.taskTabId);
    if (known && msg.status !== "progress") {
      known.status = msg.status === "error" ? "error" : "completed";
    }
    const prompt = buildTaskEventPrompt({
      ...msg,
      ...(msg.label ? {} : known?.label ? { label: known.label } : {}),
    });
    if (this.turnActive) {
      if (msg.status !== "progress") this.deferredTaskPrompts.push(prompt);
      return;
    }
    void this.runPrompt(prompt);
  }

  /** Barge-in: kill the in-flight brain turn (its terminal event is
   *  suppressed by the generation guard). */
  async abort(): Promise<void> {
    if (!this.session || !this.turnActive) return;
    this.generation += 1;
    this.turnActive = false;
    try {
      await this.session.abort();
    } catch (err) {
      logger
        .scope("voice-brain")
        .warn(
          `abort failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
  }

  /** Drop the session (conversation ended / model changed via settings). */
  async reset(): Promise<void> {
    await this.abort();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    try {
      this.session?.dispose();
    } catch {
      /* ignore */
    }
    this.session = undefined;
    this.sessionModelKey = undefined;
    this.dispatched.clear();
    this.deferredTaskPrompts = [];
    this.firstPrompt = true;
  }

  /** Is this tab one of ours? (Frontend also tracks this; defensive.) */
  isDispatchedTab(tabId: string): boolean {
    return this.dispatched.has(tabId);
  }

  private async runPrompt(prompt: string): Promise<void> {
    if (this.turnActive) {
      // Supersede: the newest input wins (matches how the conversation
      // engine supersedes speech).
      await this.abort();
    }
    const generation = ++this.generation;

    let session: BrainSession;
    try {
      session = await this.ensureSession();
    } catch (err) {
      this.emitError(err, generation);
      return;
    }

    this.turnActive = true;
    this.replyText = "";
    this.endError = undefined;
    this.lastDispatched = undefined;
    const includedPreamble = this.firstPrompt;
    this.firstPrompt = false;

    try {
      await withTimeout(session.prompt(prompt), VOICE_BRAIN_TIMEOUT_MS, () => {
        void session.abort();
      });
      if (generation !== this.generation) return;
      if (this.endError) {
        this.emitError(this.endError, generation);
        return;
      }
      this.deps.send({
        type: "voice_brain_end",
        text: this.replyText.trim(),
        ...(this.lastDispatched ? { dispatched: this.lastDispatched } : {}),
      });
    } catch (err) {
      // A failed first prompt must not permanently swallow the preamble.
      if (includedPreamble) this.firstPrompt = true;
      this.emitError(err, generation);
    } finally {
      if (generation === this.generation) {
        this.turnActive = false;
        this.drainDeferredTaskPrompts();
      }
    }
  }

  /** Deliver one parked task announcement after the active turn settled.
   *  One at a time: each delivery is itself a turn whose completion drains
   *  the next, so announcements queue instead of superseding each other. */
  private drainDeferredTaskPrompts(): void {
    const next = this.deferredTaskPrompts.shift();
    if (next === undefined) return;
    queueMicrotask(() => {
      if (this.turnActive) {
        // A user turn slipped in between settle and drain — re-park.
        this.deferredTaskPrompts.unshift(next);
        return;
      }
      void this.runPrompt(next);
    });
  }

  private emitError(err: unknown, generation: number): void {
    if (generation !== this.generation) return;
    const message = err instanceof Error ? err.message : String(err);
    logger.scope("voice-brain").warn(`turn failed: ${message}`);
    this.deps.send({ type: "voice_brain_error", message });
  }

  private async ensureSession(): Promise<BrainSession> {
    const modelKey = this.context.brainModel?.trim() ?? "";
    if (this.session && this.sessionModelKey === modelKey) {
      return this.session;
    }
    // Model changed (or first turn): rebuild. Conversation context is lost on
    // a model switch — acceptable; switching models mid-conversation is rare.
    await this.reset();

    const session = await this.createSession({
      modelId: modelKey || undefined,
      cwd: this.context.projectPath ?? process.cwd(),
      customTools: buildVoiceBrainTools({
        startTask: (input) => this.deps.startTask(input),
        sendFollowup: (input) => this.deps.sendFollowup(input),
        getContext: () => this.context,
        onDispatched: (task) => {
          this.dispatched.set(task.tabId, task);
          this.lastDispatched = { tabId: task.tabId, label: task.label };
        },
        listTasks: () => [...this.dispatched.values()],
        countRunningTabs: () =>
          [...this.state.tabs.values()].filter((tab) => tab.promptInFlight)
            .length,
      }),
    });

    this.unsubscribe = session.subscribe((event) => {
      handleSubagentEvent(event, {
        onText: (delta) => {
          this.replyText += delta;
          this.deps.send({ type: "voice_brain_delta", text: delta });
        },
        onThinking: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onEnd: (messages) => {
          this.endError = extractAgentEndError(messages);
          if (!this.replyText.trim()) {
            this.replyText = extractLastAssistantText(messages);
          }
        },
      });
    });
    this.session = session;
    this.sessionModelKey = modelKey;
    return session;
  }

  private async defaultCreateSession(options: {
    modelId: string | undefined;
    cwd: string;
    customTools: ReturnType<typeof buildVoiceBrainTools>;
  }): Promise<BrainSession> {
    const resolved = resolveModelServices(
      this.state,
      this.context.activeTabId ?? "default",
      options.modelId,
    );
    if (!resolved) {
      throw new Error(
        `voice brain model "${options.modelId}" is not available — check that its provider is signed in`,
      );
    }
    const { session } = await createAgentSession({
      ...(resolved.model ? { model: resolved.model } : {}),
      authStorage: resolved.authStorage,
      modelRegistry: resolved.modelRegistry,
      settingsManager: this.state.settingsManager,
      sessionManager: SessionManager.inMemory(),
      resourceLoader: this.state.resourceLoader,
      cwd: options.cwd,
      noTools: "builtin",
      customTools: options.customTools,
    });
    return session;
  }
}

/** Lazily create the singleton brain on first voice message. */
export function ensureVoiceBrain(
  state: AethonAgentState,
  deps: VoiceBrainDeps,
): VoiceBrain {
  state.voiceBrain ??= new VoiceBrain(state, deps);
  return state.voiceBrain;
}
