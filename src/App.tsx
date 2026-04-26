import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import A2UIRenderer from "./components/A2UIRenderer";
import { SkillRegistry, SkillRegistryProvider } from "./skills/registry";
import { defaultLayoutSkill } from "./skills/default-layout";
import type { A2UIPayload, ChatMessage } from "./types/a2ui";
import type { A2UISkill } from "./skills/types";
import {
  buildBuiltinSlashCommands,
  parseSlashCommand,
  type SlashCommand,
  type SlashCommandContext,
} from "./slashCommands";

// The default-layout skill ships a layout — that's the boot payload.
const BOOT_LAYOUT: A2UIPayload = defaultLayoutSkill.layout!;

interface ModelDescriptor {
  id: string;
  label: string;
  provider: string;
}

export default function App() {
  // The registry is created once and shared across the app via context.
  // Skills register their components/layouts here; the renderer resolves
  // unknown component types through it.
  const registryRef = useRef<SkillRegistry | null>(null);
  if (!registryRef.current) {
    registryRef.current = new SkillRegistry();
    registryRef.current.register(defaultLayoutSkill);
  }
  const registry = registryRef.current;

  // The layout's state IS the app state. Single source of truth, addressed by
  // JSON Pointer from the layout payload.
  const [state, setState] = useState<Record<string, unknown>>(
    () => ({ ...(BOOT_LAYOUT.state ?? {}) }),
  );

  // Active layout payload — replaceable. Skills can swap the chrome wholesale
  // by calling window.aethon.setLayout(payload), or register a new skill via
  // window.aethon.registerSkill(skill) and switch to its layout.
  const [layout, setLayout] = useState<A2UIPayload>(BOOT_LAYOUT);

  // Fallback id for text bubbles when the bridge doesn't supply one. The
  // bridge now sends a stable `messageId` per pi assistant message so text
  // deltas after a tool card still land in the original bubble; this ref
  // only matters for old-bridge / legacy `response_delta` payloads.
  const activeResponseIdRef = useRef<string | null>(null);

  // Theme — persisted to localStorage so the choice survives reloads.
  // Default: whatever the OS prefers; fall back to dark.
  useEffect(() => {
    const saved = localStorage.getItem("aethon-theme");
    const initial =
      saved === "light" || saved === "dark"
        ? saved
        : window.matchMedia?.("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark";
    document.documentElement.dataset.theme = initial;
  }, []);

  function setTheme(theme: "dark" | "light") {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("aethon-theme", theme);
    } catch {
      /* localStorage may be denied in sandboxed webviews */
    }
  }

  // Persistent chat history — restore on mount, write on each change. Cap at
  // 200 messages and 8KB per text field so a single huge tool result can't
  // blow out localStorage's quota. Disk persistence (~/.aethon/state.json)
  // arrives with the broader Aethon-config work.
  const PERSIST_KEY = "aethon-messages";
  const MAX_MESSAGES = 200;
  const MAX_TEXT_BYTES = 8 * 1024;

  // Replace `image` component data URLs with a placeholder so persisted history
  // doesn't blow past the localStorage quota. The in-memory message keeps the
  // full data URL — only the persisted copy is slimmed.
  function stripImageDataUrls(component: unknown): unknown {
    if (!component || typeof component !== "object") return component;
    const c = component as {
      type?: string;
      props?: Record<string, unknown>;
      children?: unknown[];
    };
    let next = c;
    if (
      c.type === "image" &&
      typeof c.props?.src === "string" &&
      (c.props.src as string).startsWith("data:")
    ) {
      next = { ...c, props: { ...c.props, src: "", caption: "[image dropped from history]" } };
    }
    if (Array.isArray(c.children) && c.children.length > 0) {
      next = { ...next, children: c.children.map(stripImageDataUrls) };
    }
    return next;
  }

  function trimMessage(m: ChatMessage): ChatMessage {
    let out = m;
    if (m.text && m.text.length > MAX_TEXT_BYTES) {
      out = { ...out, text: m.text.slice(0, MAX_TEXT_BYTES - 1) + "…" };
    }
    if (m.a2ui && Array.isArray(m.a2ui.components)) {
      out = {
        ...out,
        a2ui: { ...m.a2ui, components: m.a2ui.components.map(stripImageDataUrls) as never },
      };
    }
    return out;
  }

  // Restore on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        setState((prev) => ({ ...prev, messages: parsed }));
      }
    } catch {
      /* corrupt / denied / quota — ignore */
    }
  }, []);

  // Debounced write on messages change.
  const persistTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const messages = (state.messages as ChatMessage[]) ?? [];
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      try {
        const slim = messages.slice(-MAX_MESSAGES).map(trimMessage);
        localStorage.setItem(PERSIST_KEY, JSON.stringify(slim));
      } catch {
        /* quota — surface later if we add a disk fallback */
      }
    }, 400);
    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
      }
    };
  }, [state.messages]);

  function clearChat() {
    setState((prev) => ({ ...prev, messages: [] }));
    try {
      localStorage.removeItem(PERSIST_KEY);
    } catch {
      /* ignore */
    }
  }

  // Latest state, kept in a ref so the aethon-debug skill can read it via
  // `window.__AETHON_STATE__()` without going through React's state lifecycle.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const api = {
      setLayout,
      resetLayout: () => setLayout(BOOT_LAYOUT),
      getLayout: () => layout,
      registerSkill: (skill: A2UISkill) => {
        registry.register(skill);
        if (skill.layout) setLayout(skill.layout);
      },
      listSkills: () => registry.list().map((s) => s.name),
    };
    (window as unknown as { aethon: typeof api }).aethon = api;

    if (import.meta.env.DEV) {
      const win = window as unknown as {
        __AETHON_STATE__: () => Record<string, unknown>;
        __AETHON_REGISTRY__: SkillRegistry;
        __AETHON_SET_STATE__: (next: Record<string, unknown>) => void;
      };
      win.__AETHON_STATE__ = () => stateRef.current;
      win.__AETHON_REGISTRY__ = registry;
      win.__AETHON_SET_STATE__ = setState;
    }
  }, [layout, registry]);

  useEffect(() => {
    (async () => {
      try {
        await invoke("start_agent");
        // Request a fresh `ready` event in case the agent process was already
        // running before this React tree mounted (e.g. after a webview
        // hot-reload). Newly-spawned agents emit ready unconditionally, so
        // the duplicate is harmless.
        await invoke("agent_command", {
          payload: JSON.stringify({ type: "report" }),
        });
      } catch (err) {
        appendMessage({
          id: crypto.randomUUID(),
          role: "agent",
          text: `Failed to start agent: ${err}`,
        });
        setStatusFlags({ status: "error" });
      }
    })();

    const unlistenResponse = listen<string>("agent-response", (event) => {
      try {
        const data = JSON.parse(event.payload);
        handleAgentMessage(data);
      } catch {
        // Non-JSON line from the bridge — ignore.
      }
    });

    const unlistenReload = listen<string>("agent-reloaded", () => {
      activeResponseIdRef.current = null;
      setStatusFlags({ waiting: false, status: "agent reloaded" });
      // Re-prime the agent so we get a fresh `ready` event with the new code.
      invoke("start_agent").catch(() => {
        /* surfaced by the next user action */
      });
    });

    // Mirror agent stderr into the chat as a system message — when the bridge
    // dies on startup this is the only signal we have.
    const unlistenStderr = listen<string>("agent-stderr", (event) => {
      const text = event.payload?.toString().trim();
      if (!text) return;
      // Cap noise — only surface lines that look like errors. Bun and pi-ai
      // emit informational stderr (e.g. cache hits) we can ignore.
      if (/error|throw|fatal|cannot|fail|exception/i.test(text)) {
        appendMessage({
          id: crypto.randomUUID(),
          role: "system",
          text: `[agent stderr] ${text}`,
        });
      }
      // Always log to webview console for debug skill access.
      console.warn("[agent stderr]", text);
    });

    return () => {
      unlistenResponse.then((fn) => fn());
      unlistenReload.then((fn) => fn());
      unlistenStderr.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleAgentMessage(data: { type?: string; [k: string]: unknown }) {
    switch (data.type) {
      case "ready": {
        const model = (data.model as string) || "";
        const models = (data.models as ModelDescriptor[]) ?? [];
        setState((prev) => ({
          ...prev,
          model,
          status: "ready",
          connection: "connected",
          sidebar: {
            ...((prev.sidebar as Record<string, unknown>) ?? {}),
            models: models.map((m) => ({
              id: m.id,
              label: m.label,
              active: m.id === model,
            })),
          },
        }));
        break;
      }
      case "model_changed": {
        const model = (data.model as string) || "";
        setState((prev) => {
          const sidebar = (prev.sidebar as Record<string, unknown>) ?? {};
          const items =
            (sidebar.models as { id: string; label: string }[] | undefined) ?? [];
          return {
            ...prev,
            model,
            status: `switched to ${model}`,
            sidebar: {
              ...sidebar,
              models: items.map((m) => ({
                id: m.id,
                label: m.label,
                active: m.id === model,
              })),
            },
          };
        });
        break;
      }
      case "response_delta": {
        const delta = (data.content as string) ?? "";
        if (!delta) break;
        const messageId = (data.messageId as string) || undefined;
        appendOrAmendAgentText(delta, messageId);
        break;
      }
      case "response_end": {
        activeResponseIdRef.current = null;
        setStatusFlags({ waiting: false, status: "ready" });
        break;
      }
      case "error": {
        const message = (data.message as string) ?? "unknown error";
        activeResponseIdRef.current = null;
        appendMessage({
          id: crypto.randomUUID(),
          role: "agent",
          text: `Error: ${message}`,
        });
        setStatusFlags({ waiting: false, status: "error" });
        break;
      }
      // Legacy single-shot response (kept so old bridge builds still render).
      case "response": {
        const content = (data.content as string) ?? "";
        if (content) {
          appendMessage({ id: crypto.randomUUID(), role: "agent", text: content });
        }
        if (data.done) setStatusFlags({ waiting: false, status: "ready" });
        break;
      }
      case "a2ui": {
        const payload = data.payload as A2UIPayload | undefined;
        const id = (data.id as string) || crypto.randomUUID();
        if (payload) {
          appendMessage({ id, role: "agent", a2ui: payload });
        }
        if (data.done) setStatusFlags({ waiting: false, status: "ready" });
        break;
      }
    }
  }

  // Append a chat message, or replace in place if a message with the same
  // id already exists. This is what lets the bridge stream "running…" tool
  // cards and update them with the final result without duplicating bubbles.
  function appendMessage(msg: ChatMessage) {
    setState((prev) => {
      const messages = [...((prev.messages as ChatMessage[]) ?? [])];
      const idx = messages.findIndex((m) => m.id === msg.id);
      if (idx >= 0) {
        messages[idx] = msg;
      } else {
        messages.push(msg);
      }
      return { ...prev, messages };
    });
  }

  // Append a streaming text delta to its bubble. When the bridge supplies a
  // stable `messageId` (one per pi assistant message), look up the bubble by
  // id anywhere in the array — this keeps text from a single agent message in
  // one bubble even after tool cards land between deltas. Without a messageId
  // (legacy bridges), fall back to the previous "is it the last message?"
  // behavior tracked via activeResponseIdRef.
  function appendOrAmendAgentText(delta: string, messageId?: string) {
    setState((prev) => {
      const messages = [...((prev.messages as ChatMessage[]) ?? [])];

      if (messageId) {
        const idx = messages.findIndex((m) => m.id === messageId);
        if (idx >= 0) {
          messages[idx] = {
            ...messages[idx],
            text: (messages[idx].text ?? "") + delta,
          };
        } else {
          messages.push({ id: messageId, role: "agent", text: delta });
        }
        activeResponseIdRef.current = messageId;
        return { ...prev, messages };
      }

      const activeId = activeResponseIdRef.current;
      const last = messages[messages.length - 1];
      if (activeId && last && last.id === activeId && last.role === "agent") {
        messages[messages.length - 1] = {
          ...last,
          text: (last.text ?? "") + delta,
        };
      } else {
        const id = crypto.randomUUID();
        activeResponseIdRef.current = id;
        messages.push({ id, role: "agent", text: delta });
      }
      return { ...prev, messages };
    });
  }

  function setStatusFlags(
    flags: Partial<{ waiting: boolean; status: string; connection: string }>,
  ) {
    setState((prev) => ({ ...prev, ...flags }));
  }

  // Built once — handlers close over App-scope helpers via the ctx passed at
  // dispatch time, so the registry itself doesn't need state in scope.
  const slashCommandsRef = useRef<SlashCommand[]>(buildBuiltinSlashCommands());

  function appendSystem(text: string) {
    appendMessage({ id: crypto.randomUUID(), role: "system", text });
  }

  // Build the dispatch context fresh per invocation so handlers see latest
  // state (model list, skills) without re-creating the command registry.
  function slashContext(): SlashCommandContext {
    return {
      appendSystem,
      clearChat,
      setTheme,
      setModel,
      resetLayout: () => setLayout(BOOT_LAYOUT),
      listSkills: () => registry.list().map((s) => s.name),
      listModels: () => {
        const sidebar = (stateRef.current.sidebar as Record<string, unknown>) ?? {};
        return ((sidebar.models as { id: string; label: string; active?: boolean }[]) ?? []);
      },
      toggleTerminal: () =>
        setState((prev) => {
          const term = (prev.terminal as { open?: boolean }) ?? {};
          return { ...prev, terminal: { ...term, open: !term.open } };
        }),
    };
  }

  async function sendChat(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Client-side slash commands handle UI-only actions (clear, theme, etc.).
    // Unknown slash commands fall through to the agent so pi's own slash
    // command handling and any prompt-template / skill commands still reach
    // it. `//foo` escapes to force a literal `/foo` to be sent.
    const parsed = parseSlashCommand(trimmed);
    if (parsed) {
      const cmd = slashCommandsRef.current.find((c) => c.name === parsed.name);
      if (cmd) {
        appendMessage({ id: crypto.randomUUID(), role: "user", text: trimmed });
        setState((prev) => ({ ...prev, draft: "" }));
        try {
          await cmd.run(parsed.args, slashContext());
        } catch (err) {
          appendSystem(`Slash command \`/${parsed.name}\` failed: ${err}`);
        }
        return;
      }
      // Unknown — fall through to send_message. Pi's own command handling on
      // the agent side may pick it up; if not, the LLM sees the literal text.
    }

    const sendText = trimmed.startsWith("//") ? trimmed.slice(1) : trimmed;
    appendMessage({ id: crypto.randomUUID(), role: "user", text: sendText });
    setState((prev) => ({
      ...prev,
      draft: "",
      waiting: true,
      status: "thinking…",
      connection: "connected",
    }));

    try {
      await invoke("send_message", { message: sendText });
    } catch (err) {
      appendMessage({
        id: crypto.randomUUID(),
        role: "agent",
        text: `Connection error: ${err}`,
      });
      setStatusFlags({ waiting: false, status: "error" });
    }
  }

  async function setModel(id: string) {
    try {
      await invoke("agent_command", {
        payload: JSON.stringify({ type: "set_model", id }),
      });
    } catch (err) {
      appendMessage({
        id: crypto.randomUUID(),
        role: "agent",
        text: `Failed to switch model: ${err}`,
      });
    }
  }

  // Intercept events from layout-level components before they reach the agent.
  // The layout speaks A2UI, but a few interactions need to drive native APIs
  // (Tauri IPC for chat send, model picker) — this is where the renderer
  // hands off control.
  const onEvent = useMemo(
    () => async (component: { id: string }, eventType: string, data?: unknown) => {
      if (component.id === "chat-input" && eventType === "submit") {
        const value = (data as { value?: string } | undefined)?.value ?? "";
        await sendChat(value);
        return true;
      }
      if (component.id === "chat-input" && eventType === "change") {
        // Optimistic update already wrote /draft; nothing more to forward.
        return true;
      }
      if (component.id === "chat-input" && eventType === "cancel") {
        try {
          await invoke("agent_command", {
            payload: JSON.stringify({ type: "stop" }),
          });
          setStatusFlags({ status: "stopping…" });
        } catch (err) {
          appendMessage({
            id: crypto.randomUUID(),
            role: "agent",
            text: `Failed to stop: ${err}`,
          });
        }
        return true;
      }
      if (component.id === "sidebar" && eventType === "select") {
        const selected = data as { sectionId?: string; itemId?: string } | undefined;
        if (selected?.itemId === "toggle-terminal") {
          setState((prev) => {
            const term = (prev.terminal as { open?: boolean; output?: string }) ?? {};
            return { ...prev, terminal: { ...term, open: !term.open } };
          });
          return true;
        }
        if (selected?.itemId === "clear-chat") {
          clearChat();
          return true;
        }
        if (selected?.sectionId === "models" && selected.itemId) {
          await setModel(selected.itemId);
          return true;
        }
        if (
          selected?.sectionId === "themes" &&
          (selected.itemId === "dark" || selected.itemId === "light")
        ) {
          setTheme(selected.itemId);
          return true;
        }
      }
      return false;
    },
    [],
  );

  return (
    <SkillRegistryProvider registry={registry}>
      <div className="app">
        <A2UIRenderer
          payload={layout}
          state={state}
          onStateChange={setState}
          onEvent={onEvent}
        />
      </div>
    </SkillRegistryProvider>
  );
}
