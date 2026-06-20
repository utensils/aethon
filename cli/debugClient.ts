import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";

export interface DebugClientOptions {
  port?: number;
  host?: string;
  home?: string;
  tmpdir?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface DevInfo {
  debugPort?: number;
  vitePort?: number;
  pid?: number;
  [key: string]: unknown;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 19433;

export function readDevInfo(path: string): DevInfo | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DevInfo;
  } catch {
    return null;
  }
}

export function resolveDevInfoPath(options: DebugClientOptions = {}): string | null {
  const home = options.home ?? process.env.HOME ?? "";
  const tmpdir = options.tmpdir ?? process.env.TMPDIR ?? "/tmp";
  const conventional = join(home, ".aethon", "dev-info.json");
  if (existsSync(conventional)) return conventional;

  const sandboxRoot = join(tmpdir, "aethon-dev");
  if (!existsSync(sandboxRoot)) return null;
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const entry of readdirSync(sandboxRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("new-")) continue;
    const candidate = join(sandboxRoot, entry.name, "dev-info.json");
    if (!existsSync(candidate)) continue;
    const mtimeMs = statSync(candidate).mtimeMs;
    if (!newest || mtimeMs > newest.mtimeMs) newest = { path: candidate, mtimeMs };
  }
  return newest?.path ?? null;
}

export function resolveDebugPort(options: DebugClientOptions = {}): number {
  if (options.port && Number.isFinite(options.port)) return options.port;
  const env = options.env ?? process.env;
  const envPort = Number(env.AETHON_DEBUG_PORT);
  if (Number.isInteger(envPort) && envPort > 0) return envPort;
  const devInfoPath = resolveDevInfoPath(options);
  const devInfo = devInfoPath ? readDevInfo(devInfoPath) : null;
  const infoPort = devInfo?.debugPort;
  return typeof infoPort === "number" && Number.isInteger(infoPort) && infoPort > 0
    ? infoPort
    : DEFAULT_PORT;
}

export class AethonDebugClient {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(options: DebugClientOptions = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    this.port = resolveDebugPort(options);
    this.timeoutMs = options.timeoutMs ?? 12_000;
  }

  eval(js: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        "python3",
        [
          "-c",
          `
import socket, sys
s = socket.socket()
s.settimeout(${JSON.stringify(Math.ceil(this.timeoutMs / 1000))})
try:
    s.connect((${JSON.stringify(this.host)}, ${JSON.stringify(this.port)}))
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(2)
s.sendall(sys.stdin.buffer.read())
s.shutdown(socket.SHUT_WR)
data = b""
while True:
    try:
        chunk = s.recv(4096)
    except socket.timeout:
        break
    if not chunk:
        break
    data += chunk
s.close()
sys.stdout.buffer.write(data)
`,
        ],
        { maxBuffer: 64 * 1024 * 1024, timeout: this.timeoutMs },
        (err, stdout, stderr) => {
          if (err) {
            reject(
              new Error(
                `could not talk to Aethon debug server on ${this.host}:${this.port}: ${
                  stderr || err.message
                }`,
              ),
            );
            return;
          }
          resolve(stdout.trimEnd());
        },
      );
      child.stdin?.end(js);
    });
  }

  async evalJson<T = unknown>(js: string): Promise<T> {
    const raw = await this.eval(js);
    if (raw.startsWith("ERROR:")) throw new Error(raw.slice("ERROR:".length).trim());
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new Error(`Aethon returned non-JSON output: ${String(err)}\n${raw}`, {
        cause: err,
      });
    }
  }

  async invoke<T = unknown>(command: string, args: unknown = {}): Promise<T> {
    const raw = await this.eval(invokeJs(command, args));
    if (raw.startsWith("ERROR:")) throw new Error(raw.slice("ERROR:".length).trim());
    if (raw === "" || raw === "undefined") return undefined as T;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as T;
    }
  }
}

export function invokeJs(command: string, args: unknown = {}): string {
  return `
const invoke = window.__AETHON_INVOKE__ || window.__TAURI_INTERNALS__?.invoke;
if (!invoke) throw new Error("Aethon debug invoke hook is not available");
const result = await invoke(${JSON.stringify(command)}, ${JSON.stringify(args)});
return result;
`;
}
