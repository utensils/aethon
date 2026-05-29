// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SourceControlPanel } from "./source-control-panel";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import type { GhCheckRun } from "../../../ghChecksCache";
import type { VcsCi, VcsSlice } from "../../../hooks/useVcsStatus";

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
        pr: {
          number: 7,
          state: "OPEN",
          title: "x",
          url: "https://gh/pr/7",
          isDraft: false,
          merged: false,
          baseRefName: "main",
        },
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
