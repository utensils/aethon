import { Table } from "aethon";
import type * as React from "react";

/** Preview-only themed surface: the app shell styles `body` with
 *  --bg/--text/--font-ui (chrome base.css), and real designs inherit that
 *  via the styles.css closure — the DS preview harness overrides body to
 *  white, so cards re-create the shell surface locally. */
const Surface = ({ children }: { children?: React.ReactNode }) => (
  <div
    style={{
      background: "var(--bg)",
      color: "var(--text)",
      fontFamily: "var(--font-ui)",
      padding: 16,
      borderRadius: 8,
    }}
  >
    {children}
  </div>
);

const noop = () => {};

const columns = [
  { header: "Session", field: "session" },
  { header: "Model", field: "model" },
  { header: "Status", field: "status" },
  { header: "Duration", field: "duration", width: "90px" },
];

const rows = [
  {
    session: "fix flaky scrollSpy test",
    model: "claude-sonnet-5",
    status: "completed",
    duration: "4m 12s",
  },
  {
    session: "migrate window-state schema",
    model: "claude-opus-4-8",
    status: "running",
    duration: "12m 03s",
  },
  {
    session: "voice hotkey regression",
    model: "gpt-5.6-sol",
    status: "queued",
    duration: "—",
  },
  {
    session: "release 0.12.1 notes",
    model: "claude-haiku-4-5",
    status: "completed",
    duration: "1m 48s",
  },
];

export const AgentRuns = () => (
  <Surface>
  <div style={{ padding: 8, maxWidth: 640 }}>
    <Table
      component={{
        id: "t-runs",
        type: "table",
        props: { columns, rows },
      }}
      state={{}}
      onEvent={noop}
    />
  </div>
  </Surface>
);

/** Rows bound from state via `$ref` — the table re-renders when the
 *  pointed-at array changes. */
export const StateBound = () => (
  <Surface>
  <div style={{ padding: 8, maxWidth: 640 }}>
    <Table
      component={{
        id: "t-bound",
        type: "table",
        props: { columns, rows: { $ref: "/dashboard/runs" } },
      }}
      state={{ dashboard: { runs: rows.slice(0, 2) } }}
      onEvent={noop}
    />
  </div>
  </Surface>
);
