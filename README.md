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

### Google Sign-In (без зміни `.env`)

1. У Google Cloud Console створіть OAuth Client ID (тип **Web application**).
2. Authorized JavaScript origins: `https://schedule.tereshkovych.com.ua` (і ваш домен).
3. Впишіть Client ID у файл `auth.config.json` у корені проєкту:
   ```json
   { "googleClientId": "123456789-xxxx.apps.googleusercontent.com" }
   ```
4. Задеплойте (файл їде з кодом; `.env` чіпати не потрібно). На сторінці входу з’явиться кнопка Google.

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

## Nginx + HTTPS

Конфіг у репозиторії: `nginx-surgion-schedule.conf` (HTTP → HTTPS + proxy `/api/`).

На VPS найпростіше видати безкоштовний сертифікат Let's Encrypt:

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx \
  -d surgion-schedule.tereshkovych.com.ua \
  -d imaging-schedule.tereshkovych.com.ua \
  -d surgeon-schedule.tereshkovych.com.ua
sudo nginx -t && sudo systemctl reload nginx
```

Перевірка автооновлення сертифіката:

```bash
sudo certbot renew --dry-run
```

Після змін без certbot: скопіюйте `nginx-surgion-schedule.conf` у `/etc/nginx/sites-available/`, увімкніть сайт і зробіть `nginx -t && systemctl reload nginx`.

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
