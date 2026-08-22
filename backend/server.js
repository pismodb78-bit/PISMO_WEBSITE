/**
 * PISMO Web — шлюз между браузером и той же базой `bdauth`, с которой
 * работают ПК-клиент (PISMO.exe) и Android (pismo.apk).
 *
 * Зачем шлюз вообще нужен: приложения ходят в MySQL напрямую, а веб-страница
 * так не может — из браузера нельзя открыть TCP-сокет к базе. Поэтому здесь
 * повторён тот же слой запросов, только за пределами страницы, плюс всё,
 * что нельзя отдавать в браузер: секрет LiveKit и доступ к базе.
 *
 * Данные при этом общие: написанное с сайта видно на телефоне и на
 * компьютере, и наоборот, — отдельной «веб-базы» нет.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const cors = require('cors');

const config = require('./config');
const db = require('./db');
const { socketAuth } = require('./utils/session');
const presence = require('./data/presence');
const livekit = require('./utils/livekit');

const app = express();
const server = http.createServer(app);

/**
 * CORS. Пустой список origin — режим разработки: отражаем присланный
 * origin. Отражаем, а не возвращаем '*', потому что клиент ходит с
 * credentials, и со звёздочкой браузер запрос отклонит.
 */
function corsOrigin(origin, callback) {
    if (config.corsOrigins.length === 0) return callback(null, origin || true);
    if (!origin || config.corsOrigins.includes(origin)) return callback(null, origin || true);
    return callback(new Error('CORS: origin не разрешён'));
}

const io = new Server(server, {
    cors: { origin: corsOrigin, methods: ['GET', 'POST'], credentials: true },
    // Вложения уходят через HTTP, но голосовые и картинки удобнее слать
    // прямо в событии — с запасом на самый большой такой кусок.
    maxHttpBufferSize: config.chunkBytes + 2 * 1024 * 1024,
});

app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '10mb' }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/media', require('./routes/media'));

/** Что фронтенду нужно знать до входа. */
app.get('/api/config', (_req, res) => {
    res.json({
        livekitConfigured: livekit.isConfigured(),
        livekitUrl: config.livekit.url,
        maxUploadBytes: config.maxUploadBytes,
    });
});

app.get('/api/health', async (_req, res) => {
    try {
        const version = await db.ping();
        res.json({ status: 'ok', db: `${config.db.host}:${config.db.port}`, mysql: version });
    } catch (err) {
        // База лежит — но сам сайт жив, и сказать об этом честнее, чем 500
        // без объяснений: ровно этот случай выглядел как «сайт не работает».
        res.status(503).json({ status: 'db_unavailable', error: err.code || err.message });
    }
});

// ── Собранный фронтенд ────────────────────────────────────────────────
// Если рядом лежит frontend/dist, отдаём его этим же процессом: на боевой
// машине так не нужен отдельный веб-сервер и не возникает вопросов с CORS.
const distDir = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
    console.log(`[веб] отдаём собранный фронтенд из ${distDir}`);
}

// ── Сокеты ────────────────────────────────────────────────────────────

io.use(socketAuth);

io.on('connection', (socket) => {
    const me = socket.userId;
    // Персональная комната: у одного человека может быть несколько вкладок
    // и телефон — события должны приходить на все сразу.
    socket.join(`user_${me}`);

    require('./socket/chat')(io, socket);
    require('./socket/servers')(io, socket);
    require('./socket/social')(io, socket);
    require('./socket/calls')(io, socket);

    // Вход отмечаем сразу, иначе собеседник увидит «в сети» только через
    // такт heartbeat.
    presence.heartbeat(me, true).catch(() => {});

    socket.on('disconnect', async () => {
        // Гасим точку только когда закрылась последняя вкладка этого
        // человека: иначе закрытие одной из двух показывало бы его офлайн.
        const room = io.sockets.adapter.rooms.get(`user_${me}`);
        if (!room || room.size === 0) {
            presence.markOffline(me).catch(() => {});
        }
    });
});

server.listen(config.port, () => {
    console.log('='.repeat(58));
    console.log(`  PISMO Web запущен на порту ${config.port}`);
    console.log(`  База:    ${config.db.host}:${config.db.port}/${config.db.database}`);
    console.log(`  LiveKit: ${config.livekit.url}`);
    console.log('='.repeat(58));
});

module.exports = { app, server, io };
