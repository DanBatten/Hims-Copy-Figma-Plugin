import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";

const queueUrl = stripTrailingSlash(process.env.HERMES_QUEUE_URL || "http://127.0.0.1:8787");
const queueToken = process.env.HERMES_QUEUE_TOKEN || "";
const figmaToken = process.env.FIGMA_TOKEN || "";
const fileKey = process.env.FIGMA_FILE_KEY || "";
const root = path.resolve(process.env.HERMES_QUEUE_DIR || "queue-data");
const commentDir = path.join(root, "comments");
const pollIntervalMs = Number(process.env.COMMENT_WATCH_INTERVAL_MS || 60000);
const hermesRevisionUrl = process.env.HERMES_REVISION_URL || "";
const hermesRevisionToken = process.env.HERMES_REVISION_TOKEN || "";
const hermesNamespace = "hermes";
const requiredMention = (process.env.FIGMA_COMMENT_REQUIRED_MENTION || "copy.agent@forhims.com").toLowerCase();

if (!figmaToken) throw new Error("FIGMA_TOKEN is required.");
if (!fileKey) throw new Error("FIGMA_FILE_KEY is required.");

await mkdir(commentDir, { recursive: true });

console.log(`Hermes Figma comment watcher polling ${fileKey} every ${pollIntervalMs}ms`);

await poll();
setInterval(() => void poll(), pollIntervalMs);

async function poll() {
  try {
    const comments = await figmaJson(`/v1/files/${fileKey}/comments`);
    for (const comment of comments.comments || []) {
      await processComment(comment);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
}

async function processComment(comment) {
  if (!comment || !comment.id || comment.resolved_at) return;
  if (!comment.message || isAgentStatusComment(comment.message)) return;
  if (requiredMention && !mentionsAgent(comment.message, requiredMention)) return;

  const statePath = path.join(commentDir, `${safeId(fileKey)}-${safeId(comment.id)}.json`);
  if (existsSync(statePath)) return;

  const target = await inferTarget(comment);
  const revisionTask = {
    type: "figma_comment_revision",
    fileKey,
    commentId: comment.id,
    message: comment.message,
    target,
    commentUrl: comment.order_id ? `https://www.figma.com/file/${fileKey}?comment-id=${comment.id}` : undefined,
    createdAt: new Date().toISOString()
  };

  await writeFile(statePath, JSON.stringify({ status: "seen", revisionTask }, null, 2));

  if (hermesRevisionUrl) {
    await postHermesRevision(revisionTask);
    await writeFile(statePath, JSON.stringify({ status: "sent_to_hermes", revisionTask }, null, 2));
  } else if (target.adId && target.field && process.env.COMMENT_WATCHER_DIRECT_PATCH_VALUE) {
    const patchJob = {
      jobId: `comment-${safeId(comment.id)}`,
      mode: "patchTextField",
      sourceCommentId: comment.id,
      target,
      value: process.env.COMMENT_WATCHER_DIRECT_PATCH_VALUE
    };
    await postQueueJob(patchJob);
    await writeFile(statePath, JSON.stringify({ status: "queued_patch", revisionTask, patchJobId: patchJob.jobId }, null, 2));
  } else {
    console.log(`Stored comment ${comment.id}; set HERMES_REVISION_URL to forward revision tasks.`);
  }
}

async function inferTarget(comment) {
  const messageTarget = parseTargetFromMessage(comment.message || "", comment.client_meta || null);
  if (messageTarget.adId && messageTarget.field) return messageTarget;

  const figmaTarget = await resolveTargetFromFigma(comment, messageTarget);
  if (figmaTarget.adId || figmaTarget.field) return figmaTarget;

  return {
    ...messageTarget,
    clientMeta: comment.client_meta || null
  };
}

async function resolveTargetFromFigma(comment, messageTarget) {
  const nodeId = comment && comment.client_meta && comment.client_meta.node_id;
  if (!nodeId) return messageTarget;

  try {
    const data = await figmaJson(`/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&plugin_data=shared`);
    const root = data.nodes && data.nodes[nodeId] && data.nodes[nodeId].document;
    if (!root) return messageTarget;

    const directTarget = targetFromSharedPluginData(root, messageTarget);
    if (directTarget.adId || directTarget.field) return canonicalizeTarget(directTarget);

    const pointCandidates = commentPointCandidates(root, comment.client_meta);
    const textNodes = collectTextNodes(root);
    const matchingFieldNodes = messageTarget.field
      ? textNodes.filter((node) => node.field === normalizeField(messageTarget.field))
      : textNodes;
    const candidates = matchingFieldNodes.length ? matchingFieldNodes : textNodes;
    const targetNode = nearestNode(candidates, pointCandidates) || candidates[0];
    if (!targetNode) return messageTarget;

    return canonicalizeTarget({
      adId: messageTarget.adId || targetNode.adId || adIdFromAncestors(targetNode.ancestors),
      field: messageTarget.field || targetNode.field || normalizeField(targetNode.node.name),
      clientMeta: comment.client_meta || null,
      figmaNodeId: targetNode.node.id || ""
    });
  } catch (error) {
    console.error(`Could not resolve Figma node ${nodeId}:`, error instanceof Error ? error.message : error);
    return messageTarget;
  }
}

function parseTargetFromMessage(message, clientMeta) {
  const adMatch = message.match(/\b(?:ad|creative)\s*[:#-]?\s*([A-Z]+-\d+)/i) || message.match(/\b([A-Z]+-\d{2,})\b/i);
  const fieldMatch = message.match(/\b(TOPHAT|HEADLINE|SUBHEAD|CTA|CALLOUTS|PRIMARY_TEXT|META_HEADLINE|META_DESCRIPTION)\b/i);
  return {
    adId: adMatch ? adMatch[1].toUpperCase() : "",
    field: fieldMatch ? fieldMatch[1].toUpperCase() : "",
    clientMeta
  };
}

function collectTextNodes(root) {
  const result = [];
  walk(root, [], (node, ancestors) => {
    if (node.type !== "TEXT") return;
    const shared = sharedHermes(node);
    const field = normalizeField(shared.field || node.name || "");
    if (!knownFields().includes(field)) return;
    result.push({ node, ancestors, adId: shared.adId || "", field });
  });
  return result;
}

function walk(node, ancestors, visit) {
  visit(node, ancestors);
  for (const child of node.children || []) {
    walk(child, ancestors.concat(node), visit);
  }
}

function commentPointCandidates(root, clientMeta) {
  const offset = clientMeta && clientMeta.node_offset;
  if (!offset || typeof offset.x !== "number" || typeof offset.y !== "number") return [];
  const points = [{ x: offset.x, y: offset.y }];
  if (root.absoluteBoundingBox) {
    points.push({
      x: root.absoluteBoundingBox.x + offset.x,
      y: root.absoluteBoundingBox.y + offset.y
    });
  }
  return points;
}

function nearestNode(candidates, points) {
  if (candidates.length === 0) return null;
  if (points.length === 0) return candidates[0];

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const box = candidate.node.absoluteBoundingBox;
    if (!box) continue;
    const area = box.width * box.height;
    for (const point of points) {
      const inside = containsPoint(box, point);
      const score = inside ? -1000000 + area / 1000000 : distanceToBox(box, point) + 1000000;
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
  }
  return best || candidates[0];
}

function containsPoint(box, point) {
  return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
}

function distanceToBox(box, point) {
  const dx = point.x < box.x ? box.x - point.x : point.x > box.x + box.width ? point.x - (box.x + box.width) : 0;
  const dy = point.y < box.y ? box.y - point.y : point.y > box.y + box.height ? point.y - (box.y + box.height) : 0;
  return Math.sqrt(dx * dx + dy * dy);
}

function adIdFromAncestors(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const sharedAdId = sharedHermes(ancestors[index]).adId;
    if (sharedAdId) return sharedAdId;
    const match = String(ancestors[index].name || "").match(/\b(?:HERS|HIMS)-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/i);
    if (match) return match[0].toUpperCase();
  }
  return "";
}

function targetFromSharedPluginData(root, messageTarget) {
  const shared = sharedHermes(root);
  const rootField = normalizeField(shared.field || root.name || "");
  if (shared.adId || knownFields().includes(rootField)) {
    return {
      adId: messageTarget.adId || shared.adId || "",
      field: messageTarget.field || (knownFields().includes(rootField) ? rootField : ""),
      clientMeta: messageTarget.clientMeta || null,
      figmaNodeId: root.id || ""
    };
  }
  return messageTarget;
}

function sharedHermes(node) {
  const data = node && node.sharedPluginData && node.sharedPluginData[hermesNamespace];
  return data && typeof data === "object" ? data : {};
}

function canonicalizeTarget(target) {
  const resolvedAdId = canonicalAdId(target.adId);
  return {
    ...target,
    adId: resolvedAdId || target.adId || ""
  };
}

function canonicalAdId(adId) {
  const raw = String(adId || "").toUpperCase();
  if (!raw) return "";
  const candidates = knownAdIds();
  if (candidates.includes(raw)) return raw;
  const rawConcept = conceptKey(raw);
  const conceptMatch = candidates.find((candidate) => conceptKey(candidate) === rawConcept);
  if (conceptMatch) return conceptMatch;
  const prefixMatch = candidates.find((candidate) => raw.startsWith(`${conceptKey(candidate)}-`) || raw.startsWith(conceptKey(candidate)));
  return prefixMatch || "";
}

let knownAdIdCache = null;
function knownAdIds() {
  if (knownAdIdCache) return knownAdIdCache;
  knownAdIdCache = [];
  const dirs = ["queued", "processing", "completed", "failed"];
  for (const dir of dirs) {
    const fullDir = path.join(root, dir);
    if (!existsSync(fullDir)) continue;
    for (const file of safeReadDir(fullDir)) {
      if (!file.endsWith(".json")) continue;
      const job = safeReadJson(path.join(fullDir, file));
      for (const ad of job && Array.isArray(job.ads) ? job.ads : []) {
        if (ad && ad.id) knownAdIdCache.push(String(ad.id).toUpperCase());
      }
    }
  }
  knownAdIdCache = [...new Set(knownAdIdCache)].sort();
  return knownAdIdCache;
}

function safeReadDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeReadJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function conceptKey(value) {
  return normalize(value)
    .replace(/\s*\+\s*POST COPY\b/g, "")
    .replace(/\s*\((?:4X5|9X16|1X1|16X9|STORIES?)\)\s*$/g, "")
    .replace(/-(?:45|916|11|169)(?=\b|\s|$)/g, "")
    .replace(/\b(?:4X5|9X16|1X1|16X9|STORIES?)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value) {
  return String(value || "").trim().toUpperCase().replace(/[_\s]+/g, " ");
}

function knownFields() {
  return ["TOPHAT", "HEADLINE", "SUBHEAD", "CTA", "CALLOUTS", "PRIMARY_TEXT", "META_HEADLINE", "META_DESCRIPTION", "DISCLAIMERS"];
}

function normalizeField(value) {
  return String(value).trim().toUpperCase().replace(/\s+/g, "_");
}

async function postHermesRevision(payload) {
  const body = JSON.stringify(payload);
  const response = await fetch(hermesRevisionUrl, {
    method: "POST",
    headers: hermesHeaders(hermesRevisionToken, body),
    body
  });
  if (!response.ok) throw new Error(`Hermes revision intake returned ${response.status}: ${await response.text()}`);
}

async function postQueueJob(payload) {
  const response = await fetch(`${queueUrl}/jobs`, {
    method: "POST",
    headers: authHeaders(queueToken),
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`Queue returned ${response.status}: ${await response.text()}`);
}

async function figmaJson(endpoint) {
  const response = await fetch(`https://api.figma.com${endpoint}`, {
    headers: { "X-Figma-Token": figmaToken }
  });
  if (!response.ok) throw new Error(`Figma returned ${response.status}: ${await response.text()}`);
  return response.json();
}

function authHeaders(token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function hermesHeaders(token, body) {
  const headers = authHeaders(token);
  if (token) headers["X-Hub-Signature-256"] = `sha256=${createHmac("sha256", token).update(body).digest("hex")}`;
  return headers;
}

function isAgentStatusComment(message) {
  return /^✅?\s*(Updated|Implemented|Applied)\b/i.test(message.trim());
}

function mentionsAgent(message, required) {
  const normalized = stripHtml(String(message || "")).toLowerCase();
  return normalized.includes(required);
}

function stripHtml(value) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 160);
}
