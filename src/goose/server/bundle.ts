import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type AssetBundle = {
  readonly htmx: string;
  readonly appCss: string;
  readonly sidebar: string;
  readonly stream: string;
  readonly rename: string;
  readonly ui: string;
  readonly prompts: string;
  readonly groups: string;
  readonly passkey: string;
  readonly uploads: string;
};

// Resolved relative to this file (src/goose/server/) so dist/goose is three levels up.
const readAsset = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

// Read after the serve command has built dist/, so the bundle is current.
const buildAssetBundle = (): AssetBundle => ({
  htmx: readFileSync(
    fileURLToPath(import.meta.resolve("htmx.org/dist/htmx.min.js")),
    "utf8",
  ),
  appCss: readAsset("../../../dist/goose/app.css"),
  sidebar: readAsset("../../../dist/goose/sidebar.js"),
  stream: readAsset("../../../dist/goose/stream.js"),
  rename: readAsset("../../../dist/goose/rename.js"),
  ui: readAsset("../../../dist/goose/ui.js"),
  prompts: readAsset("../../../dist/goose/prompts.js"),
  groups: readAsset("../../../dist/goose/groups.js"),
  passkey: readAsset("../../../dist/goose/passkey.js"),
  uploads: readAsset("../../../dist/goose/uploads.js"),
});

export type { AssetBundle };
export { buildAssetBundle };
