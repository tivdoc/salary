import { detectPersistenceEnvironment } from "../../../src/server/platform/persistence/isolated-environment.ts";
import { verifyIsolatedPostgresAvailability } from "../../../src/server/platform/persistence/isolated-verifier.ts";

const environment = detectPersistenceEnvironment();
const receipt = verifyIsolatedPostgresAvailability(environment);
process.stdout.write(`${JSON.stringify({ environment, verification: receipt })}\n`);
