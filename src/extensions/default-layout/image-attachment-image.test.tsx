// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageAttachmentImage } from "./image-attachment-image";
import type { ChatAttachment } from "../../types/a2ui";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: (...args: unknown[]) => invoke(...args),
}));

const attachment: ChatAttachment = {
  id: "img-1",
  kind: "image",
  path: "/tmp/one.png",
  name: "one.png",
  mimeType: "image/png",
  sizeBytes: 10,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ImageAttachmentImage", () => {
  it("uses the asset URL without eagerly reading pasted image bytes", () => {
    render(<ImageAttachmentImage attachment={attachment} alt="one" />);

    const img = screen.getByAltText("one");
    expect(img.getAttribute("src")).toBe("asset:///tmp/one.png");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reads pasted image bytes only when the asset URL fails", async () => {
    invoke.mockResolvedValue("abc123");
    render(<ImageAttachmentImage attachment={attachment} alt="one" />);

    const img = screen.getByAltText("one");
    fireEvent.error(img);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("read_paste_image_base64", {
        path: "/tmp/one.png",
      }),
    );
    await waitFor(() =>
      expect(img.getAttribute("src")).toBe("data:image/png;base64,abc123"),
    );
  });
});
