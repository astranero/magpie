const fs = require('fs');
fetch("https://www.youtube.com/watch?v=iQyg-KypKAA").then(r => r.text()).then(html => {
  const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.*?\});/);
  console.log("Match without /s:", !!match);
  
  const matchWithS = html.match(/ytInitialPlayerResponse\s*=\s*(\{.*?\});/s);
  console.log("Match with /s:", !!matchWithS);
  
  const matchVar = html.match(/var ytInitialPlayerResponse\s*=\s*(\{.*?\});/);
  console.log("Match var:", !!matchVar);

  const matchSplit = html.split('ytInitialPlayerResponse = ')[1]?.split('};')[0] + '}';
  console.log("Split length:", matchSplit ? matchSplit.length : 0);
  
  if (matchSplit && matchSplit.length > 100) {
    try {
      JSON.parse(matchSplit);
      console.log("Parse successful via split!");
    } catch(e) {
      console.log("Parse failed", e.message.substring(0, 50));
    }
  }
});
