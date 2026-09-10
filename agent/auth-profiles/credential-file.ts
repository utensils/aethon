import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Persist an API key into a profile's `auth.json` using pi's on-disk
 * credential format (`Record<providerId, Credential>`).
 *
 * pi >= 0.80.8 removed the credential setter from the SDK surface; the
 * runtime's file-backed store re-reads the file whenever its revision
 * changes, so writing the same shape pi writes is enough for the profile's
 * `ModelRuntime` to pick the key up on its next auth resolution.
 */
export function writeProfileApiKey(
  authPath: string | undefined,
  providerId: string,
  key: string,
): void {
  if (!authPath) {
    throw new Error("writeProfileApiKey: profile has no auth path");
  }
  mkdirSync(dirname(authPath), { recursive: true });
  const current = readCredentialFile(authPath);
  current[providerId] = { type: "api_key", key };
  const tmp = `${authPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(current, null, 2), { mode: 0o600 });
  renameSync(tmp, authPath);
}

function readCredentialFile(authPath: string): Record<string, unknown> {
  if (!existsSync(authPath)) return {};
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(authPath, "utf8").replace(/^\uFEFF/, ""),
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
