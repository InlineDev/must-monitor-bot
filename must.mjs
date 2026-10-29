// Декодер MUST PV18/PV1800 (и совместимых) через Wi-Fi логгер Solarman V5.
// Карта регистров — по https://github.com/mukaschultze/ha-must-inverter (const.py / mapper.py).
// ТОЛЬКО ЧТЕНИЕ и только безопасные Display-диапазоны: массовое чтение control-регистров
// (10000-10100, 20016-20100) по данным автора интеграции может отключить инвертор.
//
// Использование: node must.mjs <ip> <loggerSerial> [slave=4] [--json] [--pv19]
import { fileURLToPath } from 'node:url';
import { readRegisters, int16 } from './solarman.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const RANGES = [
  [15201, 15221], // Charger Display
  [25201, 25279], // Inverter Display
];
export const PV19_RANGES = [[113, 114]]; // SoC / SoH (PV19 / PV1900)

const s = (r, a) => int16(r[a]);
const x10 = (r, a) => +(int16(r[a]) * 0.1).toFixed(1);
const x100 = (r, a) => +(int16(r[a]) * 0.01).toFixed(2);
const kwh = (r, a) => +(r[a] * 1000 + r[a + 1] * 0.1).toFixed(1);

const CHARGER_STATE = { 0: 'Initialization', 1: 'Self-check', 2: 'Work', 3: 'Stop' };
const MPPT_STATE = { 0: 'Stop', 1: 'MPPT', 2: 'Current limiting' };
const CHARGING_STATE = { 0: 'Stop', 1: 'Absorb charge', 2: 'Float charge', 3: 'Equalization charge' };
const WORK_STATE = {
  0: 'PowerOn', 1: 'SelfTest', 2: 'OffGrid', 3: 'Grid-Tie', 4: 'ByPass',
  5: 'Stop', 6: 'Grid charging',
};

// Тексты битов ошибок/предупреждений — из ha-must-inverter const.py
const CHARGER_ERROR = ['Hardware protection', 'Over current', 'Current sensor error', 'Over temperature',
  'PV voltage is too high', 'PV voltage is too low', 'Battery voltage is too high', 'Battery voltage is too low',
  'Current is uncontrollable', 'Parameter error'];
const CHARGER_WARNING = ['Fan error'];
const INVERTER_ERROR = ['Fan is locked when inverter is off', 'Inverter transformer over temperature',
  'Battery voltage is too high', 'Battery voltage is too low', 'Output short circuited', 'Inverter output voltage is high',
  'Overload time out', 'Inverter bus voltage is too high', 'Bus soft start failed', 'Main relay failed',
  'Inverter output voltage sensor error', 'Inverter grid voltage sensor error', 'Inverter output current sensor error',
  'Inverter grid current sensor error', 'Inverter load current sensor error', 'Inverter grid over current error',
  'Inverter radiator over temperature', 'Solar charger battery voltage class error', 'Solar charger current sensor error',
  'Solar charger current is uncontrollable', 'Inverter grid voltage is low', 'Inverter grid voltage is high',
  'Inverter grid under frequency', 'Inverter grid over frequency', 'Inverter over current protection error',
  'Inverter bus voltage is too low', 'Inverter soft start failed', 'Over DC voltage in AC output',
  'Battery connection is open', 'Inverter control current sensor error', 'Inverter output voltage is too low'];
const INVERTER_WARNING = ['Fan is locked when inverter is on', 'Fan2 is locked when inverter is on',
  'Battery is over-charged', 'Low battery', 'Overload', 'Output power derating', 'Solar charger stops due to low battery',
  'Solar charger stops due to high PV voltage', 'Solar charger stops due to over load', 'Solar charger over temperature',
  'PV charger communication error'];

export function bitsToText(value, names) {
  const out = [];
  for (let i = 0; i < 32; i++) if (value & (2 ** i)) out.push(names[i] || `bit ${i}`);
  return out.length ? out.join(', ') : 'OK';
}

export function decode(r) {
  const has = (a) => r[a] !== undefined;
  const out = {};
  if (has(15201)) Object.assign(out, {
    chargerWorkState: CHARGER_STATE[r[15201]] ?? r[15201],
    mpptState: MPPT_STATE[r[15202]] ?? r[15202],
    chargingState: CHARGING_STATE[r[15203]] ?? r[15203],
    pvVoltage_V: x10(r, 15205),
    batteryVoltage_V: x10(r, 15206),
    chargerCurrent_A: x10(r, 15207),
    pvPower_W: s(r, 15208),
    chargerRadiatorTemp_C: s(r, 15209),
    chargerErrors: bitsToText(r[15213], CHARGER_ERROR),
    chargerWarnings: bitsToText(r[15214], CHARGER_WARNING),
    pvAccumulated_kWh: kwh(r, 15217),
    battVolGrade: r[15215], // 12/24/48 — номинал АКБ
    ratedCurrent_A: x10(r, 15216),
  });
  if (has(25201)) Object.assign(out, {
    workState: WORK_STATE[r[25201]] ?? r[25201],
    inverterBatteryVoltage_V: x10(r, 25205),
    inverterVoltage_V: x10(r, 25206),
    gridVoltage_V: x10(r, 25207),
    busVoltage_V: x10(r, 25208),
    inverterCurrent_A: x10(r, 25210),
    gridCurrent_A: x10(r, 25211),
    loadCurrent_A: x10(r, 25212),
    inverterPower_W: s(r, 25213),
    gridPower_W: s(r, 25214),
    loadPower_W: s(r, 25215),
    loadPercent: s(r, 25216),
    inverterFrequency_Hz: x100(r, 25225),
    gridFrequency_Hz: x100(r, 25226),
    acRadiatorTemp_C: s(r, 25233),
    dcRadiatorTemp_C: s(r, 25235),
    batteryPower_W: s(r, 25273),   // предположительно: <0 — разряд, >0 — заряд
    batteryCurrent_A: s(r, 25274),
    accChargerEnergy_kWh: kwh(r, 25245),
    accDischargerEnergy_kWh: kwh(r, 25247),
    accBuyEnergy_kWh: kwh(r, 25249),
    accSellEnergy_kWh: kwh(r, 25251),
    accLoadEnergy_kWh: kwh(r, 25253),
    accSelfUseEnergy_kWh: kwh(r, 25255),
    inverterErrors: bitsToText(((r[25262] << 16) | r[25261]) >>> 0, INVERTER_ERROR),
    inverterWarnings: bitsToText(r[25265], INVERTER_WARNING),
  });
  if (has(113)) Object.assign(out, { stateOfCharge_pct: r[113], stateOfHealth_pct: r[114] });
  return out;
}

/** Последовательно читает диапазоны (логгер не любит параллельные запросы). */
export async function readMust({ ip, serial, slave = 4, port = 8899, pv19 = false, gapMs = 150 }) {
  const regs = {};
  for (const [a, b] of pv19 ? [...RANGES, ...PV19_RANGES] : RANGES) {
    const values = await readRegisters({ ip, port, serial, slave, start: a, count: b - a + 1 });
    values.forEach((v, i) => { regs[a + i] = v; });
    await sleep(gapMs);
  }
  return { registers: regs, data: decode(regs) };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
  const [ip, serial, slave = '4'] = args;
  if (!ip || !serial) {
    console.error('Usage: node must.mjs <ip> <loggerSerial> [slave=4] [--json] [--pv19]');
    process.exit(2);
  }
  readMust({ ip, serial: Number(serial), slave: Number(slave), pv19: flags.has('--pv19') })
    .then(({ data }) => (flags.has('--json') ? console.log(JSON.stringify(data, null, 2)) : console.table(data)))
    .catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
}
