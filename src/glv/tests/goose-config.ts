import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gooseConfigPath } from "../../goose/models.js";
import { fakeHomeEnv } from "./harness.js";

// goose resolves its config under APPDATA on Windows and ~/.config
// elsewhere; fakeHomeEnv spells the fake home the same way for both, so
// this writes exactly where the server's fresh-per-call reads look.
const writeGooseConfig = (home: string, configYaml: string): void => {
  const path = gooseConfigPath(fakeHomeEnv(home));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, configYaml);
};

// Two usable providers, one active — the smallest config that gives the
// picker a multi-provider group and a labelled default. Shared by the
// cron-model and combined suites.
const TWO_PROVIDER_CONFIG_YAML = `active_provider: zai
providers:
  zai:
    enabled: true
    model: glm-5.3
    configured: true
  anthropic:
    enabled: true
    model: claude-sonnet-4-5
    configured: true
`;

export { TWO_PROVIDER_CONFIG_YAML, writeGooseConfig };
