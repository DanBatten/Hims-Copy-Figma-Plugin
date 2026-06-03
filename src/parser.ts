import type { AdCopy } from "./types";

const SINGLE_LINE_FIELDS = ["TOPHAT", "HEADLINE", "SUBHEAD", "CTA", "META_HEADLINE", "META_DESCRIPTION"];
const FIELD_NAMES = SINGLE_LINE_FIELDS.concat(["CALLOUTS", "PRIMARY_TEXT"]);

export function parseCopyDoc(text: string): AdCopy[] {
  const markdownAds = parseStructuredMarkdown(text);
  if (markdownAds.length > 0) return markdownAds;
  return parseLegacyTableDoc(text);
}

function parseStructuredMarkdown(text: string): AdCopy[] {
  const normalizedText = text.replace(/\r/g, "");
  const campaignMetadata = parseCampaignMetadata(normalizedText);
  const campaignBrands = parseCampaignBrands(campaignMetadata);
  const adBlocks = normalizedText
    .split(/^# Ad\s*$/gim)
    .slice(1)
    .map((block) => block.trim())
    .filter(Boolean);

  return adBlocks.map((block) => parseAdBlock(block, campaignMetadata, campaignBrands)).filter((ad): ad is AdCopy => Boolean(ad));
}

function parseAdBlock(block: string, campaignMetadata: Record<string, string>, campaignBrands: string[]): AdCopy | null {
  const lines = block.split("\n").map((line) => line.replace(/\s+$/, ""));
  const firstHeading = lines.find((line) => line.trim().startsWith("# "));
  const metadata = parseStructuredMetadata(lines);
  const fieldsSection = sectionBetween(lines, "Fields");
  const creativeSection = sectionBetween(lines, "Creative Direction");
  const fields = parseStructuredFields(fieldsSection);
  const creativeMetadata = parseStructuredMetadata(creativeSection);

  const id = metadata.ID || metadata.Variant || "";
  if (!id) return null;
  const brand = metadata.Brand || inferBrand(id);
  if (campaignBrands.length > 0 && !campaignBrands.map(normalize).includes(normalize(brand))) {
    throw new Error(`Brand mismatch for ${id}: "${brand}" is not in campaign Brands: ${campaignBrands.join(", ")}.`);
  }

  return {
    id: id.toUpperCase(),
    title: metadata["Output name"] || metadata.Title || firstHeadingLabel(firstHeading) || id.toUpperCase(),
    brand,
    category: metadata.Category || campaignMetadata.Category || inferCategory(campaignMetadata),
    pageName: metadata.Page || campaignMetadata.Page || categoryPageName(metadata.Category || campaignMetadata.Category || inferCategory(campaignMetadata)),
    batchName: metadata["Ad set"] || metadata.Batch || campaignMetadata["Ad set"] || campaignMetadata.Batch || campaignMetadata.Name || "Imported Ads",
    month: metadata.Month || campaignMetadata.Month || currentMonthName(),
    projectId: metadata["Project ID"] || metadata.Project || campaignMetadata["Project ID"] || campaignMetadata.Project || inferProjectId(campaignMetadata.Name || ""),
    round: metadata.Round || campaignMetadata.Round || "R1",
    format: inferFormat(metadata.Format || ""),
    templateName: metadata.Template || "",
    leadAngle: creativeMetadata["Lead angle"],
    visualDirection: creativeMetadata["Visual direction"],
    fields
  };
}

function parseStructuredMetadata(lines: string[]) {
  const metadata: Record<string, string> = {};
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z][A-Za-z0-9 _-]*):\s*(.+)$/);
    if (match) metadata[match[1].trim()] = match[2].trim();
  }
  return metadata;
}

function parseCampaignMetadata(text: string) {
  const beforeFirstAd = text.split(/^# Ad\s*$/im)[0] || "";
  const lines = beforeFirstAd.split("\n");
  const metadata = parseStructuredMetadata(lines);
  if (!metadata.Name) {
    const heading = lines.find((line) => /^#\s+/.test(line.trim()) && normalize(line.trim()) !== "# AD");
    if (heading) metadata.Name = firstHeadingLabel(heading);
  }
  return metadata;
}

function parseCampaignBrands(metadata: Record<string, string>) {
  return metadata.Brands ? metadata.Brands.split(",").map((brand) => normalizeBrand(brand.trim())).filter(Boolean) : [];
}

function sectionBetween(lines: string[], heading: string) {
  const start = lines.findIndex((line) => normalize(line) === normalize("## " + heading));
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line.trim()));
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

function parseStructuredFields(lines: string[]) {
  const fields: Record<string, string> = {};
  let currentKey = "";
  let currentValue: string[] = [];

  function commitField() {
    if (!currentKey) return;
    const key = normalizeStructuredField(currentKey);
    fields[key] = cleanStructuredFieldValue(key, currentValue);
  }

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^([A-Z][A-Z0-9_ ]+):\s*(.*)$/);
    if (match) {
      const key = normalizeStructuredField(match[1]);
      if (!FIELD_NAMES.includes(key)) {
        if (currentKey) currentValue.push(line);
        continue;
      }
      commitField();
      currentKey = match[1];
      currentValue = match[2] ? [match[2]] : [];
    } else if (currentKey) {
      currentValue.push(line);
    }
  }
  commitField();

  return fields;
}

function cleanStructuredFieldValue(key: string, lines: string[]) {
  if (SINGLE_LINE_FIELDS.includes(key)) {
    const valueLines = lines.map((line) => line.trim()).filter(Boolean);
    if (valueLines.length > 1) throw new Error(`${key} must be a single-line field.`);
    return valueLines[0] || "";
  }

  if (key === "CALLOUTS") {
    const invalid = lines.map((line) => line.trim()).filter(Boolean).filter((line) => !/^[-*]\s+/.test(line));
    if (invalid.length > 0) throw new Error("CALLOUTS must be a Markdown list, with one item per line.");
    return lines
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^[-*]\s+/, ""))
      .join("\n")
      .trim();
  }

  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeStructuredField(value: string) {
  return normalize(value).replace(/\s+/g, "_");
}

function firstHeadingLabel(line: string | undefined) {
  return line ? line.replace(/^#+\s*/, "").trim() : "";
}

function inferBrand(id: string) {
  return id.toUpperCase().startsWith("HERS") ? "Hers" : id.toUpperCase().startsWith("HIMS") ? "Hims" : "";
}

function inferCategory(metadata: Record<string, string>) {
  const source = metadata.Category || metadata.Name || metadata.Campaign || "";
  if (/weight\s*loss|wl/i.test(source)) return "Weight Loss";
  if (/testosterone/i.test(source)) return "Testosterone";
  if (/hair/i.test(source)) return "Hair";
  if (/mental\s*health|mh/i.test(source)) return "Mental Health";
  if (/sexual\s*health|sex/i.test(source)) return "Sex";
  return "";
}

function categoryPageName(category: string) {
  if (/^(weight\s*loss|wl)$/i.test(category)) return "Weight Loss";
  return category || "Imported Ads";
}

function normalizeBrand(brand: string) {
  if (/^her'?s$/i.test(brand)) return "Hers";
  if (/^him'?s$/i.test(brand)) return "Hims";
  return brand;
}

function currentMonthName() {
  return new Date().toLocaleString("en-US", { month: "long", year: "numeric" });
}

function inferProjectId(value: string) {
  const match = value.match(/(\d{5})/);
  return match ? match[1] : "Unassigned Project";
}

function parseLegacyTableDoc(text: string): AdCopy[] {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const output: AdCopy[] = [];
  const adStart = /^((?:HERS|HIMS)-\d{2})\s+[—-]\s+"?([^"(]+?)"?\s*(?:\(([^)]+)\))?$/i;

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(adStart);
    if (!match) continue;

    const [, id, title, placement = ""] = match;
    const fields: Record<string, string> = {};
    const nextLine = lines[i + 1];
    const leadLine = nextLine && nextLine.startsWith("Lead angle:") ? nextLine : undefined;
    const tableStart = lines.findIndex((line, index) => index > i && normalize(line) === "ELEMENT" && normalize(lines[index + 1] || "") === "COPY");
    if (tableStart === -1) continue;
    const metadata = parseMetadata(lines.slice(i + 1, tableStart));

    let cursor = tableStart + 2;
    while (cursor < lines.length && !adStart.test(lines[cursor]) && normalize(lines[cursor]) !== "COMPLIANCE NOTES:") {
      const key = normalizeElement(lines[cursor]);
      if (key) {
        cursor += 1;
        const valueLines: string[] = [];
        while (cursor < lines.length && !normalizeElement(lines[cursor]) && !adStart.test(lines[cursor]) && normalize(lines[cursor]) !== "COMPLIANCE NOTES:") {
          valueLines.push(lines[cursor]);
          cursor += 1;
        }
        fields[key] = valueLines.join("\n").trim();
      } else {
        cursor += 1;
      }
    }

    output.push({
      id: id.toUpperCase(),
      title: title.trim(),
      brand: id.toUpperCase().startsWith("HERS") ? "Hers" : "Hims",
      pageName: "Weight Loss",
      batchName: "Legacy Import",
      month: currentMonthName(),
      projectId: inferProjectId(title),
      round: "R1",
      format: inferFormat(metadata.Format || placement),
      templateName: metadata.Template || inferTemplateName(id, title, metadata.Format || placement),
      leadAngle: leadLine ? leadLine.split("Visual direction:")[0].replace("Lead angle:", "").trim() : undefined,
      visualDirection: leadLine && leadLine.split("Visual direction:")[1] ? leadLine.split("Visual direction:")[1].trim() : undefined,
      fields
    });

    i = cursor - 1;
  }

  return output;
}

function parseMetadata(lines: string[]) {
  const metadata: Record<string, string> = {};
  for (const line of lines) {
    const match = line.match(/^(Template|Format|Variant):\s*(.+)$/i);
    if (match) metadata[match[1]] = match[2].trim();
  }
  return metadata;
}

function normalizeElement(value: string) {
  const normalized = normalize(value).replace(/\s*\(POST COPY\)\s*/g, "");
  const allowed = ["TOPHAT", "HEADLINE", "SUBHEAD", "CALLOUTS", "CTA", "PRIMARY TEXT", "META HEADLINE FIELD", "META DESCRIPTION"];
  return allowed.includes(normalized) ? normalized : "";
}

function inferTemplateName(id: string, title: string, placement: string) {
  const format = inferFormat(placement) === "9x16" ? "9x16" : "4x5";
  return `${id.toUpperCase()} ${format} ${title.trim()}`;
}

function inferFormat(value: string): AdCopy["format"] {
  if (value.includes("9x16") || /stor/i.test(value)) return "9x16";
  if (value.includes("4x5")) return "4x5";
  return "unknown";
}

function normalize(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, " ");
}
