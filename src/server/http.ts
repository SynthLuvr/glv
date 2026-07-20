import { type Context } from "hono";

const isHtmxRequest = (c: Context): boolean =>
  c.req.header("HX-Request") === "true";

const extractIds = (value: unknown): string[] => {
  if (Array.isArray(value))
    return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" ? [value] : [];
};

const serveAsset = (c: Context, body: string, contentType: string) =>
  c.body(body, 200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=86400",
  });

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export { errorMessage, extractIds, isHtmxRequest, serveAsset };
