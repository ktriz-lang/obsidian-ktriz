// Shared esbuild bundling helper for the verify-*.mjs scripts. Each of them
// bundles a small TypeScript entry point (which just re-exports production
// functions from src/) into a CJS file they can `require()`, aliasing the
// "obsidian" import to obsidian-stub.mjs since Obsidian's actual runtime
// isn't available outside the app.

import esbuild from "esbuild";
import path from "path";

const obsidianStubPlugin = (stubDir) => ({
  name: "obsidian-stub",
  setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({
      path: path.join(stubDir, "obsidian-stub.mjs"),
    }));
  },
});

/**
 * Bundle `entryFile` (an absolute path) to `outFile` (an absolute path) as a
 * Node-targeted CJS module, with "obsidian" resolved to obsidian-stub.mjs.
 * `stubDir` is the directory obsidian-stub.mjs lives in (defaults to the
 * directory containing this file).
 */
export async function buildEntry(entryFile, outFile, stubDir = import.meta.dirname) {
  await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "es2018",
    outfile: outFile,
    plugins: [obsidianStubPlugin(stubDir)],
    logLevel: "silent",
  });
  return outFile;
}
