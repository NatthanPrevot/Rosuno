#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOG_HASH_ALGORITHM,
  CATALOG_SQL,
  queryCatalog,
  verifyCatalogFingerprint,
} from "./lib/catalog-fingerprint.mjs";

const databaseUrl = process.env.P0_STAGING_DB_URL;
const mode = process.argv[2] ?? "--fingerprint";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

if (mode === "--query") {
  process.stdout.write(`${CATALOG_SQL.trim()}\n`);
} else {
  const result = queryCatalog(databaseUrl);
  if (mode === "--verify") {
    const baseline = JSON.parse(
      readFileSync(
        path.join(root, "governance/evidence/p1-002-catalog-fingerprint.json"),
        "utf8",
      ),
    );
    verifyCatalogFingerprint(result, baseline);
  }
  const output = {
    algorithm: CATALOG_HASH_ALGORITHM,
    sha256: result.sha256,
    canonical_byte_length: result.canonicalBytes.length,
    category_counts: result.categoryCounts,
    verified: mode === "--verify",
  };
  if (mode === "--snapshot") output.snapshot = result.snapshot;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}
