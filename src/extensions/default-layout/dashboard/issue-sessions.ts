import type { Tab } from "../../../types/tab";
import type { TabBucket } from "../../../hooks/projectOps/types";

function collectTabs(state: Record<string, unknown>): Tab[] {
  const tabs: Tab[] = [];
  const seen = new Set<string>();
  const collect = (list: readonly Tab[] | undefined) => {
    for (const tab of list ?? []) {
      if (seen.has(tab.id)) continue;
      seen.add(tab.id);
      tabs.push(tab);
    }
  };
  collect((state.tabs as Tab[] | undefined) ?? []);
  const buckets = state.persistedTabBuckets as
    | Record<string, { tabs?: Tab[] }>
    | undefined;
  if (buckets) {
    for (const bucket of Object.values(buckets)) collect(bucket.tabs);
  }
  return tabs;
}

export function issueSessionTabs(
  state: Record<string, unknown>,
  projectId: string,
  issueNumber: number,
): Tab[] {
  return collectTabs(state).filter((tab) => {
    const source = tab.sourceIssue;
    return (
      tab.kind === "agent" &&
      source?.kind === "github-issue" &&
      source.projectId === projectId &&
      source.number === issueNumber
    );
  });
}

export function firstIssueSessionTab(
  state: Record<string, unknown>,
  projectId: string,
  issueNumber: number,
): Tab | null {
  return issueSessionTabs(state, projectId, issueNumber)[0] ?? null;
}

function stripSourceIssue(tab: Tab): Tab {
  const { sourceIssue: _sourceIssue, ...rest } = tab;
  return rest;
}

function clearClosedIssueLinksFromTab(
  tab: Tab,
  projectId: string,
  openIssueNumbers: ReadonlySet<number>,
): Tab {
  const source = tab.sourceIssue;
  if (
    source?.kind !== "github-issue" ||
    source.projectId !== projectId ||
    openIssueNumbers.has(source.number)
  ) {
    return tab;
  }
  return stripSourceIssue(tab);
}

function clearClosedIssueLinksFromBucket(
  bucket: TabBucket,
  projectId: string,
  openIssueNumbers: ReadonlySet<number>,
): TabBucket {
  let changed = false;
  const tabs = bucket.tabs.map((tab) => {
    const next = clearClosedIssueLinksFromTab(tab, projectId, openIssueNumbers);
    if (next !== tab) changed = true;
    return next;
  });
  return changed ? { ...bucket, tabs } : bucket;
}

export function clearClosedIssueLinks(
  state: Record<string, unknown>,
  projectId: string,
  openIssueNumbers: ReadonlySet<number>,
): Record<string, unknown> {
  let changed = false;
  const tabs = ((state.tabs as Tab[] | undefined) ?? []).map((tab) => {
    const next = clearClosedIssueLinksFromTab(tab, projectId, openIssueNumbers);
    if (next !== tab) changed = true;
    return next;
  });

  const persisted = state.persistedTabBuckets as
    | Record<string, TabBucket>
    | undefined;
  let persistedTabBuckets = persisted;
  if (persisted) {
    const nextBuckets: Record<string, TabBucket> = {};
    for (const [key, bucket] of Object.entries(persisted)) {
      const next = clearClosedIssueLinksFromBucket(
        bucket,
        projectId,
        openIssueNumbers,
      );
      if (next !== bucket) changed = true;
      nextBuckets[key] = next;
    }
    persistedTabBuckets = nextBuckets;
  }

  if (!changed) return state;
  return persisted
    ? { ...state, tabs, persistedTabBuckets }
    : { ...state, tabs };
}

export function clearClosedIssueLinksInBuckets(
  buckets: Map<string, TabBucket>,
  projectId: string,
  openIssueNumbers: ReadonlySet<number>,
): boolean {
  let changed = false;
  for (const [key, bucket] of buckets.entries()) {
    const next = clearClosedIssueLinksFromBucket(
      bucket,
      projectId,
      openIssueNumbers,
    );
    if (next === bucket) continue;
    changed = true;
    buckets.set(key, next);
  }
  return changed;
}
