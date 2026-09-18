import type {} from "@fastify/multipart";
import type { FastifyRequest } from "fastify";

// Multipart file parts buffer into a File so the upload pipeline (size
// caps, sanitized names) sees the shape it was built for.
const toFile = (
  part: { filename: string; mimetype: string },
  buffer: Buffer,
): File =>
  new File([new Uint8Array(buffer)], part.filename, {
    type: part.mimetype,
  });

// Adds a field occurrence: a repeated name yields an array, a single
// occurrence yields the value itself.
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

// Form fields as a record. Multipart bodies (file uploads) are consumed
// part by part; urlencoded and JSON bodies arrive already parsed on
// req.body.
const parseForm = async (
  req: FastifyRequest,
): Promise<Record<string, unknown>> => {
  if (req.isMultipart()) {
    const body: Record<string, unknown> = {};
    for await (const part of req.parts()) {
      const value =
        part.type === "file" ? toFile(part, await part.toBuffer()) : part.value;
      pushField(body, part.fieldname, value);
    }
    return body;
  }
  const body = req.body;
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)
    : {};
};

export { parseForm };
