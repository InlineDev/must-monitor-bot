// Оценка заряда батареи и оставшегося времени работы от неё.
//
// Как считаем:
//  1. Ёмкость (А·ч) и тип батареи берём из настроек инвертора: регистры 10111 и 10110,
//     напряжения absorption/float — 10104/10103.
//  2. Заряд (SoC) ведём счётчиком ампер-часов постоянно, а не только во время разряда:
//     разряд вычитаем, заряд прибавляем (с КПД заряда).
//  3. Опорная точка — «батарея полная»: зарядное держит её у float/absorption, а ток почти нулевой.
//     Тогда SoC = 100 %. Это главный источник: у LiFePO4 кривая напряжения плоская
//     (3,28 В/яч — это 50 %, 3,32 — уже 90 %), и погрешность вольтметра MUST в 0,2–0,4 В
//     превращает полную батарею в «≈58 %».
//  4. Только если полного заряда ещё не видели (свежий запуск, долго без сети) — SoC по напряжению
//     «в покое» (таблица для свинца или LiFePO4). Такая оценка помечается как приблизительная.
//  5. Время = (SoC − минимально допустимый SoC) × ёмкость / средний ток разряда (с поправкой Пейкерта).
// Всё приблизительно: показываем со знаком «≈».

const BATTERY_TYPES = ['', 'своя (LiFePO4)', 'литий', 'свинцовая (sealed)', 'AGM', 'гелевая', 'заливная'];
const NOISE_W = 50;
const AVG_WINDOW_MS = 5 * 60000;
const FULL_HOLD_MS = 3 * 60000;          // сколько держаться у float с малым током, чтобы считать «полная»
const FULL_VALID_MS = 3 * 86400e3;       // дольше без полного заряда счётчик уже «уплывает» — снова по напряжению
const MAX_GAP_MS = 120000;               // разрыв в данных больше 2 мин не интегрируем

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
  const volts = (a) => (registers?.[a] ? registers[a] / 10 : null);
  // 2 = литий; 1 = USER (своя) — на MUST его выбирают для LiFePO4, чтобы задать свои напряжения.
  // Свинцом считаем только явно выбранные свинцовые типы (sealed / AGM / гель / заливная).
  const lithium = typeCode === 2 || typeCode === 1 || typeCode == null;
  return {
    ah, grade, lithium,
    floatV: volts(10103), absorptionV: volts(10104),
    chargeEff: lithium ? 0.97 : 0.85,   // часть ампер-часов заряда уходит в тепло
    typeLabel: BATTERY_TYPES[typeCode] || 'неизвестный тип',
    nominalV: lithium ? (grade / 24) * 25.6 : grade,
    socMin: lithium ? 10 : 50,          // «бережный» предел: свинец глубже 50 % — сильно сокращает срок службы
    // Эффект Пейкерта: при большом токе батарея отдаёт меньше паспортной ёмкости (паспорт — для 20-часового разряда)
    peukertK: lithium ? 1.05 : 1.2,
    socFromVoltage(v) {
      if (!v) return null;
      return lithium ? interp(LFP_CELL, v / ((grade / 24) * 8)) : interp(LEAD_12V, v / (grade / 12));
    },
  };
}

export function createRuntimeEstimator() {
  // soc — текущий заряд, %; source: 'full' — отсчёт от полного заряда, 'voltage' — по напряжению покоя
  let soc = null, source = null, fullAt = 0, lastTs = 0;
  let nearFullSince = 0;
  let session = null;      // { start } — текущий разряд
  const window = [];       // [{ ts, w, v }] мощности разряда за последние 5 мин
  let endedAt = 0;

  // Зарядное держит батарею у float/absorption, а ток почти нулевой — батарея полная.
  function isFull(d, bat, v, profile, gridChargeOn) {
    if (bat < 0 || !v) return false;
    const target = profile.floatV || profile.absorptionV;
    if (!target) return false;
    const amps = bat / v;
    const smallA = Math.max(2, (profile.ah || 100) * 0.03);
    const charging = gridChargeOn === 1 || (d.pvPower_W ?? 0) > NOISE_W;
    return charging && v >= target - 0.2 && amps <= smallA;
  }

  /** d — снимок данных, bat — мощность батареи (+ заряд, − разряд), profile — batteryProfile(), gridChargeOn — 1/0/null */
  function update(d, bat, profile, gridChargeOn = null) {
    const now = d.ts || Date.now();
    const v = d.inverterBatteryVoltage_V;
    const dt = lastTs && now > lastTs ? Math.min(now - lastTs, MAX_GAP_MS) / 3600000 : 0;
    lastTs = now;

    // счётчик ампер-часов
    if (soc != null && profile.ah && dt && bat) {
      const ah = (Math.abs(bat) / (v || profile.nominalV)) * dt * (bat > 0 ? profile.chargeEff : 1);
      soc = Math.max(0, Math.min(100, soc + (bat > 0 ? ah : -ah) / profile.ah * 100));
    }

    // опорная точка «полная»
    if (isFull(d, bat, v, profile, gridChargeOn)) {
      if (!nearFullSince) nearFullSince = now;
      if (now - nearFullSince >= FULL_HOLD_MS) { soc = 100; source = 'full'; fullAt = now; }
    } else nearFullSince = 0;
    if (source === 'full' && now - fullAt > FULL_VALID_MS) source = null;

    // без опорной точки — по напряжению покоя
    if (source !== 'full' && Math.abs(bat) < NOISE_W && v) {
      const s = profile.socFromVoltage(v);
      if (s != null) { soc = s; source = 'voltage'; }
    }
    if (source !== 'full' && soc == null && bat <= -NOISE_W && v) {
      // запуск прямо во время разряда: напряжение под нагрузкой занижено, но лучше, чем ничего
      const s = profile.socFromVoltage(v);
      if (s != null) { soc = s; source = 'voltage'; }
    }

    if (bat <= -NOISE_W) {
      if (!session) session = { start: now };
      window.push({ ts: now, w: -bat, v });
      endedAt = 0;
    } else if (session) {
      // разряд закончился: держим сессию 2 минуты (короткие паузы не сбрасывают окно)
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
    if (soc == null) return null;
    // средний ток разряда и поправка Пейкерта на ёмкость при этом токе
    const v = window[window.length - 1]?.v || profile.nominalV;
    const amps = avgW / v;
    const i20 = profile.ah / 20;
    const factor = amps > i20 ? Math.pow(i20 / amps, profile.peukertK - 1) : 1;
    const effAh = profile.ah * factor;
    const minutesTo = (socTo) => (amps > 0.2 ? (Math.max(0, soc - socTo) / 100) * effAh / amps * 60 : Infinity);
    return {
      soc, socSource: source, fullAt: source === 'full' ? fullAt : null,
      avgW, amps, ah: profile.ah, effAh, typeLabel: profile.typeLabel, socMin: profile.socMin, lithium: profile.lithium,
      minutes: minutesTo(0),                                   // до отключения инвертора
      minutesSafe: profile.lithium ? null : minutesTo(profile.socMin), // до 50 % для свинца
      since: session.start,
    };
  }

  // Состояние счётчика переживает перезапуск (data/battery.json): иначе после рестарта
  // опять остаётся только неточная оценка по напряжению.
  const snapshot = () => ({ soc, source, fullAt, ts: lastTs });
  function restore(st) {
    if (!st || st.soc == null || !st.ts || Date.now() - st.ts > 15 * 60000) return false;
    ({ soc, source, fullAt } = st);
    lastTs = st.ts;
    return true;
  }

  return { update, estimate, snapshot, restore };
}

const fmtMin = (min) => {
  const m = Math.round(min);
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`;
};
export function formatRuntime(est) {
  if (!est) return null;
  // «≈» уже стоит; если отсчёт не от полного заряда — честно говорим, что по напряжению
  const socTxt = (soc) => `заряд ≈${Math.round(soc)} %${est.socSource === 'voltage' ? ', по напряжению' : ''}`;
  if (est.needAh) return '⏳ Время работы не посчитать: в инверторе не указана ёмкость батареи (⚙️ Настройки → Ёмкость батареи)';
  if (!Number.isFinite(est.minutes) || est.minutes > 48 * 60) return `⏳ Хватит больше чем на сутки (${socTxt(est.soc)})`;
  if (est.minutes < 1) return `🪫 Батарея на пределе (${socTxt(est.soc)})`;
  let line = `⏳ До отключения ≈ <b>${fmtMin(est.minutes)}</b> (${socTxt(est.soc)})`;
  if (est.minutesSafe != null) {
    line += est.minutesSafe >= 1
      ? `\n<i>   бережно, до ${est.socMin} %: ≈ ${fmtMin(est.minutesSafe)}</i>`
      : `\n<i>   ниже ${est.socMin} % — глубокий разряд сокращает ресурс свинцовой батареи</i>`;
  }
  return line;
}
