# Running on Linux

Tested assumptions: Ubuntu 22.04/24.04 or Debian 12 (x86-64 or arm64). Other distributions work with equivalent packages.

## 1. Install Node.js 24 LTS

Pick one:

```bash
# Option A: nvm (per user, no sudo)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 24
node -v   # v24.x

# Option B: NodeSource packages (system-wide)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Also install git: `sudo apt-get install -y git`.

## 2. Get the code and install dependencies

```bash
git clone <your-repository-url> vshield
cd vshield
npm ci            # installs exact versions from package-lock.json and runs `prisma generate`
cp .env.example .env
```

Edit `.env` and replace every `change-me` password. For a server reachable by other machines, set `APP_URL` to the exact URL users open (for example `https://svs.example.com`), because requests from any other origin are rejected.

## 3. Choose a database

### Option A — development: embedded PostgreSQL (no installation)

```bash
npm run db:dev    # keep this terminal open; data is stored in .data/pg
```

Notes:

- Must run as a **normal user, not root** (PostgreSQL refuses to run as root).
- If it fails with a missing shared library, install ICU and readline: `sudo apt-get install -y libicu-dev libreadline8`.

### Option B — real PostgreSQL (recommended for servers)

```bash
sudo apt-get install -y postgresql            # 16+ recommended
sudo -u postgres psql <<'SQL'
CREATE ROLE vshield_owner LOGIN PASSWORD 'choose-a-strong-owner-password';
CREATE DATABASE vshield OWNER vshield_owner;
SQL
```

In `.env`:

```bash
MIGRATION_DATABASE_URL=postgresql://vshield_owner:<owner-password>@localhost:5432/vshield
DATABASE_URL=postgresql://vshield_app:<app-password>@localhost:5432/vshield
APP_DB_PASSWORD=<app-password, at least 16 characters>
```

Then create the tables, the security policies and the application role:

```bash
npm run db:migrate
npm run db:setup-roles
```

## 4. Create the first organization and administrator

```bash
npm run tenant:create -- --name "Acme Retail" --slug acme --email admin@acme.example --admin-name "Jane Doe"
```

The command prints a one-time temporary password; the administrator changes it at first sign-in. To choose the password yourself, run `export ADMIN_PASSWORD='a-long-passphrase'` before the command.

Optional demo data (synthetic, labelled SAMPLE DATA): `ADMIN_PASSWORD='a-long-passphrase' npm run seed:demo`.

## 5. Run the application

Development (three terminals):

```bash
npm run db:dev     # only with Option A
npm run dev        # http://localhost:3000
npm run worker     # processes uploaded scans; required
```

Production on one server:

```bash
NODE_ENV=production npm run build
NODE_ENV=production npm start      # web on port 3000
NODE_ENV=production npm run worker
```

In production the session cookie is marked Secure, so serve the app over **HTTPS** (see the nginx example below). Over plain `http://` on another machine, sign-in will not work.

### systemd services

`/etc/systemd/system/vshield-web.service`:

```ini
[Unit]
Description=StoreIQ Simple Virtual Shield web
After=network.target postgresql.service

[Service]
User=vshield
WorkingDirectory=/opt/vshield
EnvironmentFile=/opt/vshield/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -p 3000
Restart=always

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/vshield-worker.service`: same, with `Description=... worker` and
`ExecStart=/usr/bin/node node_modules/tsx/dist/cli.mjs src/worker/index.ts`.

The worker stops gracefully on SIGTERM. Use the path from `which node` if Node is installed with nvm.

```bash
sudo useradd --system --home /opt/vshield vshield
sudo chown -R vshield: /opt/vshield
sudo systemctl daemon-reload
sudo systemctl enable --now vshield-web vshield-worker
journalctl -u vshield-worker -f     # JSON logs
```

Keep owner credentials (`MIGRATION_DATABASE_URL`) out of the service environment; they are only needed when running migrations.

### nginx reverse proxy with HTTPS

```nginx
server {
  listen 443 ssl;
  server_name svs.example.com;
  ssl_certificate     /etc/letsencrypt/live/svs.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/svs.example.com/privkey.pem;
  client_max_body_size 200m;          # match MAX_UPLOAD_BYTES
  proxy_request_buffering off;        # stream large uploads
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 300s;
  }
}
```

Get a certificate with `sudo apt-get install -y certbot python3-certbot-nginx && sudo certbot --nginx`.

## 6. Verify

```bash
curl -s http://localhost:3000/api/ready
# {"status":"ready","checks":{"database":"ok","storage":"ok","worker":"ok"},...}
```

## 7. Run the tests on Linux

```bash
npm test                                         # starts its own temporary PostgreSQL; run as a non-root user
npx playwright install --with-deps chromium      # once (installs browser + system libraries)
npm run build && npm run test:e2e
```

## Alternative: Docker Compose

```bash
sudo apt-get install -y docker.io docker-compose-v2
export POSTGRES_OWNER_PASSWORD=... APP_DB_PASSWORD=...
docker compose up --build
docker compose run --rm web npm run tenant:create -- --name "Acme" --slug acme --email admin@acme.example
```

These Docker files have not been run yet; check them in a staging environment first.
