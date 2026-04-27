/**
 * Layout-slot contract. A "slot" is a stable, semantic name a composite uses
 * (via its `area` prop) to declare where it belongs in a layout. The Layout
 * component resolves the slot to a CSS grid-area name — by default the slot
 * name IS the grid area, but a layout can declare an optional `slotMap` prop
 * to remap (e.g. `{ composer: "bottom-bar" }`).
 *
 * The contract lets alternative layout skills swap the entire `<layout>`
 * tree while still hosting the standard composites: as long as the layout's
 * grid areas (or its slotMap) include the canonical slot names, the same
 * sidebar / chat-input / status-bar / etc. composites slot in unchanged.
 */

import slotsJson from "./slots.json";

export interface LayoutSlotDefinition {
  description: string;
  defaultComposite: string;
  required: boolean;
}

export interface LayoutSlotCatalogue {
  version: number;
  description: string;
  slots: Record<string, LayoutSlotDefinition>;
}

export const layoutSlots: LayoutSlotCatalogue = slotsJson as LayoutSlotCatalogue;

/** Canonical slot names. */
export const SLOT_NAMES = Object.freeze(
  Object.keys(layoutSlots.slots),
) as readonly string[];

/** Slot names any layout MUST provide to be considered "complete". */
export const REQUIRED_SLOT_NAMES = Object.freeze(
  Object.entries(layoutSlots.slots)
    .filter(([, def]) => def.required)
    .map(([name]) => name),
) as readonly string[];

/** True when `name` is a documented canonical slot. */
export function isKnownSlot(name: string): boolean {
  return Object.hasOwn(layoutSlots.slots, name);
}

/**
 * Inspects a layout payload's root `<layout>` and reports which canonical
 * slots its immediate children fill (via their `area` prop), which required
 * slots are missing, and which used names aren't in the catalogue.
 *
 * Lenient by design — extensions may legitimately ship layouts with
 * non-canonical area names (e.g. for custom panels). The report is meant
 * for tooling and dev-time warnings, not enforcement.
 */
export interface SlotCoverageReport {
  filledSlots: string[];
  missingRequired: string[];
  unknownAreasUsed: string[];
  dynamicAreas: boolean;
}

interface InspectableComponent {
  type?: string;
  props?: Record<string, unknown> & {
    area?: string;
    slotMap?: Record<string, string>;
    areas?: unknown;
  };
  children?: InspectableComponent[];
}

interface InspectablePayload {
  components?: InspectableComponent[];
}

export function inspectLayoutSlotCoverage(
  payload: InspectablePayload,
): SlotCoverageReport {
  const filled = new Set<string>();
  const unknown = new Set<string>();
  let dynamicAreas = false;

  const root = payload.components?.[0];
  if (!root || root.type !== "layout") {
    return {
      filledSlots: [],
      missingRequired: [...REQUIRED_SLOT_NAMES],
      unknownAreasUsed: [],
      dynamicAreas: false,
    };
  }

  const rootProps = root.props ?? {};
  const slotMap = (rootProps.slotMap ?? {}) as Record<string, string>;
  if (
    rootProps.areas &&
    typeof rootProps.areas === "object" &&
    "$ref" in (rootProps.areas as object)
  ) {
    dynamicAreas = true;
  }

  for (const child of root.children ?? []) {
    const area = child.props?.area;
    if (!area) continue;
    // Honor slotMap presence (a layout may remap a slot to a different
    // grid area). We still record the slot the child *claims* to fill,
    // not the underlying CSS area name — slotMap lookup is informational.
    void slotMap[area];
    if (isKnownSlot(area)) {
      filled.add(area);
    } else {
      unknown.add(area);
    }
  }

  const missing = REQUIRED_SLOT_NAMES.filter((s) => !filled.has(s));
  return {
    filledSlots: [...filled],
    missingRequired: missing,
    unknownAreasUsed: [...unknown],
    dynamicAreas,
  };
}
