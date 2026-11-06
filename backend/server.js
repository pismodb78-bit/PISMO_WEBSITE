// Настройки из backend/.env (если файл есть) — до всех require: модули ниже
// читают process.env прямо при загрузке. Уже заданные переменные (например,
// из systemd на VPS) не перетираются. Без зависимостей: формат KEY=VALUE.
(() => {
    const fs = require('fs');
    const file = require('path').join(__dirname, '.env');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m || process.env[m[1]] !== undefined) continue;
        process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
})();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const socketAuth = require('./socket/auth');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: (origin, callback) => {
            // На этапе разработки разрешаем любой origin, но ОТРАЖАЕМ его явно,
            // а не возвращаем '*' — это обязательно при credentials: true на клиенте
            callback(null, origin);
        },
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        credentials: true
    },
    maxHttpBufferSize: 60 * 1024 * 1024
});

app.use(cors({
    origin: (origin, callback) => callback(null, origin),
    credentials: true
}));
app.use(express.json());

// Только авторизация остаётся на REST. Все чаты, файлы, группы — через сокеты.
app.use('/api/auth', authRoutes);

app.get('/api/health', (req, res) => {
    res.json({ status: 'active', build: 'PISMO-Web-v2.0-WS' });
});

// Аутентификация сокета по JWT на этапе handshake — единственное место проверки токена
io.use(socketAuth);

io.on('connection', (socket) => {
    console.log(`[Socket] Подключен user_${socket.userId} (${socket.id})`);

    require('./socket/chat')(io, socket);
    require('./socket/call')(io, socket); // обработчики звонков (call:invite/accept/decline/...)

    socket.on('disconnect', () => {
        console.log(`[Socket] Отключен user_${socket.userId} (${socket.id})`);
    });
});

global.io = io;

const PORT = process.env.PORT || 5000;
// На VPS бэкенд закрыт за nginx: HOST=127.0.0.1, снаружи его не видно.
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
    console.log(`==================================================`);
    console.log(`🚀 Сервер PISMO Web (WebSocket-only) запущен на ${HOST}:${PORT}`);
    console.log(`==================================================`);
});