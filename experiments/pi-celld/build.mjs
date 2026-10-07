import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/worker.mjs"],
  outfile: "dist/worker.mjs",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  // Keep this isolated experiment independent of the mobile Expo tsconfig.
  tsconfigRaw: { compilerOptions: {} },
  external: ["cloudflare:*", "node:*"],
  metafile: true,
  sourcemap: "external",
  legalComments: "eof",
  logLevel: "info",
});
await mkdir("dist", { recursive: true });
await writeFile("dist/metafile.json", JSON.stringify(result.metafile, null, 2) + "\n");
const externals = [...new Set(Object.values(result.metafile.outputs)
  .flatMap((output) => output.imports.filter((entry) => entry.external).map((entry) => entry.path)))];
console.log(JSON.stringify({ externalImports: externals }));
