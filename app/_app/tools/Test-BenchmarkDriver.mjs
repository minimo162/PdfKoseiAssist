// Test-BenchmarkDriver.mjs — 自動実行スクリプトとアプリ側の入口が食い違っていないか検証する。
//
//   node tools/Test-BenchmarkDriver.mjs
//
// Run-Benchmark.ps1 は CDP 越しに window.__koseiBenchmark を呼ぶ。両者は別ファイルなので、
// 片方の名前を変えても静かに壊れ、しかも壊れたことは**実機で40分走らせて初めて分かる**。
// PowerShell はこのコンテナで実行できないため、せめて次の対応関係は機械で押さえておく。
//
//   1. 使っているメソッドがアプリ側に実在するか
//   2. async のメソッドを .then() で包んでいるか
//      （包まないと JSON.stringify(Promise) が "{}" になり、読み込み失敗に気づけない）
//   3. -Config の候補と実際の構成表が一致しているか
//   4. 読み込む PDF が実在し、静的配信の対象（src/config/tools 以外）か

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const driver = readFileSync(join(root, "tools", "Run-Benchmark.ps1"), "utf8");

let failures = 0;
const t = (name, cond, detail) => {
  if (!cond) { failures++; console.error(`  FAIL ${name}`); if (detail) console.error(`       ${detail}`); }
  else console.log(`  ok   ${name}`);
};

// --- 1. アプリ側の入口を読み取る ---------------------------------------
const hookStart = indexHtml.indexOf("window.__koseiBenchmark = {");
t("index.html に window.__koseiBenchmark がある", hookStart > 0);
const hookBody = indexHtml.slice(hookStart, indexHtml.indexOf("\n    };", hookStart));
const methods = new Map();   // name -> isAsync
for (const m of hookBody.matchAll(/^\s{6}(async\s+)?([A-Za-z][A-Za-z0-9_]*)\s*\(/gm)) {
  methods.set(m[2], Boolean(m[1]));
}
t(`入口のメソッドを ${methods.size} 個検出`, methods.size >= 8, [...methods.keys()].join(", "));
for (const need of ["loadTarget", "loadReference", "selectAllPages", "setChunkSize",
                    "startProofread", "startConsistency", "status", "report"]) {
  t(`入口に ${need}() がある`, methods.has(need));
}
t("loadTarget / loadReference は async", methods.get("loadTarget") === true && methods.get("loadReference") === true);
t("status / report は同期（ポーリングを待たせない）",
  methods.get("status") === false && methods.get("report") === false);

// --- 2. 使い方が合っているか -------------------------------------------
{
  const used = [...driver.matchAll(/window\.__koseiBenchmark\.([A-Za-z][A-Za-z0-9_]*)/g)].map(m => m[1]);
  const unknown = [...new Set(used)].filter(n => !methods.has(n));
  t("使っているメソッドがすべて実在する", unknown.length === 0, unknown.join(", "));

  // async のものは .then(...) で包まないと Promise が "{}" になって静かに壊れる
  for (const line of driver.split(/\r?\n/)) {
    const m = line.match(/window\.__koseiBenchmark\.([A-Za-z][A-Za-z0-9_]*)/);
    if (!m || !methods.get(m[1])) continue;
    t(`${m[1]}() の戻りを .then() で受けている`, /\.then\(/.test(line), line.trim().slice(0, 100));
  }
  t("同期メソッドは JSON.stringify で直接包んでいる",
    /JSON\.stringify\(window\.__koseiBenchmark\.status\(\)\)/.test(driver) &&
    /JSON\.stringify\(window\.__koseiBenchmark\.report\(\)\)/.test(driver));
}

// --- 3. -Config の候補と構成表 -----------------------------------------
{
  const validate = (driver.match(/\[ValidateSet\(([^)]*)\)\]/) || [])[1] || "";
  const allowed = [...validate.matchAll(/'([^']+)'/g)].map(m => m[1]).filter(x => x !== "all");
  const defined = [...driver.matchAll(/@\{\s*name\s*=\s*'([^']+)'/g)].map(m => m[1]);
  t("-Config の候補と構成表が一致",
    JSON.stringify([...allowed].sort()) === JSON.stringify([...defined].sort()),
    `ValidateSet=${allowed.join(",")} / 構成表=${defined.join(",")}`);
  t("5構成（統合3・校正1・比較用1）", defined.length === 5);
  t("-Config all は測定に使う4本だけ走る（比較用は明示指定のとき）",
    (driver.match(/inAll = \$true/g) || []).length === 4 && /\$_\.inAll/.test(driver));
  // 幅を比べるなら到達範囲が実際に変わる幅を選ぶ必要がある。
  // 幅40・60は境界の都合で幅25と到達範囲がほぼ同じで、比べても何も分からない。
  const widths = [...driver.matchAll(/kind = 'consistency'; width = (\d+)/g)].map(m => Number(m[1]));
  t("整合性の幅は 25 / 50 / 100 を比べる", [25, 50, 100].every(w => widths.includes(w)),
    widths.join(","));
  t("校正の幅は10に固定（英語単体の綴り・文法まで見るため）",
    /kind = 'proofread';   width = 10/.test(driver) && !/kind = 'proofread';\s*width = (?!10)/.test(driver));
  t("統合構成は combined プロンプトと1passプロファイルの両方を指定する",
    /combined = \$true;\s*profile = 'consistency1'/.test(driver),
    "片方だけだと『1ターンなのに観点の指示が無い』か『指示はあるのに4ターン走る』になる");
  t("比較用の4pass構成は profile を上書きしない（settings の既定で走る）",
    /name = 'consistency25'[^\n]*profile = ''/.test(driver));

  // 重ねが揃っていないと到達可能なペアが変わり、幅どうしを比較できなくなる
  const overlaps = [...driver.matchAll(/kind\s*=\s*'consistency';\s*width\s*=\s*\d+;\s*overlap\s*=\s*(\d+)/g)].map(m => m[1]);
  t("整合性の重ねが全構成で揃っている", overlaps.length === 4 && new Set(overlaps).size === 1, overlaps.join(","));
}

// --- 4. 読み込む PDF -----------------------------------------------------
{
  const paths = [...driver.matchAll(/\$(?:TargetPath|ReferencePath)\s*=\s*'([^']+)'/g)].map(m => m[1]);
  t("校正対象と比較資料の既定パスがある", paths.length === 2, paths.join(" / "));
  for (const p of paths) {
    t(`${p} が実在する`, existsSync(join(root, p.replace(/^\//, ""))));
    // Server.ps1 は src/ config/ tools/ を配信しない
    t(`${p} は静的配信の対象`, !/^\/(src|config|tools)\//i.test(p));
  }
}

// --- 5. run 間の初期化 --------------------------------------------------
{
  // findings は画面に溜まる。初期化しないと前の run の指摘が次に混ざり、
  // 「幅を広げたら増えた」ように見えてしまう。
  t("run ごとに初期化する", /Reset-App/.test(driver) && /window\.__koseiBenchmark\.reset\(\)/.test(driver));

  // ただし読み込み直してはいけない。beforeunload が /__page-closed を送り、
  // サーバーが2秒後に止まる（実測で2本目の loadTarget が Failed to fetch で落ちた）。
  t("画面を読み込み直さない（サーバーが止まるため）", !/-Method\s+'Page\.(navigate|reload)'/.test(driver));
  // 理由を書き残しておかないと、あとで「読み込み直したほうが確実では」と戻される
  t("読み込み直さない理由を両方に書き残している",
    /__page-closed/.test(driver) && /__page-closed/.test(hookBody));
}

// --- 5b. タブを閉じてもサーバーが巻き添えで止まらないか ------------------
{
  // 自動実行では CDP 側に新しいタブを開くので、アプリのタブが2つになる。
  // 片方を閉じただけで停止すると、生きているタブごとアプリが落ちる。
  const server = readFileSync(join(root, "src", "Server.ps1"), "utf8");
  const grace = Number((server.match(/__page-closed'\)\s*\{[\s\S]{0,400}?AddSeconds\((\d+)\)/) || [])[1] || 0);
  const beat = Number((indexHtml.match(/fetch\("\/__heartbeat"[\s\S]{0,120}?\},\s*(\d+)\)/) || [])[1] || 0) / 1000;
  t(`タブ閉鎖の猶予(${grace}秒)がハートビート間隔(${beat}秒)より長い`, grace > 0 && beat > 0 && grace > beat);
}

// --- 5c. 統合1ターン構成の配線 ------------------------------------------
{
  // 追撃passを畳むには「プロンプトに観点を入れる」と「passを1本にする」の両方が要る。
  // 片方だけだと静かに別物を測ることになる。
  const html = indexHtml;
  t("combined でプロンプトに 訳語の揺れ を織り込む", /packet\.combined \? `C\. 訳語の揺れ/.test(html));
  t("combined でプロンプトに 注記・脚注 を織り込む",
    /packet\.combined[\s\S]{0,2000}注記・脚注・\(注\)行・表の但し書き/.test(html));
  t("combined のときは追撃を予告しない（矛盾した指示を出さない）",
    /packet\.combined[\s\S]{0,2000}追加の質問はしません/.test(html));
  t("combined でないときは従来どおり追撃を予告する",
    /このあと同じ資料に対して観点を絞って追加で質問します/.test(html));

  t("整合性パケットが profile を積む", /profile: String\(opts\.profile \|\| ""\)/.test(html));
  const server = readFileSync(join(root, "src", "Server.ps1"), "utf8");
  t("Server.ps1 が profile を allowlist で受理", /'consistency1'\) -notcontains \$profile/.test(server));
  t("未知の profile は無視して既定に戻す（黙って別構成で走らせない）",
    /未知の profile[\s\S]{0,80}\$profile = ''/.test(server));
  const job = readFileSync(join(root, "src", "ReviewJob.ps1"), "utf8");
  t("ReviewJob がパケットの profile を最優先する",
    /IsNullOrWhiteSpace\(\[string\]\$p\.profile\)\) \{\s*\r?\n\s*\[string\]\$p\.profile/.test(job));
  t("consistency1 は broad 1本で gap も付かない",
    /consistency1 = @\('broad'\)/.test(job) && /\$noGapProfiles = @\('complement', 'consistency1'\)/.test(job));
}

// --- 5d. 無音と停止を区別できるか --------------------------------------
{
  // 表示が変わらない間も生きていることを見せないと、利用者は「止まった」と判断して
  // Ctrl+C を押す。実測で「PDF添付中…」のまま無音になり、実際は動いていた。
  t("表示が変わらなくても定期的に生存を出す", /表示に変化なし/.test(driver));
  t("長く止まったらパケット別の状態も出す",
    /quietSec -ge 300[\s\S]{0,200}koseiBenchmark\.packets\(\)/.test(driver));
}

// --- 5e. Copilot画面が見えるか ------------------------------------------
{
  // 無人で走らせる間、Copilot画面は既定で最小化されている。添付やサインインで
  // 止まったとき、[Copilot画面を表示]を押しに行かないと確認できないのは実用的でない。
  t("実行開始時に Copilot画面を表示する", /Show-KoseiCopilotEdgeWindow -Settings \$settings/.test(driver));
  t("表示を抑止する手段がある（-HideBrowser）", /\[switch\]\$HideBrowser/.test(driver) && /if \(-not \$HideBrowser\)/.test(driver));
  t("表示に失敗しても実行は続ける", /Copilot画面の表示に失敗（処理は継続）/.test(driver));

  // アプリのタブを同じウィンドウに開くと、そちらが手前になって Copilot のタブが
  // 非アクティブ（visibilityState='hidden'）になる。非アクティブなタブはレイアウトが
  // 更新されないので、添付一覧の実寸が0になり、回答本体の innerText も空になる。
  // 「画面には見えているのにアプリは何も読めない」状態を作らないため、別ウィンドウに開く。
  t("アプリのタブは別ウィンドウに開く（Copilotのタブを裏に回さない）",
    /'Target\.createTarget' -Params @\{ url = \$appUrl; newWindow = \$true \}/.test(driver));
  t("別ウィンドウで開けない環境では同じウィンドウへ落とす", /別ウィンドウで開けなかったので/.test(driver));

  // 静かに壊れて40分無駄になるのを防ぐため、走らせる前に必ず確かめる。
  t("開始前に Copilotタブの表示状態を確認する", /document\.visibilityState/.test(driver));
  t("非表示なら前面に出し直す", /'Page\.bringToFront'/.test(driver));
  t("それでも非表示なら警告する（黙って走らせない）",
    /Copilotのタブが非表示のままです/.test(driver));
}

// --- 6. 失敗パケットの取り直し ------------------------------------------
{
  // 1セクション落ちたまま進むと、その範囲の誤りが「検出できなかった」のか
  // 「そもそも見ていない」のか区別できなくなる。0件として扱うと recall が嘘になる。
  t("失敗したパケットをリトライする", /Invoke-RetryFailedPackets/.test(driver));
  t("リトライは status=error を対象にする", /status -eq 'error'/.test(driver));
  t("リトライしても残ったら未測定として警告する", /未測定/.test(driver));
  t("入口に packets() / retry() がある", methods.has("packets") && methods.has("retry"));
  t("入口に reset() がある", methods.has("reset"));

  // 整合性セクションでも payload を保持していないと retry が使えない
  t("整合性セクションでも lastAutoPayloadByPacket を作る",
    /buildConsistencySectionPackets\(opts\);[\s\S]{0,400}lastAutoPayloadByPacket = new Map/.test(indexHtml));
}

if (failures) { console.error(`\nTest-BenchmarkDriver: FAIL (${failures})`); process.exit(1); }
console.log("\nTest-BenchmarkDriver: PASS");
