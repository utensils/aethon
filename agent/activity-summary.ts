export interface AgentActivitySummary {
  label: string;
  detail: string;
}

function commandText(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const value = (args as Record<string, unknown>).command;
  return typeof value === "string" ? value.trim() : "";
}

function firstCommandWord(command: string): string {
  return command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

function looksLikeDirectoryCommand(command: string): boolean {
  const first = firstCommandWord(command);
  if (/^(ls|tree|du|find|fd)$/.test(first)) return true;
  return /\b(find|fd)\b[\s\S]*\b(maxdepth|type\s+[df]|name)\b/i.test(command);
}

function looksLikeFileReadCommand(command: string): boolean {
  const first = firstCommandWord(command);
  return /^(cat|sed|head|tail|nl|less|more|jq|yq)$/.test(first);
}

function looksLikeGitCommand(command: string): boolean {
  return /\b(git|gh)\s+(diff|status|log|show|branch|fetch)\b/i.test(command);
}

function looksLikeCheckCommand(command: string): boolean {
  return /\b(vitest|test|check|lint|tsc|eslint|cargo test|bun test)\b/i.test(
    command,
  );
}

function looksLikeSearchCommand(command: string): boolean {
  return /\b(rg|grep|glob|search)\b/i.test(command);
}

function looksLikeFetchCommand(command: string): boolean {
  return /\b(curl|wget|http|fetch)\b/i.test(command);
}

export function activityForTool(
  toolName: string,
  args: unknown,
): AgentActivitySummary {
  if (toolName === "edit" || toolName === "write") {
    return {
      label: "Editing files",
      detail: "Applying changes to the workspace",
    };
  }
  if (toolName === "read") {
    return {
      label: "Reading files",
      detail: "Inspecting file contents",
    };
  }
  if (toolName === "ls" || toolName === "find") {
    return {
      label: "Reading directory contents",
      detail: "Inspecting files and folders",
    };
  }
  if (toolName === "grep") {
    return {
      label: "Searching files",
      detail: "Looking for relevant matches",
    };
  }
  if (toolName === "bash") {
    const command = commandText(args);
    if (looksLikeDirectoryCommand(command)) {
      return {
        label: "Reading directory contents",
        detail: "Inspecting files and folders",
      };
    }
    if (looksLikeFileReadCommand(command)) {
      return {
        label: "Reading files",
        detail: "Inspecting file contents",
      };
    }
    if (looksLikeGitCommand(command)) {
      return {
        label: "Checking git state",
        detail: "Reviewing repository changes",
      };
    }
    if (looksLikeCheckCommand(command)) {
      return {
        label: "Running checks",
        detail: "Waiting for results",
      };
    }
    if (looksLikeSearchCommand(command)) {
      return {
        label: "Searching files",
        detail: "Looking for relevant matches",
      };
    }
    if (looksLikeFetchCommand(command)) {
      return {
        label: "Fetching data",
        detail: "Waiting on an external response",
      };
    }
  }
  if (toolName === "task" || toolName === "task_batch" || toolName === "subagent") {
    return {
      label: "Working through steps",
      detail: "Running background activity",
    };
  }
  return {
    label: "Working",
    detail: "Gathering context",
  };
}
