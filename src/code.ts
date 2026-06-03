import type { AdCopy, PluginMessage } from "./types";

let loadedFallbackFont: FontName = { family: "Inter", style: "Regular" };
const HERMES_NAMESPACE = "hermes";

figma.showUI(__html__, { width: 220, height: 88, themeColors: true });

figma.ui.onmessage = async (message: PluginMessage) => {
  if (message.type === "patchTextField") {
    try {
      await loadPluginFonts();
      const patchedNodes = await patchTextField(message.job.target.adId, message.job.target.field, message.job.value);
      selectVisibleNodes(patchedNodes);
      const successMessage = `Updated ${message.job.target.field} on ${message.job.target.adId} across ${patchedNodes.length} ratio${patchedNodes.length === 1 ? "" : "s"}.`;
      figma.notify(successMessage);
      figma.ui.postMessage({ type: "generated", jobId: message.job.jobId, message: successMessage });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Could not apply patch.";
      figma.notify(errorMessage, { error: true });
      figma.ui.postMessage({ type: "error", message: errorMessage });
    }
    return;
  }

  if (message.type === "relayoutFallbackAds") {
    try {
      await loadPluginFonts();
      const count = await relayoutAllFallbackAds();
      const successMessage = `Repaired ${count} fallback ad board${count === 1 ? "" : "s"}.`;
      figma.notify(successMessage);
      figma.ui.postMessage({ type: "generated", jobId: message.job.jobId, message: successMessage });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Could not repair fallback boards.";
      figma.notify(errorMessage, { error: true });
      figma.ui.postMessage({ type: "error", message: errorMessage });
    }
    return;
  }

  if (message.type === "retagHermesMetadata") {
    try {
      const count = await retagHermesMetadata();
      const successMessage = `Retagged ${count} Hermes node${count === 1 ? "" : "s"} with shared metadata.`;
      figma.notify(successMessage);
      figma.ui.postMessage({ type: "generated", jobId: message.job.jobId, message: successMessage });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Could not retag Hermes metadata.";
      figma.notify(errorMessage, { error: true });
      figma.ui.postMessage({ type: "error", message: errorMessage });
    }
    return;
  }

  if (message.type !== "generate") return;

  try {
    await loadPluginFonts();

    const batchFrames: FrameNode[] = [];
    const groups = groupAdsByPage(message.ads);
    for (const group of groups) {
      const page = getOrCreatePage(group.pageName, group.ads[0]);
      await figma.setCurrentPageAsync(page);
      const batchFrame = await createBatchFrame(group.pageName, group.ads, message.options);
      batchFrames.push(batchFrame);
    }

    const lastBatch = batchFrames[batchFrames.length - 1];
    if (lastBatch) {
      const parentPage = lastBatch.parent && lastBatch.parent.type === "PAGE" ? lastBatch.parent : figma.currentPage;
      await figma.setCurrentPageAsync(parentPage);
      figma.currentPage.selection = [lastBatch];
      figma.viewport.scrollAndZoomIntoView([lastBatch]);
    }
    const successMessage = `Created ${message.ads.length} ad${message.ads.length === 1 ? "" : "s"} in ${batchFrames.length} batch${batchFrames.length === 1 ? "" : "es"}.`;
    figma.notify(successMessage);
    figma.ui.postMessage({ type: "generated", jobId: message.jobId, message: successMessage });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create ads.";
    figma.notify(message, { error: true });
    figma.ui.postMessage({ type: "error", message });
  }
};

type GenerateOptions = { useTemplates: boolean; includePrimaryText: boolean };

async function createBatchFrame(pageName: string, ads: AdCopy[], options: GenerateOptions): Promise<FrameNode> {
  const batch = figma.createFrame();
  const firstAd = ads[0];
  const boardTheme = brandTheme(firstAd ? firstAd.brand : "", firstAd ? firstAd.category : "");
  batch.name = firstAd && firstAd.round ? firstAd.round : ads[0] && ads[0].batchName ? ads[0].batchName : "R1";
  batch.x = nextBatchX();
  batch.y = 0;
  batch.fills = [{ type: "SOLID", color: boardTheme.briefBackground }];
  batch.clipsContent = false;

  const label = figma.createText();
  label.name = "BATCH_LABEL";
  label.fontName = { family: "Inter", style: "Bold" };
  label.fontSize = 300;
  label.characters = `${batch.name} · ${firstAd && firstAd.batchName ? firstAd.batchName : pageName}`;
  label.fills = [{ type: "SOLID", color: boardTheme.accent }];
  label.textAutoResize = "WIDTH_AND_HEIGHT";
  label.x = 80;
  label.y = 64;
  batch.appendChild(label);

  const sections: FrameNode[] = [];
  const themeGroups = groupAdsByTheme(ads);
  let adIndex = 0;
  for (const themeGroup of themeGroups) {
    const unitFrames: FrameNode[] = [];
    const section = createThemeSection(themeGroup.name, themeGroup.brief, boardTheme);
    batch.appendChild(section);

    for (const ad of themeGroup.ads) {
      const frame = options.useTemplates ? await createFromTemplate(ad) : null;
      const adFrame = frame ? frame : createFallbackAd(ad, adIndex);
      adFrame.name = ad.title || `${ad.id} - ${ad.title}`;
      tagAdFrame(adFrame, ad);
      const unitFrame = createAdUnit(adFrame, ad, options.includePrimaryText);
      section.appendChild(unitFrame);
      unitFrames.push(unitFrame);
      adIndex += 1;
    }

    layoutThemeSection(section, unitFrames);
    sections.push(section);
  }

  layoutBatch(batch, sections);
  return batch;
}

function groupAdsByPage(ads: AdCopy[]) {
  const groups: Array<{ pageName: string; ads: AdCopy[] }> = [];
  for (const ad of ads) {
    const pageName = hierarchyPageName(ad);
    let group = groups.find((candidate) => candidate.pageName === pageName);
    if (!group) {
      group = { pageName, ads: [] };
      groups.push(group);
    }
    group.ads.push(ad);
  }
  return groups;
}

function groupAdsByTheme(ads: AdCopy[]) {
  const groups: Array<{ key: string; name: string; brief: string; ads: AdCopy[] }> = [];
  for (const ad of ads) {
    const name = canonicalThemeName(ad.themeName || "Theme 1");
    const key = normalize(name);
    let group = groups.find((candidate) => candidate.key === key);
    if (!group) {
      group = { key, name, brief: themeBriefForAd(ad), ads: [] };
      groups.push(group);
    }
    if (!group.brief) group.brief = themeBriefForAd(ad);
    group.ads.push(ad);
  }
  return groups.map((group, index) => ({
    ...group,
    name: formattedThemeName(group.name, index)
  }));
}

function canonicalThemeName(value: string) {
  return value
    .replace(/^\s*(?:Hims|Hers)\s*[—:-]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formattedThemeName(value: string, index: number) {
  const match = value.match(/^theme\s*(\d+)\s*[—:-]?\s*(.*)$/i);
  if (match) return `Theme ${match[1]}${match[2] ? `: ${match[2].trim()}` : ""}`;
  return `Theme ${index + 1}: ${value}`;
}

function themeBriefForAd(ad: AdCopy) {
  return [ad.themeBrief, ad.leadAngle ? `Lead angle: ${ad.leadAngle}` : "", ad.visualDirection ? `Visual direction: ${ad.visualDirection}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

function createThemeSection(themeName: string, brief: string, theme: BrandTheme) {
  const section = figma.createFrame();
  section.name = themeName;
  section.fills = [{ type: "SOLID", color: theme.sectionBackground }];
  section.cornerRadius = 28;
  section.clipsContent = false;

  const title = figma.createText();
  title.name = "THEME_LABEL";
  title.fontName = { family: "Inter", style: "Bold" };
  title.fontSize = 200;
  title.characters = themeName;
  title.fills = [{ type: "SOLID", color: theme.darkText }];
  title.textAutoResize = "WIDTH_AND_HEIGHT";
  title.x = 120;
  title.y = 96;
  section.appendChild(title);

  const briefBox = figma.createFrame();
  briefBox.name = "THEME_BRIEF";
  briefBox.fills = [{ type: "SOLID", color: theme.lightBackground }];
  briefBox.strokes = [{ type: "SOLID", color: hex("E0D8CE") }];
  briefBox.strokeWeight = 1;
  briefBox.cornerRadius = 16;
  briefBox.clipsContent = false;
  section.appendChild(briefBox);

  const briefLabel = figma.createText();
  briefLabel.name = "THEME_BRIEF_LABEL";
  briefLabel.fontName = { family: "Inter", style: "Bold" };
  briefLabel.fontSize = 64;
  briefLabel.characters = "Brief";
  briefLabel.fills = [{ type: "SOLID", color: theme.darkText }];
  briefLabel.textAutoResize = "WIDTH_AND_HEIGHT";
  briefLabel.x = 48;
  briefLabel.y = 48;
  briefBox.appendChild(briefLabel);

  const briefText = figma.createText();
  briefText.name = "THEME_BRIEF_TEXT";
  briefText.fontName = { family: "Inter", style: "Regular" };
  briefText.fontSize = 44;
  briefText.lineHeight = { unit: "PERCENT", value: 135 };
  briefText.characters = brief || "No theme brief provided.";
  briefText.fills = [{ type: "SOLID", color: theme.darkText }];
  briefText.textAutoResize = "HEIGHT";
  briefText.x = 48;
  briefText.y = 140;
  briefBox.appendChild(briefText);

  return section;
}

function pageNameFromAd(ad: AdCopy) {
  const category = ad.category || "Weight Loss";
  const pageCategory = /^(weight\s*loss|wl)$/i.test(category) ? "Weight Loss" : category;
  return pageCategory;
}

function hierarchyPageName(ad: AdCopy) {
  const round = normalizeRound(ad.round || "R1");
  if (round === "R1") return projectPageName(ad);
  return `    ↳ ${round}`;
}

function projectPageName(ad: AdCopy) {
  const projectId = ad.projectId || "Unassigned";
  const title = cleanProjectTitle(ad.batchName || ad.title || "");
  return `↳ ${projectId}${title ? `: ${title}` : ""}`;
}

function cleanProjectTitle(value: string) {
  return value
    .replace(/\(.*?\)/g, "")
    .replace(/\bBrief\s*#?\d+\b/gi, "")
    .replace(/\bAd Set\s*\d+\b/gi, "")
    .replace(/\s+[—-]\s+Paid Social.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRound(value: string) {
  const match = value.match(/\d+/);
  return match ? `R${match[0]}` : "R1";
}

function currentMonthName() {
  return new Date().toLocaleString("en-US", { month: "long", year: "numeric" });
}

function getOrCreatePage(pageName: string, ad?: AdCopy) {
  ensureMonthSeparator(pageName, ad);
  const existing = findHierarchyPage(pageName, ad);
  if (existing) {
    tagHierarchyPage(existing, pageName, ad);
    movePageIntoHierarchy(existing, ad);
    return existing;
  }
  const page = figma.createPage();
  page.name = pageName;
  tagHierarchyPage(page, pageName, ad);
  movePageIntoHierarchy(page, ad);
  return page;
}

function ensureMonthSeparator(targetPageName: string, ad?: AdCopy) {
  if (!targetPageName.includes("↳")) return;
  const existing = monthSeparatorPage(ad);
  if (existing) {
    moveMonthSeparator(existing, ad);
    return;
  }
  const page = figma.createPage();
  page.name = monthSeparatorName(ad);
  tagMonthPage(page, ad);
  moveMonthSeparator(page, ad);
}

function movePageIntoHierarchy(page: PageNode, ad?: AdCopy) {
  const separatorIndex = monthSeparatorIndex(ad);
  if (separatorIndex === -1) return;
  const round = normalizeRound(ad && ad.round ? ad.round : "R1");
  const targetIndex = round === "R1" ? firstProjectInsertIndex(separatorIndex, ad) : roundInsertIndex(separatorIndex, ad, round);
  movePageToIndex(page, targetIndex);
}

function moveMonthSeparator(page: PageNode, ad?: AdCopy) {
  const categoryIndex = categoryPageIndex(ad);
  if (categoryIndex === -1) return;
  const nextCategoryIndex = nextCategoryPageIndex(categoryIndex);
  const targetIndex = nextCategoryIndex === -1 ? figma.root.children.length - 1 : nextCategoryIndex;
  movePageToIndex(page, targetIndex);
}

function firstProjectInsertIndex(separatorIndex: number, ad?: AdCopy) {
  const nextBoundaryIndex = nextSectionBoundaryIndex(separatorIndex, ad);
  return nextBoundaryIndex === -1 ? figma.root.children.length - 1 : nextBoundaryIndex;
}

function roundInsertIndex(separatorIndex: number, ad: AdCopy | undefined, round: string) {
  const projectIndex = pageIndex(projectPageNameFromAd(ad));
  if (projectIndex === -1) return firstProjectInsertIndex(separatorIndex, ad);
  const nextBoundaryIndex = nextSectionBoundaryIndex(separatorIndex, ad);
  const limit = nextBoundaryIndex === -1 ? figma.root.children.length : nextBoundaryIndex;
  let insertAfter = projectIndex;
  for (let index = projectIndex + 1; index < limit; index += 1) {
    const name = figma.root.children[index].name;
    if (!isRoundPageName(name)) break;
    insertAfter = index;
  }
  return insertAfter + 1;
}

function projectPageNameFromAd(ad?: AdCopy) {
  if (!ad) return "";
  return projectPageName(ad);
}

function findHierarchyPage(pageName: string, ad?: AdCopy) {
  const key = hierarchyPageKey(ad);
  if (key) {
    const byKey = figma.root.children.find((page) => page.getSharedPluginData(HERMES_NAMESPACE, "pageKey") === key);
    if (byKey) return byKey;
  }
  const normalized = normalize(pageName);
  return figma.root.children.find((page) => normalize(page.name) === normalized);
}

function tagHierarchyPage(page: PageNode, pageName: string, ad?: AdCopy) {
  page.setSharedPluginData(HERMES_NAMESPACE, "pageType", isRoundPageName(pageName) ? "round" : "project");
  page.setSharedPluginData(HERMES_NAMESPACE, "pageKey", hierarchyPageKey(ad) || normalize(pageName));
  page.setSharedPluginData(HERMES_NAMESPACE, "categoryKey", categoryKey(ad));
  page.setSharedPluginData(HERMES_NAMESPACE, "category", categoryPageName(ad));
  page.setSharedPluginData(HERMES_NAMESPACE, "monthKey", monthKey(ad));
  page.setSharedPluginData(HERMES_NAMESPACE, "month", monthLabel(ad));
  page.setSharedPluginData(HERMES_NAMESPACE, "projectId", ad && ad.projectId ? ad.projectId : "");
  page.setSharedPluginData(HERMES_NAMESPACE, "round", normalizeRound(ad && ad.round ? ad.round : "R1"));
}

function tagMonthPage(page: PageNode, ad?: AdCopy) {
  page.setSharedPluginData(HERMES_NAMESPACE, "pageType", "month");
  page.setSharedPluginData(HERMES_NAMESPACE, "pageKey", monthPageKey(ad));
  page.setSharedPluginData(HERMES_NAMESPACE, "categoryKey", categoryKey(ad));
  page.setSharedPluginData(HERMES_NAMESPACE, "monthKey", monthKey(ad));
  page.setSharedPluginData(HERMES_NAMESPACE, "month", monthLabel(ad));
}

function tagCategoryPage(page: PageNode, ad?: AdCopy) {
  page.setSharedPluginData(HERMES_NAMESPACE, "pageType", "category");
  const key = ad ? categoryKey(ad) : normalize(page.name);
  page.setSharedPluginData(HERMES_NAMESPACE, "pageKey", key);
  page.setSharedPluginData(HERMES_NAMESPACE, "categoryKey", key);
  page.setSharedPluginData(HERMES_NAMESPACE, "category", ad ? categoryPageName(ad) : page.name);
}

function hierarchyPageKey(ad?: AdCopy) {
  if (!ad) return "";
  const project = normalize(ad.projectId || "Unassigned");
  const round = normalizeRound(ad.round || "R1");
  return `${categoryKey(ad)}:${monthKey(ad)}:${project}:${round}`;
}

function monthPageKey(ad?: AdCopy) {
  return `${categoryKey(ad)}:${monthKey(ad)}`;
}

function monthSeparatorName(ad?: AdCopy) {
  return `🗓️ ${monthLabel(ad)} ------------------------------`;
}

function monthSeparatorPage(ad?: AdCopy) {
  const byKey = figma.root.children.find((page) => page.getSharedPluginData(HERMES_NAMESPACE, "pageKey") === monthPageKey(ad));
  if (byKey) return byKey;
  const separatorName = monthSeparatorName(ad);
  const categoryIndex = categoryPageIndex(ad);
  if (categoryIndex === -1) return figma.root.children.find((page) => normalize(page.name) === normalize(separatorName));
  const nextCategoryIndex = nextCategoryPageIndex(categoryIndex);
  const limit = nextCategoryIndex === -1 ? figma.root.children.length : nextCategoryIndex;
  for (let index = categoryIndex + 1; index < limit; index += 1) {
    const page = figma.root.children[index];
    if (normalize(page.name) === normalize(separatorName)) return page;
  }
  return undefined;
}

function monthSeparatorIndex(ad?: AdCopy) {
  const page = monthSeparatorPage(ad);
  return page ? figma.root.children.indexOf(page) : -1;
}

function nextSectionBoundaryIndex(separatorIndex: number, ad?: AdCopy) {
  const nextMonthIndex = nextMonthSeparatorIndex(separatorIndex);
  const categoryIndex = categoryPageIndex(ad);
  const nextCategoryIndex = categoryIndex === -1 ? -1 : nextCategoryPageIndex(categoryIndex);
  const candidates = [nextMonthIndex, nextCategoryIndex].filter((index) => index !== -1);
  return candidates.length ? Math.min(...candidates) : -1;
}

function nextMonthSeparatorIndex(separatorIndex: number) {
  for (let index = separatorIndex + 1; index < figma.root.children.length; index += 1) {
    const page = figma.root.children[index];
    if (page.getSharedPluginData(HERMES_NAMESPACE, "pageType") === "month" || page.name.startsWith("🗓️")) return index;
  }
  return -1;
}

function isRoundPageName(name: string) {
  return /^\s*↳\s*R\d+/i.test(name);
}

function pageIndex(name: string) {
  const normalized = normalize(name);
  return figma.root.children.findIndex((candidate) => normalize(candidate.name) === normalized);
}

function categoryPageName(ad?: AdCopy) {
  const category = ad && ad.category ? ad.category : "Weight Loss";
  return /^(weight\s*loss|wl)$/i.test(category) ? "Weight Loss" : category;
}

function categoryPageIndex(ad?: AdCopy) {
  const key = categoryKey(ad);
  let index = figma.root.children.findIndex((page) => page.getSharedPluginData(HERMES_NAMESPACE, "pageType") === "category" && page.getSharedPluginData(HERMES_NAMESPACE, "categoryKey") === key);
  if (index !== -1) return index;
  const name = categoryPageName(ad);
  index = pageIndex(name);
  if (index !== -1) {
    tagCategoryPage(figma.root.children[index], ad);
    return index;
  }
  const page = figma.createPage();
  page.name = name;
  tagCategoryPage(page, ad);
  index = figma.root.children.indexOf(page);
  return index;
}

function nextCategoryPageIndex(categoryIndex: number) {
  for (let index = categoryIndex + 1; index < figma.root.children.length; index += 1) {
    const page = figma.root.children[index];
    if (page.getSharedPluginData(HERMES_NAMESPACE, "pageType") === "category" || isCategoryPageName(page.name)) return index;
  }
  return -1;
}

function isCategoryPageName(pageName: string) {
  const categories = [
    "Testosterone",
    "Weight Loss",
    "WL",
    "Sex",
    "Sexual Health",
    "Hair",
    "Hair Loss",
    "Menopause",
    "Skin",
    "Mental Health",
    "Labs"
  ];
  return categories.some((category) => normalize(category) === normalize(pageName));
}

function movePageToIndex(page: PageNode, targetIndex: number) {
  const currentIndex = figma.root.children.indexOf(page);
  const boundedIndex = Math.max(0, Math.min(targetIndex, figma.root.children.length - 1));
  if (currentIndex !== boundedIndex) figma.root.insertChild(boundedIndex, page);
}

function monthLabel(ad?: AdCopy) {
  const raw = (ad && ad.month ? ad.month : currentMonthName()).split(" ")[0];
  return raw.toUpperCase();
}

function monthKey(ad?: AdCopy) {
  return normalize(monthLabel(ad));
}

function categoryKey(ad?: AdCopy) {
  return normalize(categoryPageName(ad));
}

function categoryAlias(category: string) {
  return /^(weight\s*loss|wl)$/i.test(category) ? "Weight Loss" : category || "Weight Loss";
}

function nextBatchX() {
  const frames = figma.currentPage.children.filter((node) => node.type === "FRAME") as FrameNode[];
  if (frames.length === 0) return 0;
  return Math.max(...frames.map((frame) => frame.absoluteTransform[0][2] + frame.width)) + 600;
}

function layoutBatch(batch: FrameNode, sections: FrameNode[]) {
  const padding = 160;
  const labelHeight = 500;
  const gap = 160;
  let y = padding + labelHeight;
  let width = 1800;

  sections.forEach((section) => {
    section.x = padding;
    section.y = y;
    y += section.height + gap;
    width = Math.max(width, section.width);
  });

  batch.resize(padding * 2 + width, Math.max(padding * 2 + labelHeight, y + padding - gap));
}

function layoutThemeSection(section: FrameNode, frames: FrameNode[]) {
  const padding = 120;
  const headerHeight = 360;
  const gap = 64;
  const briefWidth = 1280;
  const briefGap = 96;
  const columns = frames.length <= 2 ? frames.length || 1 : Math.min(4, frames.length);
  const maxWidth = Math.max(...frames.map((frame) => frame.width), 1080);
  const maxHeight = Math.max(...frames.map((frame) => frame.height), 1350);

  frames.forEach((frame, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    frame.x = padding + column * (maxWidth + gap);
    frame.y = padding + headerHeight + row * (maxHeight + gap);
  });

  const rows = Math.ceil(frames.length / columns) || 1;
  const gridWidth = columns * maxWidth + (columns - 1) * gap;
  const gridHeight = rows * maxHeight + (rows - 1) * gap;
  const sectionWidth = padding * 2 + gridWidth + briefGap + briefWidth;
  const sectionHeight = padding * 2 + headerHeight + gridHeight;

  const briefBox = section.findOne((node) => node.name === "THEME_BRIEF" && node.type === "FRAME") as FrameNode | null;
  if (briefBox) {
    briefBox.x = padding + gridWidth + briefGap;
    briefBox.y = padding + headerHeight;
    briefBox.resize(briefWidth, Math.min(Math.max(900, gridHeight), 1800));
    const briefText = briefBox.findOne((node) => node.name === "THEME_BRIEF_TEXT" && node.type === "TEXT") as TextNode | null;
    if (briefText) briefText.resize(briefWidth - 96, 10);
  }

  section.resize(sectionWidth, sectionHeight);
}

async function createFromTemplate(ad: AdCopy): Promise<FrameNode | null> {
  const template = findTemplate(ad.templateName);
  if (!template) return null;

  const instance = template.type === "COMPONENT_SET" ? template.defaultVariant.createInstance() : "createInstance" in template ? template.createInstance() : template.clone();
  const frame = wrapAsFrame(instance, ad);
  await populateTextLayers(frame, ad);
  return frame;
}

function findTemplate(templateName: string): ComponentNode | ComponentSetNode | FrameNode | null {
  const normalized = normalize(templateName);
  const candidates = figma.currentPage.findAll((node) => {
    return (
      (node.type === "COMPONENT" || node.type === "COMPONENT_SET" || node.type === "FRAME") &&
      normalize(node.name).includes(normalized)
    );
  });
  return (candidates[0] as ComponentNode | ComponentSetNode | FrameNode | undefined) || null;
}

function wrapAsFrame(node: SceneNode, ad: AdCopy): FrameNode {
  if (node.type === "FRAME") {
    node.name = `${ad.id} - ${ad.title}`;
    return node;
  }

  const frame = figma.createFrame();
  frame.name = `${ad.id} - ${ad.title}`;
  frame.resize(node.width, node.height);
  frame.appendChild(node);
  node.x = 0;
  node.y = 0;
  return frame;
}

async function populateTextLayers(root: BaseNode & ChildrenMixin, ad: AdCopy) {
  const textNodes = root.findAll((node) => node.type === "TEXT") as TextNode[];
  for (const node of textNodes) {
    const key = tokenFromName(node.name);
    const value = getField(ad, key);
    if (!value) continue;
    await figma.loadFontAsync(node.fontName === figma.mixed ? { family: "Inter", style: "Regular" } : node.fontName);
    node.characters = value;
    tagTextNode(node, ad, key, value);
  }
}

async function patchTextField(adId: string, field: string, value: string): Promise<TextNode[]> {
  await figma.loadAllPagesAsync();
  const targetAdId = normalize(adId);
  const targetField = normalizeField(field);
  const targetConcept = conceptKey(adId);
  const candidates = figma.root.findAll((node) => {
    if (node.type !== "TEXT") return false;
    const textNode = node as TextNode;
    return textNodeMatchesPatchTarget(textNode, targetAdId, targetConcept, targetField);
  }) as TextNode[];

  if (candidates.length === 0) throw new Error(`Could not find ${field} on ${adId}.`);

  const targetFrames = uniqueAdFrames(candidates);
  annotateAdFrames(targetFrames, "updating", field);

  for (const node of candidates) {
    await figma.loadFontAsync(node.fontName === figma.mixed ? fallbackFont() : node.fontName);
    node.characters = value;
    node.setPluginData("lastPatchedAt", new Date().toISOString());
    node.setPluginData("copy", value);
  }
  relayoutPatchedFallbackAds(candidates);
  annotateAdFrames(targetFrames, "updated", field);
  return candidates;
}

function textNodeMatchesPatchTarget(node: TextNode, targetAdId: string, targetConcept: string, targetField: string) {
  const pluginAdId = normalize(node.getPluginData("adId"));
  const pluginField = normalizeField(node.getPluginData("field"));
  if (pluginField === targetField && (pluginAdId === targetAdId || conceptKey(pluginAdId) === targetConcept)) return true;

  if (normalizeField(node.name) !== targetField) return false;
  let parent = node.parent;
  while (parent) {
    if ("name" in parent) {
      const parentName = normalize(parent.name);
      const parentConcept = conceptKey(parentName);
      if (parentName.includes(targetAdId) || parentConcept === targetConcept || parentConcept.startsWith(`${targetConcept} `)) return true;
    }
    parent = parent.parent;
  }
  return false;
}

function selectVisibleNodes(nodes: SceneNode[]) {
  const selection = nodes.filter((node) => isOnCurrentPage(node));
  if (selection.length > 0) {
    figma.currentPage.selection = selection;
    figma.viewport.scrollAndZoomIntoView(selection);
  }
}

function isOnCurrentPage(node: BaseNode) {
  let parent = node.parent;
  while (parent) {
    if (parent === figma.currentPage) return true;
    parent = parent.parent;
  }
  return false;
}

function conceptKey(value: string) {
  return normalize(value)
    .replace(/\s*\+\s*POST COPY\b/g, "")
    .replace(/\s*\((?:4X5|9X16|1X1|16X9|STORIES?)\)\s*$/g, "")
    .replace(/-(?:45|916|11|169)(?=\b|\s|$)/g, "")
    .replace(/\b(?:4X5|9X16|1X1|16X9|STORIES?)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tagAdFrame(frame: FrameNode, ad: AdCopy) {
  frame.setPluginData("hermesNodeType", "ad");
  frame.setPluginData("adId", ad.id);
  frame.setPluginData("brand", ad.brand);
  frame.setPluginData("category", ad.category || "");
  frame.setPluginData("projectId", ad.projectId || "");
  frame.setPluginData("round", ad.round || "");
  if (!frame.getPluginData("layoutMode")) frame.setPluginData("layoutMode", "template");
  setSharedHermesData(frame, ad, "ad");

  const textNodes = frame.findAll((node) => node.type === "TEXT") as TextNode[];
  for (const node of textNodes) {
    const field = tokenFromName(node.name);
    if (!getField(ad, field) && field !== "DISCLAIMERS") continue;
    tagTextNode(node, ad, field, node.characters);
  }
}

function tagTextNode(node: TextNode, ad: AdCopy, field: string, value: string) {
  node.setPluginData("hermesNodeType", "copyField");
  node.setPluginData("adId", ad.id);
  node.setPluginData("field", normalizeField(field));
  node.setPluginData("brand", ad.brand);
  node.setPluginData("category", ad.category || "");
  node.setPluginData("projectId", ad.projectId || "");
  node.setPluginData("round", ad.round || "");
  node.setPluginData("copy", value);
  setSharedHermesData(node, ad, "copyField", normalizeField(field));
}

function setSharedHermesData(node: BaseNode & PluginDataMixin, ad: AdCopy, nodeType: string, field = "") {
  node.setSharedPluginData(HERMES_NAMESPACE, "nodeType", nodeType);
  node.setSharedPluginData(HERMES_NAMESPACE, "adId", ad.id);
  node.setSharedPluginData(HERMES_NAMESPACE, "field", field);
  node.setSharedPluginData(HERMES_NAMESPACE, "brand", ad.brand);
  node.setSharedPluginData(HERMES_NAMESPACE, "category", ad.category || "");
  node.setSharedPluginData(HERMES_NAMESPACE, "categoryKey", categoryKey(ad));
  node.setSharedPluginData(HERMES_NAMESPACE, "monthKey", monthKey(ad));
  node.setSharedPluginData(HERMES_NAMESPACE, "projectId", ad.projectId || "");
  node.setSharedPluginData(HERMES_NAMESPACE, "round", ad.round || "");
  node.setSharedPluginData(HERMES_NAMESPACE, "conceptKey", conceptKey(ad.id));
}

async function retagHermesMetadata() {
  await figma.loadAllPagesAsync();
  let count = 0;

  for (const page of figma.root.children) {
    count += retagPageMetadata(page);
  }

  const hermesNodes = figma.root.findAll((node) => {
    if (!("getPluginData" in node)) return false;
    const nodeType = node.getPluginData("hermesNodeType");
    return nodeType === "ad" || nodeType === "copyField";
  }) as Array<SceneNode & PluginDataMixin>;

  for (const node of hermesNodes) {
    const nodeType = node.getPluginData("hermesNodeType");
    const adId = node.getPluginData("adId");
    if (!adId) continue;
    node.setSharedPluginData(HERMES_NAMESPACE, "nodeType", nodeType);
    node.setSharedPluginData(HERMES_NAMESPACE, "adId", adId);
    node.setSharedPluginData(HERMES_NAMESPACE, "field", node.getPluginData("field") || "");
    node.setSharedPluginData(HERMES_NAMESPACE, "brand", node.getPluginData("brand") || "");
    node.setSharedPluginData(HERMES_NAMESPACE, "category", node.getPluginData("category") || "");
    node.setSharedPluginData(HERMES_NAMESPACE, "categoryKey", normalize(categoryAlias(node.getPluginData("category") || "")));
    node.setSharedPluginData(HERMES_NAMESPACE, "projectId", node.getPluginData("projectId") || "");
    node.setSharedPluginData(HERMES_NAMESPACE, "round", node.getPluginData("round") || "");
    node.setSharedPluginData(HERMES_NAMESPACE, "conceptKey", conceptKey(adId));
    count += 1;
  }

  return count;
}

function retagPageMetadata(page: PageNode) {
  const normalized = normalize(page.name);
  if (isCategoryPageName(page.name)) {
    tagCategoryPage(page);
    return 1;
  }
  if (page.name.startsWith("🗓️")) {
    page.setSharedPluginData(HERMES_NAMESPACE, "pageType", "month");
    page.setSharedPluginData(HERMES_NAMESPACE, "monthKey", normalized.replace(/^🗓️\s*/, "").replace(/\s*-+$/, "").trim());
    return 1;
  }
  if (/^\s*↳\s*R\d+/i.test(page.name)) {
    page.setSharedPluginData(HERMES_NAMESPACE, "pageType", "round");
    page.setSharedPluginData(HERMES_NAMESPACE, "round", normalizeRound(page.name));
    return 1;
  }
  if (/^\s*↳\s*/.test(page.name)) {
    page.setSharedPluginData(HERMES_NAMESPACE, "pageType", "project");
    const projectMatch = page.name.match(/^\s*↳\s*([^:]+)/);
    page.setSharedPluginData(HERMES_NAMESPACE, "projectId", projectMatch ? projectMatch[1].trim() : "");
    return 1;
  }
  return 0;
}

function createAdUnit(adFrame: FrameNode, ad: AdCopy, includePrimaryText: boolean) {
  const primaryText = getField(ad, "PRIMARY_TEXT");
  if (!includePrimaryText || !primaryText) return adFrame;

  const theme = brandTheme(ad.brand, ad.category);
  const unit = figma.createFrame();
  unit.name = `${adFrame.name} + post copy`;
  unit.fills = [];
  unit.clipsContent = false;
  unit.resize(adFrame.width + 600, adFrame.height);

  adFrame.x = 0;
  adFrame.y = 0;
  unit.appendChild(adFrame);

  const note = figma.createFrame();
  note.name = "POST_COPY_SIDE_NOTE";
  note.x = adFrame.width + 40;
  note.y = 0;
  note.resize(520, Math.min(adFrame.height, 900));
  note.fills = [{ type: "SOLID", color: hex("FFFFFF") }];
  note.strokes = [{ type: "SOLID", color: hex("D9D2C8") }];
  note.strokeWeight = 2;
  note.cornerRadius = 16;
  unit.appendChild(note);

  const label = figma.createText();
  label.name = "POST_COPY_LABEL";
  label.x = 28;
  label.y = 28;
  label.resize(464, 10);
  label.fontName = { family: "Inter", style: "Bold" };
  label.fontSize = 24;
  label.lineHeight = { unit: "PERCENT", value: 120 };
  label.fills = [{ type: "SOLID", color: theme.foreground }];
  label.characters = "Primary text";
  label.textAutoResize = "HEIGHT";
  note.appendChild(label);

  const primaryNode = addTextNode(note, "PRIMARY_TEXT", primaryText, 28, label.y + label.height + 24, 464, 22, theme, 130);
  tagTextNode(primaryNode, ad, "PRIMARY_TEXT", primaryText);

  return unit;
}

function createFallbackAd(ad: AdCopy, index: number): FrameNode {
  const isStory = ad.format === "9x16";
  const width = isStory ? 1080 : 1080;
  const height = isStory ? 1920 : 1350;
  const theme = brandTheme(ad.brand, ad.category);
  const frame = figma.createFrame();
  frame.name = `${ad.id} - ${ad.title}`;
  frame.setPluginData("layoutMode", "fallback");
  frame.resize(width, height);
  frame.x = (index % 4) * (width + 120);
  frame.y = Math.floor(index / 4) * (height + 160);
  frame.fills = [{ type: "SOLID", color: theme.background }];

  const margin = isStory ? 84 : 76;
  const contentWidth = width - margin * 2;
  const stack = createContentStack(frame, margin, isStory ? 210 : 150, contentWidth);
  addTextNode(stack, "TOPHAT", getField(ad, "TOPHAT"), 0, 0, contentWidth, 35, theme, 118);
  addTextNode(stack, "HEADLINE", getField(ad, "HEADLINE"), 0, 0, contentWidth, headlineFontSizeForCopy(getField(ad, "HEADLINE") || "", isStory), theme, 94);
  addTextNode(stack, "SUBHEAD", getField(ad, "SUBHEAD"), 0, 0, contentWidth, 58, theme, 110);
  addTextNode(stack, "CALLOUTS", formatCallouts(getField(ad, "CALLOUTS")), 0, 0, contentWidth, 40, theme, 118);
  addCta(stack, getField(ad, "CTA") || "See if you're eligible", 0, 0, theme);

  const disclaimerText = formatDisclaimers(ad);
  if (disclaimerText) {
    addText(frame, "DISCLAIMERS", disclaimerText, margin, height - 96, contentWidth, 17, theme, 125);
  }

  layoutFallbackAd(frame, ad.brand, ad.category);
  return frame;
}

function relayoutPatchedFallbackAds(nodes: TextNode[]) {
  const frames: FrameNode[] = [];
  for (const node of nodes) {
    const frame = parentAdFrame(node);
    if (frame && frame.getPluginData("layoutMode") === "fallback" && !frames.includes(frame)) frames.push(frame);
  }
  for (const frame of frames) {
    layoutFallbackAd(frame, frame.getPluginData("brand"), frame.getPluginData("category"));
  }
}

async function relayoutAllFallbackAds() {
  await figma.loadAllPagesAsync();
  const frames = figma.root.findAll((node) => node.type === "FRAME" && node.getPluginData("layoutMode") === "fallback") as FrameNode[];
  for (const frame of frames) {
    layoutFallbackAd(frame, frame.getPluginData("brand"), frame.getPluginData("category"));
  }
  return frames.length;
}

function parentAdFrame(node: BaseNode) {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "FRAME" && parent.getPluginData("hermesNodeType") === "ad") return parent;
    parent = parent.parent;
  }
  return null;
}

function uniqueAdFrames(nodes: TextNode[]) {
  const frames: FrameNode[] = [];
  for (const node of nodes) {
    const frame = parentAdFrame(node);
    if (frame && !frames.includes(frame)) frames.push(frame);
  }
  return frames;
}

function annotateAdFrames(frames: FrameNode[], status: "updating" | "updated", field: string) {
  const timestamp = status === "updated" ? formatTimestamp(new Date()) : "";
  for (const frame of frames) {
    frame.clipsContent = false;
    const marker = getOrCreateUpdateMarker(frame);
    const isUpdated = status === "updated";
    marker.fills = [{ type: "SOLID", color: hex("FFFFFF") }];
    marker.strokes = [{ type: "SOLID", color: hex(isUpdated ? "22C55E" : "F4C542") }];
    marker.strokeWeight = 2;
    marker.resize(340, 72);
    marker.x = Math.max(24, frame.width - marker.width - 28);
    marker.y = 28;

    const dot = marker.findOne((node) => node.type === "ELLIPSE" && node.name === "UPDATE_STATUS_DOT") as EllipseNode | null;
    if (dot) dot.fills = [{ type: "SOLID", color: hex(isUpdated ? "22C55E" : "F4C542") }];

    const label = marker.findOne((node) => node.type === "TEXT" && node.name === "UPDATE_STATUS_LABEL") as TextNode | null;
    if (label) {
      label.characters = isUpdated ? `Updated ${field}\n${timestamp}` : `Updating ${field}...`;
      label.fills = [{ type: "SOLID", color: hex("1F2933") }];
      label.resize(250, 10);
      label.textAutoResize = "HEIGHT";
    }

    marker.setPluginData("status", status);
    marker.setPluginData("field", field);
    if (timestamp) marker.setPluginData("updatedAt", timestamp);
  }
}

function getOrCreateUpdateMarker(frame: FrameNode) {
  const existing = frame.children.find((node) => node.type === "FRAME" && node.name === "UPDATE_STATUS") as FrameNode | undefined;
  if (existing) return existing;

  const marker = figma.createFrame();
  marker.name = "UPDATE_STATUS";
  marker.cornerRadius = 36;
  marker.clipsContent = false;
  marker.layoutMode = "HORIZONTAL";
  marker.primaryAxisSizingMode = "FIXED";
  marker.counterAxisSizingMode = "FIXED";
  marker.primaryAxisAlignItems = "MIN";
  marker.counterAxisAlignItems = "CENTER";
  marker.itemSpacing = 14;
  marker.paddingLeft = 22;
  marker.paddingRight = 18;
  marker.paddingTop = 0;
  marker.paddingBottom = 0;
  frame.appendChild(marker);

  const dot = figma.createEllipse();
  dot.name = "UPDATE_STATUS_DOT";
  dot.resize(22, 22);
  marker.appendChild(dot);

  const label = figma.createText();
  label.name = "UPDATE_STATUS_LABEL";
  label.fontName = { family: "Inter", style: "Bold" };
  label.fontSize = 18;
  label.lineHeight = { unit: "PERCENT", value: 118 };
  marker.appendChild(label);

  return marker;
}

function formatTimestamp(date: Date) {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function layoutFallbackAd(frame: FrameNode, brand: string, category?: string) {
  const theme = brandTheme(brand, category);
  const isStory = frame.height > 1500;
  const margin = isStory ? 84 : 76;
  const contentWidth = frame.width - margin * 2;
  const topStart = isStory ? 210 : 150;

  const stack = ensureContentStack(frame, margin, topStart, contentWidth);
  const tophat = textChild(frame, "TOPHAT");
  const headline = textChild(frame, "HEADLINE");
  const subhead = textChild(frame, "SUBHEAD");
  const callouts = textChild(frame, "CALLOUTS");
  const ctaButton = frame.findOne((node) => node.type === "FRAME" && node.name === "CTA_BUTTON") as FrameNode | null;
  const disclaimer = textChild(frame, "DISCLAIMERS");

  [tophat, headline, subhead, callouts].forEach((node) => {
    if (node && node.parent !== stack) stack.appendChild(node);
  });
  if (ctaButton && ctaButton.parent !== stack) stack.appendChild(ctaButton);

  const orderedChildren = [tophat, headline, subhead, callouts, ctaButton].filter((node): node is TextNode | FrameNode => Boolean(node));
  orderedChildren.forEach((node, index) => stack.insertChild(index, node));

  if (headline) {
    headline.fontSize = headlineFontSizeForCopy(headline.characters, isStory);
    headline.lineHeight = { unit: "PERCENT", value: 94 };
  }

  [tophat, headline, subhead, callouts].forEach((node) => configureStackText(node, contentWidth));

  if (ctaButton) {
    configureCtaButton(ctaButton, theme);
    const label = ctaButton.findOne((node) => node.type === "TEXT" && node.name === "CTA") as TextNode | null;
    if (label) label.fills = [{ type: "SOLID", color: theme.ctaText }];
  }

  if (disclaimer) {
    configureDisclaimer(disclaimer, margin, contentWidth, frame.height, isStory);
  }
}

function configureDisclaimer(disclaimer: TextNode, margin: number, width: number, frameHeight: number, isStory: boolean) {
  const reservedHeight = isStory ? 128 : 92;
  disclaimer.x = margin;
  disclaimer.y = frameHeight - margin - reservedHeight;
  disclaimer.resize(width, reservedHeight);
  disclaimer.textAutoResize = "NONE";
  disclaimer.textAlignVertical = "BOTTOM";
}

function createContentStack(parent: FrameNode, x: number, y: number, width: number) {
  const stack = figma.createFrame();
  stack.name = "CONTENT_STACK";
  stack.fills = [];
  parent.appendChild(stack);
  configureContentStack(stack, x, y, width);
  return stack;
}

function ensureContentStack(parent: FrameNode, x: number, y: number, width: number) {
  const existing = parent.children.find((node) => node.type === "FRAME" && node.name === "CONTENT_STACK") as FrameNode | undefined;
  if (existing) {
    configureContentStack(existing, x, y, width);
    return existing;
  }
  return createContentStack(parent, x, y, width);
}

function configureContentStack(stack: FrameNode, x: number, y: number, width: number) {
  stack.x = x;
  stack.y = y;
  stack.resize(width, 10);
  stack.layoutMode = "VERTICAL";
  stack.primaryAxisSizingMode = "AUTO";
  stack.counterAxisSizingMode = "FIXED";
  stack.counterAxisAlignItems = "MIN";
  stack.itemSpacing = 42;
  stack.paddingTop = 0;
  stack.paddingBottom = 0;
  stack.paddingLeft = 0;
  stack.paddingRight = 0;
  stack.clipsContent = false;
}

function configureStackText(node: TextNode | null | undefined, width: number) {
  if (!node) return;
  node.x = 0;
  node.resize(width, Math.max(10, node.height));
  node.textAutoResize = "HEIGHT";
}

function configureCtaButton(button: FrameNode, theme: BrandTheme) {
  button.resize(480, 92);
  button.cornerRadius = 46;
  button.fills = [{ type: "SOLID", color: theme.accent }];
  button.layoutMode = "HORIZONTAL";
  button.primaryAxisAlignItems = "CENTER";
  button.counterAxisAlignItems = "CENTER";
  button.primaryAxisSizingMode = "FIXED";
  button.counterAxisSizingMode = "FIXED";
  button.paddingLeft = 0;
  button.paddingRight = 0;
  button.paddingTop = 0;
  button.paddingBottom = 0;
}

function headlineFontSizeForCopy(value: string, isStory = false) {
  if (isStory) return 150;
  const length = value.trim().length;
  if (length > 90) return 92;
  if (length > 78) return 104;
  if (length > 64) return 118;
  if (length > 52) return 132;
  return 150;
}

function textChild(parent: FrameNode, name: string) {
  return parent.findOne((node) => node.type === "TEXT" && node.name === name) as TextNode | null;
}

function addText(parent: FrameNode, name: string, value: string | undefined, x: number, y: number, width: number, fontSize: number, theme: BrandTheme, lineHeight = 112) {
  const text = addTextNode(parent, name, value, x, y, width, fontSize, theme, lineHeight);
  return text.y + text.height;
}

function addTextNode(parent: FrameNode, name: string, value: string | undefined, x: number, y: number, width: number, fontSize: number, theme: BrandTheme, lineHeight = 112) {
  const text = figma.createText();
  text.name = name;
  text.x = x;
  text.y = y;
  text.resize(width, 10);
  text.fontName = theme.font;
  text.fontSize = fontSize;
  text.lineHeight = { unit: "PERCENT", value: lineHeight };
  text.fills = [{ type: "SOLID", color: theme.foreground }];
  text.characters = value || "";
  text.textAutoResize = "HEIGHT";
  parent.appendChild(text);
  return text;
}

function addCta(parent: FrameNode, value: string, x: number, y: number, theme: BrandTheme) {
  const button = figma.createFrame();
  button.name = "CTA_BUTTON";
  button.x = x;
  button.y = y;
  configureCtaButton(button, theme);
  parent.appendChild(button);

  const label = figma.createText();
  label.name = "CTA";
  label.fontName = theme.font;
  label.fontSize = 34;
  label.characters = value;
  label.fills = [{ type: "SOLID", color: theme.ctaText }];
  label.textAutoResize = "WIDTH_AND_HEIGHT";
  button.appendChild(label);
}

type BrandTheme = {
  background: RGB;
  foreground: RGB;
  accent: RGB;
  ctaText: RGB;
  briefBackground: RGB;
  darkText: RGB;
  lightBackground: RGB;
  sectionBackground: RGB;
  font: FontName;
};

async function loadPluginFonts() {
  try {
    await figma.loadFontAsync({ family: "Sofia Pro", style: "Regular" });
    loadedFallbackFont = { family: "Sofia Pro", style: "Regular" };
  } catch {
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    loadedFallbackFont = { family: "Inter", style: "Regular" };
  }
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  await figma.loadFontAsync({ family: "Inter", style: "Bold" });
}

function fallbackFont(): FontName {
  return loadedFallbackFont;
}

function brandTheme(brand: string, category?: string): BrandTheme {
  const isHims = normalize(brand) === "HIMS";
  const palette = isHims ? himsPalette(category) : hersPalette(category);
  const accent = hex(palette.accent);
  const textDark = hex(palette.textDark);
  return {
    background: hex(palette.adBackground),
    foreground: textDark,
    accent,
    ctaText: contrastText(accent),
    briefBackground: hex(palette.briefBackground),
    darkText: textDark,
    lightBackground: hex(palette.adBackground),
    sectionBackground: hex("FFFFFF"),
    font: fallbackFont()
  };
}

function hersPalette(category?: string) {
  const key = normalize(category || "");
  if (key === "HAIR" || key === "HAIR LOSS") {
    return { briefBackground: "162B33", textDark: "3D5B58", accent: "BFFB81", adBackground: "E2ECE7" };
  }
  if (key === "WEIGHT LOSS" || key === "WL") {
    return { briefBackground: "384429", textDark: "384429", accent: "C5ED82", adBackground: "CCDDB7" };
  }
  if (key === "MENOPAUSE") {
    return { briefBackground: "451310", textDark: "451310", accent: "FF7350", adBackground: "FFF7F3" };
  }
  if (key === "LABS") {
    return { briefBackground: "0F5F62", textDark: "0F5F62", accent: "2DA5A2", adBackground: "EBF3ED" };
  }
  if (key === "MENTAL HEALTH") {
    return { briefBackground: "223C47", textDark: "223C47", accent: "FDFFA7", adBackground: "B4CFCF" };
  }
  if (key === "SEX" || key === "SEXUAL HEALTH") {
    return { briefBackground: "332124", textDark: "4C3338", accent: "61474C", adBackground: "F5F0F1" };
  }
  if (key === "SKIN") {
    return { briefBackground: "1E3741", textDark: "1E3741", accent: "1A1A1A", adBackground: "FFFFFF" };
  }
  return { briefBackground: "384429", textDark: "384429", accent: "C5ED82", adBackground: "EEF1EA" };
}

function himsPalette(category?: string) {
  const key = normalize(category || "");
  if (key === "HAIR" || key === "HAIR LOSS") {
    return { briefBackground: "754B3D", textDark: "754B3D", accent: "8A3A34", adBackground: "EFE8DF" };
  }
  if (key === "WEIGHT LOSS" || key === "WL") {
    return { briefBackground: "784B2A", textDark: "784B2A", accent: "FFC671", adBackground: "F0E5D2" };
  }
  if (key === "TESTOSTERONE") {
    return { briefBackground: "0A2633", textDark: "0A2633", accent: "789299", adBackground: "FAF1D1" };
  }
  if (key === "LABS") {
    return { briefBackground: "5E2E26", textDark: "5E2E26", accent: "92D9C1", adBackground: "F5F0E8" };
  }
  if (key === "MENTAL HEALTH") {
    return { briefBackground: "000000", textDark: "000000", accent: "FDFFA7", adBackground: "EFE8DF" };
  }
  if (key === "SEX" || key === "SEXUAL HEALTH") {
    return { briefBackground: "40556C", textDark: "40556C", accent: "FAF8F2", adBackground: "BDCAD7" };
  }
  return { briefBackground: "784B2A", textDark: "784B2A", accent: "FFC671", adBackground: "F0E5D2" };
}

function contrastText(color: RGB) {
  const luminance = 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
  return luminance > 0.58 ? hex("1D1A18") : hex("FFFFFF");
}

function linearize(value: number) {
  return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function tokenFromName(name: string) {
  return normalize(name).replace(/\{\{|\}\}/g, "").replace(/\s+/g, "_");
}

function normalizeField(value: string) {
  return normalize(value).replace(/\s+/g, "_");
}

function normalize(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, " ");
}

function getField(ad: AdCopy, key: string) {
  return ad.fields[key] || ad.fields[key.replace(/_/g, " ")];
}

function formatCallouts(value: string | undefined) {
  if (!value) return "";
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith("•") || line.startsWith("-") || line.startsWith("—") ? line : `• ${line}`))
    .join("\n");
}

function formatDisclaimers(ad: AdCopy) {
  if (ad.disclaimers && ad.disclaimers.length > 0) {
    return ad.disclaimers
      .filter((disclaimer) => {
        const placement = normalize(disclaimer.placement || "");
        return placement === "IN-IMAGE" || placement === "ON-ASSET";
      })
      .map((disclaimer) => disclaimer.text.trim())
      .filter((text) => text && !/^no compounded disclaimer/i.test(text))
      .filter((text, index, all) => all.indexOf(text) === index)
      .join("\n");
  }
  return [getField(ad, "META_HEADLINE"), getField(ad, "META_DESCRIPTION")].filter(Boolean).join("\n");
}

function hex(value: string): RGB {
  const bigint = Number.parseInt(value, 16);
  return {
    r: ((bigint >> 16) & 255) / 255,
    g: ((bigint >> 8) & 255) / 255,
    b: (bigint & 255) / 255
  };
}
