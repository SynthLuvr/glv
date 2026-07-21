import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type AssetBundle = {
  readonly htmx: string;
  readonly appCss: string;
  readonly sidebar: string;
  readonly stream: string;
  readonly rename: string;
  readonly sourcePicker: string;
  readonly ui: string;
  readonly prompts: string;
  readonly passkey: string;
};

// Resolved relative to this file (src/server/) so dist/ is two levels up.
const readAsset = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

// Read after the serve command has built dist/, so the bundle is current.
const buildAssetBundle = (): AssetBundle => ({
  htmx: readFileSync(
    fileURLToPath(import.meta.resolve("htmx.org/dist/htmx.min.js")),
    "utf8",
  ),
  appCss: readAsset("../../dist/app.css"),
  sidebar: readAsset("../../dist/sidebar.js"),
  stream: readAsset("../../dist/stream.js"),
  rename: readAsset("../../dist/rename.js"),
  sourcePicker: readAsset("../../dist/source-picker.js"),
  ui: readAsset("../../dist/ui.js"),
  prompts: readAsset("../../dist/prompts.js"),
  passkey: readAsset("../../dist/passkey.js"),
});

export type { AssetBundle };
export { buildAssetBundle };
