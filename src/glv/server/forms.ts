import type { FastifyRequest } from "fastify";
import { isRecord } from "./http.js";

// Form-body normalization for Fastify.
//
// @fastify/formbody parses urlencoded bodies into strings / string arrays
// (repeated keys); @fastify/multipart (attachFieldsToBody) wraps each part
// in { type: "field", value } or { type: "file", ... } objects with files
// buffered by the plugin. This module erases the wrapper shapes so route
// handlers see one body shape — a record of string / string[] / File /
// File[] — exactly what Hono's parseBody({ all: true }) used to yield.

const isFieldPart = (
  value: unknown,
): value is { type: "field"; value: string } =>
  isRecord(value) && value.type === "field" && typeof value.value === "string";

type FilePart = {
  type: "file";
  filename: string;
  mimetype: string;
  toBuffer: () => Promise<Buffer>;
};

const isFilePart = (value: unknown): value is FilePart =>
  isRecord(value) &&
  value.type === "file" &&
  typeof value.filename === "string" &&
  typeof value.mimetype === "string" &&
  typeof value.toBuffer === "function";

// Files become Web File objects — the shape saveUploads already consumes
// (name, size, arrayBuffer()).
const toWebFile = async (part: FilePart): Promise<File> => {
  // Copy into a plain Uint8Array so the File's blob part owns its buffer
  // (Buffer's ArrayBufferLike backing type is not a BlobPart under the
  // DOM lib's stricter ArrayBufferView<ArrayBuffer>).
  const bytes = new Uint8Array(await part.toBuffer());
  return new File([bytes], part.filename, { type: part.mimetype });
};

const normalizePart = async (
  value: unknown,
): Promise<string | File | undefined> => {
  if (typeof value === "string") return value;
  if (isFieldPart(value)) return value.value;
  if (isFilePart(value)) return toWebFile(value);
  return undefined;
};

const normalizeEntry = async (
  value: unknown,
): Promise<string | File | Array<string | File> | undefined> => {
  if (!Array.isArray(value)) return normalizePart(value);
  const items: Array<string | File> = [];
  for (const item of value) {
    const normalized = await normalizePart(item);
    if (normalized !== undefined) items.push(normalized);
  }
  // Repeated keys stay arrays (the follow-up step fields rely on order);
  // a single value collapses to itself, matching the urlencoded shape.
  return items.length === 1 ? items[0] : items;
};

// Reads a parsed form body (urlencoded or multipart) into the normalized
// record. JSON bodies (the auth endpoints) never route through here.
const parseForm = async (
  request: FastifyRequest,
): Promise<Record<string, unknown>> => {
  const body: unknown = request.body;
  if (!isRecord(body)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    const normalized = await normalizeEntry(value);
    if (normalized !== undefined) out[key] = normalized;
  }
  return out;
};

export { parseForm };
