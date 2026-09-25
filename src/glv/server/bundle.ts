import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type AssetBundle = {
  readonly htmx: string;
  readonly appCss: string;
  readonly sidebar: string;
  readonly stream: string;
  readonly agents: string;
  readonly rename: string;
  readonly actions: string;
  readonly ui: string;
  readonly prompts: string;
  readonly groups: string;
  readonly passkey: string;
  readonly uploads: string;
  readonly location: string;
  readonly schedule: string;
};

// Resolved relative to this file (src/glv/server/) so dist/ is three
// levels up.
const readAsset = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

// Read after the serve command has built dist/<flavor>/, so the bundle is
// current.
const buildAssetBundle = (flavor: string): AssetBundle => ({
  htmx: readFileSync(
    fileURLToPath(import.meta.resolve("htmx.org/dist/htmx.min.js")),
    "utf8",
  ),
  appCss: readAsset(`../../../dist/${flavor}/app.css`),
  sidebar: readAsset(`../../../dist/${flavor}/sidebar.js`),
  stream: readAsset(`../../../dist/${flavor}/stream.js`),
  agents: readAsset(`../../../dist/${flavor}/agents.js`),
  rename: readAsset(`../../../dist/${flavor}/rename.js`),
  actions: readAsset(`../../../dist/${flavor}/actions.js`),
  ui: readAsset(`../../../dist/${flavor}/ui.js`),
  prompts: readAsset(`../../../dist/${flavor}/prompts.js`),
  groups: readAsset(`../../../dist/${flavor}/groups.js`),
  passkey: readAsset(`../../../dist/${flavor}/passkey.js`),
  uploads: readAsset(`../../../dist/${flavor}/uploads.js`),
  location: readAsset(`../../../dist/${flavor}/location.js`),
  schedule: readAsset(`../../../dist/${flavor}/schedule.js`),
});

export type { AssetBundle };
export { buildAssetBundle };
