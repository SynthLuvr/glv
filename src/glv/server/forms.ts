import type {} from "@fastify/multipart";
import type { FastifyRequest } from "fastify";

// Mirrors hono's parseBody({ all: true }): a record of field values where
// a repeated field name yields an array and a single occurrence yields the
// value itself. Multipart bodies (file uploads) are consumed part by part;
// urlencoded and JSON bodies arrive already parsed on req.body.
const pushField = (
  body: Record<string, unknown>,
  name: string,
  value: unknown,
): void => {
  const existing = body[name];
  if (Array.isArray(existing)) existing.push(value);
  else if (existing !== undefined) body[name] = [existing, value];
  else body[name] = value;
};

const parseForm = async (
  req: FastifyRequest,
): Promise<Record<string, unknown>> => {
  if (req.isMultipart()) {
    const body: Record<string, unknown> = {};
    for await (const part of req.parts()) {
      // File parts buffer into a File so the existing upload pipeline
      // (size caps, sanitized names) sees the same shape hono produced.
      const value =
        part.type === "file"
          ? await part.toBuffer().then((buffer) => toFile(part, buffer))
          : part.value;
      pushField(body, part.fieldname, value);
    }
    return body;
  }
  const body = req.body;
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)
    : {};
};

const toFile = (
  part: { filename: string; mimetype: string },
  buffer: Buffer,
): File =>
  new File([new Uint8Array(buffer)], part.filename, {
    type: part.mimetype,
  });

export { parseForm };
