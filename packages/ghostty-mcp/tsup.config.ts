import { defineConfig } from "tsup";

// Keep runtime dependencies external. In particular, the VT package's
// package-relative WASM loader must resolve from @gkoreli/ghostty-vt-js.
export default defineConfig([
  {
    entry: { "ghostty-mcp": "src/cli.ts" },
    format: ["esm"],
    outDir: "dist",
    banner: { js: "#!/usr/bin/env node" },
    clean: true,
    target: "node22",
    external: [/^@gkoreli\/ghostty-vt-js/],
  },
]);
