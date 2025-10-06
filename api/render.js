// api/render.js
// ESM endpoint: returns an HTML page with an embedded screenshot (image inside a form).
// Query: /api/render?url=https://example.com&width=800&height=600
import fs from 'fs';
import path from 'path';

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Get a puppeteer-like browser factory that tries a few strategies */
async function getPuppeteerAndOpts() {
  // Try chrome-aws-lambda style, then puppeteer-core, then puppeteer
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
  // safe defaults
  args.push('--no-sandbox', '--disable-setuid-sandbox');

  const headless = true;
  return { puppeteer, execPath, args, headless, chrome };
}

export default async function handler(req, res) {
  const url = (req.query.url || 'https://example.com').toString();
  const width = parseInt(req.query.width || '800', 10) || 800;
  const height = parseInt(req.query.height || '600', 10) || 600;

  let browser = null;
  try {
    const { puppeteer, execPath, args, headless, chrome } = await getPuppeteerAndOpts();
    if (!puppeteer) throw new Error('No puppeteer or puppeteer-core available in runtime.');

    const launchOptions = {
      args,
      headless,
      defaultViewport: { width, height },
    };
    if (execPath) launchOptions.executablePath = execPath;

    // For puppeteer imported via ESM dynamic import: puppeteer.default is the module namespace
    const pp = puppeteer.default || puppeteer;
    browser = await pp.launch(launchOptions);

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);
    await page.goto(url, { waitUntil: 'networkidle2' }).catch(()=>{});
    const buf = await page.screenshot({ type: 'png', clip: { x:0, y:0, width, height } });

    // HTML: image inside a form that submits coordinates. Also add client-side hover script.
    const html = `<!doctype html>
<meta charset="utf-8">
<title>WiiRender — ${escapeHtml(url)}</title>
<style>
  body{margin:0;background:#111;color:#eee;font-family:Arial,Helvetica,sans-serif}
  header{padding:6px;background:#000;color:#fff;font-weight:600}
  main{padding:8px}
  .screenshot{display:block;max-width:100%;border:1px solid #333}
  #hint{color:#bbb;font-size:12px;margin-top:8px}
  #tooltip{position:fixed;pointer-events:none;background: rgba(0,0,0,0.85);color:#fff;padding:6px;border-radius:4px;font-size:12px;display:none;z-index:9999}
</style>
<header>WiiRender — ${escapeHtml(url)}</header>
<main>
  <form id="clickForm" method="GET" action="/api/click">
    <input type="hidden" name="url" value="${escapeHtml(url)}" />
    <input type="hidden" name="width" value="${width}" />
    <input type="hidden" name="height" value="${height}" />
    <!-- clicking the image will submit coordinates as image.x / image.y -->
    <input id="screenshotImage" class="screenshot" type="image"
      src="data:image/png;base64,${buf.toString('base64')}"
      alt="screenshot"
      style="width:${width}px;height:${height}px" />
  </form>
  <div id="hint">Tap the image to click. Move the pointer (or press on Wii) to show a tooltip if available.</div>
</main>
<div id="tooltip"></div>

<script>
(async ()=>{
  const img = document.getElementById('screenshotImage');
  const tooltip = document.getElementById('tooltip');
  const url = encodeURIComponent('${escapeHtml(url)}');
  const width = ${width}, height = ${height};

  // Send hover requests when pointer moves (or Wii pointer). Throttle to ~10Hz.
  let last = 0;
  function showTooltipAt(text, cx, cy){
    if(!text){ tooltip.style.display='none'; return; }
    tooltip.style.display='block';
    tooltip.textContent = text;
    tooltip.style.left = (cx + 12) + 'px';
    tooltip.style.top = (cy + 12) + 'px';
  }

  async function probeHover(clientX, clientY){
    const now = Date.now();
    if(now - last < 80) return;
    last = now;
    // coords relative to displayed image:
    const rect = img.getBoundingClientRect();
    const x = Math.round((clientX - rect.left) * (${width} / rect.width));
    const y = Math.round((clientY - rect.top) * (${height} / rect.height));
    try{
      const resp = await fetch('/api/click?mode=hover&url=' + url + '&x=' + x + '&y=' + y);
      if(!resp.ok) { showTooltipAt(null); return; }
      const j = await resp.json();
      if(j && j.tag){
        const text = (j.tag + (j.text ? ': ' + j.text.replace(/\\s+/g,' ').slice(0,120) : '') + (j.href ? ' → ' + j.href : ''));
        showTooltipAt(text, clientX, clientY);
      } else {
        showTooltipAt(null);
      }
    }catch(e){ showTooltipAt(null); }
  }

  // Pointer move -> hover probe
  img.addEventListener('pointermove', e => {
    const rect = img.getBoundingClientRect();
    if(e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) { tooltip.style.display='none'; return; }
    probeHover(e.clientX, e.clientY);
  });
  img.addEventListener('pointerleave', ()=> tooltip.style.display='none');

  // allow clicks: let form submission handle it (image input sends image.x/image.y)
})();
</script>
`;

    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.status(200).send(html);

  } catch (err) {
    console.error('render error', err);
    res.status(500).send('Render error: ' + String(err.message || err));
  } finally {
    if (browser) try { await browser.close(); } catch (e) {}
  }
}


