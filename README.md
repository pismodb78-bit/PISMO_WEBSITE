# PISMO Web

Веб-версия мессенджера PISMO: чаты, группы, файлы и звонки прямо в браузере.
Работает с той же базой `bdauth`, что ПК- и Android-клиенты, и с тем же
LiveKit для звонков.

| Часть | Что это | Где лежит |
|---|---|---|
| `backend/` | Node.js: вход по REST (`/api/auth`), всё остальное через Socket.io | порт 5000 |
| `frontend/` | React + Vite, после сборки обычные статические файлы | `frontend/dist` |

- [Установка на VPS](#установка-на-vps)
- [Обновление](#обновление)
- [Запуск у себя для разработки](#запуск-у-себя-для-разработки)
- [Если что-то не работает](#если-что-то-не-работает)

---

## Установка на VPS

Ставим на тот же сервер `5.181.23.167`, где уже работают MariaDB, ws-сервер и
LiveKit (см. `deploy/UBUNTU-VPS.md` в репозитории
[PISMO_MESSENDGER](https://github.com/pismodb78-bit/PISMO_MESSENDGER)). Идите
по шагам сверху вниз.

**Как это устроено после установки.** Снаружи открыт один сайт на 443-м
порту. nginx отдаёт страницы, а запросы `/api`, `/socket.io` и `/rtc`
перекидывает внутрь сервера:

| Адрес на сайте | Куда уходит |
|---|---|
| `/` | файлы из `/opt/pismo-web/frontend/dist` |
| `/api/…`, `/socket.io/…` | бэкенд `127.0.0.1:5000` (снаружи его не видно) |
| `/rtc…` | LiveKit `127.0.0.1:7880` (звонки из браузера) |

Бэкенд ходит в базу по `127.0.0.1:3307`, то есть внутри сервера.

**Почему обязательно HTTPS.** Браузер не даёт сайту на `http://` доступ к
микрофону и камере, а со страницы `https://` не пускает на `ws://`. Без
сертификата чаты будут работать, а звонки нет.

### 1. Что уже должно стоять

```bash
ssh root@5.181.23.167

node --version                  # v20 или новее (ставился вместе с ws-сервером)
systemctl is-active mariadb nginx
curl -s http://127.0.0.1:7880   # LiveKit отвечает «OK»
ss -tlnp | grep -E ':(80|443|5000)\s'   # должно быть пусто: порты свободны
```

Если 80-й порт занят nginx, это его сайт по умолчанию. Уберите его:
`rm /etc/nginx/sites-enabled/default && systemctl reload nginx`.

Если Node.js нет:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git
```

Если nginx нет: `apt install -y nginx`.

### 2. Код

```bash
apt install -y git
B=claude/pismo-android-version-qd5fxr
git clone -b "$B" https://github.com/pismodb78-bit/PISMO_WEBSITE /opt/pismo-web

cd /opt/pismo-web/backend  && npm ci --omit=dev
cd /opt/pismo-web/frontend && npm ci && npm run build
ls /opt/pismo-web/frontend/dist   # index.html и папка assets
```

Когда ветку вольют в `main`, клонируйте без `-b`.

### 3. Адрес сайта

Определитесь, по какому адресу будет открываться сайт. От этого зависит
сертификат на шаге 6.

- **Есть домен** (например, `pismo.example.ru`, его A-запись указывает на
  `5.181.23.167`): нормальный сертификат Let's Encrypt, без предупреждений.
- **Домена нет**: сайт по IP, самоподписанный сертификат. Браузер один раз
  предупредит, и это нужно будет подтвердить на каждом устройстве.

```bash
SITE=pismo.example.ru      # домен или 5.181.23.167
```

Переменная `SITE` нужна в шагах 4–6. Делайте их в той же ssh-сессии.

### 4. Настройки бэкенда

Секреты храним отдельным файлом с доступом только для root, как у ws-сервера.

```bash
# Ключ и секрет LiveKit — те же, что в его конфиге
read LK_KEY LK_SECRET <<<"$(sed -n '/^keys:/{n;s/^ *\([^:]*\): *\(.*\)$/\1 \2/p}' /root/livekit.yaml)"
echo "LiveKit: $LK_KEY"     # не пусто? если пусто — впишите руками ниже

# Пароль пользователя базы user1 (шаг 4.1 инструкции по VPS; тот же, что
# в ip.txt у ПК-клиента). На экране не отображается
read -rsp 'Пароль user1: ' DB_PASS; echo

install -m 600 /dev/null /etc/pismo-web.env   # сразу закрыт для чужих
cat > /etc/pismo-web.env <<EOF
PORT=5000
HOST=127.0.0.1

# База на этом же сервере. Порт 3307, как в 60-pismo.cnf
DB_HOST=127.0.0.1
DB_PORT=3307
DB_USER=user1
DB_PASSWORD=$DB_PASS
DB_NAME=bdauth

# Звонки. WS-адрес отдаётся браузеру: через nginx, по HTTPS
LIVEKIT_WS_URL=wss://$SITE
LIVEKIT_HTTP_URL=http://127.0.0.1:7880
LIVEKIT_API_KEY=$LK_KEY
LIVEKIT_API_SECRET=$LK_SECRET
EOF

# Секрет подписи токенов — тот же, что у ws-сервера, иначе вход с сайта
# не будет признан остальными частями PISMO
grep '^JWT_SECRET=' /etc/pismo-ws.env >> /etc/pismo-web.env

sed -E 's/(PASSWORD|SECRET)=.*/\1=***/' /etc/pismo-web.env
```

Ошиблись в чём-то — поправьте файл: `nano /etc/pismo-web.env`, затем
`systemctl restart pismo-web`.

### 5. Автозапуск бэкенда

```bash
cat > /etc/systemd/system/pismo-web.service <<'EOF'
[Unit]
Description=PISMO Web backend
After=network.target mariadb.service

[Service]
Type=simple
WorkingDirectory=/opt/pismo-web/backend
EnvironmentFile=/etc/pismo-web.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
User=nobody
Group=nogroup
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now pismo-web
journalctl -u pismo-web -n 20 --no-pager
curl -s http://127.0.0.1:5000/api/health
```

В логе должны быть `[БД] Пул подключений успешно инициализирован
(127.0.0.1:3307/bdauth)` и `запущен на 127.0.0.1:5000`, а `curl` должен
ответить `{"status":"active",…}`.

### 6. nginx и сертификат

Общая часть для обоих вариантов, то есть всё, кроме сертификата:

```bash
cat > /etc/nginx/conf.d/pismo-upgrade.conf <<'EOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
EOF

cat > /etc/nginx/snippets/pismo-web.conf <<'EOF'
root /opt/pismo-web/frontend/dist;
index index.html;
server_tokens off;
# Файлы в чате идут через Socket.io, бэкенд принимает до 60 МБ
client_max_body_size 64m;

# Страницы приложения: любой путь без файла — это index.html
location / {
    try_files $uri $uri/ /index.html;
}
location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}

location /api/ {
    proxy_pass http://127.0.0.1:5000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /socket.io/ {
    proxy_pass http://127.0.0.1:5000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
}

# Сигналинг LiveKit: браузер подключается к wss://сайт/rtc
location /rtc {
    proxy_pass http://127.0.0.1:7880;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
}
EOF
```

#### Вариант А: домен и Let's Encrypt

```bash
apt install -y certbot python3-certbot-nginx

cat > /etc/nginx/sites-available/pismo-web <<EOF
server {
    listen 80;
    server_name $SITE;
    include snippets/pismo-web.conf;
}
EOF
ln -sf /etc/nginx/sites-available/pismo-web /etc/nginx/sites-enabled/
ufw allow 80/tcp && ufw allow 443/tcp
nginx -t && systemctl reload nginx

certbot --nginx -d "$SITE" --redirect --agree-tos -m you@example.com --no-eff-email
```

Вместо `you@example.com` укажите свою почту: на неё придёт письмо, если
продление сертификата сломается. certbot сам добавит в конфиг 443-й порт и
перенаправление с `http://`, а продлевать сертификат будет по таймеру.
Проверка продления: `certbot renew --dry-run`.

#### Вариант Б: без домена, по IP

```bash
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout /etc/ssl/private/pismo-web.key -out /etc/ssl/certs/pismo-web.crt \
  -subj "/CN=$SITE" -addext "subjectAltName=IP:$SITE"
chmod 600 /etc/ssl/private/pismo-web.key

cat > /etc/nginx/sites-available/pismo-web <<'EOF'
server {
    listen 80;
    server_name _;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name _;
    ssl_certificate     /etc/ssl/certs/pismo-web.crt;
    ssl_certificate_key /etc/ssl/private/pismo-web.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    include snippets/pismo-web.conf;
}
EOF
ln -sf /etc/nginx/sites-available/pismo-web /etc/nginx/sites-enabled/
ufw allow 80/tcp && ufw allow 443/tcp
nginx -t && systemctl reload nginx
```

При первом входе на `https://5.181.23.167/` браузер предупредит о
сертификате: «Дополнительно» → «Перейти на сайт». После этого работают и
чаты, и звонки: страница и `/rtc` на одном адресе, поэтому подтверждать
нужно один раз. На телефоне это тоже нужно сделать один раз.

### 7. Фаервол

`80` и `443` открыты на шаге 6. Порт `5000` **не открывайте**: бэкенд
слушает только `127.0.0.1`, и снаружи он не нужен. Порты LiveKit
(`7881/tcp`, `50000:60000/udp`) уже открыты: по ним идут голос и видео,
мимо nginx.

```bash
ufw status numbered
```

### 8. Проверка

```bash
systemctl is-enabled pismo-web nginx
systemctl is-active  pismo-web nginx
curl -sk https://127.0.0.1/api/health      # {"status":"active",…}
```

В браузере на другом компьютере откройте `https://<SITE>/`, войдите
существующим аккаунтом PISMO, откройте чат и отправьте сообщение. Оно должно
сразу появиться на ПК и Android. Потом позвоните: браузер спросит доступ к
микрофону.

Перезагрузка проверяет автозапуск:

```bash
reboot
# через минуту
systemctl is-active mariadb pismo-ws pismo-web nginx
```

---

## Обновление

```bash
cd /opt/pismo-web && git pull
cd backend  && npm ci --omit=dev
cd ../frontend && npm ci && npm run build
systemctl restart pismo-web
```

nginx перезапускать не нужно: новые файлы из `dist` он отдаёт сразу.
Обновите страницу в браузере.

---

## Запуск у себя для разработки

Нужен Node.js 20+.

```bash
# Бэкенд: подключение берётся из ip.txt в корне (или из backend/.env)
cd backend && npm install && npm run dev

# Фронтенд, во втором окне
cd frontend && npm install && npm run dev
```

Откройте `http://localhost:5173`. Vite сам перекидывает `/api` и
`/socket.io` на `localhost:5000`. Бэкенд на другом адресе указывается
переменной `PISMO_BACKEND=http://адрес:5000 npm run dev`.

Настройки бэкенда можно положить в `backend/.env` (образец
`backend/.env.example`): переменные `DB_*` важнее `ip.txt`, а без
`LIVEKIT_*` не будут работать звонки.

`ip.txt` в том же формате, что у ПК-клиента. Подойдёт и файл, скопированный
от `PISMO.exe`, лишние ключи (`ws=`, `livekit=`) не мешают:

```
server=5.181.23.167;port=3307;uid=user1;password=…;database=bdauth
```

---

## Если что-то не работает

| Признак | Где смотреть |
|---|---|
| Страница не открывается | `nginx -t`, `systemctl status nginx`, `ufw status` (нужны 80 и 443) |
| 502 Bad Gateway | бэкенд не запущен: `journalctl -u pismo-web -n 50 --no-pager` |
| `[Критическая ошибка БД]` в логе | `/etc/pismo-web.env`: адрес, порт 3307, пароль; `systemctl is-active mariadb` |
| Вход проходит, сообщения не приходят | не проходит Socket.io: блок `location /socket.io/` в nginx, `journalctl -u pismo-web -f` |
| Звонок не начинается | открыт ли сайт по `https://`; `LIVEKIT_*` в `/etc/pismo-web.env`; `curl -s http://127.0.0.1:7880` |
| Звонок соединяется, но нет звука | закрыты порты LiveKit: `ufw allow 7881/tcp`, `ufw allow 50000:60000/udp` |
| После обновления старая страница | обновите страницу с Ctrl+F5 |
