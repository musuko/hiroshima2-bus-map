// ============================================================
//  広島県バス協会 GTFSリアルタイム バス位置情報ローダー
//  データは GitHub Actions が定期取得して /data/ に配置
// ============================================================

// 同一オリジンから取得（CORSなし）
const VEHICLE_POSITION_URL = "./data/vehicle_position.bin";

// 自動更新間隔 (ms) - Actionsが2分ごとなので2分に合わせる
const REFRESH_INTERVAL_MS = 120_000;

// ----- GTFS-Realtime proto 定義（最小限） -----
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

// ----- Leaflet マップ初期化 -----
const map = L.map("map").setView([34.3853, 132.4553], 12);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution:
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

const busMarkers = new Map();

// ---- カスタムバスアイコン ----
function createBusIcon(bearing) {
  const rot = bearing != null ? bearing : 0;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <g transform="rotate(${rot},16,16)">
        <circle cx="16" cy="16" r="14" fill="#1a6b3c" stroke="white" stroke-width="2"/>
        <text x="16" y="21" text-anchor="middle" font-size="16" fill="white">🚌</text>
      </g>
    </svg>`;
  return L.divIcon({
    html: svg,
    className: "",
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -18],
  });
}

// ---- UI ヘルパー ----
function setStatus(state, text) {
  const dot = document.getElementById("status-dot");
  const label = document.getElementById("status-text");
  dot.className = state;
  label.textContent = text;
}

function updateInfoPanel(count, feedTimestamp) {
  document.getElementById("bus-count").textContent = count;
  const fetchedAt = new Date().toLocaleTimeString("ja-JP");
  const dataTime = feedTimestamp
    ? new Date(Number(feedTimestamp) * 1000).toLocaleTimeString("ja-JP")
    : "—";
  document.getElementById("last-updated").textContent =
    `取得: ${fetchedAt}　データ時刻: ${dataTime}`;
}

// ---- protobufjs でデコード ----
async function decodeFeedMessage(buffer) {
  const root = await protobuf.parse(GTFS_RT_PROTO, { keepCase: true }).root;
  const FeedMessage = root.lookupType("transit_realtime.FeedMessage");
  return FeedMessage.decode(new Uint8Array(buffer));
}

// ---- バイナリ取得 ----
async function fetchVehiclePositions() {
  setStatus("loading", "取得中…");
  try {
    // キャッシュバスターでブラウザキャッシュを回避
    const res = await fetch(
      `${VEHICLE_POSITION_URL}?t=${Date.now()}`,
      { cache: "no-store" }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    const feed = await decodeFeedMessage(buffer);
    renderVehicles(feed.entity || [], feed.header?.timestamp);
    setStatus("ok", "更新済み");
  } catch (err) {
    setStatus("error", `エラー: ${err.message}`);
    console.error("[GTFS-RT] 取得失敗:", err);
  }
}

// ---- マーカー描画 ----
function renderVehicles(entities, feedTimestamp) {
  const activeIds = new Set();

  for (const entity of entities) {
    const vp = entity.vehicle;
    if (!vp || !vp.position) continue;

    const { latitude, longitude, bearing, speed } = vp.position;
    if (!latitude || !longitude) continue;

    const vehicleId = vp.vehicle?.id || vp.vehicle?.label || entity.id || "unknown";
    const label     = vp.vehicle?.label || vehicleId;
    const routeId   = vp.trip?.route_id ?? "—";
    const tripId    = vp.trip?.trip_id  ?? "—";
    const ts        = vp.timestamp
      ? new Date(Number(vp.timestamp) * 1000).toLocaleTimeString("ja-JP")
      : "—";
    const speedKmh  = speed != null ? (speed * 3.6).toFixed(1) + " km/h" : "—";

    const popupHtml = `
      <div style="min-width:160px;font-size:13px;line-height:1.7">
        <b>🚌 車両ID:</b> ${label}<br>
        <b>路線ID:</b> ${routeId}<br>
        <b>便ID:</b>   ${tripId}<br>
        <b>速度:</b>   ${speedKmh}<br>
        <b>時刻:</b>   ${ts}
      </div>`;

    activeIds.add(vehicleId);

    if (busMarkers.has(vehicleId)) {
      const marker = busMarkers.get(vehicleId);
      marker.setLatLng([latitude, longitude]);
      marker.setIcon(createBusIcon(bearing));
      marker.getPopup().setContent(popupHtml);
    } else {
      const marker = L.marker([latitude, longitude], { icon: createBusIcon(bearing) })
        .bindPopup(popupHtml)
        .addTo(map);
      busMarkers.set(vehicleId, marker);
    }
  }

  // 消えた車両を削除
  for (const [id, marker] of busMarkers) {
    if (!activeIds.has(id)) {
      map.removeLayer(marker);
      busMarkers.delete(id);
    }
  }

  updateInfoPanel(activeIds.size, feedTimestamp);
  console.log(`[GTFS-RT] ${activeIds.size} 台を描画`);
}

// ---- 初期化 & 定期更新 ----
fetchVehiclePositions();
setInterval(fetchVehiclePositions, REFRESH_INTERVAL_MS);

document.getElementById("refresh-btn")
  .addEventListener("click", fetchVehiclePositions);
```

---

## 仕組みのまとめ
```
[GitHub Actions（2分ごと）]
    ↓ curl でサーバーサイドから直接取得（CORSなし）
[data/vehicle_position.bin をリポジトリにpush]
    ↓ GitHub Pages で配信
[ブラウザ] → ./data/vehicle_position.bin を同一オリジン取得 → 地図表示
