# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Обзор

Локальный мониторинг и управление гибридными инверторами MUST PV18/PV1800 через Wi‑Fi‑стик EyeBond/SmartESS, без облака. Веб‑дашборд + Telegram‑бот. Документация, комментарии, логи и UI — на русском; сообщения коммитов — на английском (`Area: summary`, например `Telegram: Live status mode…`).

**Без зависимостей**: чистый Node.js 18+ (ESM, `.mjs`), только встроенные модули `node:*`. Нет `package.json`, сборки, линтера и тестов — не добавляйте npm‑пакеты.

## Команды

```bash
cp .env.example .env                       # настройки; .env подхватывается автоматически, флаги CLI важнее
node dashboard.mjs [<IP_стика>]            # основной процесс: опрос + веб + Telegram
node dashboard.mjs --no-announce --allow <IP>   # режим сервера (VPS): ждать входящий стик, не слать UDP
node must-eybond.mjs <IP_стика> [--json] [--debug] [--watch 15]   # разовое чтение в консоль, отладка протокола
node announce.mjs <IP_стика> <IP_сервера>  # перенаправить стик на другой хост
node --check <file>.mjs                    # единственная доступная «проверка» синтаксиса
cd server && docker compose up -d --build  # VPS
```

Любой флаг `--foo-bar` можно задать переменной окружения (см. `opt()` в `dashboard.mjs`: `--http` → `HTTP_PORT`, `--allow` → `ALLOW` и т.д.). Проверить изменения можно только запуском против реального стика — эмулятора нет.

## Важно: копии в `server/`

`server/` содержит **побайтовые копии** `*.mjs` и `dashboard.html` из корня (Dockerfile копирует их из своей папки). Любое изменение этих файлов в корне нужно продублировать в `server/` в том же коммите (`cp <file> server/`). Проверка: `for f in server/*.mjs server/dashboard.html; do cmp $f $(basename $f); done`. `announce.mjs` и `start.sh` в `server/` не копируются.

## Архитектура

Поток данных: `[MUST] —RS485→ [стик EyeBond] —TCP 8899→ must-eybond.mjs → dashboard.mjs → (SSE в браузер | telegram.mjs)`.

- **`must-eybond.mjs`** — транспорт. Стик сам не принимает подключения: мы поднимаем TCP‑сервер на 8899 и шлём UDP `set>server=<IP>:8899;` на порт 58899 стика (только если он не подключился сам — каждый announce рвёт его сессию). `Session.detect()` определяет прошивку: «AT + голый Modbus RTU» или «EyeBond‑заголовок, FC=4». `run()` отдаёт через `onReady` API `{read, write, connected}`; все обращения к стику сериализованы через `exclusive()` (стик отвечает строго по порядку, без id транзакций). `write` после записи ждёт и читает регистр обратно. Опрос: `pollOnce()` читает `RANGES` из `must.mjs` и вызывает `onData`; период — `getInterval()` (Live‑режим бота уменьшает его до 5 с).
- **`must.mjs`** — карта регистров (`RANGES`) и `decode(regs)` → плоский объект с полями вида `pvPower_W`, `batteryVoltage_V` и текстовыми расшифровками состояний/ошибок. `readMust` здесь — вариант через Solarman V5, основной путь его не использует.
- **`solarman.mjs`** — CRC16/Modbus‑кадры (используются и в EyeBond‑пути) + клиент Solarman V5.
- **`controls.mjs`** — белый список записываемых настроек (`CONTROLS`) с диапазонами; `toRaw`/`toDisplay` масштабируют значения с учётом номинала батареи (`battVolGrade`, 12/24/48 В); `CONTROL_RANGES` — какие регистры перечитываются для отображения текущих настроек. Новая настройка добавляется только сюда. «Заряд от сети» сделан через регистр 20143, т.к. 20106 на PV18 запись принимает, но не применяет.
- **`dashboard.mjs`** — точка входа: парсит `.env`/флаги, держит `latest`, `status`, историю за 48 ч в памяти (+ `data/history-YYYY-MM-DD.jsonl`), раз в минуту `refreshControls()`. HTTP без фреймворка: `/` (`dashboard.html`), `/api/state`, `/events` (SSE), `/api/controls`, `POST /api/control` (по `CONTROL_PIN`), `/api/export.csv`; Basic Auth через `DASH_USER`/`DASH_PASS`. `applyControl()` — единая точка записи для веба и бота, пишет в `data/audit.jsonl`. Запускает бота через `startTelegram({...getters, applyControl})`.
- **`telegram.mjs`** — бот на long polling через `node:https` (новое соединение на каждый запрос, IPv4 first). Состояние (привязанные чаты, уведомления, тихий режим, начало отключения сети) — в `data/telegram.json`. Доступ — по `TELEGRAM_PASSWORD`; смена пароля отвязывает все чаты. Детекция событий (пропала/вернулась сеть по двум замерам, ошибки, низкий заряд, нет данных >5 мин) идёт по потоку `getLatest()`.
- **`runtime.mjs`** — оценка времени работы от батареи (профиль по типу батареи; тип USER считается LiFePO4).
- **`dashboard.html`** — весь фронтенд одним файлом (inline CSS/JS, без сборки).

Знаки мощности: `BATTERY_POWER_SIGN`/`GRID_POWER_SIGN` в `dashboard.mjs` и `GRID_IMPORT_SIGN`/`BAT_CHARGE_SIGN` в `telegram.mjs` (все `-1`) — учитывайте при работе с `batteryPower_W`/`gridPower_W`.

## Данные и секреты

`data/` (история, `audit.jsonl`, `telegram.json`), `.env`, `.dashpass`, `.controlpin`, `.tgtoken`, `.loggerip` — в `.gitignore`. `start.sh` — запуск в Termux без PM2 (генерирует пароль/PIN, опционально туннель Cloudflare).
