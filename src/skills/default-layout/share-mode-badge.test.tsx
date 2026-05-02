// Unit tests for the share-mode badge — extracted as its own
// registerable component so a skill can replace it without rewriting
// the whole shell status bar.
//
// The vitest harness runs in node (no jsdom), so we exercise rendering
// via react-dom/server and trust the existing share-badge cycle
// integration test in `components.test.ts` to cover the click-emit
// logic via `cycleShareMode`.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShareModeBadge } from "./share-mode-badge";
import type { A2UIComponent } from "../../types/a2ui";

function badge(props: { shareMode?: string; tabId?: string }): A2UIComponent {
  return {
    id: "share-mode-badge",
    type: "share-mode-badge",
    props,
  };
}

describe("ShareModeBadge", () => {
  it("renders the prop-supplied mode as the data-mode attribute", () => {
    const html = renderToStaticMarkup(
      <ShareModeBadge
        component={badge({ shareMode: "read", tabId: "tab-1" })}
        state={{}}
        onEvent={() => {}}
      />,
    );
    expect(html).toContain('data-mode="read"');
    expect(html).toContain('class="ae-share-badge"');
  });

  it("falls back to the active shell tab's mode when prop is absent", () => {
    const html = renderToStaticMarkup(
      <ShareModeBadge
        component={badge({})}
        state={{
          activeTabId: "shell-1",
          tabs: [
            {
              id: "shell-1",
              kind: "shell",
              shell: { shareMode: "read-write" },
            },
          ],
        }}
        onEvent={() => {}}
      />,
    );
    expect(html).toContain('data-mode="read-write"');
  });

  it("defaults to private when active tab is an agent tab", () => {
    const html = renderToStaticMarkup(
      <ShareModeBadge
        component={badge({})}
        state={{
          activeTabId: "agent-1",
          tabs: [{ id: "agent-1", kind: "agent" }],
        }}
        onEvent={() => {}}
      />,
    );
    expect(html).toContain('data-mode="private"');
  });

  it("defaults to private with no active tab at all", () => {
    const html = renderToStaticMarkup(
      <ShareModeBadge
        component={badge({})}
        state={{}}
        onEvent={() => {}}
      />,
    );
    expect(html).toContain('data-mode="private"');
  });

  it("includes an aria-label that announces the current mode", () => {
    const html = renderToStaticMarkup(
      <ShareModeBadge
        component={badge({ shareMode: "read-write-trusted", tabId: "t" })}
        state={{}}
        onEvent={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Share mode:');
    expect(html).toContain("read-write");
  });
});
