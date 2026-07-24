import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readConfig,
  readRawConfig,
  resolveConfigPath,
  writeConfig,
} from "../config.js";

describe("config file", () => {
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

  describe("readConfig", () => {
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

  describe("readRawConfig", () => {
    it("returns an empty object when the file is absent", () => {
      expect(readRawConfig()).toEqual({});
    });

    it("preserves unknown keys the schema does not model", () => {
      writeFileSync(path, JSON.stringify({ futureSetting: true }));
      expect(readRawConfig()).toEqual({ futureSetting: true });
    });

    it("throws on malformed JSON", () => {
      writeFileSync(path, "{ not json");
      expect(() => readRawConfig()).toThrow("not a valid JSON object");
    });
  });

  describe("writeConfig", () => {
    it("creates the file and its parent directory when absent", () => {
      process.env.GLV_CONFIG = join(dir, "nested", "deep", "config.json");
      writeConfig({ forwardHost: "203.0.113.5" });
      expect(existsSync(resolveConfigPath())).toBe(true);
    });

    it("writes pretty-printed JSON that reads back", () => {
      writeConfig({ forwardHost: "203.0.113.5" });
      expect(readRawConfig().forwardHost).toBe("203.0.113.5");
      expect(readFileSync(path, "utf-8")).toContain('  "forwardHost":');
    });

    it("round-trips an object merged from readRawConfig", () => {
      writeFileSync(path, JSON.stringify({ forwardHost: "1.2.3.4", extra: 9 }));
      const config = readRawConfig();
      config.forwardHost = "5.6.7.8";
      writeConfig(config);
      expect(readRawConfig()).toEqual({
        forwardHost: "5.6.7.8",
        extra: 9,
      });
    });

    it("throws when a value violates the schema", () => {
      expect(() => writeConfig({ forwardHost: 123 })).toThrow(
        "invalid glv config",
      );
    });
  });
});
