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
  }, [layout, registry]);

  useEffect(() => {
    const unlisten = listen<string>("agent-response", (event) => {
      try {
        const data = JSON.parse(event.payload);
        if (data.type === "response" && data.content) {
          appendMessage({
            id: crypto.randomUUID(),
            role: "agent",
            text: data.content,
          });
          if (data.done) setStatusFlags({ waiting: false, status: "ready" });
        } else if (data.type === "a2ui" && data.payload) {
          appendMessage({
            id: crypto.randomUUID(),
            role: "agent",
            a2ui: data.payload,
          });
          if (data.done) setStatusFlags({ waiting: false, status: "ready" });
        } else if (data.type === "error") {
          appendMessage({
            id: crypto.randomUUID(),
            role: "agent",
            text: `Error: ${data.message}`,
          });
          setStatusFlags({ waiting: false, status: "error" });
        }
      } catch {
        // non-JSON event, ignore
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  function appendMessage(msg: ChatMessage) {
    setState((prev) => ({
      ...prev,
      messages: [...((prev.messages as ChatMessage[]) ?? []), msg],
    }));
  }

  function setStatusFlags(flags: Partial<{ waiting: boolean; status: string; connection: string }>) {
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

  // Intercept events from layout-level components before they reach the agent.
  // The layout speaks A2UI, but a few interactions need to drive native APIs
  // (Tauri IPC for chat send) — this is where the renderer hands off control.
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
