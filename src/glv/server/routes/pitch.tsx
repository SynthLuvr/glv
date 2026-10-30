import type { FastifyInstance } from "fastify";
import { PitchPage } from "../../views/Pitch.js";
import type { ServerContext } from "../context.js";
import { sendHtml } from "../http.js";

// GET /pitch — the public single-page tour of glv (see the PITCH_PATH
// exemption in auth/service.ts). Static content only: it names the served
// agents and links back to the viewer, touching no session data.
const registerPitchRoutes = (
  app: FastifyInstance,
  ctx: ServerContext,
): void => {
  app.get("/pitch", (_request, reply) =>
    sendHtml(reply, <PitchPage agentNames={ctx.agentNames} />),
  );
};

export { registerPitchRoutes };
