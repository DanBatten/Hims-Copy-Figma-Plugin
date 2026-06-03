import { parseCopyDoc } from "./parser";
import type { AdCopy, HermesJob } from "./types";

export function parseJobPayload(text: string): HermesJob {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return normalizeJsonJob(JSON.parse(trimmed));
  const ads = parseCopyDoc(text);
  return {
    jobId: `manual-${Date.now()}`,
    ads
  };
}

export function normalizeJsonJob(value: unknown): HermesJob {
  if (!value || typeof value !== "object") throw new Error("Job payload must be an object.");
  const record = value as Record<string, unknown>;
  const rawAds = Array.isArray(record.ads) ? record.ads : [];
  const campaign = normalizeCampaign(record.campaign);
  const jobId = typeof record.jobId === "string" && record.jobId.trim() ? record.jobId.trim() : `job-${Date.now()}`;
  const inferred = inferJobStructure(jobId, campaign);
  const ads = rawAds.map((ad, index) => normalizeAd(ad, campaign, inferred, index));
  if (ads.length === 0) throw new Error("Job payload must include at least one ad.");

  return {
    jobId,
    targetFileKey: typeof record.targetFileKey === "string" ? record.targetFileKey : undefined,
    campaign,
    ads,
    options: normalizeOptions(record.options)
  };
}

function normalizeCampaign(value: unknown): HermesJob["campaign"] {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    name: stringValue(record.name),
    brands: Array.isArray(record.brands) ? record.brands.map((brand) => String(brand)).filter(Boolean) : undefined,
    category: stringValue(record.category),
    page: stringValue(record.page),
    batch: stringValue(record.batch),
    month: stringValue(record.month),
    projectId: stringValue(record.projectId),
    round: stringValue(record.round)
  };
}

function normalizeOptions(value: unknown): HermesJob["options"] {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return {
    useTemplates: typeof record.useTemplates === "boolean" ? record.useTemplates : undefined,
    includePrimaryText: typeof record.includePrimaryText === "boolean" ? record.includePrimaryText : undefined
  };
}

function normalizeAd(value: unknown, campaign: HermesJob["campaign"], inferred: { month: string; projectId: string; round: string }, index: number): AdCopy {
  if (!value || typeof value !== "object") throw new Error(`Ad ${index + 1} must be an object.`);
  const record = value as Record<string, unknown>;
  const id = requiredString(record.id, `ads[${index}].id`).toUpperCase();
  const brand = requiredString(record.brand, `ads[${index}].brand`);
  const category = stringValue(record.category) || (campaign ? campaign.category : undefined);
  const fields = normalizeFields(record.fields);

  if (campaign && campaign.brands && campaign.brands.length > 0 && !campaign.brands.map(normalize).includes(normalize(brand))) {
    throw new Error(`Brand mismatch for ${id}: "${brand}" is not in campaign brands: ${campaign.brands.join(", ")}.`);
  }

  return {
    id,
    title: stringValue(record.title) || stringValue(record.outputName) || id,
    brand,
    category,
    pageName: stringValue(record.pageName) || (campaign ? campaign.page : undefined) || categoryPageName(category),
    batchName: stringValue(record.batchName) || (campaign ? campaign.batch : undefined) || (campaign ? campaign.name : undefined) || "Imported Ads",
    month: stringValue(record.month) || (campaign ? campaign.month : undefined) || inferred.month,
    projectId: stringValue(record.projectId) || (campaign ? campaign.projectId : undefined) || inferred.projectId,
    round: stringValue(record.round) || (campaign ? campaign.round : undefined) || inferred.round,
    format: normalizeFormat(stringValue(record.format) || ""),
    templateName: stringValue(record.templateName) || stringValue(record.template) || "",
    themeName: themeName(record.theme) || stringValue(record.themeName),
    themeBrief: themeBrief(record.theme) || stringValue(record.themeBrief),
    leadAngle: stringValue(record.leadAngle),
    visualDirection: stringValue(record.visualDirection),
    fields,
    disclaimers: normalizeDisclaimers(record.disclaimers)
  };
}

function themeName(value: unknown) {
  if (typeof value === "string") return stringValue(value);
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return stringValue(record.name) || stringValue(record.title);
}

function themeBrief(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return stringValue(record.brief) || stringValue(record.description) || stringValue(record.rationale);
}

function normalizeDisclaimers(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => {
      if (typeof item === "string") return { text: item };
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const text = stringValue(record.text);
      if (!text) return null;
      return {
        type: stringValue(record.type),
        placement: stringValue(record.placement),
        text
      };
    })
    .filter((item): item is { type?: string; placement?: string; text: string } => Boolean(item));
}

function normalizeFields(value: unknown) {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const fields: Record<string, string> = {};
  Object.keys(record).forEach((key) => {
    const normalizedKey = normalizeFieldKey(key);
    const fieldValue = record[key];
    fields[normalizedKey] = Array.isArray(fieldValue) ? fieldValue.map((item) => String(item)).join("\n") : fieldValue == null ? "" : String(fieldValue);
  });
  return fields;
}

function normalizeFieldKey(value: string) {
  return normalize(value).replace(/\s+/g, "_");
}

function normalizeFormat(value: string): AdCopy["format"] {
  if (value.includes("9x16") || /stor/i.test(value)) return "9x16";
  if (value.includes("4x5")) return "4x5";
  return "unknown";
}

function categoryPageName(category: string | undefined) {
  return category && /^(weight\s*loss|wl)$/i.test(category) ? "Weight Loss" : category || "Weight Loss";
}

function inferJobStructure(jobId: string, campaign: HermesJob["campaign"]) {
  const idMatch = jobId.match(/(\d{5})/);
  const roundMatch = jobId.match(/(?:^|[-_])v?(\d+)(?:$|[-_])/i);
  return {
    month: campaign?.month || new Date().toLocaleString("en-US", { month: "long", year: "numeric" }),
    projectId: campaign?.projectId || (idMatch ? idMatch[1] : jobId),
    round: campaign?.round || (roundMatch ? `R${roundMatch[1]}` : "R1")
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function normalize(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, " ");
}
