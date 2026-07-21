import { Layout } from "aethon";
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

/** Layout renders `component.children` through a `renderChild` prop the
 *  real renderer normally supplies (it recurses into the A2UI tree). In the
 *  preview we pass our own `renderChild` that turns each child node into a
 *  labeled panel, so the grid template-areas geometry is what's on display —
 *  the actual workstation composites (sidebar, canvas, …) are stubbed. Each
 *  child opts into a region via `props.area`, which doubles as the grid-area
 *  name; the cell div the Layout wraps it in carries `grid-area: <area>`. */
type ChildNode = {
  id: string;
  props?: { area?: string; visible?: unknown };
};

const AREA_TINT: Record<string, string> = {
  header: "var(--accent, #6c8cff)",
  sidebar: "var(--accent-2, #b06cff)",
  canvas: "var(--success, #3fbf7f)",
  composer: "var(--warning, #e0a94f)",
  terminal: "var(--text-dim, #8a94a6)",
  status: "var(--danger, #e06c75)",
};

const renderChild = (child: unknown): React.ReactNode => {
  const node = child as ChildNode;
  const area = node.props?.area ?? "cell";
  const tint = AREA_TINT[area] ?? "var(--text-dim, #8a94a6)";
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-elev, #1b1f27)",
        border: "1px solid var(--border, #2b313c)",
        borderLeft: `3px solid ${tint}`,
        borderRadius: 6,
        color: "var(--text-dim, #8a94a6)",
        fontSize: 11,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}
    >
      {area}
    </div>
  );
};

const cell = (id: string, area: string): ChildNode => ({
  id,
  props: { area },
});

/** The real workstation shape: a full-width header, a fixed-width sidebar
 *  down the left, the canvas taking the center, a composer beneath it, and a
 *  status bar spanning the bottom. Mirrors
 *  `workstation.a2ui.json`'s slot arrangement at ~560×320. */
export const Workstation = () => (
  <Surface>
    <div style={{ width: 560, height: 320 }}>
      <Layout
        component={{
          id: "ly-workstation",
          type: "layout",
          props: {
            columns: "200px minmax(0,1fr)",
            rows: "44px minmax(0,1fr) 56px 30px",
            gap: 8,
            areas: [
              "header  header",
              "sidebar canvas",
              "sidebar composer",
              "status  status",
            ],
          },
          children: [
            cell("ly-h", "header"),
            cell("ly-sb", "sidebar"),
            cell("ly-cv", "canvas"),
            cell("ly-cp", "composer"),
            cell("ly-st", "status"),
          ],
        }}
        state={{}}
        renderChild={renderChild}
      />
    </div>
  </Surface>
);

/** A simpler two-column split — sidebar left, canvas right — showing the
 *  same template-areas mechanism without the header/status chrome. */
export const TwoColumnSplit = () => (
  <Surface>
    <div style={{ width: 520, height: 240 }}>
      <Layout
        component={{
          id: "ly-split",
          type: "layout",
          props: {
            columns: "220px minmax(0,1fr)",
            rows: "minmax(0,1fr)",
            gap: 8,
            areas: ["sidebar canvas"],
          },
          children: [cell("ly2-sb", "sidebar"), cell("ly2-cv", "canvas")],
        }}
        state={{}}
        renderChild={renderChild}
      />
    </div>
  </Surface>
);
