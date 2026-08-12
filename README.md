# Розклад операцій — вебверсія

Вебзастосунок для хірургічного відділення **Національного інституту фтизіатрії і пульмонології ім. Ф.Г. Яновського НАМН України**.

## Що вміє

- розклад операцій (CRUD) у **MySQL**
- прикріплені зображення/відео (файли на диску + метадані в MySQL)
- журнал змін (додано / змінено поля / видалено)
- журнал доступів з **IP**
- спільний пароль відділення (перевірка на сервері)
- вкладки: розклад, архів, працівники, журнали
- архів: операції з датою раніше сьогодні; автовидалення з медіа через 7 днів

## Серверний `.env`

На VPS у каталозі застосунку створіть `.env` (див. `.env.example`):

```env
ACCESS_PASSWORD=...
PORT=3001
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=...
MYSQL_PASSWORD=...
MYSQL_DATABASE=surgion_schedule
```

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

## CI/CD

GitHub Actions rsync-ить код і виконує `npm install` + `pm2 startOrReload`.  
Секрети: `VPS_HOST`, `VPS_USER`, `VPS_SSH_PRIVATE_KEY` (опційно `VPS_DEPLOY_PATH`).  
Пароль і MySQL — лише в серверному `.env`.
