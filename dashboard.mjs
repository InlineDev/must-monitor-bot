// Локальный дашборд MUST-инвертора: опрос через EyeBond-логгер + HTTP + SSE.
// Без зависимостей. История пишется в data/history-YYYY-MM-DD.jsonl.
//
// Дома (Mac в той же сети):
//   node dashboard.mjs <IP_логгера> [--interval 15] [--http 3000] [--host <IP_Mac>] [--slave 4]
// На сервере в интернете (логгер перенаправлен командой announce.mjs):
//   DASH_USER=admin DASH_PASS=секрет node dashboard.mjs --no-announce --allow <внешний_IP_дома> [--http-host 127.0.0.1]
// Любой флаг можно задать переменной окружения: --allow → ALLOW, --http → HTTP_PORT и т.д. (см. ниже).
// Управление инвертором включается PIN-кодом: --control-pin 1234 (или CONTROL_PIN). Без PIN — только просмотр.
// Telegram-бот: --telegram-token <токен от @BotFather> (или TELEGRAM_TOKEN).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './must-eybond.mjs';
import { startTelegram } from './telegram.mjs';
import { CONTROLS, CONTROL_RANGES, describe, getControl, toRaw, toDisplay, formatValue } from './controls.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(DIR, 'data');
const HISTORY_MS = 48 * 3600 * 1000;

const argv = process.argv.slice(2);
const BOOL = new Set(['--no-announce']);
const opt = (n, env, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : process.env[env] ?? d; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1]?.startsWith('--') && !BOOL.has(argv[i - 1])));
const noAnnounce = argv.includes('--no-announce') || process.env.NO_ANNOUNCE === '1';
const loggerIp = positional[0] || process.env.LOGGER_IP;
if (!loggerIp && !noAnnounce) {
  console.error('Usage: node dashboard.mjs <IP_логгера> [--interval 15] [--http 3000] [--host <IP_Mac>] [--slave 4]\n' +
    '       node dashboard.mjs --no-announce --allow <IP_дома>   (сервер в интернете)');
  process.exit(2);
}
const interval = Number(opt('interval', 'INTERVAL', 15));
const httpPort = Number(opt('http', 'HTTP_PORT', 3000));
const httpHost = opt('http-host', 'HTTP_HOST', '0.0.0.0');
const allowIps = (opt('allow', 'ALLOW', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
const AUTH_USER = process.env.DASH_USER, AUTH_PASS = process.env.DASH_PASS;
if (noAnnounce && !AUTH_PASS) console.error('ВНИМАНИЕ: дашборд без пароля. Задайте DASH_USER и DASH_PASS.');
const CONTROL_PIN = opt('control-pin', 'CONTROL_PIN', '') || '';
if (CONTROL_PIN && CONTROL_PIN.length < 4) { console.error('PIN должен быть не короче 4 символов'); process.exit(2); }
console.error(CONTROL_PIN ? 'управление: включено (по PIN)' : 'управление: выключено (запустите с --control-pin, чтобы включить)');
if (noAnnounce && !allowIps.length) console.error('ВНИМАНИЕ: --allow не задан — порт логгера примет подключение с любого IP.');

// ---------- история ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const dayFile = (t) => path.join(DATA_DIR, `history-${new Date(t).toISOString().slice(0, 10)}.jsonl`);

// Хранимые в истории поля (компактно; полный снимок — только последний)
const SERIES = ['pvPower_W', 'loadPower_W', 'gridPower_W', 'batteryPower_W', 'batteryVoltage_V',
  'inverterBatteryVoltage_V', 'pvVoltage_V', 'gridVoltage_V', 'inverterVoltage_V', 'dcRadiatorTemp_C', 'acRadiatorTemp_C'];

const history = [];
for (const f of fs.readdirSync(DATA_DIR).filter((n) => n.endsWith('.jsonl')).sort()) {
  for (const line of fs.readFileSync(path.join(DATA_DIR, f), 'utf8').split('\n')) {
    if (!line) continue;
    try { const p = JSON.parse(line); if (p.ts > Date.now() - HISTORY_MS) history.push(p); } catch { /* битая строка */ }
  }
}
console.error(`история: загружено ${history.length} точек`);

let latest = null;
const logs = [];
const status = { connected: false, lastOk: null, lastError: null, pn: null, interval };

// ---------- SSE ----------
const clients = new Set();
function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(msg);
}

function onData(d) {
  latest = d;
  status.connected = true;
  status.lastOk = d.ts;
  status.pn = d.pn;
  const point = { ts: d.ts };
  for (const k of SERIES) point[k] = d[k];
  history.push(point);
  while (history.length && history[0].ts < Date.now() - HISTORY_MS) history.shift();
  fs.appendFile(dayFile(d.ts), JSON.stringify(point) + '\n', () => {});
  broadcast('data', { latest: d, point, status });
  if (!ctl.updatedAt || Date.now() - ctl.updatedAt > 65000) refreshControls();
  bot?.onData(d);
}

function onLog(line) {
  const entry = { ts: Date.now(), line };
  logs.push(entry);
  if (logs.length > 200) logs.shift();
  if (/ошибка|не удалось|закрыл|закрыто|timeout/i.test(line)) { status.lastError = entry; status.connected = false; }
  if (/подключился/.test(line)) status.connected = true;
  broadcast('log', { entry, status });
}

// ---------- управление ----------
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');
const audit = [];
try {
  for (const l of fs.readFileSync(AUDIT_FILE, 'utf8').split('\n')) if (l) { try { audit.push(JSON.parse(l)); } catch {} }
} catch {}
let inverter = null;            // API из run(): read/write/connected
const ctl = { registers: {}, updatedAt: null, error: null };

async function refreshControls() {
  if (!inverter?.connected()) return;
  try {
    for (const [a, b] of CONTROL_RANGES) {
      const vals = await inverter.read(a, b - a + 1);
      vals.forEach((v, i) => { ctl.registers[a + i] = v; });
    }
    ctl.updatedAt = Date.now(); ctl.error = null;
    broadcast('controls', controlsPayload());
  } catch (e) { ctl.error = e.message; }
}
setInterval(refreshControls, 60000);

function controlsPayload() {
  return {
    enabled: !!CONTROL_PIN, connected: !!inverter?.connected(), updatedAt: ctl.updatedAt, error: ctl.error,
    battVolGrade: latest?.battVolGrade ?? null,
    items: ctl.updatedAt ? describe(ctl.registers, latest?.battVolGrade) : [],
    audit: audit.slice(-15).reverse(),
  };
}

const pinFails = new Map();
function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > limit) { reject(new Error('слишком большой запрос')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('неверный JSON')); } });
  });
}

let writing = false;
async function handleControl(req, res) {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  // защита от CSRF: только JSON и только со своей страницы
  const origin = req.headers.origin;
  if (!String(req.headers['content-type'] || '').startsWith('application/json') || (origin && new URL(origin).host !== req.headers.host)) {
    return send(403, { error: 'запрос отклонён' });
  }
  if (!CONTROL_PIN) return send(403, { error: 'управление выключено: запустите дашборд с --control-pin' });
  const ip = clientIp(req), f = pinFails.get(ip);
  if (f && f.until > Date.now()) return send(429, { error: `слишком много неверных PIN, подождите ${Math.ceil((f.until - Date.now()) / 60000)} мин` });

  let body;
  try { body = await readJson(req); } catch (e) { return send(400, { error: e.message }); }
  if (!safeEqual(body.pin ?? '', CONTROL_PIN)) {
    const n = (f?.n || 0) + 1;
    pinFails.set(ip, { n, until: n >= 3 ? Date.now() + Math.min(2 ** (n - 3), 60) * 60000 : 0 }); // 3 ошибки → бан 1, 2, 4… мин
    console.error(`control: неверный PIN с ${ip} (${n})`);
    return send(401, { error: 'неверный PIN' });
  }
  pinFails.delete(ip);

  const r = await applyControl(body.key, body.value, { ip, user: AUTH_PASS ? (AUTH_USER || 'admin') : null });
  send(r.status, r.entry || { error: r.error });
}

/** Общая запись настройки (веб и Telegram): белый список, диапазон, запись, чтение обратно, журнал. */
async function applyControl(key, value, who) {
  const c = getControl(key);
  if (!c) return { status: 400, error: 'эта настройка не разрешена' };
  if (!inverter?.connected()) return { status: 503, error: 'нет связи с логгером' };
  if (writing) return { status: 409, error: 'другая запись ещё выполняется' };
  if (!ctl.updatedAt) return { status: 503, error: 'настройки ещё не прочитаны с инвертора' };

  let raw;
  try { raw = toRaw(c, value, latest?.battVolGrade); } catch (e) { return { status: 400, error: e.message }; }
  const bad = c.check?.(raw, ctl.registers);
  if (bad) return { status: 400, error: bad };
  const beforeRaw = ctl.registers[c.address];
  const entry = { ts: Date.now(), ip: who.ip ?? null, user: who.user ?? null, via: who.via || 'web', key: c.key, label: c.label,
    before: formatValue(c, toDisplay(c, beforeRaw)), requested: formatValue(c, toDisplay(c, raw)) };

  writing = true;
  try {
    if (beforeRaw === raw || (c.type === 'switch' && toDisplay(c, beforeRaw) === toDisplay(c, raw))) { entry.after = entry.before; entry.ok = true; entry.note = 'значение уже установлено'; }
    else {
      const back = await inverter.write(c.address, raw);
      ctl.registers[c.address] = back;
      entry.after = formatValue(c, toDisplay(c, back));
      entry.ok = back === raw || (c.type === 'switch' && toDisplay(c, back) === toDisplay(c, raw));
      if (!entry.ok) entry.note = 'инвертор принял команду, но значение не изменилось';
    }
  } catch (e) {
    entry.ok = false; entry.error = e.message;
  } finally { writing = false; }

  audit.push(entry);
  if (audit.length > 500) audit.shift();
  fs.appendFile(AUDIT_FILE, JSON.stringify(entry) + '\n', () => {});
  onLog(`управление (${entry.via}): ${entry.label}: ${entry.before} → ${entry.requested} — ${entry.ok ? 'OK' : 'ОШИБКА ' + (entry.error || entry.note)}`);
  broadcast('controls', controlsPayload());
  return { status: entry.ok ? 200 : 502, entry };
}

// ---------- HTTP ----------
// ---------- Basic Auth + ограничение попыток ----------
const fails = new Map(); // ip -> { n, until }
function clientIp(req) {
  // за reverse proxy (Caddy/nginx на этом же хосте) берём X-Forwarded-For
  const fwd = req.socket.remoteAddress?.startsWith('127.') || req.socket.remoteAddress === '::1' ? req.headers['x-forwarded-for'] : null;
  return (fwd?.split(',')[0].trim() || req.socket.remoteAddress || '').replace('::ffff:', '');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function authorized(req, res) {
  if (!AUTH_PASS) return true;
  const ip = clientIp(req), f = fails.get(ip);
  if (f && f.until > Date.now()) { res.writeHead(429, { 'retry-after': Math.ceil((f.until - Date.now()) / 1000) }).end('Слишком много попыток'); return false; }
  const [scheme, b64] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && b64) {
    const [u, ...rest] = Buffer.from(b64, 'base64').toString().split(':');
    if (safeEqual(u, AUTH_USER || 'admin') && safeEqual(rest.join(':'), AUTH_PASS)) { fails.delete(ip); return true; }
    const n = (f?.n || 0) + 1;
    fails.set(ip, { n, until: n >= 5 ? Date.now() + Math.min(2 ** (n - 5), 60) * 60000 : 0 }); // 5 ошибок → бан 1, 2, 4… до 60 мин
    console.error(`auth: неверный пароль с ${ip} (${n})`);
  }
  res.writeHead(401, { 'www-authenticate': 'Basic realm="MUST", charset="UTF-8"' }).end('Нужен пароль');
  return false;
}

const server = http.createServer((req, res) => {
  if (!authorized(req, res)) return;
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(path.join(DIR, 'dashboard.html')).pipe(res);
    return;
  }
  if (url.pathname === '/api/state') {
    const since = Number(url.searchParams.get('since') || 0);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ latest, status, logs: logs.slice(-30), history: history.filter((p) => p.ts >= since) }));
    return;
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (url.pathname === '/api/controls' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(controlsPayload()));
    return;
  }
  if (url.pathname === '/api/control' && req.method === 'POST') { handleControl(req, res); return; }
  if (url.pathname === '/api/export.csv') {
    const cols = ['ts', ...SERIES];
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="must-history.csv"' });
    res.end([cols.join(','), ...history.map((p) => cols.map((c) => (c === 'ts' ? new Date(p.ts).toISOString() : p[c] ?? '')).join(','))].join('\n'));
    return;
  }
  res.writeHead(404).end('not found');
});
server.listen(httpPort, httpHost, () => console.error(`дашборд: http://${httpHost === '0.0.0.0' ? 'localhost' : httpHost}:${httpPort}${AUTH_PASS ? ' (с паролем)' : ''}`));

// ---------- опрос ----------
const ac = new AbortController();

// ---------- Telegram ----------
const TG_TOKEN = opt('telegram-token', 'TELEGRAM_TOKEN', '');
var bot = TG_TOKEN ? startTelegram({
  token: TG_TOKEN, dataDir: DATA_DIR, signal: ac.signal, log: onLog,
  getLatest: () => latest, getStatus: () => status, getHistory: () => history,
  getControls: () => controlsPayload(), applyControl,
}) : null;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { ac.abort(); server.close(); setTimeout(() => process.exit(0), 300); });

(async function loop() {
  while (!ac.signal.aborted) {
    try {
      await run({
        loggerIp, host: opt('host', 'HOST'), port: Number(opt('port', 'LOGGER_PORT', 8899)), slave: Number(opt('slave', 'SLAVE', 4)),
        watch: interval, onData, onLog, signal: ac.signal, noAnnounce, allowIps,
        onReady: (api) => { inverter = api; },
      });
    } catch (e) {
      onLog('Ошибка: ' + e.message + ' — повтор через 30 с');
      await new Promise((r) => setTimeout(r, 30000));
    }
  }
})();
