// The companion's extra composites + boot layout. Registered alongside
// the default-layout extension on the mobile surface only, so the
// desktop bundle never pulls these in. The default-layout extension
// still supplies the shared composites the mobile layout reuses
// (main-canvas, chat-input, model-picker, agent-pulse).

import type { A2UIExtension } from "../extensions/types";
import { ConnectionBadge } from "./composites/connection-badge";
import { MobileNav } from "./composites/mobile-nav";
import { MobileSessions } from "./composites/mobile-sessions";
import mobilePayload from "./mobile.a2ui.json";

export const mobileLayoutExtension: A2UIExtension = {
  name: "mobile-layout",
  components: {
    "connection-badge": ConnectionBadge,
    "mobile-nav": MobileNav,
    "mobile-sessions": MobileSessions,
  },
  layout: mobilePayload,
};
