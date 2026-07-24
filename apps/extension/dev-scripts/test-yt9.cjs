const fs = require('fs');
fetch("https://www.youtube.com/watch?v=iQyg-KypKAA").then(r => r.text()).then(async html => {
  const match = html.split('ytInitialPlayerResponse = ')[1]?.split('};')[0] + '}';
  const ytResponse = JSON.parse(match);
  const captionTracks = ytResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  const track = captionTracks[0];
  const fetchUrl = track.baseUrl;
  console.log("Fetching default:", fetchUrl);
  
  const transcriptRes = await fetch(fetchUrl);
  console.log("Status:", transcriptRes.status);
  const transcriptTextRaw = await transcriptRes.text();
  console.log("Raw length:", transcriptTextRaw.length);
  console.log("Snippet:", transcriptTextRaw.substring(0, 100));
});
