/**
 * subagents-config — the overview editor for configurable subagents.
 *
 * Scope-parameterized via `componentProps`: the project overview mounts it with
 * `{ scope: "project", projectPath }`, the host overview with `{ scope: "user" }`.
 * It owns its Tauri IPC directly (like the gh caches) — `subagents_list` to
 * load, `subagents_write` / `subagents_delete` to mutate. Rust signals the
 * running bridge after each mutation, so a save re-advertises subagents to the
 * agent without a restart.
 *
 * The markdown contract is parsed/serialized by `src/subagents` (mirror of the
 * agent-side parser), so this component never hand-rolls frontmatter.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { resolvePointer } from "../../../utils/jsonPointer";
import {
  isSafeSubagentName,
  parseSubagentContent,
  sanitizeSubagentName,
  serializeSubagent,
  type SubagentFields,
  type SubagentFile,
  type SubagentScope,
  type SubagentSurface,
} from "../../../subagents";
import { MAX_AGENT_TIMEOUT_SECONDS } from "../../../config";

/** Built-in pi tools offered as checkboxes when restricting a subagent. */
const BUILTIN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];

type ToolsMode = "inherit" | "restrict" | "none";

interface Row {
  name: string;
  filePath: string;
  fields: SubagentFields | null;
  error?: string;
}

interface EditorState {
  /** Original name when editing an existing definition; null for a new one. */
  original: string | null;
  name: string;
  description: string;
  model: string;
  toolsMode: ToolsMode;
  tools: string[];
  surface: SubagentSurface;
  timeoutSeconds: string;
  systemPrompt: string;
}

function blankEditor(): EditorState {
  return {
    original: null,
    name: "",
    description: "",
    model: "",
    toolsMode: "inherit",
    tools: [],
    surface: "inline",
    timeoutSeconds: "",
    systemPrompt: "",
  };
}

function editorFromRow(row: Row): EditorState {
  const f = row.fields;
  const toolsMode: ToolsMode =
    f?.tools === undefined
      ? "inherit"
      : f.tools.length === 0
        ? "none"
        : "restrict";
  return {
    original: row.name,
    name: row.name,
    description: f?.description ?? "",
    model: f?.model ?? "",
    toolsMode,
    tools: f?.tools ?? [],
    surface: f?.surface ?? "inline",
    timeoutSeconds:
      typeof f?.timeoutSeconds === "number" ? String(f.timeoutSeconds) : "",
    systemPrompt: f?.systemPrompt ?? "",
  };
}

function editorToFields(editor: EditorState): SubagentFields {
  const tools =
    editor.toolsMode === "inherit"
      ? undefined
      : editor.toolsMode === "none"
        ? []
        : editor.tools;
  return {
    description: editor.description,
    model: editor.model.trim() || undefined,
    tools,
    surface: editor.surface,
    timeoutSeconds: parseEditorTimeout(editor.timeoutSeconds),
    systemPrompt: editor.systemPrompt,
  };
}

function parseEditorTimeout(value: string): number | undefined {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, MAX_AGENT_TIMEOUT_SECONDS)
    : undefined;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SubagentsConfig({ component, state }: BuiltinComponentProps) {
  const props = component.props as
    | { scope?: unknown; projectPath?: unknown }
    | undefined;
  const scope: SubagentScope = props?.scope === "project" ? "project" : "user";
  const projectPath =
    typeof props?.projectPath === "string" ? props.projectPath : undefined;

  const models = useMemo<{ id: string; label: string }[]>(() => {
    const raw = resolvePointer(state, "/sidebar/models");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (m): m is { id: unknown; label?: unknown } =>
          typeof m === "object" && m !== null,
      )
      .map((m) => ({
        id: String(m.id ?? ""),
        label: String(m.label ?? m.id ?? ""),
      }))
      .filter((m) => m.id.length > 0);
  }, [state]);

  const [rows, setRows] = useState<Row[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const files = await invoke<SubagentFile[]>("subagents_list", {
        projectRoot: projectPath ?? null,
      });
      const scoped = files.filter((f) => f.scope === scope);
      setRows(
        scoped.map((f) => {
          const parsed = parseSubagentContent(f.content);
          return {
            name: f.name,
            filePath: f.filePath,
            fields: parsed.fields ?? null,
            error: parsed.error,
          };
        }),
      );
      setError(null);
    } catch (err) {
      setError(`Failed to load subagents: ${errMessage(err)}`);
    }
  }, [scope, projectPath]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load + reload when scope/project changes; reload() fetches over IPC then setState
    void reload();
  }, [reload]);

  const save = useCallback(async () => {
    if (!editor) return;
    const name = sanitizeSubagentName(editor.name);
    if (!isSafeSubagentName(name)) {
      setError(
        "Name must be lowercase letters, digits, - or _ (start alphanumeric).",
      );
      return;
    }
    if (!editor.description.trim()) {
      setError(
        "A description is required — it's how the main agent decides when to delegate.",
      );
      return;
    }
    setBusy(true);
    try {
      const content = serializeSubagent(editorToFields({ ...editor, name }));
      // Write the new definition first; only remove the old name once the new
      // file is safely on disk. A failed write then can't lose the original
      // (worst case leaves a recoverable duplicate, never a gap).
      await invoke("subagents_write", {
        scope,
        name,
        content,
        projectRoot: projectPath ?? null,
      });
      if (editor.original && editor.original !== name) {
        await invoke("subagents_delete", {
          scope,
          name: editor.original,
          projectRoot: projectPath ?? null,
        });
      }
      setEditor(null);
      setError(null);
      await reload();
    } catch (err) {
      setError(`Save failed: ${errMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }, [editor, scope, projectPath, reload]);

  const remove = useCallback(
    async (name: string) => {
      setBusy(true);
      try {
        await invoke("subagents_delete", {
          scope,
          name,
          projectRoot: projectPath ?? null,
        });
        await reload();
      } catch (err) {
        setError(`Delete failed: ${errMessage(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [scope, projectPath, reload],
  );

  const scopeNote =
    scope === "project"
      ? "Project subagents (override your user subagents by name)."
      : "User subagents — available in every project.";

  return (
    <div className="ae-subagents" data-scope={scope}>
      <header className="ae-subagents-head">
        <div className="ae-subagents-head-text">
          <h2 className="ae-subagents-title">Subagents</h2>
          <p className="ae-subagents-note">{scopeNote}</p>
        </div>
        {!editor && (
          <button
            type="button"
            className="ae-subagents-new"
            onClick={() => {
              setError(null);
              setEditor(blankEditor());
            }}
          >
            + New subagent
          </button>
        )}
      </header>

      {error && <div className="ae-subagents-error">{error}</div>}

      {editor ? (
        <SubagentEditor
          editor={editor}
          models={models}
          busy={busy}
          onChange={setEditor}
          onSave={() => void save()}
          onCancel={() => {
            setEditor(null);
            setError(null);
          }}
        />
      ) : rows.length === 0 ? (
        <p className="ae-subagents-empty">
          No subagents yet. Create one to let the main agent delegate focused
          work to a different (e.g. local) model.
        </p>
      ) : (
        <ul className="ae-subagents-list">
          {rows.map((row) => (
            <li
              key={row.name}
              className="ae-subagents-row"
              data-name={row.name}
            >
              <div className="ae-subagents-row-main">
                <span className="ae-subagents-row-name">{row.name}</span>
                <span className="ae-subagents-row-desc">
                  {row.error
                    ? `⚠ ${row.error}`
                    : (row.fields?.description ?? "")}
                </span>
              </div>
              <div className="ae-subagents-row-badges">
                {row.fields?.model && (
                  <span className="ae-subagents-badge">{row.fields.model}</span>
                )}
                {row.fields?.surface === "tab" && (
                  <span className="ae-subagents-badge ae-subagents-badge-tab">
                    tab
                  </span>
                )}
                {typeof row.fields?.timeoutSeconds === "number" && (
                  <span className="ae-subagents-badge">
                    {row.fields.timeoutSeconds}s
                  </span>
                )}
              </div>
              <div className="ae-subagents-row-actions">
                <button
                  type="button"
                  className="ae-subagents-action"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setEditor(editorFromRow(row));
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="ae-subagents-action ae-subagents-action-danger"
                  disabled={busy}
                  onClick={() => void remove(row.name)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SubagentEditor({
  editor,
  models,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  editor: EditorState;
  models: { id: string; label: string }[];
  busy: boolean;
  onChange: (next: EditorState) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = <K extends keyof EditorState>(key: K, value: EditorState[K]) =>
    onChange({ ...editor, [key]: value });

  const toggleTool = (tool: string) => {
    const has = editor.tools.includes(tool);
    onChange({
      ...editor,
      tools: has
        ? editor.tools.filter((t) => t !== tool)
        : [...editor.tools, tool],
    });
  };

  return (
    <div className="ae-subagents-editor">
      <label className="ae-subagents-field">
        <span className="ae-subagents-label">Name</span>
        <input
          type="text"
          className="ae-subagents-input"
          value={editor.name}
          placeholder="reviewer"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => set("name", e.target.value)}
        />
      </label>

      <label className="ae-subagents-field">
        <span className="ae-subagents-label">Description</span>
        <textarea
          className="ae-subagents-textarea"
          rows={2}
          value={editor.description}
          placeholder="Reviews diffs for correctness and edge cases."
          onChange={(e) => set("description", e.target.value)}
        />
        <span className="ae-subagents-hint">
          Action-oriented — the main agent reads this to decide when to
          delegate.
        </span>
      </label>

      <label className="ae-subagents-field">
        <span className="ae-subagents-label">Model</span>
        <input
          type="text"
          className="ae-subagents-input"
          list="ae-subagents-model-list"
          value={editor.model}
          placeholder="inherit the tab's model (e.g. ollama/llama3.3)"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => set("model", e.target.value)}
        />
        <datalist id="ae-subagents-model-list">
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </datalist>
      </label>

      <div className="ae-subagents-field">
        <span className="ae-subagents-label">Tools</span>
        <select
          className="ae-subagents-select"
          value={editor.toolsMode}
          onChange={(e) => set("toolsMode", e.target.value as ToolsMode)}
        >
          <option value="inherit">Inherit all tools</option>
          <option value="restrict">Restrict to selected</option>
          <option value="none">None (reasoning only)</option>
        </select>
        {editor.toolsMode === "restrict" && (
          <div className="ae-subagents-tools">
            {BUILTIN_TOOLS.map((tool) => (
              <label key={tool} className="ae-subagents-tool">
                <input
                  type="checkbox"
                  checked={editor.tools.includes(tool)}
                  onChange={() => toggleTool(tool)}
                />
                {tool}
              </label>
            ))}
          </div>
        )}
      </div>

      <label className="ae-subagents-field">
        <span className="ae-subagents-label">Run surface</span>
        <select
          className="ae-subagents-select"
          value={editor.surface}
          onChange={(e) => set("surface", e.target.value as SubagentSurface)}
        >
          <option value="inline">Inline (nested card in the turn)</option>
          <option value="tab">Tab (its own agent tab)</option>
        </select>
      </label>

      <label className="ae-subagents-field">
        <span className="ae-subagents-label">Timeout (seconds)</span>
        <input
          type="number"
          className="ae-subagents-input"
          min={1}
          max={MAX_AGENT_TIMEOUT_SECONDS}
          value={editor.timeoutSeconds}
          placeholder="Use global default"
          onChange={(e) => set("timeoutSeconds", e.target.value)}
        />
      </label>

      <label className="ae-subagents-field">
        <span className="ae-subagents-label">System prompt</span>
        <textarea
          className="ae-subagents-textarea ae-subagents-prompt"
          rows={6}
          value={editor.systemPrompt}
          placeholder="You are a meticulous code reviewer. Focus on correctness…"
          onChange={(e) => set("systemPrompt", e.target.value)}
        />
      </label>

      <div className="ae-subagents-editor-actions">
        <button
          type="button"
          className="ae-subagents-save"
          disabled={busy}
          onClick={onSave}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="ae-subagents-cancel"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
