import { useEffect, useRef, useState } from "react";

type Role = "user" | "agent";

type Message = {
  id: string;
  role: Role;
  text: string;
};

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function send() {
    const text = draft.trim();
    if (!text) return;
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", text },
    ]);
    setDraft("");
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
        <span className="app-status">scaffold &middot; agent not connected</span>
      </header>

      <div className="message-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="message-empty">
            Start the conversation. The agent runtime is not wired up yet &mdash;
            messages stay local.
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`message ${m.role}`}>
              <span className="message-role">{m.role}</span>
              {m.text}
            </div>
          ))
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
        />
        <button
          type="button"
          className="composer-send"
          onClick={send}
          disabled={draft.trim().length === 0}
        >
          Send
        </button>
      </div>
    </div>
  );
}
