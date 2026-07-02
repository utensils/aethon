// useHostInfo — local + LAN-discovered Aethon hosts.
//
// On mount the hook resolves the local host via `host_info` IPC and
// subscribes to the Rust mDNS browser events. Remote hosts join + leave
// the `hosts` list as their announcements come in. The Rust side
// already debounces, so we just maintain a Map keyed by id and emit a
// stable derived list `[local, ...remotes]`.

import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getLocalHost, type Host } from "../hosts";
import {
  remoteDevicesList,
  remoteHostProjectSnapshot,
  remoteHostsList,
  type RemoteDevice,
  type RemoteHost,
} from "../services/remote";

export interface RemoteWorkspaceMirror {
  id: string;
  remoteId: string;
  projectId: string;
  remoteProjectId: string;
  label: string;
  branch?: string | null;
  path: string;
  createdAt?: number;
  active: boolean;
  isMain?: boolean;
  locked?: boolean;
}

export interface RemoteProjectMirror {
  id: string;
  remoteId: string;
  hostId: string;
  label: string;
  tooltip: string;
  path: string;
  active: boolean;
  expanded: boolean;
  workspaces: RemoteWorkspaceMirror[];
}

export interface UseHostInfo {
  hosts: Host[];
  mobileDevices: Host[];
  activeHostId: string | null;
  /** Stable across renders — wire directly into event-route ctx without
   *  needing a ref bridge. */
  setActiveHost: (id: string | null) => void;
  localHostId: string | null;
  remoteProjectsByHost: Record<string, RemoteProjectMirror[]>;
}

export function useHostInfo(): UseHostInfo {
  const [localHost, setLocalHost] = useState<Host | null>(null);
  const remotesRef = useRef<Map<string, Host>>(new Map());
  const pairedHostsRef = useRef<Map<string, Host>>(new Map());
  const devicesRef = useRef<Map<string, Host>>(new Map());
  const [remotes, setRemotes] = useState<Host[]>([]);
  const [pairedHosts, setPairedHosts] = useState<Host[]>([]);
  const [devices, setDevices] = useState<Host[]>([]);
  const [remoteProjectsByHost, setRemoteProjectsByHost] = useState<
    Record<string, RemoteProjectMirror[]>
  >({});
  const [activeHostId, setActiveHostState] = useState<string | null>(null);

  function emitRemotes(): void {
    setRemotes(Array.from(remotesRef.current.values()));
  }

  function emitDevices(): void {
    setDevices(Array.from(devicesRef.current.values()));
  }

  function emitPairedHosts(): void {
    setPairedHosts(Array.from(pairedHostsRef.current.values()));
  }

  function pairedHost(remote: RemoteHost): Host {
    return {
      id: remote.id,
      hostId: remote.hostId,
      hostname: remote.hostname,
      displayName: remote.displayName,
      isLocal: false,
      fingerprint: remote.fingerprint,
      fingerprintPrefix: remote.fingerprint,
      candidates: remote.candidates,
      paired: true,
      connected: remotesRef.current.has(remote.id),
      createdAt: remote.createdAt,
      lastSeen: remote.lastSeenAt,
    };
  }

  function deviceHost(device: RemoteDevice): Host | null {
    if (!device.id || device.revoked || device.platform === "desktop") return null;
    const platform = device.platform || "mobile";
    return {
      id: `device:${device.id}`,
      hostname: platform,
      displayName: device.name || platform,
      isLocal: false,
      paired: true,
      connected: device.connected === true,
      createdAt: device.createdAt,
      lastSeen: device.lastSeenAt,
    };
  }

  function hostsEqual(a: Host[], b: Host[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((host, index) => {
      const other = b[index];
      return (
        other &&
        host.id === other.id &&
        host.hostId === other.hostId &&
        host.hostname === other.hostname &&
        host.displayName === other.displayName &&
        host.isLocal === other.isLocal &&
        host.paired === other.paired &&
        host.connected === other.connected &&
        host.discovered === other.discovered &&
        host.createdAt === other.createdAt &&
        host.lastSeen === other.lastSeen
      );
    });
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const local = await getLocalHost();
      if (cancelled) return;
      setLocalHost(local);
      // Default the active host to local on first paint.
      if (local) {
        setActiveHostState((prev) => prev ?? local.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let off: UnlistenFn[] = [];
    let cancelled = false;
    void (async () => {
      try {
        const offDiscovered = await listen<Host>("host-discovered", (event) => {
          const host = event.payload;
          if (!host?.id) return;
          remotesRef.current.set(host.id, {
            ...host,
            isLocal: false,
            discovered: true,
            candidates:
              Array.isArray(host.candidates) && host.candidates.length > 0
                ? host.candidates
                : host.port
                  ? [`${host.hostname}:${host.port}`]
                  : undefined,
          });
          const paired = pairedHostsRef.current.get(host.id);
          if (paired) {
            pairedHostsRef.current.set(host.id, {
              ...paired,
              hostname: host.hostname,
              candidates: host.candidates ?? paired.candidates,
              connected: true,
              lastSeen: host.lastSeen ?? paired.lastSeen,
            });
            emitPairedHosts();
          }
          emitRemotes();
        });
        const offRemoved = await listen<{ id: string }>("host-removed", (event) => {
          const id = event.payload?.id;
          if (!id) return;
          if (remotesRef.current.delete(id)) {
            const paired = pairedHostsRef.current.get(id);
            if (paired) {
              pairedHostsRef.current.set(id, { ...paired, connected: false });
              emitPairedHosts();
            }
            emitRemotes();
            setActiveHostState((prev) => (prev === id ? localHost?.id ?? null : prev));
          }
        });
        if (cancelled) {
          offDiscovered();
          offRemoved();
          return;
        }
        off = [offDiscovered, offRemoved];
      } catch {
        // Running outside Tauri (tests, plain browser) — no events flow.
      }
    })();
    return () => {
      cancelled = true;
      for (const fn of off) fn();
    };
  }, [localHost?.id]);

  useEffect(() => {
    let cancelled = false;

    async function refreshRemoteHosts(): Promise<void> {
      try {
        const list = await remoteHostsList();
        if (cancelled || !Array.isArray(list)) return;
        const next = new Map<string, Host>();
        for (const remote of list) {
          if (!remote.id) continue;
          next.set(remote.id, pairedHost(remote));
        }
        const nextHosts = Array.from(next.values());
        if (!hostsEqual(Array.from(pairedHostsRef.current.values()), nextHosts)) {
          pairedHostsRef.current = next;
          emitPairedHosts();
        }
        void refreshRemoteProjectSnapshots(Array.from(next.keys()));
      } catch {
        // A fresh install or tests may not have the command available yet.
      }
    }

    async function refreshRemoteProjectSnapshots(hostIds: string[]): Promise<void> {
      const entries = await Promise.all(
        hostIds.map(async (hostId) => {
          try {
            const snapshot = await remoteHostProjectSnapshot(hostId);
            return [hostId, projectMirrorsFromSnapshot(hostId, snapshot.projects)] as const;
          } catch {
            return [hostId, []] as const;
          }
        }),
      );
      if (cancelled) return;
      setRemoteProjectsByHost(Object.fromEntries(entries));
    }

    void refreshRemoteHosts();
    let off: UnlistenFn | null = null;
    void listen("remote-hosts-changed", () => {
      void refreshRemoteHosts();
    })
      .then((fn) => {
        if (cancelled) fn();
        else off = fn;
      })
      .catch(() => {});
    const timer = window.setInterval(refreshRemoteHosts, 30_000);
    return () => {
      cancelled = true;
      off?.();
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function refreshDevices(): Promise<void> {
      try {
        const list = await remoteDevicesList();
        if (cancelled || !Array.isArray(list)) return;
        const next = new Map<string, Host>();
        for (const device of list) {
          const host = deviceHost(device);
          if (host) next.set(host.id, host);
        }
        const nextHosts = Array.from(next.values());
        if (!hostsEqual(Array.from(devicesRef.current.values()), nextHosts)) {
          devicesRef.current = next;
          emitDevices();
        }
      } catch {
        // Transient IPC failure (server restart, teardown) — keep the
        // last-known list rather than blanking the sidebar section; the
        // next event/poll tick reconciles.
      }
    }
    void refreshDevices();
    let off: UnlistenFn | null = null;
    void listen("remote-devices-changed", () => {
      void refreshDevices();
    })
      .then((fn) => {
        if (cancelled) fn();
        else off = fn;
      })
      .catch(() => {
        // Running outside Tauri (tests, plain browser) — fallback poll below.
      });
    const timer = window.setInterval(refreshDevices, 30_000);
    return () => {
      cancelled = true;
      off?.();
      window.clearInterval(timer);
    };
  }, []);

  const hosts: Host[] = [
    ...(localHost ? [localHost] : []),
    ...pairedHosts,
    ...remotes.filter((remote) => !pairedHostsRef.current.has(remote.id)),
  ];
  const setActiveHost = useCallback((id: string | null) => {
    setActiveHostState(id);
  }, []);

  return {
    hosts,
    mobileDevices: devices,
    activeHostId,
    setActiveHost,
    localHostId: localHost?.id ?? null,
    remoteProjectsByHost,
  };
}

function projectMirrorsFromSnapshot(
  hostId: string,
  snapshot: unknown,
): RemoteProjectMirror[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const doc = snapshot as {
    projects?: Array<{
      id?: unknown;
      label?: unknown;
      path?: unknown;
      uiExpanded?: unknown;
      workspaceSortMode?: unknown;
    }>;
    workspacesByProject?: Record<string, unknown>;
    worktreesByProject?: Record<string, unknown>;
  };
  const projects = Array.isArray(doc.projects) ? doc.projects : [];
  const byProject =
    doc.workspacesByProject && typeof doc.workspacesByProject === "object"
      ? doc.workspacesByProject
      : doc.worktreesByProject && typeof doc.worktreesByProject === "object"
        ? doc.worktreesByProject
        : {};
  return projects
    .filter(
      (p): p is { id: string; label: string; path: string; uiExpanded?: unknown } =>
        typeof p.id === "string" &&
        typeof p.label === "string" &&
        typeof p.path === "string",
    )
    .map((project) => {
      const projectId = `${hostId}::project::${project.id}`;
      const rawWorkspaces = Array.isArray(byProject[project.id])
        ? (byProject[project.id] as Array<Record<string, unknown>>)
        : [];
      const workspaces = rawWorkspaces
        .filter(
          (w): w is {
            id: string;
            path: string;
            label?: string;
            branch?: string | null;
            createdAt?: number;
            isMain?: boolean;
            locked?: boolean;
          } => typeof w.id === "string" && typeof w.path === "string",
        )
        .map((workspace) => ({
          id: `${hostId}::workspace::${workspace.id}`,
          remoteId: workspace.id,
          projectId,
          remoteProjectId: project.id,
          label: workspace.label ?? workspace.branch ?? "workspace",
          branch: workspace.branch,
          path: workspace.path,
          createdAt: workspace.createdAt,
          active: false,
          isMain: workspace.isMain,
          locked: workspace.locked,
        }));
      return {
        id: projectId,
        remoteId: project.id,
        hostId,
        label: project.label,
        tooltip: project.path,
        path: project.path,
        active: false,
        expanded: project.uiExpanded === true,
        workspaces,
      };
    });
}
