# OKTREK GoDaddy VPS Deployment Guide

This folder contains the production-ready OKTREK application.

## Requirements
- GoDaddy VPS or Dedicated Server
- Node.js 20+ and npm
- Domain pointed to your VPS IP
- (Optional) PM2 or systemd for process management
- (Optional) Nginx reverse proxy

## Upload
1. Upload OKTREK.zip to your VPS (e.g., /home/youruser/).
2. Extract it:

~~~bash
unzip OKTREK.zip
cd OKTREK
~~~

## Install
~~~bash
npm install
~~~

## Configure
1. Copy the environment template:

~~~bash
cp .env.example .env
nano .env
~~~

2. Fill in all secrets and set APP_URL to your domain.
3. Generate AES_KEY_MFA:

~~~bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
~~~

## Database
Default is SQLite. Run migrations and seed demo data:

~~~bash
npm run migrate
npm run seed
~~~

For MySQL, update DATABASE_URL in .env before running migrations.

## Start the app
### Option A: PM2 (recommended)
~~~bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
~~~

### Option B: systemd
1. Edit oktrek.service to match your user and path.
2. Copy it to systemd:

~~~bash
sudo cp oktrek.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now oktrek
~~~

### Option C: direct
~~~bash
npm start
~~~

## Nginx reverse proxy
Create /etc/nginx/sites-available/oktrek:

~~~nginx
server {
  listen 80;
  server_name yourdomain.com www.yourdomain.com;

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
~~~

Enable it:

~~~bash
sudo ln -s /etc/nginx/sites-available/oktrek /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
~~~

## SSL
Use GoDaddy SSL or Let's Encrypt:

~~~bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
~~~

## Updates
Upload the new OKTREK folder, run npm install, npm run migrate, then restart:

~~~bash
pm2 restart oktrek
# or
sudo systemctl restart oktrek
~~~
