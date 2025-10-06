// api/click.js
// Handles:
//  - GET click queries (from the image form) -> perform click & return PNG
//  - POST JSON ({"url","x","y"}) -> perform click -> return PNG
//  - mode=hover (GET or POST) -> return JSON describing element under point
import { IncomingForm as IF } from 'formidable';
import { fileURLToPath } from 'url';

function safeParseInt(v, d=0){ const n = parseInt(String(v||''),10); return Number.isNaN(n)?d:n; }

async function parseFormCompat(req){
  // resilient parse for multiple formidable versions
  try {
    // new versions: `formidable` default export is a function returning an instance
    const mod = await import('formidable').catch(()=>null);
    if(mod){
      const F = mod.default || mod;
      // if default is a function, use it as factory:
      if(typeof F === 'function' && !F.IncomingForm){
        return new Promise((resolve,reject)=>{
          const form = F({ multiples: false });
          form.parse(req, (err, fields, files) => err ? reject(err) : resolve({ fields, files }));
        });
      }
      // else try constructor
      if(F.IncomingForm || F){
        const Incoming = F.IncomingForm || F;
        return new Promise((resolve,reject)=>{
          const form = new Incoming();
          form.parse(req, (err, fields, files) => err ? reject(err) : resolve({ fields, files }));
        });
      }
    }
  } catch(e){
    // fall through
  }
  // fallback attempt: old-style require
  try {
    // attempt sync require
    // (This branch won't run in ESM-only runtimes but included for robustness)
    /* eslint-disable no-eval */
    const reqMod = eval("require")('formidable');
    const Incoming = reqMod.IncomingForm || reqMod;
    return new Promise((resolve,reject)=>{
      const form = new Incoming();
      form.parse(req, (err, fields, files) => err ? reject(err) : resolve({ fields, files }));
    });
  } catch(e) {
    throw new Error('Could not parse form data: ' + String(e.message || e));
  }
}

async function getPuppeteerAndOpts() {
  let chrome = null;
  try { chrome = await import('chrome-aws-lambda'); } catch {}
  try { if (!chrome) chrome = await import('@sparticuz/chromium-min'); } catch {}
  let puppeteer = null;
  try { puppeteer = await import('puppeteer-core'); } catch {}
  if (!puppeteer) {
    try { puppeteer = await import('puppeteer'); } catch {}
  }
  const execPath =
    process.env.CHROME_PATH ||
    (chrome && (chrome.executablePath?.() || chrome.executablePath)) ||
    (puppeteer && typeof puppeteer.executablePath === 'function' ? puppeteer.executablePath() : null) ||
    null;

  const args = [];
  if (chrome && chrome.args) args.push(...(chrome.args || []));
  args.push('--no-sandbox', '--disable-setuid-sandbox');

  const headless = true;
  return { puppeteer, execPath, args, headless, chrome };
}

/** Evaluate element under point on the page and return metadata */
async function inspectElementAt(page, x, y) {
  // x,y are pixels relative to page viewport (not CSS scaled)
  const info = await page.evaluate(({x,y})=>{
    const el = document.elementFromPoint(x, y);
    if(!el) return null;
    const rect = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const text = (el.innerText || el.alt || el.title || '').trim().slice(0,300);
    const href = el.href || null;
    return { tag, text, href, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  }, { x, y });
  return info;
}

export const config = { api: { bodyParser: false } }; // for Vercel: allow raw/formidable

export default async function handler(req, res) {
  try {
    // Accept several input styles:
    // 1) GET query parameters: url, x, y, mode=hover (or default click)
    // 2) POST JSON: { url, x, y, mode }
    // 3) multipart form from <input type="image"> -> fields.image.x / image.y or 0.x / 0.y

    const q = req.query || {};
    let url = q.url || null;
    let mode = (q.mode || '').toString() || null;
    let x = safeParseInt(q.x, NaN);
    let y = safeParseInt(q.y, NaN);

    // If POST JSON
    if(req.method === 'POST' && req.headers['content-type'] && req.headers['content-type'].includes('application/json')){
      const body = await new Promise((ok)=>{ let s=''; req.on('data',c=>s+=c); req.on('end',()=>ok(s?JSON.parse(s):{})); });
      url = url || body.url;
      mode = mode || body.mode;
      if(Number.isFinite(body.x)) x = body.x;
      if(Number.isFinite(body.y)) y = body.y;
    }

    // If POST multipart/form-data
    if((req.method === 'POST' || req.method === 'PUT') && (!url || Number.isNaN(x) || Number.isNaN(y))) {
      // try parse form
      try {
        const { fields } = await parseFormCompat(req);
        url = url || (fields.url || fields.URL || null);
        // classic image submit names:
        const rawX = fields['image.x'] ?? fields['0.x'] ?? fields.x ?? fields.left ?? '0';
        const rawY = fields['image.y'] ?? fields['0.y'] ?? fields.y ?? fields.top ?? '0';
        x = Number(rawX) || 0;
        y = Number(rawY) || 0;
        mode = mode || fields.mode || null;
      } catch(e){
        // ignore parse errors here (we might still have GET data)
      }
    }

    if(!url) return res.status(400).send('Missing url parameter');

    // default numeric fallback
    if(!Number.isFinite(x)) x = 0;
    if(!Number.isFinite(y)) y = 0;

    // mode handling: hover -> return JSON describing element under point
    const { puppeteer, execPath, args, headless } = await getPuppeteerAndOpts();
    if(!puppeteer) throw new Error('No puppeteer library available at runtime.');

    const pp = puppeteer.default || puppeteer;
    const launchOptions = { args, headless, defaultViewport: { width: 800, height: 600 } };
    if (execPath) launchOptions.executablePath = execPath;

    const browser = await pp.launch(launchOptions);
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);
    await page.goto(url, { waitUntil: 'networkidle2' }).catch(()=>{});

    // ensure x,y are within viewport; clamp
    const vp = await page.viewport() || { width: 800, height: 600 };
    const clampX = Math.max(0, Math.min(x, vp.width - 1));
    const clampY = Math.max(0, Math.min(y, vp.height - 1));

    if((q.mode === 'hover') || (mode && mode.toString().toLowerCase()==='hover')){
      const info = await inspectElementAt(page, clampX, clampY);
      await browser.close();
      if(!info) return res.json({ tag: null });
      return res.json(info);
    }

    // Otherwise: treat as click: perform mouse click at (x,y) then re-screenshot and return PNG
    await page.mouse.click(clampX, clampY, { delay: 50 }).catch(()=>{});
    await sleep(400);
    const width = (req.query.width ? parseInt(req.query.width,10) : (page.viewport() ? page.viewport().width : 800)) || 800;
    const height = (req.query.height ? parseInt(req.query.height,10) : (page.viewport() ? page.viewport().height : 600)) || 600;
    const buf = await page.screenshot({ type: 'png', clip: { x:0, y:0, width, height } }).catch(async (err)=>{
      // fallback: fullpage screenshot
      try { return await page.screenshot({ type: 'png', fullPage: false }); } catch(e){ throw err; }
    });
    await browser.close();

    res.setHeader('Content-Type','image/png');
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('click error', err);
    // friendly JSON for hover mode, plaintext for clicks.
    const isHover = (req.query && req.query.mode === 'hover') || (req.body && req.body.mode === 'hover');
    if(isHover) return res.status(500).json({ error: String(err.message || err) });
    res.status(500).send('Click error: ' + String(err.message || err));
  }
}


