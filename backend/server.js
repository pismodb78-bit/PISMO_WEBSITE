
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const db = require('./db');
const authRoutes = require('./routes/auth');

const app = express();
const server = http.createServer(app);

// Интеграция Socket.IO с гибким CORS-доступом
const io = new Server(server, {
    cors: {
        origin: '*', // На этапе разработки разрешаем все запросы
        methods: ['GET', 'POST', 'PUT', 'DELETE']
    }
});

// Глобальные Middleware
app.use(cors());
app.use(express.json());

// Подключение роутеров приложения
app.use('/api/auth', authRoutes);
app.use('/api/messages', require('./routes/messages'));
app.use('/api/groups', require('./routes/groups'));
app.use('/api', require('./routes/notify'));



// Тестовый эндпоинт проверки жизнеспособности сервера
app.get('/api/health', (req, res) => {
    res.json({ status: 'active', build: 'PISMO-Web-v1.0' });
});

// Логика Socket.IO — вся обработка событий ('join', 'chat:join', 'message:new' и т.д.)
// находится ТОЛЬКО внутри socket/chat.js, чтобы не было дублей и расхождений.
io.on('connection', (socket) => {
    console.log(`[Socket] Новое подключение: ${socket.id}`);

    require('./socket/chat')(io, socket);

    socket.on('disconnect', () => {
        console.log(`[Socket] Соединение разорвано: ${socket.id}`);
    });
});

// Делаем инстанс io доступным внутри других файлов проекта (например, в роутах сообщений)
global.io = io;

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`🚀 Сервер PISMO Web успешно запущен на порту ${PORT}`);
    console.log(`==================================================`);

    // Проверка соединения с БД при старте — чтобы сразу видеть проблему,
    // а не ловить непонятную "внутреннюю ошибку" на каждом входе в систему.
    db.query('SELECT 1')
        .then(() => console.log('[БД] Соединение с базой данных установлено ✅'))
        .catch((e) => {
            console.error('[БД] НЕ УДАЛОСЬ подключиться к базе данных ❌');
            console.error(`     Причина: ${e.code || e.message}`);
            console.error('     Проверь: запущен ли MySQL, доступен ли host:port из ip.txt, верны ли логин/пароль/имя БД.');
        });
});