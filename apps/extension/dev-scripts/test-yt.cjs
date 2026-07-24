const https = require('https');
https.get('https://www.youtube.com/watch?v=iQyg-KypKAA', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const match = data.match(/ytInitialPlayerResponse\s*=\s*(\{.*?\});/);
    if (!match) {
      console.log('No match for ytInitialPlayerResponse');
      return;
    }
    const yt = JSON.parse(match[1]);
    const tracks = yt?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    console.log('Caption tracks:', tracks);
    if (tracks && tracks.length > 0) {
      https.get(tracks[0].baseUrl, (res2) => {
        let xml = '';
        res2.on('data', c => xml += c);
        res2.on('end', () => {
          console.log('XML snippet:', xml.slice(0, 500));
        });
      });
    }
  });
});
