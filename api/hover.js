// api/hover.js
import puppeteer from "puppeteer";

const VIEWPORT = { width: 800, height: 600 };
let _browser = null;
async function getBrowser(){
  if (_browser && !_browser.process().killed) return _browser;
  _browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox","--disable-setuid-sandbox"] });
  return _browser;
}

export default async function handler(req, res) {
  try {
    // only accept JSON POST
    const body = await new Promise(r=>{ let s=''; req.on('data',c=>s+=c); req.on('end',()=>r(JSON.parse(s||'{}'))); });
    const url = body.url;
    let rx = Number(body.rx || 0), ry = Number(body.ry || 0);
    if(!url) return res.status(400).json({ error: 'missing url' });
    rx = Math.max(0, Math.min(1, rx));
    ry = Math.max(0, Math.min(1, ry));

    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.setDefaultNavigationTimeout(20000);
    await page.goto(url, { waitUntil: 'networkidle2' }).catch(()=>{});
    const px = Math.round(rx * VIEWPORT.width), py = Math.round(ry * VIEWPORT.height);

    // Move mouse (some pages rely on pointer events)
    try { await page.mouse.move(px, py, { steps: 1 }); } catch(e){}

    // Evaluate element at the point, and gather some friendly info
    const info = await page.evaluate(({x,y}) => {
      const el = document.elementFromPoint(x, y);
      if(!el) return { tag: null };
      const tag = el.tagName.toLowerCase();
      const title = el.getAttribute('title') || el.alt || el.getAttribute('aria-label') || '';
      const href = el.closest('a') ? (el.closest('a').href || '') : (el.href || '');
      let text = el.innerText || el.value || '';
      text = text.trim().slice(0,500);
      const r = el.getBoundingClientRect();
      return {
        tag, title, href, text,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height }
      };
    }, { x: px, y: py });

    await page.close();
    res.setHeader('Content-Type','application/json');
    res.status(200).send(JSON.stringify(info));
  } catch (err) {
    console.error('hover error', err);
    res.status(500).json({ error: String(err.message || err) });
  }
}

