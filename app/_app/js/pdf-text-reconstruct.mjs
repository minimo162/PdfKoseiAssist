export const TEXT_RECONSTRUCTION_VERSION = "visual-lines-v1";
export const LAYOUT_TEXT_RECONSTRUCTION_VERSION = "layout-v2";

// PDF.js textContentを、製品・監査・実PDF試験で同じ規則の視覚行へ復元する。
// 外部状態を参照しない純粋関数にして、ブラウザ用HTMLへも同じ関数本体を渡せるようにする。
export function reconstructTextContentByVisualLines(content) {
  const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const rawItems = Array.isArray(content?.items) ? content.items : [];
  const items = rawItems.map(item => {
    const str = String(item?.str || "");
    if (!str) return null;
    const transform = Array.isArray(item?.transform) ? item.transform : [];
    return {
      str, x: num(transform[4], 0), y: num(transform[5], 0),
      width: Math.max(0, num(item?.width, 0)),
      height: Math.max(1, num(item?.height, Math.abs(num(transform[3], 10)) || 10)),
      isSpace: !str.trim(),
    };
  }).filter(Boolean);
  if (!items.length) return "";
  const heights = items.map(item => item.height).filter(height => height > 0).sort((a, b) => a - b);
  const medianHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
  const yTolerance = Math.max(2.5, Math.min(8, medianHeight * 0.45));
  const lines = [];
  for (const item of items.sort((a, b) => (b.y - a.y) || (a.x - b.x))) {
    let line = lines.find(candidate => Math.abs(candidate.y - item.y) <= yTolerance);
    if (!line) { line = { y: item.y, items: [] }; lines.push(line); }
    line.items.push(item);
  }
  lines.sort((a, b) => b.y - a.y);
  const out = [];
  for (const line of lines) {
    const parts = line.items.sort((a, b) => a.x - b.x);
    let text = "", prevRight = null, prevHeight = medianHeight, inkRight = null, pendingSpace = false;
    const overprintSlack = 1;
    for (const part of parts) {
      if (part.isSpace) {
        if (text && !/\s$/.test(text)) text += " ";
        prevRight = part.x + Math.max(part.width, 0);
        continue;
      }
      if (inkRight !== null && part.x < inkRight - overprintSlack) {
        if (/\s/.test(part.str)) pendingSpace = true;
        continue;
      }
      inkRight = part.x + Math.max(part.width, 0);
      const gap = prevRight === null ? 0 : part.x - prevRight;
      const threshold = Math.max(2.5, Math.min(14, prevHeight * 0.35));
      if (pendingSpace && text && !/\s$/.test(text) && !/^\s/.test(part.str)) text += " ";
      pendingSpace = false;
      if (text && gap > threshold && !/\s$/.test(text) && !/^\s/.test(part.str)) text += " ";
      text += part.str;
      prevRight = part.x + Math.max(part.width, 0);
      prevHeight = part.height || prevHeight;
    }
    const normalized = text.replace(/[ \t]+/g, " ").trimEnd();
    if (normalized.trim()) out.push(normalized);
  }
  return out.join("\n").trim();
}

/**
 * Layout-aware PDF.js text reconstruction.
 *
 * The legacy function above is intentionally kept byte-compatible.  This API
 * retains source item geometry, separates a landscape spread into panes only
 * when a persistent centre gutter is present, and reads prose columns to
 * completion instead of joining equal-Y text across the page.
 */
export function reconstructTextContentDetailed(content, options = {}) {
  const VERSION = "layout-v2";
  const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const median = values => {
    const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
    return xs.length ? xs[Math.floor(xs.length / 2)] : 0;
  };
  const bboxUnion = boxes => {
    if (!boxes.length) return { x:0, y:0, width:0, height:0, minX:0, maxX:0, minY:0, maxY:0 };
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    for(const box of boxes){
      minX=Math.min(minX,Number(box?.minX)||0);maxX=Math.max(maxX,Number(box?.maxX)||0);
      minY=Math.min(minY,Number(box?.minY)||0);maxY=Math.max(maxY,Number(box?.maxY)||0);
    }
    return { x:minX, y:minY, width:Math.max(0, maxX-minX), height:Math.max(0, maxY-minY), minX, maxX, minY, maxY };
  };
  const overlapRatio = (a, b) => {
    const w = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
    const h = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
    const area = w * h;
    return area / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
  };
  const safeText = value => String(value || "").replace(/[ \t]+/g, " ").trim();
  const allRawItems = Array.isArray(content?.items) ? content.items : [];
  const maxItems = clamp(Number(options.maxItems)||25000,1000,100000);
  const maxCharacters = clamp(Number(options.maxCharacters)||2000000,10000,10000000);
  const rawItems = allRawItems.slice(0,maxItems);
  const warnings = [];
  if(allRawItems.length>maxItems)warnings.push(`degraded-item-cap:${allRawItems.length}:${maxItems}`);
  const items = [];
  let invalidItems = 0;
  const invalidTextItems=[];
  let acceptedCharacters=0;
  for (let sourceIndex = 0; sourceIndex < rawItems.length; sourceIndex++) {
    const item = rawItems[sourceIndex];
    const str = String(item?.str || "");
    if (!str) continue;
    if(acceptedCharacters+str.length>maxCharacters){warnings.push(`degraded-character-cap:${acceptedCharacters}:${maxCharacters}`);break;}
    acceptedCharacters+=str.length;
    const t = Array.isArray(item?.transform) ? item.transform : [];
    const x = num(t[4], NaN), y = num(t[5], NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e7 || Math.abs(y) > 1e7) { invalidItems++;invalidTextItems.push({sourceIndex,str:safeText(str)});continue; }
    const a = num(t[0], 1), b = num(t[1], 0), d = num(t[3], 10);
    const angle = Math.atan2(b, a) * 180 / Math.PI;
    const vertical = Boolean(content?.styles?.[item?.fontName]?.vertical) || Math.abs(Math.sin(angle * Math.PI / 180)) > 0.72;
    const width = Math.max(0.1, num(item?.width, Math.abs(a) * Math.max(1, str.length)));
    const height = Math.max(1, num(item?.height, Math.abs(d) || 10));
    const box = { x, y:y-height*0.20, width, height, minX:x, maxX:x+width, minY:y-height*0.20, maxY:y+height*0.80 };
    items.push({ sourceIndex, str, dir:String(item?.dir || "ltr").toLowerCase(), fontName:String(item?.fontName || ""),
      hasEOL:Boolean(item?.hasEOL), vertical, angle, ...box });
  }
  if (invalidItems) warnings.push(`invalid-items:${invalidItems}`);
  if (!items.length) return { version:VERSION, text:"", promptText:"", blocks:[], lines:[], warnings,
    stats:{ itemCount:0, paneCount:0, columnCount:0, uncertain:warnings.length>0 } };

  // Remove only genuine overprints.  Geometric overlap alone is not enough:
  // neighbouring table cells and diagram labels can legitimately overlap.
  const deduped = [];
  const duplicateBuckets = new Map();
  for (const item of items) {
    const key = `${safeText(item.str).normalize("NFKC")}|${item.fontName}|${item.dir}|${Math.round(item.x*2)}|${Math.round(item.y*2)}|${Math.round(item.width)}|${Math.round(item.height)}`;
    const candidates = duplicateBuckets.get(key) || [];
    if (safeText(item.str) && candidates.some(prior => overlapRatio(prior, item) >= 0.80)) continue;
    candidates.push(item); duplicateBuckets.set(key, candidates); deduped.push(item);
  }
  // Some Japanese PDFs encode a vertical heading as horizontal one-glyph
  // items.  Detect compact same-X glyph runs and keep them out of prose/table
  // rows; otherwise labels such as 売/上/高 are interleaved with numeric rows.
  // `日本` のような横書きラベルもPDF.jsでは「日」「本」の別itemになる。
  // それを各行で縦方向に集めると、地域名の列全体を縦見出しと誤認してしまう。
  // 実際の縦見出し（Mazda参考資料の 売/上/高、連/結/出/荷/台/数）は
  // 各字が独立したvisual line (`hasEOL`) なので、その肯定的証拠を必須にする。
  const glyphCandidates=deduped.filter(item=>!item.vertical&&item.hasEOL&&/^\p{L}$/u.test(safeText(item.str)));
  const glyphRuns=[];
  for(const candidate of glyphCandidates.slice().sort((a,b)=>(a.x-b.x)||(b.y-a.y))){
    let run=glyphRuns.find(group=>Math.abs(group.x-candidate.x)<=Math.max(2,candidate.height*.38));
    if(!run){run={x:candidate.x,items:[]};glyphRuns.push(run);}
    run.items.push(candidate);
  }
  const verticalGlyphIds=new Set();
  for(const run of glyphRuns){
    const ordered=run.items.sort((a,b)=>b.y-a.y);
    let streak=[];
    const flush=()=>{if(streak.length>=3)for(const item of streak)verticalGlyphIds.add(item.sourceIndex);streak=[];};
    for(const item of ordered){
      const prior=streak[streak.length-1];
      const gap=prior?prior.y-item.y:0;
      if(prior&&(gap<Math.max(1,item.height*.25)||gap>Math.max(prior.height,item.height)*2.6))flush();
      streak.push(item);
    }
    flush();
  }
  if(verticalGlyphIds.size)warnings.push(`vertical-glyph-run:${verticalGlyphIds.size}`);
  const horizontal = deduped.filter(item => !item.vertical&&!verticalGlyphIds.has(item.sourceIndex));
  const vertical = deduped.filter(item => item.vertical||verticalGlyphIds.has(item.sourceIndex));
  if (vertical.length) warnings.push(`vertical-text:${vertical.length}`);
  const medianHeight = Math.max(4, median(horizontal.map(item => item.height)) || 10);
  const yTolerance = clamp(medianHeight * 0.45, 2.5, 8);
  const segmentGap = Math.max(18, medianHeight * 1.8);

  const renderParts = parts => {
    let text = "", prevRight = null, prevHeight = medianHeight;
    const spans = [];
    for (const part of parts) {
      const raw = String(part.str || "").replace(/[ \t]+/g," ");
      if (!raw) continue;
      const isSpace = !raw.trim();
      if (isSpace) {
        if (text && !/\s$/.test(text)) text += " ";
        prevRight = part.maxX;
        continue;
      }
      const gap = prevRight === null ? 0 : part.minX - prevRight;
      const threshold = clamp(prevHeight * 0.35, 2.5, 14);
      if (text && gap > threshold && !/\s$/.test(text) && !/^\s/.test(raw)) text += " ";
      const start = text.length;
      text += raw;
      spans.push({ start, end:text.length, itemIndex:part.sourceIndex, bbox:{ x:part.x, y:part.y, width:part.width, height:part.height } });
      prevRight = part.maxX; prevHeight = part.height || prevHeight;
    }
    return { text:text.trimEnd(), spans };
  };

  // Build visual-line atoms, but split a line at wide horizontal gaps.  The
  // split is what prevents L1/R1 from becoming one fabricated sentence.
  const baselineGroups = [];
  for (const item of horizontal.slice().sort((a,b)=>(b.y-a.y)||(a.x-b.x)||(a.sourceIndex-b.sourceIndex))) {
    const last = baselineGroups[baselineGroups.length - 1];
    if (!last || Math.abs(last.y - item.y) > yTolerance) baselineGroups.push({ y:item.y, items:[item] });
    else last.items.push(item);
  }
  const atoms = [];
  let atomSerial = 0;
  for (const group of baselineGroups) {
    const parts = group.items.sort((a,b)=>(a.x-b.x)||(a.sourceIndex-b.sourceIndex));
    let segment = [];
    const flush = () => {
      if (!segment.length) return;
      const rendered = renderParts(segment);
      if (rendered.text.trim()) {
        const ink = segment.filter(part => safeText(part.str));
        const box = bboxUnion(ink.length ? ink : segment);
        atoms.push({ id:`A${++atomSerial}`, text:rendered.text, spans:rendered.spans, items:segment, y:group.y, ...box });
      }
      segment = [];
    };
    let priorInk = null;
    for (const part of parts) {
      if (priorInk !== null && part.minX - priorInk > segmentGap && segment.some(p => safeText(p.str))) flush();
      segment.push(part);
      if (safeText(part.str)) priorInk = Math.max(priorInk ?? part.maxX, part.maxX);
    }
    flush();
  }

  const contentBox = bboxUnion(deduped);
  const pageWidth = Math.max(1, num(options?.page?.width ?? options.pageWidth, contentBox.maxX + Math.max(18, contentBox.minX)));
  const pageHeight = Math.max(1, num(options?.page?.height ?? options.pageHeight, contentBox.maxY + Math.max(18, contentBox.minY)));
  const pageBox = { minX:0, maxX:pageWidth, minY:0, maxY:pageHeight, x:0, y:0, width:pageWidth, height:pageHeight };
  const charWeight = atom => Math.max(1, safeText(atom.text).length);

  const bestVerticalCut = (source, bounds, rangeMin=.30, rangeMax=.70) => {
    if (source.length < 8 || bounds.width < medianHeight * 12) return null;
    const total = source.reduce((n,a)=>n+charWeight(a),0);
    let best = null;
    const step = Math.max(2, bounds.width / 128);
    for (let x=bounds.minX+bounds.width*rangeMin; x<=bounds.minX+bounds.width*rangeMax; x+=step) {
      let left=0,right=0,cross=0,leftCount=0,rightCount=0;
      for (const atom of source) {
        const weight=charWeight(atom);
        if (atom.maxX < x-medianHeight*.35) { left+=weight; leftCount++; }
        else if (atom.minX > x+medianHeight*.35) { right+=weight; rightCount++; }
        else cross+=weight;
      }
      if (leftCount<4 || rightCount<4 || left<total*.07 || right<total*.07) continue;
      const score=cross/total + Math.abs(left-right)/total*.12 + Math.abs(x-(bounds.minX+bounds.width/2))/bounds.width*.08;
      if (!best || score<best.score) best={ x, score, crossRatio:cross/total, leftCount, rightCount, balance:Math.min(left,right)/Math.max(left,right) };
    }
    return best && best.crossRatio <= .22 && best.balance >= .075 ? best : null;
  };
  const tableStructure = source => {
    const lengths=source.map(atom=>safeText(atom.text).length).filter(Boolean);
    const shortRatio=lengths.filter(length=>length<40).length/Math.max(1,lengths.length);
    const averageLength=lengths.reduce((sum,length)=>sum+length,0)/Math.max(1,lengths.length);
    if(lengths.length>=20&&shortRatio>=.60&&averageLength<38)return true;
    const rows=[];
    for(const atom of source.slice().sort((a,b)=>b.y-a.y)){
      const last=rows[rows.length-1];
      if(!last||Math.abs(last.y-atom.y)>yTolerance)rows.push({y:atom.y,atoms:[atom]});
      else last.atoms.push(atom);
    }
    const multi=rows.filter(row=>row.atoms.length>=2);
    if(multi.length<3)return false;
    const anchors=new Map();
    for(const row of multi)for(const atom of row.atoms){const key=Math.round(atom.minX/Math.max(8,medianHeight*1.5));anchors.set(key,(anchors.get(key)||0)+1);}
    return [...anchors.values()].filter(count=>count>=3).length>=2 && multi.length/Math.max(1,rows.length)>=.35;
  };
  const tableHasRepeatedRowLabels = source => {
    const rows=new Map();
    for(const atom of source){
      const key=Math.round(atom.y/Math.max(2,yTolerance));
      if(!rows.has(key))rows.set(key,[]);
      rows.get(key).push(atom);
    }
    let labelledRows=0;
    for(const atoms of rows.values()){
      const numeric=atoms.filter(atom=>/\d/.test(atom.text));
      if(!numeric.length)continue;
      const firstNumericX=Math.min(...numeric.map(atom=>atom.minX));
      const hasLabel=atoms.some(atom=>{
        const compact=safeText(atom.text).replace(/\s+/g,"");
        return atom.maxX<firstNumericX&&compact&&!/\d/.test(compact)
          &&!/^(?:in|unit|units|単位|通期|前期比|増減率|[%％()（）]+)$/i.test(compact)
          &&/[A-Za-z]{2,}|[ぁ-んァ-ヶ一-龠々]{2,}/u.test(compact);
      });
      if(hasLabel)labelledRows++;
    }
    return labelledRows>=3;
  };
  const regionProfile=source=>{
    const joined=source.map(a=>a.text).join(" ");
    const shortRatio=source.filter(atom=>safeText(atom.text).length<42).length/Math.max(1,source.length);
    // Currency words alone are ordinary financial prose.  Treat only explicit
    // chart/diagram vocabulary as a cue; otherwise grammar review would be
    // disabled for normal paragraphs mentioning billions or trillions.
    const chartCues=[/anticipated impact/i,/estimated cost(?: due)?/i,/reduced to/i,/optimization through collaboration/i,/investment.*collaboration/i,/2022\s*[–-]\s*2030\s+total/i,/\bdiagram\b/i,/\bchart\b/i,/\baxis\b/i]
      .filter(pattern=>pattern.test(joined)).length;
    const chartNumericRatio=source.filter(atom=>/[\d%％$￥¥]/.test(atom.text)).length/Math.max(1,source.length);
    const chartXClusters=new Set(source.map(atom=>Math.round(atom.x/Math.max(24,medianHeight*4)))).size;
    const sentenceRatio=source.filter(atom=>/[.!?。！？]\s*$/.test(safeText(atom.text))).length/Math.max(1,source.length);
    if(source.length>=8&&shortRatio>=.35&&chartCues>=2&&chartNumericRatio>=.08&&chartXClusters>=2&&sentenceRatio<.45)return {role:"table-or-figure",table:false,uncertain:true};
    const structured=tableStructure(source);
    if(!structured)return {role:"body",table:false,uncertain:false};
    const numeric=source.filter(atom=>/[\d%％$￥¥]/.test(atom.text)).length/Math.max(1,source.length);
    const diagramCue=/(?:node[_\s-]|strategy|process|flow|step|axis|chart|diagram)/i.test(joined);
    const tableCue=/(?:sales|revenue|income|assets|liabilities|rate|target|result|year|yen|units|台|円|売上|利益|資産|負債|年度|実績|目標)/i.test(joined);
    if(diagramCue)return {role:"table-or-figure",table:true,uncertain:true};
    if((source.length>=12&&numeric>=.16)||tableCue)return {role:"table",table:true,uncertain:false};
    return {role:"table-or-figure",table:true,uncertain:true};
  };

  let paneCut = null;
  if (pageWidth / pageHeight >= 1.16) paneCut = bestVerticalCut(atoms, pageBox, .38, .62);
  const panes=[];
  if(paneCut){
    panes.push({id:"left",bounds:{...pageBox,maxX:paneCut.x,width:paneCut.x},atoms:atoms.filter(a=>a.maxX<paneCut.x-medianHeight*.35)});
    panes.push({id:"right",bounds:{...pageBox,minX:paneCut.x,x:paneCut.x,width:pageWidth-paneCut.x},atoms:atoms.filter(a=>a.minX>paneCut.x+medianHeight*.35)});
    const crossing=atoms.filter(a=>a.minX<=paneCut.x+medianHeight*.35&&a.maxX>=paneCut.x-medianHeight*.35);
    if(crossing.length) warnings.push(`spread-crossing:${crossing.length}`);
    // Crossing text is never silently discarded.  Keep it isolated from both panes.
    if(crossing.length) panes.unshift({id:"full",bounds:pageBox,atoms:crossing,full:true});
  } else panes.push({id:"full",bounds:pageBox,atoms});

  let blockSerial=0,lineSerial=0,columnCount=0;
  const blocks=[];
  const makeBlock=(source,meta={})=>{
    if(!source.length)return null;
    const table=Boolean(meta.table);
    const ordered=source.slice().sort((a,b)=>(b.y-a.y)||(a.x-b.x)||(a.items?.[0]?.sourceIndex-b.items?.[0]?.sourceIndex));
    const lines=[];
    if(table){
      const rows=[];
      for(const atom of ordered){const last=rows[rows.length-1];if(!last||Math.abs(last.y-atom.y)>yTolerance)rows.push({y:atom.y,atoms:[atom]});else last.atoms.push(atom);}
      for(const row of rows){
        const cells=row.atoms.sort((a,b)=>a.x-b.x);
        const text=cells.map(a=>a.text).join(" ").replace(/[ \t]+/g," ").trim();
        if(!text)continue;
        lines.push({id:`L${++lineSerial}`,text,bbox:bboxUnion(cells),sourceItemIds:[...new Set(cells.flatMap(a=>a.items.map(i=>i.sourceIndex)))],cells:cells.map(a=>({text:a.text,bbox:{x:a.x,y:a.y,width:a.width,height:a.height}}))});
      }
    }else{
      for(const atom of ordered)lines.push({id:`L${++lineSerial}`,text:atom.text,bbox:{x:atom.x,y:atom.y,width:atom.width,height:atom.height,minX:atom.minX,maxX:atom.maxX,minY:atom.minY,maxY:atom.maxY},sourceItemIds:[...new Set(atom.items.map(i=>i.sourceIndex))],spans:atom.spans});
    }
    const text=lines.map(line=>line.text).join("\n").trim();
    if(!text)return null;
    const box=bboxUnion(source);
    const role=meta.role|| (table?"table":((lines.length<=2&&text.length<120)?"caption-or-callout":"body"));
    const block={id:`B${++blockSerial}`,pane:meta.pane||"full",column:meta.column??0,role,writingMode:meta.writingMode||"horizontal",confidence:num(meta.confidence,1),bbox:box,text,lines,sourceItemIds:[...new Set(lines.flatMap(line=>line.sourceItemIds))]};
    blocks.push(block);return block;
  };

  const orderPane = pane => {
    if(!pane.atoms.length)return;
    if(pane.full&&panes.length>1){
      columnCount+=1;
      makeBlock(pane.atoms,{pane:pane.id,column:0,role:"order-uncertain",confidence:.25});
      return;
    }
    const topCut=pageHeight*.90,bottomCut=pageHeight*.08;
    const top=pane.atoms.filter(a=>a.y>=topCut), bottom=pane.atoms.filter(a=>a.y<=bottomCut);
    const main=pane.atoms.filter(a=>a.y<topCut&&a.y>bottomCut);
    makeBlock(top,{pane:pane.id,role:"marginal-header",confidence:.8});
    if(!main.length){makeBlock(bottom,{pane:pane.id,role:"marginal-footer",confidence:.8});return;}
    // Portrait financial releases often place two independent tables on the
    // same horizontal band.  A page-wide table classification would fabricate
    // rows across them.  Detect a compact run of multi-cell numeric baselines,
    // isolate that band, then emit each side as a separate table block.
    if(pageWidth/pageHeight<1.08){
      const rows=[];
      for(const atom of main.slice().sort((a,b)=>b.y-a.y)){
        const last=rows[rows.length-1];
        if(!last||Math.abs(last.y-atom.y)>yTolerance)rows.push({y:atom.y,atoms:[atom]});else last.atoms.push(atom);
      }
      const dense=rows.filter(row=>row.atoms.length>=2&&row.atoms.some(atom=>/[\d%％△▲+＋-]/.test(atom.text))).sort((a,b)=>b.y-a.y);
      const clusters=[];
      for(const row of dense){const last=clusters[clusters.length-1];if(!last||last[last.length-1].y-row.y>medianHeight*4.2)clusters.push([row]);else last.push(row);}
      const cluster=clusters.sort((a,b)=>b.length-a.length)[0];
      if(cluster?.length>=3){
        const upperY=cluster[0].y+medianHeight*1.5,lowerY=cluster[cluster.length-1].y-medianHeight*1.5;
        const band=main.filter(atom=>atom.y<=upperY&&atom.y>=lowerY);
        let bandCut=bestVerticalCut(band,pane.bounds,.28,.72);
        const encodedVertical=vertical.filter(item=>verticalGlyphIds.has(item.sourceIndex));
        if(encodedVertical.length){
          const x=Math.min(...encodedVertical.map(item=>item.x))-medianHeight*.5;
          if(x>pane.bounds.minX+pane.bounds.width*.25&&x<pane.bounds.maxX-pane.bounds.width*.25)bandCut={x,crossRatio:0};
        }else if(!bandCut&&vertical.length){
          const x=median(vertical.map(item=>item.x));
          if(x>pane.bounds.minX+pane.bounds.width*.25&&x<pane.bounds.maxX-pane.bounds.width*.25)bandCut={x,crossRatio:0};
        }
        if(bandCut){
          const left=band.filter(atom=>atom.maxX<bandCut.x-medianHeight*.2);
          const right=band.filter(atom=>atom.minX>bandCut.x+medianHeight*.2);
          const independentTables=tableStructure(left)&&tableStructure(right)
            &&tableHasRepeatedRowLabels(left)&&tableHasRepeatedRowLabels(right);
          if(left.length>=3&&right.length>=3&&independentTables){
            const used=new Set([...left,...right]);
            const above=main.filter(atom=>!used.has(atom)&&atom.y>upperY);
            const below=main.filter(atom=>!used.has(atom)&&atom.y<=upperY);
            if(above.length){const profile=regionProfile(above);makeBlock(above,{pane:pane.id,column:1,table:profile.table,role:profile.role,confidence:profile.uncertain ? .42 : .9});}
            columnCount+=2;
            makeBlock(left,{pane:pane.id,column:1,table:true,role:"table",confidence:.9});
            makeBlock(right,{pane:pane.id,column:2,table:true,role:"table",confidence:.9});
            if(below.length){const profile=regionProfile(below);makeBlock(below,{pane:pane.id,column:1,table:profile.table,role:profile.role,confidence:profile.uncertain ? .42 : .9});}
            makeBlock(bottom,{pane:pane.id,role:"marginal-footer",confidence:.8});
            return;
          }
        }
      }
    }
    let wholeProfile=regionProfile(main);
    if(wholeProfile.uncertain)warnings.push(`ambiguous-grid:${pane.id}`);
    const candidateCut=bestVerticalCut(main,pane.bounds,.24,.76);
    let cut=candidateCut;
    if(candidateCut){
      const crossingProbe=main.filter(a=>a.minX<=candidateCut.x+medianHeight*.30&&a.maxX>=candidateCut.x-medianHeight*.30);
      const numericRatio=main.filter(atom=>/[\d%％$￥¥]/.test(atom.text)).length/Math.max(1,main.length);
      // A dense region with several cells spanning an apparent cut is a wide
      // table, not two prose columns.  Keep the row association intact.
      if(main.length>=60&&crossingProbe.length>=3&&numericRatio>=.08){
        wholeProfile={role:"table",table:true,uncertain:false};
        cut=null;
      }
    }
    if(candidateCut&&wholeProfile.role==="table"){
      const leftProbe=main.filter(a=>a.maxX<candidateCut.x-medianHeight*.30);
      const rightProbe=main.filter(a=>a.minX>candidateCut.x+medianHeight*.30);
      const proseLike=source=>source.length>=4&&source.reduce((sum,atom)=>sum+safeText(atom.text).length,0)/source.length>=24;
      // Two independent side-by-side tables have a nearly empty gutter and
      // both halves retain table structure.  Multi-column prose can also be
      // misclassified by decorative numeric callouts; split it when both
      // halves contain sentence-like atoms.  A true wide table keeps its rows.
      const independentlyStructured=(candidateCut.crossRatio<=.04&&tableStructure(leftProbe)&&tableStructure(rightProbe)
        &&tableHasRepeatedRowLabels(leftProbe)&&tableHasRepeatedRowLabels(rightProbe))
        ||(candidateCut.crossRatio<=.22&&proseLike(leftProbe)&&proseLike(rightProbe));
      if(!independentlyStructured)cut=null;
    }
    if(!cut){columnCount+=1;makeBlock(main,{pane:pane.id,column:1,table:wholeProfile.table,role:wholeProfile.role,confidence:wholeProfile.uncertain ? .42 : .95});}
    else{
      columnCount+=2;
      const left=main.filter(a=>a.maxX<cut.x-medianHeight*.30);
      const right=main.filter(a=>a.minX>cut.x+medianHeight*.30);
      const spanning=main.filter(a=>!left.includes(a)&&!right.includes(a));
      const spanners=spanning.slice().sort((a,b)=>b.y-a.y);
      let upper=Infinity;
      const emitBand=(lower,upperBound)=>{
        const inBand=a=>a.y<upperBound&&a.y>lower;
        const l=left.filter(inBand),r=right.filter(inBand);
        if(l.length){const profile=regionProfile(l);makeBlock(l,{pane:pane.id,column:1,table:profile.table,role:profile.role,confidence:profile.uncertain ? .42 : 1-cut.crossRatio});}
        if(r.length){const profile=regionProfile(r);makeBlock(r,{pane:pane.id,column:2,table:profile.table,role:profile.role,confidence:profile.uncertain ? .42 : 1-cut.crossRatio});}
      };
      for(const span of spanners){emitBand(span.y,upper);makeBlock([span],{pane:pane.id,column:0,role:span.height>=medianHeight*1.18?"heading":"span-or-unknown",confidence:.72});upper=span.y;}
      emitBand(-Infinity,upper);
    }
    makeBlock(bottom,{pane:pane.id,role:"marginal-footer",confidence:.8});
  };
  for(const pane of panes)orderPane(pane);
  if(vertical.length){
    const ordered=vertical.slice().sort((a,b)=>(b.x-a.x)||(b.y-a.y));
    const box=bboxUnion(ordered);
    const text=ordered.map(item=>safeText(item.str)).filter(Boolean).join("\n");
    if(text){const lines=ordered.filter(item=>safeText(item.str)).map(item=>({id:`L${++lineSerial}`,text:safeText(item.str),bbox:{x:item.x,y:item.y,width:item.width,height:item.height,minX:item.minX,maxX:item.maxX,minY:item.minY,maxY:item.maxY},sourceItemIds:[item.sourceIndex]}));blocks.push({id:`B${++blockSerial}`,pane:"full",column:0,role:"order-uncertain",writingMode:"vertical",confidence:.35,bbox:box,text,lines,sourceItemIds:ordered.map(item=>item.sourceIndex)});}
  }
  if(invalidTextItems.length){
    const text=invalidTextItems.map(item=>item.str).filter(Boolean).join("\n");
    if(text){
      const lines=invalidTextItems.filter(item=>item.str).map(item=>({id:`L${++lineSerial}`,text:item.str,bbox:null,sourceItemIds:[item.sourceIndex],spans:[{start:0,end:item.str.length,itemIndex:item.sourceIndex,bbox:null}]}));
      blocks.push({id:`B${++blockSerial}`,pane:"full",column:0,role:"order-uncertain",writingMode:"unknown",confidence:0,bbox:null,text,lines,sourceItemIds:invalidTextItems.map(item=>item.sourceIndex)});
    }
  }

  // Serialize only after the layout tree is stable, then attach source offsets.
  let text="",offset=0;
  for(const block of blocks){
    if(text){text+="\n\n";offset+=2;}
    block.outStart=offset;
    let local=0;
    for(let i=0;i<block.lines.length;i++){
      const line=block.lines[i];if(i){text+="\n";offset++;local++;}
      line.outStart=offset;line.outEnd=offset+line.text.length;
      if(Array.isArray(line.spans))line.spans=line.spans.map(span=>({...span,outStart:line.outStart+span.start,outEnd:line.outStart+span.end}));
      text+=line.text;offset+=line.text.length;local+=line.text.length;
    }
    block.outEnd=offset;
  }
  const uncertain=warnings.some(w=>/invalid|vertical|spread-crossing|degraded/.test(w)) || blocks.some(block=>block.confidence<.5||/^(?:span-or-unknown|order-uncertain|table-or-figure)$/.test(block.role));
  return { version:VERSION,text:text.trim(),promptText:text.trim(),blocks,lines:blocks.flatMap(block=>block.lines),warnings,stats:{itemCount:deduped.length,atomCount:atoms.length,paneCount:panes.filter(p=>!p.full||panes.length===1).length,columnCount,uncertain,pageWidth,pageHeight,paneCut:paneCut?.x||null} };
}

export function marginaliaSignatureKeys(layout) {
  const signature = (text,role) => {
    let normalized=String(text||"").normalize("NFKC").toLowerCase().replace(/\s+/g," ").trim();
    // Section 1/2/3 のような意味のある番号付き上端見出しは別物として保持する。
    // page番号の揺れを吸収するのは、短いfooterの先頭/末尾に孤立する数字だけ。
    if(/footer$/.test(role)&&normalized.length<=160){
      normalized=normalized.replace(/^(?:p(?:age)?\.?\s*)?\d{1,4}\b/i,"#").replace(/\b\d{1,4}$/,"#");
    }
    return normalized;
  };
  const keys=new Set();
  for(const block of layout?.blocks||[]){
    if(!/^(?:marginal|running)-(?:header|footer)$/.test(String(block?.role||"")))continue;
    const raw=String(block?.text||"");
    // 欄外判定のために巨大文字列をMap keyへ保持しない。切り詰めると異なる
    // header同士を同一視して消すため、上限超過は反復判定対象から外す。
    if(raw.length>2048)continue;
    const role=String(block.role).replace(/^running-/,"marginal-");
    const normalized=signature(raw,role);
    if(normalized.length>2048)continue;
    const key=`${block.pane}|${role}|${normalized}`;
    if(!key.endsWith("|"))keys.add(key);
  }
  return keys;
}

export function marginaliaScanPageNumbers(totalPages, limit = 512) {
  const total=Math.max(0,Math.floor(Number(totalPages)||0));
  const cap=Math.max(32,Math.min(2048,Math.floor(Number(limit)||512)));
  if(total<=cap)return Array.from({length:total},(_,index)=>index+1);
  const pages=new Set([1,total]);
  for(let index=0;index<cap;index++)pages.add(1+Math.round(index*(total-1)/(cap-1)));
  return [...pages].sort((a,b)=>a-b).slice(0,cap);
}

export function collectRepeatedMarginaliaSignatures(pageLayouts, options = {}) {
  const layouts=Array.isArray(pageLayouts)?pageLayouts:[];
  const minimumPages=Math.max(3,Number(options.minimumPages)||3);
  const counts = new Map();
  for(const layout of layouts){
    for(const key of marginaliaSignatureKeys(layout))counts.set(key,(counts.get(key)||0)+1);
  }
  return new Set([...counts].filter(([,count])=>count>=minimumPages).map(([key])=>key));
}

export function applyRepeatedMarginaliaSignatures(pageLayouts, repeatedSignatures) {
  const layouts=Array.isArray(pageLayouts)?pageLayouts:[];
  const repeated=repeatedSignatures instanceof Set?repeatedSignatures:new Set(repeatedSignatures||[]);
  for(const layout of layouts){
    for(const block of layout?.blocks||[]){
      if(!/^(?:marginal|running)-(?:header|footer)$/.test(String(block?.role||"")))continue;
      const currentRole=String(block.role).replace(/^running-/,"marginal-");
      block.role=currentRole;
      const key=[...marginaliaSignatureKeys({blocks:[block]})][0];
      if(key&&repeated.has(key))block.role=currentRole.replace("marginal-","running-");
    }
    layout.promptText=(layout.blocks||[]).filter(block=>!/^running-(?:header|footer)$/.test(block.role)).map(block=>block.text).filter(Boolean).join("\n\n").trim();
  }
  return layouts;
}

export function classifyRepeatedMarginalia(pageLayouts, options = {}) {
  return applyRepeatedMarginaliaSignatures(pageLayouts,collectRepeatedMarginaliaSignatures(pageLayouts,options));
}

// Product and audit must project the same canonical layout into the prompt.
// Protect source-controlled lines before app markers are added so a PDF cannot
// forge structure and the genuine markers remain recognisable to the model.
export function serializeLayoutBlocksForPrompt(layout) {
  const reservedSourceLine=/^\s*(?:=====\s+(?:PDF\s+P\.\d+|APP\s+LAYOUT\s+BLOCK)\s+\/|APP_TABLE_CONTEXT\s*:|LAYOUT_STATUS:|TARGET_CHECK(?:_FAST_REVIEW_INDEX)?\s*:|TARGET_CONTEXT\s*:|REF\d*_?CANDIDATE\s*:)/i;
  const protectSourceText=text=>String(text||"").split(/\r?\n/).map(line=>
    reservedSourceLine.test(line)
      ? `［PDF本文］${line}` : line
  ).join("\n");
  // Unit captions are often emitted as a header/caption block while their
  // numeric cells live in a table block.  Reattach a short, app-owned context
  // to each table on the same physical page.  It is metadata only: canonical
  // quote/source-map text remains unchanged.
  const unitPattern=/(?:[（(]\s*単位\s*[:：][^）)]{1,100}[）)]|[（(]\s*(?:in\s+)?(?:hundred\s+)?(?:thousand|million|billion)s?\s+(?:of\s+)?(?:yen|units|vehicles|shares)[^）)]{0,40}[）)]|^\s*(?:単位\s*[:：]\s*)?(?:百万円|億円|千台|千株)\s*$|^\s*(?:in\s+)?(?:hundred\s+)?(?:thousand|million|billion)s?\s+(?:of\s+)?(?:yen|units|vehicles|shares)\s*$)/i;
  const familySet=text=>{
    const value=String(text||""),families=new Set();
    if(/(?:千台|thousand(?:s)?\s+(?:of\s+)?(?:units|vehicles)|(?:販売|生産|出荷|卸売|小売).*台数|(?:sales|production)\s+volume)/i.test(value))families.add("units");
    if(/(?:百万円|億円|(?:hundred\s+)?million(?:s)?\s+(?:of\s+)?yen|billion(?:s)?\s+(?:of\s+)?yen|売上(?!台数)|収益|利益|資産|負債|財務|現金|借入|配当|社債|株主|税金|費用|収入|支出|キャッシュ.?フロー|cash flow|net sales|revenue|income|assets|liabilities)/i.test(value))families.add("money");
    if(/(?:千株|thousand(?:s)?\s+(?:of\s+)?shares|株式数)/i.test(value))families.add("shares");
    return families;
  };
  const unitHints=[],structuralUnitHints=[];
  const sourceBlocks=layout?.blocks||[];
  for(let blockIndex=0;blockIndex<sourceBlocks.length;blockIndex++){
    for(const line of String(sourceBlocks[blockIndex]?.text||"").split(/\r?\n/)){
      const hint=line.replace(/\s+/g," ").trim();
      if(!hint||hint.length>240||reservedSourceLine.test(line)||!unitPattern.test(hint))continue;
      const parts=[...hint.matchAll(/(?:^|\s)([^()（）|]{0,48}?\s*[（(]\s*単位\s*[:：][^）)]{1,100}[）)])/g)].map(match=>match[1].trim());
      for(const part of (parts.length?parts:[hint]))if(part){
        const item={text:part,families:familySet(part),blockIndex};
        if(structuralUnitHints.length<64&&!structuralUnitHints.some(existing=>existing.text===part&&existing.blockIndex===blockIndex))structuralUnitHints.push(item);
        // Keep prompt metadata short.  Structural row counting below uses the
        // separately bounded complete set, so long split tables are not lost.
        if(unitHints.length<6&&!unitHints.some(existing=>existing.text===part&&existing.blockIndex===blockIndex))unitHints.push(item);
      }
    }
  }
  const visible=(layout?.blocks||[]).filter(block=>!/^running-(?:header|footer)$/.test(String(block?.role||"")));
  const needsContext=visible.filter(block=>String(block?.role||"").toLowerCase()==="table"&&!unitPattern.test(String(block?.text||"")));
  const contextByBlock=new Map(),usedHints=new Set(),matchedBlocks=new Set();
  for(const block of needsContext){
    const blockIndex=sourceBlocks.indexOf(block);
    const families=familySet(block.text);
    // Include vertical/uncertain headings from the same physical page only as
    // semantic evidence; never concatenate them into the table text.
    for(const other of visible)if(other!==block&&other.role==="order-uncertain")for(const family of familySet(String(other.text||"").replace(/\s+/g,"")))families.add(family);
    // A caption can only govern a following layout block.  This positional
    // requirement prevents a later caption from being attached to an earlier
    // table that happens to share the same semantic family.
    const candidates=unitHints.filter((hint,index)=>!usedHints.has(index)&&hint.blockIndex<blockIndex&&hint.families.size&&[...hint.families].every(family=>families.has(family)));
    if(candidates.length!==1)continue;
    const hint=candidates[0],index=unitHints.indexOf(hint);
    contextByBlock.set(block,[hint.text]);usedHints.add(index);matchedBlocks.add(block);
  }
  // In a composite header followed by parallel tables, semantic matching may
  // resolve one side and leave exactly one unlabelled side (Mazda P6).  Only
  // that one-to-one residue is safe; never broadcast or pair solely by order.
  const unresolved=needsContext.filter(block=>!matchedBlocks.has(block));
  const remaining=unitHints.map((hint,index)=>({hint,index})).filter(item=>!usedHints.has(item.index));
  if(matchedBlocks.size>0&&unresolved.length===1&&remaining.length===1&&remaining[0].hint.blockIndex<sourceBlocks.indexOf(unresolved[0])){
    const block=unresolved[0],hint=remaining[0].hint,blockFamilies=familySet(block.text);
    const semanticMatch=hint.families.size&&[...hint.families].every(family=>blockFamilies.has(family));
    const geographicRows=(String(block.text||"").match(/(?:^|\n)\s*(?:日\s*本|北\s*米|欧\s*州|中\s*国|その他|合\s*計)(?=\s|[+＋\-△▲]|\d|$)/g)||[]).length;
    const sameCompositeHeader=unitHints.some((other,index)=>usedHints.has(index)&&other.blockIndex===hint.blockIndex);
    const vehicleTableResidue=sameCompositeHeader&&hint.families.size===1&&hint.families.has("units")&&geographicRows>=3;
    if(semanticMatch||vehicleTableResidue)contextByBlock.set(block,[hint.text]);
  }
  // A PDF may put table row labels/units in one block and the corresponding
  // value matrix in the immediately following block (row-span extraction).
  // Accept that split only when at least three same-family labelled rows align
  // with at least three numeric rows.  A lone caption or coincidental value is
  // deliberately insufficient.
  for(const block of needsContext)if(!contextByBlock.has(block)){
    const blockIndex=sourceBlocks.indexOf(block),previousIndex=blockIndex-1;
    const previousHints=structuralUnitHints.filter(hint=>hint.blockIndex===previousIndex&&hint.families.size===1);
    const hintFamilies=new Set(previousHints.flatMap(hint=>[...hint.families]));
    const tableLines=String(block.text||"").split(/\r?\n/);
    const numericBearingRows=tableLines.filter(line=>(line.match(/[-+＋△▲]?\s*\(?\s*\d[\d,.]*\s*[%％]?\s*\)?/g)||[]).length);
    const numericRows=tableLines.filter(line=>{
      if((line.match(/[-+＋△▲]?\s*\(?\s*\d[\d,.]*\s*[%％]?\s*\)?/g)||[]).length<2)return false;
      const residue=line
        .replace(/[-+＋△▲]?\s*\(?\s*\d[\d,.]*\s*[%％]?\s*\)?/g,"")
        .replace(/[\s|｜/／,，.．:：;；\[\]（）()－—–]/g,"");
      return !residue;
    }).length;
    if(previousHints.length>=3&&hintFamilies.size===1&&numericRows>=3&&numericRows===numericBearingRows.length&&Math.abs(previousHints.length-numericRows)<=1){
      contextByBlock.set(block,[previousHints[0].text]);
    }
  }
  return visible
    .map(block=>{
      const hints=contextByBlock.get(block)||[];
      const tableContext=hints.length?`APP_TABLE_CONTEXT: ${hints.map(protectSourceText).join(" | ")}\n`:"";
      return `===== APP LAYOUT BLOCK / ${String(block?.role||"body").toUpperCase()} =====\n${tableContext}${protectSourceText(block?.text)}`;
    })
    .join("\n\n").trim();
}
