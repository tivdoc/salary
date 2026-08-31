import { detectPersistenceEnvironment } from "../../../src/server/platform/persistence/isolated-environment.ts";

const receipt = detectPersistenceEnvironment();
process.stdout.write(`${JSON.stringify(receipt)}\n`);
