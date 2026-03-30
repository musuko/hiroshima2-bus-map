// 読み込む GTFS ZIP ファイルのローカルパス（GitHub Pages に同梱済み）
const GTFS_ZIP_URL = "current_data.zip";

// CSV 文字列を JSON 配列に変換するユーティリティ関数
function parseCsv(text) {
  // 改行で行を分割し、空行を除く
  const rows = text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0].split(",").map((h) => h.trim());
  return rows.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim());
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = values[i] ?? "";
    });
    return obj;
  });
}

function createTable(items) {
  // CSV を解析して得た配列から HTML table を生成
  if (items.length === 0) {
    return "<p>stops.txt に行がありません。</p>";
  }

  const headers = Object.keys(items[0]);
  const thead = "<tr>" + headers.map((h) => `<th>${h}</th>`).join("") + "</tr>";
  // 大量データの場合、上位200件のみ表示
  const tbody = items
    .slice(0, 200)
    .map((item) => {
      return (
        "<tr>" +
        headers.map((h) => `<td>${escapeHtml(item[h])}</td>`).join("") +
        "</tr>"
      );
    })
    .join("");

  let note = "";
  if (items.length > 200) {
    note = `<p>表示は最初の200件です (${items.length} 件中)。</p>`;
  }

  return `${note}<table border="1" cellspacing="0" cellpadding="4"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

function escapeHtml(raw) {
  return String(raw)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ボタンクリックで呼び出され、GTFS ZIP をロードして stops.txt を表示するメイン処理
async function loadGtfsStops() {
  const status = document.getElementById("status");
  const result = document.getElementById("result");

  // UI に進行状況を表示
  status.textContent = "ダウンロード中...";
  result.innerHTML = "";

  try {
    // GTFS ZIP をフェッチ（ここで CORS に注意。ローカルに同梱しているため問題なし）
    const response = await fetch(GTFS_ZIP_URL);
    if (!response.ok) {
      // 404/403 はここで捕まる
      throw new Error(`HTTP error: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    status.textContent = "zip 解凍中...";

    // バイナリを JSZip で解凍

    const zip = await JSZip.loadAsync(arrayBuffer);
    const file = zip.file("stops.txt");
    if (!file) {
      throw new Error("stops.txt が zip 内に見つかりませんでした");
    }

    const text = await file.async("text");
    const items = parseCsv(text);

    status.textContent = `読み込み完了: ${items.length} 件`;
    result.innerHTML = createTable(items);
  } catch (error) {
    // ネットワーク/zip/CSV エラーをすべてここで表示
    status.textContent = "エラー発生";
    result.innerHTML = `<pre style="color:red;">${escapeHtml(error.message || String(error))}</pre>`;
    console.error(error);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("loadBtn");
  btn.addEventListener("click", loadGtfsStops);
});
