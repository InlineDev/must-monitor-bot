#!/data/data/com.termux/files/usr/bin/bash
# Запуск дашборда + публичная ссылка через Cloudflare Tunnel + QR-код на неё.
#
#   bash start.sh                 # IP логгера по умолчанию 192.168.0.142
#   LOGGER_IP=192.168.0.150 bash start.sh
#
# Пароль на вход и PIN управления генерируются при первом запуске и хранятся
# в файлах .dashpass и .controlpin (поменять — отредактируйте файлы или задайте DASH_PASS / CONTROL_PIN).
# Нужно один раз: pkg install -y nodejs cloudflared libqrencode

cd "$(dirname "$0")" || exit 1
LOGGER_IP="${LOGGER_IP:-192.168.0.142}"
HTTP_PORT="${HTTP_PORT:-3000}"
export DASH_USER="${DASH_USER:-admin}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Не найден $1 — выполните: pkg install -y $2"; exit 1; }; }
need node nodejs
need cloudflared cloudflared
command -v qrencode >/dev/null 2>&1 || echo "(для QR-кода: pkg install -y libqrencode)"

gen() { head -c 64 /dev/urandom | base64 | tr -dc "$1" | head -c "$2"; }
if [ -z "$DASH_PASS" ]; then
  [ -s .dashpass ] || { gen 'A-Za-z0-9' 16 > .dashpass; chmod 600 .dashpass; }
  DASH_PASS="$(cat .dashpass)"
fi
if [ -z "$CONTROL_PIN" ]; then
  [ -s .controlpin ] || { gen '0-9' 6 > .controlpin; chmod 600 .controlpin; }
  CONTROL_PIN="$(cat .controlpin)"
fi
export DASH_PASS

command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock

cleanup() {
  echo; echo "Останавливаю…"
  kill "$DASH_PID" "$TUN_PID" 2>/dev/null
  command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock
  exit 0
}
trap cleanup INT TERM

node dashboard.mjs "$LOGGER_IP" --http "$HTTP_PORT" --control-pin "$CONTROL_PIN" > dashboard.log 2>&1 &
DASH_PID=$!
sleep 2
kill -0 "$DASH_PID" 2>/dev/null || { echo "Дашборд не запустился:"; cat dashboard.log; exit 1; }

: > tunnel.log
cloudflared tunnel --no-autoupdate --url "http://localhost:$HTTP_PORT" > tunnel.log 2>&1 &
TUN_PID=$!

echo "Жду ссылку от Cloudflare…"
URL=""
for _ in $(seq 1 60); do
  URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' tunnel.log | head -n1)"
  [ -n "$URL" ] && break
  kill -0 "$TUN_PID" 2>/dev/null || break
  sleep 1
done
if [ -z "$URL" ]; then
  echo "Не удалось получить ссылку. Последние строки tunnel.log:"; tail -n 15 tunnel.log
  cleanup
fi
echo "$URL" > public-url.txt

clear 2>/dev/null
echo "=================================================="
echo " Дашборд MUST доступен из интернета:"
echo
echo "   $URL"
echo
if command -v qrencode >/dev/null 2>&1; then
  qrencode -t ansiutf8 -m 1 "$URL"
fi
echo " Логин:  $DASH_USER"
echo " Пароль: $DASH_PASS"
echo " PIN управления: $CONTROL_PIN"
echo
echo " Локально: http://localhost:$HTTP_PORT"
echo " Журналы: dashboard.log, tunnel.log   Остановить: Ctrl+C"
echo "=================================================="

# следим за процессами: если один упал — сообщаем
while true; do
  sleep 10
  kill -0 "$DASH_PID" 2>/dev/null || { echo "Дашборд остановился, см. dashboard.log"; tail -n 5 dashboard.log; cleanup; }
  kill -0 "$TUN_PID" 2>/dev/null || { echo "Туннель остановился, см. tunnel.log"; tail -n 5 tunnel.log; cleanup; }
done
