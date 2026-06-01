// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function markdownPreviewComponent(props?: Record<string, unknown>): A2UIComponent {
  return {
    id: "markdown-preview",
    type: "markdown-preview",
    props: {
      filePath: "README.md",
      projectPath: "/repo",
      ...props,
    },
  };
}

function renderMarkdownPreview(markdown: string) {
  vi.mocked(invoke).mockResolvedValueOnce(markdown);
  return render(
    <MarkdownPreview
      component={markdownPreviewComponent()}
      state={{}}
      onEvent={vi.fn()}
    />,
  );
}

describe("MarkdownPreview", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  afterEach(() => cleanup());

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

    await waitFor(() => expect(container.querySelector("table")).not.toBeNull());

    expect(container.querySelector("thead th")?.textContent).toBe("Feature");
    expect(container.querySelector("tbody td")?.textContent).toBe("Preview");

    const checkboxes = container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes.item(0).checked).toBe(true);
    expect(checkboxes.item(1).checked).toBe(false);
  });

  it("sanitizes unsafe raw HTML while preserving README-safe tags", async () => {
    const { container } = renderMarkdownPreview(
      `${readmeMarkdown}\n<script>alert("x")</script>\n<img src="javascript:alert(1)" alt="bad" />`,
    );

    await screen.findByRole("heading", { name: "Claudette", level: 1 });

    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("alert(\"x\")");
    expect(container.querySelector('img[alt="bad"]')?.getAttribute("src")).toBeNull();
  });
});
