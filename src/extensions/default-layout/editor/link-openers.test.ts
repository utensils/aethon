import { describe, expect, it, vi } from "vitest";
import { handleEditorLinkOpen, type EditorLinkResource } from "./link-openers";

const resource = (
  scheme: string,
  value: Partial<EditorLinkResource> = {},
): EditorLinkResource => {
  const ownToString = Object.prototype.hasOwnProperty.call(value, "toString")
    ? value.toString
    : undefined;
  return {
    scheme,
    path: value.path ?? "",
    fsPath: value.fsPath,
    toString: ownToString ?? (() => `${scheme}://example.test/path`),
  };
};

describe("handleEditorLinkOpen", () => {
  it("opens http and https links through the system opener", async () => {
    const openExternalUrl = vi.fn(() => Promise.resolve());
    const openMarkdownFile = vi.fn();

    await expect(
      handleEditorLinkOpen(resource("https"), {
        currentTabId: "tab-1",
        projectPath: "/repo",
        openExternalUrl,
        openMarkdownFile,
      }),
    ).resolves.toBe(true);

    expect(openExternalUrl).toHaveBeenCalledWith("https://example.test/path");
    expect(openMarkdownFile).not.toHaveBeenCalled();
  });

  it("still claims external links when the system opener fails", async () => {
    const openExternalUrl = vi.fn(() => Promise.reject(new Error("no opener")));
    const openMarkdownFile = vi.fn();

    await expect(
      handleEditorLinkOpen(resource("http"), {
        currentTabId: "tab-1",
        projectPath: "/repo",
        openExternalUrl,
        openMarkdownFile,
      }),
    ).resolves.toBe(true);

    expect(openMarkdownFile).not.toHaveBeenCalled();
  });

  it("routes file links back through the editor tab opener", async () => {
    const openExternalUrl = vi.fn(() => Promise.resolve());
    const openMarkdownFile = vi.fn();

    await expect(
      handleEditorLinkOpen(resource("file", { path: "/repo/docs/api.md" }), {
        currentTabId: "tab-1",
        projectPath: "/repo",
        openExternalUrl,
        openMarkdownFile,
      }),
    ).resolves.toBe(true);

    expect(openMarkdownFile).toHaveBeenCalledWith({
      tabId: "tab-1",
      filePath: "/repo/docs/api.md",
      rootPath: "/repo",
    });
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("prefers fsPath for platform-normalized file links", async () => {
    const openMarkdownFile = vi.fn();

    await handleEditorLinkOpen(
      resource("file", {
        path: "/repo/docs/api.md",
        fsPath: "C:\\repo\\docs\\api.md",
      }),
      {
        currentTabId: "tab-1",
        projectPath: "C:\\repo",
        openExternalUrl: vi.fn(() => Promise.resolve()),
        openMarkdownFile,
      },
    );

    expect(openMarkdownFile).toHaveBeenCalledWith({
      tabId: "tab-1",
      filePath: "C:\\repo\\docs\\api.md",
      rootPath: "C:\\repo",
    });
  });

  it("declines file links when there is no active editor tab", async () => {
    const openMarkdownFile = vi.fn();

    await expect(
      handleEditorLinkOpen(resource("file", { path: "/repo/docs/api.md" }), {
        currentTabId: "",
        projectPath: "/repo",
        openExternalUrl: vi.fn(() => Promise.resolve()),
        openMarkdownFile,
      }),
    ).resolves.toBe(false);

    expect(openMarkdownFile).not.toHaveBeenCalled();
  });

  it("declines schemes Monaco can handle elsewhere", async () => {
    await expect(
      handleEditorLinkOpen(resource("mailto"), {
        currentTabId: "tab-1",
        projectPath: "/repo",
        openExternalUrl: vi.fn(() => Promise.resolve()),
        openMarkdownFile: vi.fn(),
      }),
    ).resolves.toBe(false);
  });
});
