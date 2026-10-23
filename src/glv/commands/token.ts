import type { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import {
  type ApiTokenSummary,
  createApiToken,
  listApiTokenSummaries,
  ownerUserId,
  revokeApiToken,
} from "../auth/db.js";
import { renderTable } from "../format/index.js";

// Same 1–64-char label rule as the browser surface
// (server/routes/tokens.tsx).
const ApiTokenName = type("string.trim").pipe(type("1<=string<=64"));

const NAME_ERROR = "A token name of 1–64 characters is required.";

const HEADERS = ["ID", "Name", "Created", "Last used", "Expires"];

// Ids are 64-char hashes that revoke needs verbatim, so the table must
// not truncate them (renderTable's default ceiling is 40).
const MAX_COLUMN_WIDTH = 64;

const tokenToCells = (t: ApiTokenSummary): string[] => [
  t.id,
  t.name,
  t.createdAt,
  t.lastUsedAt ?? "never",
  t.expiresAt,
];

const runTokenCreate = (db: DatabaseSync, rawName: string): void => {
  const name = ApiTokenName(rawName);
  if (name instanceof type.errors) {
    console.error(NAME_ERROR);
    process.exitCode = 1;
    return;
  }
  // A token grants the single owner's identity, so minting requires one.
  const owner = ownerUserId(db);
  if (owner === undefined) {
    console.error(
      "This app has no owner yet — start glv serve and register a " +
        "passkey once, then mint tokens.",
    );
    process.exitCode = 1;
    return;
  }
  const token = createApiToken(db, owner, name);
  // Stdout is exactly the raw token so `TOKEN=$(glv token create …)`
  // captures it cleanly; the note is for humans, so it goes to stderr.
  console.log(token);
  console.error(
    `Token "${name}" created — shown once, expires in 30 days; only ` +
      "its SHA-256 hash is stored.",
  );
};

const runTokenList = (db: DatabaseSync): void => {
  const tokens = listApiTokenSummaries(db);
  if (tokens.length === 0) {
    console.log("No tokens found.");
    return;
  }
  console.log(renderTable(HEADERS, tokens.map(tokenToCells), MAX_COLUMN_WIDTH));
  console.log(`\n${tokens.length} token(s) listed.`);
};

const runTokenRevoke = (db: DatabaseSync, id: string): void => {
  // An unknown id is a typo in practice — say so instead of silently
  // revoking nothing.
  const token = listApiTokenSummaries(db).find((t) => t.id === id);
  if (token === undefined) {
    console.error(`No token with id ${id}.`);
    process.exitCode = 1;
    return;
  }
  revokeApiToken(db, id);
  console.log(`Revoked token "${token.name}".`);
};

export { runTokenCreate, runTokenList, runTokenRevoke };
