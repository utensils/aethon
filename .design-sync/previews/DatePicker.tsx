import { DatePicker } from "aethon";
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

const Field = ({
  label,
  children,
}: {
  label: string;
  children?: React.ReactNode;
}) => (
  <div style={{ display: "grid", gap: 6, maxWidth: 280 }}>
    <span style={{ fontSize: "0.8125rem", fontWeight: 650 }}>{label}</span>
    {children}
  </div>
);

/** A scheduled-run date, bounded to the current release window. */
export const Scheduled = () => (
  <Surface>
    <div style={{ padding: 8 }}>
      <Field label="Run agent on">
        <DatePicker
          component={{
            id: "dp-run",
            type: "date-picker",
            props: { value: "2026-07-24", min: "2026-07-20", max: "2026-08-31" },
          }}
          state={{}}
          onEvent={noop}
        />
      </Field>
    </div>
  </Surface>
);

/** Empty — no date chosen yet; the native placeholder shows. */
export const Empty = () => (
  <Surface>
    <div style={{ padding: 8 }}>
      <Field label="Snooze nightly build until">
        <DatePicker
          component={{
            id: "dp-empty",
            type: "date-picker",
            props: { min: "2026-07-20" },
          }}
          state={{}}
          onEvent={noop}
        />
      </Field>
    </div>
  </Surface>
);

/** Disabled — the schedule is fixed by a recurring cron and can't be edited. */
export const Disabled = () => (
  <Surface>
    <div style={{ padding: 8 }}>
      <Field label="Next run (managed by cron)">
        <DatePicker
          component={{
            id: "dp-disabled",
            type: "date-picker",
            props: { value: "2026-07-21", disabled: true },
          }}
          state={{}}
          onEvent={noop}
        />
      </Field>
    </div>
  </Surface>
);
