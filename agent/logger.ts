/**
 * Tiny structured logger for the bridge.
 *
 * Two sinks:
 *   1. stderr — picked up live by the Rust supervisor and forwarded
 *      under the `aethon::agent::stderr` tracing target. The dev
 *      terminal sees these in real time.
 *   2. `~/.aethon/logs/bridge.YYYY-MM-DD.log` — daily-rotating file
 *      so a release user troubleshooting an issue can grep history
 *      without needing to be in the dev terminal at the time.
 *
 * The bridge writes JSON IPC frames to stdout — those MUST stay clean,
 * so all human-readable log output goes to stderr (and the file).
 *
 * Levels honor `AETHON_LOG` (preferred) or `LOG_LEVEL` env vars; default
 * is `info`. Callers grab a scoped logger once per module
 * (`const log = logger.scope("ext-loader")`) and call `.debug / .info /
 * .warn / .error`. The scope shows up in the formatted line so a flood
 * of "loaded foo.ts" entries is easy to filter.
 *
 * Retention: at module load, files matching `bridge.*` older than
 * `RETENTION_DAYS` are removed. No per-file size limit — daily
 * rotation alone is enough at the bridge's log volume.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveMinLevel(): number {
  const raw = (process.env.AETHON_LOG ?? process.env.LOG_LEVEL ?? "info")
    .toLowerCase()
    .trim() as Level;
  return LEVELS[raw] ?? LEVELS.info;
}

const MIN_LEVEL = resolveMinLevel();
const RETENTION_DAYS = 7;

// Same dir the Rust shell uses, so `ls ~/.aethon/logs/` shows both
// `aethon.YYYY-MM-DD` (Rust supervisor) and `bridge.YYYY-MM-DD.log`
// (this process) side by side. `AETHON_LOG_DIR` overrides the location
// (used by tests, and available for ad-hoc redirection).
const LOG_DIR_OVERRIDE = process.env.AETHON_LOG_DIR;
const LOG_DIR = LOG_DIR_OVERRIDE ?? join(homedir(), ".aethon", "logs");

// The rotating-file sink is disabled under test runs (vitest sets VITEST)
// unless an explicit AETHON_LOG_DIR override is given. The agent runs
// `bunx vitest` via its own bash tool, which loads these modules; without
// this gate those runs append test fixtures to the real
// `~/.aethon/logs/bridge.<date>.log`. stderr still carries every line.
const FILE_SINK_ENABLED = Boolean(LOG_DIR_OVERRIDE) || !process.env.VITEST;

function todayStamp(): string {
  // YYYY-MM-DD in local time. Matches `tracing-appender`'s daily
  // rotation naming convention enough that operators don't have to
  // decode two different schemes.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

let currentDay = todayStamp();
let currentFd: number | null = null;

function openCurrentLog(): number | null {
  if (!FILE_SINK_ENABLED) return null;
  try {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }
    const path = join(LOG_DIR, `bridge.${currentDay}.log`);
    return openSync(path, "a");
  } catch {
    // Fall back to stderr-only — better than crashing the bridge.
    return null;
  }
}

function ensureFd(): number | null {
  if (!FILE_SINK_ENABLED) return null;
  const today = todayStamp();
  if (today !== currentDay) {
    // Rotated past midnight — close the old fd and open today's file.
    if (currentFd !== null) {
      try {
        closeSync(currentFd);
      } catch {
        /* ignore */
      }
      currentFd = null;
    }
    currentDay = today;
  }
  if (currentFd === null) {
    currentFd = openCurrentLog();
  }
  return currentFd;
}

function pruneOldLogs(): void {
  // Best-effort retention sweep. Runs once at module load; daily
  // rotation handles the day-to-day churn.
  if (!FILE_SINK_ENABLED) return;
  try {
    if (!existsSync(LOG_DIR)) return;
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(LOG_DIR)) {
      if (!name.startsWith("bridge.")) continue;
      const path = join(LOG_DIR, name);
      try {
        const s = statSync(path);
        if (s.mtimeMs < cutoff) unlinkSync(path);
      } catch {
        /* skip unreadable entries */
      }
    }
  } catch {
    /* ignore — logging must never throw */
  }
}

pruneOldLogs();

function format(level: Level, scope: string, message: string): string {
  // ISO-8601 with millisecond precision keeps these greppable in
  // forwarded output and sortable across processes.
  const ts = new Date().toISOString();
  // Pad the level to 5 chars so columns line up (`DEBUG`, `INFO `, …).
  const lvl = level.toUpperCase().padEnd(5, " ");
  return `${ts} ${lvl} ${scope}: ${message}`;
}

function write(level: Level, scope: string, message: string): void {
  if (LEVELS[level] < MIN_LEVEL) return;
  const line = format(level, scope, message) + "\n";
  // stderr first — the Rust supervisor splits on lines and forwards.
  process.stderr.write(line);
  // File second — best effort. Failures don't bubble up; we'd rather
  // drop a log line than crash the bridge.
  const fd = ensureFd();
  if (fd !== null) {
    try {
      writeSync(fd, line);
    } catch {
      /* swallow */
    }
  }
}

export interface ScopedLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const logger = {
  scope(name: string): ScopedLogger {
    return {
      debug: (m: string) => write("debug", name, m),
      info: (m: string) => write("info", name, m),
      warn: (m: string) => write("warn", name, m),
      error: (m: string) => write("error", name, m),
    };
  },
};

// Test-only: surface the resolved level so tests can assert filtering.
export const __testing = { MIN_LEVEL, LEVELS };
