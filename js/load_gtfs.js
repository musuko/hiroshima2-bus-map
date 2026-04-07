// ============================================================
// load_gtfs.js
// 広島県バス協会 GTFSデータ表示システム
//
// 【機能】
//   1. バス停を地図上にマーカー表示（stops.txt）
//   2. バス停クリックで時刻表パネルを表示（stop_times.txt）
//   3. 時刻クリックで便情報パネルと路線を地図表示（trips.txt）
//   4. 当日の運行日（平日・土曜・日曜・祝日）を自動判定
//
// 【使用するGTFSファイル】
//   stops.txt          ... バス停の位置・名称
//   stop_times.txt     ... 時刻表
//   trips.txt          ... 便情報（行先・路線・運行日）
//   routes.txt         ... 路線名・バス会社
//   calendar.txt       ... 平日・土曜・日曜の運行日定義
//   calendar_dates.txt ... 祝日・特別ダイヤの例外定義
//
// 【データパス】
//   ./data/<事業者名>/static/<ファイル名>
//   例: ./data/hdnishihiroshima/static/stops.txt
// ============================================================

// -------------------------------------------------------
// 対象事業者の設定
// 現在はエイチ・ディー西広島（hdnishihiroshima）のみ対象
// 複数事業者に対応する場合はここにフォルダ名を追加する
// -------------------------------------------------------
var OPERATOR = "hdnishihiroshima";
var STATIC_BASE = "./data/" + OPERATOR + "/static/";

// -------------------------------------------------------
// GTFSデータを格納するグローバル変数
// CSVを読み込んだ後にここに格納して使い回す
// -------------------------------------------------------
var gtfsStops = []; // stops.txt の全レコード
var gtfsStopTimes = []; // stop_times.txt の全レコード
var gtfsTrips = []; // trips.txt の全レコード
var gtfsRoutes = []; // routes.txt の全レコード
var gtfsCalendar = []; // calendar.txt の全レコード
var gtfsCalendarDates = []; // calendar_dates.txt の全レコード

// -------------------------------------------------------
// 当日の運行サービスIDセット
// 今日の日付・曜日・祝日判定の結果、
// 運行しているservice_idの集合を格納する
// -------------------------------------------------------
var activateServiceIds = new Set();

// -------------------------------------------------------
// 地図上に描画した路線ライン（Leaflet Polyline）
// 別の便を選択したときに前の路線を消すために保持する
// -------------------------------------------------------
var currentTripLine = null;

// -------------------------------------------------------
// Leaflet マップ初期化
// 広島市中心部を初期表示位置に設定する
// -------------------------------------------------------
var map = L.map("map").setView([34.3853, 132.4553], 13);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

// -------------------------------------------------------
// バスマーカーを管理するMap（vehicle_id → Leafletマーカー）
// -------------------------------------------------------
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
// バスアイコンを生成する
// bearing（進行方向）に応じてアイコンを回転させる
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
// state: 'loading'（黄色点滅）/ 'ok'（緑）/ 'error'（赤）
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
// GitHub Actionsが取得したキャッシュファイルを使用する
// -------------------------------------------------------
async function fetchVehiclePositions() {
  setStatus("loading", "loading...");
  try {
    var url =
      "./data/" +
      OPERATOR +
      "/realtime/vehicle_position.bin" +
      "?t=" +
      Date.now();
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
// 戻り値: Promiseでレコード配列を返す
// -------------------------------------------------------
function loadCsv(path) {
  return new Promise(function (resolve, reject) {
    Papa.parse(path, {
      download: true, // URLからダウンロードして解析する
      header: true, // 1行目を列名として使用する
      skipEmptyLines: true, // 空行をスキップする
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
// 今日の日付をYYYYMMDD形式の文字列で返す
// calendar.txtのstart_date/end_dateと比較するために使用する
// -------------------------------------------------------
function getTodayStr() {
  var d = new Date();
  var yyyy = d.getFullYear();
  var mm = String(d.getMonth() + 1).padStart(2, "0");
  var dd = String(d.getDate()).padStart(2, "0");
  return yyyy + mm + dd;
}

// -------------------------------------------------------
// 今日が何曜日かを返す
// 戻り値: "monday"/"tuesday"/"wednesday"/"thursday"/
//         "friday"/"saturday"/"sunday"
// calendar.txtの列名と一致させる
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
// 今日の運行サービスIDを判定して activateServiceIds に格納する
//
// 判定の順序:
//   1. calendar_dates.txt で例外指定があればそれを優先する
//      exception_type=1 → 運行あり（追加）
//      exception_type=2 → 運行なし（除外）
//   2. calendar.txt の曜日フラグで判定する
//
// 祝日は calendar_dates.txt に exception_type=1 で
// 日曜ダイヤのservice_idが登録されているケースが多い
// -------------------------------------------------------
function calcActiveServiceIds() {
  var todayStr = getTodayStr();
  var todayDay = getTodayDayName();

  // calendar_dates.txt で今日の例外指定を収集する
  var addedByException = new Set(); // 運行追加されたservice_id
  var removedByException = new Set(); // 運行除外されたservice_id

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
    // 今日が有効期間内かチェックする
    if (row.start_date <= todayStr && todayStr <= row.end_date) {
      if (row[todayDay] === "1") {
        // 例外で除外されていなければ有効とする
        if (!removedByException.has(row.service_id)) {
          activateServiceIds.add(row.service_id);
        }
      }
    }
  });

  // 例外で追加されたservice_idを加える
  addedByException.forEach(function (sid) {
    activateServiceIds.add(sid);
  });

  console.log("[GTFS] 今日のサービスID数:", activateServiceIds.size);
}

// -------------------------------------------------------
// バス停マーカーのアイコンを生成する
// リアルタイムのバスアイコンと区別するためバス停専用にする
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
// 全バス停を地図上にマーカーとして表示する
// クリックするとバス停情報パネルを開く
// -------------------------------------------------------
function renderStops() {
  gtfsStops.forEach(function (stop) {
    var lat = parseFloat(stop.stop_lat);
    var lng = parseFloat(stop.stop_lon);
    if (isNaN(lat) || isNaN(lng)) return;

    // stop_id はスペース入り文字列のため文字列のまま使用する
    var stopId = stop.stop_id;
    var stopName = stop.stop_name || "不明";

    var marker = L.marker([lat, lng], { icon: createStopIcon() });

    // クリックでバス停情報パネルを表示する
    marker.on("click", function () {
      showStopPanel(stopId, stopName);
    });

    marker.addTo(map);
  });

  console.log("[GTFS] バス停描画完了:", gtfsStops.length, "件");
}

// -------------------------------------------------------
// バス停情報パネルを表示する
// 指定されたバス停の当日時刻表を表示する
//
// 引数:
//   stopId   ... クリックされたバス停のstop_id（スペース入り文字列）
//   stopName ... バス停名
// -------------------------------------------------------
function showStopPanel(stopId, stopName) {
  // パネルのタイトルを更新する
  document.getElementById("stop-panel-title").textContent = stopName;
  var body = document.getElementById("stop-panel-body");
  body.innerHTML = '<p class="loading-msg">時刻表を読み込み中...</p>';

  // パネルを表示する
  document.getElementById("stop-panel").classList.add("visible");

  // -------------------------------------------------------
  // 当日運行している便のうち、このバス停に停車する便を抽出する
  //
  // 処理の流れ:
  //   1. stop_times.txt から stop_id が一致するレコードを抽出
  //   2. trips.txt で service_id を取得
  //   3. 当日有効な service_id かチェック
  //   4. 時刻順にソートして表示
  // -------------------------------------------------------

  // trips.txt を trip_id でインデックス化する（高速検索のため）
  var tripMap = {};
  gtfsTrips.forEach(function (t) {
    tripMap[t.trip_id] = t;
  });

  // routes.txt を route_id でインデックス化する
  var routeMap = {};
  gtfsRoutes.forEach(function (r) {
    routeMap[r.route_id] = r;
  });

  // このバス停に停車する当日の便を抽出する
  var rows = [];
  gtfsStopTimes.forEach(function (st) {
    // stop_id を文字列として比較する（スペース入りに対応）
    if (st.stop_id !== stopId) return;

    var trip = tripMap[st.trip_id];
    if (!trip) return;

    // 当日運行しているservice_idかチェックする
    if (!activateServiceIds.has(trip.service_id)) return;

    var route = routeMap[trip.route_id] || {};
    rows.push({
      time: st.arrival_time, // 到着時刻（HH:MM:SS形式）
      headsign: trip.trip_headsign || st.stop_headsign || "--",
      routeName: route.route_short_name || route.route_long_name || "--",
      tripId: st.trip_id,
      stopId: stopId,
    });
  });

  // 時刻順にソートする
  rows.sort(function (a, b) {
    return a.time.localeCompare(b.time);
  });

  // -------------------------------------------------------
  // 時刻表HTMLを生成して表示する
  // -------------------------------------------------------
  if (rows.length === 0) {
    body.innerHTML = '<p class="loading-msg">本日の運行はありません</p>';
    return;
  }

  // バス停のメタ情報（stop_id）を表示する
  var html = '<p class="stop-meta">stop_id: ' + stopId + "</p>";

  // 時刻表テーブルを生成する
  html +=
    '<table class="timetable">' +
    "<tr><th>時刻</th><th>行先</th><th>路線</th></tr>";

  rows.forEach(function (row) {
    // HH:MM:SS から HH:MM に変換して表示する
    var timeDisp = row.time.substring(0, 5);

    // 時刻セルにクリックイベントを設定する
    // data-trip-id と data-stop-id を属性として持たせる
    html +=
      "<tr>" +
      '<td class="time-cell" data-trip-id="' +
      row.tripId +
      '" ' +
      'data-stop-id="' +
      row.stopId +
      '">' +
      timeDisp +
      "</td>" +
      "<td>" +
      row.headsign +
      "</td>" +
      "<td>" +
      row.routeName +
      "</td>" +
      "</tr>";
  });

  html += "</table>";
  body.innerHTML = html;

  // -------------------------------------------------------
  // 時刻セルのクリックイベントを設定する
  // クリックすると便情報パネルを表示する
  // -------------------------------------------------------
  body.querySelectorAll(".time-cell").forEach(function (cell) {
    cell.addEventListener("click", function () {
      var tripId = cell.getAttribute("data-trip-id");
      var currentStopId = cell.getAttribute("data-stop-id");
      showTripPanel(tripId, currentStopId);
    });
  });
}

// -------------------------------------------------------
// 便情報パネルを表示する
// 指定された便の全停留所と時刻を表示し、地図上にルートを描画する
//
// 引数:
//   tripId        ... 選択された便のtrip_id
//   currentStopId ... クリックされたバス停のstop_id（現在地ハイライト用）
// -------------------------------------------------------
function showTripPanel(tripId, currentStopId) {
  // trips.txt から便情報を取得する
  var trip = null;
  for (var i = 0; i < gtfsTrips.length; i++) {
    if (gtfsTrips[i].trip_id === tripId) {
      trip = gtfsTrips[i];
      break;
    }
  }

  var headsign = trip ? trip.trip_headsign || "--" : "--";
  document.getElementById("trip-panel-title").textContent = "行先: " + headsign;

  var body = document.getElementById("trip-panel-body");
  body.innerHTML = '<p class="loading-msg">便情報を読み込み中...</p>';

  // パネルを表示する
  document.getElementById("trip-panel").classList.add("visible");

  // -------------------------------------------------------
  // この便の全停留所を stop_sequence 順に抽出する
  // -------------------------------------------------------
  var stopTimes = gtfsStopTimes.filter(function (st) {
    return st.trip_id === tripId;
  });

  // stop_sequence でソートする（数値として比較する）
  stopTimes.sort(function (a, b) {
    return parseInt(a.stop_sequence) - parseInt(b.stop_sequence);
  });

  // stops.txt を stop_id でインデックス化する
  var stopMap = {};
  gtfsStops.forEach(function (s) {
    stopMap[s.stop_id] = s;
  });

  // -------------------------------------------------------
  // 停留所リストHTMLを生成する
  // -------------------------------------------------------
  var html = '<ul class="stop-list">';
  var coords = []; // 地図上の路線描画用の座標リスト

  stopTimes.forEach(function (st) {
    var stop = stopMap[st.stop_id];
    var stopName = stop ? stop.stop_name || "--" : "--";
    var timeDisp = st.arrival_time ? st.arrival_time.substring(0, 5) : "--";

    // 現在地（クリックされたバス停）をハイライトする
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

    // 路線描画用の座標を追加する
    if (stop) {
      var lat = parseFloat(stop.stop_lat);
      var lng = parseFloat(stop.stop_lon);
      if (!isNaN(lat) && !isNaN(lng)) {
        coords.push([lat, lng]);
      }
    }
  });

  html += "</ul>";
  body.innerHTML = html;

  // -------------------------------------------------------
  // 地図上に路線を描画する
  // 前の路線が表示されている場合は削除してから描画する
  // -------------------------------------------------------
  if (currentTripLine) {
    map.removeLayer(currentTripLine);
    currentTripLine = null;
  }

  if (coords.length >= 2) {
    currentTripLine = L.polyline(coords, {
      color: "#2c7be5", // 青色で路線を描画する
      weight: 4, // 線の太さ
      opacity: 0.8, // 透明度
    }).addTo(map);

    // 路線全体が見えるように地図の表示範囲を調整する
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
    // バス停パネルを閉じたら便情報パネルと路線も閉じる
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
    // 地図上の路線も消す
    if (currentTripLine) {
      map.removeLayer(currentTripLine);
      currentTripLine = null;
    }
  });

// ============================================================
// 初期化処理
// ページ読み込み時に静的GTFSデータを読み込んで地図に表示する
// ============================================================
async function initGtfs() {
  console.log("[GTFS] 静的データ読み込み開始");
  setStatus("loading", "データ読み込み中...");

  try {
    // -------------------------------------------------------
    // 6つのCSVファイルを並行して読み込む
    // Promise.all で全て完了するまで待つ
    // stop_times.txt はデータ量が多いため時間がかかる場合がある
    // -------------------------------------------------------
    var results = await Promise.all([
      loadCsv(STATIC_BASE + "stops.txt"),
      loadCsv(STATIC_BASE + "stop_times.txt"),
      loadCsv(STATIC_BASE + "trips.txt"),
      loadCsv(STATIC_BASE + "routes.txt"),
      loadCsv(STATIC_BASE + "calendar.txt"),
      loadCsv(STATIC_BASE + "calendar_dates.txt"),
    ]);

    // 読み込んだデータをグローバル変数に格納する
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

    // 当日の運行サービスIDを計算する
    calcActiveServiceIds();

    // バス停を地図上に表示する
    renderStops();

    setStatus("ok", "データ読み込み完了");
    console.log("[GTFS] 初期化完了");
  } catch (err) {
    setStatus("error", "データ読み込みエラー");
    console.error("[GTFS] 初期化失敗:", err);
  }
}

// -------------------------------------------------------
// リアルタイムデータを取得する
// -------------------------------------------------------
fetchVehiclePositions();

// -------------------------------------------------------
// 更新ボタンを押したときにリアルタイムデータを再取得する
// -------------------------------------------------------
document
  .getElementById("refresh-btn")
  .addEventListener("click", fetchVehiclePositions);

// -------------------------------------------------------
// ページ読み込み時に静的GTFSデータの初期化を実行する
// -------------------------------------------------------
initGtfs();
