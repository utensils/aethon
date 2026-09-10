declare module "pi-mcp-adapter" {
  import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

  const extension: ExtensionFactory;
  export default extension;
}
