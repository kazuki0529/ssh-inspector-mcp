import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/ssh-inspector.mjs",
  sourcemap: false,
  legalComments: "eof",
  banner: {
    js: "#!/usr/bin/env node",
  },
});