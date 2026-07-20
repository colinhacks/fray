// Invoked through Nub by artifacts.ts. Keeping the esbuild API in a tiny Node entry avoids asking
// Nub to execute esbuild's platform binary as though it were JavaScript, while retaining Nub's
// source-loader/runtime contract for the build itself.
import { build } from "esbuild";

const output = process.argv[2];
if (!output) throw new Error("usage: build-runtime.mjs <outfile>");

await build({
  entryPoints: ["packages/cli/src/index.ts"],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  // Some bundled dependencies (including ws) retain CommonJS dynamic `require()` calls for
  // Node built-ins. In an ESM bundle esbuild otherwise installs a throwing require shim. Give
  // that shim a real, bundle-relative CommonJS resolver while preserving ESM/import.meta.
  banner: {
    js: 'import { createRequire as __frayCreateRequire } from "node:module"; const require = __frayCreateRequire(import.meta.url);',
  },
  external: ["better-sqlite3", "node-pty", "@parcel/watcher", "vite"],
  logLevel: "silent",
});
