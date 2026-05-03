/**
 * Aethon extension frontend module (`aethon.frontendEntry`).
 *
 * This file's body is read by the bridge as a string and shipped to
 * the webview, where it's wrapped with:
 *
 *     new Function("React", "skill", code)(React, frontendModuleApi)
 *
 * So write the body as if `React` and `skill` are in scope (the
 * second parameter is named `skill` for back-compat with existing
 * `frontendEntry` bodies; it's just the local handle for the API
 * object below). No imports — the file is evaluated, not
 * module-loaded. (If you want imports, run a bundler like esbuild
 * over a real source file and emit the bundled output here. JSX
 * must be transformed to `React.createElement` calls before the
 * file is shipped.)
 *
 * The API is intentionally tiny — `registerComponent(type, fn)`.
 * Components are React function components receiving the same
 * `BuiltinComponentProps` shape (component, state, onEvent,
 * renderChildren, renderChildWithState) as built-in composites.
 *
 * What this demo registers: a `pulse-card` component that renders a
 * card with a CSS-animated pulse dot. The whole point is to
 * demonstrate something templates can't easily express — here, a
 * keyframe animation tied to a `props.state` variant. Reference it
 * in any A2UI payload as:
 *
 *   { type: "pulse-card", props: { title: "Live", state: "ok" } }
 */
const { createElement: h, useEffect } = React;

skill.registerComponent("pulse-card", function PulseCard({ component }) {
  const props = component.props || {};
  const title = typeof props.title === "string" ? props.title : "Status";
  const variant = props.state === "warn"
    ? { dot: "var(--accent-warn, #d4a01b)", label: "warn" }
    : props.state === "error"
    ? { dot: "var(--accent-error, #d44b3b)", label: "error" }
    : { dot: "var(--accent, #2bbf6b)", label: "ok" };

  // Inject the keyframe animation once per page lifetime. Using a
  // useEffect here demonstrates that real React components shipped
  // through this channel get the full hooks API.
  useEffect(() => {
    const id = "pulse-card-keyframes";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent =
      "@keyframes pulse-card-pulse {" +
      "  0%, 100% { transform: scale(1); opacity: 1; }" +
      "  50% { transform: scale(1.45); opacity: 0.55; }" +
      "}";
    document.head.appendChild(style);
  }, []);

  return h(
    "div",
    {
      className: "pulse-card",
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 14px",
        borderRadius: 999,
        background: "var(--surface, rgba(255,255,255,0.04))",
        border: "1px solid var(--border, rgba(255,255,255,0.08))",
        font: "12px/1 ui-monospace, SF Mono, monospace",
        color: "var(--text)",
      },
    },
    h("span", {
      style: {
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: variant.dot,
        animation: "pulse-card-pulse 1.4s ease-in-out infinite",
      },
    }),
    h(
      "span",
      { style: { fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" } },
      title,
    ),
    h(
      "span",
      { style: { color: "var(--text-dim, #888)" } },
      variant.label,
    ),
  );
});
