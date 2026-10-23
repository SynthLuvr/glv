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

// The CLI minting surface for agents (issue #361): the same
// createApiToken/revokeApiToken the browser's /auth/tokens page calls,
// driven from a shell against the same auth database serve owns. This
// is a new caller for the existing operation, not new crypto — the
// invariants in auth/db.ts stay authoritative: the plaintext is shown
// exactly once, only its SHA-256 hash is stored, fixed 30-day TTL, no
// sliding refresh.

// The same label rule as the browser surface (server/routes/tokens.tsx):
// a free-form 1–64 character name once trimmed. The stored hash is the
// identifier; the name exists for the list.
const ApiTokenName = type("string.trim").pipe(type("1<=string<=64"));

const NAME_ERROR = "A token name of 1–64 characters is required.";

// The id is the stored 64-hex-char hash, so revoke needs it verbatim —
// the table's width ceiling must not truncate it.
const HEADERS = ["ID", "Name", "Created", "Last used", "Expires"];

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
  // Minting underneath an owner is the whole security story: a token
  // grants the single owner's identity, so there must be one to grant.
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
  // The raw token is the command's entire stdout so it captures
  // cleanly (TOKEN=$(glv token create --name ci)); the human-facing
  // note stays on stderr.
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
  console.log(renderTable(HEADERS, tokens.map(tokenToCells), 64));
  console.log(`\n${tokens.length} token(s) listed.`);
};

const runTokenRevoke = (db: DatabaseSync, id: string): void => {
  // `id` is the stored hash `glv token list` prints. An unknown id is a
  // typo in practice, so say so instead of silently revoking nothing.
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
