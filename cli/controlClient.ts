import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";

export interface ControlInfo {
  protocolVersion: number;
  mode: string;
  socketPath: string;
  tokenPath: string;
  pid: number;
  version: string;
  instanceId: string;
}

export interface ControlClientOptions {
  socketPath?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

export function defaultControlInfoPath(options: ControlClientOptions = {}): string {
  const env = options.env ?? process.env;
  const root = env.AETHON_USER_DIR && env.AETHON_USER_DIR.length > 0
    ? env.AETHON_USER_DIR
    : join(options.home ?? env.HOME ?? ".", ".aethon");
  return join(root, "control", "control.json");
}

export function readControlInfo(options: ControlClientOptions = {}): ControlInfo | undefined {
  const path = defaultControlInfoPath(options);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ControlInfo>;
  if (!parsed.socketPath || !parsed.tokenPath) return undefined;
  return parsed as ControlInfo;
}

export class AethonControlClient {
  readonly info: ControlInfo;
  readonly token: string;

  constructor(options: ControlClientOptions = {}) {
    const info = readControlInfo(options);
    const socketPath = options.socketPath ?? info?.socketPath;
    const tokenPath = info?.tokenPath;
    if (!socketPath || !tokenPath) {
      throw new Error("Aethon control socket not found; is the app running?");
    }
    this.info = {
      protocolVersion: info?.protocolVersion ?? 1,
      mode: info?.mode ?? "local",
      socketPath,
      tokenPath,
      pid: info?.pid ?? 0,
      version: info?.version ?? "",
      instanceId: info?.instanceId ?? "",
    };
    this.token = readFileSync(tokenPath, "utf8").trim();
    if (!this.token) throw new Error(`Aethon control token is empty: ${tokenPath}`);
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const payload = JSON.stringify({ token: this.token, method, params }) + "\n";
    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(this.info.socketPath);
      let buffer = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`control request timed out: ${method}`));
      }, 310_000);
      socket.on("connect", () => {
        socket.write(payload);
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        clearTimeout(timer);
        socket.end();
        try {
          const parsed = JSON.parse(buffer.slice(0, newline)) as {
            ok?: boolean;
            result?: T;
            error?: string;
          };
          if (parsed.ok) {
            resolve(parsed.result as T);
          } else {
            reject(new Error(parsed.error ?? `control request failed: ${method}`));
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.on("close", () => {
        clearTimeout(timer);
        if (buffer.length === 0) {
          reject(new Error(`control socket closed without a response: ${method}`));
        }
      });
    });
  }
}
