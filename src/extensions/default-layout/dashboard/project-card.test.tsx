import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectCard } from "./project-card";
import type { A2UIComponent } from "../../../types/a2ui";

function card(props: Record<string, unknown>): A2UIComponent {
  return {
    id: "project-card",
    type: "project-card",
    props,
  };
}

describe("ProjectCard", () => {
  it("renders the project label + path", () => {
    const html = renderToStaticMarkup(
      <ProjectCard
        component={card({
          project: {
            id: "p1",
            label: "aethon",
            path: "/Users/me/Projects/aethon",
          },
        })}
        state={{}}
        onEvent={() => {}}
      />,
    );
    expect(html).toContain("aethon");
    expect(html).toContain("/Users/me/Projects/aethon");
  });

  it("renders the active chip when active=true", () => {
    const html = renderToStaticMarkup(
      <ProjectCard
        component={card({
          project: { id: "p1", label: "aethon", path: "/p" },
          active: true,
        })}
        state={{}}
        onEvent={() => {}}
      />,
    );
    expect(html).toContain("a2ui-project-card--active");
    expect(html).toContain(">active<");
  });

  it("renders branch + dirty + ahead/behind from gitStatus", () => {
    const html = renderToStaticMarkup(
      <ProjectCard
        component={card({
          project: {
            id: "p1",
            label: "aethon",
            path: "/p",
            gitStatus: {
              branch: "feat/x",
              dirty: true,
              ahead: 2,
              behind: 1,
            },
          },
        })}
        state={{}}
        onEvent={() => {}}
      />,
    );
    expect(html).toContain("feat/x");
    expect(html).toContain("a2ui-project-card-branch--dirty");
    expect(html).toContain("↑2");
    expect(html).toContain("↓1");
  });

  it("renders nothing when project is missing", () => {
    const html = renderToStaticMarkup(
      <ProjectCard
        component={card({})}
        state={{}}
        onEvent={() => {}}
      />,
    );
    expect(html).toBe("");
  });

  it("resolves project via $ref", () => {
    const html = renderToStaticMarkup(
      <ProjectCard
        component={card({ project: { $ref: "/projectsDashboard/cards/0" } })}
        state={{
          projectsDashboard: {
            cards: [{ id: "p1", label: "claudette", path: "/c" }],
          },
        }}
        onEvent={() => {}}
      />,
    );
    expect(html).toContain("claudette");
    expect(html).toContain("/c");
  });
});
