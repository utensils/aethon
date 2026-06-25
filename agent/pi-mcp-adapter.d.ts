declare module "pi-mcp-adapter/index.ts" {
  import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

  const extension: ExtensionFactory;
  export default extension;
}

