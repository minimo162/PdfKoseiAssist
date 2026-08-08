// ヘッドレスEdgeの後始末。**プロファイルディレクトリで特定して落とす。**
//
// ⚠️ なぜ taskkill /T では足りないか（実測 2026-08-07）:
//    `--headless=new` は**起動したプロセスが即終了して、本体が別の親にぶら下がる**。
//    そのため spawn した PID を /T で辿っても本体が見つからず、落ちない。
//    Audit-DocumentMask を90回ほど回したところ msedge が **434プロセス**まで増え、
//    CDPが詰まってベンチが「CDP応答タイムアウト」で落ちた。
//    増えても静かなので、**次に何かが遅くなるまで気づけない**型の不具合である。
//
// ⚠️ IMAGENAME 指定（`taskkill /IM msedge.exe`）で消してはいけない。
//    利用者が開いているブラウザとCopilotのタブまで巻き込む。
//    プロファイルは実行ごとに一意（mkdtemp / PID 付き）なので、それで絞る。
import { execFileSync } from "node:child_process";

/**
 * @param {string} profileDir このrun専用の --user-data-dir
 * @param {number} [pid] spawn した PID。分かるなら先にツリーを落とす
 */
export function killHeadlessByProfile(profileDir, pid) {
  if (pid) {
    try { execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }); } catch { /* 既に落ちている */ }
  }
  if (!profileDir) return;
  // PowerShell の単引用符の中はエスケープ不要（パスの \ をそのまま書ける）。
  const script = "$d = '" + String(profileDir).replace(/'/g, "''") + "'; "
    + "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | "
    + "Where-Object { $_.CommandLine -and $_.CommandLine.Contains($d) } | "
    + "ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }";
  try {
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: "ignore", timeout: 30000 });
  } catch { /* 落とせなくても本題は続ける */ }
}
