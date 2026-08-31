import path from "node:path";

import {
  CRITICAL_DEPENDENCY_RECEIPT_SYMBOL,
  verifyCriticalPostgresDependencies,
} from "./foundation/dependency-integrity.mts";
import { registerTrackedTypeScriptResolver } from "./foundation/typescript-resolver.mts";

const receipt = await verifyCriticalPostgresDependencies(path.resolve(process.cwd()));
Object.defineProperty(globalThis, CRITICAL_DEPENDENCY_RECEIPT_SYMBOL, {
  value: receipt,
  configurable: false,
  enumerable: false,
  writable: false,
});
registerTrackedTypeScriptResolver(path.resolve(process.cwd()));
await import("./run.mts");
