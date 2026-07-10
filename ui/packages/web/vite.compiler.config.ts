import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// PRONG-2.5 EVALUATION CONFIG (render-perf thread): identical to vite.config.ts plus the React
// Compiler (babel-plugin-react-compiler) enabled through @vitejs/plugin-react's babel hook. Used ONLY
// by explicit `vite build --config vite.compiler.config.ts` A/B runs — the dev server never reads it
// (its embedded Vite watches vite.config.ts alone). The plugin resolves from an ISOLATED scratchpad
// install so the repo's package.json/pnpm-lock stay untouched during the evaluation; if the compiler
// is ADOPTED, install it as a real devDependency and fold this into vite.config.ts instead.
const COMPILER_PLUGIN =
  process.env.REACT_COMPILER_PLUGIN ??
  "/private/tmp/claude-501/-Users-colinmcd94-Documents-projects-fray/d3b316e5-075f-47cb-b0dc-ccf3628bd73d/scratchpad/compiler-eval/node_modules/babel-plugin-react-compiler"

export default defineConfig({
  plugins: [react({ babel: { plugins: [[COMPILER_PLUGIN, {}]] } }), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
})
