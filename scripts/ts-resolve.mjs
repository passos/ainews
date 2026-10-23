// Preload for Node scripts that import src/ files. Most src/ files import
// each other without a file extension (the bundler and vitest resolve
// those), but Node does not. This hook retries a relative specifier that has
// no extension with ".ts". It changes nothing under src/.
//
// Usage: node --import ./scripts/ts-resolve.mjs scripts/<name>.ts
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative =
        specifier.startsWith("./") || specifier.startsWith("../");
      if (
        relative &&
        error?.code === "ERR_MODULE_NOT_FOUND" &&
        !/\.[cm]?[jt]sx?$/.test(specifier)
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
