// Checks voices-pick.html: renders at phone and laptop size, three picks update the summary, no console errors.
// Run: cd test && node picker.mjs [FILE_URL]   (default: ../voices-pick.html)
import puppeteer from 'puppeteer-core';
import path from 'path';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const URL = process.argv[2] || 'file://' + path.join(here, '..', 'voices-pick.html');
let bad = 0;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
for (const [name, vp] of [['phone', { width: 390, height: 844, isMobile: true, hasTouch: true }], ['laptop', { width: 1366, height: 768 }]]) {
  const page = await browser.newPage(); await page.setViewport(vp);
  const errors = []; page.on('console', m => m.type() === 'error' && errors.push(m.text())); page.on('pageerror', e => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'load' });
  const rows = await page.$$eval('.row', r => r.length);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const tap = async (key, k) => { const b = await page.$(`.row[data-key="${key}"] .take:nth-child(${k}) .sel`); await b.tap?.() ?? await b.click(); };
  await page.screenshot({ path: path.join(here, `picker-${name}.png`) });
  for (const [key, k] of [['book', 3], ['bag', 1], ['he1', 2]]) await (await page.$(`.row[data-key="${key}"] .take:nth-child(${k}) .sel`)).click();
  const play = await page.$('.row[data-key="ball"] .play'); await play.click();
  const sum = await page.$eval('#sum', e => e.textContent);
  const rtl = await page.$eval('.row[data-key="he1"]', e => getComputedStyle(e).direction);
  await page.screenshot({ path: path.join(here, `picker-${name}-picked.png`) });
  await page.evaluate(() => document.querySelector('.row[data-key="he1"]').scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: path.join(here, `picker-${name}-hebrew.png`) });
  const okay = rows === 29 && wide <= 0 && sum === 'book 3 · bag 1 · he1 2' && rtl === 'rtl' && errors.length === 0;
  if (!okay) bad++;
  console.log(`${name}: ${rows} rows, overflow ${wide}px, summary "${sum}", Hebrew ${rtl}, ${errors.length} console errors ${errors.join(' | ')} ${okay ? 'OK' : 'FAIL'}`);
}
await browser.close();
process.exit(bad ? 1 : 0);
