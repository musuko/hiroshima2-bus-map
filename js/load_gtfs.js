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
      // HTTPステータスが200以外（403, 500等）の場合はエラーとして扱う
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
        // GitHub Pages上のキャッシュファイルのパス
        // fetch_realtime.yml が定期的に更新している
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
      // プロキシもキャッシュも両方失敗した場合
      // ステータス表示をエラーに更新して処理を終了する
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
    // 取得・描画成功をステータス表示に反映する
    setStatus("ok", "updated");
  } catch (err) {
    // デコード失敗（バイナリが壊れている等）の場合
    setStatus("error", "error: " + err.message);
    console.error("[GTFS-RT] デコード失敗:", err);
  }
}
