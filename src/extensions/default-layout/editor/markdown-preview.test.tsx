// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMarkdownLinkPath } from "./markdown-links";
import { MarkdownPreview } from "./markdown-preview";
import type { A2UIComponent } from "../../../types/a2ui";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
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
) {
  vi.mocked(invoke).mockResolvedValueOnce(markdown);
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

    const image = doc?.querySelector("img");
    expect(image?.getAttribute("src")).toBe("assets/logo.png");
    expect(image?.getAttribute("alt")).toBe("Claudette");
    expect(image?.getAttribute("width")).toBe("128");
    expect(image?.closest("p")?.getAttribute("align")).toBe("center");
    expect(doc?.querySelector("h1")?.getAttribute("align")).toBe("center");
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

  it("sanitizes unsafe raw HTML while preserving README-safe tags", async () => {
    const { container } = renderMarkdownPreview(
      `${readmeMarkdown}\n<script>alert("x")</script>\n<img src="javascript:alert(1)" alt="bad" />`,
    );

    await screen.findByRole("heading", { name: "Claudette", level: 1 });

    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain('alert("x")');
    expect(
      container.querySelector('img[alt="bad"]')?.getAttribute("src"),
    ).toBeNull();
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

  it("leaves external markdown links as normal links", async () => {
    const { onEvent } = renderMarkdownPreview(
      "See [release-plz](https://release-plz.dev).",
      {
        filePath: "/repo/README.md",
        projectPath: "/repo",
        tabId: "editor-1",
      },
    );

    const link = await screen.findByRole("link", { name: "release-plz" });
    link.addEventListener("click", (event) => event.preventDefault(), {
      once: true,
    });
    fireEvent.click(link);

    expect(onEvent).not.toHaveBeenCalled();
  });
});
