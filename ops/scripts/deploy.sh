#!/usr/bin/env bash
# =============================================
# Web2App Studio - DEPLOY SCRIPT
# =============================================
# Deploy aplikasi ke VPS + start dengan PM2.
# Dijalankan SETELAH install.sh selesai.
# Usage:   sudo bash deploy.sh
# =============================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ----- Config -----
APP_DIR="/var/www/web2app-studio"
APP_USER="webapp"
DOMAIN="${DOMAIN:-web2appstudio.my.id}"
NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}.conf"
SSL_DIR="/etc/letsencrypt/live"

# Validasi
[ "$EUID" -eq 0 ] || err "Harus sebagai root: sudo bash deploy.sh"
[ -d "$APP_DIR" ] || err "Folder $APP_DIR tidak ada. Jalankan install.sh dulu."

echo "============================================"
echo "  Web2App Studio - Deploy"
echo "============================================"

# =============================================
# 1. Install dependencies
# =============================================
echo ""
echo "→ [1/5] Install npm dependencies"
cd $APP_DIR/api
if [ ! -d "node_modules" ]; then
  sudo -u $APP_USER npm ci --only=production --silent
  log "Backend dependencies installed"
else
  log "node_modules sudah ada, skip"
fi

# =============================================
# 2. Validasi .env
# =============================================
echo ""
echo "→ [2/5] Validasi .env"

if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    chown $APP_USER:$APP_USER .env
    chmod 600 .env
    err "File .env baru saja dibuat dari template. Edit dulu: nano $APP_DIR/api/.env"
  else
    err "File .env.example tidak ditemukan"
  fi
fi

# Check critical vars
REQUIRED_VARS=("SUPABASE_URL" "SUPABASE_SERVICE_ROLE_KEY" "PAKASIR_API_KEY" "PAKASIR_WEBHOOK_SECRET" "COOKIE_SECRET" "CRON_SECRET")
MISSING=()
for var in "${REQUIRED_VARS[@]}"; do
  if ! grep -q "^${var}=.\\+" .env 2>/dev/null || grep -q "^${var}=your_" .env 2>/dev/null; then
    MISSING+=("$var")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  err "Variabel .env belum diisi: ${MISSING[*]}\n   Edit: nano $APP_DIR/api/.env"
fi

log ".env OK"

# =============================================
# 3. Setup SSL via certbot (Let's Encrypt)
# =============================================
echo ""
echo "→ [3/5] Setup SSL via certbot (Let's Encrypt)"

if [ ! -d "$SSL_DIR/${DOMAIN}" ]; then
  warn "SSL cert belum ada untuk ${DOMAIN}"
  warn ""
  warn "Pastikan:"
  warn "  1. DNS A record @ dan www sudah pointing ke IP VPS ini"
  warn "  2. Tunggu propagasi DNS 5-30 menit"
  warn "  3. Port 80 dan 443 terbuka di firewall"
  warn ""
  warn "Sekarang certbot akan request cert. Kalau gagal (DNS belum propagasi),"
  warn "    run manual nanti: sudo certbot --nginx -d ${DOMAIN} -d www.${DOMAIN}"
  echo ""

  # Pre-flight: pastikan nginx bisa start (certbot butuh nginx running buat challenge)
  if ! nginx -t 2>/dev/null; then
    err "Nginx config invalid. Run 'nginx -t' dulu."
  fi

  # Request cert dengan webroot method (gak butuh nginx downtime)
  certbot certonly --webroot -w /var/www/certbot \
    -d ${DOMAIN} -d www.${DOMAIN} \
    --non-interactive --agree-tos -m ${EMAIL:-admin@${DOMAIN}} \
    --cert-name ${DOMAIN} || err "Certbot gagal. Cek log: tail -50 /var/log/letsencrypt/letsencrypt.log"

  log "SSL cert Let's Encrypt dibuat di $SSL_DIR/${DOMAIN}/"
else
  log "SSL cert Let's Encrypt sudah ada di $SSL_DIR/${DOMAIN}/"
fi

# =============================================
# 4. Copy Nginx config
# =============================================
echo ""
echo "→ [4/5] Setup Nginx"

if [ -f "$APP_DIR/ops/nginx/${DOMAIN}.conf" ]; then
  cp $APP_DIR/ops/nginx/${DOMAIN}.conf $NGINX_CONF
  ln -sf $NGINX_CONF /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default

  if nginx -t 2>/dev/null; then
    systemctl restart nginx
    log "Nginx configured & running"
  else
    err "Nginx config invalid. Cek: nginx -t"
  fi
else
  err "Nginx config tidak ada: $APP_DIR/ops/nginx/${DOMAIN}.conf"
fi

# =============================================
# 5. Start dengan PM2
# =============================================
echo ""
echo "→ [5/5] Start dengan PM2"

cd $APP_DIR/ops/pm2
pm2 delete all 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save --force

sleep 2

# Verify
if pm2 ls | grep -q "online"; then
  log "PM2 processes running"
else
  warn "PM2 tidak detect online processes. Cek: pm2 ls"
fi

# =============================================
# FINAL: Verifikasi
# =============================================
echo ""
echo "============================================"
echo "  ✅ DEPLOY SELESAI!"
echo "============================================"
echo ""
echo "🔍 Verifikasi:"
echo ""
echo "  • PM2 status:"
pm2 ls | head -10
echo ""
echo "  • Test API lokal:"
echo "    curl http://localhost:3000/api/health"
curl -s http://localhost:3000/api/health 2>/dev/null || warn "API belum respond, tunggu 5 detik lalu cek log"
echo ""
echo "  • Test HTTPS:"
echo "    curl -I https://${DOMAIN}"
echo ""
echo "📋 Commands berguna:"
echo "  pm2 logs web2app-api    # tail log API"
echo "  pm2 logs web2app-worker # tail log worker"
echo "  pm2 monit               # real-time monitor"
echo "  pm2 restart all         # restart semua"
echo ""
echo "🔄 Update app (zero-downtime):"
echo "  cd $APP_DIR"
echo "  sudo -u $APP_USER git pull"
echo "  cd api && sudo -u $APP_USER npm ci --only=production"
echo "  pm2 reload ecosystem.config.cjs"
echo ""
echo "📖 Panduan lengkap: cat $APP_DIR/ops/panduan_vps.md"
echo ""
