import { createServer } from "node:http";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const root = path.resolve(process.env.HERMES_QUEUE_DIR || "queue-data");
const figmaToken = process.env.FIGMA_TOKEN || "";
const figmaFileKey = process.env.FIGMA_FILE_KEY || "";
const implementedReactionEmoji = process.env.FIGMA_IMPLEMENTED_REACTION || ":white_check_mark:";
const authToken = process.env.HERMES_QUEUE_TOKEN || "";
const dirs = {
  queued: path.join(root, "queued"),
  inflight: path.join(root, "inflight"),
  completed: path.join(root, "completed"),
  failed: path.join(root, "failed")
};

await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));

createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : "Internal server error" });
  }
}).listen(port, host, () => {
  console.log(`Hermes Figma queue listening on http://${host}:${port}`);
  console.log(`Queue data: ${root}`);
  console.log(authToken ? "Auth: bearer token required" : "Auth: disabled");
});

async function route(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { ok: true });
    return;
  }

  if (!isAuthorized(request)) {
    json(response, 401, { error: "Unauthorized" });
    return;
  }

  if (request.method === "POST" && url.pathname === "/jobs") {
    const payload = await readJson(request);
    const jobId = safeId(payload.jobId || randomUUID());
    const existing = await findJob(jobId);
    if (existing) {
      json(response, 409, { jobId, status: existing.status, error: `Job ${jobId} already exists in ${existing.status}.` });
      return;
    }
    payload.jobId = jobId;
    payload.createdAt = new Date().toISOString();
    await writeFile(path.join(dirs.queued, `${jobId}.json`), JSON.stringify(payload, null, 2));
    json(response, 202, { jobId, status: "queued" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/jobs") {
    json(response, 200, await listJobs());
    return;
  }

  if (request.method === "GET" && url.pathname === "/jobs/next") {
    const files = (await readdir(dirs.queued)).filter((file) => file.endsWith(".json")).sort();
    if (files.length === 0) {
      response.writeHead(204);
      response.end();
      return;
    }
    const file = files[0];
    const queuedPath = path.join(dirs.queued, file);
    const inflightPath = path.join(dirs.inflight, file);
    await rename(queuedPath, inflightPath);
    const job = JSON.parse(await readFile(inflightPath, "utf8"));
    json(response, 200, job);
    return;
  }

  const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
  if (request.method === "GET" && jobMatch) {
    const jobId = safeId(decodeURIComponent(jobMatch[1]));
    const existing = await findJob(jobId);
    if (!existing) {
      json(response, 404, { error: `No job found for ${jobId}.` });
      return;
    }
    json(response, 200, existing);
    return;
  }

  if (request.method === "POST" && url.pathname === "/jobs/purge-queued") {
    const files = (await readdir(dirs.queued)).filter((file) => file.endsWith(".json"));
    await Promise.all(files.map((file) => rm(path.join(dirs.queued, file), { force: true })));
    json(response, 200, { purged: files.length });
    return;
  }

  const statusMatch = url.pathname.match(/^\/jobs\/([^/]+)\/(completed|failed)$/);
  if (request.method === "POST" && statusMatch) {
    const jobId = safeId(decodeURIComponent(statusMatch[1]));
    const status = statusMatch[2];
    const source = path.join(dirs.inflight, `${jobId}.json`);
    const destination = path.join(status === "completed" ? dirs.completed : dirs.failed, `${jobId}.json`);
    const note = await readJson(request).catch(() => ({}));
    if (!existsSync(source)) {
      json(response, 404, { error: `No inflight job found for ${jobId}.` });
      return;
    }
    const job = JSON.parse(await readFile(source, "utf8"));
    job.finishedAt = new Date().toISOString();
    job.status = status;
    job.result = note;
    await writeFile(source, JSON.stringify(job, null, 2));
    await rename(source, destination);
    if (status === "completed") await markSourceCommentImplemented(job);
    json(response, 200, { jobId, status });
    return;
  }

  json(response, 404, { error: "Not found" });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120);
}

function isAuthorized(request) {
  if (!authToken) return true;
  return request.headers.authorization === `Bearer ${authToken}`;
}

async function findJob(jobId) {
  for (const status of Object.keys(dirs)) {
    const file = path.join(dirs[status], `${jobId}.json`);
    if (!existsSync(file)) continue;
    const job = JSON.parse(await readFile(file, "utf8"));
    return { status, jobId, job };
  }
  return null;
}

async function listJobs() {
  const result = {};
  for (const status of Object.keys(dirs)) {
    const files = (await readdir(dirs[status])).filter((file) => file.endsWith(".json")).sort();
    result[status] = await Promise.all(
      files.map(async (file) => {
        const job = JSON.parse(await readFile(path.join(dirs[status], file), "utf8"));
        return {
          jobId: job.jobId || file.replace(/\.json$/, ""),
          createdAt: job.createdAt,
          finishedAt: job.finishedAt,
          status: job.status || status
        };
      })
    );
  }
  return result;
}

async function markSourceCommentImplemented(job) {
  const commentId = job && job.sourceCommentId;
  const fileKey = (job && job.fileKey) || figmaFileKey;
  if (!figmaToken || !fileKey || !commentId) return;

  try {
    await figmaRequest(`/v1/files/${fileKey}/comments/${encodeURIComponent(commentId)}/reactions`, {
      method: "POST",
      body: JSON.stringify({ emoji: implementedReactionEmoji })
    });
  } catch (error) {
    console.error(`Could not react to Figma comment ${commentId}:`, error instanceof Error ? error.message : error);
  }
}

async function figmaRequest(endpoint, options) {
  const response = await fetch(`https://api.figma.com${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Figma-Token": figmaToken,
      ...(options && options.headers ? options.headers : {})
    }
  });
  if (!response.ok) throw new Error(`Figma returned ${response.status}: ${await response.text()}`);
  return response;
}
