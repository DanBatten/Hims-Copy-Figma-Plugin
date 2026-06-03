import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const input = process.argv[2];
if (!input) {
  console.error("Usage: npm run to-json -- path/to/brief.md [job-id]");
  process.exit(1);
}

await build({
  entryPoints: ["src/job.ts"],
  bundle: true,
  outfile: "dist/job.cjs",
  platform: "node",
  format: "cjs"
});

const { parseJobPayload } = await import("../dist/job.cjs");
const job = parseJobPayload(await readFile(input, "utf8"));
if (process.argv[3]) job.jobId = process.argv[3];
console.log(JSON.stringify(job, null, 2));
