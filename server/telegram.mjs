// Telegram-бот для MUST-дашборда: статус, управление, уведомления.
// Работает через long polling: бот сам подключается к api.telegram.org,
// поэтому не нужны ни белый IP, ни туннели. Без зависимостей (Node 18+).
//
// Доступ: при запуске в консоли печатается одноразовый код. Отправьте боту
// /start <код> — чат будет привязан (хранится в data/telegram.json).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Знаки мощностей — как в dashboard.html (по замерам на этом инверторе).
const GRID_IMPORT_SIGN = -1;
const BAT_CHARGE_SIGN = 1;

const MODE_RU = { PowerOn: 'Включение', SelfTest: 'Самотест', OffGrid: 'Автономно (от батареи)', 'Grid-Tie': 'С сетью', ByPass: 'Байпас (от сети)', Stop: 'Стоп', 'Grid charging': 'Заряд от сети' };
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const n1 = (v) => (v == null ? '—' : Number(v).toFixed(1).replace('.', ','));
const fmtW = (w) => (w == null ? '—' : Math.abs(w) >= 1000 ? (w / 1000).toFixed(2).replace('.', ',') + ' кВт' : Math.round(w) + ' Вт');
const hm = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'Europe/Kyiv' });
const hms = (t) => new Date(t).toLocaleTimeString('ru-RU', { timeZone: process.env.TZ || 'Europe/Kyiv' });
const dur = (ms) => { if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))} с`; const m = Math.round(ms / 60000); return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`; };

// Какие настройки показываем кнопками (ключи из controls.mjs)
const QUICK = {
  gridCharge: [{ v: 1, t: 'Включить' }, { v: 0, t: 'Выключить' }],
  energyMode: [{ v: 3, t: 'UTI' }, { v: 1, t: 'SBU' }],
  gridChargeCurrent: [{ v: 20, t: '20 А' }, { v: 30, t: '30 А' }],
};

export function startTelegram({ token, dataDir, getLatest, getStatus, getControls, getHistory, applyControl, log, signal }) {
  const API = (process.env.TELEGRAM_API || 'https://api.telegram.org') + '/bot' + token;
  const stateFile = path.join(dataDir, 'telegram.json');
  let state = { chats: [], muted: [], offset: 0, outages: [] };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch {}
  const save = () => fs.writeFile(stateFile, JSON.stringify(state), { mode: 0o600 }, () => {});

  let alertRef = { grid: null };
  const pairCode = String(crypto.randomInt(100000, 1000000));
  const pairUntil = Date.now() + 30 * 60000;
  const pairFails = new Map();
  console.error(`telegram: бот запущен. Чтобы привязать чат, отправьте боту:  /start ${pairCode}   (код действует 30 мин)` +
    (state.chats.length ? ` · уже привязано чатов: ${state.chats.length}` : ''));

  async function call(method, body) {
    const r = await fetch(`${API}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 65000 : 15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
    return j.result;
  }
  const send = (chat_id, text, kb) => call('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}) })
    .catch((e) => log(`telegram: ${e.message}`));
  const edit = (chat_id, message_id, text, kb) => call('editMessageText', { chat_id, message_id, text, parse_mode: 'HTML', ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}) })
    .catch((e) => { if (!/not modified/.test(e.message)) log(`telegram: ${e.message}`); });
  const allowed = (id) => state.chats.includes(id);

  // Постоянное меню внизу экрана — чтобы ничего не набирать
  const MENU = { status: '📊 Статус', settings: '⚙️ Настройки', day: '📈 Сутки', mute: '🔔 Уведомления' };
  const menuKb = { keyboard: [[{ text: MENU.status }, { text: MENU.settings }], [{ text: MENU.day }, { text: MENU.mute }]], resize_keyboard: true, is_persistent: true };
  const sendMenu = (chat_id, text) => call('sendMessage', { chat_id, text, parse_mode: 'HTML', reply_markup: menuKb }).catch((e) => log(`telegram: ${e.message}`));

  // ---------- тексты ----------
  function statusText() {
    const d = getLatest(), st = getStatus();
    if (!d) return '⏳ Данных от инвертора пока нет — жду подключения логгера.';
    const age = Date.now() - d.ts;
    const grid = (d.gridPower_W ?? 0) * GRID_IMPORT_SIGN, bat = (d.batteryPower_W ?? 0) * BAT_CHARGE_SIGN;
    const gridOn = (d.gridVoltage_V ?? 0) > 170;
    const ctl = getControls();
    const gc = ctl.items.find((i) => i.key === 'gridCharge');
    const errs = [d.inverterErrors, (d.chargerErrors || '').split(', ').filter((x) => x && x !== 'OK' && x !== 'PV voltage is too low').join(', '), d.inverterWarnings]
      .filter((x) => x && x !== 'OK');
    return [
      `<b>MUST</b> · ${esc(MODE_RU[d.workState] || d.workState)}`,
      '',
      `${gridOn ? '🟢' : '🔴'} <b>Сеть:</b> ${gridOn ? `${n1(d.gridVoltage_V)} В · ${(d.gridFrequency_Hz ?? 0).toFixed(2).replace('.', ',')} Гц${Math.abs(grid) > 5 ? ` · ${grid > 0 ? 'берём' : 'отдаём'} ${fmtW(Math.abs(grid))}` : ''}` : 'нет напряжения'}`,
      `🔋 <b>Батарея:</b> ${n1(d.inverterBatteryVoltage_V)} В · ${bat > 5 ? `заряд ${fmtW(bat)}` : bat < -5 ? `разряд ${fmtW(-bat)}` : 'покой'}`,
      `🏠 <b>Нагрузка:</b> ${fmtW(d.loadPower_W)} (${d.loadPercent ?? '—'} %)`,
      `🔌 <b>Заряд от сети:</b> ${gc?.value == null ? '—' : gc.value ? 'вкл' : 'выкл'}`,
      `🌡 ${d.dcRadiatorTemp_C ?? '—'} / ${d.acRadiatorTemp_C ?? '—'} °C`,
      errs.length ? `\n⚠️ ${esc(errs.join('; '))}` : '',
      '',
      `<i>${age > 120000 ? `⚠️ данные устарели: ${dur(age)} назад` : `обновлено ${hms(d.ts)}`}${st.connected ? '' : ' · логгер не на связи'}</i>`,
    ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  }

  function statusKb() {
    const ctl = getControls();
    const kb = [[{ text: '🔄 Обновить', callback_data: 'r' }]];
    if (!ctl.items.length) return kb;
    const gc = ctl.items.find((i) => i.key === 'gridCharge');
    if (gc) kb.push([{ text: gc.value ? '🔌 Выключить заряд от сети' : '🔌 Включить заряд от сети', callback_data: `c:gridCharge:${gc.value ? 0 : 1}` }]);
    kb.push([{ text: '⚙️ Настройки', callback_data: 's' }]);
    return kb;
  }

  function dayText() {
    const now = Date.now(), from = now - 24 * 3600e3;
    const cur = alertRef.grid === false ? [{ from: alertRef.gridSince, to: now, ongoing: true }] : [];
    const list = [...state.outages, ...cur].filter((o) => o.to > from).map((o) => ({ ...o, from: Math.max(o.from, from) }));
    const total = list.reduce((a, o) => a + (o.to - o.from), 0);
    const longest = list.reduce((a, o) => Math.max(a, o.to - o.from), 0);
    const hist = (getHistory?.() || []).filter((p) => p.ts >= from);
    const vs = hist.map((p) => p.inverterBatteryVoltage_V ?? p.batteryVoltage_V).filter((v) => v > 0);
    const loads = hist.map((p) => p.loadPower_W).filter((v) => v != null);
    const lines = ['<b>📈 За последние 24 часа</b>', ''];
    if (!list.length) lines.push('🟢 Отключений сети не было');
    else {
      lines.push(`🔴 Отключений: <b>${list.length}</b>, всего без сети <b>${dur(total)}</b>`);
      lines.push(`⏱ Самое долгое: ${dur(longest)}`);
      lines.push('');
      for (const o of list.slice(-8)) lines.push(`• ${hm(o.from)}–${o.ongoing ? 'сейчас' : hm(o.to)} (${dur(o.to - o.from)})`);
    }
    if (vs.length) { lines.push(''); lines.push(`🔋 Батарея: мин ${n1(Math.min(...vs))} В · макс ${n1(Math.max(...vs))} В`); }
    if (loads.length) lines.push(`🏠 Нагрузка: средняя ${fmtW(loads.reduce((a, b) => a + b, 0) / loads.length)} · пик ${fmtW(Math.max(...loads))}`);
    if (!hist.length && !list.length) lines.push('', '<i>Истории пока мало — данные копятся с момента запуска.</i>');
    return lines.join('\n');
  }

  function settingsText() {
    const ctl = getControls();
    if (!ctl.items.length) return 'Настройки ещё не прочитаны с инвертора.';
    const line = (k) => { const it = ctl.items.find((i) => i.key === k); return it ? `• ${esc(it.label)}: <b>${esc(fmt(it))}</b>` : ''; };
    return ['<b>Настройки</b>', '', ...Object.keys(QUICK).map(line),
      line('stopDischargeV'), line('stopChargeV'), line('absorptionV'), line('floatV'),
      '', '<i>Пороги и напряжения меняются в веб-дашборде.</i>'].filter(Boolean).join('\n');
  }
  function settingsKb() {
    const ctl = getControls();
    const kb = [];
    for (const [k, opts] of Object.entries(QUICK)) {
      const it = ctl.items.find((i) => i.key === k);
      if (!it) continue;
      kb.push(opts.map((o) => ({ text: `${o.v === it.value ? '● ' : ''}${short(it)} ${o.t}`, callback_data: `c:${k}:${o.v}` })));
    }
    kb.push([{ text: '← Назад', callback_data: 'r' }]);
    return kb;
  }
  const short = (it) => ({ gridCharge: 'Заряд:', energyMode: 'Режим', gridChargeCurrent: 'Ток' }[it.key] || it.label);
  function fmt(it, v = it.value) {
    if (v == null) return '—';
    if (it.type === 'switch') return v ? 'Вкл' : 'Выкл';
    if (it.type === 'select') return it.options.find((o) => o.value === v)?.label ?? `код ${v}`;
    return `${String(v).replace('.', ',')} ${it.unit}`;
  }

  // ---------- обработка ----------
  async function onMessage(m) {
    const chat = m.chat.id, text = (m.text || '').trim();
    const [cmd, arg] = text.split(/\s+/);
    if (cmd === '/start' || cmd === '/pair') {
      if (allowed(chat)) { await sendMenu(chat, 'Меню — кнопками внизу 👇'); return send(chat, statusText(), statusKb()); }
      const f = pairFails.get(chat) || 0;
      if (f >= 5) return; // молчим после 5 попыток
      if (arg && arg === pairCode && Date.now() < pairUntil) {
        state.chats.push(chat); save();
        log(`telegram: привязан чат ${chat} (${m.from?.username || m.from?.first_name || ''})`);
        await sendMenu(chat, '✅ <b>Чат привязан.</b>\n\nБуду сразу писать, когда:\n🔴 пропала сеть\n🟢 сеть вернулась (и сколько её не было)\n⚠️ у инвертора ошибка\n🪫 садится батарея\n\nМеню — кнопками внизу 👇');
        return send(chat, statusText(), statusKb());
      }
      pairFails.set(chat, f + 1);
      return send(chat, '🔒 Это личный бот. Отправьте /start и код, который показан в Termux при запуске дашборда.');
    }
    if (!allowed(chat)) return; // чужим не отвечаем
    if (cmd === '/status' || cmd === '/s' || text === MENU.status) return send(chat, statusText(), statusKb());
    if (cmd === '/settings' || text === MENU.settings) return send(chat, settingsText(), settingsKb());
    if (cmd === '/day' || text === MENU.day) return send(chat, dayText(), [[{ text: '🔄 Обновить', callback_data: 'd' }]]);
    if (cmd === '/mute' || text === MENU.mute) {
      const i = state.muted.indexOf(chat);
      if (i >= 0) state.muted.splice(i, 1); else state.muted.push(chat);
      save();
      return send(chat, i >= 0 ? '🔔 Уведомления включены' : '🔕 Уведомления выключены (команда /mute — включить обратно)');
    }
    if (cmd === '/unlink') { state.chats = state.chats.filter((c) => c !== chat); save(); return send(chat, 'Чат отвязан.'); }
    return sendMenu(chat, 'Пользуйтесь кнопками внизу 👇\nЕщё: /unlink — отвязать этот чат');
  }

  async function onCallback(q) {
    const chat = q.message?.chat.id, mid = q.message?.message_id;
    if (!allowed(chat)) return call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    const [t, key, val] = String(q.data).split(':');
    const answer = (text) => call('answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => {});
    if (t === 'r') { await edit(chat, mid, statusText(), statusKb()); return answer(); }
    if (t === 's') { await edit(chat, mid, settingsText(), settingsKb()); return answer(); }
    if (t === 'd') { await edit(chat, mid, dayText(), [[{ text: '🔄 Обновить', callback_data: 'd' }]]); return answer(); }
    const it = getControls().items.find((i) => i.key === key);
    if (!it || !(key in QUICK)) return answer('Недоступно');
    const value = Number(val);
    if (t === 'c') { // подтверждение
      if (value === it.value) return answer('Уже установлено');
      const warn = key === 'gridCharge' && value === 0 ? '\n\n⚠️ Батарея перестанет заряжаться от сети, пока не включите обратно.' : '';
      await edit(chat, mid, `<b>${esc(it.label)}</b>\n\nБыло: ${esc(fmt(it))}\nСтанет: <b>${esc(fmt(it, value))}</b>${warn}\n\nЗаписать в инвертор?`,
        [[{ text: '✅ Да, записать', callback_data: `y:${key}:${value}` }, { text: '✖️ Отмена', callback_data: 'r' }]]);
      return answer();
    }
    if (t === 'y') {
      await answer('Записываю…');
      const who = q.from?.username ? '@' + q.from.username : q.from?.first_name || String(chat);
      const r = await applyControl(key, value, { via: 'telegram', user: who });
      const res = r.entry?.ok ? `✅ ${esc(it.label)}: <b>${esc(r.entry.after)}</b>` : `❌ Не удалось: ${esc(r.error || r.entry?.error || r.entry?.note)}`;
      return edit(chat, mid, `${res}\n\n${statusText()}`, statusKb());
    }
  }

  // ---------- уведомления ----------
  const alert = { grid: null, gridSince: null, gridPending: 0, batLow: false, errors: '', stale: false, lastData: Date.now() };
  alertRef = alert;
  const notify = (text) => { for (const c of state.chats) if (!state.muted.includes(c)) send(c, text); };

  function onData(d) {
    alert.lastData = d.ts;
    if (alert.stale) { alert.stale = false; notify('🟢 Связь с инвертором восстановлена'); }
    // сеть: 2 замера подряд, чтобы не дёргаться на провалах
    const gridOn = (d.gridVoltage_V ?? 0) > 170;
    if (alert.grid === null) { alert.grid = gridOn; alert.gridSince = d.ts; }
    else if (gridOn !== alert.grid) {
      if (++alert.gridPending >= 2) {
        const was = alert.gridSince;
        alert.grid = gridOn; alert.gridSince = d.ts; alert.gridPending = 0;
        if (gridOn) { state.outages.push({ from: was, to: d.ts }); state.outages = state.outages.filter((o) => o.to > Date.now() - 7 * 86400e3); save(); }
        notify(gridOn
          ? `🟢 <b>Сеть вернулась</b> в ${hm(d.ts)}. Без сети: ${dur(d.ts - was)}.\n🔋 ${n1(d.inverterBatteryVoltage_V)} В`
          : `🔴 <b>Пропала сеть</b> в ${hm(d.ts)}. Работаем от батареи.\n🔋 ${n1(d.inverterBatteryVoltage_V)} В · нагрузка ${fmtW(d.loadPower_W)}`);
      }
    } else alert.gridPending = 0;
    // батарея: порог = «переход на сеть» + 0,5 В, иначе 23,5 В для 24-вольтовой системы
    const ctl = getControls();
    const stop = ctl.items.find((i) => i.key === 'stopDischargeV')?.value;
    const low = Number(process.env.TG_BAT_LOW) || (stop ? stop + 0.5 : ((d.battVolGrade || 24) / 24) * 23.5);
    const v = d.inverterBatteryVoltage_V;
    if (v != null && !alert.batLow && v < low && !gridOn) { alert.batLow = true; notify(`🪫 <b>Батарея садится:</b> ${n1(v)} В (порог ${n1(low)} В). Нагрузка ${fmtW(d.loadPower_W)}.`); }
    if (alert.batLow && v != null && v > low + 1) alert.batLow = false;
    // ошибки инвертора
    const errs = [d.inverterErrors, (d.chargerErrors || '').split(', ').filter((x) => x && x !== 'OK' && x !== 'PV voltage is too low').join(', ')]
      .filter((x) => x && x !== 'OK').join('; ');
    if (errs !== alert.errors) {
      if (errs) notify(`⚠️ <b>Ошибка инвертора:</b> ${esc(errs)}`);
      else if (alert.errors) notify('✅ Ошибки инвертора сброшены');
      alert.errors = errs;
    }
  }
  setInterval(() => {
    if (!alert.stale && state.chats.length && Date.now() - alert.lastData > 5 * 60000) {
      alert.stale = true; notify('⚠️ Нет данных от инвертора больше 5 минут (логгер или Wi-Fi не на связи).');
    }
  }, 60000).unref();

  // ---------- long polling ----------
  (async () => {
    try {
      await call('setMyCommands', { commands: [
        { command: 'status', description: 'Состояние инвертора' },
        { command: 'settings', description: 'Настройки и управление' },
        { command: 'day', description: 'Отключения и батарея за сутки' },
        { command: 'mute', description: 'Уведомления вкл/выкл' },
      ] });
    } catch (e) { log(`telegram: ${e.message} — проверьте токен`); }
    while (!signal?.aborted) {
      try {
        const ups = await call('getUpdates', { offset: state.offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
        for (const u of ups) {
          state.offset = u.update_id + 1;
          try {
            if (u.message) await onMessage(u.message);
            else if (u.callback_query) await onCallback(u.callback_query);
          } catch (e) { log(`telegram: ошибка обработки: ${e.message}`); }
        }
        if (ups.length) save();
      } catch (e) {
        if (signal?.aborted) break;
        log(`telegram: ${e.message} — повтор через 10 с`);
        await new Promise((r) => setTimeout(r, 10000));
      }
    }
  })();

  return { onData };
}
