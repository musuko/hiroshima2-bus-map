/**
 * load_gtfs.js
 * GTFSのZIPファイルを取得し、stops.txtをテーブルに表示する
 *
 * CORSの回避策: allorigins.win プロキシを経由してZIPを取得
 * JSZip ライブラリを使ってZIPを解凍する（CDN読み込み）
 */

const GTFS_ZIP_URL =
  "https://ajt-mobusta-gtfs.mcapps.jp/static/13/current_data.zip";
const PROXY_URL = "https://api.allorigins.win/raw?url=";

// JSZip を動的に読み込む
function loadJSZip() {
  return new Promise((resolve, reject) => {
    if (window.JSZip) {
      resolve(window.JSZip);
      return;
    }
    const script = document.createElement("script");
    script.src =
      "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    script.onload = () => resolve(window.JSZip);
    script.onerror = () => reject(new Error("JSZipの読み込みに失敗しました"));
    document.head.appendChild(script);
  });
}

// CSV文字列 → 行配列（ヘッダー付き）
function parseCSV(text) {
  // BOM除去
  const clean = text.replace(/^\uFEFF/, "").replace(/\r/g, "");
  const lines = clean.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = lines[0]
    .split(",")
    .map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows = lines.slice(1).map((line) => {
    // 簡易CSVパーサー（ダブルクォート対応）
    const cells = [];
    let cur = "",
      inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQ = !inQ;
      } else if (ch === "," && !inQ) {
        cells.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    return cells;
  });
  return { headers, rows };
}

// テーブルを描画する
function renderTable(headers, rows) {
  const head = document.getElementById("tableHead");
  const body = document.getElementById("tableBody");
  const countEl = document.getElementById("rowCount");

  head.innerHTML = "";
  body.innerHTML = "";

  const tr = document.createElement("tr");
  headers.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    tr.appendChild(th);
  });
  head.appendChild(tr);

  rows.forEach((cells) => {
    const row = document.createElement("tr");
    headers.forEach((_, i) => {
      const td = document.createElement("td");
      td.textContent = cells[i] ?? "";
      row.appendChild(td);
    });
    body.appendChild(row);
  });

  countEl.textContent = `${rows.length.toLocaleString()} 件表示`;
}

// 検索フィルター
function filterTable(headers, rows, query) {
  if (!query) return rows;
  const q = query.toLowerCase();
  // stop_name 列を優先的に検索（なければ全列）
  const nameIdx = headers.findIndex((h) => h === "stop_name");
  return rows.filter((cells) => {
    if (nameIdx >= 0) {
      return (cells[nameIdx] ?? "").toLowerCase().includes(q);
    }
    return cells.some((c) => (c ?? "").toLowerCase().includes(q));
  });
}

// メイン処理
async function loadGTFS() {
  const btn = document.getElementById("loadBtn");
  const status = document.getElementById("status");
  const searchBox = document.getElementById("searchBox");
  const progressWrap = document.getElementById("progressWrap");
  const progressBar = document.getElementById("progressBar");

  btn.disabled = true;
  searchBox.disabled = true;
  progressWrap.style.display = "block";
  progressBar.style.width = "10%";
  status.className = "";
  status.textContent = "JSZip を読み込み中...";

  let JSZip;
  try {
    JSZip = await loadJSZip();
  } catch (e) {
    status.textContent = e.message;
    status.className = "error";
    btn.disabled = false;
    progressWrap.style.display = "none";
    return;
  }

  progressBar.style.width = "25%";
  status.textContent = "ZIPを取得中（CORSプロキシ経由）...";

  let arrayBuffer;
  try {
    // allorigins.win で CORS回避
    const res = await fetch(PROXY_URL + encodeURIComponent(GTFS_ZIP_URL));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    arrayBuffer = await res.arrayBuffer();
  } catch (e) {
    status.textContent = "取得失敗: " + e.message;
    status.className = "error";
    btn.disabled = false;
    progressWrap.style.display = "none";
    return;
  }

  progressBar.style.width = "60%";
  status.textContent = "ZIPを解凍中...";

  let zip;
  try {
    zip = await JSZip.loadAsync(arrayBuffer);
  } catch (e) {
    status.textContent = "ZIP解凍失敗: " + e.message;
    status.className = "error";
    btn.disabled = false;
    progressWrap.style.display = "none";
    return;
  }

  // stops.txt を探す（パス問わず）
  const stopsFile = Object.values(zip.files).find(
    (f) => f.name.endsWith("stops.txt") && !f.dir,
  );

  if (!stopsFile) {
    status.textContent = "stops.txt が見つかりませんでした";
    status.className = "error";
    btn.disabled = false;
    progressWrap.style.display = "none";
    return;
  }

  progressBar.style.width = "80%";
  status.textContent = "stops.txt を解析中...";

  let text;
  try {
    text = await stopsFile.async("string");
  } catch (e) {
    status.textContent = "ファイル読み込み失敗: " + e.message;
    status.className = "error";
    btn.disabled = false;
    progressWrap.style.display = "none";
    return;
  }

  const { headers, rows } = parseCSV(text);

  progressBar.style.width = "100%";
  status.textContent = `読み込み完了 — ${rows.length.toLocaleString()} 件`;
  status.className = "success";

  renderTable(headers, rows);

  // 検索機能を有効化
  searchBox.disabled = false;
  searchBox.addEventListener("input", () => {
    const filtered = filterTable(headers, rows, searchBox.value);
    renderTable(headers, filtered);
  });

  setTimeout(() => {
    progressWrap.style.display = "none";
  }, 800);
  btn.disabled = false;
  btn.textContent = "再読み込み";
}

document.getElementById("loadBtn").addEventListener("click", loadGTFS);
