const fs = require('fs');
fetch("https://www.youtube.com/watch?v=iQyg-KypKAA", {
  headers: {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  }
}).then(r => r.text()).then(async html => {
  const match = html.split('ytInitialPlayerResponse = ')[1]?.split('};')[0] + '}';
  const ytResponse = JSON.parse(match);
  const captionTracks = ytResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  const track = captionTracks[0];
  const fetchUrl = track.baseUrl + (track.baseUrl.includes('fmt=json3') ? '' : '&fmt=json3');
  console.log("Fetching:", fetchUrl);
  
  const transcriptRes = await fetch(fetchUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
  });
  console.log("Status:", transcriptRes.status);
  const transcriptTextRaw = await transcriptRes.text();
  console.log("Raw length:", transcriptTextRaw.length);
  if(transcriptTextRaw.length > 0) {
    const data = JSON.parse(transcriptTextRaw);
    console.log("Events:", data.events?.length);
  }
});
