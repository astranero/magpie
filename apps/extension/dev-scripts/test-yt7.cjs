const fs = require('fs');
fetch("https://www.youtube.com/watch?v=iQyg-KypKAA").then(r => r.text()).then(async html => {
  const match = html.split('ytInitialPlayerResponse = ')[1]?.split('};')[0] + '}';
  const ytResponse = JSON.parse(match);
  const captionTracks = ytResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  const track = captionTracks[0];
  const fetchUrl = track.baseUrl + (track.baseUrl.includes('fmt=json3') ? '' : '&fmt=json3');
  console.log("Fetching:", fetchUrl);
  
  const transcriptRes = await fetch(fetchUrl);
  const transcriptTextRaw = await transcriptRes.text();
  console.log("Raw length:", transcriptTextRaw.length);
  const data = JSON.parse(transcriptTextRaw);
  console.log("Events:", data.events?.length);
  
  let transcriptText = '';
  if (data.events) {
    for (const event of data.events) {
      if (event.segs && event.segs.length > 0) {
        const startMs = event.tStartMs || 0;
        const mins = Math.floor(startMs / 60000);
        const secs = Math.floor((startMs % 60000) / 1000).toString().padStart(2, '0');
        const textContent = event.segs.map(s => s.utf8).join('').replace(/\n/g, ' ').trim();
        if (textContent && textContent !== '\n') {
          transcriptText += `[${mins}:${secs}] ${textContent}\n`;
        }
      }
    }
  }
  console.log("Result length:", transcriptText.length);
  console.log("Sample:", transcriptText.substring(0, 200));
});
