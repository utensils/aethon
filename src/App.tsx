import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import A2UIRenderer from "./components/A2UIRenderer";
import { SkillRegistry, SkillRegistryProvider } from "./skills/registry";
import { defaultLayoutSkill } from "./skills/default-layout";
import type { A2UIPayload, ChatMessage } from "./types/a2ui";
import type { A2UISkill } from "./skills/types";

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

  // Track the trailing agent message id so streaming text deltas append to
  // the same chat bubble instead of creating a new bubble per chunk.
  const activeResponseIdRef = useRef<string | null>(null);

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
    invoke("start_agent").catch((err) => {
      appendMessage({
        id: crypto.randomUUID(),
        role: "agent",
        text: `Failed to start agent: ${err}`,
      });
      setStatusFlags({ status: "error" });
    });

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
            models: models.map((m) => ({ id: m.id, label: m.label })),
          },
        }));
        break;
      }
      case "model_changed": {
        const model = (data.model as string) || "";
        setState((prev) => ({ ...prev, model, status: `switched to ${model}` }));
        break;
      }
      case "response_delta": {
        const delta = (data.content as string) ?? "";
        if (!delta) break;
        appendOrAmendAgentText(delta);
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

  function appendOrAmendAgentText(delta: string) {
    setState((prev) => {
      const messages = [...((prev.messages as ChatMessage[]) ?? [])];
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

  async function sendChat(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    appendMessage({ id: crypto.randomUUID(), role: "user", text: trimmed });
    setState((prev) => ({
      ...prev,
      draft: "",
      waiting: true,
      status: "thinking…",
      connection: "connected",
    }));

    try {
      await invoke("send_message", { message: trimmed });
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
      if (component.id === "sidebar" && eventType === "select") {
        const selected = data as { sectionId?: string; itemId?: string } | undefined;
        if (selected?.itemId === "toggle-terminal") {
          setState((prev) => {
            const term = (prev.terminal as { open?: boolean; output?: string }) ?? {};
            return { ...prev, terminal: { ...term, open: !term.open } };
          });
          return true;
        }
        if (selected?.sectionId === "models" && selected.itemId) {
          await setModel(selected.itemId);
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
