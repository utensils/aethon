import type { AethonConfig } from "../../../config";
import { DevshellRefreshControl } from "./devshell-refresh-control";
import { Field, Section, type SettingsUpdate } from "./sections";

export function DevshellSection({
  config,
  state,
  update,
}: {
  config: AethonConfig;
  state: unknown;
  update: SettingsUpdate;
}) {
  return (
    <Section id="devshell" title="Nix devshell">
      <Field label="Detection">
        <select
          className="ae-settings-input"
          value={config.devshell.enabled}
          onChange={(e) =>
            update({
              devshell: {
                ...config.devshell,
                enabled:
                  e.target.value === "always"
                    ? "always"
                    : e.target.value === "never"
                      ? "never"
                      : "auto",
              },
            })
          }
        >
          <option value="auto">Auto (detect flake / direnv / shell.nix)</option>
          <option value="always">Always (require resolver to succeed)</option>
          <option value="never">Never (disable wrapping)</option>
        </select>
      </Field>
      <Field label="Resolver mode">
        <select
          className="ae-settings-input"
          value={config.devshell.mode}
          onChange={(e) =>
            update({
              devshell: {
                ...config.devshell,
                mode:
                  e.target.value === "direnv" ||
                  e.target.value === "nix" ||
                  e.target.value === "nix-shell"
                    ? e.target.value
                    : "auto",
              },
            })
          }
        >
          <option value="auto">
            Auto (direnv when present, else flake, else shell.nix)
          </option>
          <option value="direnv">Force direnv exec</option>
          <option value="nix">Force nix develop (flake)</option>
          <option value="nix-shell">
            Force Nix devshell (flake, legacy alias)
          </option>
        </select>
      </Field>
      <Field label="Cache TTL (hours)">
        <input
          type="number"
          className="ae-settings-input"
          min={0}
          max={4320}
          value={config.devshell.cacheTtlHours}
          onChange={(e) =>
            update({
              devshell: {
                ...config.devshell,
                cacheTtlHours: Math.max(0, parseInt(e.target.value, 10) || 0),
              },
            })
          }
        />
      </Field>
      <Field label="Re-resolve on lockfile change">
        <input
          type="checkbox"
          checked={config.devshell.refreshOnLockfileChange}
          onChange={(e) =>
            update({
              devshell: {
                ...config.devshell,
                refreshOnLockfileChange: e.target.checked,
              },
            })
          }
        />
      </Field>
      <Field label="Active project">
        <DevshellRefreshControl state={state} />
      </Field>
      <p className="ae-settings-note">
        When a project's root contains a <code>flake.nix</code>,{" "}
        <code>shell.nix</code>, or <code>.envrc</code> wiring{" "}
        <code>use_flake</code> / <code>use_nix</code>, Aethon resolves the
        devshell env once per <code>flake.lock</code> hash and applies it to
        every shell tab and the agent's bash tool. Override per project with{" "}
        <code>&lt;project&gt;/.aethon/devshell.toml</code>.
      </p>
    </Section>
  );
}
