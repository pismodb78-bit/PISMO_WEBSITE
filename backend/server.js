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

    socket.on('disconnect', () => {
        console.log(`[Socket] Отключен user_${socket.userId} (${socket.id})`);
    });
});

global.io = io;

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`🚀 Сервер PISMO Web (WebSocket-only) запущен на порту ${PORT}`);
    console.log(`==================================================`);
});