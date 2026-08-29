import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { legalSourceRelationSchema } from "../../../engine/legal-knowledge/contracts.ts";

export const legalSourceRelationsManifestSchema = z.object({
  schema_version: z.literal("legal-source-relations-v0.1"),
  automatic_legal_inference: z.literal(false),
  relations: z.array(legalSourceRelationSchema),
}).strict();

export const defaultLegalSourceRelationsPath = path.resolve(
  "src",
  "server",
  "engine",
  "legal-knowledge",
  "legal-relations.v0.1.json",
);

export async function loadLegalSourceRelations(filePath = defaultLegalSourceRelationsPath) {
  return legalSourceRelationsManifestSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
}
