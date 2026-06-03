import { parseJobPayload } from "./job";
import type { AdCopy, HermesJob, PatchTextFieldJob, RelayoutFallbackAdsJob } from "./types";

const DEFAULT_QUEUE_URL = "http://172.31.46.177:8787";
const DEFAULT_QUEUE_TOKEN = "0ae77f98bf1197ea9a2a65c145279a8f2be309ef6f32d2195d4d8630e46c33b8";
const POLL_INTERVAL_MS = 5000;

const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const queueEl = document.querySelector<HTMLElement>("#queue")!;
const lastJobEl = document.querySelector<HTMLElement>("#last-job")!;

let currentJobId = "";
let workerBusy = false;

queueEl.textContent = DEFAULT_QUEUE_URL;
startWorker();

window.onmessage = (event) => {
  const pluginMessage = event.data.pluginMessage;
  if (pluginMessage && pluginMessage.type === "error") {
    statusEl.textContent = pluginMessage.message;
    if (currentJobId) void reportJob("failed", currentJobId, pluginMessage.message);
    currentJobId = "";
    workerBusy = false;
  }
  if (pluginMessage && pluginMessage.type === "generated") {
    if (pluginMessage.jobId) void reportJob("completed", pluginMessage.jobId, pluginMessage.message);
    currentJobId = "";
    workerBusy = false;
    statusEl.textContent = pluginMessage.message;
  }
};

function sendGenerateMessage(nextAds: AdCopy[], jobId: string, options: { useTemplates: boolean; includePrimaryText: boolean }) {
  parent.postMessage(
    {
      pluginMessage: {
        type: "generate",
        ads: nextAds,
        jobId,
        options
      }
    },
    "*"
  );
}

function startWorker() {
  statusEl.textContent = "Listening for Hermes jobs...";
  window.setInterval(() => void pollQueue(), POLL_INTERVAL_MS);
  void pollQueue();
}

async function pollQueue() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    const response = await fetch(`${DEFAULT_QUEUE_URL}/jobs/next`, {
      headers: authHeaders()
    });
    if (response.status === 204) {
      statusEl.textContent = "Listening. No queued jobs.";
      workerBusy = false;
      return;
    }
    if (!response.ok) throw new Error(await queueErrorMessage(response));

    const payload = await response.json();
    if (isPatchTextFieldJob(payload)) {
      currentJobId = payload.jobId;
      lastJobEl.textContent = payload.jobId;
      statusEl.textContent = `Applying queued patch ${payload.jobId}...`;
      parent.postMessage({ pluginMessage: { type: "patchTextField", job: payload } }, "*");
      return;
    }
    if (isRelayoutFallbackAdsJob(payload)) {
      currentJobId = payload.jobId;
      lastJobEl.textContent = payload.jobId;
      statusEl.textContent = `Repairing fallback boards ${payload.jobId}...`;
      parent.postMessage({ pluginMessage: { type: "relayoutFallbackAds", job: payload } }, "*");
      return;
    }

    const job = parseJobPayload(JSON.stringify(payload));
    currentJobId = job.jobId;
    lastJobEl.textContent = job.jobId;
    statusEl.textContent = `Rendering queued job ${job.jobId}...`;
    sendGenerateMessage(job.ads, job.jobId, jobOptions(job));
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : "Worker poll failed.";
    workerBusy = false;
  }
}

function isPatchTextFieldJob(value: unknown): value is PatchTextFieldJob {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.mode === "patchTextField";
}

function isRelayoutFallbackAdsJob(value: unknown): value is RelayoutFallbackAdsJob {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.mode === "relayoutFallbackAds";
}

async function reportJob(status: "completed" | "failed", jobId: string, message: string) {
  try {
    await fetch(`${DEFAULT_QUEUE_URL}/jobs/${encodeURIComponent(jobId)}/${status}`, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      body: JSON.stringify({ message })
    });
  } catch {
    statusEl.textContent = `Finished job ${jobId}, but could not report status.`;
  }
}

function jobOptions(job: HermesJob) {
  return {
    useTemplates: job.options && typeof job.options.useTemplates === "boolean" ? job.options.useTemplates : false,
    includePrimaryText: job.options && typeof job.options.includePrimaryText === "boolean" ? job.options.includePrimaryText : true
  };
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${DEFAULT_QUEUE_TOKEN}` };
}

async function queueErrorMessage(response: Response) {
  const body = await response.text().catch(() => "");
  if (!body) return `Queue returned ${response.status}.`;

  try {
    const parsed = JSON.parse(body) as { error?: string };
    if (parsed.error) return `Queue returned ${response.status}: ${parsed.error}`;
  } catch {
    // Fall through to the raw body preview.
  }

  return `Queue returned ${response.status}: ${body.slice(0, 120)}`;
}
