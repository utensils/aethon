import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import A2UIRenderer from "./components/A2UIRenderer";
import type { A2UIPayload, ChatMessage } from "./types/a2ui";
import defaultLayoutJson from "./layouts/default.a2ui.json";

const DEFAULT_LAYOUT: A2UIPayload = defaultLayoutJson as A2UIPayload;

export default function App() {
  // The layout's state IS the app state. Single source of truth, addressed by
  // JSON Pointer from the layout payload.
  const [state, setState] = useState<Record<string, unknown>>(
    () => ({ ...(DEFAULT_LAYOUT.state ?? {}) }),
  );

  // The active layout payload — replaceable. Skills could call setLayout()
  // (via an exposed API) to swap the chrome wholesale.
  const [layout] = useState<A2UIPayload>(DEFAULT_LAYOUT);

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
      return false;
    },
    [],
  );

  return (
    <div className="app">
      <A2UIRenderer
        payload={layout}
        state={state}
        onStateChange={setState}
        onEvent={onEvent}
      />
    </div>
  );
}
