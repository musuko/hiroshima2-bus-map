const proxyUrl = "https://cors-anywhere.herokuapp.com/";
const apiUrl = "https://ajt-mobusta-gtfs.mcapps.jp/static/13/current_data.zip";

fetch(proxyUrl + apiUrl)
  .then((response) => response.text())
  .then((data) => {
    // ZIPファイルを解凍する
    const zip = JSZip.loadAsync(data);

    // stops.txtファイルを取得する
    zip.then((zip) => {
      const stopsTxt = zip.files["stops.txt"];
      stopsTxt
        .async("text")
        .then((stopsTxtData) => {
          const stopsContent = document.getElementById("gtfs-content");
          stopsContent.innerHTML = stopsTxtData;
        })
        .catch((error) => {
          console.error("Error:", error);
        });
    });
  })
  .catch((error) => {
    console.error("Error:", error);
  });