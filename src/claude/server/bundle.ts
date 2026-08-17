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

// Resolved relative to this file (src/claude/server/) so dist/claude is three levels up.
const readAsset = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

// Read after the serve command has built dist/, so the bundle is current.
const buildAssetBundle = (): AssetBundle => ({
  htmx: readFileSync(
    fileURLToPath(import.meta.resolve("htmx.org/dist/htmx.min.js")),
    "utf8",
  ),
  appCss: readAsset("../../../dist/claude/app.css"),
  sidebar: readAsset("../../../dist/claude/sidebar.js"),
  stream: readAsset("../../../dist/claude/stream.js"),
  rename: readAsset("../../../dist/claude/rename.js"),
  ui: readAsset("../../../dist/claude/ui.js"),
  prompts: readAsset("../../../dist/claude/prompts.js"),
  groups: readAsset("../../../dist/claude/groups.js"),
  passkey: readAsset("../../../dist/claude/passkey.js"),
  uploads: readAsset("../../../dist/claude/uploads.js"),
});

export type { AssetBundle };
export { buildAssetBundle };
