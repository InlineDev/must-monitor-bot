// Белый список настроек MUST PV18/PV1800, которые дашборд разрешает менять.
// Адреса, коэффициенты и диапазоны — из ha-must-inverter (const.py: SENSORS_ARRAY, OPTIONS, RANGES).
// Калибровочные регистры (20009-20016) и сбросы счётчиков сюда НЕ входят и записаны быть не могут.

// Диапазоны регистров, откуда читаем текущие значения (те же блоки, что читает ha-must-inverter).
export const CONTROL_RANGES = [[10101, 10124], [20101, 20144]];

const g = (grade) => (grade || 24) / 24; // множитель для систем 12/24/48 В

export const CONTROLS = [
  // Регистр 20106 (InverterChargerFromGridEnable) на PV18 принимает запись, но не меняется
  // (проверено на железе 29.10.2026), поэтому «Заряд от сети» переключает источник заряда (20143):
  // Вкл = «Солнце + сеть» (2), Выкл = «Только солнце» (3) — без панелей это значит «не заряжать».
  {
    key: 'gridCharge', address: 20143, type: 'switch', group: 'Заряд',
    onValue: 2, offValue: 3, isOn: (raw) => raw !== 3,
    label: 'Заряд от сети',
    hint: 'Вкл — батарея заряжается от сети. Выкл — не заряжается (источник заряда «только солнце», а панелей нет).',
  },
  {
    key: 'chargerSource', address: 20143, type: 'select', group: 'Заряд',
    label: 'Источник заряда',
    options: [
      { value: 2, label: 'Солнце + сеть' },
      { value: 0, label: 'Сначала солнце' },
      { value: 3, label: 'Только солнце', danger: 'Без панелей батарея перестанет заряжаться' },
    ],
  },
  {
    key: 'gridChargeCurrent', address: 20125, type: 'number', group: 'Заряд',
    label: 'Ток заряда от сети', unit: 'А', coeff: 0.1,
    // PH18-3024 PRO: максимум 60 А по паспорту (в ha-must-inverter было 20–30 А для другой модели).
    // Инвертор сам ограничивает значение — после записи оно читается обратно и проверяется.
    range: () => ({ min: 10, max: 60, step: 10 }),
    hint: 'Ток, которым инвертор заряжает батарею от сети. Не выше, чем допускает ваша батарея (смотрите паспорт АКБ).',
  },
  {
    key: 'maxChargeCurrent', address: 20132, type: 'number', group: 'Заряд',
    label: 'Макс. общий ток заряда', unit: 'А', coeff: 0.1, range: () => ({ min: 1, max: 80, step: 1 }),
  },
  {
    key: 'energyMode', address: 20109, type: 'select', group: 'Режим',
    label: 'Режим работы',
    options: [
      { value: 3, label: 'UTI — от сети, батарея в резерве' },
      { value: 1, label: 'SBU — сначала батарея, потом сеть' },
      { value: 2, label: 'SUB — солнце, сеть, батарея' },
      { value: 4, label: 'SOL — солнце' },
    ],
  },
  {
    key: 'searchMode', address: 20104, type: 'switch', group: 'Режим',
    label: 'Режим поиска нагрузки',
    hint: 'Экономия при нулевой нагрузке: инвертор «засыпает» и периодически проверяет, есть ли потребитель.',
  },
  {
    key: 'absorptionV', address: 10104, type: 'number', group: 'Батарея',
    label: 'Напряжение заряда (absorption)', unit: 'В', coeff: 0.1,
    range: (gr) => ({ min: +(g(gr) * 24).toFixed(1), max: +(g(gr) * 29.2).toFixed(1), step: 0.1 }),
    check: (raw, regs) => regs[10103] != null && raw < regs[10103] ? 'должно быть не ниже напряжения поддержки (float)' : null,
    hint: 'Основной заряд: до этого напряжения батарея заряжается полным током. Берите из паспорта АКБ (обычно 28,2–28,8 В для свинца 24 В, ~28,4 В для LiFePO4 8S).',
  },
  {
    key: 'floatV', address: 10103, type: 'number', group: 'Батарея',
    label: 'Напряжение поддержки (float)', unit: 'В', coeff: 0.1,
    range: (gr) => ({ min: +(g(gr) * 24).toFixed(1), max: +(g(gr) * 29.2).toFixed(1), step: 0.1 }),
    check: (raw, regs) => regs[10104] != null && raw > regs[10104] ? 'должно быть не выше напряжения заряда (absorption)' : null,
    hint: 'После полного заряда батарея держится на этом напряжении. Из паспорта АКБ (обычно 27,0–27,6 В для свинца 24 В, ~27,0 В для LiFePO4 8S).',
  },
  {
    key: 'batteryAh', address: 10111, type: 'number', group: 'Батарея',
    label: 'Ёмкость батареи', unit: 'А·ч', coeff: 1, range: () => ({ min: 1, max: 900, step: 1 }),
    hint: 'Ёмкость вашей батареи (суммарно для всей сборки). По ней считается «хватит примерно на …» при работе от батареи.',
  },
  {
    key: 'stopDischargeV', address: 20118, type: 'number', group: 'Батарея',
    label: 'Переход на сеть при', unit: 'В', coeff: 0.1,
    range: (gr) => ({ min: +(g(gr) * 22).toFixed(1), max: +(g(gr) * 29).toFixed(1), step: 0.1 }),
    hint: 'Когда батарея разрядится до этого напряжения, инвертор перейдёт на сеть.',
  },
  {
    key: 'stopChargeV', address: 20119, type: 'number', group: 'Батарея',
    label: 'Возврат на батарею при', unit: 'В', coeff: 0.1,
    range: (gr) => ({ min: +(g(gr) * 22).toFixed(1), max: +(g(gr) * 29).toFixed(1), step: 0.1 }),
    hint: 'Когда батарея зарядится до этого напряжения, инвертор снова перейдёт на неё.',
  },
  {
    key: 'lowCutoffV', address: 20127, type: 'number', group: 'Батарея',
    label: 'Отсечка по низкому напряжению', unit: 'В', coeff: 0.1,
    range: (gr) => ({ min: +(g(gr) * 20).toFixed(1), max: +(g(gr) * 24).toFixed(1), step: 0.1 }),
    hint: 'Защита батареи от глубокого разряда: ниже этого напряжения инвертор отключит выход.',
  },
];

const byKey = new Map(CONTROLS.map((c) => [c.key, c]));
export const getControl = (key) => byKey.get(key);

/** raw-регистр → значение для UI */
export function toDisplay(c, raw) {
  if (raw == null) return null;
  if (c.type === 'number') return +(raw * c.coeff).toFixed(2);
  if (c.type === 'switch') return (c.isOn ? c.isOn(raw) : raw !== 0) ? 1 : 0;
  return raw;
}

/** Значение из UI → raw для записи. Бросает ошибку, если вне белого списка/диапазона. */
export function toRaw(c, value, battVolGrade) {
  if (c.type === 'switch') {
    if (value !== 0 && value !== 1 && value !== true && value !== false) throw new Error('ожидается вкл/выкл');
    return value ? (c.onValue ?? 1) : (c.offValue ?? 0);
  }
  if (c.type === 'select') {
    const v = Number(value);
    if (!c.options.some((o) => o.value === v)) throw new Error('недопустимое значение');
    return v;
  }
  const v = Number(value);
  if (!Number.isFinite(v)) throw new Error('ожидается число');
  const { min, max, step } = c.range(battVolGrade);
  if (v < min - 1e-9 || v > max + 1e-9) throw new Error(`допустимо ${min}…${max} ${c.unit}`);
  const steps = (v - min) / step;
  if (Math.abs(steps - Math.round(steps)) > 1e-6) throw new Error(`шаг ${step} ${c.unit}`);
  return Math.round(v / c.coeff);
}

/** Описание для UI с текущими значениями */
export function describe(registers, battVolGrade) {
  return CONTROLS.map((c) => {
    const raw = registers[c.address];
    const out = { key: c.key, label: c.label, type: c.type, group: c.group, hint: c.hint, unit: c.unit, raw, value: toDisplay(c, raw) };
    if (c.type === 'select') out.options = c.options;
    if (c.type === 'number') Object.assign(out, c.range(battVolGrade));
    return out;
  });
}

export function formatValue(c, value) {
  if (value == null) return '—';
  if (c.type === 'switch') return value ? 'Вкл' : 'Выкл';
  if (c.type === 'select') return c.options.find((o) => o.value === value)?.label ?? `код ${value}`;
  return `${String(value).replace(".", ",")} ${c.unit}`;
}
