// ============================================================
// load_gtfs.js
// 広島県バス協会 GTFSデータ表示システム
//
// 【機能】
//   1. 複数事業者を同時選択してバス停を地図上に表示
//   2. バス停クリックで時刻表パネルを表示（stop_times.txt）
//   3. 時刻クリックで便情報パネルと路線を地図表示
//   4. 当日の運行日（平日・土曜・日曜・祝日）を自動判定
//   5. 選択中の全事業者のリアルタイムバス位置を表示
// ============================================================

// -------------------------------------------------------
// 事業者リスト
// folder      ... data/以下のフォルダ名
// name        ... ドロワーに表示する名称
// realtimeId  ... リアルタイムAPIの事業者ID（Mobistaシステム）
// color       ... バス停マーカーの色
// hasRealtime ... false の場合リアルタイムデータなし
// -------------------------------------------------------
var OPERATORS = [
  { folder: "hiroden", name: "広島電鉄", realtimeId: "8", color: "#4a7c2f" },
  {
    folder: "hiroshimabus",
    name: "広島バス",
    realtimeId: "9",
    color: "#cc0000",
  },
  { folder: "hirokotsu", name: "広島交通", realtimeId: "10", color: "#e8a000" },
  { folder: "geiyo", name: "芸陽バス", realtimeId: "11", color: "#f39800" },
  { folder: "bihoku", name: "備北交通", realtimeId: "12", color: "#00a050" },
  {
    folder: "hdnishihiroshima",
    name: "HD西広島",
    realtimeId: "13",
    color: "#6ab04c",
  },
  { folder: "fouble", name: "フォーブル", realtimeId: "14", color: "#8b4513" },
  { folder: "jrbus", name: "JRバス中国", realtimeId: "15", color: "#003087" },
  {
    folder: "sasaki",
    name: "ささき観光(ハートバス)",
    realtimeId: "17",
    color: "#9b59b6",
  },
  {
    folder: "kurebus",
    name: "呉市生活バス",
    realtimeId: "18",
    color: "#00b4d8",
  },
  {
    folder: "hatsukaichi",
    name: "廿日市市自主運行",
    realtimeId: "19",
    color: "#2ecc71",
  },
  {
    folder: "onomichi",
    name: "おのみちバス",
    realtimeId: "53",
    color: "#e67e22",
  },
  {
    folder: "asahi",
    name: "朝日交通(阿戸線)",
    realtimeId: "54",
    color: "#f1c40f",
  },
  // -------------------------------------------------------
  // 以下4社は両備システムズ・タウンクリエーションのシステム
  // realtimeId は使用しない（folderから直接パスを構築する）
  // -------------------------------------------------------
  {
    folder: "chugokubus",
    name: "中国バス",
    realtimeId: null,
    color: "#c0392b",
  },
  { folder: "tomotetsu", name: "鞆鉄道", realtimeId: null, color: "#27ae60" },
  {
    folder: "ikasabus",
    name: "井笠バスカンパニー",
    realtimeId: null,
    color: "#8e44ad",
  },
  {
    folder: "etajima",
    name: "江田島バス",
    realtimeId: null,
    color: "#2980b9",
    hasRealtime: false,
  },
];

// -------------------------------------------------------
// 現在選択中の事業者セット（複数選択対応）
// バス停クリック時にどの事業者のデータを使うかを currentOperator で管理する
// -------------------------------------------------------
var selectedOperators = new Set(["hdnishihiroshima"]);

// バス停クリック時に時刻表・運賃表示に使う事業者
var currentOperator = OPERATORS.find(function (o) {
  return o.folder === "hdnishihiroshima";
});

// -------------------------------------------------------
// 事業者ごとの静的データキャッシュ
// Map<folder, {stops, stopTimes, trips, routes,
//              calendar, calendarDates, fareAttrs, fareRules, shapes}>
// -------------------------------------------------------
var operatorDataCache = new Map();

// -------------------------------------------------------
// 事業者ごとのバス停マーカー
// Map<folder, Leafletマーカー配列>
// -------------------------------------------------------
var stopMarkersByOperator = new Map();

// -------------------------------------------------------
// 事業者ごとのリアルタイムバスマーカー
// Map<folder, Map<vehicleId, Leafletマーカー>>
// -------------------------------------------------------
var busMarkersByOperator = new Map();

// 地図上に描画した路線ライン（別の便選択時に削除するために保持する）
var currentTripLine = null;

// リアルタイムバスの表示・非表示フラグ
var busVisible = true;

// -------------------------------------------------------
// Leaflet マップ初期化（広島市中心部）
// -------------------------------------------------------
var map = L.map("map").setView([34.3853, 132.4553], 13);

// 国土地理院地図（淡色地図）
// 日本の地図として最も正確で、色が薄く見やすい
L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", {
  attribution:
    '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
  maxZoom: 21,
}).addTo(map);

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
// state: 'loading'（黄色点滅）/ 'ok'（緑）/ 'error'（赤）
// -------------------------------------------------------
function setStatus(state, text) {
  var dot = document.getElementById("status-dot");
  var label = document.getElementById("status-text");
  dot.className = state;
  label.textContent = text;
}

// -------------------------------------------------------
// フッターのバス台数を全事業者の合計で更新する
// -------------------------------------------------------
function updateInfoPanelTotal() {
  var total = 0;
  busMarkersByOperator.forEach(function (markers) {
    total += markers.size;
  });
  document.getElementById("bus-count").textContent = total;
  var now = new Date().toLocaleTimeString("ja-JP");
  document.getElementById("last-updated").textContent = "取得: " + now;
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
// 指定した事業者のリアルタイムデータを取得して地図に描画する
// -------------------------------------------------------
async function fetchVehiclePositionsForOperator(op) {
  // リアルタイムデータがない事業者はスキップする
  if (op.hasRealtime === false) return;

  try {
    var url =
      "./data/" + op.folder + "/realtime/vehicle_position.bin?t=" + Date.now();
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
    renderVehiclesForOperator(
      op,
      feed.entity || [],
      feed.header && feed.header.timestamp,
    );
  } catch (err) {
    console.warn("[GTFS-RT] " + op.name + " 取得失敗:", err.message);
  }
}

// -------------------------------------------------------
// 選択中の全事業者のリアルタイムデータを更新する
// 更新ボタン押下時・定期更新時に呼び出す
// -------------------------------------------------------
async function fetchAllVehiclePositions() {
  setStatus("loading", "loading...");
  for (var i = 0; i < OPERATORS.length; i++) {
    var op = OPERATORS[i];
    if (!selectedOperators.has(op.folder)) continue;
    await fetchVehiclePositionsForOperator(op);
  }
  setStatus("ok", "updated");
  updateInfoPanelTotal();
}

// -------------------------------------------------------
// 指定した事業者のバスマーカーを地図上に描画する
// 前回から消えた車両のマーカーは削除する
// -------------------------------------------------------
function renderVehiclesForOperator(op, entities, feedTimestamp) {
  var folder = op.folder;

  // この事業者のバスマーカーMapを取得または作成する
  if (!busMarkersByOperator.has(folder)) {
    busMarkersByOperator.set(folder, new Map());
  }
  var markers = busMarkersByOperator.get(folder);
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
      "<b>" +
      op.name +
      "</b><br>" +
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

    if (markers.has(vehicleId)) {
      var marker = markers.get(vehicleId);
      marker.setLatLng([lat, lng]);
      marker.setIcon(createBusIcon(bearing));
      marker.getPopup().setContent(popupHtml);
      // busVisible フラグに応じて表示・非表示を切り替える
      if (busVisible) {
        marker.addTo(map);
      } else {
        map.removeLayer(marker);
      }
    } else {
      var newMarker = L.marker([lat, lng], {
        icon: createBusIcon(bearing),
      }).bindPopup(popupHtml);
      if (busVisible) newMarker.addTo(map);
      markers.set(vehicleId, newMarker);
    }
  }

  // 前回のデータに存在したが今回ないバスのマーカーを削除する
  markers.forEach(function (marker, id) {
    if (!activeIds.has(id)) {
      map.removeLayer(marker);
      markers.delete(id);
    }
  });
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
// オプションのCSVファイルを読み込む
// ファイルが存在しない場合はエラーにせず空配列を返す
// shapes.txt・fare_attributes.txt など事業者によって
// 存在しない場合があるファイルに使用する
// -------------------------------------------------------
function loadCsvOptional(path) {
  return loadCsv(path).catch(function () {
    console.log("[GTFS] オプションファイルなし（スキップ）: " + path);
    return [];
  });
}

// -------------------------------------------------------
// 今日の日付をYYYYMMDD形式で返す
// calendar.txt の start_date/end_date と比較するために使用する
// -------------------------------------------------------
function getTodayStr() {
  var d = new Date();
  var yyyy = d.getFullYear();
  var mm = String(d.getMonth() + 1).padStart(2, "0");
  var dd = String(d.getDate()).padStart(2, "0");
  return yyyy + mm + dd;
}

// -------------------------------------------------------
// 今日が何曜日かを calendar.txt の列名形式で返す
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
// calendar・calendarDates から今日の運行サービスIDセットを返す
// calendar_dates.txt の例外を優先して適用する
// -------------------------------------------------------
function calcServiceIds(calendar, calendarDates) {
  var serviceIds = new Set();
  var todayStr = getTodayStr();
  var todayDay = getTodayDayName();
  var addedByException = new Set();
  var removedByException = new Set();

  calendarDates.forEach(function (row) {
    if (row.date === todayStr) {
      if (row.exception_type === "1") {
        addedByException.add(row.service_id);
      } else if (row.exception_type === "2") {
        removedByException.add(row.service_id);
      }
    }
  });

  calendar.forEach(function (row) {
    if (row.start_date <= todayStr && todayStr <= row.end_date) {
      if (row[todayDay] === "1" && !removedByException.has(row.service_id)) {
        serviceIds.add(row.service_id);
      }
    }
  });

  addedByException.forEach(function (sid) {
    serviceIds.add(sid);
  });

  console.log(
    "[GTFS] 今日のサービスID数:",
    serviceIds.size,
    Array.from(serviceIds),
  );
  return serviceIds;
}

// -------------------------------------------------------
// shapes データから shape_id → 座標配列 の Map を構築する
// -------------------------------------------------------
function buildShapesMap(shapesData) {
  var shapeTemp = {};
  shapesData.forEach(function (row) {
    var shapeId = row.shape_id;
    if (!shapeId) return;
    if (!shapeTemp[shapeId]) shapeTemp[shapeId] = [];
    shapeTemp[shapeId].push({
      seq: parseInt(row.shape_pt_sequence),
      lat: parseFloat(row.shape_pt_lat),
      lng: parseFloat(row.shape_pt_lon),
    });
  });
  var shapesMap = new Map();
  Object.keys(shapeTemp).forEach(function (shapeId) {
    var points = shapeTemp[shapeId];
    points.sort(function (a, b) {
      return a.seq - b.seq;
    });
    shapesMap.set(
      shapeId,
      points.map(function (p) {
        return [p.lat, p.lng];
      }),
    );
  });
  return shapesMap;
}

// -------------------------------------------------------
// fare_attributes・fare_rules から運賃インデックスを構築する
// キー: "route_id→origin_id→destination_id"
// 値: 運賃（円）
// -------------------------------------------------------
function buildFareIndexForData(fareAttrs, fareRules) {
  var index = new Map();
  var attrMap = {};
  fareAttrs.forEach(function (row) {
    attrMap[row.fare_id] = parseInt(row.price);
  });
  fareRules.forEach(function (row) {
    var price = attrMap[row.fare_id];
    if (price == null) return;
    var key = row.route_id + "→" + row.origin_id + "→" + row.destination_id;
    index.set(key, price);
  });
  return index;
}

// -------------------------------------------------------
// 乗車バス停から降車バス停までの運賃を検索する
//
// 引数:
//   fareIdx           ... 事業者ごとの運賃インデックス
//   routeId           ... 路線ID（trip.route_id）
//   originZoneId      ... 乗車バス停の zone_id
//   destinationZoneId ... 降車バス停の zone_id
//
// 戻り値: 運賃（円）または null（データなし）
// -------------------------------------------------------
function getFare(fareIdx, routeId, originZoneId, destinationZoneId) {
  if (originZoneId === destinationZoneId) return null;
  var key = routeId + "→" + originZoneId + "→" + destinationZoneId;
  var price = fareIdx.get(key);
  return price != null ? price : null;
}

// -------------------------------------------------------
// バス停マーカーのアイコンを生成する
// 事業者カラーを使用する
// -------------------------------------------------------
function createStopIcon(color) {
  var c = color || "#2c7be5";
  var svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">' +
    '<circle cx="7" cy="7" r="6" fill="' +
    c +
    '" stroke="white" stroke-width="1.5"/>' +
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
// 指定した事業者のバス停マーカーを全て地図から削除する
// folder が null の場合は全事業者を削除する
// -------------------------------------------------------
function clearStopMarkers(folder) {
  if (folder) {
    var markers = stopMarkersByOperator.get(folder) || [];
    markers.forEach(function (m) {
      map.removeLayer(m);
    });
    stopMarkersByOperator.delete(folder);
  } else {
    stopMarkersByOperator.forEach(function (markers) {
      markers.forEach(function (m) {
        map.removeLayer(m);
      });
    });
    stopMarkersByOperator.clear();
  }
}

// -------------------------------------------------------
// 指定した事業者のバス停を地図上に描画する
// バス停クリック時にその事業者を currentOperator にセットする
// -------------------------------------------------------
function renderStops(op, stops) {
  clearStopMarkers(op.folder);
  var markers = [];

  stops.forEach(function (stop) {
    var lat = parseFloat(stop.stop_lat);
    var lng = parseFloat(stop.stop_lon);
    if (isNaN(lat) || isNaN(lng)) return;

    var stopId = stop.stop_id;
    var stopName = stop.stop_name || "不明";

    var marker = L.marker([lat, lng], {
      icon: createStopIcon(op.color),
    });

    marker.on("click", function () {
      // クリックされたバス停の事業者を currentOperator にセットする
      currentOperator = op;
      showStopPanel(stopId, stopName);
    });

    marker.addTo(map);
    markers.push(marker);
  });

  stopMarkersByOperator.set(op.folder, markers);
  console.log("[GTFS] " + op.name + " バス停描画完了:", markers.length, "件");
}

// -------------------------------------------------------
// バス停情報パネルを表示する
// currentOperator のキャッシュデータを使用する
// -------------------------------------------------------
function showStopPanel(stopId, stopName) {
  document.getElementById("stop-panel-title").textContent = stopName;
  var body = document.getElementById("stop-panel-body");
  body.innerHTML = '<p class="loading-msg">時刻表を読み込み中...</p>';
  document.getElementById("stop-panel").classList.add("visible");

  // currentOperator のキャッシュデータを取得する
  var data = operatorDataCache.get(currentOperator.folder);
  if (!data) {
    body.innerHTML = '<p class="loading-msg">データがありません</p>';
    return;
  }

  // 今日の運行サービスIDを計算する
  var activeIds = calcServiceIds(data.calendar, data.calendarDates);

  var tripMap = {};
  data.trips.forEach(function (t) {
    tripMap[t.trip_id] = t;
  });
  var routeMap = {};
  data.routes.forEach(function (r) {
    routeMap[r.route_id] = r;
  });

  // このバス停に停車する当日の便を抽出する
  var rows = [];
  data.stopTimes.forEach(function (st) {
    if (st.stop_id !== stopId) return;
    // pickup_type=1 は降車専用（終点）のため除外する
    if (st.pickup_type === "1") return;
    var trip = tripMap[st.trip_id];
    if (!trip) return;
    if (!activeIds.has(trip.service_id)) return;
    var route = routeMap[trip.route_id] || {};
    rows.push({
      time: st.arrival_time,
      routeNo: route.route_short_name || "--",
      headsign: st.stop_headsign || trip.trip_headsign || "--",
      tripId: st.trip_id,
      stopId: stopId,
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
// currentOperator のキャッシュデータを使用する
// -------------------------------------------------------
function showTripPanel(tripId, currentStopId) {
  // currentOperator のキャッシュデータを取得する
  var data = operatorDataCache.get(currentOperator.folder);
  if (!data) return;

  var trip = data.trips.find(function (t) {
    return t.trip_id === tripId;
  });
  var headsign = trip ? trip.trip_headsign || "--" : "--";
  document.getElementById("trip-panel-title").textContent = "行先: " + headsign;

  var body = document.getElementById("trip-panel-body");
  body.innerHTML = '<p class="loading-msg">便情報を読み込み中...</p>';
  document.getElementById("trip-panel").classList.add("visible");

  // この便の全停留所を stop_sequence 順に抽出する
  var stopTimes = data.stopTimes.filter(function (st) {
    return st.trip_id === tripId;
  });
  stopTimes.sort(function (a, b) {
    return parseInt(a.stop_sequence) - parseInt(b.stop_sequence);
  });

  // stops.txt をインデックス化する
  var stopMap = {};
  data.stops.forEach(function (s) {
    stopMap[s.stop_id] = s;
  });

  // 乗車バス停の zone_id を取得する（運賃計算の起点）
  var originStop = stopMap[currentStopId];
  var originZoneId = originStop ? originStop.zone_id : null;

  // trip の route_id を取得する（運賃検索に必要）
  var routeId = trip ? trip.route_id : null;

  // 事業者ごとの運賃インデックスを構築する
  var fareIdx = buildFareIndexForData(data.fareAttrs, data.fareRules);

  var html = '<ul class="stop-list">';
  var coords = [];

  stopTimes.forEach(function (st) {
    var stop = stopMap[st.stop_id];
    var stopName = stop ? stop.stop_name || "--" : "--";
    var timeDisp = st.arrival_time ? st.arrival_time.substring(0, 5) : "--";
    var isCurrent = st.stop_id === currentStopId;
    var liClass = isCurrent ? ' class="current-stop"' : "";

    // 運賃を検索して表示文字列を決める
    var fareDisp = "--";
    if (stop && originZoneId && routeId) {
      if (isCurrent) {
        fareDisp = "乗車";
      } else {
        var price = getFare(fareIdx, routeId, originZoneId, stop.zone_id);
        if (price != null) fareDisp = price + "円";
      }
    }

    html +=
      "<li" +
      liClass +
      ">" +
      '<span class="stop-time">' +
      timeDisp +
      "</span>" +
      '<span class="stop-name">' +
      stopName +
      "</span>" +
      '<span class="stop-fare">' +
      fareDisp +
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

  // shapes.txt がある場合はそれを使う（なければバス停を繋ぐ）
  var shapeCoords = null;
  if (trip && trip.shape_id) {
    var shapeId = trip.shape_id.trim();
    var shapesMap = buildShapesMap(data.shapes);
    shapeCoords = shapesMap.get(shapeId) || null;
    if (shapeCoords) {
      console.log(
        "[GTFS] shapes使用: " + shapeId + " (" + shapeCoords.length + "点)",
      );
    } else {
      console.log("[GTFS] shape_id未発見: " + shapeId + " → バス停接続で代替");
    }
  }

  var lineCoords = shapeCoords || coords;
  if (lineCoords.length >= 2) {
    currentTripLine = L.polyline(lineCoords, {
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
// 指定した事業者の静的データを読み込んで地図に表示する
// ============================================================
async function loadOperator(op) {
  var base = "./data/" + op.folder + "/static/";
  console.log("[GTFS] 静的データ読み込み開始:", op.name);

  try {
    var results = await Promise.all([
      loadCsv(base + "stops.txt"),
      loadCsv(base + "stop_times.txt"),
      loadCsv(base + "trips.txt"),
      loadCsv(base + "routes.txt"),
      loadCsv(base + "calendar.txt"),
      loadCsvOptional(base + "calendar_dates.txt"),
      loadCsvOptional(base + "shapes.txt"),
      loadCsvOptional(base + "fare_attributes.txt"),
      loadCsvOptional(base + "fare_rules.txt"),
    ]);

    // 事業者ごとのデータをキャッシュに格納する
    var data = {
      stops: results[0],
      stopTimes: results[1],
      trips: results[2],
      routes: results[3],
      calendar: results[4],
      calendarDates: results[5],
      shapes: results[6],
      fareAttrs: results[7],
      fareRules: results[8],
    };
    operatorDataCache.set(op.folder, data);

    console.log(
      "[GTFS] " + op.name + " 読み込み完了:",
      data.stops.length,
      "バス停",
      data.stopTimes.length,
      "時刻",
      data.fareRules.length,
      "運賃ルール",
    );

    // バス停を地図上に描画する
    renderStops(op, data.stops);

    // リアルタイムデータを取得する
    await fetchVehiclePositionsForOperator(op);
  } catch (err) {
    console.error("[GTFS] " + op.name + " 読み込み失敗:", err);
  }
}

// ============================================================
// 事業者選択ドロワーの初期化
// ============================================================
function initOperatorDrawer() {
  var drawer = document.getElementById("operator-drawer");
  var toggleBtn = document.getElementById("operator-toggle-btn");
  var checkboxContainer = document.getElementById("operator-checkboxes");
  var selectedCountEl = document.getElementById("selected-count");

  // -------------------------------------------------------
  // 事業者ごとのチェックボックスを動的に生成する
  // -------------------------------------------------------
  OPERATORS.forEach(function (op) {
    var item = document.createElement("label");
    item.className = "operator-checkbox-item";

    var checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = op.folder;
    checkbox.checked = selectedOperators.has(op.folder);

    // 事業者カラーのドット
    var dot = document.createElement("span");
    dot.className = "operator-color-dot";
    dot.style.background = op.color;

    var name = document.createTextNode(op.name);

    item.appendChild(checkbox);
    item.appendChild(dot);
    item.appendChild(name);
    checkboxContainer.appendChild(item);

    // チェックボックス変更時の処理
    checkbox.addEventListener("change", function () {
      if (checkbox.checked) {
        // 事業者を追加して静的データを読み込む
        selectedOperators.add(op.folder);
        loadOperator(op);
      } else {
        // 事業者を削除してマーカーを消す
        selectedOperators.delete(op.folder);
        clearStopMarkers(op.folder);
        // バスマーカーも削除する
        var bm = busMarkersByOperator.get(op.folder);
        if (bm) {
          bm.forEach(function (marker) {
            map.removeLayer(marker);
          });
          busMarkersByOperator.delete(op.folder);
        }
        // キャッシュも削除する
        operatorDataCache.delete(op.folder);
      }
      updateSelectedCount();
      updateInfoPanelTotal();
    });
  });

  // -------------------------------------------------------
  // ドロワーの開閉処理
  // -------------------------------------------------------
  toggleBtn.addEventListener("click", function () {
    drawer.classList.toggle("open");
    toggleBtn.textContent = drawer.classList.contains("open")
      ? "🏢 事業者選択 ▲"
      : "🏢 事業者選択 ▼";
  });

  // ドロワー外をクリックしたら閉じる
  document.addEventListener("click", function (e) {
    if (!drawer.contains(e.target) && e.target !== toggleBtn) {
      drawer.classList.remove("open");
      toggleBtn.textContent = "🏢 事業者選択 ▼";
    }
  });

  // -------------------------------------------------------
  // 全選択ボタン
  // -------------------------------------------------------
  document
    .getElementById("select-all-btn")
    .addEventListener("click", function () {
      checkboxContainer
        .querySelectorAll("input[type=checkbox]")
        .forEach(function (cb) {
          if (!cb.checked) {
            cb.checked = true;
            var op = OPERATORS.find(function (o) {
              return o.folder === cb.value;
            });
            selectedOperators.add(cb.value);
            loadOperator(op);
          }
        });
      updateSelectedCount();
    });

  // -------------------------------------------------------
  // 全解除ボタン
  // -------------------------------------------------------
  document
    .getElementById("deselect-all-btn")
    .addEventListener("click", function () {
      checkboxContainer
        .querySelectorAll("input[type=checkbox]")
        .forEach(function (cb) {
          cb.checked = false;
          selectedOperators.delete(cb.value);
          clearStopMarkers(cb.value);
          var bm = busMarkersByOperator.get(cb.value);
          if (bm) {
            bm.forEach(function (marker) {
              map.removeLayer(marker);
            });
            busMarkersByOperator.delete(cb.value);
          }
          operatorDataCache.delete(cb.value);
        });
      updateSelectedCount();
      updateInfoPanelTotal();
    });

  // -------------------------------------------------------
  // 選択中の事業者数を更新する
  // -------------------------------------------------------
  function updateSelectedCount() {
    selectedCountEl.textContent = selectedOperators.size + "社選択中";
  }
  updateSelectedCount();
}

// -------------------------------------------------------
// リアルタイムバスの表示・非表示を切り替える
// ボタンを押すたびに表示状態がトグルする
// -------------------------------------------------------
document
  .getElementById("toggle-bus-btn")
  .addEventListener("click", function () {
    busVisible = !busVisible;

    // 全事業者のバスマーカーを一括で表示・非表示にする
    busMarkersByOperator.forEach(function (markers) {
      markers.forEach(function (marker) {
        if (busVisible) {
          marker.addTo(map);
        } else {
          map.removeLayer(marker);
        }
      });
    });

    document.getElementById("toggle-bus-btn").textContent = busVisible
      ? "🚌 非表示"
      : "🚌 表示";
  });

// ============================================================
// パネルの操作機能を設定する
//
// PC（幅769px以上）の場合:
//   ヘッダーをドラッグしてパネルを画面上で移動できる
//
// スマホ（幅768px以下）の場合:
//   ヘッダーをドラッグしてパネルの高さを変更できる
//   上ドラッグ → 高さ増加（最大80vh）
//   下ドラッグ → 高さ減少（最小15vh）
//   デフォルト: 40vh
// ============================================================
function initPanelControl(panelId, headerId) {
  var panel = document.getElementById(panelId);
  var header = document.getElementById(headerId);

  var isDragging = false;
  var startX = 0,
    startY = 0;
  var startLeft = 0,
    startTop = 0,
    startH = 0;

  var winH = window.innerHeight;
  var MAX_H = winH * 0.8;
  var MIN_H = winH * 0.15;

  function onStart(clientX, clientY) {
    isDragging = true;
    startX = clientX;
    startY = clientY;
    panel.style.transition = "none";

    if (window.innerWidth > 768) {
      var rect = panel.getBoundingClientRect();
      panel.style.position = "fixed";
      panel.style.right = "auto";
      panel.style.top = rect.top + "px";
      panel.style.left = rect.left + "px";
      startLeft = rect.left;
      startTop = rect.top;
    } else {
      startH = panel.getBoundingClientRect().height;
    }
  }

  function onMove(clientX, clientY) {
    if (!isDragging) return;
    var dx = clientX - startX;
    var dy = clientY - startY;

    if (window.innerWidth > 768) {
      panel.style.left = startLeft + dx + "px";
      panel.style.top = startTop + dy + "px";
    } else {
      var newH = Math.max(MIN_H, Math.min(MAX_H, startH - dy));
      panel.style.height = newH + "px";
    }
  }

  function onEnd() {
    if (!isDragging) return;
    isDragging = false;
    panel.style.transition = "transform 0.3s ease";
  }

  header.addEventListener("mousedown", function (e) {
    if (e.target.tagName === "BUTTON") return;
    onStart(e.clientX, e.clientY);
    e.preventDefault();
  });
  document.addEventListener("mousemove", function (e) {
    onMove(e.clientX, e.clientY);
  });
  document.addEventListener("mouseup", onEnd);

  header.addEventListener(
    "touchstart",
    function (e) {
      if (e.target.tagName === "BUTTON") return;
      onStart(e.touches[0].clientX, e.touches[0].clientY);
      e.preventDefault();
    },
    { passive: false },
  );
  document.addEventListener(
    "touchmove",
    function (e) {
      if (!isDragging) return;
      onMove(e.touches[0].clientX, e.touches[0].clientY);
      e.preventDefault();
    },
    { passive: false },
  );
  document.addEventListener("touchend", onEnd);
}

// -------------------------------------------------------
// バス停パネルと便情報パネルに操作機能を設定する
// -------------------------------------------------------
initPanelControl("stop-panel", "stop-panel-header");
initPanelControl("trip-panel", "trip-panel-header");

// ============================================================
// 起動処理（1回だけ実行する）
// ============================================================

// 事業者選択ドロワーを初期化する
initOperatorDrawer();

// 初期選択事業者（HD西広島）のデータを読み込む
var initialOp = OPERATORS.find(function (o) {
  return o.folder === "hdnishihiroshima";
});
loadOperator(initialOp);

// 更新ボタンで全選択事業者のリアルタイムデータを更新する
document
  .getElementById("refresh-btn")
  .addEventListener("click", fetchAllVehiclePositions);
