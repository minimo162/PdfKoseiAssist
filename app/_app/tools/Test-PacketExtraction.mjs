// Test-PacketExtraction.mjs — パケット処理が関数として切り出されたままであることを守る。
//
//   node tools/Test-PacketExtraction.mjs
//
// 並列化（引き継ぎ書 §6.4）はワーカーごとに1パケットを回せることが前提で、
// そのためにループ本体を Invoke-KoseiPacket へ出してある。
// ここが再びループへ埋め戻されると、2ワーカーの実測すら製品と別経路のコードを
// 書くことになり、測ったものが製品とずれる。構造として固定しておく。

import fs from "node:fs";

const job = fs.readFileSync(new URL("../src/ReviewJob.ps1", import.meta.url), "utf8");

let bad = 0;
const t = (name, cond, detail) => {
  if (cond) console.log("  ok   " + name);
  else { bad++; console.error("  FAIL " + name); if (detail !== undefined) console.error("       " + JSON.stringify(detail)); }
};

// --- 1. 関数が存在し、必要な引数を取る ---------------------------------
t("Invoke-KoseiPacket が定義されている", /^function Invoke-KoseiPacket \{/m.test(job));

const fnStart = job.indexOf("function Invoke-KoseiPacket {");
const paramBlock = job.slice(fnStart, fnStart + 1200);
for (const p of ["$Packet", "$State", "$Settings", "$ReviewFlags", "$AnswersDir", "$PacketIndex", "$Touch"]) {
  t(`引数 ${p} を取る`, paramBlock.includes(p));
}

// --- 2. ファイルスコープにある（worker runspace から見える） -----------
// worker は ReviewJob.ps1 を dot-source するので、関数は入れ子でなく素で定義されていること。
t("ファイルスコープに定義されている（行頭 function）", /^function Invoke-KoseiPacket \{/m.test(job));
t("Start-KoseiReviewJob より前にある",
  job.indexOf("function Invoke-KoseiPacket {") < job.indexOf("function Start-KoseiReviewJob {"));

// --- 3. ループは委譲するだけ -------------------------------------------
const loopStart = job.indexOf("function Invoke-KoseiSupervisedSequentialPackets {");
t("ジョブ本体にパケットループがある", loopStart > 0);
const loopBody = job.slice(loopStart, job.indexOf("\nfunction Start-KoseiReviewJob", loopStart));
t("ループが Invoke-KoseiPacket を呼ぶ", /Invoke-KoseiPacket -Packet \$p /.test(loopBody), loopBody.slice(0, 200));
t("打ち切り判定はworker自身の停止フラグで行う",
  /Invoke-KoseiPacket[\s\S]{0,700}\$Shared\.worker_stop\[\[string\]\$WorkerIndex\]\s*=\s*\$true/.test(loopBody));

// ⚠️ ここが本題。Copilotへの往復がループへ埋め戻されていないこと。
t("ループ本体に Copilot 往復が埋め戻されていない",
  !loopBody.includes("Invoke-KoseiCopilotReviewRequest"), loopBody.slice(0, 300));
t("ループ本体に multipass 追撃が埋め戻されていない",
  !loopBody.includes("Get-KoseiPassSchedule"));

// --- 4. 往復と追撃は関数側にある ---------------------------------------
const fnEnd = job.indexOf("\nfunction ", fnStart + 10);
const fnBody = job.slice(fnStart, fnEnd > 0 ? fnEnd : job.length);
t("関数側が Copilot 往復を持つ", fnBody.includes("Invoke-KoseiCopilotReviewRequest"));
t("関数側が multipass 追撃を持つ", fnBody.includes("Get-KoseiPassSchedule"));
t("関数側が打ち切りフラグを返す", /return \$fatalScreenFailure/.test(fnBody));

// --- 5. ターンマーカーはパケットごとに一意 -----------------------------
// 並列にすると同じ番号のマーカーが同時に飛びうる。採番に PacketIndex を使い続けること。
t("ターンマーカーの採番に PacketIndex を使う",
  /New-KoseiTurnMarker[^\n]*-PacketIndex \(\[int\]\$PacketIndex\)/.test(fnBody),
  (fnBody.match(/New-KoseiTurnMarker[^\n]*/) || [""])[0]);

// --- 6. ワーカーごとの CDP ページを通せる（§6.4 #1 の継ぎ目） -----------
const client = fs.readFileSync(new URL("../src/CopilotClient.ps1", import.meta.url), "utf8");

t("Invoke-KoseiPacket が -Page を取る", /\$Page = \$null/.test(paramBlock));

// ⚠️ 1箇所でも渡し忘れると、そのターンだけ「条件に合う最初のページ」へ行く。
//    並列時は他ワーカーのチャットへ書き込むことになり、両方の回答が壊れる。
// コメント行（# で始まる）は数えない。説明文に関数名が出てくるため。
const roundTrips = fnBody
  .split(/\r?\n/)
  .filter(l => !/^\s*#/.test(l) && l.includes("Invoke-KoseiCopilotReviewRequest"))
  .map(l => l.trim());
t("Copilot 往復は4箇所（pass1 / 分割再試行 / 全体回復 / 追撃pass）", roundTrips.length === 4, roundTrips.length);
t("往復すべてに -Page を渡す",
  roundTrips.every(l => / -Page \$Page(\s|$)/.test(l)),
  roundTrips.filter(l => !/ -Page \$Page(\s|$)/.test(l)));

t("Invoke-KoseiCopilotReviewRequest が -Page を受け取る",
  /function Invoke-KoseiCopilotReviewRequest[\s\S]{0,1400}\$Page = \$null/.test(client));
t("渡されたページを優先し、無ければ従来どおり解決する",
  /\$page = if \(\$null -ne \$Page\) \{ \$Page \} else \{ Get-KoseiCopilotPage -Settings \$Settings \}/.test(client));

// hidden の事前判定は添付を拒否しない。実際に進展が無い timeout だけを
// Exception.Data の typed failure として ReviewJob へ渡す。
const attachStart = client.indexOf("function Invoke-KoseiCopilotAttachFiles {");
const attachEnd = client.indexOf("\nfunction ", attachStart + 10);
const attachBody = client.slice(attachStart, attachEnd > attachStart ? attachEnd : client.length);
const visibilityBlock = attachBody.slice(attachBody.indexOf("$initialVisibility"), attachBody.indexOf("$null = Clear-KoseiResidualAttachments"));
t("typed failure helper が Exception.Data を使う",
  /function New-KoseiFailureException[\s\S]{0,500}Data\['KoseiFailureKind'\]/.test(client));
t("hidden でも添付処理を継続する", visibilityBlock.includes("Write-KoseiLog") && !visibilityBlock.includes("throw"));
t("hidden+進展なし timeout が needs_user_visibility を typed throw する",
  /\$noAttachProgress[\s\S]{0,500}New-KoseiFailureException[\s\S]{0,200}needs_user_visibility/.test(attachBody));
const setInputStart = client.indexOf("function Invoke-KoseiSetFileInputFile {");
const setInputEnd = client.indexOf("\nfunction ", setInputStart + 10);
const setInputBody = setInputStart >= 0
  ? client.slice(setInputStart, setInputEnd > setInputStart ? setInputEnd : client.length)
  : "";
t("添付attempt直前にperformance.now baselineを取得する",
  attachBody.indexOf("performance.now())()") >= 0 &&
  attachBody.indexOf("performance.now())()") < attachBody.indexOf("Invoke-KoseiAttachmentSequence") &&
  setInputBody.includes("DOM.setFileInputFiles") &&
  setInputBody.indexOf("Assert-KoseiTrustedOriginOnSocket") < 0 &&
  setInputBody.indexOf("Assert-KoseiTrustedCopilotOriginOnSocket") < setInputBody.indexOf("DOM.setFileInputFiles"));
t("timeout upload計測はbaseline以降のresourceだけを数える",
  /startTime\) >= baseline - 50/.test(attachBody) &&
  /initiatorType/.test(attachBody) &&
  /UPLOAD_BASELINE/.test(attachBody));
t("timeout visibilityは開始時またはtimeout時hiddenを扱う",
  /\(\$initialVisibility -eq 'hidden' -or \$timeoutVisibility -eq 'hidden'\)/.test(attachBody));
t("upload token JSONはPS5.1でもflat arrayを生成する",
  /function ConvertTo-KoseiJsonStringArray[\s\S]{0,500}ConvertTo-Json -InputObject \(\[string\]\$value\) -Compress[\s\S]{0,200}return '\[' \+ \(\$parts -join ','\) \+ '\]'/.test(client) &&
  /\$uploadTokensJson = ConvertTo-KoseiJsonStringArray -Values \$uploadTokens/.test(attachBody) &&
  !/ConvertTo-Json -InputObject \(,\$uploadTokens\)/.test(attachBody));
t("visibility pauseはtimeout probe成功時だけ判定する",
  /\$timeoutProbeSucceeded = \$false/.test(attachBody) &&
  /\$timeoutProbeSucceeded = \$true/.test(attachBody) &&
  /\$uploadBaselineAvailable -and \$timeoutProbeSucceeded -and/.test(attachBody));
t("ReviewJob は例外文字列ではなく Data の failure kind を読む",
  /function Get-KoseiFailureKind[\s\S]{0,800}KoseiFailureKind/.test(job) &&
  !/\$detail -match ['"]needs_user_visibility:/.test(job));
t("multipass は typed visibility failure を上位へ再throwする",
  /Get-KoseiFailureKind -ErrorRecord \$_\) -eq 'needs_user_visibility'\) \{ throw \}/.test(job));

// --- 7. 復旧経路が自分のターゲットを引き直す ---------------------------
// ここを直さないと、CDPエラーが続いたときに他ワーカーの窓へ乗り移る。
t("Get-KoseiCopilotPageById がある", /function Get-KoseiCopilotPageById \{/.test(client));
t("Wait-KoseiCopilotReviewResponse が -TargetId を取る",
  /function Wait-KoseiCopilotReviewResponse[\s\S]{0,900}\[string\]\$TargetId = ''/.test(client));
t("復旧は TargetId があれば id で引き直す",
  /if\(\[string\]::IsNullOrWhiteSpace\(\$TargetId\)\)\{Get-KoseiCopilotPage -Settings \$Settings\}else\{Get-KoseiCopilotPageById -Settings \$Settings -TargetId \$TargetId\}/.test(client));
t("往復側が TargetId を渡す",
  (client.match(/Wait-KoseiCopilotReviewResponse[^\r\n]*-TargetId \$targetId/g) || []).length === 2);

// --- 8. 並列実行（§6.4 #4）------------------------------------------
const settings = fs.readFileSync(new URL("../src/Settings.ps1", import.meta.url), "utf8");
const settingsTemplateRaw = fs.readFileSync(new URL("../config/settings.template.json", import.meta.url), "utf8");
const settingsTemplate = JSON.parse(settingsTemplateRaw.charCodeAt(0) === 0xFEFF ? settingsTemplateRaw.slice(1) : settingsTemplateRaw);

// 整合性セクションは観点パケットを独立に投げるため、設定を触らない環境でも
// 既定で複数workerを使う。実測（docs/benchmarks/README.md）で4ワーカーまで
// 速度が伸びることを確認できたため既定を4にした。明示的に1を設定した利用者は
// 従来どおり逐次。
t("review_max_workers の既定は実測で確認済みの4", /review_max_workers\s*=\s*4\b/.test(settings),
  (settings.match(/review_max_workers\s*=\s*[^\r\n]*/) || [""])[0]);
// ⚠️ README.md（セットアップ手順）で settings.template.json を settings.json へ
//    コピーする運用のため、テンプレート側の値が実質の既定値としてSettings.ps1の
//    ハードコード既定を上書きしてしまう。ここを直し忘れると、Settings.ps1側だけ
//    4にしても実運用は2のまま（README.mdの手順でテンプレートがsettings.jsonへ
//    コピーされ既定値を上書きする）。両者が一致し、かつ4であることを
//    両方チェックする。
const settingsPsDefault = Number((settings.match(/review_max_workers\s*=\s*(\d+)/) || [])[1]);
t("settings.template.json の review_max_workers もSettings.ps1の既定と一致し、かつ4",
  settingsTemplate.review_max_workers === 4 && settingsTemplate.review_max_workers === settingsPsDefault,
  { template: settingsTemplate.review_max_workers, settingsPsDefault });
t("review_max_workers を検証済みflagに含める", /review_max_workers\s*=\s*&\s*\$asWorkers/.test(settings));
t("範囲外は 1 へ落とす", /\$n -lt 1 -or \$n -gt 8/.test(settings));

t("ワーカー数はパケット数で頭打ちにする",
  /\$maxWorkers = \[Math\]::Min\(\[int\]\$reviewFlags\.review_max_workers, \$stageIndices\.Count\)/i.test(job));
t("1 以下なら監督付き逐次経路を通る", /if \(\$maxWorkers -le 1\) \{[\s\S]{0,500}Invoke-KoseiSupervisedSequentialPackets/.test(job));
t("ワーカー用ページの用意に失敗しても maxWorkers=1 へ静かに落とさない",
  !/ワーカー用ウィンドウを用意できないため逐次で実行します/.test(job) &&
  /並列ワーカー用Edge窓/.test(job));
t("ワーカーごとに自分のページを渡す", /Invoke-KoseiPacket[^\r\n]*-Page \$Page/.test(job));
t("stage内パケットは共有キューで配り、空いたワーカーが次の1件を引く",
  /\$packetQueue = New-Object System\.Collections\.Concurrent\.ConcurrentQueue\[int\]/.test(job) &&
  /\$PacketQueue\.TryDequeue\(\[ref\]\$i\)/.test(job));
t("後続stageは先行stageの成功完了までbarrierで止める",
  /function Get-KoseiOrderedStageGroups \{/.test(job)
  && /function Test-KoseiStageRunnable \{/.test(job)
  && /stagePackets\.Count -eq 0/.test(job)
  && /Test-KoseiStageRunnable -State \$State -StageIndex \$stageIndex/.test(job));
t("submitted staged jobの全体契約を検証する",
  /function Test-KoseiSubmittedStageContract \{/.test(job)
  && /staged jobにmetadataあり\/なしのパケットを混在できません/.test(job)
  && /stage_indexとstage_orderが一致しません/.test(job)
  && /stage_totalが一致しません/.test(job)
  && /stageが1からdeclared totalまで連続していません/.test(job));
t("stage欠落とdeclared totalを実行前に拒否する",
  /\$distinctStages\.Count -ne \$declaredTotal/.test(job)
  && /for \(\$stage = 1; \$stage -le \$declaredTotal; \$stage\+\+\)/.test(job)
  && /declared_stage_total = \[int\]\$stageContract\.declared_total/.test(job));
t("schedulerは観測最大ではなく宣言totalを保持する",
  /\$stageTotal = \[Math\]::Max\(1, \[int\]\$State\.declared_stage_total\)/.test(job));
t("stage 2はstage 1完了後に既出digestをserver側で注入する",
  /function Add-KoseiStagePriorFindingsDigest \{/.test(job)
  && /Get-KoseiPriorFindingsDigest -Passes \$priorPasses -Max 50/.test(job)
  && /SERVER_GENERATED_PRIOR_FINDINGS_DIGEST/.test(job)
  && /Add-KoseiStagePriorFindingsDigest -State \$State -StagePackets \$stagePackets -StageIndex \$stageIndex/.test(job));
t("stage 2 digest注入後にprompt hashを更新する",
  /WriteAllText\(\$path, \$prompt \+ \$suffix[\s\S]{0,180}\$packet\.prompt_sha256 = Get-KoseiFileSha256 -Path \$path/.test(job));
t("個別workerの失敗は worker_stop に閉じ込める",
  /worker_stop\s*=\s*\[hashtable\]::Synchronized/.test(job) &&
  /\$Shared\.worker_stop\[\[string\]\$WorkerIndex\]\s*=\s*\$true/.test(job));
t("worker停止理由を保存する", /stop_reasons\s*=\s*\[hashtable\]::Synchronized/.test(job) && /\$Shared\.stop_reasons\[\[string\]\$WorkerIndex\]/.test(job));
t("visibility停止の残件を supervisor がqueued保持する", /stopReason -eq 'needs_user_visibility'[\s\S]{0,240}continue/.test(job));
const waitStart = job.indexOf("function Wait-KoseiWorkerHandles {");
const waitEnd = job.indexOf("\nfunction Stop-KoseiJob", waitStart + 10);
const waitBody = job.slice(waitStart, waitEnd > waitStart ? waitEnd : job.length);
const asyncGate = waitBody.indexOf("if ($h.Async.IsCompleted)");
const firstReasonRead = waitBody.indexOf("$Shared.stop_reasons");
const endInvoke = waitBody.indexOf("EndInvoke");
t("stopReasonはAsync完了判定前に先読みしない", asyncGate >= 0 && (firstReasonRead < 0 || firstReasonRead > asyncGate));
t("stopReasonはEndInvoke後に再読する", endInvoke >= 0 && firstReasonRead > endInvoke && /EndInvoke[\s\S]{0,260}\$Shared\.stop_reasons/.test(waitBody));
t("terminal遷移とpackets_done加算をロック下helperへ集約する",
  /function Set-KoseiPacketTerminalStatus/.test(job) &&
  /Set-KoseiPacketTerminalStatus -State \$State -Index/.test(job) &&
  /\$State\.packets_done = \[int\]\$State\.packets_done \+ 1/.test(job));
t("他workerを止める Shared.fatal 依存がない",
  !/\$State\.cancel_requested\s*-or\s*\$Shared\.fatal/.test(job) &&
  !/\$Shared\.fatal\s*=\s*\$true/.test(job));
t("ワーカーは自分の番号をログへ出す", /Set-KoseiWorkerIndex -Index \$WorkerIndex/.test(job));

// --- 9. 同時実行中のパケットを複数持てる ------------------------------
t("state に current_packets がある", /current_packets\s*=\s*@\(\)/.test(job));
t("status に current_packets を載せる", /current_packets\s*=\s*@\(\$State\.current_packets\)/.test(job));

// --- 10. ログの直列化（§6.4 #5）--------------------------------------
const paths = fs.readFileSync(new URL("../src/Paths.ps1", import.meta.url), "utf8");
// ⚠️ $script: の Monitor は runspace ごとに別インスタンスになるので同期にならない。
//    名前付き Mutex でなければならない。
t("ログは名前付き Mutex で直列化する", /New-Object System\.Threading\.Mutex\(\$false, 'Local\\PdfKoseiAssist\.Log'\)/.test(paths));
t("ログ行に worker=N を付ける", /worker=' \+ \[string\]\$script:KoseiWorkerIndex/.test(paths));
t("ワーカー番号を設定できる", /function Set-KoseiWorkerIndex/.test(paths));

const server = fs.readFileSync(new URL("../src/Server.ps1", import.meta.url), "utf8");
t("pass-stats も名前付き Mutex で直列化する",
  /New-Object System\.Threading\.Mutex\(\$false, 'Local\\PdfKoseiAssist\.PassStat'\)/.test(server));

// --- 11. ワーカー用ページの用意は製品と probe で同じ関数 ---------------
t("New-KoseiCopilotWorkerPages がある", /function New-KoseiCopilotWorkerPages \{/.test(client));
t("2つ目以降は必ず別ウィンドウ", /Target\.createTarget[^\r\n]*newWindow = \$true/.test(client));
const probe = fs.readFileSync(new URL("./Measure-Concurrency.ps1", import.meta.url), "utf8");
// コメント行は数えない（説明文に関数名が出てくるため）。
const probeCode = probe.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join("\n");
t("probe も同じ関数を使う（別実装を持たない）",
  /New-KoseiCopilotWorkerPages -Settings \$settings -Count \$Workers/.test(probeCode) &&
  !/Target\.createTarget/.test(probeCode));

if (bad) { console.error(`\nTest-PacketExtraction: FAIL (${bad})`); process.exit(1); }
console.log("\nTest-PacketExtraction: PASS");
