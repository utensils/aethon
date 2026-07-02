/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build surface: "mobile" for the iOS companion build (set via
   *  vite.mobile.config.ts define), undefined for the desktop build. */
  readonly VITE_AETHON_SURFACE?: "mobile";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
