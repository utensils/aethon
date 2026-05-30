/**
 * A2UI Type Definitions
 * Based on A2UI v0.9 spec
 */

// Dynamic value types for data binding
export type DynamicString = {
  $ref: string; // JSON Pointer path
};

export type DynamicNumber = {
  $ref: string;
};

export type DynamicBoolean = {
  $ref: string;
};

export type StringValue = string | DynamicString;
export type NumberValue = number | DynamicNumber;
export type BooleanValue = boolean | DynamicBoolean;

// Base component interface
export interface A2UIComponent {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  children?: A2UIComponent[];
}

// Built-in component types
export interface TextComponent extends A2UIComponent {
  type: "text";
  props: {
    content: StringValue;
    variant?: "body" | "small" | "large";
    color?: string;
  };
}

export interface CardComponent extends A2UIComponent {
  type: "card";
  props: {
    title?: StringValue;
    description?: StringValue;
    padding?: NumberValue;
  };
  children?: A2UIComponent[];
}

export interface ButtonComponent extends A2UIComponent {
  type: "button";
  props: {
    label: StringValue;
    variant?: "primary" | "secondary" | "ghost";
    disabled?: BooleanValue;
  };
}

export interface ContainerComponent extends A2UIComponent {
  type: "container";
  props: {
    direction?: "row" | "column";
    gap?: NumberValue;
    padding?: NumberValue;
    align?: "start" | "center" | "end" | "stretch";
    justify?: "start" | "center" | "end" | "space-between";
    /** Extra class names appended to the container element. */
    className?: string;
    /** Mark the container as a macOS window drag region
     *  (`data-tauri-drag-region`). Honored only on macOS (overlay
     *  titlebar); a no-op elsewhere. */
    dragRegion?: BooleanValue;
  };
  children?: A2UIComponent[];
}

export interface CodeComponent extends A2UIComponent {
  type: "code";
  props: {
    content: StringValue;
    language?: string;
    showLineNumbers?: BooleanValue;
  };
}

export interface TextInputComponent extends A2UIComponent {
  type: "text-input";
  props: {
    value?: StringValue;
    placeholder?: StringValue;
    disabled?: BooleanValue;
    onChange?: string; // Event handler reference
    onSubmit?: string;
    name?: StringValue;
    required?: BooleanValue;
    autocomplete?: StringValue;
  };
}

export interface DatePickerComponent extends A2UIComponent {
  type: "date-picker";
  props: {
    value?: StringValue;
    min?: StringValue;
    max?: StringValue;
    placeholder?: StringValue;
    disabled?: BooleanValue;
    required?: BooleanValue;
    name?: StringValue;
  };
}

export interface IconComponent extends A2UIComponent {
  type: "icon";
  props: {
    name?: StringValue;
    symbol?: StringValue;
    label?: StringValue;
    size?: NumberValue;
    color?: StringValue;
    decorative?: BooleanValue;
  };
}

export interface FormFieldComponent extends A2UIComponent {
  type: "form-field";
  props: {
    label?: StringValue;
    description?: StringValue;
    error?: StringValue;
    required?: BooleanValue;
  };
  children?: A2UIComponent[];
}

export interface FormComponent extends A2UIComponent {
  type: "form";
  props: {
    submitLabel?: StringValue;
    disabled?: BooleanValue;
    gap?: NumberValue;
    direction?: "row" | "column";
  };
  children?: A2UIComponent[];
}

// Layout primitive — CSS Grid with template-areas. Children opt into a region
// via their own `area` prop. Consumed by the layout extension, but available to
// agents and extensions too.
export interface LayoutComponent extends A2UIComponent {
  type: "layout";
  props: {
    columns?: StringValue;
    rows?: StringValue;
    areas?: string[]; // grid-template-areas rows
    gap?: NumberValue;
  };
  children?: A2UIComponent[];
}

export interface SidebarSection {
  id: string;
  title: string;
  items: SidebarItem[] | { $ref: string };
  /** When true, the default sidebar omits the section until it has items. */
  hideWhenEmpty?: boolean;
}

export interface SidebarItem {
  id: string;
  label: string;
  icon?: string;
  /** Resolved icon URL — bundled asset path, file://, or http(s). Rendered
   *  as a small <img> before the label. Used by host rows and (when
   *  src/projectIcons.ts populates iconUrl) project rows. */
  iconUrl?: string;
  onClick?: string;
  // Optional active flag — true highlights the row.
  active?: boolean;
  // When set, the sidebar resolves this through the ExtensionRegistry and
  // renders that template per item instead of the default label row.
  // Templates can $ref into /$item for per-row data
  // (icon, badge, sub-text, last-modified, …). The standard $item /
  // $index / $parent for-each scope keys are available because the
  // sidebar passes the item as $item when expanding.
  componentType?: string;
  // Free-form extra fields available to a custom componentType template.
  // Surfaced under /$item alongside id/label/active.
  [extra: string]: unknown;
}

export interface SidebarComponent extends A2UIComponent {
  type: "sidebar";
  props: {
    title?: StringValue;
    sections?: SidebarSection[];
    // Appended after `sections`. Inline array or `$ref` so extensions can
    // push panels into a state-bound list without modifying the layout.
    extraSections?: SidebarSection[] | { $ref: string };
  };
}

export interface ChatHistoryComponent extends A2UIComponent {
  type: "chat-history";
  props: {
    messages: { $ref: string };
    emptyHint?: StringValue;
  };
}

export interface StatusBarComponent extends A2UIComponent {
  type: "status-bar";
  props: {
    left?: StringValue;
    center?: StringValue;
    right?: StringValue;
  };
}

export interface TerminalComponent extends A2UIComponent {
  type: "terminal";
  props: {
    cols?: NumberValue;
    rows?: NumberValue;
    fontSize?: NumberValue;
    output?: StringValue; // raw text written to the terminal
    onInput?: string;
    // Opt-in: subscribe to the agent's bash output stream. When false (the
    // default), this terminal is independent and only renders what its
    // `output` prop or its own input handler provide.
    subscribeToBash?: BooleanValue;
  };
}

export interface ChatInputComponent extends A2UIComponent {
  type: "chat-input";
  props: {
    value?: StringValue;
    placeholder?: StringValue;
    disabled?: BooleanValue;
    onSubmit?: string;
    onChange?: string;
    // Slash command suggestions. When the input starts with `/`, the
    // matching commands surface in an autocomplete dropdown.
    commands?:
      | { name: string; description?: string; usage?: string }[]
      | { $ref: string };
  };
}

// MainCanvas is a slot — it renders whatever A2UI subtree lives at the
// pointer it's bound to, plus a scrollable message feed. This is how
// agent-emitted UI flows into the layout without the layout knowing about it.
export interface MainCanvasComponent extends A2UIComponent {
  type: "main-canvas";
  props: {
    slot?: string; // JSON Pointer into state for live A2UI subtree
    messages?: { $ref: string };
  };
}

// A2UI payload from agent
export interface A2UIPayload {
  components: A2UIComponent[];
  state?: Record<string, unknown>;
}

// Event types
export interface A2UIEvent {
  componentId: string;
  eventType: string;
  data?: unknown;
}

// Component props types (for React component implementations)
export type TextProps = TextComponent["props"];
export type CardProps = CardComponent["props"];
export type ButtonProps = ButtonComponent["props"];
export type ContainerProps = ContainerComponent["props"];
export type CodeProps = CodeComponent["props"];
export type TextInputProps = TextInputComponent["props"];
export type DatePickerProps = DatePickerComponent["props"];
export type IconProps = IconComponent["props"];
export type FormFieldProps = FormFieldComponent["props"];
export type FormProps = FormComponent["props"];
export type LayoutProps = LayoutComponent["props"];
export type SidebarProps = SidebarComponent["props"];
export type ChatHistoryProps = ChatHistoryComponent["props"];
export type StatusBarProps = StatusBarComponent["props"];
export type TerminalProps = TerminalComponent["props"];
export type ChatInputProps = ChatInputComponent["props"];
export type MainCanvasProps = MainCanvasComponent["props"];

export interface ChatAttachment {
  id: string;
  kind: "image";
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

// Message shape used by ChatHistory and MainCanvas — text or embedded A2UI subtree.
export interface ChatMessage {
  id: string;
  role: "user" | "agent" | "system";
  text?: string;
  attachments?: ChatAttachment[];
  thinking?: string;
  a2ui?: A2UIPayload;
  delivery?: "sent" | "queued" | "steered" | "failed";
}
