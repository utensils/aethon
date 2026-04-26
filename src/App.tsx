import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Role = "user" | "agent";

type Message = {
  id: string;
  role: Role;
  text: string;
};

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [connected, setConnected] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Listen for agent responses
  useEffect(() => {
    const unlisten = listen<string>("agent-response", (event) => {
      try {
        const data = JSON.parse(event.payload);
        if (data.type === "response" && data.content) {
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "agent", text: data.content },
          ]);
          if (data.done) setWaiting(false);
        } else if (data.type === "error") {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "agent",
              text: `Error: ${data.message}`,
            },
          ]);
          setWaiting(false);
        }
      } catch {
        // non-JSON event, ignore
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function send() {
    const text = draft.trim();
    if (!text || waiting) return;
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", text },
    ]);
    setDraft("");
    setWaiting(true);
    setConnected(true);

    try {
      await invoke("send_message", { message: text });
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "agent",
          text: `Connection error: ${err}`,
        },
      ]);
      setWaiting(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">Aethon</h1>
        <span className="app-status">
          {waiting
            ? "thinking..."
            : connected
              ? "connected"
              : "ready"}
        </span>
      </header>

      <div className="message-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="message-empty">
            Send a message to start a conversation with the pi agent.
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`message ${m.role}`}>
              <span className="message-role">{m.role}</span>
              {m.text}
            </div>
          ))
        )}
        {waiting && (
          <div className="message agent">
            <span className="message-role">agent</span>
            <span className="typing-indicator">...</span>
          </div>
        )}
      </div>

      <div className="composer">
        <textarea
          className="composer-input"
          rows={2}
          placeholder="Message Aethon&hellip; (Enter to send, Shift+Enter for newline)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={waiting}
        />
        <button
          type="button"
          className="composer-send"
          onClick={send}
          disabled={draft.trim().length === 0 || waiting}
        >
          Send
        </button>
      </div>
    </div>
  );
}
