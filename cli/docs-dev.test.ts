import { execFile } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function hasLsof(): Promise<boolean> {
  try {
    await execFileAsync("sh", ["-c", "command -v lsof"]);
    return true;
  } catch {
    return false;
  }
}

function listenLoopback(port: number) {
  const server = createServer();

  return new Promise<{ port: number; close: () => Promise<void> }>(
    (resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address() as AddressInfo;
        resolve({
          port: address.port,
          close: () =>
            new Promise<void>((closeResolve, closeReject) => {
              server.close((error) =>
                error ? closeReject(error) : closeResolve(),
              );
            }),
        });
      });
    },
  );
}

describe("docs dev helper", () => {
  it("is the devshell entrypoint for docs", async () => {
    const flake = await readFile("flake.nix", "utf8");

    expect(flake).toContain("exec ./scripts/docs-dev.sh");
  });

  it("fails before launch when localhost would be shadowed", async () => {
    if (!(await hasLsof())) {
      return;
    }

    const server = await listenLoopback(0);

    try {
      await expect(
        execFileAsync("bash", ["scripts/docs-dev.sh"], {
          env: {
            ...process.env,
            AETHON_DOCS_PORT: String(server.port),
            AETHON_DOCS_PRECHECK_ONLY: "1",
          },
        }),
      ).rejects.toMatchObject({
        // `.rejects` is untyped (`any`), so the matcher's `any` return would
        // trip @typescript-eslint/no-unsafe-assignment; type it as the string
        // field it stands in for (runtime value is still the matcher).
        stderr: expect.stringContaining(
          "is shadowed by a loopback-only listener",
        ) as unknown as string,
      });
    } finally {
      await server.close();
    }
  });

  it("keeps the committed docs dashboard free of the token gate", async () => {
    const dashboardRoot = "website/public/dashboard";
    const html = await readFile(`${dashboardRoot}/index.html`, "utf8");
    const assets = await readdir(`${dashboardRoot}/assets`);
    const jsAssets = assets.filter((asset) => asset.endsWith(".js"));
    const jsBodies = await Promise.all(
      jsAssets.map((asset) =>
        readFile(`${dashboardRoot}/assets/${asset}`, "utf8"),
      ),
    );
    const bundledText = [html, ...jsBodies].join("\n");

    expect(bundledText).not.toContain("Access Token Required");
    expect(bundledText).not.toContain("Paste token here");
  });
});
