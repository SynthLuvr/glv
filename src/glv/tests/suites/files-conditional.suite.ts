import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
} from "../harness.js";

// A fixed mtime in the past keeps every If-Modified-Since comparison
// deterministic regardless of when the suite runs.
const MTIME = new Date("2026-08-20T10:00:00Z");
const FILE_PATH = "/files/Documents/notes.txt";

// The /files route hands validated paths to sendFile from the forked
// @hono/node-server, which now honors conditional requests per RFC 9110:
// a GET/HEAD carrying If-Modified-Since (and no If-None-Match) gets 304
// Not Modified when the file's mtime is not newer than the given date.
const runFilesConditionalSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let home: string;
  let lastModified: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "glv-files-ims-"));
    mkdirSync(join(home, "Documents"), { recursive: true });
    writeFileSync(
      join(home, "Documents", "notes.txt"),
      "conditional content\n",
    );
    utimesSync(join(home, "Documents", "notes.txt"), MTIME, MTIME);
    lastModified = MTIME.toUTCString();
    env = await fx.startEnv("glv-files-ims-", {}, home);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  });

  describe("files: If-Modified-Since", () => {
    it("serves the file with a Last-Modified header", async () => {
      const res = await authedFetch(env, FILE_PATH);
      expect(res.status).toBe(200);
      expect(res.headers.get("last-modified")).toBe(lastModified);
      expect(await res.text()).toBe("conditional content\n");
    });

    it("responds 304 without representation metadata when unmodified", async () => {
      const res = await authedFetch(env, FILE_PATH, {
        headers: { "if-modified-since": lastModified },
      });
      expect(res.status).toBe(304);
      // Last-Modified stays to guide cache updates; a 304 carries no
      // representation metadata (RFC 9110 Section 15.4.5).
      expect(res.headers.get("last-modified")).toBe(lastModified);
      expect(res.headers.get("content-type")).toBeNull();
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(res.headers.get("content-length")).toBeNull();
      expect(res.headers.get("content-range")).toBeNull();
      expect(await res.text()).toBe("");
    });

    it("responds 304 when the date is newer than the file mtime", async () => {
      const res = await authedFetch(env, FILE_PATH, {
        headers: {
          "if-modified-since": new Date(MTIME.getTime() + 60_000).toUTCString(),
        },
      });
      expect(res.status).toBe(304);
      expect(await res.text()).toBe("");
    });

    it("serves the file when its mtime is newer than the date", async () => {
      // One second before the mtime: the file changed after the date, so
      // the cached copy is stale and the full body must come back.
      const res = await authedFetch(env, FILE_PATH, {
        headers: {
          "if-modified-since": new Date(MTIME.getTime() - 1000).toUTCString(),
        },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("conditional content\n");
    });

    it("ignores an invalid If-Modified-Since header", async () => {
      const res = await authedFetch(env, FILE_PATH, {
        headers: { "if-modified-since": "not-a-date" },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("conditional content\n");
    });

    it("ignores If-Modified-Since when If-None-Match is present", async () => {
      const res = await authedFetch(env, FILE_PATH, {
        headers: {
          "if-none-match": '"v1"',
          "if-modified-since": lastModified,
        },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("conditional content\n");
    });

    it("responds 304 to a HEAD request when not modified", async () => {
      const res = await authedFetch(env, FILE_PATH, {
        method: "HEAD",
        headers: { "if-modified-since": lastModified },
      });
      expect(res.status).toBe(304);
      expect(await res.text()).toBe("");
    });

    it("responds 304 to a range request when not modified", async () => {
      // The conditional check runs before the range branch, so no range
      // metadata may leak into the 304.
      const res = await authedFetch(env, FILE_PATH, {
        headers: {
          range: "bytes=0-9",
          "if-modified-since": lastModified,
        },
      });
      expect(res.status).toBe(304);
      expect(res.headers.get("content-range")).toBeNull();
      expect(res.headers.get("accept-ranges")).toBeNull();
      expect(await res.text()).toBe("");
    });

    // RFC 9110 Section 13.1.3: a field value with more than one member is
    // ignored. Node joins repeated headers into one comma-separated value.
    it("ignores If-Modified-Since with more than one member", async () => {
      const res = await authedFetch(env, FILE_PATH, {
        headers: {
          "if-modified-since": `${lastModified}, ${lastModified}`,
        },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("conditional content\n");
    });
  });
};

export { runFilesConditionalSuite };
