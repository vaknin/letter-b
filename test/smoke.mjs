// Smoke test: opens every stage and drives every game to its end, at projector and phone size.
// Run: cd test && npm install && timeout 300 node smoke.mjs [URL]   (default: the live site; a file:// URL works too)
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || process.env.LESSON_URL || 'https://vaknin.github.io/letter-b/';
const URL = BASE + (BASE.includes('?') ? '&' : '?') + 'fast=0.05';
const SHOTS = path.join(here, 'shots');
rmSync(SHOTS, { recursive: true, force: true }); mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME || '/usr/bin/chromium';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0, warnings = [];
const fail = m => { failures++; console.log('  FAIL', m); };
const ok = (c, m) => { if (!c) fail(m); };

async function waitFor(page, fn, arg, ms = 8000, what = 'condition') {
  try { await page.waitForFunction(fn, { timeout: ms, polling: 30 }, arg); return true; }
  catch { fail('timed out waiting for ' + what); return false; }
}
const ds = (page, k) => page.evaluate(k => document.querySelector('#screen').dataset[k] ?? '', k);
const spoken = page => page.evaluate(() => window.__spoken.length);
const key = (page, k) => page.keyboard.press(k);

async function run(vpName, vp) {
  console.log(`\n== ${vpName} ${vp.width}x${vp.height}`);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.setViewport({ ...vp, hasTouch: false });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.evaluateOnNewDocument(() => {
    // a clip played counts as spoken; Web Speech is only the fallback for a line with no clip
    window.__spoken = []; window.__tts = [];
    HTMLMediaElement.prototype.play = function () { window.__spoken.push(this.src.slice(0, 30)); return Promise.resolve(); };
    const s = window.speechSynthesis;
    if (s) { s.speak = u => { window.__spoken.push(u.text); window.__tts.push(u.text); }; s.cancel = () => {}; }
  });
  await page.goto(URL, { waitUntil: 'load' });
  let n = 0;
  const shot = async name => { await sleep(120); await page.screenshot({ path: path.join(SHOTS, `${vpName}-${String(++n).padStart(2, '0')}-${name}.png`) }); };
  const stage = async (i, part = 0) => {
    await page.evaluate((i, p) => go(i - 1, p), i, part);
    await sleep(80);
    const over = await page.evaluate(() => { const s = document.querySelector('#screen'); return s.scrollHeight - s.clientHeight; });
    if (over > 4) warnings.push(`${vpName} stage ${i}.${part}: content taller than screen by ${over}px`);
  };
  const center = (sel) => page.evaluate(sel => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
  const clickSel = async sel => { const c = await center(sel); ok(c, 'missing ' + sel); if (c) await page.mouse.click(c.x, c.y); };
  const speakGrew = async (before, what) => { await sleep(60); ok(await spoken(page) > before, `${what}: nothing spoken`); };

  // keyboard navigation
  await key(page, '3'); await sleep(60); ok(await ds(page, 'game') === 'meet', 'key 3 opens stage 3');
  await key(page, '1'); await key(page, '2'); await sleep(60); ok(await ds(page, 'game') === 'read', 'keys 1 2 open stage 12');
  await key(page, 'PageDown'); await sleep(60); ok(await ds(page, 'game') === 'read', 'PageDown does nothing');
  ok(await page.evaluate(() => PHRASES(LESSON).filter(p => !CLIPS[p])).then(m => m.length === 0), 'every phrase has a clip');
  // ArrowRight alone walks the whole lesson: every press moves an item or the stage
  await page.evaluate(() => go(0));
  const sig = () => page.evaluate(() => location.hash + '|' + JSON.stringify(document.querySelector('#screen').dataset) + '|' + document.querySelector('#screen').innerHTML.length);
  let walked = 0, stuck = []; const last = (await page.evaluate(() => STAGES.length)) - 1;
  for (let k = 0; k < 200 && (await page.evaluate(() => cur)) < last; k++) {
    const a = await sig(); await key(page, 'ArrowRight'); await sleep(30); walked++;
    if (await sig() === a) stuck.push(await page.evaluate(() => location.hash));
  }
  ok(await page.evaluate(() => cur) === (await page.evaluate(() => STAGES.length)) - 1, 'ArrowRight reaches the last stage');
  ok(stuck.length === 0, 'ArrowRight did nothing on ' + stuck.join(' '));
  for (let k = 0; k < 3; k++) await key(page, 'ArrowLeft');
  ok(await page.evaluate(() => cur) < (await page.evaluate(() => STAGES.length)) - 1, 'ArrowLeft goes back a stage');
  console.log(`  ArrowRight walk: ${walked} presses`);
  await key(page, 'm'); await sleep(100); await shot('menu'); await key(page, 'Escape');

  // 1 Routine
  await stage(1); await shot('routine');
  // 2 Lead-in
  await stage(2); await key(page, ' '); await sleep(500); ok(await ds(page, 'state') === 'revealed', 'lead-in reveal'); await shot('leadin');

  // 3 A Meet the words
  await stage(3);
  for (let k = 0; k < 6; k++) {
    let s0 = await spoken(page); await key(page, ' '); await speakGrew(s0, 'meet');
    ok(await ds(page, 'shown') === '1', 'meet word shown');
    if (k === 2) await shot('meet');
    if (k < 5) await key(page, 'ArrowRight');
  }
  ok(await ds(page, 'word') === 'balloon', 'meet reaches the last word');
  ok(await page.evaluate(() => !document.querySelector('#screen .he') && !!document.querySelector('.gest').textContent), 'meet: gesture hint, no Hebrew line');

  // 4a B Pop the balloon
  await stage(4, 0);
  await waitFor(page, () => document.querySelector('#screen').dataset.target, null, 3000, 'pop target');
  await shot('pop');
  { const s1 = await spoken(page); await clickSel('.say-btn'); await speakGrew(s1, 'pop speaker button'); }
  for (let guard = 0; guard < 300 && +(await ds(page, 'stars') || 0) < 8; guard++) {
    // find a balloon fully inside the sky and make it the target with its digit key
    const vis = await page.evaluate(() => {
      const sky = document.querySelector('.sky').getBoundingClientRect();
      const words = ['book', 'bag', 'ball', 'bus', 'banana', 'balloon'];
      for (const b of document.querySelectorAll('.balloon:not(.gone)')) {
        const r = b.getBoundingClientRect();
        if (r.top > sky.top + 10 && r.bottom < sky.bottom - 10) return { w: b.dataset.word, d: words.indexOf(b.dataset.word) + 1 };
      }
      return null;
    });
    if (!vis) { await sleep(150); continue; }
    if (await ds(page, 'target') === '') { await sleep(60); continue; }
    if (guard === 0) { // one wrong tap first
      const other = await page.evaluate(w => document.querySelector('#screen').dataset.target === w ? null : w, vis.w);
      if (other) { await clickSel(`.balloon[data-word="${other}"]`); ok(await ds(page, 'stars') === '' || +(await ds(page, 'stars')) === 0, 'wrong balloon gives no star'); }
    }
    await key(page, String(vis.d)); await sleep(30);
    const before = +(await ds(page, 'stars') || 0);
    await clickSel(`.balloon[data-word="${vis.w}"]`);
    await sleep(50);
    if (+(await ds(page, 'stars') || 0) === before) continue;
    await waitFor(page, () => document.querySelector('#screen').dataset.target || document.querySelector('#screen').dataset.state === 'won', null, 3000, 'next pop target');
  }
  ok(await ds(page, "state") === "won", "pop reaches 8 stars, got " + await ds(page, "stars"));
  await shot('pop-win');

  // 4b C B or not B?
  await stage(4, 1); await sleep(100); await shot('bornot');
  for (let k = 0; k < 11; k++) {
    await key(page, ' '); await sleep(40); ok(await ds(page, 'state') === 'revealed', 'bornot reveal ' + k);
    if (k === 0) await shot('bornot-reveal');
    await key(page, 'ArrowRight');
  }
  ok(await ds(page, 'state') === 'done', 'bornot ends'); await shot('bornot-end');

  // 5 gesture
  await stage(5); await shot('gesture');

  // 6 D Hot potato
  await stage(6); await shot('hotpotato');
  let lastHot = '';
  for (let k = 0; k < 3; k++) {
    await key(page, ' '); ok(await ds(page, 'state') === 'playing', 'hot music plays');
    if (k === 0) await shot('hot-playing');
    await waitFor(page, () => document.querySelector('#screen').dataset.state === 'shown', null, 5000, 'hot picture');
    const t = await ds(page, 'target'); ok(t !== lastHot, 'hot potato never repeats twice in a row'); lastHot = t;
    let s0 = await spoken(page); await key(page, 'Enter'); await speakGrew(s0, 'hot reveal');
    ok(await ds(page, 'state') === 'revealed', 'hot revealed');
    if (k === 0) await shot('hot-revealed');
  }

  // Space while the music plays stops it at once
  await key(page, ' '); ok(await ds(page, 'state') === 'playing', 'hot plays again');
  await key(page, ' '); ok(await ds(page, 'state') === 'drum', 'Space stops hot potato at once');
  ok(await page.evaluate(() => Music.timer === null), 'hot potato music stopped');
  await waitFor(page, () => document.querySelector('#screen').dataset.state === 'shown', null, 3000, 'hot picture after Space');

  // 7 E Letter B b
  await stage(7);
  let s0 = await spoken(page); await key(page, ' '); await speakGrew(s0, 'letter');
  await sleep(40); await shot('letter-drawing');
  await waitFor(page, () => document.querySelector('#screen').dataset.state === 'drawn', null, 5000, 'letters drawn');
  await shot('letter-drawn');
  await key(page, 'r'); await waitFor(page, () => document.querySelector('#screen').dataset.state === 'drawn', null, 5000, 'letters redrawn');
  await key(page, 'ArrowRight'); await sleep(60); ok(await ds(page, 'screen') === '2', 'letter screen 2');
  s0 = await spoken(page); await clickSel('.wcard[data-word="bus"]'); await speakGrew(s0, 'letter card');
  ok(await ds(page, 'said') === 'bus', 'letter card says bus'); await shot('letter-cards');

  // 8 F Catch the B!
  // the round is 20 s; a slower test clock (6 s) lets letters fall fully into view
  await page.goto(BASE + (BASE.includes('?') ? '&' : '?') + 'fast=0.3#8', { waitUntil: 'load' }); await sleep(100);
  const spokenBeforeCatch = 0; await shot('catch-ready');
  await key(page, 's'); ok(await ds(page, 'speed') === 'medium', 'S: medium');
  await key(page, 's'); ok(await ds(page, 'speed') === 'fast', 'S: fast');
  ok((await page.evaluate(() => document.querySelector('.speed').textContent)) === 'Speed: fast', 'speed button shows fast');
  await key(page, 's'); ok(await ds(page, 'speed') === 'slow', 'S cycles back to slow');
  await key(page, ' '); ok(await ds(page, 'state') === 'running', 'catch runs');
  let wrongDone = false, shotDone = false;
  while (await ds(page, 'state') === 'running') {
    const t = await page.evaluate(wantOk => {
      const f = document.querySelector('.field').getBoundingClientRect();
      for (const b of document.querySelectorAll('.letter:not(.burst):not(.bad):not(.fade)')) {
        const r = b.getBoundingClientRect();
        if (r.top > f.top + 2 && r.bottom < f.bottom - 20 && (b.dataset.ok === '1') === wantOk) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return null;
    }, wrongDone);
    if (t) { await page.mouse.click(t.x, t.y); wrongDone = true; }
    if (!shotDone && +(await ds(page, 'count') || 0) >= 2) { await shot('catch-running'); shotDone = true; }
    await sleep(40);
  }
  ok(await ds(page, 'state') === 'done', 'catch round ends');
  const caught = +(await ds(page, 'count'));
  ok(caught > 0, 'caught at least one B, wrongDone=' + wrongDone);
  ok((await page.evaluate(() => document.querySelector('.ready .title').textContent)).includes(`caught ${caught} B`), 'catch end text');
  await shot('catch-end');

  // 9 G Build the word: spell the whole word (drag the first letter, tap the rest)
  await page.goto(URL + '#9', { waitUntil: 'load' }); await sleep(100);
  await stage(9);
  const built = [];
  for (let r = 0; r < 6; r++) {
    await sleep(80);
    const w = await ds(page, 'word'); built.push(w);
    ok(await page.evaluate(n => document.querySelectorAll('.slot').length === n && document.querySelectorAll('.tile').length === n + 1, w.length), 'build: a slot per letter + 1 extra tile for ' + w);
    if (r === 0) {
      await shot('build');
      const bad = await page.evaluate(() => { const t = [...document.querySelectorAll('.tile')].find(t => t.dataset.letter !== 'b'); return t.dataset.letter; });
      await clickSel(`.tile[data-letter="${bad}"]`); await sleep(80);
      ok(await page.evaluate(() => !document.querySelector('.slot.filled')), 'wrong tile not accepted');
    }
    for (let k = 0; k < w.length; k++) {
      const sel = `.tile[data-letter="${w[k]}"]:not(.used):not([data-busy])`;
      if (k === 0) {
        const a = await center(sel), b = await center('.slot');
        await page.mouse.move(a.x, a.y); await page.mouse.down();
        for (let s = 1; s <= 8; s++) await page.mouse.move(a.x + (b.x - a.x) * s / 8, a.y + (b.y - a.y) * s / 8);
        await page.mouse.up();
      } else await clickSel(sel);
      await sleep(30);
    }
    await waitFor(page, () => document.querySelector('#screen').dataset.state === 'solved', null, 3000, 'build solved ' + w);
    await sleep(400);
    ok(await page.evaluate(w => document.querySelector('.bword').textContent === w && document.querySelector('.bword .b').textContent === 'b', w), 'solved word is one unbroken word, b red: ' + w);
    // nothing in Build the word overlaps
    const lap = await page.evaluate(() => {
      const els = [...document.querySelectorAll('.build > .pic, .bword, .tiles, .dots, .nextbtn, #screen > .he')];
      const R = els.map(e => [e.className, e.getBoundingClientRect()]), out = [];
      for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) {
        const [na, a] = R[i], [nb, b] = R[j];
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1 && !(na.includes('bfoot') || nb.includes('bfoot'))) out.push(na + ' x ' + nb);
      }
      const v = R.filter(([, r]) => r.bottom > innerHeight || r.right > innerWidth || r.left < 0).map(([n]) => n + ' off screen');
      return out.concat(v);
    });
    ok(lap.length === 0, `build ${w}: overlap ${lap.join(', ')}`);
    if (r === 0 || r === 5) await shot('build-solved-' + w);
    await key(page, ' ');
  }
  ok(built.slice(4).join() === 'banana,balloon', 'banana and balloon come last');
  ok(await ds(page, 'state') === 'won', 'build ends with Word builders'); await shot('build-win');

  // 10 I It's a…
  await stage(10);
  for (let k = 0; k < 6; k++) {
    s0 = await spoken(page); await key(page, ' '); await key(page, ' '); await speakGrew(s0, 'itsa');
    ok(await ds(page, 'phase') === '2', 'itsa both bubbles');
    if (k === 0) await shot('itsa');
    if (k < 5) await key(page, 'ArrowRight');
  }

  // 11 J Stand up if it's true!
  await stage(11); await sleep(100); await shot('truefalse');
  for (let k = 0; k < 8; k++) {
    await key(page, ' '); await sleep(100); ok(await ds(page, 'state') === 'revealed', 'true/false reveal');
    if (await ds(page, 'truth') === '0') ok(await page.evaluate(() => !!document.querySelector('.sent.fix')), 'false sentence corrected');
    if (k < 2) await shot('truefalse-' + (await ds(page, 'truth') === '1' ? 'true' : 'false'));
    await key(page, 'ArrowRight');
  }
  ok(await ds(page, 'state') === 'done', 'true/false ends');

  // 12 L Read with me
  await stage(12);
  for (let k = 0; k < 6; k++) {
    s0 = await spoken(page); await key(page, ' ');
    await waitFor(page, () => document.querySelector('#screen').dataset.state === 'read', null, 3000, 'karaoke done');
    ok(await spoken(page) >= s0 + 3, 'karaoke speaks 3 chips');
    await clickSel('.wchip[data-say="a"]'); ok(await ds(page, 'state') !== 'solved', 'wrong chip not accepted');
    await clickSel('.wchip[data-b="1"]'); ok(await ds(page, 'state') === 'solved', 'b chip accepted');
    if (k === 0) await shot('read');
    await key(page, 'ArrowRight');
  }
  ok(await ds(page, 'state') === 'done', 'read ends');

  // 13 M My B picture
  await stage(13); await shot('mypicture');
  await key(page, ' '); ok(await ds(page, 'state') === 'running', 'picture timer runs');
  await key(page, ' '); ok(await ds(page, 'state') === 'paused', 'picture timer pauses'); await key(page, ' ');
  await waitFor(page, () => document.querySelector('#screen').dataset.state === 'done', null, 12000, 'picture timer ends');

  // 14 N Bus stop: the bus drives left -> right, always fully on screen
  await stage(14); await key(page, ' ');
  const xs = [];
  for (let k = 0; k < 6; k++) {
    const r = await page.evaluate(() => { const b = document.querySelector('.rbus').getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; });
    ok(r.l >= 0 && r.r <= vp.width && r.t >= 0 && r.b <= vp.height, `bus inside the screen (${r.l | 0}..${r.r | 0})`);
    xs.push(r.l); if (k === 2) await shot('busstop-running');
    await sleep(700);
  }
  ok(xs.every((x, k) => k === 0 || x > xs[k - 1]), 'bus moves right: ' + xs.map(x => x | 0).join(' '));
  await waitFor(page, () => document.querySelector('#screen').dataset.state === 'done', null, 15000, 'bus timer ends');
  { const r = await page.evaluate(() => [document.querySelector('.rbus').getBoundingClientRect().right, document.querySelector('.rsign').getBoundingClientRect().left]);
    ok(r[0] <= r[1] && r[1] - r[0] < 40, `bus stops at the sign (${r[0] | 0} / ${r[1] | 0})`); }
  await shot('busstop-arrived');
  await sleep(4200); ok(await page.evaluate(() => document.querySelector('.busstop .sign').textContent.includes('BUS STOP')), 'BUS STOP sign');
  ok(await page.evaluate(() => { const b = document.querySelector('.bigbus').getBoundingClientRect(), s = document.querySelector('.busstop .sign').getBoundingClientRect(); return b.left >= 0 && b.right <= s.left; }), 'big bus on screen, not under the sign');
  await shot('busstop-end');

  // 15 O Show me!
  await stage(15); await shot('showme');
  for (let k = 0; k < 5; k++) {
    s0 = await spoken(page); await key(page, ' '); await speakGrew(s0, 'show me');
    await key(page, 'Enter'); ok(await page.evaluate(() => !!document.querySelector('.wcard.hit')), 'show me highlight');
    if (k === 0) await shot('showme-hit');
  }
  await key(page, ' '); ok(await ds(page, 'state') === 'final', 'show me self-check'); await shot('showme-final');
  await key(page, ' '); ok(await ds(page, 'state') === 'bye', 'show me goodbye'); await shot('showme-bye');

  // 16 P Memory match (bonus)
  await stage(16); await shot('memory');
  const words = ['book', 'bag', 'ball', 'bus', 'banana', 'balloon'];
  const card = (w, kind) => `.mcard[data-word="${w}"][data-kind="${kind}"]`;
  // a miss: turn passes
  await clickSel(card('book', 'pic')); await clickSel(card('bus', 'word'));
  ok(await ds(page, 'state') === 'nomatch', 'memory no match');
  await waitFor(page, () => document.querySelector('#screen').dataset.state === '' && document.querySelector('#screen').dataset.team === 'blue', null, 3000, 'turn passes to blue');
  // a rejected match: turn passes back
  await clickSel(card('ball', 'pic')); await clickSel(card('ball', 'word')); await sleep(500);
  ok(await ds(page, 'state') === 'pending', 'memory match waits for teacher'); await shot('memory-pending');
  await key(page, 'Backspace');
  await waitFor(page, () => document.querySelector('#screen').dataset.team === 'red', null, 3000, 'rejected match passes turn');
  await sleep(60);
  for (const w of words) {
    await clickSel(card(w, 'pic')); await clickSel(card(w, 'word')); await sleep(80);
    s0 = await spoken(page); await key(page, 'Enter');
  }
  await waitFor(page, () => document.querySelector('#screen .win'), null, 3000, 'memory game over');
  ok((await page.evaluate(() => document.querySelector('.win-card').textContent)).includes('Well played'), 'memory Well played'); await sleep(500); await shot('memory-over');

  ok(await spoken(page) > 30, 'clips were played');
  const tts = await page.evaluate(() => [...new Set(window.__tts)]);
  ok(tts.length === 0, 'spoken with no clip: ' + JSON.stringify(tts));
  ok(errors.length === 0, 'console errors: ' + errors.join(' | '));
  console.log(`  spoken ${await spoken(page)} times, ${errors.length} console errors, ${n} screenshots`);
  await browser.close();
}

await run('desktop', { width: 1366, height: 768 });
await run('phone', { width: 390, height: 844, deviceScaleFactor: 1 });
if (warnings.length) console.log('\nlayout warnings:\n  ' + warnings.join('\n  '));
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
