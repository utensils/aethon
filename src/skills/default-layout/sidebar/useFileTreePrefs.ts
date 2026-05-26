import { useEffect, useRef, useState } from "react";

import { readState, writeState } from "../../../persist";

const PANEL_PREFS_FILE = "file-tree-prefs.json";
const PANEL_HEIGHT_DEFAULT = 280;
const PANEL_HEIGHT_MIN = 120;
const PANEL_HEIGHT_MAX = 1200;
const SIDEBAR_WIDTH_MIN = 220;
const SIDEBAR_WIDTH_MAX = 640;

interface PanelPrefs {
  collapsed?: boolean;
  hidden?: boolean;
  height?: number;
}

function readPanelPrefs(raw: string): PanelPrefs {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object") return v as PanelPrefs;
  } catch {
    /* fall through */
  }
  return {};
}

function useFileTreePrefs() {
  const [collapsed, setCollapsed] = useState<boolean>(false);
  const [hidden, setHidden] = useState<boolean>(false);
  const [height, setHeight] = useState<number>(PANEL_HEIGHT_DEFAULT);
  const prefsHydrated = useRef<boolean>(false);
  const prefsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readState(PANEL_PREFS_FILE).then((raw) => {
      if (cancelled) return;
      const prefs = readPanelPrefs(raw);
      if (typeof prefs.collapsed === "boolean") setCollapsed(prefs.collapsed);
      if (typeof prefs.hidden === "boolean") setHidden(prefs.hidden);
      if (
        typeof prefs.height === "number" &&
        prefs.height >= PANEL_HEIGHT_MIN &&
        prefs.height <= PANEL_HEIGHT_MAX
      ) {
        setHeight(prefs.height);
      }
      prefsHydrated.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (prefsSaveTimerRef.current) {
        clearTimeout(prefsSaveTimerRef.current);
        prefsSaveTimerRef.current = null;
      }
    };
  }, []);

  // Persist panel prefs after hydration. The save is debounced because the
  // drag handle fires height updates on every mousemove.
  useEffect(() => {
    if (!prefsHydrated.current) return;
    if (prefsSaveTimerRef.current) clearTimeout(prefsSaveTimerRef.current);
    prefsSaveTimerRef.current = setTimeout(() => {
      void writeState(
        PANEL_PREFS_FILE,
        JSON.stringify({ collapsed, hidden, height }),
      );
    }, 200);
  }, [collapsed, hidden, height]);

  useEffect(() => {
    const toggle = () => setHidden((h) => !h);
    const resetPrefs = () => {
      setCollapsed(false);
      setHidden(false);
      setHeight(PANEL_HEIGHT_DEFAULT);
    };
    window.addEventListener("aethon:toggle-file-tree", toggle);
    window.addEventListener("aethon:reset-file-tree-prefs", resetPrefs);
    return () => {
      window.removeEventListener("aethon:toggle-file-tree", toggle);
      window.removeEventListener("aethon:reset-file-tree-prefs", resetPrefs);
    };
  }, []);

  return {
    collapsed,
    hidden,
    height,
    setCollapsed,
    setHidden,
    setHeight,
  };
}

export {
  PANEL_HEIGHT_DEFAULT,
  PANEL_HEIGHT_MAX,
  PANEL_HEIGHT_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  readPanelPrefs,
  useFileTreePrefs,
};

export type { PanelPrefs };
