// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_THEME_MAP,
  applyBootTheme,
  mirrorBootTheme,
  readBootThemeSeed,
  THEME_STORAGE_KEY,
} from "./themeBootstrap";

describe("themeBootstrap", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => storage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage.set(key, value);
        }),
        removeItem: vi.fn((key: string) => {
          storage.delete(key);
        }),
        clear: vi.fn(() => {
          storage.clear();
        }),
      },
    });
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    vi.restoreAllMocks();
  });

  it("reads the persisted theme synchronously before React paints", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "paper");

    expect(readBootThemeSeed()).toBe("paper");
    applyBootTheme();
    expect(document.documentElement.dataset.theme).toBe("paper");
  });

  it("normalizes legacy ids and falls back to the OS color scheme", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(readBootThemeSeed()).toBe(LEGACY_THEME_MAP.dark);

    window.localStorage.removeItem(THEME_STORAGE_KEY);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        media: "(prefers-color-scheme: light)",
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    expect(readBootThemeSeed()).toBe("paper");
  });

  it("mirrors the applied theme for the next reload", () => {
    mirrorBootTheme("aether");

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("aether");
  });
});
