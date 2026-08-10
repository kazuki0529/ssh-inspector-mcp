import { build } from "esbuild";
import { chmod, rm } from "node:fs/promises";

const bundlePath = "dist/ssh-inspector-mcp.mjs";

const optionalNativePlugin = {
  name: "optional-native",
  setup(buildContext) {
    // ssh2はnative addon読込失敗を捕捉してpure-JSへfallbackするため、静的bundleだけを避けます。
    buildContext.onResolve({ filter: /\.node$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

await rm("dist/ssh-inspector.mjs", { force: true });

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: bundlePath,
  sourcemap: false,
  legalComments: "eof",
  plugins: [optionalNativePlugin],
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nimport { dirname as __pathDirname } from 'node:path';\nimport { fileURLToPath as __fileURLToPath } from 'node:url';\nconst require = __createRequire(import.meta.url);\nconst __filename = __fileURLToPath(import.meta.url);\nconst __dirname = __pathDirname(__filename);",
  },
});

await chmod(bundlePath, 0o755);