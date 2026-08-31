import path from "node:path";

import { verifyCriticalPostgresDependencies } from "../foundation/dependency-integrity.mts";
import { registerTrackedTypeScriptResolver } from "../foundation/typescript-resolver.mts";

await verifyCriticalPostgresDependencies(path.resolve(process.cwd()));
registerTrackedTypeScriptResolver(path.resolve(process.cwd()));
await import("./restart-replay-child.mts");
