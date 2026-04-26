import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import A2UIRenderer from "./components/A2UIRenderer";
import type { A2UIPayload } from "./types/a2ui";

type Role = "user" | "agent";

type Message = {
  id: string;
  role: Role;
  text?: string;
  a2ui?: A2UIPayload;
};

// Demo A2UI payload for testing Phase 2
const demoA2UIPayload: A2UIPayload = {
  components: [
    {
      id: "demo-card",
      type: "card",
      props: {
        title: "A2UI Demo",
        description: "Phase 2 Implementation",
        padding: 20,
      },
      children: [
        {
          id: "demo-container",
          type: "container",
          props: {
            direction: "column",
            gap: 16,
          },
          children: [
            {
              id: "demo-text",
              type: "text",
              props: {
                content: "This is a working A2UI renderer with data binding and event dispatch.",
              },
            },
            {
              id: "demo-code",
              type: "code",
              props: {
                content: `const greeting = "Hello from A2UI!";
console.log(greeting);`,
                language: "typescript",
                showLineNumbers: true,
              },
            },
            {
              id: "demo-input",
              type: "text-input",
              props: {
                value: { $ref: "/userInput" },
                placeholder: "Type something...",
                onChange: "input-changed",
              },
            },
            {
              id: "demo-button-container",
              type: "container",
              props: {
                direction: "row",
                gap: 8,
              },
              children: [
                {
                  id: "demo-button-primary",
                  type: "button",
                  props: {
                    label: "Primary Action",
                    variant: "primary",
                    onClick: "primary-clicked",
                  },
                },
                {
                  id: "demo-button-secondary",
                  type: "button",
                  props: {
                    label: "Secondary Action",
                    variant: "secondary",
                    onClick: "secondary-clicked",
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  state: {
    userInput: "Initial value",
  },
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
        } else if (data.type === "a2ui" && data.payload) {
          // A2UI payload from agent
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "agent", a2ui: data.payload },
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

      {/* A2UI Demo Section */}
      <div style={{ padding: "20px", borderBottom: "1px solid var(--border)" }}>
        <A2UIRenderer payload={demoA2UIPayload} />
      </div>

      <div className="message-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="message-empty">
            Send a message to start a conversation with the pi agent.
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`message ${m.role}`}>
              <span className="message-role">{m.role}</span>
              {m.text && m.text}
              {m.a2ui && <A2UIRenderer payload={m.a2ui} />}
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
