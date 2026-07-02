// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PairingQr } from "./pairing-qr";

const SAMPLE_PAYLOAD = JSON.stringify({
  v: 1,
  name: "halcyon",
  hosts: ["192.168.1.10", "halcyon.local"],
  port: 48213,
  fp: "ab".repeat(32),
  code: "12345678",
});

afterEach(cleanup);

describe("PairingQr", () => {
  it("renders an SVG QR with drawn modules for a pairing payload", () => {
    render(<PairingQr payload={SAMPLE_PAYLOAD} />);
    const svg = screen.getByTestId("remote-pairing-qr");
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.getAttribute("role")).toBe("img");
    const path = svg.querySelector("path");
    expect(path).not.toBeNull();
    // A real QR encodes hundreds of dark modules — an empty `d` would
    // mean the matrix never made it into the path.
    expect(path!.getAttribute("d")!.length).toBeGreaterThan(500);
  });

  it("honors the size prop without changing the module grid", () => {
    render(<PairingQr payload={SAMPLE_PAYLOAD} size={96} />);
    const svg = screen.getByTestId("remote-pairing-qr");
    expect(svg.getAttribute("width")).toBe("96");
    expect(svg.getAttribute("height")).toBe("96");
  });
});
