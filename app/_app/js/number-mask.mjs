// Compatibility wrapper around the proven masking core.
// Fixes parenthesized scaled amounts without widening the masked span.
import * as base from "./number-mask-base.mjs";
export * from "./number-mask-base.mjs";

const MICRO = 6;
const EN_SCALE_EXP = new Map([["trillion",12],["billion",9],["million",6],["thousand",3],["oku",8],["k",3]]);
const JA_SCALE_EXP = new Map([["兆",12],["億",8],["百万",6],["万",4],["千",3]]);

function toMicro(raw) {
  const s = String(raw).replace(/[,，]/g, "");
  const [integer, fraction = ""] = s.split(".");
  return BigInt(integer + (fraction + "0".repeat(MICRO)).slice(0, MICRO));
}
function shift(value, exp) { return value * 10n ** BigInt(exp); }
function quantumMicro(raw, exp) {
  const s = String(raw).replace(/[,，]/g, "");
  const fraction = (s.split(".")[1] || "").slice(0, MICRO);
  return shift(10n ** BigInt(MICRO - fraction.length), exp);
}
function compactJaScale(value) { return String(value || "").replace(/\s+/g, ""); }

function parenthesizedScaledAmounts(text, lang) {
  const src = String(text || "");
  const out = [];
  const re = lang === "ja"
    // ⚠️ `(1) 千葉工場` / `(2) 万全な体制` / `(1)万一の場合` は見出し番号＋複合語であって金額ではない（#129）。
    //    スケール語の直後が 円/株/台（さらに漢字が続かない。`(1) 千円未満` は注記）か、
    //    語が続かない（空白・句読点・行末）ときだけ量として読む。
    ? /([（(])\s*(\d{1,3}(?:[,，]\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*([）)])\s*(兆|億|百\s*万|万|千)(?:\s*(円|株|台)(?![一-鿿])|(?![ぁ-んァ-ヶ一-鿿A-Za-z0-9０-９]))/gu
    : /([（(])\s*(\d{1,3}(?:[,，]\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*([）)])\s*(trillions?|billions?|millions?|thousands?|oku|k)(?![A-Za-z])\s*(yen|shares?|units?)?/giu;
  for (const match of src.matchAll(re)) {
    const raw = match[2];
    const rawOffset = match[0].indexOf(raw);
    if (rawOffset < 0) continue;
    const start = match.index + rawOffset;
    const end = start + raw.length;
    const scaleKey = lang === "ja"
      ? compactJaScale(match[4])
      : String(match[4]).toLowerCase().replace(/s$/, "");
    const exp = (lang === "ja" ? JA_SCALE_EXP : EN_SCALE_EXP).get(scaleKey);
    if (!Number.isInteger(exp)) continue;
    const unit = String(match[5] || "").toLowerCase();
    const family = lang === "ja"
      ? (unit === "株" ? "shares" : unit === "台" ? "units" : unit === "円" ? "money" : "")
      : (/^shares?$/i.test(unit) ? "shares" : /^units?$/i.test(unit) ? "units" : (unit === "yen" || scaleKey === "oku" || scaleKey === "k") ? "money" : "");
    out.push({
      start, end, raw, exp, family,
      micro: shift(toMicro(raw), exp),
      quantum: quantumMicro(raw, exp),
      sign: "(",
      source: "explicit-parenthesized-scale",
      explicitScale: true,
      chosenExp: exp,
      namespace: "amount",
      layoutRole: "",
    });
  }
  return out;
}

function foldWidth(text) {
  return String(text).replace(/[０-９，．]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

function correctedTokens(text, lang, allow, evidenceAmounts, rowFamilyEvidence, localEvidenceAmounts) {
  const orig = String(text || "");
  const original = lang === "ja"
    ? base.tokenizeJa(orig, allow, evidenceAmounts, rowFamilyEvidence, localEvidenceAmounts)
    : base.tokenizeEn(orig, allow, evidenceAmounts, rowFamilyEvidence, localEvidenceAmounts);
  // `(20) oku` / `(108)億円` は見出し番号の形をしているが、スケール語が直に付くので金額
  // （英文会計の負値）。ベースの構造番号 allow-list を上書きして伏せる。
  // 構造番号＋複合語（"(1)万一の場合" / "(1) 千葉工場"）は parenthesizedScaledAmounts 側の
  // 直後文字の条件で除外され、skipSpans の保護がそのまま残る。
  // Compound Japanese scales (3千万 / 1億2千万 / 5百億) are read by the base tokenizer itself.
  // Detection runs on the width-folded text (same offsets); raw keeps the original characters.
  const fixes = parenthesizedScaledAmounts(foldWidth(orig), lang)
    .map(fix => ({ ...fix, raw: orig.slice(fix.start, fix.end) }));
  if (!fixes.length) return original;
  const overlapsFix = token => fixes.some(fix => token.start < fix.end && fix.start < token.end);
  return original.filter(token => !overlapsFix(token)).concat(fixes).sort((a,b) => a.start - b.start || a.end - b.end);
}

export function tokenizeJa(text, allow = base.DEFAULT_ALLOW, evidenceAmounts = null, rowFamilyEvidence = null, localEvidenceAmounts = null) {
  return correctedTokens(text, "ja", allow, evidenceAmounts, rowFamilyEvidence, localEvidenceAmounts);
}
export function tokenizeEn(text, allow = base.DEFAULT_ALLOW, evidenceAmounts = null, rowFamilyEvidence = null, localEvidenceAmounts = null) {
  return correctedTokens(text, "en", allow, evidenceAmounts, rowFamilyEvidence, localEvidenceAmounts);
}

function mergeEvidenceAmounts(...sources) {
  const merged = new Map();
  for (const source of sources) for (const [family, amounts] of source || []) {
    if (!merged.has(family)) merged.set(family, new Set());
    for (const amount of amounts || []) merged.get(family).add(amount);
  }
  return merged;
}

export class Masker extends base.Masker {
  collectExplicitEvidence(text, lang, allow = base.DEFAULT_ALLOW, includeUnambiguous = true) {
    const collected = super.collectExplicitEvidence(text, lang, allow, includeUnambiguous);
    for (const token of correctedTokens(text, lang, allow).filter(item => item.source === "explicit-parenthesized-scale")) {
      if (!token.family || !["money","units","shares","count"].includes(token.family)) continue;
      if (!collected.has(token.family)) collected.set(token.family, new Set());
      const amount = token.micro < 0n ? -token.micro : token.micro;
      collected.get(token.family).add(amount.toString());
    }
    return collected;
  }

  mask(text, lang, allow = base.DEFAULT_ALLOW) {
    const src = String(text);
    this.indexRowFamilyEvidence(src);
    const pageMarkers = (src.match(/^===== PDF P\.\d+ \//gm) || []).length;
    const localEvidence = pageMarkers === 0 ? this.collectExplicitEvidence(src, lang, allow, true) : null;
    this.indexExplicitEvidence(src, lang, allow);
    const tableEvidence = mergeEvidenceAmounts(this.explicitAmounts, localEvidence);
    const toks = lang === "ja"
      ? tokenizeJa(src, allow, this.explicitAmounts, this.rowFamilyEvidence, tableEvidence)
      : tokenizeEn(src, allow, this.explicitAmounts, this.rowFamilyEvidence, tableEvidence);
    const parts = [];
    const used = [];
    let last = 0;
    for (const t of toks) {
      const sym = this.symbolFor(t.micro, t.quantum, t.namespace || "amount");
      parts.push(src.slice(last, t.start), sym);
      const rec = {
        symbol: sym, raw: t.raw, sign: t.sign, lang, micro: t.micro, quantum: t.quantum,
        chosenExp: t.chosenExp, family: t.family || "", source: t.source || "", layoutRole: t.layoutRole || "",
        namespace: t.namespace || "amount",
      };
      used.push(rec);
      this.occurrences.push(rec);
      const key = `${lang}\u0000${sym}`;
      if (!this.surfaces.has(key)) this.surfaces.set(key, t.raw);
      last = t.end;
    }
    parts.push(src.slice(last));
    return { text: parts.join(""), used };
  }
}
