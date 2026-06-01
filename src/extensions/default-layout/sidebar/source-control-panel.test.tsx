// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SourceControlPanel } from "./source-control-panel";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import type { GhCheckRun } from "../../../ghChecksCache";
import type { VcsCi, VcsPr, VcsSlice } from "../../../hooks/useVcsStatus";

afterEach(() => cleanup());

type OnEvent = BuiltinComponentProps["onEvent"];

function run(over: Partial<GhCheckRun> = {}): GhCheckRun {
  return {
    name: "build",
    status: "completed",
    conclusion: "success",
    url: "https://gh/run/build",
    ...over,
  };
}

function ci(over: Partial<VcsCi> = {}): VcsCi {
  return {
    conclusion: "success",
    total: 2,
    passed: 2,
    failed: 0,
    pending: 0,
    skipped: 0,
    checks: [],
    ...over,
  };
}

function pr(over: Partial<VcsPr> = {}): VcsPr {
  return {
    number: 185,
    state: "OPEN",
    title: "Add aurora",
    url: "https://gh/pr/185",
    isDraft: false,
    merged: false,
    baseRefName: "main",
    ...over,
  };
}

function vcs(over: Partial<VcsSlice> = {}): VcsSlice {
  return {
    root: "/repo",
    branch: "main",
    ahead: 0,
    behind: 0,
    dirty: false,
    ghAvailable: true,
    loading: false,
    changes: {
      total: 0,
      modified: 0,
      added: 0,
      deleted: 0,
      untracked: 0,
      renamed: 0,
      copied: 0,
      conflicted: 0,
      insertions: 0,
      deletions: 0,
      files: [],
    },
    pr: null,
    ci: ci(),
    ...over,
  };
}

function renderPanel(slice: VcsSlice, onEvent: OnEvent = vi.fn()) {
  render(
    <SourceControlPanel
      component={{
        id: "source-control-panel",
        type: "source-control-panel",
        props: {},
      }}
      state={{ vcs: slice }}
      onEvent={onEvent}
      renderChildWithState={() => null}
    />,
  );
  return { onEvent };
}

describe("SourceControlPanel — PR badge", () => {
  it("renders merged PRs with the merged badge class, not neutral", () => {
    renderPanel(vcs({ pr: pr({ merged: true }) }));

    const badge = screen.getByText("merged");
    expect(badge.classList.contains("is-merged")).toBe(true);
    expect(badge.classList.contains("is-neutral")).toBe(false);
  });

  it("keeps open, closed, and draft badge tones unchanged", () => {
    const cases: Array<[string, VcsPr, string]> = [
      ["open", pr(), "is-success"],
      ["closed", pr({ state: "CLOSED" }), "is-failure"],
      ["draft", pr({ isDraft: true }), "is-muted"],
    ];

    for (const [label, value, className] of cases) {
      cleanup();
      renderPanel(vcs({ pr: value }));
      const badge = screen.getByText(label);
      expect(badge.classList.contains(className)).toBe(true);
    }
  });
});

describe("SourceControlPanel — CI jobs", () => {
  it("auto-expands the job list when CI is failing, failures first", () => {
    renderPanel(
      vcs({
        ci: ci({
          conclusion: "failure",
          total: 2,
          passed: 1,
          failed: 1,
          checks: [
            run({ name: "lint", conclusion: "success" }),
            run({
              name: "test",
              conclusion: "failure",
              url: "https://gh/run/test",
            }),
          ],
        }),
      }),
    );
    const ciRow = screen.getByRole("button", { name: /CI/ });
    expect(ciRow.getAttribute("aria-expanded")).toBe("true");
    const names = screen
      .getAllByText(/^(lint|test)$/)
      .map((n) => n.textContent);
    expect(names).toEqual(["test", "lint"]);
  });

  it("starts collapsed when green and expands on summary click", () => {
    renderPanel(
      vcs({
        ci: ci({
          checks: [run({ name: "lint" }), run({ name: "test" })],
        }),
      }),
    );
    const ciRow = screen.getByRole("button", { name: /CI/ });
    expect(ciRow.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("lint")).toBeNull();
    fireEvent.click(ciRow);
    expect(ciRow.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("lint")).not.toBeNull();
  });

  it("renders the shared SVG chevron (not the tiny text glyph)", () => {
    renderPanel(
      vcs({
        ci: ci({
          checks: [run({ name: "lint" }), run({ name: "test" })],
        }),
      }),
    );
    const ciRow = screen.getByRole("button", { name: /CI/ });
    const chevron = ciRow.querySelector(".ae-scm-ci-chevron");
    expect(chevron).not.toBeNull();
    // Shared <Chevron> SVG, matching the file tree + "N CHANGED" header.
    expect(chevron?.querySelector("svg")).not.toBeNull();
    // No leftover unicode triangle glyphs anywhere in the row.
    expect(ciRow.textContent ?? "").not.toMatch(/[▾▸]/);
  });

  it("opens the check URL when a job row is clicked", () => {
    const onEvent = vi.fn();
    renderPanel(
      vcs({
        ci: ci({
          conclusion: "failure",
          checks: [
            run({
              name: "test",
              conclusion: "failure",
              url: "https://gh/run/test",
            }),
          ],
        }),
      }),
      onEvent,
    );
    fireEvent.click(screen.getByText("test"));
    expect(onEvent).toHaveBeenCalledWith("open-url", {
      url: "https://gh/run/test",
    });
  });

  it("does not emit open-url for a job with no URL (e.g. skipped)", () => {
    const onEvent = vi.fn();
    renderPanel(
      vcs({
        ci: ci({
          conclusion: "failure",
          checks: [run({ name: "docker", conclusion: "skipped", url: null })],
        }),
      }),
      onEvent,
    );
    const li = screen.getByText("docker").closest("li")!;
    expect(li.getAttribute("data-clickable")).toBeNull();
    fireEvent.click(screen.getByText("docker"));
    expect(onEvent).not.toHaveBeenCalledWith("open-url", expect.anything());
  });

  it("keeps open-on-click (no toggle) when the rollup has no individual checks", () => {
    const onEvent = vi.fn();
    renderPanel(
      vcs({
        pr: pr({ number: 7, title: "x", url: "https://gh/pr/7" }),
        ci: ci({ checks: [] }),
      }),
      onEvent,
    );
    const ciRow = screen.getByRole("button", { name: /CI/ });
    expect(ciRow.hasAttribute("aria-expanded")).toBe(false);
    fireEvent.click(ciRow);
    expect(onEvent).toHaveBeenCalledWith("open-url", {
      url: "https://gh/pr/7",
    });
  });
});

describe("SourceControlPanel — changed files", () => {
  it("renders the +adds / -dels line stat in the header", () => {
    renderPanel(
      vcs({
        dirty: true,
        changes: {
          total: 2,
          modified: 2,
          added: 0,
          deleted: 0,
          untracked: 0,
          renamed: 0,
          copied: 0,
          conflicted: 0,
          insertions: 3157,
          deletions: 249,
          files: [],
        },
      }),
    );
    expect(screen.getByText("+3,157")).toBeTruthy();
    expect(screen.getByText("−249")).toBeTruthy();
  });

  it("starts with the changed-files list collapsed", () => {
    renderPanel(
      vcs({
        dirty: true,
        changes: {
          total: 1,
          modified: 1,
          added: 0,
          deleted: 0,
          untracked: 0,
          renamed: 0,
          copied: 0,
          conflicted: 0,
          insertions: 1,
          deletions: 0,
          files: [{ path: "src/App.tsx", status: "modified" }],
        },
      }),
    );
    // File row hidden until the header is clicked.
    expect(screen.queryByText("src/App.tsx")).toBeNull();
  });

  it("opens a diff view when a changed file is clicked", () => {
    const onEvent = vi.fn();
    renderPanel(
      vcs({
        dirty: true,
        changes: {
          total: 1,
          modified: 1,
          added: 0,
          deleted: 0,
          untracked: 0,
          renamed: 0,
          copied: 0,
          conflicted: 0,
          insertions: 12,
          deletions: 3,
          files: [{ path: "src/App.tsx", status: "modified" }],
        },
      }),
      onEvent,
    );
    // The list is collapsed by default — expand it first.
    fireEvent.click(screen.getByText(/1 changed/));
    fireEvent.click(screen.getByText("src/App.tsx"));
    expect(onEvent).toHaveBeenCalledWith("file-tree-diff", {
      filePath: "/repo/src/App.tsx",
      rootPath: "/repo",
    });
  });
});
