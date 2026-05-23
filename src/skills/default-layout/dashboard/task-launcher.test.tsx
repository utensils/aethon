import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskLauncher } from "./task-launcher";
import type { A2UIComponent } from "../../../types/a2ui";

function launcher(props: Record<string, unknown>): A2UIComponent {
  return {
    id: "task-launcher",
    type: "task-launcher",
    props,
  };
}

describe("TaskLauncher", () => {
  it("renders prompt placeholder with the project name", () => {
    const html = renderToStaticMarkup(
      <TaskLauncher
        component={launcher({
          project: { id: "p1", label: "claudex", path: "/c" },
        })}
        state={{}}
        onEvent={() => {}}
      />,
    );
    expect(html).toContain("Start a task in claudex…");
  });

  it("renders nothing when no project is set", () => {
    const html = renderToStaticMarkup(
      <TaskLauncher
        component={launcher({})}
        state={{}}
        onEvent={() => {}}
      />,
    );
    expect(html).toBe("");
  });

  it("renders the project chip label and start button", () => {
    const html = renderToStaticMarkup(
      <TaskLauncher
        component={launcher({
          project: { id: "p1", label: "aethon", path: "/a" },
        })}
        state={{}}
        onEvent={() => {}}
      />,
    );
    expect(html).toContain("aethon");
    expect(html).toContain("Start");
  });

  it("resolves project via $ref", () => {
    const html = renderToStaticMarkup(
      <TaskLauncher
        component={launcher({ project: { $ref: "/project" } })}
        state={{ project: { id: "p1", label: "mold", path: "/m" } }}
        onEvent={() => {}}
      />,
    );
    expect(html).toContain("mold");
    expect(html).toContain("Start a task in mold…");
  });
});
