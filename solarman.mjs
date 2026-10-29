// Solarman V5 (Wi-Fi логгер, порт 8899) -> Modbus RTU клиент без зависимостей.
// Использование: node solarman.mjs <ip> <serial> [startReg=0] [count=10] [slave=1]
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const CTRL_REQUEST = 0x4510;
const CTRL_RESPONSE = 0x1510;

export function crc16modbus(buf) {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

export function modbusRead(slave, start, count, fn = 0x03) {
  const pdu = Buffer.alloc(6);
  pdu.writeUInt8(slave, 0);
  pdu.writeUInt8(fn, 1);
  pdu.writeUInt16BE(start, 2);
  pdu.writeUInt16BE(count, 4);
  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(crc16modbus(pdu));
  return Buffer.concat([pdu, crc]);
}

function checksum(frame) {
  let sum = 0;
  for (let i = 1; i < frame.length - 2; i++) sum = (sum + frame[i]) & 0xff;
  return sum;
}

export function v5Frame(serial, seq, modbus) {
  const payload = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(14), modbus]);
  const frame = Buffer.alloc(11 + payload.length + 2);
  frame.writeUInt8(0xa5, 0);
  frame.writeUInt16LE(payload.length, 1);
  frame.writeUInt16LE(CTRL_REQUEST, 3);
  frame.writeUInt16LE(seq & 0xffff, 5);
  frame.writeUInt32LE(serial >>> 0, 7);
  payload.copy(frame, 11);
  frame[frame.length - 1] = 0x15;
  frame[frame.length - 2] = checksum(frame);
  return frame;
}

/**
 * Достаёт из накопленного буфера следующий полный V5-кадр.
 * Возвращает { frame, rest } или null, если данных пока мало.
 * Мусор до 0xA5 отбрасывается.
 */
export function takeFrame(acc) {
  const startIdx = acc.indexOf(0xa5);
  if (startIdx < 0) return { frame: null, rest: Buffer.alloc(0) };
  if (startIdx > 0) acc = acc.subarray(startIdx);
  if (acc.length < 3) return null;
  const total = 11 + acc.readUInt16LE(1) + 2;
  if (acc.length < total) return null;
  return { frame: acc.subarray(0, total), rest: acc.subarray(total) };
}

/** Разбирает V5-ответ. Возвращает массив регистров или null для keep-alive / чужих кадров. */
export function parseResponse(frame, { serial, seq } = {}) {
  if (frame[0] !== 0xa5 || frame[frame.length - 1] !== 0x15) throw new Error('V5: неверные start/end байты');
  if (checksum(frame) !== frame[frame.length - 2]) throw new Error('V5: неверная контрольная сумма');
  const ctrl = frame.readUInt16LE(3);
  if (ctrl !== CTRL_RESPONSE) return null; // 0x4710 keep-alive и прочее — пропускаем
  if (seq !== undefined && frame[5] !== (seq & 0xff)) return null;
  if (serial !== undefined && frame.readUInt32LE(7) !== serial >>> 0) throw new Error('V5: серийный номер логгера не совпал');
  const rtu = frame.subarray(11 + 14, frame.length - 2);
  if (rtu.length < 5) throw new Error('V5: пустой Modbus-ответ (часто — неверный serial или slave id)');
  if (crc16modbus(rtu.subarray(0, -2)) !== rtu.readUInt16LE(rtu.length - 2)) throw new Error('Modbus: неверный CRC');
  if (rtu[1] & 0x80) throw new Error(`Modbus exception ${rtu[2]}`);
  const n = rtu[2] / 2;
  return Array.from({ length: n }, (_, i) => rtu.readUInt16BE(3 + i * 2));
}

let seqCounter = Math.floor(Math.random() * 0xff);

export function readRegisters({ ip, serial, start, count, slave = 1, port = 8899, timeoutMs = 5000, fn = 0x03 }) {
  const seq = (seqCounter = (seqCounter + 1) & 0xff);
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, ip);
    let acc = Buffer.alloc(0);
    const fail = (e) => { sock.destroy(); reject(e); };
    sock.setTimeout(timeoutMs, () => fail(new Error('timeout')));
    sock.on('connect', () => sock.write(v5Frame(serial, seq, modbusRead(slave, start, count, fn))));
    sock.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      try {
        for (let t = takeFrame(acc); t; t = takeFrame(acc)) {
          acc = t.rest;
          if (!t.frame) break;
          const regs = parseResponse(t.frame, { serial, seq });
          if (regs) { sock.end(); return resolve(regs); }
        }
      } catch (e) { fail(e); }
    });
    sock.on('error', reject);
  });
}

// Хелперы декодирования
export const int16 = (v) => (v > 0x7fff ? v - 0x10000 : v);
export const u32 = (lo, hi) => ((hi << 16) | lo) >>> 0;

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [ip, serial, start = '0', count = '10', slave = '1'] = process.argv.slice(2);
  if (!ip || !serial) {
    console.error('Usage: node solarman.mjs <ip> <serial> [startReg=0] [count=10] [slave=1]');
    process.exit(2);
  }
  readRegisters({ ip, serial: Number(serial), start: Number(start), count: Number(count), slave: Number(slave) })
    .then((regs) => regs.forEach((v, i) => console.log(`reg ${Number(start) + i}\t${v}\t(0x${v.toString(16).padStart(4, '0')})`)))
    .catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
}
