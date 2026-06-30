const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

let pool;

try {
    // Чтение ip.txt из корня проекта (на уровень выше текущего файла)
    const ipFilePath = path.join(__dirname, '..', 'ip.txt');
    
    if (!fs.existsSync(ipFilePath)) {
        throw new Error(`Файл конфигурации не найден по пути: ${ipFilePath}`);
    }

    const content = fs.readFileSync(ipFilePath, 'utf8').trim();
    
    // Парсинг строки вида: server=85.174.248.59;port=3307;uid=user1;...
    const config = {};
    content.split(';').forEach(pair => {
        const [key, value] = pair.split('=');
        if (key && value) {
            config[key.trim().toLowerCase()] = value.trim();
        }
    });

    // Проверка обязательных параметров
    if (!config.server || !config.uid || !config.password || !config.database) {
        throw new Error('Некорректный формат строки подключения в ip.txt');
    }

    // Создание пула подключений к MySQL
    pool = mysql.createPool({
        host: config.server,
        port: parseInt(config.port) || 3307,
        user: config.uid,
        password: config.password,
        database: config.database,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000
    });

    console.log(`[БД] Пул подключений успешно инициализирован (${config.server}:${config.port})`);
} catch (error) {
    console.error('[Критическая ошибка БД]:', error.message);
    process.exit(1);
}

module.exports = pool;