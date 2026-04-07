// ============================================================
// load_gtfs.js
// 広島県バス協会 GTFSデータ表示システム
//
// 【機能】
//   1. 事業者セレクターで表示する事業者を切り替える
//   2. バス停を地図上にマーカー表示（stops.txt）
//   3. バス停クリックで時刻表パネルを表示（stop_times.txt）
//   4. 時刻クリックで便情報パネルと路線を地図表示
//   5. 当日の運行日（平日・土曜・日曜・祝日）を自動判定
// ============================================================

// -------------------------------------------------------
// 事業者リスト
// folder    ... data/以下のフォルダ名
// name      ... セレクターに表示する名称
// realtimeId... リアルタイムAPIの事業者ID
// -------------------------------------------------------
var OPERATORS = [
  { folder: "hiroden", name: "広島電鉄", realtimeId: "8" },
  { folder: "hiroshimabus", name: "広島バス", realtimeId: "9" },
  { folder: "hirokotsu", name: "広島交通", realtimeId: "10" },
  { folder: "geiyo", name: "芸陽バス", realtimeId: "11" },
  { folder: "bihoku", name: "備北交通", realtimeId: "12" },
  { folder: "hdnishihiroshima", name: "HD西広島", realtimeId: "13" },
  { folder: "fouble", name: "フォーブル", realtimeId: "14" },
  { folder: "jrbus", name: "JRバス中国", realtimeId: "15" },
  { folder: "sasaki", name: "ささき観光(ハートバス)", realtimeId: "17" },
  { folder: "kurebus", name: "呉市生活バス", realtimeId: "18" },
  { folder: "hatsukaichi", name: "廿日市市自主運行", realtimeId: "19" },
  { folder: "onomichi", name: "おのみちバス", realtimeId: "53" },
  { folder: "asahi", name: "朝日交通(阿戸線)", realtimeId: "54" },
];

// -------------------------------------------------------
// 現在選択中の事業者（初期値はHD西広島）
// -------------------------------------------------------
var currentOperator = OPERATORS.find(function (o) {
  return o.folder === "hdnishihiroshima";
});

// -------------------------------------------------------
// 現在の事業者の静的データパスを返す
// -------------------------------------------------------
function getStaticBase() {
  return "./data/" + currentOperator.folder + "/static/";
}

// -------------------------------------------------------
// 現在の事業者のリアルタイムデータパスを返す
// -------------------------------------------------------
function getRealtimePath() {
  return "./data/" + currentOperator.folder + "/realtime/vehicle_position.bin";
}

// -------------------------------------------------------
// GTFSデータを格納するグローバル変数
// -------------------------------------------------------
var gtfsStops = [];
var gtfsStopTimes = [];
var gtfsTrips = [];
var gtfsRoutes = [];
var gtfsCalendar = [];
var gtfsCalendarDates = [];

// 当日の運行サービスIDセット
var activateServiceIds = new Set();

// バス停マーカーの配列（事業者切替時に全削除するために保持する）
var stopMarkers = [];

// 地図上に描画した路線ライン（別の便選択時に削除するために保持する）
var currentTripLine = null;

// -------------------------------------------------------
// Leaflet マップ初期化（広島市中心部）
// -------------------------------------------------------
var map = L.map("map").setView([34.3853, 132.4553], 13);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

// バスマーカーを管理するMap（vehicle_id → Leafletマーカー）
var busMarkers = new Map();

// ============================================================
// GTFSリアルタイム関連
// ============================================================

// GTFS-Realtime Protocol Buffers スキーマ定義（最小限）
var GTFS_RT_PROTO = `
syntax = "proto2";
package transit_realtime;
message FeedMessage {
  required FeedHeader header = 1;
  repeated FeedEntity entity = 2;
}
message FeedHeader {
  required string gtfs_realtime_version = 1;
  optional uint64 timestamp = 3;
}
message FeedEntity {
  required string id = 1;
  optional bool is_deleted = 3;
  optional VehiclePosition vehicle = 4;
}
message VehiclePosition {
  optional TripDescriptor trip = 1;
  optional VehicleDescriptor vehicle = 8;
  optional Position position = 2;
  optional uint64 timestamp = 5;
  optional string stop_id = 7;
}
message TripDescriptor {
  optional string trip_id = 1;
  optional string route_id = 5;
}
message VehicleDescriptor {
  optional string id = 1;
  optional string label = 2;
}
message Position {
  required float latitude  = 1;
  required float longitude = 2;
  optional float bearing   = 3;
  optional float speed     = 5;
}
`;

// -------------------------------------------------------
// バスアイコンを生成する（進行方向に応じて回転させる）
// -------------------------------------------------------
function createBusIcon(bearing) {
  var rot = bearing != null ? bearing : 0;
  var svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
    '<g transform="rotate(' +
    rot +
    ',16,16)">' +
    '<circle cx="16" cy="16" r="14" fill="#1a6b3c" stroke="white" stroke-width="2"/>' +
    '<text x="16" y="21" text-anchor="middle" font-size="16" fill="white">\uD83D\uDE8C</text>' +
    "</g></svg>";
  return L.divIcon({
    html: svg,
    className: "",
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -18],
  });
}

// -------------------------------------------------------
// ヘッダーのステータス表示を更新する
// -------------------------------------------------------
function setStatus(state, text) {
  var dot = document.getElementById("status-dot");
  var label = document.getElementById("status-text");
  dot.className = state;
  label.textContent = text;
}

// -------------------------------------------------------
// フッターの情報パネルを更新する
// -------------------------------------------------------
function updateInfoPanel(count, feedTimestamp) {
  document.getElementById("bus-count").textContent = count;
  var fetchedAt = new Date().toLocaleTimeString("ja-JP");
  var dataTime = feedTimestamp
    ? new Date(Number(feedTimestamp) * 1000).toLocaleTimeString("ja-JP")
    : "--";
  document.getElementById("last-updated").textContent =
    "取得: " + fetchedAt + "  データ時刻: " + dataTime;
}

// -------------------------------------------------------
// protobufjs でGTFSリアルタイムバイナリをデコードする
// -------------------------------------------------------
async function decodeFeedMessage(buffer) {
  var root = await protobuf.parse(GTFS_RT_PROTO, { keepCase: true }).root;
  var FeedMessage = root.lookupType("transit_realtime.FeedMessage");
  return FeedMessage.decode(new Uint8Array(buffer));
}

// -------------------------------------------------------
// リアルタイムデータを取得して地図に描画する
// 現在選択中の事業者のキャッシュファイルを使用する
// -------------------------------------------------------
async function fetchVehiclePositions() {
  setStatus("loading", "loading...");
  try {
    var url = getRealtimePath() + "?t=" + Date.now();
    var res = await fetch(url, {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
      },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    var buffer = await res.arrayBuffer();
    var feed = await decodeFeedMessage(buffer);
    renderVehicles(feed.entity || [], feed.header && feed.header.timestamp);
    setStatus("ok", "updated");
  } catch (err) {
    setStatus("error", "error: " + err.message);
    console.error("[GTFS-RT] 取得失敗:", err);
  }
}

// -------------------------------------------------------
// 地図上にバスマーカーを描画する
// 前回から消えた車両のマーカーは削除する
// -------------------------------------------------------
function renderVehicles(entities, feedTimestamp) {
  var activeIds = new Set();
  for (var i = 0; i < entities.length; i++) {
    var entity = entities[i];
    var vp = entity.vehicle;
    if (!vp || !vp.position) continue;
    var lat = vp.position.latitude;
    var lng = vp.position.longitude;
    var bearing = vp.position.bearing;
    var speed = vp.position.speed;
    if (!lat || !lng) continue;
    var vehicleId =
      (vp.vehicle && (vp.vehicle.id || vp.vehicle.label)) ||
      entity.id ||
      "unknown";
    var label = (vp.vehicle && vp.vehicle.label) || vehicleId;
    var speedKmh = speed != null ? (speed * 3.6).toFixed(1) + " km/h" : "--";
    var ts = vp.timestamp
      ? new Date(Number(vp.timestamp) * 1000).toLocaleTimeString("ja-JP")
      : "--";
    var popupHtml =
      '<div style="font-size:13px;line-height:1.7">' +
      "<b>車両ID:</b> " +
      label +
      "<br>" +
      "<b>速度:</b> " +
      speedKmh +
      "<br>" +
      "<b>時刻:</b> " +
      ts +
      "</div>";
    activeIds.add(vehicleId);
    if (busMarkers.has(vehicleId)) {
      var marker = busMarkers.get(vehicleId);
      marker.setLatLng([lat, lng]);
      marker.setIcon(createBusIcon(bearing));
      marker.getPopup().setContent(popupHtml);
    } else {
      var newMarker = L.marker([lat, lng], { icon: createBusIcon(bearing) })
        .bindPopup(popupHtml)
        .addTo(map);
      busMarkers.set(vehicleId, newMarker);
    }
  }
  // 前回のデータに存在したが今回ないバスのマーカーを削除する
  busMarkers.forEach(function (marker, id) {
    if (!activeIds.has(id)) {
      map.removeLayer(marker);
      busMarkers.delete(id);
    }
  });
  updateInfoPanel(activeIds.size, feedTimestamp);
}

// ============================================================
// 静的GTFSデータ関連
// ============================================================

// -------------------------------------------------------
// PapaParse を使ってCSVファイルを読み込む
// -------------------------------------------------------
function loadCsv(path) {
  return new Promise(function (resolve, reject) {
    Papa.parse(path, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: function (results) {
        resolve(results.data);
      },
      error: function (err) {
        reject(err);
      },
    });
  });
}

// -------------------------------------------------------
// 今日の日付をYYYYMMDD形式で返す
// -------------------------------------------------------
function getTodayStr() {
  var d = new Date();
  var yyyy = d.getFullYear();
  var mm = String(d.getMonth() + 1).padStart(2, "0");
  var dd = String(d.getDate()).padStart(2, "0");
  return yyyy + mm + dd;
}

// -------------------------------------------------------
// 今日が何曜日かをcalendar.txtの列名形式で返す
// -------------------------------------------------------
function getTodayDayName() {
  var days = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  return days[new Date().getDay()];
}

// -------------------------------------------------------
// 当日の運行サービスIDを判定する
// calendar_dates.txt の例外を優先して適用する
// -------------------------------------------------------
function calcActiveServiceIds() {
  activateServiceIds = new Set();
  var todayStr = getTodayStr();
  var todayDay = getTodayDayName();

  // calendar_dates.txt の例外を収集する
  var addedByException = new Set();
  var removedByException = new Set();
  gtfsCalendarDates.forEach(function (row) {
    if (row.date === todayStr) {
      if (row.exception_type === "1") {
        addedByException.add(row.service_id);
      } else if (row.exception_type === "2") {
        removedByException.add(row.service_id);
      }
    }
  });

  // calendar.txt の曜日フラグで基本的な運行日を判定する
  gtfsCalendar.forEach(function (row) {
    if (row.start_date <= todayStr && todayStr <= row.end_date) {
      if (row[todayDay] === "1" && !removedByException.has(row.service_id)) {
        activateServiceIds.add(row.service_id);
      }
    }
  });

  // 例外で追加されたservice_idを加える
  addedByException.forEach(function (sid) {
    activateServiceIds.add(sid);
  });

  console.log(
    "[GTFS] 今日のサービスID数:",
    activateServiceIds.size,
    Array.from(activateServiceIds),
  );
}

// -------------------------------------------------------
// バス停マーカーのアイコンを生成する（青い小円）
// -------------------------------------------------------
function createStopIcon() {
  var svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">' +
    '<circle cx="7" cy="7" r="6" fill="#2c7be5" stroke="white" stroke-width="1.5"/>' +
    "</svg>";
  return L.divIcon({
    html: svg,
    className: "",
    iconSize: [14, 14],
    iconAnchor: [7, 7],
    popupAnchor: [0, -8],
  });
}

// -------------------------------------------------------
// 既存のバス停マーカーを全て地図から削除する
// 事業者切替時に呼び出す
// -------------------------------------------------------
function clearStopMarkers() {
  stopMarkers.forEach(function (m) {
    map.removeLayer(m);
  });
  stopMarkers = [];
}

// -------------------------------------------------------
// 全バス停を地図上にマーカーとして表示する
// -------------------------------------------------------
function renderStops() {
  clearStopMarkers();
  gtfsStops.forEach(function (stop) {
    var lat = parseFloat(stop.stop_lat);
    var lng = parseFloat(stop.stop_lon);
    if (isNaN(lat) || isNaN(lng)) return;

    // stop_id はスペース入り文字列のため文字列のまま扱う
    var stopId = stop.stop_id;
    var stopName = stop.stop_name || "不明";

    var marker = L.marker([lat, lng], { icon: createStopIcon() });
    marker.on("click", function () {
      showStopPanel(stopId, stopName);
    });
    marker.addTo(map);
    stopMarkers.push(marker);
  });
  console.log("[GTFS] バス停描画完了:", stopMarkers.length, "件");
}

// -------------------------------------------------------
// バス停情報パネルを表示する
// 当日運行中の便の時刻表を表示する
// -------------------------------------------------------
function showStopPanel(stopId, stopName) {
  document.getElementById("stop-panel-title").textContent = stopName;
  var body = document.getElementById("stop-panel-body");
  body.innerHTML = '<p class="loading-msg">時刻表を読み込み中...</p>';
  document.getElementById("stop-panel").classList.add("visible");

  // trips.txt と routes.txt をインデックス化する
  var tripMap = {};
  gtfsTrips.forEach(function (t) {
    tripMap[t.trip_id] = t;
  });
  var routeMap = {};
  gtfsRoutes.forEach(function (r) {
    routeMap[r.route_id] = r;
  });

  // このバス停に停車する当日の便を抽出する
  var rows = [];
  gtfsStopTimes.forEach(function (st) {
    if (st.stop_id !== stopId) return;
    var trip = tripMap[st.trip_id];
    if (!trip) return;
    if (!activateServiceIds.has(trip.service_id)) return;
    var route = routeMap[trip.route_id] || {};
    // -------------------------------------------------------
    // pickup_type=1 は降車専用（終点）のため除外する
    // 乗車可能なバス停のみ時刻表に表示する
    // -------------------------------------------------------
    if (st.pickup_type === "1") return;

    var route = routeMap[trip.route_id] || {};
    rows.push({
      time:      st.arrival_time,
      // 路線番号は routes.txt の route_short_name を使用する
      routeNo:   route.route_short_name || "--",
      // 行先は stop_times.txt の stop_headsign を優先して使用する
      // stop_headsign がない場合は trip_headsign を使用する
      headsign:  st.stop_headsign || trip.trip_headsign || "--",
      tripId:    st.trip_id,
      stopId:    stopId
    });
  });

  // 時刻順にソートする
  rows.sort(function (a, b) {
    return a.time.localeCompare(b.time);
  });

  if (rows.length === 0) {
    body.innerHTML = '<p class="loading-msg">本日の運行はありません</p>';
    return;
  }

  var html =
    '<p class="stop-meta">stop_id: ' +
    stopId +
    "</p>" +
    '<table class="timetable">' +
    "<tr><th>時刻</th><th>路線</th><th>行先</th></tr>";

  rows.forEach(function (row) {
    var timeDisp = row.time.substring(0, 5);
    html +=
      "<tr>" +
      '<td class="time-cell" data-trip-id="' +
      row.tripId +
      '" data-stop-id="' +
      row.stopId +
      '">' +
      timeDisp +
      "</td>" +
      "<td>" +
      row.routeNo +
      "</td>" +
      "<td>" +
      row.headsign +
      "</td>" +
      "</tr>";
  });
  html += "</table>";
  body.innerHTML = html;

  // 時刻セルのクリックイベントを設定する
  body.querySelectorAll(".time-cell").forEach(function (cell) {
    cell.addEventListener("click", function () {
      showTripPanel(
        cell.getAttribute("data-trip-id"),
        cell.getAttribute("data-stop-id"),
      );
    });
  });
}

// -------------------------------------------------------
// 便情報パネルを表示して地図上に路線を描画する
// -------------------------------------------------------
function showTripPanel(tripId, currentStopId) {
  var trip = gtfsTrips.find(function (t) {
    return t.trip_id === tripId;
  });
  var headsign = trip ? trip.trip_headsign || "--" : "--";
  document.getElementById("trip-panel-title").textContent = "行先: " + headsign;

  var body = document.getElementById("trip-panel-body");
  body.innerHTML = '<p class="loading-msg">便情報を読み込み中...</p>';
  document.getElementById("trip-panel").classList.add("visible");

  // この便の全停留所を stop_sequence 順に抽出する
  var stopTimes = gtfsStopTimes.filter(function (st) {
    return st.trip_id === tripId;
  });
  stopTimes.sort(function (a, b) {
    return parseInt(a.stop_sequence) - parseInt(b.stop_sequence);
  });

  // stops.txt をインデックス化する
  var stopMap = {};
  gtfsStops.forEach(function (s) {
    stopMap[s.stop_id] = s;
  });

  var html = '<ul class="stop-list">';
  var coords = [];

  stopTimes.forEach(function (st) {
    var stop = stopMap[st.stop_id];
    var stopName = stop ? stop.stop_name || "--" : "--";
    var timeDisp = st.arrival_time ? st.arrival_time.substring(0, 5) : "--";
    var isCurrent = st.stop_id === currentStopId;
    var liClass = isCurrent ? ' class="current-stop"' : "";

    html +=
      "<li" +
      liClass +
      ">" +
      '<span class="stop-time">' +
      timeDisp +
      "</span>" +
      "<span>" +
      stopName +
      "</span>" +
      "</li>";

    if (stop) {
      var lat = parseFloat(stop.stop_lat);
      var lng = parseFloat(stop.stop_lon);
      if (!isNaN(lat) && !isNaN(lng)) coords.push([lat, lng]);
    }
  });

  html += "</ul>";
  body.innerHTML = html;

  // 前の路線を削除して新しい路線を描画する
  if (currentTripLine) {
    map.removeLayer(currentTripLine);
    currentTripLine = null;
  }
  if (coords.length >= 2) {
    currentTripLine = L.polyline(coords, {
      color: "#2c7be5",
      weight: 4,
      opacity: 0.8,
    }).addTo(map);
    map.fitBounds(currentTripLine.getBounds(), { padding: [30, 30] });
  }
}

// ============================================================
// パネルの開閉処理
// ============================================================

// バス停情報パネルの×ボタン
document
  .getElementById("stop-panel-close")
  .addEventListener("click", function () {
    document.getElementById("stop-panel").classList.remove("visible");
    document.getElementById("trip-panel").classList.remove("visible");
    if (currentTripLine) {
      map.removeLayer(currentTripLine);
      currentTripLine = null;
    }
  });

// 便情報パネルの×ボタン
document
  .getElementById("trip-panel-close")
  .addEventListener("click", function () {
    document.getElementById("trip-panel").classList.remove("visible");
    if (currentTripLine) {
      map.removeLayer(currentTripLine);
      currentTripLine = null;
    }
  });

// ============================================================
// 静的データ読み込み（事業者切替時も呼び出す）
// ============================================================
async function initGtfs() {
  console.log("[GTFS] 静的データ読み込み開始:", currentOperator.name);
  setStatus("loading", currentOperator.name + " 読み込み中...");

  // パネルを閉じる
  document.getElementById("stop-panel").classList.remove("visible");
  document.getElementById("trip-panel").classList.remove("visible");
  if (currentTripLine) {
    map.removeLayer(currentTripLine);
    currentTripLine = null;
  }

  // GTFSデータをリセットする
  gtfsStops = [];
  gtfsStopTimes = [];
  gtfsTrips = [];
  gtfsRoutes = [];
  gtfsCalendar = [];
  gtfsCalendarDates = [];
  activateServiceIds = new Set();

  try {
    var base = getStaticBase();
    var results = await Promise.all([
      loadCsv(base + "stops.txt"),
      loadCsv(base + "stop_times.txt"),
      loadCsv(base + "trips.txt"),
      loadCsv(base + "routes.txt"),
      loadCsv(base + "calendar.txt"),
      loadCsv(base + "calendar_dates.txt"),
    ]);

    gtfsStops = results[0];
    gtfsStopTimes = results[1];
    gtfsTrips = results[2];
    gtfsRoutes = results[3];
    gtfsCalendar = results[4];
    gtfsCalendarDates = results[5];

    console.log("[GTFS] stops:", gtfsStops.length);
    console.log("[GTFS] stop_times:", gtfsStopTimes.length);
    console.log("[GTFS] trips:", gtfsTrips.length);
    console.log("[GTFS] routes:", gtfsRoutes.length);
    console.log("[GTFS] calendar:", gtfsCalendar.length);
    console.log("[GTFS] calendar_dates:", gtfsCalendarDates.length);

    calcActiveServiceIds();
    renderStops();
    setStatus("ok", currentOperator.name + " 読み込み完了");
    console.log("[GTFS] 初期化完了");
  } catch (err) {
    setStatus("error", "読み込みエラー: " + currentOperator.name);
    console.error("[GTFS] 初期化失敗:", err);
  }
}

// ============================================================
// 事業者セレクターの初期化
// ============================================================
function initOperatorSelector() {
  var select = document.getElementById("operator-select");
  select.innerHTML = "";

  OPERATORS.forEach(function (op) {
    var option = document.createElement("option");
    option.value = op.folder;
    option.textContent = op.name;
    if (op.folder === currentOperator.folder) {
      option.selected = true;
    }
    select.appendChild(option);
  });

  // -------------------------------------------------------
  // セレクター変更時の処理
  // 事業者を切り替えてバス停・リアルタイムデータを再読み込みする
  // -------------------------------------------------------
  select.addEventListener("change", function () {
    var folder = select.value;
    currentOperator = OPERATORS.find(function (o) {
      return o.folder === folder;
    });
    console.log("[GTFS] 事業者切替:", currentOperator.name);

    // バスマーカーを全削除する（前の事業者のバスを消す）
    busMarkers.forEach(function (marker) {
      map.removeLayer(marker);
    });
    busMarkers.clear();

    // リアルタイムデータと静的データを再読み込みする
    fetchVehiclePositions();
    initGtfs();
  });
}

// ============================================================
// 起動処理（1回だけ実行する）
// ============================================================
initOperatorSelector(); // セレクターを初期化する
fetchVehiclePositions(); // リアルタイムデータを取得する
initGtfs(); // 静的データを読み込む

// 更新ボタンでリアルタイムデータを再取得する
document
  .getElementById("refresh-btn")
  .addEventListener("click", fetchVehiclePositions);
