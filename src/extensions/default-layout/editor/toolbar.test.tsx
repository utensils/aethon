// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EditorToolbar } from "./toolbar";

afterEach(() => cleanup());

describe("EditorToolbar", () => {
  it("opens the File menu with New File / Save / Revert", () => {
    render(<EditorToolbar canPreview={false} previewActive={false} />);
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    expect(screen.getByRole("menuitem", { name: /New File/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /^Save/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Revert File" })).toBeTruthy();
  });

  it("dispatches aethon:editor-save from the File menu Save item", () => {
    const seen: string[] = [];
    const handler = (e: Event) => seen.push(e.type);
    window.addEventListener("aethon:editor-save", handler);
    render(<EditorToolbar canPreview={false} previewActive={false} />);
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Save/ }));
    expect(seen).toContain("aethon:editor-save");
    window.removeEventListener("aethon:editor-save", handler);
  });

  it("dispatches aethon:editor-save from the quick Save button", () => {
    const seen: string[] = [];
    const handler = (e: Event) => seen.push(e.type);
    window.addEventListener("aethon:editor-save", handler);
    render(<EditorToolbar canPreview={false} previewActive={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(seen).toContain("aethon:editor-save");
    window.removeEventListener("aethon:editor-save", handler);
  });

  it("hides the Preview toggle for non-markdown files", () => {
    render(
      <EditorToolbar
        canPreview={false}
        previewActive={false}
        onTogglePreview={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Preview|Edit/ })).toBeNull();
  });

  it("shows Preview for markdown and flips to Edit when active", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <EditorToolbar
        canPreview
        previewActive={false}
        onTogglePreview={onToggle}
      />,
    );
    const preview = screen.getByRole("button", { name: "Preview" });
    fireEvent.click(preview);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <EditorToolbar canPreview previewActive onTogglePreview={onToggle} />,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });
});
