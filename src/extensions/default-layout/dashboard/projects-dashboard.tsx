/**
 * projects-dashboard — global overview shown when no project is active
 * and all tabs are closed. Hero + CTA row + responsive grid of
 * project-card composites + recent-sessions rail.
 *
 * Reads data via $ref bindings so live mutations and extension state
 * patches reflect immediately:
 *   - projects: /projects (array of {id, label, path, active})
 *   - recentSessions: /recentSessions
 *   - extraCards: /projectsDashboard/extraCards (extension-injected
 *     custom tiles, optional)
 *
 * Events:
 *   - "new-tab" / "open-project" — reuse existing tabStrip event routes
 *     so the global empty-state behaviour stays consistent.
 *   - "select-project-card" (forwarded from project-card) → activates.
 *   - "restore-session" — reuses tabStrip route too.
 */
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { resolvePointer } from "../../../utils/jsonPointer";
import { AeMarkInline } from "../layout";
import { RegistryComponent } from "../../../components/A2UIRenderer";
import { DashboardSessionRow } from "./session-row";
import { clearConfigCache } from "../../../config";
import { writeConfigPatch } from "../../../configWrites";

interface ProjectListItem {
  id: string;
  label: string;
  path: string;
  active?: boolean;
  iconUrl?: string;
  workspaceBaseBranch?: string;
  gitStatus?: {
    branch?: string;
    dirty?: boolean;
    ahead?: number;
    behind?: number;
  };
}

interface HostBannerInfo {
  id: string;
  hostname: string;
  displayName: string;
  isLocal: boolean;
}

function resolveOptional<T>(
  v: unknown,
  state: Record<string, unknown>,
): T | null {
  if (!v) return null;
  if (isRef(v)) {
    const r = resolvePointer(state, v.$ref);
    return (r as T) ?? null;
  }
  return v as T;
}

interface RecentSession {
  id: string;
  label: string;
  lastModified?: string;
  cwd?: string;
}

interface ExtraCard {
  id: string;
  type: string;
  props?: Record<string, unknown>;
}

interface WorkspaceLite {
  id: string;
  label: string;
  branch?: string;
  path: string;
}

interface HostStartupConfig {
  startup?: {
    autoApprove?: boolean;
  };
}

function isRef(v: unknown): v is { $ref: string } {
  return typeof v === "object" && v !== null && "$ref" in v;
}

function resolveArray<T>(v: unknown, state: Record<string, unknown>): T[] {
  if (!v) return [];
  if (isRef(v)) {
    const r = resolvePointer(state, v.$ref);
    return Array.isArray(r) ? (r as T[]) : [];
  }
  return Array.isArray(v) ? (v as T[]) : [];
}

export function ProjectsDashboard({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const [hostStartupAutoApprove, setHostStartupAutoApprove] = useState<
    boolean | null
  >(null);
  const [hostStartupSaving, setHostStartupSaving] = useState(false);
  const [hostStartupError, setHostStartupError] = useState<string | null>(null);
  const props = component.props as
    | {
        projects?: unknown;
        recentSessions?: unknown;
        extraCards?: unknown;
        host?: unknown;
        title?: string;
        subtitle?: string;
      }
    | undefined;

  const projects = useMemo(
    () => resolveArray<ProjectListItem>(props?.projects, state),
    [props?.projects, state],
  );
  const host = useMemo(
    () => resolveOptional<HostBannerInfo>(props?.host, state),
    [props?.host, state],
  );
  const recentSessions = useMemo(
    () => resolveArray<RecentSession>(props?.recentSessions, state),
    [props?.recentSessions, state],
  );
  const extraCards = useMemo(
    () => resolveArray<ExtraCard>(props?.extraCards, state),
    [props?.extraCards, state],
  );
  const workspacesByProject = useMemo(() => {
    const sidebarProjects =
      (
        state.sidebar as
          | { projects?: Array<{ id?: string; workspaces?: WorkspaceLite[] }> }
          | undefined
      )?.projects ?? [];
    const byProject: Record<string, WorkspaceLite[]> = {};
    for (const project of sidebarProjects) {
      if (!project.id || !Array.isArray(project.workspaces)) continue;
      byProject[project.id] = project.workspaces;
    }
    return byProject;
  }, [state.sidebar]);
  const showHostStartupPolicy = host?.isLocal === true;

  useEffect(() => {
    if (!showHostStartupPolicy) {
      queueMicrotask(() => {
        setHostStartupAutoApprove(null);
        setHostStartupError(null);
      });
      return;
    }
    let cancelled = false;
    void (async () => {
      setHostStartupAutoApprove(null);
      setHostStartupError(null);
      try {
        const config = await invoke<HostStartupConfig>("read_config");
        if (!cancelled) {
          setHostStartupAutoApprove(config.startup?.autoApprove === true);
        }
      } catch (err) {
        if (!cancelled) setHostStartupError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showHostStartupPolicy]);

  const setHostStartupPolicy = async (enabled: boolean) => {
    setHostStartupSaving(true);
    setHostStartupError(null);
    try {
      await writeConfigPatch({ startup: { autoApprove: enabled } });
      clearConfigCache();
      setHostStartupAutoApprove(enabled);
    } catch (err) {
      setHostStartupError(String(err));
    } finally {
      setHostStartupSaving(false);
    }
  };

  return (
    <div className="a2ui-projects-dashboard">
      <div className="a2ui-projects-dashboard-card">
        {host && (
          <div className="a2ui-host-banner" data-host-id={host.id}>
            <span className="a2ui-host-banner-dot" aria-hidden="true" />
            <span className="a2ui-host-banner-text">
              <strong>{host.displayName || host.hostname}</strong>
              <span className="a2ui-host-banner-hint">
                {host.isLocal ? "this mac" : host.hostname}
              </span>
            </span>
          </div>
        )}
        <div className="a2ui-projects-dashboard-hero" aria-hidden="true">
          <AeMarkInline size={56} radius={12} />
        </div>
        <h1 className="a2ui-projects-dashboard-title">
          {props?.title ?? "Projects"}
        </h1>
        <p className="a2ui-projects-dashboard-subtitle">
          {props?.subtitle ??
            "Pick a project to keep working, or start something new."}
        </p>
        <div className="a2ui-projects-dashboard-actions">
          <button
            type="button"
            className="a2ui-projects-dashboard-primary"
            onClick={() => onEvent("open-project")}
          >
            Open Project…
          </button>
          <button
            type="button"
            className="a2ui-projects-dashboard-secondary"
            onClick={() => onEvent("new-tab")}
          >
            New Tab
          </button>
        </div>
        {projects.length > 0 && (
          <section className="a2ui-projects-dashboard-section">
            <RegistryComponent
              type="task-launcher"
              state={state}
              onEvent={(_component, eventType, data) =>
                onEvent(eventType, data, "projects-dashboard-launcher")
              }
              componentProps={{
                project: projects[0],
                projects,
                workspacesByProject,
                showProjectSelector: true,
                defaultTarget: "host",
                placeholder:
                  "Start a task on this host… choose a project, use @<subagent> or @path",
              }}
            />
          </section>
        )}
        {showHostStartupPolicy && (
          <section className="a2ui-projects-dashboard-section a2ui-project-dashboard-startup-policy a2ui-projects-dashboard-startup-policy">
            <label className="a2ui-project-dashboard-startup-checkbox">
              <input
                type="checkbox"
                checked={hostStartupAutoApprove === true}
                disabled={hostStartupSaving || hostStartupAutoApprove === null}
                onChange={(event) =>
                  void setHostStartupPolicy(event.currentTarget.checked)
                }
              />
              <span className="a2ui-project-dashboard-startup-label">
                Auto-approve startup commands on this host
              </span>
            </label>
            <span className="a2ui-project-dashboard-startup-hint">
              {hostStartupError ??
                "Applies to all projects using this host's Aethon config"}
            </span>
          </section>
        )}
        {projects.length > 0 && (
          <section className="a2ui-projects-dashboard-section">
            <h2>Recent projects</h2>
            <div className="a2ui-projects-dashboard-grid">
              {projects.map((p) => (
                // Route through RegistryComponent (NOT the direct
                // `<ProjectCard>` import) so an extension that calls
                // `aethon.registerComponent("project-card", Custom)`
                // can replace tiles globally. The "overrideable by
                // type string" contract has to hold here or the
                // override-everything story breaks on the most
                // visible surface in the app.
                <RegistryComponent
                  key={p.id}
                  type="project-card"
                  state={state}
                  onEvent={(_component, eventType, data) =>
                    onEvent(eventType, data, `project-card-${p.id}`)
                  }
                  componentProps={{
                    project: p,
                    active: p.active === true,
                  }}
                />
              ))}
              {extraCards.map((card) => (
                <RegistryComponent
                  key={card.id}
                  type={card.type}
                  state={state}
                  onEvent={(_component, eventType, data) =>
                    onEvent(eventType, data, card.id)
                  }
                  componentProps={card.props ?? {}}
                />
              ))}
            </div>
          </section>
        )}
        {recentSessions.length > 0 && (
          <section className="a2ui-projects-dashboard-section">
            <h2>Recent sessions</h2>
            <ul className="a2ui-projects-dashboard-sessions">
              {recentSessions.slice(0, 6).map((s) => (
                <DashboardSessionRow
                  key={s.id}
                  session={s}
                  classPrefix="a2ui-projects-dashboard"
                  onRestore={() =>
                    onEvent(
                      "restore-session",
                      { sessionId: s.id, label: s.label, cwd: s.cwd },
                      s.id,
                    )
                  }
                  onDelete={() =>
                    onEvent(
                      "delete-session",
                      { sessionId: s.id, label: s.label, confirmed: true },
                      s.id,
                    )
                  }
                />
              ))}
            </ul>
          </section>
        )}
        <section className="a2ui-projects-dashboard-section">
          <RegistryComponent
            type="subagents-config"
            state={state}
            onEvent={(_component, eventType, data) =>
              onEvent(eventType, data, "subagents-config")
            }
            componentProps={{ scope: "user" }}
          />
        </section>
      </div>
    </div>
  );
}
