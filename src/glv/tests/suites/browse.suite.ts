import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
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
  withPage,
} from "../harness.js";

// Windows grants symlink creation only with developer mode or admin rights;
// probe at collection time so symlink-dependent cases skip, not fail, where
// the OS denies it.
const probeSymlinkSupport = (): boolean => {
  const dir = mkdtempSync(join(tmpdir(), "glv-symlink-probe-"));
  try {
    symlinkSync(dir, join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const runBrowseSuite = (fx: FlavorFixture): void => {
  // A throwaway "home directory" so the browse view never touches the real one.
  // It mixes folders, files, dotfiles (secrets), and symlinks so every security
  // rule can be exercised deterministically.
  let env: IntegrationEnv;
  let home: string;
  const canSymlink = probeSymlinkSupport();

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "glv-browse-home-"));
    mkdirSync(join(home, "Documents"), { recursive: true });
    mkdirSync(join(home, "Projects"), { recursive: true });
    // URI-reserved characters in names ("#" would truncate an unencoded
    // href at the fragment boundary).
    const hashDir = join(home, "Z# notes");
    mkdirSync(hashDir, { recursive: true });
    writeFileSync(join(hashDir, "inside.txt"), "inner content\n");
    writeFileSync(join(hashDir, "a b#c.txt"), "hash file\n");
    writeFileSync(join(home, "Documents", "notes.txt"), "hello world\n");
    writeFileSync(join(home, "Documents", "data.json"), '{"ok":true}');
    writeFileSync(join(home, "readme.md"), "# Hello\n");
    writeFileSync(join(home, "config.json"), '{"v":1}');
    // Dotfiles are secrets — they must never be listed or served.
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_rsa"), "SECRET KEY MATERIAL");
    writeFileSync(join(home, ".env"), "TOKEN=secret");
    // Symlinks may escape the root, so they must never be followed. Where
    // the OS denies symlink creation, the fixtures are absent and the
    // symlink-safety cases skip (see probeSymlinkSupport).
    if (canSymlink) {
      symlinkSync("/etc", join(home, "link-etc"));
      symlinkSync("Documents", join(home, "link-docs"), "dir");
    }
    env = await fx.startEnv("glv-browse-", {}, home);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  });

  const text = async (path: string): Promise<string> => {
    const res = await authedFetch(env, path);
    return res.text();
  };

  describe("browse: link encoding", () => {
    it("encodes URI-reserved characters in folder and file links", async () => {
      const html = await text("/browse");
      expect(html).toContain('href="/browse/Z%23%20notes"');

      // Following the encoded folder link lists its contents, with the
      // nested file link encoded the same way.
      const inner = await text("/browse/Z%23%20notes");
      expect(inner).toContain("inside.txt");
      expect(inner).toContain('href="/files/Z%23%20notes/a%20b%23c.txt"');

      // The encoded file link serves the bytes.
      const file = await authedFetch(env, "/files/Z%23%20notes/a%20b%23c.txt");
      expect(file.status).toBe(200);
      expect(await file.text()).toContain("hash file");
    });
  });

  describe("browse: directory listing", () => {
    it("lists folders and files, folders first, excluding dotfiles and symlinks", async () => {
      const html = await text("/browse");
      // Folders sort before files; each group is alphabetical.
      const docs = html.indexOf("Documents");
      const projects = html.indexOf("Projects");
      const config = html.indexOf("config.json");
      const readme = html.indexOf("readme.md");
      expect(docs).toBeGreaterThan(-1);
      expect(projects).toBeGreaterThan(-1);
      expect(config).toBeGreaterThan(-1);
      expect(readme).toBeGreaterThan(-1);
      expect(docs).toBeLessThan(config);
      expect(projects).toBeLessThan(config);
      expect(config).toBeLessThan(readme);
      // Secrets and symlinks are hidden from view.
      expect(html).not.toContain(".ssh");
      expect(html).not.toContain("id_rsa");
      expect(html).not.toContain(".env");
      expect(html).not.toContain("link-etc");
      expect(html).not.toContain("link-docs");
    });

    it("shows a breadcrumb rooted at ~", async () => {
      const html = await text("/browse");
      expect(html).toContain('class="browse-breadcrumb"');
      expect(html).toContain(">~</a>");
    });

    it("descends into a folder, showing its contents and a parent link", async () => {
      const html = await text("/browse/Documents");
      expect(html).toContain("notes.txt");
      expect(html).toContain("data.json");
      expect(html).toContain('href="/browse"');
      expect(html).toContain(">..</span>");
    });

    it("reports an empty folder clearly", async () => {
      const html = await text("/browse/Projects");
      expect(html).toContain("browse-empty");
      expect(html).toContain("empty");
    });

    it("returns only the listing fragment for an htmx request", async () => {
      const res = await authedFetch(env, "/browse", {
        headers: { "HX-Request": "true" },
      });
      const html = await res.text();
      expect(html).toContain("browse-breadcrumb");
      // A fragment swap never includes the page shell / sidebar.
      expect(html).not.toContain("<html");
      expect(html).not.toContain('class="sidebar"');
    });

    it("navigates between folders in a real browser via htmx", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/browse`);
        // Target Documents by name rather than "the first folder": on
        // Windows the server's Known-Folders data dir (AppData/Roaming/…)
        // is created inside the fake home at boot and sorts first.
        await page
          .locator(".browse-entry-folder a", { hasText: "Documents" })
          .click();
        await expect(page.locator(".browse-list")).toBeVisible();
        await expect(
          page.locator(".browse-entry-name", { hasText: "notes.txt" }),
        ).toBeVisible();
        // The URL advanced to the descended folder.
        expect(page.url()).toContain("/browse/Documents");
      });
    });
  });

  describe("browse: file delivery", () => {
    it("serves a file's bytes", async () => {
      const res = await authedFetch(env, "/files/Documents/notes.txt");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello world\n");
    });

    it("sets a content type derived from the extension", async () => {
      const res = await authedFetch(env, "/files/config.json");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain(
        "application/json",
      );
      expect(await res.text()).toBe('{"v":1}');
    });

    it("404s when a file path points at a folder", async () => {
      const res = await authedFetch(env, "/files/Documents");
      expect(res.status).toBe(404);
    });
  });

  // The vendored sendFile (from the @hono/node-server fork) served these; the
  // local copy must keep the same wire behavior: ranges, conditionals, and
  // HEAD metadata.
  describe("browse: file delivery — ranges and conditionals", () => {
    it("serves a bounded byte range as 206 with Content-Range", async () => {
      const res = await authedFetch(env, "/files/Documents/notes.txt", {
        headers: { Range: "bytes=0-4" },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe("bytes 0-4/12");
      expect(res.headers.get("content-length")).toBe("5");
      expect(await res.text()).toBe("hello");
    });

    it("serves a suffix range from the file's tail", async () => {
      const res = await authedFetch(env, "/files/Documents/notes.txt", {
        headers: { Range: "bytes=-5" },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe("bytes 7-11/12");
      expect(await res.text()).toBe("orld\n");
    });

    it("serves an open-ended range to EOF", async () => {
      const res = await authedFetch(env, "/files/Documents/notes.txt", {
        headers: { Range: "bytes=6-" },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe("bytes 6-11/12");
      expect(await res.text()).toBe("world\n");
    });

    it("rejects an unsatisfiable range with 416 and the total size", async () => {
      const res = await authedFetch(env, "/files/Documents/notes.txt", {
        headers: { Range: "bytes=100-200" },
      });
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe("bytes */12");
    });

    it("serves the whole file when the Range header is malformed", async () => {
      const res = await authedFetch(env, "/files/Documents/notes.txt", {
        headers: { Range: "bytes=abc" },
      });
      // As serveStatic always did: an unparseable range degrades to an
      // open-ended range from zero — the whole file, still as 206.
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe("bytes 0-11/12");
      expect(await res.text()).toBe("hello world\n");
    });

    it("answers HEAD with metadata and no body", async () => {
      const res = await authedFetch(env, "/files/Documents/notes.txt", {
        method: "HEAD",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe("12");
      expect(res.headers.get("last-modified")).toBeTruthy();
      expect(await res.text()).toBe("");
    });

    it("returns 304 for an unmodified If-Modified-Since", async () => {
      const full = await authedFetch(env, "/files/Documents/notes.txt");
      const lastModified = full.headers.get("last-modified");
      expect(lastModified).toBeTruthy();
      const res = await authedFetch(env, "/files/Documents/notes.txt", {
        headers: { "If-Modified-Since": lastModified ?? "" },
      });
      expect(res.status).toBe(304);
      // A 304 carries no representation metadata (RFC 9110 §15.4.5).
      expect(res.headers.get("content-type")).toBe(null);
      expect(await res.text()).toBe("");
    });

    it("serves the file when If-Modified-Since predates it", async () => {
      const res = await authedFetch(env, "/files/Documents/notes.txt", {
        headers: { "If-Modified-Since": "Mon, 01 Jan 1990 00:00:00 GMT" },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello world\n");
    });

    it("ignores If-Modified-Since when If-None-Match is present", async () => {
      const full = await authedFetch(env, "/files/Documents/notes.txt");
      const res = await authedFetch(env, "/files/Documents/notes.txt", {
        headers: {
          "If-Modified-Since": full.headers.get("last-modified") ?? "",
          "If-None-Match": '"etag"',
        },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("browse: security — dotfile exclusion", () => {
    it("refuses to list a dotfile directory", async () => {
      const res = await authedFetch(env, "/browse/.ssh");
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("id_rsa");
    });

    it("refuses to serve a dotfile's bytes", async () => {
      const res = await authedFetch(env, "/files/.ssh/id_rsa");
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("SECRET");
    });

    it("refuses to serve a dotfile at the root", async () => {
      const res = await authedFetch(env, "/files/.env");
      expect(res.status).toBe(404);
    });
  });

  describe("browse: security — traversal containment", () => {
    // The URL layer collapses a literal "..", so the attack vector is an encoded
    // slash (%2F) smuggled inside a segment. It must decode to a "/" and be
    // rejected before any filesystem access happens.
    it("rejects an encoded-slash traversal", async () => {
      const res = await authedFetch(env, "/browse/x%2F..%2F..%2Fetc");
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain("passwd");
    });

    it("rejects an encoded-slash traversal on the file route", async () => {
      const res = await authedFetch(env, "/files/x%2F..%2F..%2Fetc%2Fpasswd");
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("root:");
    });
  });

  describe("browse: security — symlink safety", () => {
    it.runIf(canSymlink)("never lists a symlink", async () => {
      const html = await text("/browse");
      expect(html).not.toContain("link-etc");
      expect(html).not.toContain("link-docs");
    });

    it.runIf(canSymlink)(
      "refuses to follow a symlinked directory entry",
      async () => {
        const res = await authedFetch(env, "/browse/link-etc");
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("hostname");
      },
    );

    it.runIf(canSymlink)(
      "refuses to follow a symlink even when its target is inside the root",
      async () => {
        const res = await authedFetch(env, "/browse/link-docs");
        expect(res.status).toBe(404);
      },
    );

    it.runIf(canSymlink)("refuses a symlink nested in the path", async () => {
      const res = await authedFetch(env, "/browse/link-docs/notes.txt");
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("hello world");
    });
  });

  describe("browse: auth gate", () => {
    it("redirects unauthenticated requests to the auth gate", async () => {
      const res = await fetch(`${env.baseUrl}/browse`, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location") ?? "").toMatch(/^\/auth/);
    });

    it("redirects unauthenticated file requests to the auth gate", async () => {
      const res = await fetch(`${env.baseUrl}/files/readme.md`, {
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location") ?? "").toMatch(/^\/auth/);
    });
  });
};

export { runBrowseSuite };
