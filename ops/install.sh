#!/usr/bin/env bash
# =============================================
# Web2App Studio - ALL-IN-ONE INSTALLER (v2.0)
# =============================================
# Install SEMUA dependencies di VPS Ubuntu dalam 1 command.
#
# Tested on: Ubuntu 22.04 LTS, 24.04 LTS
# Usage:    sudo bash install.sh
#
# Paket yang diinstall:
#   - Node.js 20 LTS + npm
#   - Redis 7 (Bull Queue + session store)
#   - Nginx 1.24 (reverse proxy + SSL termination)
#   - PM2 (process manager + auto-restart)
#   - OpenJDK 17 (untuk Android build + general purpose)
#   - Android SDK 34 (build APK)
#   - Certbot (Let's Encrypt SSL gratis)
#   - UFW firewall
#   - fail2ban (anti brute-force SSH)
#   - htop, jq, net-tools (debugging)
#
# Setelah selesai, tinggal:
#   1. Upload project code
#   2. Setup .env
#   3. Setup domain Rumahweb (DNS A record → IP VPS)
#   4. Run deploy script (SSL Let's Encrypt diurus otomatis certbot)
# =============================================

set -euo pipefail

# ----- Colors untuk output -----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; }
step() { echo -e "\n${PURPLE}==>${NC} ${BLUE}$1${NC}"; }

# ----- Validasi root -----
if [ "$EUID" -ne 0 ]; then
  err "Script ini harus dijalankan sebagai root: sudo bash install.sh"
  exit 1
fi

# ----- Konfigurasi -----
APP_DIR="/var/www/web2app-studio"
APP_USER="webapp"
NODE_MAJOR=20
REDIS_VERSION="7"
NGINX_VERSION="1.24"
DOMAIN="${DOMAIN:-web2appstudio.my.id}"
EMAIL="${EMAIL:-admin@web2appstudio.my.id}"

echo "============================================"
echo -e "  ${PURPLE}Web2App Studio${NC} - VPS Installer v2.0"
echo -e "  Domain: ${GREEN}${DOMAIN}${NC}"
echo -e "  Email:  ${GREEN}${EMAIL}${NC}"
echo "============================================"

# =============================================
# STEP 1: System Update + Essentials
# =============================================
step "Step 1/10: System update & essential packages"

# Update package list + upgrade OS
apt update -qq
apt upgrade -y -qq
apt autoremove -y -qq
apt clean

# Essential packages
apt install -y -qq \
  curl \
  wget \
  git \
  ufw \
  fail2ban \
  software-properties-common \
  apt-transport-https \
  ca-certificates \
  gnupg \
  lsb-release \
  build-essential \
  htop \
  jq \
  net-tools \
  unzip \
  zip \
  cron \
  logrotate

log "System updated, $(dpkg --list | wc -l) packages total"

# =============================================
# STEP 2: Firewall (UFW) + fail2ban
# =============================================
step "Step 2/10: Setup firewall (UFW) + fail2ban"

# UFW
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP (certbot challenge + redirect to HTTPS)'
ufw allow 443/tcp comment 'HTTPS (Let’s Encrypt)'
# 8000-9000 gak dibuka — semua via Nginx
ufw --force enable

# fail2ban (anti SSH brute-force)
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
port    = ssh
filter  = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime  = 24h
EOF

systemctl enable fail2ban >/dev/null
systemctl restart fail2ban

log "UFW: SSH (22), HTTP (80), HTTPS (443) only"
log "fail2ban: SSH brute-force protection aktif"

# =============================================
# STEP 3: Timezone + System Limits
# =============================================
step "Step 3/10: Timezone + system limits"

# Timezone (default: Jakarta, sesuaikan via env TZ)
timedatectl set-timezone "${TZ:-Asia/Jakarta}"

# Increase file descriptor limit (untuk high-concurrency)
cat >> /etc/security/limits.conf <<'EOF'
* soft nofile 65535
* hard nofile 65535
* soft nproc 65535
* hard nproc 65535
EOF

# Sysctl tuning untuk web server
cat > /etc/sysctl.d/99-web2app.conf <<'EOF'
# Network
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15

# Memory
vm.swappiness = 10
vm.dirty_ratio = 60
vm.dirty_background_ratio = 2
EOF

sysctl -p /etc/sysctl.d/99-web2app.conf

log "Timezone: $(timedatectl | grep 'Time zone')"
log "File descriptors: 65535"

# =============================================
# STEP 4: Buat user non-root
# =============================================
step "Step 4/10: Buat user '$APP_USER' non-root"

if ! id "$APP_USER" &>/dev/null; then
  adduser --disabled-password --gecos "" "$APP_USER"
  echo "$APP_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/"$APP_USER"
  chmod 440 /etc/sudoers.d/"$APP_USER"
  log "User '$APP_USER' dibuat"
else
  log "User '$APP_USER' sudah ada"
fi

# =============================================
# STEP 5: Node.js 20 LTS + npm
# =============================================
step "Step 5/10: Install Node.js ${NODE_MAJOR} LTS"

if ! command -v node &>/dev/null; then
  # Tambah NodeSource repo
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt install -y -qq nodejs
fi

# Verify
NODE_VER=$(node --version)
NPM_VER=$(npm --version)
log "Node.js $NODE_VER | npm $NPM_VER"

# npm config: lebih strict
npm config set fund false
npm config set audit-level moderate
npm config set update-notifier false

# =============================================
# STEP 6: Redis 7 (Bull Queue + session store)
# =============================================
step "Step 6/10: Install Redis ${REDIS_VERSION}"

if ! command -v redis-server &>/dev/null; then
  apt install -y -qq redis-server
fi

# Production config
cat > /etc/redis/redis.conf <<'EOF'
# Network
bind 127.0.0.1 ::1
port 6379
protected-mode yes
tcp-backlog 511
timeout 300
tcp-keepalive 60

# General
daemonize yes
supervised systemd
loglevel notice
logfile /var/log/redis/redis-server.log
databases 16

# Snapshotting
save 900 1
save 300 10
save 60 10000
stop-writes-on-bgsave-error yes
rdbcompression yes
rdbchecksum yes
dbfilename dump.rdb
dir /var/lib/redis

# Memory
maxmemory 256mb
maxmemory-policy allkeys-lru

# Append only file
appendonly yes
appendfilename "appendonly.aof"
appendfsync everysec
no-appendfsync-on-rewrite no
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
EOF

systemctl enable redis-server >/dev/null 2>&1
systemctl restart redis-server

# Test
sleep 1
if redis-cli ping 2>/dev/null | grep -q PONG; then
  log "Redis aktif (PONG), maxmemory 256mb"
else
  err "Redis tidak merespon"
  exit 1
fi

# =============================================
# STEP 7: PM2 (Process Manager)
# =============================================
step "Step 7/10: Install PM2"

if ! command -v pm2 &>/dev/null; then
  npm install -g pm2 --silent
fi

# Auto-start saat boot
env PATH=$PATH:/usr/bin pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

# Setup logrotate untuk PM2
pm2 install pm2-logrotate >/dev/null 2>&1 || true
pm2 set pm2-logrotate:max_size 50M >/dev/null 2>&1 || true
pm2 set pm2-logrotate:retain 14 >/dev/null 2>&1 || true
pm2 set pm2-logrotate:compress true >/dev/null 2>&1 || true

log "PM2 $(pm2 --version) + pm2-logrotate terinstall"

# =============================================
# STEP 8: OpenJDK 17 + Android SDK
# =============================================
step "Step 8/10: Install OpenJDK 17 + Android SDK 34"

# Java 17
if ! command -v java &>/dev/null; then
  apt install -y -qq openjdk-17-jdk-headless
fi

JAVA_VER=$(java -version 2>&1 | head -1 | awk -F'"' '{print $2}')
log "OpenJDK ${JAVA_VER}"

# Android SDK
ANDROID_SDK_ROOT="/opt/android-sdk"
if [ ! -d "$ANDROID_SDK_ROOT/cmdline-tools/latest" ]; then
  mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools"
  cd "$ANDROID_SDK_ROOT/cmdline-tools"

  echo "  Downloading Android Command-line Tools..."
  wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O cmdline-tools.zip
  unzip -q cmdline-tools.zip
  rm cmdline-tools.zip
  mv cmdline-tools latest
  cd /
fi

# Environment vars
cat > /etc/profile.d/android.sh <<EOF
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export ANDROID_SDK_ROOT=$ANDROID_SDK_ROOT
export ANDROID_HOME=$ANDROID_SDK_ROOT
export PATH=\$PATH:\$JAVA_HOME/bin:\$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:\$ANDROID_SDK_ROOT/platform-tools:\$ANDROID_SDK_ROOT/build-tools/34.0.0
EOF

chmod +x /etc/profile.d/android.sh
source /etc/profile.d/android.sh

# Install SDK components
if [ ! -d "$ANDROID_SDK_ROOT/platforms/android-34" ]; then
  echo "  Installing SDK packages (5-10 menit)..."
  yes | sdkmanager --licenses >/dev/null 2>&1
  sdkmanager --install \
    "platform-tools" \
    "platforms;android-34" \
    "build-tools;34.0.0" \
    "extras;android;m2repository" \
    "extras;google;m2repository" 2>&1 | tail -3
fi

chmod -R 755 "$ANDROID_SDK_ROOT"

log "Android SDK di $ANDROID_SDK_ROOT"
log "Build tools 34.0.0 + platforms android-34"

# =============================================
# STEP 9: Nginx + SSL preparation
# =============================================
step "Step 9/10: Install Nginx + persiapan SSL"

if ! command -v nginx &>/dev/null; then
  apt install -y -qq nginx
fi

# Hapus default site
rm -f /etc/nginx/sites-enabled/default

# Certbot (Let's Encrypt) — SSL gratis auto-renew
if ! command -v certbot &>/dev/null; then
  apt install -y -qq certbot python3-certbot-nginx
fi

# Directory untuk cert Let's Encrypt (auto-managed by certbot)
mkdir -p /var/www/certbot
chown -R root:root /var/www/certbot

# Test nginx config
nginx -t 2>&1 | head -3

systemctl enable nginx >/dev/null
systemctl restart nginx

NGINX_VER=$(nginx -v 2>&1 | awk -F'/' '{print $2}')
log "Nginx $NGINX_VER + certbot Let's Encrypt ready"

# =============================================
# STEP 10: Setup project directory
# =============================================
step "Step 10/10: Setup project directory & environment"

mkdir -p "$APP_DIR"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# Storage directory untuk APK builds
mkdir -p "$APP_DIR/api/storage/builds"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR/api/storage"

# PM2 logs
mkdir -p /var/log/pm2
chown -R "$APP_USER":"$APP_USER" /var/log/pm2

# Backup directory
mkdir -p /var/backups/web2app-studio
chown -R "$APP_USER":"$APP_USER" /var/backups/web2app-studio

log "Project directory: $APP_DIR"
log "User:               $APP_USER"
log "Storage:            $APP_DIR/api/storage/builds"
log "PM2 logs:           /var/log/pm2"
log "Backups:            /var/backups/web2app-studio"

# =============================================
# SUMMARY
# =============================================
step "✅ INSTALASI SELESAI!"

cat <<EOF

${GREEN}📦 Yang sudah terinstall:${NC}
   • Node.js     $(node --version)
   • npm         $(npm --version)
   • Redis       7.x (maxmemory 256mb, appendonly)
   • PM2         $(pm2 --version) + pm2-logrotate
   • OpenJDK     $JAVA_VER
   • Android SDK 34 (build-tools 34.0.0)
   • Nginx       $NGINX_VER + certbot Let's Encrypt
   • Certbot     $(certbot --version 2>&1 | awk '{print $2}')
   • OpenSSL     $(openssl version | awk '{print $2}')
   • UFW         SSH/HTTP/HTTPS only
   • fail2ban    SSH brute-force protection

${GREEN}📁 Penting:${NC}
   • Project:     $APP_DIR
   • User:        $APP_USER
   • Domain:      $DOMAIN
   • Email:       $EMAIL (untuk notifikasi certbot renew)
   • SSL cert:    /etc/letsencrypt/live/${DOMAIN}/ (auto-managed certbot)

${YELLOW}🔜 LANGKAH SELANJUTNYA:${NC}
   1. Upload project ke $APP_DIR
      ${BLUE}cd /var/www && sudo git clone <your-repo-url> web2app-studio${NC}
      # atau upload via SCP/SFTP

   2. Setup environment
      ${BLUE}cd $APP_DIR/api
      sudo cp .env.example .env
      sudo chmod 600 .env
      sudo nano .env${NC}
      # Wajib diisi: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET,
      #              PAKASIR_API_KEY, PAKASIR_WEBHOOK_SECRET, COOKIE_SECRET, CRON_SECRET

   3. Pointing domain Rumahweb → VPS
      • Login https://my.rumahweb.com → Domain → Manage DNS
      • Tambah 2 A record:
        - Type: A | Name: @   | Value: IP_VPS_KAMU | TTL: 300
        - Type: A | Name: www | Value: IP_VPS_KAMU | TTL: 300
      • Tunggu propagasi DNS 5-30 menit
      • SSL Let's Encrypt diurus otomatis oleh certbot di langkah deploy

   4. Install Node dependencies
      ${BLUE}cd $APP_DIR
      sudo -u $APP_USER npm ci --omit=dev${NC}

   5. Setup Nginx site
      ${BLUE}sudo cp $APP_DIR/ops/nginx/web2appstudio.my.id.conf /etc/nginx/sites-enabled/
      sudo nginx -t && sudo systemctl reload nginx${NC}

   6. Start app dengan PM2
      ${BLUE}cd $APP_DIR
      sudo -u $APP_USER pm2 start ops/pm2/ecosystem.config.cjs
      sudo -u $APP_USER pm2 save${NC}

   7. Setup cron jobs (PENTING — 4 endpoint)
      ${BLUE}sudo -u $APP_USER crontab -e${NC}
      # Crontab lengkap ada di bagian "Setup Cron Jobs" di panduan_vps.md

   8. Verifikasi
      ${BLUE}curl -I https://${DOMAIN}
      curl https://${DOMAIN}/api/health${NC}

${PURPLE}📖 Panduan lengkap:${NC}      cat $APP_DIR/ops/panduan_vps.md
${PURPLE}💰 Alur Pakasir vs Saldo:${NC} cat $APP_DIR/ops/panduan_pakasir_saldo.md
${PURPLE}🆘 Troubleshooting:${NC}      tail -f /var/log/pm2/*.log

EOF

log "Selamat! VPS siap untuk deploy Web2App Studio 🎉"
