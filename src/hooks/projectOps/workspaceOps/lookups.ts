import type { MutableRefObject } from "react";
import type { Project, ProjectsState } from "../../../projects";
import type { Workspace } from "../../../workspaces";
import type { ProjectLookups } from "./types";

export function makeProjectLookups(
  projectsRef: MutableRefObject<ProjectsState>,
): ProjectLookups {
  function findProject(id: string): Project | null {
    return projectsRef.current.projects.find((p) => p.id === id) ?? null;
  }

  function findProjectOfWorkspace(
    workspaceId: string,
  ): { project: Project; workspace: Workspace } | null {
    const wbp = projectsRef.current.workspacesByProject;
    for (const [pid, list] of Object.entries(wbp)) {
      const wt = list.find((w) => w.id === workspaceId);
      if (wt) {
        const project = findProject(pid);
        if (project) return { project, workspace: wt };
      }
    }
    return null;
  }

  return { findProject, findProjectOfWorkspace };
}
