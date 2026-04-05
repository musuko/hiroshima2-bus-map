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

// ============================================================
// fetchVehiclePositions
// バス位置情報のリアルタイムデータを取得して地図に描画する。
//
// 【CORSとは】
// ブラウザには「異なるサーバーへの直接アクセスを制限する」
// セキュリティ機能（CORS: Cross-Origin Resource Sharing）がある。
// 例えば musuko.github.io のページから
// ajt-mobusta-gtfs.mcapps.jp に直接アクセスしようとすると、
// Mobistaサーバーが許可ヘッダーを返さないためブラウザがブロックする。
//
// 【api.codetabs.com とは】
// CORSを回避するための無料の「中継サービス」（プロキシ）。
// 仕組みは以下の通り：
//
//   ブラウザ
//     ↓ リクエスト（CORSなし・同一サービスへのアクセスなので問題なし）
//   api.codetabs.com（中継サーバー）
//     ↓ サーバー同士の通信（サーバーにはCORSの制限がない）
//   ajt-mobusta-gtfs.mcapps.jp（Mobistaサーバー）
//     ↓ バイナリデータを返す
//   api.codetabs.com
//     ↓ CORSヘッダーを付けてブラウザに転送
//   ブラウザ → データ受信成功
//
// つまり「ブラウザの代わりにサーバーがデータを取ってきてくれる」サービス。
// 無料で利用でき、登録不要。ただし将来的にサービス終了の可能性があるため、
// 失敗時はGitHub Actionsが取得したキャッシュファイルを代替として使う。
// ============================================================
async function fetchVehiclePositions() {
  // 読み込み中であることをヘッダーのステータス表示に反映する
  setStatus("loading", "loading...");

  // -------------------------------------------------------
  // 取得対象のリアルタイムデータURL
  // エイチ・ディー西広島株式会社（事業者ID: 13）の
  // バス位置情報（vehicle_position）バイナリファイル。
  // Mobistaシステムが15秒ごとに更新している。
  // -------------------------------------------------------
  var TARGET_URL =
    "https://ajt-mobusta-gtfs.mcapps.jp/realtime/13/vehicle_position.bin";

  // -------------------------------------------------------
  // CORSプロキシ経由のURL
  // api.codetabs.com にTARGET_URLを渡すと、
  // サーバー側で取得してCORSヘッダー付きで返してくれる。
  //
  // &t=Date.now() はキャッシュバスター。
  // これを付けないとブラウザが古いデータをキャッシュして
  // 再読み込みしても同じデータを使い回す可能性がある。
  // -------------------------------------------------------
  var PROXY_URL =
    "https://api.codetabs.com/v1/proxy?quest=" +
    encodeURIComponent(TARGET_URL) +
    "&t=" +
    Date.now();

  // 取得したバイナリデータを格納する変数
  // 取得失敗時は null のまま次の手段に移る
  var buffer = null;

  // -------------------------------------------------------
  // 第1手段: api.codetabs.com 経由で最新データを取得
  // ページを開いた時・更新ボタンを押した時に実行される。
  // 成功すれば常に最新のバス位置情報が得られる。
  // -------------------------------------------------------
  try {
    var res = await fetch(PROXY_URL, {
      // no-store: ブラウザキャッシュを完全に無効化する
      // これにより更新ボタンを押すたびに必ず新しいデータを取得する
      cache: "no-store",
    });

    if (res.ok) {
      // レスポンスをArrayBuffer（バイナリ）として読み込む
      // GTFSリアルタイムはProtocol Buffers形式のバイナリファイルのため
      buffer = await res.arrayBuffer();
      console.log("[GTFS-RT] プロキシ経由で取得成功");
    } else {
      throw new Error("HTTP " + res.status);
    }
  } catch (err) {
    // -------------------------------------------------------
    // 第2手段: GitHub Actionsが取得したキャッシュファイルを使用
    // api.codetabs.com が障害・サービス終了した場合の保険。
    // GitHub Actionsのスケジュールが不安定なため最新でない場合があるが、
    // 全く表示されないよりはましなため代替として使用する。
    // -------------------------------------------------------
    console.log("[GTFS-RT] プロキシ失敗、キャッシュを使用: " + err.message);

    try {
      var cacheRes = await fetch(
        "./data/hdnishihiroshima/realtime/vehicle_position.bin?t=" + Date.now(),
        { cache: "no-store" },
      );

      if (cacheRes.ok) {
        buffer = await cacheRes.arrayBuffer();
        console.log("[GTFS-RT] キャッシュから取得成功");
      } else {
        throw new Error("HTTP " + cacheRes.status);
      }
    } catch (e) {
      setStatus("error", "error: " + e.message);
      console.error("[GTFS-RT] 全取得方法失敗:", e);
      return;
    }
  }

  // -------------------------------------------------------
  // 取得したバイナリをProtocol Buffersでデコードして
  // 地図上にバスマーカーとして描画する
  // -------------------------------------------------------
  try {
    var feed = await decodeFeedMessage(buffer);
    renderVehicles(feed.entity || [], feed.header && feed.header.timestamp);
    setStatus("ok", "updated");
  } catch (err) {
    setStatus("error", "error: " + err.message);
    console.error("[GTFS-RT] デコード失敗:", err);
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
