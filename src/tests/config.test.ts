import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig } from "../config.js";

describe("readConfig", () => {
  let dir: string;
  let path: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "glv-cfg-"));
    path = join(dir, "config.json");
    prevEnv = process.env.GLV_CONFIG;
    process.env.GLV_CONFIG = path;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.GLV_CONFIG;
    else process.env.GLV_CONFIG = prevEnv;
  });

  it("returns an empty config when the file is absent", () => {
    expect(readConfig()).toEqual({});
  });

  it("reads forwardHost", () => {
    writeFileSync(path, JSON.stringify({ forwardHost: "91.98.17.2" }));
    expect(readConfig().forwardHost).toBe("91.98.17.2");
  });

  it("tolerates unknown keys so the file can grow", () => {
    writeFileSync(
      path,
      JSON.stringify({ forwardHost: "10.0.0.1", futureSetting: true }),
    );
    expect(readConfig().forwardHost).toBe("10.0.0.1");
  });

  it("throws on malformed JSON", () => {
    writeFileSync(path, "{ not json");
    expect(() => readConfig()).toThrow("not a valid JSON object");
  });

  it("throws on a non-object JSON value", () => {
    writeFileSync(path, '"hello"');
    expect(() => readConfig()).toThrow("not a valid JSON object");
  });
});
