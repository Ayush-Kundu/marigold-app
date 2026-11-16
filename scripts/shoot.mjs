import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = "http://localhost:3000";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--force-dark-mode"],
});

const page = await browser.newPage();
await page.setViewport({ width: 1180, height: 760, deviceScaleFactor: 2 });
await page.goto(URL, { waitUntil: "domcontentloaded" });
// innerText applies CSS uppercase, so match the rendered casing.
await page.waitForFunction(
  () => document.body.innerText.toLowerCase().includes("background tasks"),
  { timeout: 45000 },
);
await new Promise((r) => setTimeout(r, 600));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(name) {
  await page.screenshot({ path: `/tmp/pp-${name}.png` });
  console.log("shot", name);
}
async function clickText(sel, text) {
  const ok = await page.evaluate((s, t) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.textContent.trim().includes(t));
    if (el) { el.click(); return true; }
    return false;
  }, sel, text);
  await wait(450);
  return ok;
}

await shot("dense-chats");
console.log("projects:", await clickText("nav button", "Projects"));
await shot("dense-projects");

// mobile
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await clickText("nav button", "Chats");
await wait(400);
await shot("dense-mobile");

await browser.close();
console.log("done");
