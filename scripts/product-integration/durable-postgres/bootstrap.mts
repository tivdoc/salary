import path from "node:path";

import { registerTrackedTypeScriptResolver } from "../../canonical-persistence-v091/foundation/typescript-resolver.mts";

const root = path.resolve(process.cwd());
registerTrackedTypeScriptResolver(root);
await import("./run.mts");
