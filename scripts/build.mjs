import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });

await build({
  entryPoints: ["src/code.ts"],
  bundle: true,
  outfile: "dist/code.js",
  target: "es2017",
  format: "iife"
});

await build({
  entryPoints: ["src/ui.ts"],
  bundle: true,
  outfile: "dist/ui.js",
  target: "es2017",
  format: "iife"
});

const html = await readFile("src/ui.html", "utf8");
const js = await readFile("dist/ui.js", "utf8");
await writeFile("dist/ui.html", html.replace("<!-- UI_SCRIPT -->", `<script>${js}</script>`));
