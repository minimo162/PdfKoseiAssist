import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LAYOUT_TEXT_RECONSTRUCTION_VERSION } from "../js/pdf-text-reconstruct.mjs";

const assert = (condition, message, detail = null) => {
  if (condition) return;
  console.error("Test-ComplexLayoutGold: FAIL", message, detail || "");
  process.exit(1);
};
const extractPath = resolve("tmp/pdfs/mazda_integrated_report_2025_en.layout-v2.extract.json");
if (existsSync(extractPath)) {
  const data = JSON.parse(readFileSync(extractPath, "utf8"));
  assert(data.sourceSha256 === "3cfdf4d16522ad1aa636afa3731f49bb1918d98c042ded564d4d18a27869e72e", "unexpected Mazda source PDF");
  assert(data.reconstructionVersion === LAYOUT_TEXT_RECONSTRUCTION_VERSION, "Mazda gold was not extracted with layout-v2");
  const checks = [
    { page:4, anchors:["Times are changing", "We strive to provide mobility", "achieve success on the global stage", "development, financial strategies"], panes:2, columns:4 },
    { page:18, anchors:["MESSAGE FROM THE CHRO", "Q. Could you please explain", "Building upon the momentum", "Mazda Monozukuri Innovation 2.0"], panes:2, columns:4 },
    { page:42, anchors:["MESSAGE FROM THE OFFICER", "demonstrates that our products", "variants by 60%", "Mazda Monozukuri Innovation 2.0"], panes:2, columns:4 },
    { page:55, anchors:["Shibasaki:I am incredibly", "growth, and, when looking", "customer’s perspective through", "I feel that a crucial part"], panes:2, columns:4 },
  ];
  for (const check of checks) {
    const text = String(data.pages[check.page - 1] || "");
    const positions = check.anchors.map(anchor => text.indexOf(anchor));
    assert(positions.every(position => position >= 0), `P${check.page}: anchor missing`, positions);
    assert(positions.every((position, index) => index === 0 || positions[index - 1] < position), `P${check.page}: column order reversed`, positions);
    assert(data.layoutSummaries?.[check.page]?.stats?.paneCount === check.panes, `P${check.page}: pane count changed`);
    assert(data.layoutSummaries?.[check.page]?.stats?.columnCount === check.columns, `P${check.page}: column count changed`);
  }
  const p9=data.layoutSummaries?.[9];
  assert(p9?.stats?.paneCount===2&&p9?.stats?.uncertain===true,"P9: ambiguous spread did not remain split and fail-closed",p9?.stats);
  assert((p9?.blocks||[]).filter(block=>block.pane==="full").every(block=>block.role==="order-uncertain"),"P9: spread-crossing diagram became trusted prose",p9?.blocks);
  const p10=data.layoutSummaries?.[10];
  const p10Table=p10?.blocks?.find(block=>block.role==="table"&&block.pane==="right"&&Number(block.bbox?.width)>450);
  assert(p10Table,"P10: large table was fragmented instead of protected",p10?.blocks?.map(b=>[b.role,b.pane,b.bbox?.width]));
  assert(!p10.blocks.some(block=>block.pane==="right"&&block.role==="body"&&Number(block.bbox?.height)>300),"P10: table body leaked into a prose block");
  const p30=data.layoutSummaries?.[30];
  assert(p30?.stats?.uncertain===true,"P30: vertical/diagram uncertainty was not fail-closed");
  assert(p30?.blocks?.some(block=>block.pane==="left"&&block.role==="table-or-figure"),"P30: diagram text was not isolated from prose");
  assert(!p30.blocks.some(block=>block.pane==="left"&&block.role==="body"&&Number(block.bbox?.height)>300),"P30: diagram labels and prose share a trusted body block");
  assert(p30?.blocks?.some(block=>block.pane==="right"&&block.role==="table-or-figure"&&/Anticipated Impact/.test(block.textSample||"")),"P30: right-hand chart labels remained trusted prose",p30?.blocks);
  for(const page of [18,42])assert(String(data.pages[page-1]||"").length>500,`P${page}: gold page was not actually extracted`);
  for (const page of [4,10,18,30,42,55]) {
    const lines = String(data.pages[page - 1] || "").split(/\r?\n/);
    assert(!lines.some(line => /Times are changing.*achieve success|Shibasaki:I am incredibly.*customer’s perspective/.test(line)), `P${page}: cross-column sentence fabricated`);
  }
  console.log("Test-ComplexLayoutGold: Mazda real-PDF gold PASS");
} else {
  // The official report is deliberately not committed.  Synthetic layout
  // coverage remains mandatory in Test-PdfTextReconstruct; this optional gold
  // is exercised whenever the ignored real-document extract is present.
  console.log("Test-ComplexLayoutGold: PASS (synthetic coverage; optional real-PDF gold not present)");
}
