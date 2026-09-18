import { homedir } from "node:os";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BrowseDetail, BrowseError } from "../../views/Browse.js";
import { listBrowseDir, resolveBrowsePath } from "../browse.js";
import type { ServerContext } from "../context.js";
import { VIEWER_FILTER } from "../context.js";
import { sendNotFound } from "../http.js";
import { render } from "../render.js";
import { sendFile } from "../send-file.js";

const BROWSE_PREFIX = "/browse";
const FILES_PREFIX = "/files";

type BrowseParams = { "*": string };

const browseTitle = (rel: string): string =>
  rel === "" ? "Browse ~ — GLV" : `Browse ~/${rel} — GLV`;

const renderBrowse = (
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: ServerContext,
  sub: string,
): FastifyReply => {
  const home = homedir();
  const target = resolveBrowsePath(home, sub);
  const sessions = ctx.sessions.listSessions(VIEWER_FILTER);
  if (!target.ok)
    return render(
      request,
      reply,
      ctx,
      sessions,
      undefined,
      <BrowseError status={target.status} />,
      { status: target.status, title: "Browse — GLV" },
    );
  if (!target.stat.isDirectory())
    return render(
      request,
      reply,
      ctx,
      sessions,
      undefined,
      <BrowseError status={404} />,
      {
        status: 404,
        title: "Browse — GLV",
      },
    );
  const entries = listBrowseDir(target.abs);
  return render(
    request,
    reply,
    ctx,
    sessions,
    undefined,
    <BrowseDetail rel={target.rel} entries={entries} />,
    { title: browseTitle(target.rel) },
  );
};

// Validates containment, dotfile exclusion, and symlink safety before handing
// off to sendFile, which handles content types, byte ranges, and streaming.
const serveBrowseFile = (reply: FastifyReply, sub: string): FastifyReply => {
  const home = homedir();
  const target = resolveBrowsePath(home, sub);
  if (!target.ok)
    return reply
      .status(target.status)
      .type("text/plain; charset=utf-8")
      .send("Not found\n");
  if (!target.stat.isFile()) return sendNotFound(reply);
  return sendFile(reply, target.abs, target.stat);
};

// /browse renders a navigable listing; /files streams a file's bytes. Both sit
// behind the passkey auth gate: neither prefix is on the public allowlist.
const registerBrowseRoutes = (
  app: FastifyInstance,
  ctx: ServerContext,
): void => {
  app.get(BROWSE_PREFIX, (request, reply) =>
    renderBrowse(request, reply, ctx, ""),
  );
  app.get<{ Params: BrowseParams }>(`${BROWSE_PREFIX}/*`, (request, reply) =>
    renderBrowse(request, reply, ctx, request.params["*"]),
  );
  app.get<{ Params: BrowseParams }>(`${FILES_PREFIX}/*`, (request, reply) =>
    serveBrowseFile(reply, request.params["*"]),
  );
};

export { registerBrowseRoutes };
