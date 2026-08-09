import { build } from "esbuild";

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

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/ssh-inspector.mjs",
  sourcemap: false,
  legalComments: "eof",
  plugins: [optionalNativePlugin],
  banner: {
    js: "#!/usr/bin/env node",
  },
});