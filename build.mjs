#!/usr/bin/env node
/**
 * Сборка самодостаточной демо-страницы бубнежа (осциллятор на букву + сэмплы «как в Aurelia»).
 *
 *   node build.mjs   →   index.html
 *
 * Страница открывается по file://, где fetch запрещён, поэтому ни одного внешнего запроса
 * и ни одной относительной ссылки на медиа: портреты вшиваются inline-SVG, встроенные банки
 * мычания — data:audio/ogg;base64. Сэмплы Aurelia (so_*.ogg из Steam) не вшиваются никогда —
 * это чужой ассет; разработчик перетаскивает их на карточку сам.
 */
import { readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 512 * 1024;
const PORTRAIT_DIR = resolve(DIR, '..', 'voices-20260905', 'portraits');
const CHAR_IDS = ['58', '54', '57', 'oleg'];
/** Встроенные банки: у кого есть свои вырезанные «мх». 57 и oleg играют банк 58 со сдвигом питча. */
const HUM_BANKS = { '58': [1, 2, 3], '54': [1, 2, 3] };
const HUM_MAX_BYTES = 64 * 1024;   // один сэмпл 0,2–0,35 с — заведомо меньше

const fail = (msg) => { console.error('\n  ОШИБКА СБОРКИ: ' + msg + '\n'); process.exit(1); };

/* ---------- портреты ---------- */
const portraits = {};
for (const id of CHAR_IDS) {
  const p = join(PORTRAIT_DIR, id + '.svg');
  if (!existsSync(p)) { console.warn('  ! нет портрета ' + id + '.svg — на карточке будет текстовая заглушка'); continue; }
  const svg = readFileSync(p, 'utf8').replace(/<\?xml[^>]*\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '').trim();
  if (!/^<svg[\s>]/i.test(svg)) fail('портрет не начинается с <svg>: ' + p);
  portraits[id] = svg;
}

/* ---------- встроенные банки мычания ----------
   Битый или подменённый файл лучше уронить сборку, чем молча дать странице тишину:
   decodeAudioData в браузере отвалился бы уже без внятного сообщения. */
const hums = {};
let humBytes = 0;
for (const [bank, nums] of Object.entries(HUM_BANKS)) {
  hums[bank] = [];
  for (const n of nums) {
    const p = join(DIR, 'hums', bank, n + '.ogg');
    if (!existsSync(p)) fail('нет встроенного сэмпла ' + p + ' — банк ' + bank + ' неполон');
    const buf = readFileSync(p);
    if (buf.length < 64) fail('сэмпл пустой или обрезан: ' + p + ' (' + buf.length + ' Б)');
    if (buf.length > HUM_MAX_BYTES) fail('сэмпл ' + p + ' — ' + buf.length + ' Б, больше лимита ' + HUM_MAX_BYTES + ' Б; это не короткое «мх»');
    if (buf.subarray(0, 4).toString('latin1') !== 'OggS') {
      fail('файл ' + p + ' не Ogg: первые четыре байта «' + buf.subarray(0, 4).toString('latin1') + '», ожидалось «OggS»');
    }
    hums[bank].push('data:audio/ogg;base64,' + buf.toString('base64'));
    humBytes += buf.length;
  }
}

/* ---------- сборка ---------- */
/** JSON внутри <script>: закрывающий тег и разделители строк не должны выжить. */
const embed = (v) => JSON.stringify(v)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const build = { date: new Date().toISOString().slice(0, 16).replace('T', ' ') };

let page = readFileSync(join(DIR, 'page.html'), 'utf8');
const put = (marker, value) => {
  if (!page.includes(marker)) fail('в page.html нет метки ' + marker);
  page = page.replace(marker, () => value);   // функция: «$&» в base64/SVG не должно раскрываться
};
put('/*__BUILD__*/ {date:"?"}', embed(build));
put('/*__PORTRAITS__*/ {}', embed(portraits));
put('/*__HUMS__*/ {}', embed(hums));

// Метки способов 1/2/4 больше не должны всплывать: осциллятор и сэмплы — всё, что осталось.
for (const dead of ['__BANKS__', '__SAMJS__', 'SamJs', 'BANKS_B64']) {
  if (page.includes(dead)) fail('в странице остался хвост снятых способов: ' + dead);
}
// Чужие ассеты в страницу не попадают ни при каких правках.
if (/so_[a-z0-9_]*\.ogg/i.test(page.replace(/Aurelia\/so_\*\.ogg/g, ''))) fail('в странице оказался файл Aurelia so_*.ogg');
const oggCount = (page.match(/data:audio\/ogg;base64,/g) || []).length;
if (oggCount !== 6) fail('вшито ' + oggCount + ' сэмплов вместо 6');

const out = join(DIR, 'index.html');
writeFileSync(out, page, 'utf8');
const size = statSync(out).size;
if (size > MAX_BYTES) fail('index.html ' + (size / 1024).toFixed(0) + ' КБ — больше лимита ' + (MAX_BYTES / 1024) + ' КБ');

console.log('  index.html: ' + (size / 1024).toFixed(0) + ' КБ');
console.log('  портреты: ' + (Object.keys(portraits).join(', ') || 'нет'));
console.log('  банки мычания: ' + Object.entries(hums).map(([b, a]) => b + '×' + a.length).join(', ')
  + ' (' + (humBytes / 1024).toFixed(0) + ' КБ ogg → ' + ((humBytes * 4 / 3) / 1024).toFixed(0) + ' КБ base64)');
console.log('  сборка ' + build.date);
