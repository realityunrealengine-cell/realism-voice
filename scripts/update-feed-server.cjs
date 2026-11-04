// Локальный сервер обновлений для тестов: только 127.0.0.1, поддерживает Range для дифференциальной загрузки.
const fs = require('node:fs');
const http = require('node:http');

/** resolve(имя файла) возвращает путь к файлу или null */
function serveFile(file, req, res) {
  const size = fs.statSync(file).size;
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  res.writeHead(range ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  fs.createReadStream(file, { start, end }).pipe(res);
}

function createFeedServer(resolve) {
  return http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '');
    const file = resolve(name);
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    serveFile(file, req, res);
  });
}

module.exports = { createFeedServer };
