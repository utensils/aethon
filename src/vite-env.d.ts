/// <reference types="vite/client" />

// Build-time constants injected via vite.config.ts `define`. Single
// source of truth for the displayed app version is package.json; vite
// reads it there and substitutes the literal at compile time. The UI
// then surfaces it via the `/appVersion` state path so the layout JSON
// can `$ref` it without hardcoding.
declare const __APP_VERSION__: string;
