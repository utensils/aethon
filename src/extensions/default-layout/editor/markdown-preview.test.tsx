// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMarkdownLinkPath } from "./markdown-links";
import { MarkdownPreview } from "./markdown-preview";
import type { A2UIComponent } from "../../../types/a2ui";

const mermaidInitialize = vi.hoisted(() => vi.fn());
const mermaidRender = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

vi.mock("../../../utils/highlight", () => ({
  getCachedHighlight: vi.fn(() => null),
  highlightCode: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: mermaidInitialize,
    render: mermaidRender,
  },
}));

const readmeMarkdown = `<p align="center"><img src="assets/logo.png" alt="Claudette" width="128" /></p>
<h1 align="center">Claudette</h1>

| Feature | Status |
| --- | --- |
| Preview | ✅ |

- [x] Render raw README HTML
- [ ] Escape unsafe HTML
`;

function markdownPreviewComponent(
  props?: Record<string, unknown>,
): A2UIComponent {
  return {
    id: "markdown-preview",
    type: "markdown-preview",
    props: {
      filePath: "/repo/README.md",
      projectPath: "/repo",
      ...props,
    },
  };
}

function renderMarkdownPreview(
  markdown: string,
  props?: Record<string, unknown>,
  options?: { imageBase64?: string },
) {
  vi.mocked(invoke).mockImplementation((cmd, _args) => {
    if (cmd === "fs_read_file") return Promise.resolve(markdown);
    if (cmd === "fs_read_file_base64") {
      return Promise.resolve(options?.imageBase64 ?? "aW1hZ2UtYnl0ZXM=");
    }
    return Promise.reject(new Error(`unexpected invoke ${cmd}`));
  });
  const onEvent = vi.fn();
  return {
    ...render(
      <MarkdownPreview
        component={markdownPreviewComponent(props)}
        state={{}}
        onEvent={onEvent}
      />,
    ),
    onEvent,
  };
}

describe("resolveMarkdownLinkPath", () => {
  it("resolves relative links from the current markdown file", () => {
    expect(
      resolveMarkdownLinkPath(
        "docs/invoice-ninja-api.md",
        "/repo/README.md",
        "/repo",
      ),
    ).toBe("/repo/docs/invoice-ninja-api.md");
  });

  it("normalizes parent directory links and strips fragments", () => {
    expect(
      resolveMarkdownLinkPath(
        "../README.md#releases",
        "/repo/docs/api.md",
        "/repo",
      ),
    ).toBe("/repo/README.md");
  });

  it("treats root-relative links as project-relative when needed", () => {
    expect(
      resolveMarkdownLinkPath("/docs/api.md", "/repo/README.md", "/repo"),
    ).toBe("/repo/docs/api.md");
  });

  it("keeps absolute file links that are already under the project root", () => {
    expect(
      resolveMarkdownLinkPath(
        "/repo/docs/api.md?plain=1",
        "/repo/README.md",
        "/repo",
      ),
    ).toBe("/repo/docs/api.md");
  });

  it("decodes file urls and escaped paths", () => {
    expect(
      resolveMarkdownLinkPath(
        "file:///repo/docs/My%20API.md",
        "/repo/README.md",
        "/repo",
      ),
    ).toBe("/repo/docs/My API.md");
  });

  it("rejects relative links that escape the project root", () => {
    expect(
      resolveMarkdownLinkPath(
        "../../../../etc/passwd",
        "/repo/docs/guides/api.md",
        "/repo",
      ),
    ).toBeNull();
  });

  it("rejects file urls outside the project root", () => {
    expect(
      resolveMarkdownLinkPath("file:///etc/passwd", "/repo/README.md", "/repo"),
    ).toBeNull();
  });

  it("handles Windows-style project roots", () => {
    expect(
      resolveMarkdownLinkPath(
        "docs\\api.md",
        "C:\\repo\\README.md",
        "C:\\repo\\",
      ),
    ).toBe("C:/repo/docs/api.md");
    expect(
      resolveMarkdownLinkPath(
        "..\\secrets.md",
        "C:\\repo\\docs\\api.md",
        "C:\\repo\\",
      ),
    ).toBe("C:/repo/secrets.md");
    expect(
      resolveMarkdownLinkPath(
        "..\\..\\Windows\\win.ini",
        "C:\\repo\\docs\\api.md",
        "C:\\repo\\",
      ),
    ).toBeNull();
  });

  it("declines hash-only and external links", () => {
    expect(
      resolveMarkdownLinkPath("#releases", "/repo/README.md", "/repo"),
    ).toBeNull();
    expect(
      resolveMarkdownLinkPath(
        "https://release-plz.dev",
        "/repo/README.md",
        "/repo",
      ),
    ).toBeNull();
  });
});

describe("MarkdownPreview", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(openUrl).mockReset();
    vi.mocked(openUrl).mockResolvedValue(undefined);
    mermaidInitialize.mockReset();
    mermaidRender.mockReset();
    mermaidRender.mockResolvedValue({
      svg: '<svg role="img" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"></path></svg>',
    });
  });

  afterEach(() => cleanup());

  it("loads markdown through fs_read_file", async () => {
    renderMarkdownPreview("# Hello");

    await screen.findByRole("heading", { name: "Hello" });

    expect(invoke).toHaveBeenCalledWith("fs_read_file", {
      root: "/repo",
      path: "/repo/README.md",
    });
  });

  it("renders GitHub README raw HTML through the shared markdown styling", async () => {
    const { container } = renderMarkdownPreview(readmeMarkdown);

    await screen.findByRole("heading", { name: "Claudette", level: 1 });

    const doc = container.querySelector(".ae-md-preview-doc");
    expect(doc?.classList.contains("a2ui-markdown")).toBe(true);
    expect(doc?.classList.contains("a2ui-message-md")).toBe(false);
    expect(doc?.textContent).not.toContain("<p align");
    expect(doc?.textContent).not.toContain("<img");

    await waitFor(() => {
      const image = doc?.querySelector("img");
      expect(image?.getAttribute("src")).toBe(
        "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
      );
    });
    const image = doc?.querySelector("img");
    expect(image?.getAttribute("alt")).toBe("Claudette");
    expect(image?.getAttribute("width")).toBe("128");
    expect(image?.closest("p")?.getAttribute("align")).toBe("center");
    expect(doc?.querySelector("h1")?.getAttribute("align")).toBe("center");
    expect(invoke).toHaveBeenCalledWith("fs_read_file_base64", {
      root: "/repo",
      path: "/repo/assets/logo.png",
    });
  });

  it("resolves relative markdown images through fs_read_file_base64", async () => {
    renderMarkdownPreview('![Logo](assets/logo.png "Aethon")');

    const image = await screen.findByRole("img", { name: "Logo" });
    await waitFor(() =>
      expect(image.getAttribute("src")).toBe(
        "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
      ),
    );

    expect(image.getAttribute("title")).toBe("Aethon");
    expect(invoke).toHaveBeenCalledWith("fs_read_file_base64", {
      root: "/repo",
      path: "/repo/assets/logo.png",
    });
  });

  it("resolves nested markdown images from the current file directory", async () => {
    renderMarkdownPreview("![Logo](../assets/logo.png)", {
      filePath: "/repo/docs/guide.md",
      projectPath: "/repo",
    });

    const image = await screen.findByRole("img", { name: "Logo" });
    await waitFor(() =>
      expect(image.getAttribute("src")).toBe(
        "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
      ),
    );

    expect(invoke).toHaveBeenCalledWith("fs_read_file_base64", {
      root: "/repo",
      path: "/repo/assets/logo.png",
    });
  });

  it("does not render or load local markdown images outside the project root", async () => {
    const { container } = renderMarkdownPreview("![Secret](../../secret.png)", {
      filePath: "/repo/docs/guide.md",
      projectPath: "/repo",
    });

    await waitFor(() =>
      expect(container.querySelector(".ae-md-preview-doc")).not.toBeNull(),
    );

    expect(container.querySelector("img")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith(
      "fs_read_file_base64",
      expect.anything(),
    );
  });

  it("leaves remote and safe data image sources intact", async () => {
    const { container } = renderMarkdownPreview(
      [
        "![Remote](https://example.com/logo.png)",
        "![Inline](data:image/png;base64,aW1hZ2U=)",
      ].join("\n\n"),
    );

    const remote = await screen.findByRole("img", { name: "Remote" });
    const inline = await screen.findByRole("img", { name: "Inline" });

    expect(remote.getAttribute("src")).toBe("https://example.com/logo.png");
    expect(inline.getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=");
    expect(container.querySelectorAll("img")).toHaveLength(2);
    expect(invoke).not.toHaveBeenCalledWith(
      "fs_read_file_base64",
      expect.anything(),
    );
  });

  it("strips unsafe image sources", async () => {
    const { container } = renderMarkdownPreview(
      '![Bad](javascript:alert(1))\n\n<img src="javascript:alert(1)" alt="raw bad" />',
    );

    await waitFor(() =>
      expect(container.querySelector(".ae-md-preview-doc")).not.toBeNull(),
    );

    expect(container.querySelector("img")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith(
      "fs_read_file_base64",
      expect.anything(),
    );
  });

  it("uses GFM plugins for tables and task lists", async () => {
    const { container } = renderMarkdownPreview(readmeMarkdown);

    await waitFor(() =>
      expect(container.querySelector("table")).not.toBeNull(),
    );

    expect(container.querySelector("thead th")?.textContent).toBe("Feature");
    expect(container.querySelector("tbody td")?.textContent).toBe("Preview");
    const checkboxes = container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes.item(0).checked).toBe(true);
    expect(checkboxes.item(1).checked).toBe(false);
  });

  it("renders unlabeled fenced code through the shared code frame", async () => {
    const { container } = renderMarkdownPreview(
      "Current CLI\n\n```\nkoban --help\nkoban completions zsh\n```\n",
    );

    await waitFor(() =>
      expect(container.querySelector(".a2ui-code-frame")).not.toBeNull(),
    );

    const frame = container.querySelector(".a2ui-code-frame");
    expect(frame?.getAttribute("data-language")).toBe("plain");
    expect(frame?.querySelector(".a2ui-code-title")?.textContent).toBe("text");
    expect(frame?.querySelector("pre.a2ui-code")?.textContent).toContain(
      "koban completions zsh",
    );
    expect(frame?.querySelector("button.a2ui-code-copy")).not.toBeNull();
  });

  it("renders mermaid fences as diagrams instead of highlighted code frames", async () => {
    const { container } = renderMarkdownPreview(
      "```mermaid\ngraph TD\n  A --> B\n```\n",
    );

    await waitFor(() =>
      expect(container.querySelector(".a2ui-mermaid-diagram svg")).not.toBeNull(),
    );

    expect(mermaidInitialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false }),
    );
    expect(mermaidRender).toHaveBeenCalledWith(
      expect.stringMatching(/^aethon-mermaid-/),
      "graph TD\n  A --> B",
    );
    expect(container.querySelector(".a2ui-code-frame")).toBeNull();
  });

  it("falls back to the original code block when mermaid render fails", async () => {
    mermaidRender.mockRejectedValueOnce(new Error("bad diagram"));
    const { container } = renderMarkdownPreview(
      "```mermaid\ngraph TD\n  A -->\n```\n",
    );

    await waitFor(() =>
      expect(container.querySelector(".a2ui-code-frame")).not.toBeNull(),
    );

    const frame = container.querySelector(".a2ui-code-frame");
    expect(frame?.getAttribute("data-language")).toBe("mermaid");
    expect(frame?.querySelector("pre.a2ui-code")?.textContent).toContain(
      "graph TD",
    );
    expect(container.querySelector(".a2ui-mermaid-diagram")).toBeNull();
  });

  it("sanitizes unsafe raw HTML while preserving README-safe tags", async () => {
    const { container } = renderMarkdownPreview(
      `${readmeMarkdown}\n<script>alert("x")</script>\n<img src="javascript:alert(1)" alt="bad" />`,
    );

    await screen.findByRole("heading", { name: "Claudette", level: 1 });

    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain('alert("x")');
    expect(container.querySelector('img[alt="bad"]')).toBeNull();
  });

  it("opens relative markdown links in Monaco via the editor route", async () => {
    const { onEvent } = renderMarkdownPreview(
      "See [API notes](docs/invoice-ninja-api.md).",
      {
        filePath: "/repo/README.md",
        projectPath: "/repo",
        tabId: "editor-1",
      },
    );

    const link = await screen.findByRole("link", { name: "API notes" });
    fireEvent.click(link);

    expect(onEvent).toHaveBeenCalledWith("markdown-link-open", {
      tabId: "editor-1",
      filePath: "/repo/docs/invoice-ninja-api.md",
      rootPath: "/repo",
    });
  });

  it("keeps local markdown links from navigating when no tab id is bound", async () => {
    const { onEvent } = renderMarkdownPreview(
      "See [API notes](docs/invoice-ninja-api.md).",
      {
        filePath: "/repo/README.md",
        projectPath: "/repo",
        tabId: "",
      },
    );

    const link = await screen.findByRole("link", { name: "API notes" });
    const allowed = fireEvent.click(link);

    expect(allowed).toBe(false);
    expect(onEvent).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("opens external markdown links through the system opener", async () => {
    const { onEvent } = renderMarkdownPreview(
      "See [release-plz](https://release-plz.dev).",
      {
        filePath: "/repo/README.md",
        projectPath: "/repo",
        tabId: "editor-1",
      },
    );

    const link = await screen.findByRole("link", { name: "release-plz" });
    fireEvent.click(link);

    expect(openUrl).toHaveBeenCalledWith("https://release-plz.dev/");
    expect(onEvent).not.toHaveBeenCalled();
  });
});
