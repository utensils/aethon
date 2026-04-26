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
    onClick?: string; // Event handler reference
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
