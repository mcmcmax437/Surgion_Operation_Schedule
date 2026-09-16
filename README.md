# Розклад операцій — вебверсія

Вебзастосунок для хірургічного відділення **Національного наукового центру фтизіатрії, пульмонології і алергології ім. Ф.Г. Яновського НАМН України**.

## Що вміє

- розклад операцій (CRUD) у **MySQL**
- прикріплені зображення/відео (файли на диску + метадані в MySQL)
- журнал змін (додано / змінено поля / видалено)
- журнал доступів з **IP**
- спільний пароль відділення (перевірка на сервері)
- акаунти лікарів (реєстрація / вхід) та адмін
- опційний вхід через Google
- вкладки: розклад, архів, працівники, журнали
- архів: операції з датою раніше сьогодні; автовидалення з медіа через 7 днів

## Серверний `.env`

На VPS у каталозі застосунку створіть `.env` (див. `.env.example`):

```env
ACCESS_PASSWORD=...          # опційно: старий спільний пароль відділення
ADMIN_EMAIL=admin@clinic.ua
ADMIN_PASSWORD=...
ADMIN_NAME=Адміністратор
REGISTRATION_ENABLED=true
GOOGLE_CLIENT_ID=...         # опційно: Google Identity Services client ID
PORT=3001
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=...
MYSQL_PASSWORD=...
MYSQL_DATABASE=surgion_schedule
```

### Google Sign-In

1. Створіть OAuth Client ID (тип **Web application**) у Google Cloud Console.
2. Додайте Authorized JavaScript origins: `https://your-domain` (і `http://localhost` для тестів).
3. Вставте Client ID у `GOOGLE_CLIENT_ID` у `.env` і перезапустіть API (`pm2 restart …`).
4. На сторінці входу з’явиться кнопка Google.

Створіть базу MySQL, наприклад:

```sql
CREATE DATABASE surgion_schedule CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Таблиці створюються автоматично при старті API.

## Запуск API

```bash
npm install --omit=dev
pm2 start ecosystem.config.cjs
pm2 save
```

## Nginx

Додайте proxy для API (окремий `server` для домену):

```nginx
server {
    listen 80;
    server_name surgion-schedule.tereshkovych.com.ua;

    root /usr/src/surgion_operation/Surgion_Operation_Schedule;
    index login.html index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 80m;
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
```

Після змін: `nginx -t && systemctl reload nginx`.

Якщо логін показує **502 Bad Gateway** — nginx не може достукатись до API на `127.0.0.1:3001`. На VPS:

```bash
pm2 status
pm2 logs surgion-schedule-api --lines 100 --nostream
curl -sS http://127.0.0.1:3001/api/health
# якщо API впало:
cd /usr/src/surgion_operation/Surgion_Operation_Schedule
pm2 startOrReload ecosystem.config.cjs --update-env
# також перевірте MySQL:
sudo systemctl status mysql
```

## CI/CD

GitHub Actions rsync-ить код і виконує `npm install` + `pm2 startOrReload`.  
Секрети: `VPS_HOST`, `VPS_USER`, `VPS_SSH_PRIVATE_KEY` (опційно `VPS_DEPLOY_PATH`).  
Пароль і MySQL — лише в серверному `.env`.
