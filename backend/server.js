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
const https = require('https');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const cors = require('cors');

const config = require('./config');
const db = require('./db');
const { socketAuth } = require('./utils/session');
const presence = require('./data/presence');
const live = require('./live');
const livekit = require('./utils/livekit');

const startedAt = Date.now();

const app = express();

/**
 * HTTPS, если заданы SSL_KEY и SSL_CERT.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ НУЖНО. Браузер отдаёт микрофон, камеру и демонстрацию
 * экрана только в «защищённом контексте»: https либо localhost. На обычном
 * http по адресу вида 192.168.0.10:5000 объекта navigator.mediaDevices не
 * существует вовсе, и звонки не начнутся ни при каких разрешениях — в
 * настройках сайта камера и микрофон показаны серыми, выдать их нельзя.
 *
 * ВАЖНО: одного https на сайте мало. Со страницы по https браузер не
 * пустит соединение на ws:// — это смешанное содержимое. Значит и LiveKit
 * должен быть за TLS, а LIVEKIT_URL — начинаться с wss://. Иначе один
 * запрет просто меняется на другой.
 */
function createServer() {
    const keyPath = process.env.SSL_KEY;
    const certPath = process.env.SSL_CERT;
    if (!keyPath || !certPath) return { server: http.createServer(app), secure: false };

    try {
        const options = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath),
        };
        return { server: https.createServer(options, app), secure: true };
    } catch (err) {
        console.error(`[TLS] не удалось прочитать сертификат: ${err.message}`);
        console.error('[TLS] поднимаюсь по http — звонки в браузере работать не будут');
        return { server: http.createServer(app), secure: false };
    }
}

const { server, secure } = createServer();

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
        const front = frontendState();
        res.json({
            status: 'ok',
            db: `${config.db.host}:${config.db.port}`,
            mysql: version,
            startedAt: new Date(startedAt).toISOString(),
            frontend: front.exists
                ? { builtAt: new Date(front.builtAt).toISOString(), stale: front.stale }
                : { builtAt: null, stale: false },
        });
    } catch (err) {
        // База лежит — но сам сайт жив, и сказать об этом честнее, чем 500
        // без объяснений: ровно этот случай выглядел как «сайт не работает».
        res.status(503).json({ status: 'db_unavailable', error: err.code || err.message });
    }
});

// ── Собранный фронтенд ────────────────────────────────────────────────
//
// Если рядом лежит frontend/dist, отдаём его этим же процессом: на боевой
// машине так не нужен отдельный веб-сервер и не возникает вопросов с CORS.
//
// ПРО УСТАРЕВШУЮ СБОРКУ. frontend/dist лежит в .gitignore, то есть
// `git pull` его НЕ обновляет. Из-за этого получалась ловушка: человек
// забирает исправления, перезапускает сервер — и продолжает видеть старый
// сайт, потому что отдаётся вчерашняя сборка. Ошибка при этом выглядит как
// «исправление не помогло», и искать её будут где угодно, только не здесь.
// Поэтому сборку сверяем с исходниками и, если она отстала, говорим об
// этом и в консоль, и прямо на странице.
const frontDir = path.join(__dirname, '..', 'frontend');
const distDir = path.join(frontDir, 'dist');
const indexFile = path.join(distDir, 'index.html');

/** Время последней правки среди исходников фронтенда. */
function newestSourceTime(dir) {
    let newest = 0;
    const walk = (current) => {
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (_) {
            return;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === 'dist') continue;
                walk(full);
            } else {
                try {
                    const t = fs.statSync(full).mtimeMs;
                    if (t > newest) newest = t;
                } catch (_) { /* файл исчез между чтениями — не важно */ }
            }
        }
    };
    walk(dir);
    return newest;
}

/** Отстала ли сборка от исходников. */
function frontendState() {
    if (!fs.existsSync(indexFile)) return { exists: false, stale: false, builtAt: null };
    const builtAt = fs.statSync(indexFile).mtimeMs;
    const sources = Math.max(
        newestSourceTime(path.join(frontDir, 'src')),
        ...['index.html', 'vite.config.js', 'package.json'].map((f) => {
            try { return fs.statSync(path.join(frontDir, f)).mtimeMs; } catch (_) { return 0; }
        }),
    );
    return { exists: true, stale: sources > builtAt, builtAt, sources };
}

const STALE_BANNER = `
<div id="pismo-stale" style="position:fixed;left:0;right:0;top:0;z-index:99999;
     background:#ED4245;color:#fff;font:14px/1.4 'Segoe UI',system-ui,sans-serif;
     padding:10px 16px;text-align:center">
  Открыта <b>устаревшая сборка</b> сайта: исходники новее.
  Выполните <code style="background:rgba(0,0,0,.25);padding:1px 5px;border-radius:3px">npm run build</code>
  в папке <b>frontend</b> и обновите страницу.
</div>`;

if (fs.existsSync(distDir)) {
    // index: false — index.html отдаём сами, чтобы при устаревшей сборке
    // дописать в него предупреждение.
    app.use(express.static(distDir, { index: false }));

    app.get(/^(?!\/api\/).*/, (_req, res) => {
        const state = frontendState();
        if (!state.stale) return res.sendFile(indexFile);
        try {
            const html = fs.readFileSync(indexFile, 'utf8');
            res.type('html');
            return res.send(html.replace('<body>', `<body>${STALE_BANNER}`));
        } catch (_) {
            return res.sendFile(indexFile);
        }
    });

    const state = frontendState();
    console.log(`[веб] отдаём собранный фронтенд из ${distDir}`);
    if (state.stale) {
        console.warn('');
        console.warn('  ВНИМАНИЕ: сборка фронтенда устарела — исходники новее.');
        console.warn(`  Собрана: ${new Date(state.builtAt).toLocaleString('ru-RU')}`);
        console.warn(`  Правки:  ${new Date(state.sources).toLocaleString('ru-RU')}`);
        console.warn('  Выполните: npm --prefix frontend run build');
        console.warn('');
    }
} else {
    console.warn('');
    console.warn(`  Сборки фронтенда нет (${distDir}).`);
    console.warn('  Сайт отдаваться не будет. Выполните: npm --prefix frontend run build');
    console.warn('');
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

// Живая доставка: сообщения с ПК и Android приходят прямо в базу, минуя
// наш сокет, и без этого опроса появлялись бы на сайте только после
// перезагрузки страницы. См. live.js.
live.start(io);

server.listen(config.port, () => {
    const scheme = secure ? 'https' : 'http';
    console.log('='.repeat(58));
    console.log(`  PISMO Web запущен: ${scheme}://<адрес>:${config.port}`);
    console.log(`  База:    ${config.db.host}:${config.db.port}/${config.db.database}`);
    console.log(`  LiveKit: ${config.livekit.url}`);

    if (!secure) {
        console.log('');
        console.log('  Звонки: браузер даёт микрофон только по https или с localhost.');
        console.log(`  На этой машине открывайте http://localhost:${config.port} — так они работают.`);
        console.log('  Для доступа по сети задайте SSL_KEY и SSL_CERT (подробности в README).');
    } else if (/^ws:\/\//i.test(config.livekit.url)) {
        console.log('');
        console.log('  ВНИМАНИЕ: сайт по https, а LIVEKIT_URL по ws:// — браузер такое');
        console.log('  соединение заблокирует. Адрес LiveKit должен быть wss://.');
    }
    console.log('='.repeat(58));
});

module.exports = { app, server, io };
