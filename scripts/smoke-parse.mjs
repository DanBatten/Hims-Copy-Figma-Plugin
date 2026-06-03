import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const docPath = process.argv[2] ?? "/Users/delilah/Downloads/07363_WL-Titration-Paid-Social_Lola-V1.md (1).docx";

await build({
  entryPoints: ["src/parser.ts"],
  bundle: true,
  outfile: "dist/parser.cjs",
  platform: "node",
  format: "cjs"
});

const { parseCopyDoc } = await import("../dist/parser.cjs");
const text = docPath.endsWith(".docx")
  ? (await execFileAsync("textutil", ["-convert", "txt", "-stdout", docPath], { maxBuffer: 10 * 1024 * 1024 })).stdout
  : await readFile(docPath, "utf8");
const ads = parseCopyDoc(text);

console.log(JSON.stringify({
  count: ads.length,
  first: ads[0],
  ids: ads.map((ad) => ad.id)
}, null, 2));
