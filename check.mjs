#!/usr/bin/env node
/**
 * Живая проверка собранной страницы в headless Edge через CDP.
 *
 *   node build.mjs && node check.mjs
 *
 * Звук здесь никто не слышит — проверяем, что страница не падает и не молчит:
 * нет ошибок в консоли, у каждого персонажа play() планирует по осциллятору на
 * букву, печать доходит до конца при бегущем ctx.currentTime, ползунки и кнопки
 * формы правят именно своё поле пресета и следующая реплика идёт уже с ним,
 * экспорт даёт валидный JSON, сброс возвращает стартовые.
 *
 * Второй источник — сэмплы «как в Aurelia»: встроенные банки декодируются,
 * переключатель прячет ползунки неактивного источника, play() создаёт ровно
 * ceil(символов / everyN) нод AudioBufferSourceNode, их playbackRate лежит
 * в [pitchMin, pitchMax], банк подменяется своими файлами.
 *
 * Отдельный прогон — мобильная раскладка (Emulation.setDeviceMetricsOverride,
 * 390×844 и 360×740, mobile:true): страница не едет вбок, тач-цели не мельче
 * 44×44 px, подписи не мельче 11 px, портрет не крупнее 64 px, подвал свёрнут
 * в <details> и раскрывается, звук и печать работают так же, как на десктопе.
 * В конце пишутся screenshot.png (1440×900) и screenshot-mobile.png (390×полная высота).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const PAGE = pathToFileURL(join(DIR, 'index.html')).href;
const PORT = 9333;
const EDGES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const edgeExe = EDGES.find(existsSync);
if (!edgeExe) { console.error('не найден msedge.exe'); process.exit(2); }
if (!existsSync(join(DIR, 'index.html'))) { console.error('нет index.html — сначала node build.mjs'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'babble-edge-'));

const edge = spawn(edgeExe, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required', '--window-size=1440,900',
  'about:blank',
], { stdio: 'ignore' });

let targets = null;
for (let i = 0; i < 60; i++) {
  try { targets = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json(); if (targets.length) break; } catch {}
  await sleep(250);
}
if (!targets) { edge.kill(); console.error('Edge не поднял CDP'); process.exit(2); }
const target = targets.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });

let id = 0;
const pending = new Map();
const consoleErrors = [];
const consoleWarns = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    if (m.params.type === 'error') consoleErrors.push(txt);
    else if (m.params.type === 'warning') consoleWarns.push(txt);
  }
  // Кадры скринкаста надо подтверждать, иначе поток встаёт вместе с rAF.
  if (m.method === 'Page.screencastFrame') {
    ws.send(JSON.stringify({ id: ++id, method: 'Page.screencastFrameAck', params: { sessionId: m.params.sessionId } }));
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    consoleErrors.push('EXCEPTION: ' + (d.exception?.description || d.text));
  }
};
const send = (method, params = {}) => new Promise((r) => {
  const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJs = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const d = res.result?.exceptionDetails;
  if (d) throw new Error(d.exception?.description || d.text);
  return JSON.parse(res.result.result.value);
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
// Печать держится на requestAnimationFrame, а headless сам по себе кадры почти не рисует:
// через ~10 с страница уходит в visibilityState=hidden, и даже с эмуляцией фокуса компоновщик
// перестаёт выдавать кадры. Фокус + включённый скринкаст держат кадры весь прогон.
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Page.setWebLifecycleState', { state: 'active' });
await send('Page.navigate', { url: PAGE });
await sleep(1200);
// Пресеты могли остаться в localStorage от прошлого прогона — проверяем стартовые значения.
await evalJs(`(() => { try { localStorage.clear(); } catch (e) {} return "0"; })()`);
await send('Page.navigate', { url: PAGE });
await sleep(1400);
await send('Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 80, maxHeight: 60, everyNthFrame: 1 });
await sleep(300);

const results = [];
const ok = (name, pass, note = '') => { results.push({ name, pass, note }); };
const CHARS = ['58', '54', '57', 'oleg'];
const OSC_FIELDS = ['source', 'wave', 'hz', 'jitter', 'charMs', 'blipMs', 'decayMs', 'lowpass', 'pauseMul', 'questionMul', 'consonantDip'];
const SMP_FIELDS = ['everyN', 'pitchMin', 'pitchMax', 'sampleGain', 'cut'];
const FIELDS = OSC_FIELDS.concat(SMP_FIELDS);
const EXPORT_KEYS = FIELDS.concat(['bank']);

/* --- 1. каркас страницы --- */
const dom = await evalJs(`JSON.stringify({
  babble: typeof window.__babble,
  api: ['play','presets','ctx','exportJson','banks','loadCustomBank','debug'].filter(k => !(k in window.__babble)),
  lastNodes: Array.isArray(window.__babble.debug && window.__babble.debug.lastNodes),
  cards: [...document.querySelectorAll('.card')].map(c => c.dataset.id),
  portraits: document.querySelectorAll('.card .pic svg').length,
  knobs: [...document.querySelectorAll('.card[data-id="58"] .knobs.osc input[type=range]')].map(i => i.dataset.k),
  sknobs: [...document.querySelectorAll('.card[data-id="58"] .knobs.sm input[type=range]')].map(i => i.dataset.k),
  waveBtns: document.querySelectorAll('.card[data-id="58"] .wv').length,
  srcBtns: [...document.querySelectorAll('.card[data-id="58"] .sw')].map(b => b.dataset.src),
  drops: document.querySelectorAll('.card .drop input[type=file]').length,
  text: document.getElementById('text').value,
  dead: /SamJs|BANKS_B64/.test(document.documentElement.innerHTML),
  oggs: (document.documentElement.innerHTML.match(/data:audio\\/ogg;base64,/g) || []).length,
  aurelia: /so_[a-z0-9_]+\\.ogg/i.test(document.documentElement.innerHTML.replace(/so_\\*\\.ogg/g, '')),
  // body с overflow:hidden всегда даст scrollHeight = innerHeight, поэтому меряем сам контент:
  // низ подвала должен быть виден, а терминал — не прокручиваться внутри себя.
  footBottom: Math.round(document.getElementById('foot').getBoundingClientRect().bottom),
  winH: window.innerHeight, winW: window.innerWidth,
  termOverflowY: document.getElementById('term').scrollHeight - document.getElementById('term').clientHeight,
  cardBottom: [...document.querySelectorAll('.card')].map(c => Math.round(c.getBoundingClientRect().bottom)),
  cardRight: Math.max(...[...document.querySelectorAll('.card')].map(c => Math.round(c.getBoundingClientRect().right))),
  knobClipped: [...document.querySelectorAll('.knobs')].filter(k => k.scrollHeight - k.clientHeight > 1).length
})`);
ok('window.__babble экспортирован (включая banks/loadCustomBank/debug.lastNodes)',
  dom.babble === 'object' && dom.api.length === 0 && dom.lastNodes,
  dom.api.length ? 'нет полей: ' + dom.api.join(', ') : 'play/presets/ctx/exportJson/banks/loadCustomBank/debug на месте');
ok('4 карточки персонажей', dom.cards.length === 4 && CHARS.every((c) => dom.cards.includes(c)),
  dom.cards.join(', ') + '; портретов SVG: ' + dom.portraits);
ok('на карточке 8 ползунков осциллятора, 5 сэмплов, 4 волны, 2 источника, зона файлов',
  dom.knobs.length === 8 && dom.sknobs.length === 5 && dom.waveBtns === 4
  && dom.srcBtns.join(',') === 'osc,samples' && dom.drops === 4,
  'осц: ' + dom.knobs.join(', ') + ' | сэмплы: ' + dom.sknobs.join(', ') + ' | зон файлов ' + dom.drops);
ok('снятых способов нет, шесть встроенных ogg вшито, чужих ассетов Aurelia нет',
  dom.dead === false && dom.oggs === 6 && dom.aurelia === false,
  'ogg data-URI: ' + dom.oggs + ', хвостов снятых способов: ' + dom.dead + ', so_*.ogg из игры: ' + dom.aurelia);
ok('страница помещается в 1440×900',
  dom.footBottom <= dom.winH && dom.termOverflowY <= 1
  && dom.cardBottom.every((b) => b <= dom.winH) && dom.cardRight <= dom.winW && dom.knobClipped === 0,
  'низ подвала ' + dom.footBottom + ' из ' + dom.winH + ' px, переполнение терминала ' + dom.termOverflowY
  + ' px, низ карточек ' + dom.cardBottom.join('/') + ', правый край ' + dom.cardRight + '/' + dom.winW
  + ', обрезано блоков ручек ' + dom.knobClipped);
ok('реплика по умолчанию подставлена', dom.text.length > 0, JSON.stringify(dom.text));

/* --- 2. стартовые пресеты --- */
const start = await evalJs(`JSON.stringify({ presets: window.__babble.presets, defaults: window.__babble.DEFAULTS })`);
const shapeOk = CHARS.every((c) => start.presets[c] && FIELDS.every((f) => f in start.presets[c])
  && Object.keys(start.presets[c]).length === FIELDS.length);
ok('пресеты — плоские, по 16 полей на персонажа (осциллятор + сэмплы)', shapeOk,
  CHARS.map((c) => c + ': ' + start.presets[c].source + ' / ' + start.presets[c].wave + ' ' + start.presets[c].hz + ' Гц, '
    + start.presets[c].charMs + ' мс/сим, N=' + start.presets[c].everyN
    + ', питч ' + start.presets[c].pitchMin + '–' + start.presets[c].pitchMax).join(' | '));
ok('стартовые значения = DEFAULTS, стартовый источник у всех — осциллятор',
  JSON.stringify(start.presets) === JSON.stringify(start.defaults)
  && CHARS.every((c) => start.presets[c].source === 'osc'));

/* --- 3. AudioContext --- */
const ac = await evalJs(`(async () => {
  const b = window.__babble;
  b.ensure();
  try { await b.ctx.resume(); } catch (e) {}
  return JSON.stringify({ state: b.ctx.state, sampleRate: b.ctx.sampleRate });
})()`);
const running = ac.state === 'running';
ok('AudioContext в состоянии running', running, 'state = ' + ac.state + ', ' + ac.sampleRate + ' Гц');

/* --- 4. проигрывание на каждом персонаже (источник — осциллятор) --- */
const rows = [];
let playPass = true;
for (const c of CHARS) {
  let r;
  try {
    r = await evalJs(`(async () => {
      const b = window.__babble;
      b.presets[${JSON.stringify(c)}].source = 'osc';
      const t1 = b.ctx.currentTime;
      const r = await b.play(${JSON.stringify(c)}, undefined);
      const line = b.CHARS.filter(x => x.id === ${JSON.stringify(c)})[0].line;
      const letters = (line.match(/[a-zа-яё]/gi) || []).length;
      await new Promise(res => setTimeout(res, r.durationMs + 400));
      const out = document.querySelector('.card[data-id="' + ${JSON.stringify(c)} + '"] .out');
      return JSON.stringify(Object.assign(r, {
        letters: letters,
        advanced: +(b.ctx.currentTime - t1).toFixed(3),
        typed: out.querySelector('.said').textContent.length,
        clipped: out.scrollHeight - out.clientHeight,
        playing: b.playing,
        nodesLive: b.active,
        kinds: [...new Set(b.debug.lastNodes.map(n => n.constructor.name))]
      }));
    })()`);
  } catch (e) { playPass = false; rows.push(c + ': БРОСИЛ ' + e.message); continue; }
  // нод = осцилляторы (по букве) + один общий lowpass
  const good = r.events === r.letters && r.nodes === r.events + 1 && r.typed === r.chars
    && r.clipped <= 1 && r.playing === c && (!running || r.advanced > 0)
    && r.source === 'osc' && r.kinds.join(',') === 'OscillatorNode';
  if (!good) playPass = false;
  rows.push(c + ': осц ' + r.events + ' при ' + r.letters + ' буквах, нод ' + r.nodes
    + ', напечатано ' + r.typed + '/' + r.chars + ', реплика ' + r.durationMs + ' мс, ctx +' + r.advanced + ' с'
    + (r.clipped > 1 ? ', ОБРЕЗКА ' + r.clipped + ' px' : ''));
  await evalJs('(window.__babble.stop(), "0")');
}
ok('play() у каждого персонажа: осциллятор на букву, печать до конца', playPass, rows.join(' | '));

/* --- 4b. ▶ на одной карточке глушит остальные --- */
const solo = await evalJs(`(async () => {
  const b = window.__babble;
  await b.play('54', 'Длинная реплика Блонде, чтобы точно ещё звучала.');
  const first = b.active;
  await b.play('57', 'Перебиваю.');
  await new Promise(res => setTimeout(res, 400));
  const cards = [...document.querySelectorAll('.card.playing')].map(c => c.dataset.id);
  const said = [...document.querySelectorAll('.card')].map(c => c.dataset.id + ':' + c.querySelector('.said').textContent.length);
  const second = b.active, playing = b.playing;   // читать до stop(): он обнуляет и ноды, и playing
  b.stop();
  return JSON.stringify({ first: first, second: second, cards: cards, said: said, playing: playing });
})()`);
// «Перебиваю.» — 9 букв, значит 9 осцилляторов + фильтр: ноды первой реплики выброшены, а не доигрывают
ok('▶ на карточке глушит остальные',
  solo.cards.length === 1 && solo.cards[0] === '57' && solo.playing === '57'
  && solo.first === 41 && solo.second === 10 && solo.said.some((s) => /^57:[1-9]/.test(s))
  && solo.said.filter((s) => !/^57:/.test(s)).every((s) => /:0$/.test(s)),
  'подсвечено: ' + solo.cards.join(',') + '; напечатано ' + solo.said.join(' ') + '; нод было ' + solo.first + ' → ' + solo.second);

/* --- 5. ползунки правят своё поле и следующая реплика идёт с новым значением --- */
const knob = await evalJs(`(async () => {
  const b = window.__babble;
  const set = (id, k, v) => {
    const i = document.getElementById('k-' + id + '-' + k);
    i.value = String(v); i.dispatchEvent(new Event('input', { bubbles: true }));
    return { field: b.presets[id][k], label: document.getElementById('v-' + id + '-' + k).textContent };
  };
  const hz = set('58', 'hz', 305);
  const cm = set('54', 'charMs', 70);
  const lp = set('oleg', 'lowpass', 5000);
  const pm = set('57', 'pauseMul', 2);
  const wv = document.querySelector('.card[data-id="58"] .wv[data-w="square"]');
  wv.click();
  const dip = document.getElementById('k-54-consonantDip');
  dip.checked = false; dip.dispatchEvent(new Event('input', { bubbles: true }));

  const text = 'Проверка ползунков.';
  const r58 = await b.play('58', text); b.stop();
  const r54 = await b.play('54', text); b.stop();
  const rOleg = await b.play('oleg', text); b.stop();
  // 57 без пауз против 57 с двойными паузами: множитель должен менять длину реплики
  const withPause = (await b.play('57', 'Точка. Точка.')).durationMs; b.stop();
  set('57', 'pauseMul', 0);
  const noPause = (await b.play('57', 'Точка. Точка.')).durationMs; b.stop();

  return JSON.stringify({
    hz: hz, cm: cm, lp: lp, pm: pm,
    wave58: b.presets['58'].wave, dip54: b.presets['54'].consonantDip,
    other58: b.presets['58'].charMs, other54: b.presets['54'].hz,
    play58: { hz: r58.hz, wave: r58.wave }, play54: r54.charMs, playOleg: rOleg.lowpass,
    withPause: withPause, noPause: noPause,
    stored: (() => { try { return JSON.parse(localStorage.getItem('babble-demo-20260905-chip')).presets['58'].hz; } catch (e) { return 'нет'; } })()
  });
})()`);
const knobPass = knob.hz.field === 305 && knob.hz.label === '305'
  && knob.cm.field === 70 && knob.lp.field === 5000 && knob.pm.field === 2
  && knob.wave58 === 'square' && knob.dip54 === false
  && knob.other58 === 22 && knob.other54 === 190          // соседние поля/персонажи не поехали
  && knob.play58.hz === 305 && knob.play58.wave === 'square'
  && knob.play54 === 70 && knob.playOleg === 5000
  && knob.withPause > knob.noPause && knob.stored === 305;
ok('ползунки/кнопки правят своё поле, следующая реплика идёт с новым значением', knobPass,
  '58 hz→' + knob.hz.field + ' (метка ' + knob.hz.label + ', в play ' + knob.play58.hz + ', волна ' + knob.play58.wave
  + '), 54 charMs→' + knob.play54 + ', oleg lowpass→' + knob.playOleg
  + ', 57 паузы ×2 = ' + knob.withPause + ' мс против ×0 = ' + knob.noPause + ' мс'
  + ', соседние поля целы (58 charMs ' + knob.other58 + ', 54 hz ' + knob.other54 + ')'
  + ', в localStorage ' + knob.stored);

/* --- 5b. ползунки сэмплов правят свои поля --- */
const sknob = await evalJs(`(async () => {
  const b = window.__babble;
  const set = (id, k, v) => {
    const i = document.getElementById('ks-' + id + '-' + k);
    i.value = String(v); i.dispatchEvent(new Event('input', { bubbles: true }));
    return { field: b.presets[id][k], label: document.getElementById('vs-' + id + '-' + k).textContent };
  };
  const n = set('58', 'everyN', 6);
  const g = set('54', 'sampleGain', -14);
  const pmin = set('57', 'pitchMin', 0.62);
  const cut = document.getElementById('ks-oleg-cut');
  cut.checked = true; cut.dispatchEvent(new Event('input', { bubbles: true }));
  return JSON.stringify({
    n: n, g: g, pmin: pmin, cutOleg: b.presets['oleg'].cut, cut58: b.presets['58'].cut,
    hz58: b.presets['58'].hz,     // ползунок сэмплов не должен трогать поля осциллятора
    stored: (() => { try { return JSON.parse(localStorage.getItem('babble-demo-20260905-chip')).presets['58'].everyN; } catch (e) { return 'нет'; } })()
  });
})()`);
ok('ползунки сэмплов правят свои поля и сохраняются',
  sknob.n.field === 6 && sknob.n.label === '6' && sknob.g.field === -14 && sknob.g.label === '-14'
  && sknob.pmin.field === 0.62 && sknob.pmin.label === '0.62'
  && sknob.cutOleg === true && sknob.cut58 === false && sknob.hz58 === 305 && sknob.stored === 6,
  '58 everyN→' + sknob.n.field + ', 54 sampleGain→' + sknob.g.field + ' дБ, 57 pitchMin→' + sknob.pmin.field
  + ', галка «обрезать» у oleg ' + sknob.cutOleg + ' (у 58 ' + sknob.cut58 + '), поле осциллятора 58 hz цело: ' + sknob.hz58
  + ', в localStorage everyN ' + sknob.stored);

/* --- 6. экспорт --- */
const exp = await evalJs(`JSON.stringify({ raw: window.__babble.exportJson() })`);
let expObj = null, expErr = '';
try { expObj = JSON.parse(exp.raw); } catch (e) { expErr = e.message; }
const expPass = !!expObj && Object.keys(expObj).length === 4 && CHARS.every((c) => expObj[c]
  && Object.keys(expObj[c]).join(',') === EXPORT_KEYS.join(',')
  && typeof expObj[c].wave === 'string' && typeof expObj[c].hz === 'number'
  && typeof expObj[c].consonantDip === 'boolean' && typeof expObj[c].cut === 'boolean'
  && ['osc', 'samples'].includes(expObj[c].source)
  && /^(builtin:(58|54)|custom)$/.test(expObj[c].bank));
ok('exportJson() — валидный плоский JSON на четыре ключа, с source и bank', expPass,
  expErr ? 'не разобрался: ' + expErr
    : 'ключи ' + Object.keys(expObj).join(',') + '; 58 = ' + JSON.stringify(expObj['58'])
      + '; банки: ' + CHARS.map((c) => c + '=' + expObj[c].bank).join(' '));

/* --- 7. сброс --- */
const reset = await evalJs(`(() => {
  document.getElementById('btn-reset').click();
  const b = window.__babble;
  return JSON.stringify({
    same: JSON.stringify(b.presets) === JSON.stringify(b.DEFAULTS),
    hz58: b.presets['58'].hz, wave58: b.presets['58'].wave,
    slider: document.getElementById('k-58-hz').value,
    label: document.getElementById('v-58-hz').textContent,
    waveOn: document.querySelector('.card[data-id="58"] .wv.on').dataset.w,
    dip54: document.getElementById('k-54-consonantDip').checked,
    n58: document.getElementById('ks-58-everyN').value,
    nLabel: document.getElementById('vs-58-everyN').textContent,
    cutOleg: document.getElementById('ks-oleg-cut').checked,
    srcOn: document.querySelector('.card[data-id="58"] .sw.on').dataset.src
  });
})()`);
ok('сброс возвращает стартовые пресеты и синхронизирует ручки обоих источников',
  reset.same && reset.hz58 === 130 && reset.wave58 === 'triangle' && reset.slider === '130'
  && reset.label === '130' && reset.waveOn === 'triangle' && reset.dip54 === true
  && reset.n58 === '4' && reset.nLabel === '4' && reset.cutOleg === false && reset.srcOn === 'osc',
  '58: ' + reset.wave58 + ' ' + reset.hz58 + ' Гц, ползунок ' + reset.slider + ', подсвечена ' + reset.waveOn
  + ', галка 54 ' + reset.dip54 + ', everyN 58 ' + reset.n58 + ', «обрезать» oleg ' + reset.cutOleg
  + ', источник 58 ' + reset.srcOn);

/* --- 8. реплика после сброса всё ещё играет --- */
const after = await evalJs(`(async () => {
  const b = window.__babble;
  const r = await b.play('58', undefined);
  await new Promise(res => setTimeout(res, r.durationMs + 300));
  const typed = document.querySelector('.card[data-id="58"] .said').textContent.length;
  b.stop();
  return JSON.stringify({ hz: r.hz, wave: r.wave, events: r.events, typed: typed, chars: r.chars });
})()`);
ok('после сброса реплика играет стартовым пресетом',
  after.hz === 130 && after.wave === 'triangle' && after.events > 0 && after.typed === after.chars,
  after.wave + ' ' + after.hz + ' Гц, осцилляторов ' + after.events + ', напечатано ' + after.typed + '/' + after.chars);

/* --- 9. печать реально бежит: rAF жив, а не «замер» на невидимой странице --- */
const live = await evalJs(`(async () => {
  const b = window.__babble;
  const said = () => document.querySelector('.card[data-id="57"] .said').textContent.length;
  await b.play('57', 'Длинная реплика Громилы для замера хода печати.');
  const a1 = said();
  await new Promise(r => setTimeout(r, 500));
  const a2 = said();
  await new Promise(r => setTimeout(r, 500));
  const a3 = said();
  b.stop();
  return JSON.stringify({ vis: document.visibilityState, a1: a1, a2: a2, a3: a3 });
})()`);
ok('печать идёт кадр за кадром (rAF жив, страница видима)',
  live.vis === 'visible' && live.a2 > live.a1 && live.a3 > live.a2,
  'visibilityState = ' + live.vis + ', напечатано 0/0,5/1 с: ' + live.a1 + '/' + live.a2 + '/' + live.a3);

/* ================= источник «сэмплы» ================= */

/* --- 10. встроенные банки декодируются --- */
const banks = await evalJs(`(async () => {
  const b = window.__babble;
  await b.ensureBanks();
  const bi = b.banks.builtin;
  return JSON.stringify({
    ids: Object.keys(bi).sort(),
    sizes: Object.keys(bi).sort().map(k => bi[k].length),
    durs: Object.keys(bi).sort().map(k => bi[k].map(x => +x.duration.toFixed(3))),
    rates: Object.keys(bi).sort().map(k => bi[k].map(x => x.sampleRate)),
    chans: Object.keys(bi).sort().map(k => bi[k].map(x => x.numberOfChannels)),
    custom: Object.keys(b.banks.custom).length
  });
})()`);
const allDurs = banks.durs.flat();
ok('встроенные банки декодированы: 6 буферов по 0,2–0,35 с',
  banks.ids.join(',') === '54,58' && banks.sizes.join(',') === '3,3' && allDurs.length === 6
  && allDurs.every((d) => d >= 0.2 && d <= 0.35)
  && banks.chans.flat().every((c) => c === 1) && banks.custom === 0,
  'банки ' + banks.ids.join('/') + ', длительности ' + allDurs.join(', ') + ' с, каналов '
  + banks.chans.flat().join('') + ', частота ' + banks.rates.flat()[0] + ' Гц');

/* --- 11. переключатель источника: пресет, localStorage, видимость ползунков --- */
const swUi = await evalJs(`(() => {
  const b = window.__babble;
  const vis = (sel) => [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null).length;
  const card = '.card[data-id="58"] ';
  document.querySelector(card + '.sw[data-src="samples"]').click();
  const on = {
    source: b.presets['58'].source,
    swOn: document.querySelector(card + '.sw.on').dataset.src,
    oscKnobs: vis(card + '.knobs.osc input[type=range]'),
    smpKnobs: vis(card + '.knobs.sm input[type=range]'),
    waves: vis(card + '.wv'), cons: vis(card + '.dip.cons'), drop: vis(card + '.drop'),
    stored: JSON.parse(localStorage.getItem('babble-demo-20260905-chip')).presets['58'].source
  };
  document.querySelector(card + '.sw[data-src="osc"]').click();
  const off = {
    source: b.presets['58'].source,
    oscKnobs: vis(card + '.knobs.osc input[type=range]'),
    smpKnobs: vis(card + '.knobs.sm input[type=range]'),
    waves: vis(card + '.wv'), drop: vis(card + '.drop')
  };
  // и обратно в сэмплы — дальше проверяем именно этот режим
  document.querySelector(card + '.sw[data-src="samples"]').click();
  const notes = {};
  for (const c of ['58','54','57','oleg']) notes[c] = b.bankNote(c);
  return JSON.stringify({ on: on, off: off, notes: notes });
})()`);
ok('переключатель источника прячет ползунки неактивного и сохраняется',
  swUi.on.source === 'samples' && swUi.on.swOn === 'samples' && swUi.on.stored === 'samples'
  && swUi.on.oscKnobs === 0 && swUi.on.smpKnobs === 5 && swUi.on.waves === 0 && swUi.on.cons === 0 && swUi.on.drop === 1
  && swUi.off.source === 'osc' && swUi.off.oscKnobs === 8 && swUi.off.smpKnobs === 0 && swUi.off.waves === 4 && swUi.off.drop === 0,
  'сэмплы: видно ползунков осц ' + swUi.on.oscKnobs + ', сэмпл ' + swUi.on.smpKnobs + ', волн ' + swUi.on.waves
  + ', зона файлов ' + swUi.on.drop + '; осциллятор: осц ' + swUi.off.oscKnobs + ', сэмпл ' + swUi.off.smpKnobs
  + ', волн ' + swUi.off.waves);
ok('банк подписан честно: у 57 и Олега — банк Чейза со сдвигом',
  /встроенный банк 58/.test(swUi.notes['58']) && /встроенный банк 54/.test(swUi.notes['54'])
  && /банк Чейза, сдвинут/.test(swUi.notes['57']) && /банк Чейза, сдвинут/.test(swUi.notes['oleg']),
  CHARS.map((c) => c + ': ' + swUi.notes[c]).join(' | '));

/* --- 12. play() в режиме сэмплов: ceil(символов / everyN) нод AudioBufferSourceNode --- */
const smp = await evalJs(`(async () => {
  const b = window.__babble;
  const runs = [
    ['58', 'Хранилище смотришь?', 4],
    ['58', 'Хранилище смотришь?', 1],
    ['54', 'Диспетчер, вопрос вне эфира. Вы разговариваете со мной чаще, чем с остальными.', 3],
    ['57', 'Диспетчер. Тут... ручка.', 8],
    ['oleg', 'Диспетчерская, слушаю.', 5]
  ];
  const out = [];
  for (const run of runs) {
    const cid = run[0], text = run[1], n = run[2];
    b.presets[cid].source = 'samples';
    b.presets[cid].everyN = n;
    const r = await b.play(cid, text);
    const nodes = b.debug.lastNodes;
    out.push({
      id: cid, n: n, chars: r.chars, events: r.events, expected: r.expected,
      ceil: Math.ceil(text.length / n),
      idx: b.sampleIndexes(text, n).length,
      kinds: [...new Set(nodes.map(x => x.constructor.name))],
      nodeCount: nodes.length,
      rates: nodes.map(x => +x.playbackRate.value.toFixed(5)),
      buffered: nodes.every(x => !!x.buffer),
      lo: r.pitchMin, hi: r.pitchMax, bank: r.bank, bankSize: r.bankSize,
      nodesTotal: r.nodes, source: r.source
    });
    b.stop();
  }
  return JSON.stringify(out);
})()`);
const smpBad = [];
for (const r of smp) {
  const lo = Math.min(r.lo, r.hi), hi = Math.max(r.lo, r.hi);
  const cnt = r.events === r.ceil && r.expected === r.ceil && r.idx === r.ceil
    && r.nodeCount === r.ceil && r.rates.length === r.ceil;
  const kind = r.kinds.join(',') === 'AudioBufferSourceNode' && r.buffered;
  const wired = r.nodesTotal === r.events + 2 && r.source === 'samples' && r.bankSize === 3;
  const pitch = r.rates.every((v) => v >= lo - 1e-6 && v <= hi + 1e-6);
  if (!(cnt && kind && wired && pitch)) {
    smpBad.push(r.id + '/N=' + r.n + ': ' + (cnt ? '' : 'запусков ' + r.events + ' вместо ' + r.ceil + '; ')
      + (kind ? '' : 'ноды ' + r.kinds.join(',') + '; ')
      + (wired ? '' : 'всего нод ' + r.nodesTotal + ' вместо ' + (r.events + 2) + ', банк ' + r.bankSize + '; ')
      + (pitch ? '' : 'питч вне ' + lo + '–' + hi + ': ' + Math.min(...r.rates) + '–' + Math.max(...r.rates)));
  }
}
ok('play() в режиме сэмплов: AudioBufferSourceNode, ровно ceil(символов / everyN)',
  smpBad.length === 0,
  smpBad.length ? smpBad.join(' | ')
    : smp.map((r) => r.id + ' N=' + r.n + ': ' + r.chars + ' сим → ' + r.events + ' = ceil, нод всего '
      + r.nodesTotal + ' (' + r.kinds.join(',') + '), банк ' + r.bank).join(' | '));

/* --- 13. playbackRate реально берётся из [pitchMin, pitchMax] --- */
const pitch = await evalJs(`(async () => {
  const b = window.__babble;
  const long = 'Проверка разброса высоты по всей длинной реплике диспетчерской смены, чтобы нод набралось много.';
  const grab = async (cid) => {
    const r = await b.play(cid, long);
    const rates = b.debug.lastNodes.map(x => +x.playbackRate.value.toFixed(5));
    b.stop();
    return { n: rates.length, min: Math.min(...rates), max: Math.max(...rates), lo: r.pitchMin, hi: r.pitchMax };
  };
  b.presets['58'].source = 'samples'; b.presets['58'].everyN = 1;
  b.presets['58'].pitchMin = 0.9; b.presets['58'].pitchMax = 1.05;
  const wide = await grab('58');
  b.presets['57'].source = 'samples'; b.presets['57'].everyN = 1;
  const gromila = await grab('57');           // стартовые 0,7–0,8: банк Чейза, сдвинутый вниз
  b.presets['oleg'].source = 'samples'; b.presets['oleg'].everyN = 1;
  b.presets['oleg'].pitchMin = 1.2; b.presets['oleg'].pitchMax = 1.2;
  const locked = await grab('oleg');          // схлопнутый диапазон: все ноды строго 1.2
  return JSON.stringify({ wide: wide, gromila: gromila, locked: locked });
})()`);
const inRange = (r) => r.min >= r.lo - 1e-6 && r.max <= r.hi + 1e-6;
ok('playbackRate лежит в [pitchMin, pitchMax] и реально разбросан',
  inRange(pitch.wide) && pitch.wide.max - pitch.wide.min > 0.02
  && inRange(pitch.gromila) && pitch.gromila.lo === 0.7 && pitch.gromila.hi === 0.8
  && pitch.locked.min === 1.2 && pitch.locked.max === 1.2,
  '58 при 0,9–1,05: ' + pitch.wide.n + ' нод, ' + pitch.wide.min + '–' + pitch.wide.max
  + '; 57 при ' + pitch.gromila.lo + '–' + pitch.gromila.hi + ': ' + pitch.gromila.min + '–' + pitch.gromila.max
  + '; oleg при схлопнутом 1,2: ' + pitch.locked.min + '–' + pitch.locked.max);

/* --- 14. свой банк: drag&drop, иначе прямой вызов loadCustomBank --- */
const custom = await evalJs(`(async () => {
  const b = window.__babble;
  // тот же встроенный ogg, что вшит в страницу: вытаскиваем data-URI прямо из разметки
  const m = document.documentElement.innerHTML.match(/data:audio\\/ogg;base64,[A-Za-z0-9+\\/=]+/);
  if (!m) throw new Error('в странице не нашлось ни одного встроенного ogg');
  const bin = atob(m[0].slice(m[0].indexOf(',') + 1));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);

  let path = 'drop';
  try {
    const dt = new DataTransfer();
    dt.items.add(new File([u8.slice(0)], 'so_test_1.ogg', { type: 'audio/ogg' }));
    const zone = document.querySelector('.card[data-id="oleg"] .drop');
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  } catch (e) { path = 'loadCustomBank (DataTransfer недоступен: ' + e.message + ')'; }
  for (let i = 0; i < 40 && b.bankId('oleg') !== 'custom'; i++) await new Promise(r => setTimeout(r, 50));
  if (b.bankId('oleg') !== 'custom') {
    path = 'loadCustomBank (drop не сработал)';
    await b.loadCustomBank('oleg', [u8.slice(0).buffer], ['so_test_1.ogg']);
  }

  const info = await b.loadCustomBank('57', [u8.slice(0).buffer, u8.slice(0).buffer], ['a.ogg', 'b.ogg']);
  b.presets['oleg'].source = 'samples'; b.presets['oleg'].everyN = 4;
  const r = await b.play('oleg', 'Диспетчерская, слушаю.');
  const usesCustom = b.debug.lastNodes.every(n => n.buffer === b.banks.custom['oleg'].buffers[0]);
  b.stop();
  const exported = JSON.parse(b.exportJson());
  return JSON.stringify({
    path: path,
    bankOleg: b.bankId('oleg'), bank57: b.bankId('57'), bank58: b.bankId('58'),
    sizeOleg: b.banks.custom['oleg'].buffers.length, size57: info.count,
    note: document.getElementById('bank-oleg').textContent,
    usesCustom: usesCustom, played: r.events, bankInPlay: r.bank,
    exportOleg: exported['oleg'].bank, export58: exported['58'].bank,
    exportNames: JSON.stringify(exported).indexOf('so_test_1.ogg') >= 0,
    durations: info.durations
  });
})()`);
ok('свой банк заменяет встроенный: bank = "custom", имена файлов в JSON не попадают',
  custom.bankOleg === 'custom' && custom.bank57 === 'custom' && custom.bank58 === 'builtin:58'
  && custom.sizeOleg === 1 && custom.size57 === 2 && custom.usesCustom === true
  && custom.bankInPlay === 'custom' && custom.exportOleg === 'custom' && custom.export58 === 'builtin:58'
  && custom.exportNames === false && /so_test_1\.ogg/.test(custom.note) && /до перезагрузки/.test(custom.note),
  'путь загрузки: ' + custom.path + '; oleg → ' + custom.bankOleg + ' (' + custom.sizeOleg + ' сэмпл), 57 → '
  + custom.bank57 + ' (' + custom.size57 + ', ' + custom.durations.join('/') + ' с), 58 остался ' + custom.bank58
  + '; подпись «' + custom.note + '»; имена файлов в экспорте: ' + custom.exportNames);

/* --- 15. страница с сэмплами на всех карточках всё ещё помещается в 1440×900 --- */
const fit = await evalJs(`(() => {
  const b = window.__babble;
  for (const c of b.CHARS) { b.presets[c.id].source = 'samples'; }
  document.getElementById('k-vol').dispatchEvent(new Event('input', { bubbles: true }));  // дёргаем syncUI
  return JSON.stringify({
    sources: b.CHARS.map(c => b.presets[c.id].source),
    smpVisible: [...document.querySelectorAll('.card .smp')].filter(e => e.offsetParent !== null).length,
    footBottom: Math.round(document.getElementById('foot').getBoundingClientRect().bottom),
    winH: window.innerHeight, winW: window.innerWidth,
    termOverflowY: document.getElementById('term').scrollHeight - document.getElementById('term').clientHeight,
    cardBottom: [...document.querySelectorAll('.card')].map(c => Math.round(c.getBoundingClientRect().bottom)),
    cardRight: Math.max(...[...document.querySelectorAll('.card')].map(c => Math.round(c.getBoundingClientRect().right))),
    knobClipped: [...document.querySelectorAll('.knobs')].filter(k => k.scrollHeight - k.clientHeight > 1).length,
    outClipped: [...document.querySelectorAll('.card .out')].filter(o => o.scrollHeight - o.clientHeight > 1).length,
    minFont: Math.min(...[...document.querySelectorAll('.card .knob label, .card .drop, .card .bank')]
      .map(e => parseFloat(getComputedStyle(e).fontSize)))
  });
})()`);
// Кегль не трогали: 8,5 px — тот же, что был у подписей ползунков до появления сэмплов.
ok('с сэмплами на всех карточках страница помещается в 1440×900, кегль прежний (8,5 px)',
  fit.sources.every((s) => s === 'samples') && fit.smpVisible === 4
  && fit.footBottom <= fit.winH && fit.termOverflowY <= 1
  && fit.cardBottom.every((b) => b <= fit.winH) && fit.cardRight <= fit.winW
  && fit.knobClipped === 0 && fit.outClipped === 0 && fit.minFont >= 8.5,
  'низ подвала ' + fit.footBottom + '/' + fit.winH + ', переполнение ' + fit.termOverflowY
  + ', низ карточек ' + fit.cardBottom.join('/') + ', правый край ' + fit.cardRight + '/' + fit.winW
  + ', обрезано ручек ' + fit.knobClipped + ', обрезано реплик ' + fit.outClipped
  + ', мин. кегль ' + fit.minFont + ' px');

/* --- 16. возврат к осциллятору: прежний путь снова работает --- */
const back = await evalJs(`(async () => {
  const b = window.__babble;
  b.reset();
  const r = await b.play('58', 'Хранилище смотришь?');
  const kinds = [...new Set(b.debug.lastNodes.map(n => n.constructor.name))];
  const letters = ('Хранилище смотришь?'.match(/[a-zа-яё]/gi) || []).length;
  b.stop();
  return JSON.stringify({ source: r.source, events: r.events, letters: letters, nodes: r.nodes, kinds: kinds,
    sources: b.CHARS.map(c => b.presets[c.id].source) });
})()`);
ok('после сброса источник снова «осциллятор» и звук идёт прежним путём',
  back.sources.every((s) => s === 'osc') && back.source === 'osc'
  && back.events === back.letters && back.nodes === back.events + 1
  && back.kinds.join(',') === 'OscillatorNode',
  'источники ' + back.sources.join('/') + ', осцилляторов ' + back.events + ' при ' + back.letters
  + ' буквах, нод ' + back.nodes + ' (' + back.kinds.join(',') + ')');

/* ================= мобильная раскладка ================= */
/* Ширины двух самых узких ходовых экранов; deviceScaleFactor 3 и mobile:true — чтобы
   работали медиазапросы и виртуальный вьюпорт, как на настоящем телефоне. */
const VIEWPORTS = [
  { name: '390×844', w: 390, h: 844 },
  { name: '360×740', w: 360, h: 740 },
];
const MOBILE_PROBE = `(async () => {
  const b = window.__babble;
  b.reset();                                  // стартовые пресеты: осциллятор, кнопки волн видны
  const iw = window.innerWidth;
  const rect = (e) => e.getBoundingClientRect();
  const shown = (e) => { const r = rect(e); return r.width > 0 && r.height > 0; };
  const HTMLNS = 'http://www.w3.org/1999/xhtml';
  // за правый край смотрим только по html-элементам: внутренние узлы вшитых SVG-портретов
  // обрезаны своим .pic, их собственные рамки к раскладке страницы отношения не имеют
  const outside = () => [...document.querySelectorAll('body *')]
    .filter(e => e.namespaceURI === HTMLNS && shown(e) && rect(e).right > iw + 1)
    .map(e => e.tagName.toLowerCase() + '.' + String(e.className || '').trim().split(/\\s+/)[0]
              + '@' + Math.round(rect(e).right))
    .slice(0, 6);
  const tooSmall = (sel) => [...document.querySelectorAll(sel)].filter(shown)
    .map(e => ({ id: (e.dataset.src || e.dataset.w || e.className.split(' ')[0]),
                 w: Math.round(rect(e).width), h: Math.round(rect(e).height) }))
    .filter(t => Math.min(t.w, t.h) < 44)
    .map(t => t.id + ' ' + t.w + '×' + t.h);

  const osc = {
    scrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    small: tooSmall('.card .play, .card .sw, .card .wv'),
    targets: [...document.querySelectorAll('.card .play, .card .sw, .card .wv')].filter(shown).length,
    outside: outside(),
    labelMin: Math.min(...[...document.querySelectorAll('.card .knob label, .card .head .rl, .chip')]
      .filter(shown).map(e => parseFloat(getComputedStyle(e).fontSize))),
    bodyFont: parseFloat(getComputedStyle(document.body).fontSize),
    picMax: Math.max(...[...document.querySelectorAll('.card .pic')]
      .map(e => Math.max(rect(e).width, rect(e).height))),
    rangeMinH: Math.min(...[...document.querySelectorAll('.card .knob input[type=range]')]
      .filter(shown).map(e => Math.round(rect(e).height))),
    touchAction: [...new Set([...document.querySelectorAll('input[type=range]')]
      .map(e => getComputedStyle(e).touchAction))].join(','),
    cardsPerRow: (() => {
      const tops = [...document.querySelectorAll('.card')].map(c => Math.round(rect(c).top));
      return tops.filter(t => t === tops[0]).length;         // одна колонка → 1
    })(),
    outMinH: Math.min(...[...document.querySelectorAll('.card .out')].map(e => Math.round(rect(e).height))),
    outClipped: [...document.querySelectorAll('.card .out')].filter(o => o.scrollHeight - o.clientHeight > 1).length
  };

  // режим сэмплов: появляется кнопка выбора файлов и второй набор ползунков
  for (const c of b.CHARS) b.presets[c.id].source = 'samples';
  document.getElementById('k-vol').dispatchEvent(new Event('input', { bubbles: true }));
  const smp = {
    scrollW: document.documentElement.scrollWidth,
    small: tooSmall('.card .play, .card .sw, .card .drop'),
    outside: outside(),
    dropText: (document.querySelector('.card .drop') || {}).textContent,
    dropMobShown: [...document.querySelectorAll('.card .drop .mob')].filter(shown).length,
    dropDeskShown: [...document.querySelectorAll('.card .drop .desk')].filter(shown).length,
    labelMin: Math.min(...[...document.querySelectorAll('.card .knobs.sm .knob label')]
      .filter(shown).map(e => parseFloat(getComputedStyle(e).fontSize)))
  };
  b.reset();

  // Подвал: свёрнут в <details>, раскрывается по нажатию на заголовок. Меряем сам <footer>:
  // у закрытого details содержимое остаётся размеченным (content-visibility), и его собственный
  // getBoundingClientRect соврал бы — а высота подвала на экране честная.
  const d = document.getElementById('foot-d');
  const sum = d.querySelector('summary');
  const footEl = document.querySelector('footer');
  const foot = {
    closed: d.open === false,
    sumH: Math.round(rect(sum).height),
    hClosed: Math.round(rect(footEl).height),
    pageClosed: document.documentElement.scrollHeight
  };
  sum.click();
  foot.opened = d.open === true;
  foot.hOpen = Math.round(rect(footEl).height);
  foot.pageOpen = document.documentElement.scrollHeight;
  sum.click();
  foot.closedAgain = d.open === false;

  // звук и печать: то же самое, что на десктопе
  const r = await b.play('54', 'Проверка на телефоне.');
  await new Promise(res => setTimeout(res, r.durationMs + 400));
  const play = {
    events: r.events, chars: r.chars, source: r.source, ctxState: r.ctxState,
    typed: document.querySelector('.card[data-id="54"] .said').textContent.length,
    chip: document.getElementById('chip-ctx').textContent
  };
  b.stop();
  return JSON.stringify({ iw: iw, ih: window.innerHeight, osc: osc, smp: smp, foot: foot, play: play });
})()`;

for (const vp of VIEWPORTS) {
  await send('Emulation.setDeviceMetricsOverride',
    { width: vp.w, height: vp.h, deviceScaleFactor: 3, mobile: true });
  await sleep(500);
  const m = await evalJs(MOBILE_PROBE);

  ok('нет горизонтальной прокрутки, всё внутри экрана (' + vp.name + ')',
    m.iw === vp.w && m.osc.scrollW <= m.iw && m.smp.scrollW <= m.iw && m.osc.bodyScrollW <= m.iw
    && m.osc.outside.length === 0 && m.smp.outside.length === 0 && m.osc.cardsPerRow === 1,
    'scrollWidth ' + m.osc.scrollW + ' (сэмплы ' + m.smp.scrollW + ') при innerWidth ' + m.iw
    + ', карточек в ряду ' + m.osc.cardsPerRow
    + ', за правым краем: ' + (m.osc.outside.concat(m.smp.outside).join(', ') || 'ничего'));

  ok('тач-цели ≥44 px, кегль ≥13/11 px, портрет ≤64 px (' + vp.name + ')',
    m.osc.small.length === 0 && m.smp.small.length === 0 && m.osc.targets >= 24
    && m.osc.bodyFont >= 13 && m.osc.labelMin >= 11 && m.smp.labelMin >= 11
    && m.osc.picMax <= 64 && m.osc.rangeMinH >= 32 && m.osc.touchAction === 'pan-y'
    && m.osc.outMinH >= 3 * 14 && m.osc.outClipped === 0,
    'мелких целей ' + (m.osc.small.concat(m.smp.small).join(', ') || 'нет') + ' из ' + m.osc.targets
    + ', база ' + m.osc.bodyFont + ' px, мин. подпись ' + m.osc.labelMin + ' px, портрет '
    + Math.round(m.osc.picMax) + ' px, ползунок ' + m.osc.rangeMinH + ' px (touch-action: '
    + m.osc.touchAction + '), реплика ' + m.osc.outMinH + ' px, обрезано ' + m.osc.outClipped);

  ok('подвал свёрнут и раскрывается, «выбрать файлы» вместо перетаскивания, play() и печать идут (' + vp.name + ')',
    m.foot.closed && m.foot.opened && m.foot.closedAgain && m.foot.sumH >= 44
    && m.foot.hClosed <= m.foot.sumH + 4 && m.foot.hOpen > m.foot.hClosed + 100
    && m.foot.pageOpen > m.foot.pageClosed + 100
    && m.smp.dropMobShown === 4 && m.smp.dropDeskShown === 0
    && m.play.events > 0 && m.play.typed === m.play.chars && m.play.ctxState === 'running'
    && /RUNNING/.test(m.play.chip),
    'подвал: закрыт ' + m.foot.closed + ' (' + m.foot.hClosed + ' px, страница ' + m.foot.pageClosed
    + ') → открыт ' + m.foot.opened + ' (' + m.foot.hOpen + ' px, страница ' + m.foot.pageOpen
    + '), заголовок ' + m.foot.sumH + ' px; зона файлов «' + String(m.smp.dropText).trim()
    + '» (видна «Выбрать файлы» ×' + m.smp.dropMobShown + ', «Перетащите» ×' + m.smp.dropDeskShown
    + '); play: ' + m.play.events + ' нот, напечатано '
    + m.play.typed + '/' + m.play.chars + ', шапка «' + m.play.chip + '»');
}

/* --- промежуточные ширины: до 720 одна колонка, 721–1100 две, и нигде нет горизонтальной прокрутки --- */
const SWEEP = [
  { w: 414, h: 896, cols: 1 }, { w: 480, h: 800, cols: 1 }, { w: 600, h: 900, cols: 1 },
  { w: 720, h: 900, cols: 1 }, { w: 768, h: 1024, cols: 2 }, { w: 1024, h: 768, cols: 2 },
  { w: 1100, h: 800, cols: 2 },
];
const sweepRows = [];
let sweepPass = true;
for (const s of SWEEP) {
  await send('Emulation.setDeviceMetricsOverride',
    { width: s.w, height: s.h, deviceScaleFactor: 2, mobile: s.w <= 720 });
  await sleep(250);
  const r = await evalJs(`(() => {
    const rect = (e) => e.getBoundingClientRect();
    const iw = window.innerWidth;
    const tops = [...document.querySelectorAll('.card')].map(c => Math.round(rect(c).top));
    return JSON.stringify({
      iw: iw, scrollW: document.documentElement.scrollWidth,
      cols: tops.filter(t => t === tops[0]).length,
      outside: [...document.querySelectorAll('body *')]
        .filter(e => e.namespaceURI === 'http://www.w3.org/1999/xhtml'
          && rect(e).width > 0 && rect(e).height > 0 && rect(e).right > iw + 1)
        .map(e => e.tagName.toLowerCase() + '.' + String(e.className || '').trim().split(/\\s+/)[0]).slice(0, 4)
    });
  })()`);
  const good = r.iw === s.w && r.scrollW <= r.iw && r.cols === s.cols && r.outside.length === 0;
  if (!good) sweepPass = false;
  sweepRows.push(s.w + ': ' + r.scrollW + '/' + r.iw + ' px, колонок ' + r.cols
    + (r.outside.length ? ', ЗА КРАЕМ ' + r.outside.join(',') : ''));
}
ok('на промежуточных ширинах прокрутки вбок нет, колонок 1 до 720 px и 2 до 1100 px',
  sweepPass, sweepRows.join(' | '));

/* --- скриншоты: десктоп и телефон целиком --- */
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(400);
await evalJs(`(async () => {
  const b = window.__babble;
  b.reset();
  for (const cid of ['58','57']) document.querySelector('.card[data-id="' + cid + '"] .sw[data-src="samples"]').click();
  await b.ensureBanks();
  await b.play('58', 'Хранилище смотришь?');
  await new Promise(r => setTimeout(r, 380));
  return "0";
})()`);
const deskShot = await send('Page.captureScreenshot',
  { format: 'png', clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 } });
writeFileSync(join(DIR, 'screenshot.png'), Buffer.from(deskShot.result.data, 'base64'));

await evalJs('(window.__babble.stop(), "0")');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await sleep(500);
const mobPrep = await evalJs(`(async () => {
  const b = window.__babble;
  b.reset();
  document.querySelector('.card[data-id="57"] .sw[data-src="samples"]').click();
  await b.ensureBanks();
  await b.play('58', 'Хранилище смотришь?');
  await new Promise(r => setTimeout(r, 380));
  return JSON.stringify({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth });
})()`);
const mobShot = await send('Page.captureScreenshot', {
  format: 'png', captureBeyondViewport: true,
  clip: { x: 0, y: 0, width: 390, height: Math.min(mobPrep.h, 6000), scale: 1 },
});
writeFileSync(join(DIR, 'screenshot-mobile.png'), Buffer.from(mobShot.result.data, 'base64'));
await evalJs('(window.__babble.stop(), "0")');

const shots = ['screenshot.png', 'screenshot-mobile.png'].map((f) => ({ f, size: statSync(join(DIR, f)).size }));
ok('скриншоты записаны: 1440×900 и 390×' + mobPrep.h + ' целиком',
  shots.every((s) => s.size > 20000) && mobPrep.h > 844 && mobPrep.w <= 390,
  shots.map((s) => s.f + ' ' + (s.size / 1024).toFixed(0) + ' КБ').join(', ')
  + '; высота мобильной страницы ' + mobPrep.h + ' px при ширине ' + mobPrep.w);

/* --- 17. консоль --- */
ok('нет ошибок в консоли', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' ; ') || '—');
if (consoleWarns.length) console.log('  предупреждения консоли: ' + consoleWarns.slice(0, 5).join(' ; '));

/* --- итог --- */
console.log('\n  ПРОВЕРКА ' + PAGE + '\n');
let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log('  ' + (r.pass ? 'OK  ' : 'FAIL') + '  ' + r.name + (r.note ? '\n          ' + r.note : ''));
}
console.log('\n  ' + (results.length - failed) + '/' + results.length + ' пройдено'
  + (failed ? ', ПРОВАЛОВ: ' + failed : '') + '\n');

try { await send('Page.stopScreencast'); } catch {}
ws.close();
edge.kill();
process.exit(failed ? 1 : 0);
