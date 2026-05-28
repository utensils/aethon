/**
 * Extension type definitions.
 *
 * An extension bundles A2UI component implementations and (optionally) a
 * default A2UI layout payload. The default-layout that ships with Aethon uses
 * this same shape so the out-of-the-box experience exercises the extension
 * primitive users have access to.
 */

import type { ComponentType } from "react";
import type { A2UIPayload } from "../types/a2ui";
import type { BuiltinComponentProps } from "../components/A2UIRenderer";

export type A2UIComponentImpl = ComponentType<BuiltinComponentProps>;

export interface A2UIExtension {
  name: string;
  components?: Record<string, A2UIComponentImpl>;
  layout?: A2UIPayload;
}
