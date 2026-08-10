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
t("打ち切り判定は戻り値で行う", /Invoke-KoseiPacket[^\r\n]*\$Shared\.fatal=\$true/.test(loopBody));

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
t("Copilot 往復は3箇所（pass1 / 分割再試行 / 追撃pass）", roundTrips.length === 3, roundTrips.length);
t("往復すべてに -Page を渡す",
  roundTrips.every(l => / -Page \$Page(\s|$)/.test(l)),
  roundTrips.filter(l => !/ -Page \$Page(\s|$)/.test(l)));

t("Invoke-KoseiCopilotReviewRequest が -Page を受け取る",
  /function Invoke-KoseiCopilotReviewRequest[\s\S]{0,1400}\$Page = \$null/.test(client));
t("渡されたページを優先し、無ければ従来どおり解決する",
  /\$page = if \(\$null -ne \$Page\) \{ \$Page \} else \{ Get-KoseiCopilotPage -Settings \$Settings \}/.test(client));

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

// ⚠️ 既定は 1（逐次）。ここが 1 でなくなると、設定を触っていない利用者の挙動が変わる。
t("review_max_workers の既定は 1", /review_max_workers\s*=\s*1\b/.test(settings),
  (settings.match(/review_max_workers\s*=\s*[^\r\n]*/) || [""])[0]);
t("review_max_workers を検証済みflagに含める", /review_max_workers\s*=\s*&\s*\$asWorkers/.test(settings));
t("範囲外は 1 へ落とす", /\$n -lt 1 -or \$n -gt 8/.test(settings));

t("ワーカー数はパケット数で頭打ちにする",
  /\$maxWorkers = \[Math\]::Min\(\[int\]\$reviewFlags\.review_max_workers, @\(\$State\.per_packet\)\.Count\)/i.test(job));
t("1 以下なら監督付き逐次経路を通る", /if \(\$maxWorkers -le 1\) \{[\s\S]{0,500}Invoke-KoseiSupervisedSequentialPackets/.test(job));
t("ワーカー用ページの用意に失敗したら逐次へ落とす",
  /ワーカー用ウィンドウを用意できないため逐次で実行します/.test(job));
t("ワーカーごとに自分のページを渡す", /Invoke-KoseiPacket[^\r\n]*-Page \$Page/.test(job));
t("パケットは round-robin で配る", /\$w = \$i % \$maxWorkers/.test(job));
t("致命的失敗は共有フラグで全ワーカーへ伝える",
  /\$shared = \[hashtable\]::Synchronized\(@\{[\s\S]{0,160}?fatal = \$false/.test(job) && /\$Shared\.fatal = \$true/.test(job));
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
