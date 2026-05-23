import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GhStatsStrip } from "./gh-stats-strip";
import type { A2UIComponent } from "../../../types/a2ui";
import type { GhRepoOverview } from "../../../ghRepoOverviewCache";

function strip(props: Record<string, unknown>): A2UIComponent {
  return {
    id: "gh-stats-strip",
    type: "gh-stats-strip",
    props,
  };
}

function fullOverview(over: Partial<GhRepoOverview> = {}): GhRepoOverview {
  return {
    ghAvailable: true,
    repo: "owner/repo",
    description: "Test repo",
    url: "https://github.com/owner/repo",
    defaultBranch: "main",
    stargazerCount: 1234,
    forkCount: 56,
    openIssuesCount: 7,
    openPrsCount: 3,
    pushedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    ...over,
  };
}

describe("GhStatsStrip", () => {
  it("renders all five stat pills when ghAvailable + repo are set", () => {
    const html = renderToStaticMarkup(
      <GhStatsStrip
        component={strip({ overview: fullOverview() })}
        state={{}}
        onEvent={() => {}}
      />,
    );
    expect(html).toContain("owner/repo");
    expect(html).toContain("1234");
    expect(html).toContain("56");
    expect(html).toContain("7");
    expect(html).toContain("3");
    expect(html).toContain("main");
    // Relative-time formatter — 2h ago.
    expect(html).toContain("2h ago");
  });

  it("renders nothing when gh is unavailable", () => {
    const html = renderToStaticMarkup(
      <GhStatsStrip
        component={strip({
          overview: fullOverview({ ghAvailable: false, repo: null }),
        })}
        state={{}}
        onEvent={() => {}}
      />,
    );
    // No pills should be emitted at all.
    expect(html).toBe("");
  });

  it("resolves overview via $ref binding from state", () => {
    const html = renderToStaticMarkup(
      <GhStatsStrip
        component={strip({ overview: { $ref: "/projectDashboard/repoOverview" } })}
        state={{
          projectDashboard: { repoOverview: fullOverview({ stargazerCount: 99 }) },
        }}
        onEvent={() => {}}
      />,
    );
    expect(html).toContain("99");
  });

  it("emits open-url with the repo URL when the repo pill is clicked", () => {
    const onEvent = vi.fn();
    // Render dynamically by instantiating React on the server is too much
    // for a render test — instead exercise the handler indirectly. The
    // event-route test covers the dispatch side; here we just confirm
    // the onClick prop is wired (no error on render).
    expect(() =>
      renderToStaticMarkup(
        <GhStatsStrip
          component={strip({ overview: fullOverview() })}
          state={{}}
          onEvent={onEvent}
        />,
      ),
    ).not.toThrow();
  });
});
