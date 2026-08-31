import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const explicitRuntimeExtension = /\.(?:c?js|mjs|json|node|tsx?|mts|cts)$/u;
const trackedTypeScriptSuffixes = [".ts", ".mts", "/index.ts", "/index.mts"] as const;

export function registerTrackedTypeScriptResolver(repositoryRoot: string): void {
  const sourceRoot = path.resolve(repositoryRoot, "src");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith("@/")) {
        const candidateBase = path.resolve(sourceRoot, specifier.slice(2));
        if (!candidateBase.startsWith(`${sourceRoot}${path.sep}`)) {
          throw new Error("DYNAMIC_TYPESCRIPT_ALIAS_PATH_ESCAPE");
        }
        let originalError: unknown;
        try {
          return nextResolve(specifier, context);
        } catch (error) {
          originalError = error;
        }
        for (const suffix of trackedTypeScriptSuffixes) {
          try {
            return nextResolve(pathToFileURL(`${candidateBase}${suffix}`).href, context);
          } catch {
            // Continue through the finite, tracked TypeScript candidate set.
          }
        }
        throw originalError;
      }
      if ((!specifier.startsWith("./") && !specifier.startsWith("../"))
        || explicitRuntimeExtension.test(specifier)) {
        return nextResolve(specifier, context);
      }

      let originalError: unknown;
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        originalError = error;
      }
      for (const suffix of trackedTypeScriptSuffixes) {
        try {
          return nextResolve(`${specifier}${suffix}`, context);
        } catch {
          // Continue through the finite, tracked TypeScript candidate set.
        }
      }
      throw originalError;
    },
  });
}
