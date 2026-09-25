import { expect } from "@playwright/test";
import type { IntegrationEnv } from "./harness.js";
import { authedFetch } from "./harness.js";

// Fetches the lazy model-picker fragment the New Session form swaps in,
// asserting the route answered before the caller inspects the markup.
// Shared by the flavor and combined picker suites.
const fetchModelPicker = async (env: IntegrationEnv): Promise<string> => {
  const res = await authedFetch(env, "/sessions/model-picker");
  expect(res.status).toBe(200);
  return res.text();
};

export { fetchModelPicker };
