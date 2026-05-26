import { useCallback, useEffect, useRef, useState } from "react";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";

const DRAFT_COMMIT_DELAY_MS = 80;

export function useDraftCommit(
  externalValue: string,
  onEvent: BuiltinComponentProps["onEvent"],
) {
  const [localValue, setLocalValue] = useState(externalValue);
  const localValueRef = useRef(localValue);
  const lastExternalValueRef = useRef(externalValue);
  const draftTimerRef = useRef<number | null>(null);
  const lastCommittedDraftRef = useRef(externalValue);
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    localValueRef.current = localValue;
  }, [localValue]);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const commitDraft = useCallback((next: string) => {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    if (next === lastCommittedDraftRef.current) return;
    lastCommittedDraftRef.current = next;
    onEventRef.current("change", { value: next });
  }, []);

  useEffect(() => {
    if (externalValue === lastExternalValueRef.current) return;
    if (
      draftTimerRef.current !== null &&
      localValueRef.current !== lastCommittedDraftRef.current
    ) {
      commitDraft(localValueRef.current);
    }
    lastExternalValueRef.current = externalValue;
    lastCommittedDraftRef.current = externalValue;
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    setLocalValue(externalValue);
  }, [externalValue, commitDraft]);

  const scheduleDraftCommit = useCallback(() => {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
    }
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null;
      commitDraft(localValueRef.current);
    }, DRAFT_COMMIT_DELAY_MS);
  }, [commitDraft]);

  useEffect(() => {
    return () => {
      if (draftTimerRef.current !== null) {
        window.clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
      const latest = localValueRef.current;
      if (latest !== lastCommittedDraftRef.current) {
        onEventRef.current("change", { value: latest });
      }
    };
  }, []);

  return {
    value: localValue,
    setValue: setLocalValue,
    commitDraft,
    scheduleDraftCommit,
  };
}
