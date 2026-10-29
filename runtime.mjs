// Оценка оставшегося времени работы от батареи.
//
// Как считаем:
//  1. Ёмкость (А·ч) и тип батареи берём из настроек инвертора: регистры 10111 и 10110.
//  2. Заряд (SoC) в момент начала разряда — по напряжению «в покое» перед разрядом
//     (по таблице для свинца или LiFePO4).
//  3. Дальше вычитаем отданные ампер-часы (ток × время) — это точнее, чем напряжение под нагрузкой.
//  4. Время = (SoC − минимально допустимый SoC) × ёмкость × номинальное напряжение / средняя мощность разряда.
// Всё приблизительно: показываем со знаком «≈».

const BATTERY_TYPES = ['', 'своя', 'литий', 'свинцовая (sealed)', 'AGM', 'гелевая', 'заливная'];
const NOISE_W = 50;
const AVG_WINDOW_MS = 5 * 60000;

// Напряжение покоя на 12 В свинцовой батареи → SoC, %
const LEAD_12V = [[12.73, 100], [12.62, 90], [12.50, 80], [12.37, 70], [12.24, 60], [12.10, 50], [11.96, 40], [11.81, 30], [11.66, 20], [11.51, 10], [10.5, 0]];
// Напряжение покоя на ячейку LiFePO4 → SoC, %
const LFP_CELL = [[3.40, 100], [3.35, 99], [3.32, 90], [3.30, 70], [3.28, 50], [3.26, 40], [3.25, 30], [3.22, 20], [3.20, 15], [3.00, 10], [2.80, 5], [2.50, 0]];

function interp(table, v) {
  if (v >= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [v1, s1] = table[i - 1], [v2, s2] = table[i];
    if (v >= v2) return s2 + ((v - v2) / (v1 - v2)) * (s1 - s2);
  }
  return 0;
}

export function batteryProfile(registers, battVolGrade) {
  const ah = registers?.[10111] || null;
  const typeCode = registers?.[10110];
  const grade = battVolGrade || 24;
  const lithium = typeCode === 2;
  return {
    ah, grade, lithium,
    typeLabel: BATTERY_TYPES[typeCode] || 'неизвестный тип',
    nominalV: lithium ? (grade / 24) * 25.6 : grade,
    socMin: lithium ? 10 : 50,          // свинец разряжать глубже 50 % — сильно сокращает срок службы
    socFromVoltage(v) {
      if (!v) return null;
      return lithium ? interp(LFP_CELL, v / ((grade / 24) * 8)) : interp(LEAD_12V, v / (grade / 12));
    },
  };
}

export function createRuntimeEstimator() {
  let restV = null;        // последнее напряжение «в покое» (ток около нуля)
  let session = null;      // { start, soc0, ahOut, lastTs }
  const window = [];       // [{ ts, w }] мощности разряда за последние 5 мин
  let endedAt = 0;

  /** d — снимок данных, bat — мощность батареи (+ заряд, − разряд), profile — batteryProfile() */
  function update(d, bat, profile) {
    const now = d.ts || Date.now();
    const v = d.inverterBatteryVoltage_V;
    if (Math.abs(bat) < NOISE_W && v) restV = v;

    if (bat <= -NOISE_W) {
      if (!session) {
        const soc0 = profile.socFromVoltage(restV ?? v);
        session = { start: now, soc0, ahOut: 0, lastTs: now };
      } else {
        const dt = Math.min(now - session.lastTs, 120000) / 3600000; // разрыв > 2 мин не интегрируем
        session.ahOut += (Math.abs(bat) / (v || profile.nominalV)) * dt;
        session.lastTs = now;
      }
      window.push({ ts: now, w: -bat });
      endedAt = 0;
    } else if (session) {
      // разряд закончился: держим сессию 2 минуты (короткие паузы не сбрасывают счёт)
      if (!endedAt) endedAt = now;
      if (now - endedAt > 120000) { session = null; window.length = 0; }
    }
    while (window.length && window[0].ts < now - AVG_WINDOW_MS) window.shift();
  }

  /** Результат для показа или null, если сейчас не разряжаемся. */
  function estimate(profile) {
    if (!session || endedAt || !window.length) return null;
    const avgW = window.reduce((a, x) => a + x.w, 0) / window.length;
    if (!profile.ah) return { needAh: true, avgW };
    if (session.soc0 == null) return null;
    const soc = Math.max(0, Math.min(100, session.soc0 - (session.ahOut / profile.ah) * 100));
    const usableWh = Math.max(0, (soc - profile.socMin) / 100) * profile.ah * profile.nominalV;
    const minutes = avgW > 5 ? (usableWh / avgW) * 60 : Infinity;
    return { soc, minutes, avgW, ah: profile.ah, typeLabel: profile.typeLabel, socMin: profile.socMin, since: session.start };
  }

  return { update, estimate };
}

export function formatRuntime(est) {
  if (!est) return null;
  if (est.needAh) return '⏳ Время работы не посчитать: в инверторе не указана ёмкость батареи (⚙️ Настройки → Ёмкость батареи)';
  if (!Number.isFinite(est.minutes) || est.minutes > 48 * 60) return `⏳ Хватит больше чем на сутки (заряд ≈${Math.round(est.soc)} %)`;
  if (est.minutes < 1) return `🪫 Батарея на пределе (заряд ≈${Math.round(est.soc)} %)`;
  const m = Math.round(est.minutes);
  const t = m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`;
  return `⏳ Хватит примерно на <b>${t}</b> (заряд ≈${Math.round(est.soc)} %)`;
}
