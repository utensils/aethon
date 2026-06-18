import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StartupCurtain } from "./StartupCurtain";

describe("StartupCurtain", () => {
  it("renders an interactive approval state for startup commands", () => {
    const html = renderToStaticMarkup(
      <StartupCurtain
        logoUrl="/logo.svg"
        startup={{
          output: "",
          entry: {
            root: "/repo",
            fingerprint: "abc",
            state: "approval_required",
            approved: false,
            commands: [
              {
                id: "deps",
                label: "Install dependencies",
                required: true,
                state: "idle",
              },
            ],
          },
        }}
      />,
    );

    expect(html).toContain("Review Workspace Startup");
    expect(html).toContain("Install dependencies");
    expect(html).toContain("role=\"dialog\"");
    expect(html).toContain("aria-modal=\"true\"");
    expect(html).toContain("Approve and run");
    expect(html).toContain("Skip startup");
    expect(html).not.toContain("aria-hidden=\"true\"");
  });

  it("labels failed startup actions by their effect", () => {
    const html = renderToStaticMarkup(
      <StartupCurtain
        logoUrl="/logo.svg"
        startup={{
          output: "install failed",
          entry: {
            root: "/repo",
            fingerprint: "abc",
            state: "failed",
            approved: true,
            reason: "command exited 1",
            commands: [
              {
                id: "deps",
                label: "Install dependencies",
                required: true,
                state: "failed",
              },
            ],
          },
        }}
      />,
    );

    expect(html).toContain("Workspace Startup Failed");
    expect(html).toContain("Retry startup");
    expect(html).toContain("Skip startup");
    expect(html).not.toContain(">Continue<");
  });
});
