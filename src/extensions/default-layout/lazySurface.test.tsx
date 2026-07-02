// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import {
  lazySurface,
  releaseLazySurfaceBootDeferral,
  resetLazySurfaceBootDeferralForTest,
} from "./lazySurface";

function surfaceProps(): BuiltinComponentProps {
  return {
    component: { id: "x", type: "x", props: {} },
    state: {},
    setState: () => {},
    onEvent: () => {},
  } as unknown as BuiltinComponentProps;
}

beforeEach(() => {
  resetLazySurfaceBootDeferralForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("lazySurface", () => {
  it("does NOT start the import when rendered during the boot window", async () => {
    // The workstation layout mounts hidden cells (display:none) at first
    // chrome render — the import must wait for idle, not fire eagerly.
    vi.useFakeTimers();
    const load = vi.fn(() =>
      Promise.resolve({ default: () => <div>loaded</div> }),
    );
    const Surface = lazySurface("test-surface", load);

    render(<Surface {...surfaceProps()} />);
    expect(load).not.toHaveBeenCalled();

    // jsdom lacks requestIdleCallback — the setTimeout fallback fires it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByText("loaded")).toBeTruthy();
  });

  it("loads immediately once the boot latch is released", async () => {
    releaseLazySurfaceBootDeferral();
    const load = vi.fn(() =>
      Promise.resolve({ default: () => <div>loaded-now</div> }),
    );
    const Surface = lazySurface("post-boot", load);

    render(<Surface {...surfaceProps()} />);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("loaded-now")).toBeTruthy();
  });

  it("preload() loads now and dedupes with a later render", async () => {
    releaseLazySurfaceBootDeferral();
    const load = vi.fn(() =>
      Promise.resolve({ default: () => <div>warm</div> }),
    );
    const Surface = lazySurface("warmed", load);

    await Surface.preload();
    expect(load).toHaveBeenCalledTimes(1);

    render(<Surface {...surfaceProps()} />);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("warm")).toBeTruthy();
  });

  it("preload() never rejects even when the chunk fails", async () => {
    releaseLazySurfaceBootDeferral();
    const Surface = lazySurface("broken", () =>
      Promise.reject(new Error("chunk 404")),
    );
    await expect(Surface.preload()).resolves.toBeUndefined();
  });
});
