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
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { resolvePointer } from "../../../utils/jsonPointer";
import { formatRelativeTime } from "../../../utils/time";
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
  hostId?: string;
  hostname: string;
  displayName: string;
  isLocal: boolean;
  fingerprint?: string;
  candidates?: string[];
  paired?: boolean;
  connected?: boolean;
  discovered?: boolean;
  createdAt?: number;
  lastSeen?: number;
  port?: number;
  projectStatus?: {
    state?: "syncing" | "ready" | "error";
    error?: string;
    updatedAt?: number;
  };
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

function formatDateTime(ms?: number): string | null {
  if (!ms) return null;
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function statusText(host: HostBannerInfo): string {
  if (host.projectStatus?.state === "syncing") return "Syncing";
  if (host.projectStatus?.state === "error") return "Sync failed";
  if (host.connected) return "Connected";
  if (host.paired) return "Paired";
  if (host.discovered) return "Available on LAN";
  return "Remote";
}

function recentlySeen(host: HostBannerInfo): boolean {
  return Boolean(host.lastSeen && Date.now() - host.lastSeen < 120_000);
}

function reachabilityText(host: HostBannerInfo): string {
  if (host.projectStatus?.state === "syncing") return "Loading remote projects";
  if (host.projectStatus?.state === "error")
    return "Remote project sync failed";
  if (host.connected) return "Event stream connected";
  if (host.discovered) return "Reachable on LAN";
  if (recentlySeen(host)) return "Recently seen on LAN";
  if (host.paired) return "Not currently advertised";
  return "Discovered";
}

function remoteProjectsEmptyState(host: HostBannerInfo): {
  title: string;
  body: string;
} {
  if (host.projectStatus?.state === "syncing") {
    return {
      title: "Syncing remote projects",
      body: "Waiting for the paired host to return its project snapshot.",
    };
  }
  if (host.projectStatus?.state === "error") {
    return {
      title: "Remote projects unavailable",
      body:
        host.projectStatus.error ||
        "Aethon could not fetch the project snapshot from this host.",
    };
  }
  return {
    title: "No remote projects",
    body: "This host returned an empty project snapshot.",
  };
}

function candidateKey(candidate: string): string {
  const trimmed = candidate.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 0 ? trimmed.slice(0, end + 1) : trimmed;
  }
  const [host] = trimmed.split(":");
  return host || trimmed;
}

function isNoisyCandidate(candidate: string): boolean {
  return candidate.trim().startsWith("[");
}

function primaryCandidates(candidates: string[]): string[] {
  const latestByHost = new Map<string, string>();
  for (const candidate of candidates) {
    if (isNoisyCandidate(candidate)) continue;
    latestByHost.set(candidateKey(candidate), candidate);
  }
  return Array.from(latestByHost.values()).slice(0, 8);
}

function CandidateList({
  candidates,
  copiedCandidate,
  onCopy,
  primary = false,
}: {
  candidates: string[];
  copiedCandidate: string | null;
  onCopy: (candidate: string) => void;
  primary?: boolean;
}) {
  return (
    <ul
      className={[
        "a2ui-host-candidates",
        primary ? "a2ui-host-candidates--primary" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {candidates.map((candidate, index) => (
        <li key={`${candidate}-${index}`}>
          <button
            type="button"
            className="a2ui-host-candidate-copy"
            onClick={() => onCopy(candidate)}
            title="Copy address"
          >
            <code>{candidate}</code>
            {copiedCandidate === candidate && (
              <span className="a2ui-host-candidate-copied">Copied</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function RemoteHostDetails({ host }: { host: HostBannerInfo }) {
  const [copiedCandidate, setCopiedCandidate] = useState<string | null>(null);
  const copiedResetTimerRef = useRef<number | null>(null);
  const candidates = Array.isArray(host.candidates) ? host.candidates : [];
  const primary = primaryCandidates(candidates);
  const primarySet = new Set(primary);
  const rawCandidates = candidates.filter(
    (candidate) => !primarySet.has(candidate),
  );
  const pairedAt = formatDateTime(host.createdAt);
  const lastSeenAt = formatDateTime(host.lastSeen);

  useEffect(() => {
    return () => {
      if (copiedResetTimerRef.current !== null) {
        window.clearTimeout(copiedResetTimerRef.current);
        copiedResetTimerRef.current = null;
      }
    };
  }, []);

  const copyCandidate = async (candidate: string) => {
    try {
      if (!navigator.clipboard) return;
      await navigator.clipboard.writeText(candidate);
      setCopiedCandidate(candidate);
      if (copiedResetTimerRef.current !== null) {
        window.clearTimeout(copiedResetTimerRef.current);
        copiedResetTimerRef.current = null;
      }
      copiedResetTimerRef.current = window.setTimeout(() => {
        copiedResetTimerRef.current = null;
        setCopiedCandidate((current) =>
          current === candidate ? null : current,
        );
      }, 1200);
    } catch {
      // Clipboard permission can be denied; keep the address visible
      // without claiming it was copied.
    }
  };
  return (
    <section className="a2ui-host-details" aria-label="Remote host details">
      <div className="a2ui-host-details-head">
        <div>
          <h2>Remote host</h2>
          <p>{reachabilityText(host)}</p>
        </div>
        <span
          className={[
            "a2ui-host-details-status",
            host.connected
              ? "a2ui-host-details-status--connected"
              : host.projectStatus?.state === "error"
                ? "a2ui-host-details-status--error"
                : host.discovered
                  ? "a2ui-host-details-status--reachable"
                  : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {statusText(host)}
        </span>
      </div>
      <dl className="a2ui-host-details-grid">
        <div>
          <dt>Hostname</dt>
          <dd>{host.hostname}</dd>
        </div>
        {host.hostId && (
          <div>
            <dt>Host ID</dt>
            <dd>{host.hostId}</dd>
          </div>
        )}
        {pairedAt && (
          <div>
            <dt>Paired on</dt>
            <dd>{pairedAt}</dd>
          </div>
        )}
        {lastSeenAt && (
          <div>
            <dt>Last seen</dt>
            <dd>
              {lastSeenAt}
              <span className="a2ui-host-details-muted">
                {" "}
                ({formatRelativeTime(host.lastSeen ?? 0)})
              </span>
            </dd>
          </div>
        )}
        {host.port && (
          <div>
            <dt>Advertised port</dt>
            <dd>{host.port}</dd>
          </div>
        )}
        {host.fingerprint && (
          <div className="a2ui-host-details-wide">
            <dt>Fingerprint</dt>
            <dd>
              <code>{host.fingerprint}</code>
            </dd>
          </div>
        )}
        {candidates.length > 0 && (
          <div className="a2ui-host-details-wide">
            <dt>Primary connection candidates</dt>
            <dd>
              <CandidateList
                candidates={
                  primary.length > 0 ? primary : candidates.slice(0, 8)
                }
                copiedCandidate={copiedCandidate}
                onCopy={copyCandidate}
                primary
              />
              {rawCandidates.length > 0 && (
                <details className="a2ui-host-candidates-raw">
                  <summary>
                    Show {rawCandidates.length} raw alternate candidate
                    {rawCandidates.length === 1 ? "" : "s"}
                  </summary>
                  <CandidateList
                    candidates={rawCandidates}
                    copiedCandidate={copiedCandidate}
                    onCopy={copyCandidate}
                  />
                </details>
              )}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
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
  const showOpenProject = host?.isLocal !== false;
  const remoteHostOverview = host?.isLocal === false;
  const visibleRecentSessions = remoteHostOverview ? [] : recentSessions;
  const remoteEmptyState =
    remoteHostOverview && host && projects.length === 0
      ? remoteProjectsEmptyState(host)
      : null;

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
        {remoteHostOverview && host && <RemoteHostDetails host={host} />}
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
          {showOpenProject && (
            <button
              type="button"
              className="a2ui-projects-dashboard-primary"
              onClick={() => onEvent("open-project")}
            >
              Open Project…
            </button>
          )}
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
        {remoteEmptyState && (
          <section className="a2ui-projects-dashboard-section a2ui-remote-projects-empty">
            <h2>{remoteEmptyState.title}</h2>
            <p>{remoteEmptyState.body}</p>
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
        {visibleRecentSessions.length > 0 && (
          <section className="a2ui-projects-dashboard-section">
            <h2>Recent sessions</h2>
            <ul className="a2ui-projects-dashboard-sessions">
              {visibleRecentSessions.slice(0, 6).map((s) => (
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
        {!remoteHostOverview && (
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
        )}
      </div>
    </div>
  );
}
