// Перенаправляет логгер EyeBond на ваш сервер. Запускать ИЗ ДОМАШНЕЙ СЕТИ (с Mac),
// потому что логгер принимает этот UDP-пакет только из локальной сети.
//
//   node announce.mjs <IP_логгера> <IP_или_домен_сервера> [порт=8899]
//
// Обратно в облако SmartESS: перенастройте сеть стика в приложении SmartESS.
import dgram from 'node:dgram';
import dns from 'node:dns/promises';

const [loggerIp, target, port = '8899'] = process.argv.slice(2);
if (!loggerIp || !target) {
  console.error('Usage: node announce.mjs <IP_логгера> <IP_или_домен_сервера> [порт=8899]');
  process.exit(2);
}

// Логгеру нужен IP — домен резолвим здесь.
const ip = /^\d+\.\d+\.\d+\.\d+$/.test(target) ? target : (await dns.lookup(target, { family: 4 })).address;
const msg = Buffer.from(`set>server=${ip}:${Number(port)};`);
const sock = dgram.createSocket('udp4');
sock.send(msg, 58899, loggerIp, (err) => {
  sock.close();
  if (err) { console.error('Ошибка отправки:', err.message); process.exit(1); }
  console.log(`отправлено на ${loggerIp}:58899 → ${msg}`);
  console.log('Логгер должен подключиться к серверу в течение ~1 минуты. Отправляйте один раз: повтор рвёт его текущую сессию.');
});
