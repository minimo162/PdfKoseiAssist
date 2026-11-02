// Measure-MaskSplits.mjs — 記号割れ（同じ表記なのに単位の推定だけが割れた記号の組）をブラウザ無しで数える。
//
//   node tools/Measure-MaskSplits.mjs            … 長尺・正規フィクスチャの件数
//   node tools/Measure-MaskSplits.mjs --show     … 割れた表記と出現（言語・指数・出所）も出す
//
// Audit-DocumentMask.mjs は実物のPDFをヘッドレスEdgeで抽出して「桁差 3/6/9 の割れ組」を出すが、
// ブラウザの無い環境では動かない。ここではフィクスチャのHTML（PDFの元）からページ本文を作り、
// 同じ Masker に日英の順で通して Masker.describeSymbolSplit で数える（2026-11-02 P6 の回帰指標）。
//   inferred … 片側の単位が推定・未付与の割れ（幻の不一致の元。減らす対象）
//   explicit … 両側とも単位が明示・一意継承の割れ（本当に別の量。減らす対象ではない）
// 柱（各ページ1行目）とノンブル（- N -）はアプリでは余白として除くので、ここでも除く。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Masker } from "../js/number-mask.mjs";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "benchmarks", "fixtures");
export const MASK_SPLIT_FIXTURES = {
  long: [["aoi-long_en_TARGET.html", "en"], ["aoi-long_ja_REF.html", "ja"]],
  seiki: [["aoi-seiki_en_TARGET.html", "en"], ["aoi-seiki_ja_REF.html", "ja"]],
};

const decode = s => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (_all, n) => String.fromCharCode(Number(n)));

export function fixturePages(html) {
  return html.split(/<div class="page"/).slice(1).map(chunk => decode(chunk
    .replace(/^[^>]*>/, "")
    .replace(/<\/(?:tr|p|h\d|li|div|caption|thead|tbody|table)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, ""))
    .split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean)
    .slice(1).filter(line => !/^-\s*\d+\s*-$/.test(line))
    .join("\n"));
}

export function measureMaskSplits(files) {
  const masker = new Masker(1);
  for (const [file, lang] of files) {
    fixturePages(readFileSync(join(fixtures, file), "utf8")).forEach((page, index) => {
      masker.mask(`===== PDF P.${index + 1} / ${lang} =====\n${page}`, lang);
    });
  }
  const digitsOf = raw => (String(raw).normalize("NFKC").replace(/[,\s]/g, "").match(/\d+(?:\.\d+)?/) || [""])[0];
  const bySurface = new Map();
  for (const rec of masker.occurrences) {
    if ((rec.namespace || "amount") !== "amount") continue;
    const digits = digitsOf(rec.raw);
    if (!bySurface.has(digits)) bySurface.set(digits, new Set());
    bySurface.get(digits).add(rec.symbol);
  }
  const result = { inferred: 0, explicit: 0, inferredSurfaces: [] };
  for (const [digits, symbols] of bySurface) {
    const list = [...symbols];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const kind = masker.describeSymbolSplit(list[i], list[j])?.kind;
        if (kind === "inferred-scale-split") { result.inferred++; result.inferredSurfaces.push(digits); }
        else if (kind === "explicit-scale-conflict") result.explicit++;
      }
    }
  }
  result.masker = masker;
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const show = process.argv.includes("--show");
  for (const [name, files] of Object.entries(MASK_SPLIT_FIXTURES)) {
    const result = measureMaskSplits(files);
    console.log(`${name}: inferred-scale-split ${result.inferred} / explicit-scale-conflict ${result.explicit}`);
    if (!show) continue;
    for (const digits of [...new Set(result.inferredSurfaces)]) {
      const recs = result.masker.occurrences.filter(rec => (String(rec.raw).replace(/[,\s]/g, "").match(/\d+(?:\.\d+)?/) || [""])[0] === digits);
      console.log(`  ${digits}: ${[...new Set(recs.map(rec => `${rec.symbol} ${rec.lang} ×10^${rec.chosenExp ?? "?"} ${rec.source}${rec.explicitScale ? " explicit" : ""}`))].join(" | ")}`);
    }
  }
}
