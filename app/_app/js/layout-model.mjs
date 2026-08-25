// Canonical, source-bound projection of the existing PDF.js layout-v2 output.
// The model is deliberately data-only: it is safe to persist in a packet
// manifest and it never treats a heuristic as an accepted finding.

export const LAYOUT_MODEL_VERSION = "layout-model-v1";

const ROLE_ALIASES = new Map([
  ["heading", "heading"], ["title", "heading"], ["section-heading", "heading"],
  ["paragraph", "paragraph"], ["prose", "paragraph"], ["body", "paragraph"],
  ["list", "list"], ["list-item", "list-item"],
  ["table", "table"], ["table-or-figure", "table"], ["table-row", "table-row"], ["table-cell", "table-cell"],
  ["footnote", "footnote"], ["footnote-text", "footnote"],
  ["caption", "caption"], ["caption-or-callout", "caption"], ["order-uncertain", "order-uncertain"],
  ["running-header", "running-header"], ["running-footer", "running-footer"],
  ["marginal-header", "marginal-header"], ["marginal-footer", "marginal-footer"],
]);

function textOf(value) {
  return String(value ?? "").replace(/[\t ]+/g, " ").trim();
}

function numberOf(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sourceId(value, fallback) {
  const id = textOf(value);
  return id || fallback;
}

function bboxOf(block = {}) {
  const box = block.bbox || block.box || block;
  const x = numberOf(box?.x ?? box?.minX, 0);
  const y = numberOf(box?.y ?? box?.minY, 0);
  const width = Math.max(0, numberOf(box?.width, (numberOf(box?.maxX, x) - x)) || 0);
  const height = Math.max(0, numberOf(box?.height, (numberOf(box?.maxY, y) - y)) || 0);
  return { x, y, width, height };
}

function linesOf(block, text) {
  if (Array.isArray(block?.lines)) return block.lines.map(textOf).filter(Boolean);
  return text ? text.split(/\r?\n/).map(textOf).filter(Boolean) : [];
}

function roleHint(block = {}) {
  const raw = textOf(block.role || block.type || block.kind).toLowerCase();
  return ROLE_ALIASES.get(raw) || raw;
}

/** Classify only from positive layout evidence; unknown stays unknown. */
export function classifyBlockRole(block = {}) {
  const raw = textOf(block.role || block.type || block.kind).toLowerCase();
  const explicit = roleHint(block);
  const text = textOf(block.text);
  const lines = text.split(/\r?\n/).map(textOf).filter(Boolean);
  const listPattern = /^\s*(?:[-*•]|\d+[.)])\s+/;
  const listLike = lines.length >= 2 && lines.filter(line => listPattern.test(line)).length >= Math.max(2, Math.ceil(lines.length * 0.7));
  // PDF.js commonly emits a whole numbered/list run as one `body` block.
  // Promote that run before honoring the generic prose role.
  if (listLike && ["", "body", "unknown", "span-or-unknown", "caption-or-callout"].includes(raw)) return "list";
  if (["heading", "paragraph", "list", "list-item", "table", "table-row", "table-cell", "footnote", "caption", "order-uncertain", "running-header", "running-footer", "marginal-header", "marginal-footer"].includes(explicit)) {
    return explicit;
  }
  if (listLike) return "list";
  if (lines.length === 1 && listPattern.test(lines[0])) return "list-item";
  if (/^(?:table|表|図表)\b/i.test(text)) return "table";
  if (/^\s*(?:\*+|注|note|footnote|脚注)\s*[:：]/i.test(text)) return "footnote";
  const fontSize = Number(block.fontSize);
  if (text && text.length <= 90 && !/[.!?。！？]$/.test(text) && Number.isFinite(fontSize) && fontSize >= 12) return "heading";
  return text ? "paragraph" : "unknown";
}

function normalizeItems(block, kind) {
  const text = textOf(block.text);
  const rawItems = Array.isArray(block.items)
    ? block.items
    : kind === "list" || kind === "table"
      ? text.split(/\r?\n/).map(line => ({ text: line })).filter(item => textOf(item.text))
      : [];
  return rawItems.map((item, index) => ({
    id: sourceId(item?.id || item?.item_id, `${sourceId(block.id, "B")}-I${index + 1}`),
    text: textOf(item?.text ?? item?.value ?? item),
    index,
    order: numberOf(item?.order, index),
    bbox: bboxOf(item),
    source_item_ids: Array.isArray(item?.source_item_ids) ? item.source_item_ids.map(String) : [],
  })).filter(item => item.text);
}

function structuralSignature(blocks) {
  return blocks.map(block => `${block.role}:${block.text.replace(/\s+/g, " ").slice(0, 64)}`).join("|");
}

export function toBlockModel(block = {}, index = 0, page = null) {
  const text = textOf(block.text ?? block.promptText);
  const role = classifyBlockRole(block);
  const id = sourceId(block.id || block.block_id, `B${Number(page) || 0}-${index + 1}`);
  const model = {
    id,
    role,
    kind: role,
    page: numberOf(block.page, numberOf(page, null)),
    order: numberOf(block.order, index),
    text,
    lines: linesOf(block, text),
    bbox: bboxOf(block),
    pane: textOf(block.pane),
    column: numberOf(block.column, null),
    confidence: numberOf(block.confidence, null),
    source_item_ids: Array.isArray(block.source_item_ids) ? block.source_item_ids.map(String) : [],
    uncertain: Boolean(block.uncertain) || role === "order-uncertain" || (Number.isFinite(Number(block.confidence)) && Number(block.confidence) < 0.5),
  };
  if (role === "list" || role === "table") model.items = normalizeItems(block, role);
  return model;
}

export function toPageModel(layout = {}, options = {}) {
  const page = numberOf(options.page ?? layout.page, null);
  const rawBlocks = Array.isArray(layout.blocks) ? layout.blocks : [];
  const blocks = rawBlocks.map((block, index) => toBlockModel(block, index, page));
  const visibleBlocks = blocks.filter(block => !["running-header", "running-footer"].includes(block.role));
  const lists = visibleBlocks.filter(block => block.role === "list" || block.role === "list-item");
  const tables = visibleBlocks.filter(block => block.role === "table" || block.role === "table-row");
  const footnotes = visibleBlocks.filter(block => block.role === "footnote");
  const prose = visibleBlocks.filter(block => block.role === "paragraph").length;
  return {
    type: "PageModel",
    version: LAYOUT_MODEL_VERSION,
    source_layout_version: textOf(layout.version) || "layout-v2",
    page,
    width: numberOf(options.width ?? layout.width, null),
    height: numberOf(options.height ?? layout.height, null),
    blocks,
    lists,
    tables,
    footnotes,
    prose_ratio: visibleBlocks.length ? prose / visibleBlocks.length : 0,
    uncertain: Boolean(layout.stats?.uncertain) || blocks.some(block => block.uncertain),
    structural_signature: structuralSignature(visibleBlocks),
  };
}

export function toPageModels(layouts = [], options = {}) {
  return (Array.isArray(layouts) ? layouts : []).map((layout, index) => toPageModel(layout, {
    ...options,
    page: options.pageNumbers?.[index] ?? layout?.page ?? index + 1,
  }));
}

export function flattenPageItems(pageModel = {}, roles = ["list", "list-item", "table", "table-row", "table-cell", "caption", "footnote", "paragraph", "heading"]) {
  const allowed = new Set(roles);
  return (pageModel.blocks || []).flatMap(block => {
    if (!allowed.has(block.role)) return [];
    if (Array.isArray(block.items) && block.items.length) return block.items.map(item => ({ ...item, block_id: block.id, page: block.page, role: block.role }));
    return block.text ? [{ id: `${block.id}-TEXT`, text: block.text, block_id: block.id, page: block.page, role: block.role, index: 0 }] : [];
  });
}
