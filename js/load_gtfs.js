// ============================================================
//  広島県バス協会 GTFSリアルタイム バス位置情報ローダー
//  データは api.codetabs.com 経由で直接取得する
// ============================================================

const VEHICLE_POSITION_URL =
  "./data/hdnishihiroshima/realtime/vehicle_position.bin";
const REFRESH_INTERVAL_MS = 120000;

// Minimal GTFS-Realtime proto definition
const GTFS_RT_PROTO = `
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
  optional OccupancyStatus occupancy_status = 9;
  enum OccupancyStatus {
    EMPTY = 0;
    MANY_SEATS_AVAILABLE = 1;
    FEW_SEATS_AVAILABLE = 2;
    STANDING_ROOM_ONLY = 3;
    CRUSHED_STANDING_ROOM_ONLY = 4;
    FULL = 5;
    NOT_ACCEPTING_PASSENGERS = 6;
  }
}
message TripDescriptor {
  optional string trip_id = 1;
  optional string route_id = 5;
}
message VehicleDescriptor {
  optional string id = 1;
  optional string label = 2;
  optional string license_plate = 3;
}
message Position {
  required float latitude  = 1;
  required float longitude = 2;
  optional float bearing   = 3;
  optional double odometer = 4;
  optional float speed     = 5;
}
`;

// -------------------------------------------------------
// Leaflet マップ初期化
// 広島市中心部を初期表示位置に設定する
// -------------------------------------------------------
const map = L.map("map").setView([34.3853, 132.4553], 12);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

// バスマーカーを管理するMap（vehicle_id → Leafletマーカー）
const busMarkers = new Map();

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
// バス台数と取得時刻・データ時刻を表示する
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
// protobufjs を使ってGTFSリアルタイムバイナリをデコードする
// Protocol Buffers形式のバイナリを JavaScript オブジェクトに変換する
// -------------------------------------------------------
async function decodeFeedMessage(buffer) {
  var root = await protobuf.parse(GTFS_RT_PROTO, { keepCase: true }).root;
  var FeedMessage = root.lookupType("transit_realtime.FeedMessage");
  return FeedMessage.decode(new Uint8Array(buffer));
}

async function fetchVehiclePositions() {
  setStatus("loading", "loading...");

  // -------------------------------------------------------
  // GitHub Actionsが定期取得したキャッシュファイルを読み込む
  // ?t=Date.now() でブラウザキャッシュを完全に回避する
  // Pragma と Cache-Control ヘッダーも付与して
  // GitHub Pages のCDNキャッシュも回避する
  // -------------------------------------------------------
  try {
    var url =
      "./data/hdnishihiroshima/realtime/vehicle_position.bin" +
      "?t=" +
      Date.now();

    var res = await fetch(url, {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
      },
    });

    if (!res.ok) {
      throw new Error("HTTP " + res.status);
    }

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
    var routeId = (vp.trip && vp.trip.route_id) || "--";
    var tripId = (vp.trip && vp.trip.trip_id) || "--";
    var ts = vp.timestamp
      ? new Date(Number(vp.timestamp) * 1000).toLocaleTimeString("ja-JP")
      : "--";
    var speedKmh = speed != null ? (speed * 3.6).toFixed(1) + " km/h" : "--";

    var popupHtml =
      '<div style="min-width:160px;font-size:13px;line-height:1.7">' +
      "<b>Vehicle ID:</b> " +
      label +
      "<br>" +
      "<b>Route ID:</b> " +
      routeId +
      "<br>" +
      "<b>Trip ID:</b> " +
      tripId +
      "<br>" +
      "<b>Speed:</b> " +
      speedKmh +
      "<br>" +
      "<b>Time:</b> " +
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
  console.log("[GTFS-RT] " + activeIds.size + " 台を描画");
}

// -------------------------------------------------------
// ページ読み込み時に即座にデータを取得する
// その後は自動更新なし（更新ボタンで手動更新）
// -------------------------------------------------------
fetchVehiclePositions();

// -------------------------------------------------------
// 更新ボタンを押したときにデータを再取得する
// -------------------------------------------------------
document
  .getElementById("refresh-btn")
  .addEventListener("click", fetchVehiclePositions);
