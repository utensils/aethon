// The companion's extra composites + boot layout. Registered alongside
// the default-layout extension on the mobile surface only, so the
// desktop bundle never pulls these in. The default-layout extension
// still supplies the shared composites the mobile layout reuses
// (main-canvas, chat-input, model-picker, agent-pulse).

import type { A2UIExtension } from "../extensions/types";
import { ConnectionBadge } from "./composites/connection-badge";
import { MobileFileList } from "./composites/mobile-file-list";
import { MobileFileViewer } from "./composites/mobile-file-viewer";
import { MobileNav } from "./composites/mobile-nav";
import { MobileSessions } from "./composites/mobile-sessions";
import mobilePayload from "./mobile.a2ui.json";

// The terminal + git screens reuse the default-layout composites
// (terminal-panel, source-control-panel) — no mobile-specific variant
// needed, just a touch-sized cell in the mobile layout.
export const mobileLayoutExtension: A2UIExtension = {
  name: "mobile-layout",
  components: {
    "connection-badge": ConnectionBadge,
    "mobile-nav": MobileNav,
    "mobile-sessions": MobileSessions,
    "mobile-file-list": MobileFileList,
    "mobile-file-viewer": MobileFileViewer,
  },
  layout: mobilePayload,
};
