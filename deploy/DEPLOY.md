# Deployment Guide — travel.henzi.org

This document covers the full transition from local dev to production on your VPS.
Run every step in order the first time. Future deploys skip to **§5 — Updating the App**.

---

## Prerequisites

- VPS with Nginx installed and running
- Docker + Docker Compose installed on the VPS
- `certbot` installed (`apt install certbot python3-certbot-nginx`)
- DNS: `travel A → YOUR_VPS_IP` already propagated
- Local machine has SSH access to the VPS

---

## §1 — VPS: Prepare Directories

```bash
# Web root for static landing page (and future static tools)
sudo mkdir -p /usr/local/www/travel.henzi.org

# App directory — where the repo lives on the server
sudo mkdir -p /srv/travel
sudo chown $USER:$USER /srv/travel
```

---

## §2 — Local: Push the Repo to the VPS

From your local machine inside the `traveler/` directory:

```bash
# One-time: copy the whole repo to the VPS
rsync -avz --exclude '.git' --exclude '__pycache__' \
  /Users/joe/Local\ Development/traveler/ \
  user@YOUR_VPS_IP:/srv/travel/
```

Or if you push to Git first (recommended for ongoing deploys):

```bash
# On the VPS
cd /srv/travel
git clone https://github.com/YOU/traveler.git .
```

---

## §3 — VPS: Start the Flask App (Docker)

```bash
cd /srv/travel

# Build and start in the background
docker compose up -d --build

# Verify it's running and healthy
docker compose ps
docker compose logs -f   # Ctrl+C to exit

# Confirm Flask is answering on host port 5847
curl -s http://127.0.0.1:5847/ | head -5
```

The container maps **host port 5847 → container port 5000**.
Nginx will proxy to `127.0.0.1:5847`.

---

## §4 — VPS: Deploy Nginx Config + SSL

### 4a — Install the Nginx config

```bash
sudo cp /srv/travel/deploy/travel.henzi.org.conf \
        /etc/nginx/sites-available/travel.henzi.org

sudo ln -s /etc/nginx/sites-available/travel.henzi.org \
           /etc/nginx/sites-enabled/travel.henzi.org

# Test config before reloading
sudo nginx -t
sudo systemctl reload nginx
```

### 4b — Deploy the landing page

```bash
sudo cp /srv/travel/landing/index.html \
        /usr/local/www/travel.henzi.org/index.html

# Any landing page assets (images, landing CSS) go here too:
# sudo cp /srv/travel/landing/assets/* /usr/local/www/travel.henzi.org/
```

### 4c — SSL via Certbot

```bash
sudo certbot --nginx -d travel.henzi.org
```

Certbot will:
1. Verify domain ownership via HTTP challenge
2. Obtain a Let's Encrypt certificate
3. Append a `:443` server block and HTTP→HTTPS redirect to the nginx config
4. Schedule auto-renewal (verify with `systemctl status certbot.timer`)

### 4d — Smoke test

```bash
# Landing page (static, nginx direct)
curl -I https://travel.henzi.org/

# Planner app (proxied to Flask)
curl -I https://travel.henzi.org/plan

# API
curl -s -X POST https://travel.henzi.org/api/forecast \
  -H 'Content-Type: application/json' \
  -d '{"threshold":30,"horizon":7,"departure_day":2,"temp_threshold":82}' \
  | python3 -m json.tool | head -20
```

---

## §5 — Updating the App (Future Deploys)

```bash
# 1. On local: push changes to Git (or rsync again)
rsync -avz --exclude '.git' --exclude '__pycache__' \
  /Users/joe/Local\ Development/traveler/ \
  user@YOUR_VPS_IP:/srv/travel/

# 2. On VPS: rebuild and restart (zero-downtime: compose pulls new image,
#    starts new container, stops old one)
cd /srv/travel
docker compose up -d --build

# 3. Verify
docker compose ps
curl -s http://127.0.0.1:5847/api/forecast \
  -X POST -H 'Content-Type: application/json' \
  -d '{"threshold":30}' | python3 -m json.tool | head -5
```

Nginx config and landing page only need updating when they change:

```bash
# Reload nginx after config changes
sudo nginx -t && sudo systemctl reload nginx

# Update landing page
sudo cp /srv/travel/landing/index.html /usr/local/www/travel.henzi.org/
```

---

## §6 — Adding a New Tool to the Suite

When a second tool ships under `travel.henzi.org` (e.g. `/journal`):

1. Add a new Docker service to `/srv/travel/docker-compose.yml` on a new host port (e.g. `5848:5000`)
2. Add a `location /journal { proxy_pass http://127.0.0.1:5848; ... }` block to `travel.henzi.org.conf`
3. `sudo nginx -t && sudo systemctl reload nginx`
4. Add a card/link for the new tool on the landing page

No SSL or DNS changes needed — certbot already covers the domain.

---

## File Map

```
/srv/travel/                        ← app repo on VPS
  docker-compose.yml                ← runs Flask on host :5847
  deploy/
    travel.henzi.org.conf           ← nginx config (source of truth)
    DEPLOY.md                       ← this file
  landing/
    index.html                      ← static landing page source

/etc/nginx/sites-available/travel.henzi.org   ← nginx config (deployed copy)
/etc/nginx/sites-enabled/travel.henzi.org     ← symlink to above
/usr/local/www/travel.henzi.org/index.html    ← deployed landing page
/var/log/nginx/travel.henzi.org.access.log    ← combined access log
/var/log/nginx/travel.henzi.org.error.log     ← error log
```

---

## Ports in Use

| Host Port | Service | Notes |
|-----------|---------|-------|
| 5847 | Weather Horizon (Flask) | Proxied from `/plan` and `/api/` |
| 5848 | *(reserved — next tool)* | |

---

## Rollback

```bash
cd /srv/travel

# Stop current containers
docker compose down

# Restore previous code (if using Git)
git checkout HEAD~1

# Restart
docker compose up -d --build
```
