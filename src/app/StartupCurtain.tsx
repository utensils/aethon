import { useId } from "react";
import type { WorkspaceStartupView } from "../hooks/useWorkspaceStartup";

export interface StartupCurtainProps {
  logoUrl: string;
  startup?: WorkspaceStartupView | null;
  onApprove?: () => void;
  onRetry?: () => void;
  onContinue?: () => void;
}

export function StartupCurtain({
  logoUrl,
  startup,
  onApprove,
  onRetry,
  onContinue,
}: StartupCurtainProps) {
  const titleId = useId();
  const reasonId = useId();
  const outputId = useId();
  const entry = startup?.entry ?? null;
  if (!entry) {
    return (
      <div className="ae-boot-curtain" aria-hidden="true">
        <img src={logoUrl} alt="" />
      </div>
    );
  }
  const pendingApproval = entry.state === "approval_required";
  const failed = entry.state === "failed";
  const running = entry.state === "running";
  const interactive = pendingApproval || failed;
  const describedBy = [
    entry.reason ? reasonId : null,
    startup?.output ? outputId : null,
  ]
    .filter(Boolean)
    .join(" ");
  const title = pendingApproval
    ? "Approve Workspace Startup"
    : failed
      ? "Workspace Startup Failed"
      : running
        ? "Preparing Workspace"
        : "Workspace Startup";

  return (
    <div
      className="ae-startup-curtain"
      role={interactive ? "dialog" : "status"}
      aria-modal={interactive ? "true" : undefined}
      aria-live={interactive ? undefined : "polite"}
      aria-labelledby={titleId}
      aria-describedby={describedBy || undefined}
    >
      <div className="ae-startup-panel">
        <div className="ae-startup-header">
          <img src={logoUrl} alt="" />
          <div>
            <h1 id={titleId}>{title}</h1>
            <p>{entry.root}</p>
          </div>
        </div>
        <div className="ae-startup-tasks">
          {entry.commands.length === 0 ? (
            <div className="ae-startup-task">
              <span className="ae-startup-task-dot is-running" />
              <span>Preparing environment</span>
            </div>
          ) : (
            entry.commands.map((task) => (
              <div className="ae-startup-task" key={task.id}>
                <span className={`ae-startup-task-dot is-${task.state}`} />
                <span>{task.label}</span>
                {!task.required ? (
                  <span className="ae-startup-task-meta">optional</span>
                ) : null}
              </div>
            ))
          )}
        </div>
        {entry.reason ? (
          <p className="ae-startup-reason" id={reasonId}>
            {entry.reason}
          </p>
        ) : null}
        {startup?.output ? (
          <pre className="ae-startup-output" id={outputId}>
            {startup.output}
          </pre>
        ) : null}
        {pendingApproval || failed ? (
          <div className="ae-startup-actions">
            {pendingApproval ? (
              <button type="button" onClick={onApprove}>
                Approve
              </button>
            ) : null}
            {failed ? (
              <button type="button" onClick={onRetry}>
                Retry
              </button>
            ) : null}
            <button type="button" className="is-secondary" onClick={onContinue}>
              Continue
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
