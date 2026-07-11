const url = "https://www.youtube.com/api/timedtext?v=iQyg-KypKAA&ei=beJPaqHeCJiy0u8P5N7juA8&caps=asr&opi=112496729&exp=xpe&xoaf=5&xowf=1&xospf=1&hl=fi&ip=0.0.0.0&ipbits=0&expire=1783645405&sparams=ip,ipbits,expire,v,ei,caps,opi,exp,xoaf&signature=3ABF999BE9D616AC7317B7679E1AFCDA95DA99C9.C362CA09067CE2DC7ADA8B15CCB9084813E40046&key=yt8&lang=en&fmt=json3";
fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
  .then(r => r.text())
  .then(t => console.log('Length:', t.length, 'Data:', t.slice(0, 100)));
