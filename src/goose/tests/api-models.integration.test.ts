import { describe } from "vitest";
import {
  TWO_PROVIDER_CONFIG_YAML,
  writeGooseConfig,
} from "../../glv/tests/goose-config.js";
import { runApiModelsSuite } from "../../glv/tests/suites/api-models.suite.js";
import { gooseFixture } from "./integration-harness.js";

// The goose binding of the shared /api/models suite: the two configured
// providers, the models the ACP conversation reports (the mock's
// fixture), the active provider leading, and the configured default
// readable from config.yaml.

const ACP_PROVIDERS = JSON.stringify({
  entries: [
    {
      providerId: "zai",
      providerName: "Z.AI",
      models: [
        { id: "glm-5.3", name: "GLM-5.3" },
        { id: "glm-5.1", name: "GLM-5.1" },
        { id: "glm-5.3-flash", name: "GLM-5.3 Flash" },
      ],
    },
    {
      providerId: "anthropic",
      providerName: "Anthropic",
      models: [{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
    },
  ],
});

describe("api models", () =>
  runApiModelsSuite(gooseFixture, {
    mock: { acpProviders: ACP_PROVIDERS },
    prepareHome: (home) => writeGooseConfig(home, TWO_PROVIDER_CONFIG_YAML),
    expected: [
      {
        agent: "goose",
        label: "goose",
        default: { provider: "zai", model: "glm-5.3" },
        models: [
          { provider: "zai", model: "glm-5.3", label: "GLM-5.3" },
          { provider: "zai", model: "glm-5.1", label: "GLM-5.1" },
          { provider: "zai", model: "glm-5.3-flash", label: "GLM-5.3 Flash" },
          {
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            label: "Claude Sonnet 4.5",
          },
        ],
      },
    ],
  }));
