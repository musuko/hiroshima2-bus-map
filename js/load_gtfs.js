const GTFS_ZIP_URL =
  "https://cors-anywhere.herokuapp.com/https://ajt-mobusta-gtfs.mcapps.jp/static/13/current_data.zip";

function parseCsv(text) {
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
  if (items.length === 0) {
    return "<p>stops.txt に行がありません。</p>";
  }

  const headers = Object.keys(items[0]);
  const thead = "<tr>" + headers.map((h) => `<th>${h}</th>`).join("") + "</tr>";
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

async function loadGtfsStops() {
  const status = document.getElementById("status");
  const result = document.getElementById("result");

  status.textContent = "ダウンロード中...";
  result.innerHTML = "";

  try {
    const response = await fetch(GTFS_ZIP_URL);
    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    status.textContent = "zip 解凍中...";

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
    status.textContent = "エラー発生";
    result.innerHTML = `<pre style="color:red;">${escapeHtml(error.message || String(error))}</pre>`;
    console.error(error);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("loadBtn");
  btn.addEventListener("click", loadGtfsStops);
});
