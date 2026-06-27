
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
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
});