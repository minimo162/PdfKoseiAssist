export function createAutoImportStopGate() {
  let stopped = false;
  return Object.freeze({
    enter() {
      if (stopped) return false;
      stopped = true;
      return true;
    },
    resume() { stopped = false; },
    isStopped() { return stopped; },
  });
}

function stringArray(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function lensNames(packet = {}) {
  const fromPasses = (Array.isArray(packet.passes) ? packet.passes : [])
    .map(pass => String(pass?.lens || "").trim())
    .filter(Boolean);
  if (fromPasses.length) return [...new Set(fromPasses)];
  const match = String(packet.packet_id || "").match(/_(BROAD|TERMS|NUMBERS|STRUCTURE|GAP)(?:_R\d+)?$/i);
  return match ? [match[1].toLowerCase()] : [];
}

export function summarizeConsistencyExecution(packet = {}) {
  const targetPages = stringArray(packet.target_pages);
  const checkedPages = stringArray(packet.pages_checked);
  const targetSet = new Set(targetPages);
  const checkedSet = new Set(checkedPages);
  const findings = Math.max(0, Number(packet.findings_count) || 0);
  const excluded = Math.max(0, Number(packet.excluded_count ?? packet.excluded_findings_count) || 0);
  const errors = Math.max(0, Number(packet.error_count) || (packet.error || packet.read_error ? 1 : 0));
  const lenses = lensNames(packet);
  const common = { targetCount: targetPages.length, checkedCount: checkedPages.length, findings, excluded, errors, lenses };
  if (String(packet.status || "").toLowerCase() === "error" || errors) return { ...common, state: "failed" };
  if (!targetPages.length) return { ...common, state: "no-target" };
  if (!checkedPages.length) return { ...common, state: "not-executed" };
  if (targetSet.size !== checkedSet.size || [...targetSet].some(page => !checkedSet.has(page))) return { ...common, state: "incomplete" };
  return { ...common, state: findings ? "completed-with-findings" : "completed-zero" };
}

export function consistencyExecutionLabel(packet = {}, lensLabel = value => value) {
  const summary = summarizeConsistencyExecution(packet);
  const lensText = summary.lenses.length ? `${summary.lenses.map(lensLabel).join("・")}の${summary.lenses.length}観点で` : "";
  if (summary.state === "failed") return `整合性チェック失敗（エラー${summary.errors}件）`;
  if (summary.state === "no-target") return "対象ページ0件のため整合性チェック未実行";
  if (summary.state === "not-executed") return `対象${summary.targetCount}ページを確認できず、整合性チェック未完了`;
  if (summary.state === "incomplete") return `整合性チェック未完了（確認${summary.checkedCount}/${summary.targetCount}ページ）`;
  const suffix = summary.excluded ? `・除外${summary.excluded}件` : "";
  return `正常に${summary.checkedCount}ページを${lensText}確認し、指摘${summary.findings}件${suffix}`;
}

export function yieldToBrowser() {
  return new Promise(resolve => setTimeout(resolve, 0));
}
