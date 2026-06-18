import { describe, expect, it, vi } from "vitest";
import type { ILinkProvider } from "@xterm/xterm";
import {
  findTerminalUrlLinks,
  registerTerminalUrlLinks,
} from "./terminal-linkifier";

const { openUrl } = vi.hoisted(() => ({
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

describe("terminal URL linkifier", () => {
  it("detects visible HTTP URLs with terminal buffer coordinates", () => {
    const links = findTerminalUrlLinks(
      "Listening on http://0.0.0.0:3054, docs at https://example.test/path.",
      7,
    );

    expect(links).toEqual([
      {
        text: "http://0.0.0.0:3054",
        startColumn: 14,
        endColumn: 32,
        range: {
          start: { x: 14, y: 7 },
          end: { x: 32, y: 7 },
        },
      },
      {
        text: "https://example.test/path",
        startColumn: 43,
        endColumn: 67,
        range: {
          start: { x: 43, y: 7 },
          end: { x: 67, y: 7 },
        },
      },
    ]);
  });

  it("registers clickable underlined links that open in the system browser", () => {
    let provider: ILinkProvider | undefined;
    const registerDisposable = { dispose: vi.fn() };
    const term = {
      buffer: {
        active: {
          getLine: vi.fn(() => ({
            translateToString: vi.fn(
              () => "Puma listening on http://0.0.0.0:3054",
            ),
          })),
        },
      },
      registerLinkProvider: vi.fn((nextProvider: ILinkProvider) => {
        provider = nextProvider;
        return registerDisposable;
      }),
    };

    const disposable = registerTerminalUrlLinks(term);
    openUrl.mockResolvedValue(undefined);

    expect(term.registerLinkProvider).toHaveBeenCalledTimes(1);
    expect(disposable).toBe(registerDisposable);

    const callback = vi.fn();
    provider?.provideLinks(3, callback);

    expect(term.buffer.active.getLine).toHaveBeenCalledWith(2);
    const links = callback.mock.calls[0]?.[0];
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      text: "http://0.0.0.0:3054",
      decorations: { pointerCursor: true, underline: true },
      range: {
        start: { x: 19, y: 3 },
        end: { x: 37, y: 3 },
      },
    });

    const preventDefault = vi.fn();
    const event = { preventDefault } as unknown as MouseEvent;
    links[0].activate(event, links[0].text);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith("http://0.0.0.0:3054");
  });
});
