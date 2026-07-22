/**
 * Design-system barrel — the entry /design-sync bundles for claude.ai/design.
 *
 * Exports exactly the components synced to the "Aethon Design System"
 * project: the 19 A2UI primitives plus the presentational chrome
 * composites that render standalone (no Tauri IPC, no app state).
 * Keep this list in step with .design-sync/config.json's componentSrcMap.
 */

export { Image, Icon } from "./components/primitives/media";
export {
  Text,
  Heading,
  Paragraph,
  Code,
  Divider,
} from "./components/primitives/text";
export { Card, Container, List, Table } from "./components/primitives/layout";
export {
  Button,
  Checkbox,
  Select,
  Slider,
} from "./components/primitives/controls";
export {
  Form,
  FormField,
  TextInput,
  DatePicker,
} from "./components/primitives/form";

export { Chevron } from "./extensions/default-layout/sidebar/chevron";
export {
  AeMarkInline,
  AeWordmark,
} from "./extensions/default-layout/layout/mark";
export { EmptyState } from "./extensions/default-layout/layout/empty-state";
export { Layout } from "./extensions/default-layout/layout/grid";
export { StatusBar } from "./extensions/default-layout/layout/status-bar";
export { ComposerVisibilityPills } from "./extensions/default-layout/composer-visibility-pills";
