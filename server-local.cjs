// server-local.cjs
const express = require("express");
const puppeteer = require("puppeteer");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// --- Global browser and page state ---
let browser;
let page;

// --- Helper: delay ---
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// --- Launch Puppeteer once ---
async function ensureBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  if (!page) {
    const pages = await browser.pages();
    page = pages[0] || await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
  }
}

// --- Route: render page ---
app.get("/render", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing ?url=");

  await ensureBrowser();
  console.log("render:", url);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });

  const buffer = await page.screenshot({ type: "jpeg", quality: 80 });
  res.setHeader("Content-Type", "image/jpeg");
  res.send(buffer);
});

// --- Route: click ---
app.get("/click", async (req, res) => {
  const { x, y } = req.query;
  if (!x || !y) return res.status(400).send("Missing ?x & ?y");

  await ensureBrowser();
  console.log("click at", x, y);
  await page.mouse.click(Number(x), Number(y));
  await sleep(300);

  const buffer = await page.screenshot({ type: "jpeg", quality: 80 });
  res.setHeader("Content-Type", "image/jpeg");
  res.send(buffer);
});

// --- Route: scroll ---
app.get("/scroll", async (req, res) => {
  const deltaY = parseInt(req.query.deltaY || "0");
  await ensureBrowser();
  console.log("scroll:", deltaY);

  await page.evaluate(y => window.scrollBy(0, y), deltaY);
  await sleep(200);

  const buffer = await page.screenshot({ type: "jpeg", quality: 80 });
  res.setHeader("Content-Type", "image/jpeg");
  res.send(buffer);
});

// --- Route: keyboard input ---
app.get("/type", async (req, res) => {
  const text = req.query.text || "";
  await ensureBrowser();
  console.log("type:", text);
  await page.keyboard.type(text);
  await sleep(300);

  const buffer = await page.screenshot({ type: "jpeg", quality: 80 });
  res.setHeader("Content-Type", "image/jpeg");
  res.send(buffer);
});

// --- Start server ---
app.listen(3000, () => {
  console.log("Local server running on http://localhost:3000");
  console.log("Try: /render?url=https://example.com");
});



