// Чтение MUST-инвертора через Wi-Fi логгер EyeBond (SmartESS), локально, без облака.
//
// Как это работает: логгер EyeBond сам не слушает порты — он дозванивается до облака.
// Один UDP-пакет "set>server=<IP>:<PORT>;" на порт 58899 логгера заставляет его
// подключиться к нашему TCP-серверу. Дальше по этому соединению мы шлём Modbus RTU
// (slave 4 у MUST). Встречаются две прошивки логгера, скрипт определяет её сам:
//   * "at"     — голый Modbus RTU + текстовые AT-команды (как в oleks-p/ha-eybond-local);
//   * "eybond" — заголовок [tid:2][devcode:2][len:2][addr:1][fc:1], FC=4 forward (ubombi/ha-smartess-local).
//
// Только чтение. Регистры и декодер — из must.mjs (карта ha-must-inverter).
//
// Использование:
//   node must-eybond.mjs <IP_логгера> [--host <IP_этого_Mac>] [--port 8899] [--slave 4] [--watch 15] [--json] [--debug]
import net from 'node:net';
import dgram from 'node:dgram';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { crc16modbus, modbusRead } from './solarman.mjs';
import { RANGES, decode } from './must.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let logSink = null; // внешний обработчик логов (дашборд)
const log = (...a) => {
  console.error(new Date().toISOString().slice(11, 19), ...a);
  logSink?.(a.map(String).join(' '));
};

// ---------- кадры EyeBond ----------
const FC_HEARTBEAT = 1;
const FC_FORWARD = 4;

export function eybondFrame(tid, devcode, devaddr, fc, payload) {
  const h = Buffer.alloc(8);
  h.writeUInt16BE(tid & 0xffff, 0);
  h.writeUInt16BE(devcode & 0xffff, 2);
  h.writeUInt16BE(8 + payload.length - 6, 4); // wire_len = total - 6
  h.writeUInt8(devaddr, 6);
  h.writeUInt8(fc, 7);
  return Buffer.concat([h, payload]);
}

function heartbeatPayload(interval = 60) {
  const d = new Date();
  const p = Buffer.alloc(8);
  [d.getUTCFullYear() - 2000, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
    .forEach((v, i) => p.writeUInt8(v, i));
  p.writeUInt16BE(interval, 6);
  return p;
}

/** Длина Modbus RTU ответа по первым байтам (null — пока неизвестно). */
function rtuLength(b) {
  if (b.length < 2) return null;
  if (b[1] & 0x80) return 5;
  if (b[1] === 0x03 || b[1] === 0x04) return b.length < 3 ? null : 5 + b[2];
  if (b[1] === 0x06 || b[1] === 0x10) return 8; // эхо записи
  return -1; // не похоже на ответ Modbus
}

export function parseRtuRead(f) {
  if (crc16modbus(f.subarray(0, -2)) !== f.readUInt16LE(f.length - 2)) throw new Error('Modbus: неверный CRC');
  if (f[1] & 0x80) throw new Error(`Modbus exception ${f[2]}`);
  const n = f[2] / 2;
  return Array.from({ length: n }, (_, i) => f.readUInt16BE(3 + i * 2));
}

// ---------- сессия с логгером ----------
class Session {
  constructor(sock, debug = false) {
    this.sock = sock;
    if (debug) {
      sock.on('data', (c) => log('RX', c.length, c.toString('hex'), JSON.stringify(c.toString('latin1').replace(/[^\x20-\x7e]/g, '.'))));
      const w = sock.write.bind(sock);
      sock.write = (b, ...r) => { log('TX', b.length, Buffer.from(b).toString('hex')); return w(b, ...r); };
    }
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    this.mode = null; // 'at' | 'eybond'
    this.devcode = 0;
    this.tid = 0;
    this.pn = null;
    this.closed = false;
    sock.on('data', (c) => { this.buf = Buffer.concat([this.buf, c]); this._pump(); });
    sock.on('close', () => { this.closed = true; this.waiter?.reject(new Error('логгер закрыл соединение')); });
    sock.on('error', () => {});
  }

  _pump() {
    if (!this.waiter) {
      // Незапрошенные кадры: в режиме eybond отвечаем на heartbeat логгера, остальное выбрасываем.
      if (this.mode === 'eybond') this._drainEybondUnsolicited();
      return;
    }
    try {
      const r = this.waiter.tryParse(this.buf);
      if (r) { this.buf = r.rest; const w = this.waiter; this.waiter = null; w.resolve(r.value); }
    } catch (e) { this.buf = Buffer.alloc(0); const w = this.waiter; this.waiter = null; w.reject(e); }
  }

  _drainEybondUnsolicited() {
    while (this.buf.length >= 8) {
      const total = this.buf.readUInt16BE(4) + 6;
      if (this.buf.length < total) return;
      const fc = this.buf[7];
      if (fc === FC_HEARTBEAT) this._hbReply(this.buf.subarray(0, total));
      this.buf = this.buf.subarray(total);
    }
  }

  _hbReply(frame) {
    this.pn = frame.subarray(8, 22).toString('ascii').replace(/\0+$/, '').trim() || this.pn;
    this.devcode = frame.readUInt16BE(2) || this.devcode;
  }

  _request(bytes, tryParse, timeoutMs) {
    if (this.closed) return Promise.reject(new Error('соединение закрыто'));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { if (this.waiter?.id === id) { this.waiter = null; reject(new Error('timeout')); } }, timeoutMs);
      const id = Symbol();
      this.waiter = {
        id, tryParse,
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      };
      this.sock.write(bytes);
      this._pump();
    });
  }

  /** Определяет прошивку логгера: сперва AT, затем EyeBond heartbeat. */
  async detect() {
    try {
      const pn = await this._request(Buffer.from('AT+DTUPN?\r\n'), (b) => {
        const i = b.indexOf('AT+DTUPN:');
        if (i < 0) return null;
        const end = b.indexOf('\r\n', i);
        if (end < 0) return null;
        return { value: b.subarray(i + 9, end).toString('ascii').trim(), rest: b.subarray(end + 2) };
      }, 4000);
      this.mode = 'at'; this.pn = pn;
      return;
    } catch { /* не AT-прошивка или молчит — пробуем EyeBond */ }
    await sleep(500);
    this.buf = Buffer.alloc(0);
    const tid = ++this.tid;
    await this._request(eybondFrame(tid, 0, 1, FC_HEARTBEAT, heartbeatPayload()), (b) => {
      if (b.length < 8) return null;
      const total = b.readUInt16BE(4) + 6;
      if (total < 8 || total > 1024) throw new Error('непонятный ответ на heartbeat: ' + b.subarray(0, 16).toString('hex'));
      if (b.length < total) return null;
      if (b[7] !== FC_HEARTBEAT) return { value: null, rest: b.subarray(total) };
      this._hbReply(b.subarray(0, total));
      return { value: true, rest: b.subarray(total) };
    }, 6000);
    this.mode = 'eybond';
  }

  async readRegisters(slave, start, count, timeoutMs = 6000) {
    return parseRtuRead(await this._rtu(modbusRead(slave, start, count), timeoutMs));
  }

  /** Modbus FC=06 (запись одного регистра). Возвращает true, если инвертор вернул эхо. */
  async writeRegister(slave, address, value, timeoutMs = 8000) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error('значение вне 0..65535');
    const pdu = Buffer.alloc(6);
    pdu.writeUInt8(slave, 0); pdu.writeUInt8(0x06, 1);
    pdu.writeUInt16BE(address, 2); pdu.writeUInt16BE(value, 4);
    const frame = Buffer.concat([pdu, Buffer.alloc(2)]);
    frame.writeUInt16LE(crc16modbus(pdu), 6);
    const r = await this._rtu(frame, timeoutMs);
    if (crc16modbus(r.subarray(0, -2)) !== r.readUInt16LE(r.length - 2)) throw new Error('Modbus: неверный CRC');
    if (r[1] & 0x80) throw new Error(`инвертор отклонил запись (Modbus exception ${r[2]})`);
    if (r[1] !== 0x06 || r.readUInt16BE(2) !== address || r.readUInt16BE(4) !== value) throw new Error('неожиданный ответ на запись: ' + r.toString('hex'));
    return true;
  }

  /** Отправляет RTU-кадр и возвращает сырой RTU-ответ (в обеих прошивках логгера). */
  async _rtu(rtu, timeoutMs) {
    if (this.mode === 'at') {
      return this._request(rtu, (b) => {
        // пропускаем возможные AT-строки (heartbeat логгера)
        while (b.subarray(0, 3).toString() === 'AT+') {
          const e = b.indexOf('\r\n'); if (e < 0) return null; b = b.subarray(e + 2);
        }
        const len = rtuLength(b);
        if (len === null || (len > 0 && b.length < len)) return null;
        if (len < 0) throw new Error('не Modbus-ответ: ' + b.subarray(0, 16).toString('hex'));
        return { value: Buffer.from(b.subarray(0, len)), rest: b.subarray(len) };
      }, timeoutMs);
    }
    const tid = ++this.tid;
    return this._request(eybondFrame(tid, this.devcode, 1, FC_FORWARD, rtu), (b) => {
      while (b.length >= 8) {
        const total = b.readUInt16BE(4) + 6;
        if (b.length < total) return null;
        const frame = b.subarray(0, total);
        b = b.subarray(total);
        if (frame[7] === FC_HEARTBEAT) { this._hbReply(frame); continue; }
        if (frame[7] !== FC_FORWARD || frame.readUInt16BE(0) !== (tid & 0xffff)) continue;
        const payload = frame.subarray(8);
        if (payload.length < 5) throw new Error('пустой ответ от инвертора (проверьте slave id)');
        return { value: Buffer.from(payload), rest: b };
      }
      return null;
    }, timeoutMs);
  }

  close() { this.sock.destroy(); }
}

// ---------- сеть ----------
function guessLocalIp(target) {
  const prefix = target.split('.').slice(0, 3).join('.') + '.';
  const all = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
  return (all.find((i) => i.address.startsWith(prefix)) || all[0])?.address;
}

function announce(loggerIp, host, port) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const msg = Buffer.from(`set>server=${host}:${port};`);
    s.send(msg, 58899, loggerIp, (e) => { s.close(); e ? reject(e) : resolve(msg.toString()); });
  });
}

// noAnnounce: режим сервера в интернете — логгер уже перенаправлен (announce.mjs с домашнего ПК),
//             мы только ждём его входящих подключений.
// allowIps:   с каких IP принимать логгер (на VPS это внешний IP дома). Пусто + noAnnounce — любой.
export async function run({ loggerIp, host, port = 8899, slave = 4, watch = 0, json = false, debug = false,
  onData, onLog, onReady, signal, noAnnounce = false, allowIps = null }) {
  if (onLog) logSink = onLog;
  if (!noAnnounce) {
    host ||= guessLocalIp(loggerIp);
    if (!host) throw new Error('не удалось определить IP этого компьютера, укажите --host');
  }
  const allowed = allowIps?.length ? new Set(allowIps) : noAnnounce ? null : new Set([loggerIp]);

  // Очередь входящих подключений логгера: он сам переподключается каждые ~3 с после разрыва.
  const queue = [];
  let notify = null;
  const server = net.createServer((sock) => {
    const ip = sock.remoteAddress?.replace('::ffff:', '');
    if (allowed && !allowed.has(ip)) { log('чужое подключение от', ip, '— закрыто'); sock.destroy(); return; }
    sock.setNoDelay(true);
    queue.push(sock);
    notify?.();
  });
  const nextSocket = (ms) => new Promise((resolve) => {
    const take = () => {
      while (queue.length) { const s = queue.shift(); if (!s.destroyed) { notify = null; clearTimeout(t); return resolve(s); } }
      return false;
    };
    const t = setTimeout(() => { notify = null; resolve(null); }, ms);
    if (take() === false) notify = take;
  });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(port, '0.0.0.0', res); });
  log(`TCP-сервер слушает ${host || '0.0.0.0'}:${port}`);

  let announced = false;
  const connect = async () => {
    // Сначала ждём, не подключится ли логгер сам (перенаправление «липкое»).
    // UDP шлём, только если он молчит: каждый announce рвёт его текущую сессию.
    if (noAnnounce) {
      const s = await nextSocket(120000);
      if (!s) throw new Error('логгер не подключился за 2 мин — он перенаправлен на этот сервер? (announce.mjs), открыт ли порт');
      return startSession(s);
    }
    let sock = await nextSocket(announced ? 30000 : 12000);
    if (!sock) {
      log('логгер молчит — UDP →', `${loggerIp}:58899`, await announce(loggerIp, host, port));
      announced = true;
      sock = await nextSocket(45000);
    }
    if (!sock) throw new Error('логгер не подключился — проверьте IP, firewall macOS (разрешите входящие для node) и что Mac в той же сети');
    return startSession(sock);
  };
  const startSession = async (sock) => {
    // Если логгер успел открыть несколько соединений — берём самое свежее.
    await sleep(1500);
    while (queue.length) { const newer = queue.shift(); if (!newer.destroyed) { sock.destroy(); sock = newer; } }
    if (sock.destroyed) return connect();
    log('логгер подключился с', sock.remoteAddress);
    const sess = new Session(sock, debug);
    try { await sess.detect(); } catch (e) { sess.close(); throw new Error('не удалось определить прошивку: ' + e.message); }
    log(`прошивка: ${sess.mode}, PN: ${sess.pn ?? '—'}${sess.mode === 'eybond' ? `, devcode: 0x${sess.devcode.toString(16)}` : ''}`);
    return sess;
  };

  let sess = null;
  // Все обращения к логгеру — строго по одному (он отвечает по порядку, без id транзакций)
  let chain = Promise.resolve();
  const exclusive = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const live = () => { if (!sess || sess.closed) throw new Error('нет связи с логгером'); return sess; };
  onReady?.({
    read: (start, count) => exclusive(() => live().readRegisters(slave, start, count)),
    write: (address, value) => exclusive(async () => {
      const s = live();
      await s.writeRegister(slave, address, value);
      await sleep(400);
      const [back] = await s.readRegisters(slave, address, 1);
      return back;
    }),
    connected: () => !!sess && !sess.closed,
  });
  const pollOnce = () => exclusive(async () => {
    const regs = {};
    for (const [a, b] of RANGES) {
      const values = await sess.readRegisters(slave, a, b - a + 1);
      values.forEach((v, i) => { regs[a + i] = v; });
      await sleep(300);
    }
    const data = decode(regs);
    if (onData) onData({ ts: Date.now(), pn: sess.pn, ...data });
    else if (json) console.log(JSON.stringify({ ts: new Date().toISOString(), ...data }));
    else console.table(data);
  });

  let failures = 0;
  let done = false;
  try {
    while (!done && !signal?.aborted) {
      try {
        if (!sess || sess.closed) sess = await connect();
        await pollOnce();
        failures = 0;
        if (!watch) done = true;
      } catch (e) {
        failures++;
        log(`ошибка (${failures}/5):`, e.message);
        if (failures >= 5) {
          if (!onData) throw new Error('5 неудач подряд — запустите с --debug и пришлите вывод');
          log('5 неудач подряд — переподключаюсь');      // сервисный режим: не падаем
          sess?.close(); sess = null; failures = 0; await sleep(10000);
        }
        if (sess && !sess.closed && /timeout/.test(e.message)) await sleep(3000); // поздний ответ — выбросим
        if (sess) sess.buf = Buffer.alloc(0);
        continue;
      }
      if (watch) await sleep(watch * 1000);
    }
  } finally {
    sess?.close();
    server.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const loggerIp = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  if (!loggerIp) {
    console.error('Usage: node must-eybond.mjs <IP_логгера> [--host <IP_Mac>] [--port 8899] [--slave 4] [--watch 15] [--json] [--debug]');
    process.exit(2);
  }
  run({
    loggerIp,
    host: opt('host'),
    port: Number(opt('port', 8899)),
    slave: Number(opt('slave', 4)),
    watch: Number(opt('watch', 0)),
    json: argv.includes('--json'),
    debug: argv.includes('--debug'),
  }).catch((e) => { log('Ошибка:', e.message); process.exit(1); });
}
