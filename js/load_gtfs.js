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
  { folder: "hiroden",          name: "広島電鉄",             realtimeId: "8"  },
  { folder: "hiroshimabus",     name: "広島バス",             realtimeId: "9"  },
  { folder: "hirokotsu",        name: "広島交通",             realtimeId: "10" },
  { folder: "geiyo",            name: "芸陽バス",             realtimeId: "11" },
  { folder: "bihoku",           name: "備北交通",             realtimeId: "12" },
  { folder: "hdnishihiroshima", name: "HD西広島",             realtimeId: "13" },
  { folder: "fouble",           name: "フォーブル",           realtimeId: "14" },
  { folder: "jrbus",            name: "JRバス中国",           realtimeId: "15" },
  { folder: "sasaki",           name: "ささき観光(ハートバス)", realtimeId: "17" },
  { folder: "kurebus",          name: "呉市生活バス",         realtimeId: "18" },
  { folder: "hatsukaichi",      name: "廿日市市自主運行",     realtimeId: "19" },
  { folder: "onomichi",         name: "おのみちバス",         realtimeId: "53" },
  { folder: "asahi",            name: "朝日交通(阿戸線)",     realtimeId: "54" },
];

// -------------------------------------------------------
// 現在選択中の事業者（初期値はHD西広島）
// -------------------------------------------------------
var currentOperator = OPERATORS.find(function(o) {
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
  return "./data/" + currentOperator.folder
    + "/realtime/vehicle_position.bin";
}

// -------------------------------------------------------
// GTFSデータを格納するグローバル変数
// -------------------------------------------------------
var gtfsStops         = [];
var gtfsStopTimes     = [];
var gtfsTrips         = [];
var gtfsRoutes        = [];
var gtfsCalendar      = [];
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
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
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
  var rot = (bearing != null) ? bearing : 0;
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">'
    + '<g transform="rotate(' + rot + ',16,16)">'
    + '<circle cx="16" cy="16" r="14" fill="#1a6b3c" stroke="white" stroke-width="2"/>'
    + '<text x="16" y="21" text-anchor="middle" font-size="16" fill="white">\uD83D\uDE8C</text>'
    + '</g></svg>';
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
  var dot = document.getElementById("status-dot")