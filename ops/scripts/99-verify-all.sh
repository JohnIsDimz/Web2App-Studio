#!/usr/bin/env bash
# =============================================
# Web2App Studio - Final Verification Script
# =============================================
# Jalankan SETELAH semua step di atas selesai,
# untuk memastikan semua service berjalan.
# =============================================

set -euo pipefail

DOMAIN="web2appstudio.my.id"
PORT_API=3000

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass() { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }

echo "============================================"
echo "  Web2App Studio - Health Check"
echo "============================================"
echo ""

# [1] System checks
echo "─── SYSTEM ───"

if command -v node &>/dev/null; then
  pass "Node.js: $(node --version)"
else
  fail "Node.js tidak ditemukan"
fi

if command -v npm &>/dev/null; then
  pass "npm: $(npm --version)"
else
  fail "npm tidak ditemukan"
fi

if command -v java &>/dev/null; then
  pass "Java: $(java -version 2>&1 | head -1)"
else
  fail "Java tidak ditemukan"
fi

if [ -d "/opt/android-sdk" ]; then
  pass "Android SDK: /opt/android-sdk"
else
  warn "Android SDK belum terinstall di /opt/android-sdk"
fi

echo ""

# [2] Service checks
echo "─── SERVICES ───"

if systemctl is-active --quiet redis-server; then
  pass "Redis: running"
  if redis-cli ping 2>/dev/null | grep -q PONG; then
    pass "Redis: responding PONG"
  fi
else
  fail "Redis: not running"
fi

if systemctl is-active --quiet nginx; then
  pass "Nginx: running"
else
  fail "Nginx: not running"
fi

if command -v pm2 &>/dev/null; then
  pass "PM2: $(pm2 --version)"
  echo ""
  echo "PM2 Processes:"
  pm2 ls
  echo ""
else
  fail "PM2 tidak ditemukan"
fi

echo ""

# [3] Port & Firewall
echo "─── NETWORK ───"

if ss -tlnp 2>/dev/null | grep -q ":${PORT_API}"; then
  pass "Port ${PORT_API}: listening"
else
  fail "Port ${PORT_API}: not listening"
fi

if ss -tlnp 2>/dev/null | grep -q ":80"; then
  pass "Port 80: listening"
fi

if ss -tlnp 2>/dev/null | grep -q ":443"; then
  pass "Port 443: listening"
fi

echo ""

# [4] Endpoint tests
echo "─── ENDPOINTS ───"

if curl -sf -o /dev/null -w "%{http_code}" "http://localhost:${PORT_API}/api/health" 2>/dev/null | grep -q 200; then
  pass "API health: OK"
else
  fail "API health: not responding"
fi

# HTTPS test (skip jika domain belum point ke VPS)
if curl -sf -o /dev/null -w "%{http_code}" "https://${DOMAIN}/api/health" 2>/dev/null | grep -q 200; then
  pass "HTTPS ${DOMAIN}: reachable"
else
  warn "HTTPS ${DOMAIN}: tidak bisa dijangkau. Pastikan:"
  echo "      1. DNS A record @ dan www sudah pointing ke IP VPS ini"
  echo "      2. Tunggu propagasi DNS 5-30 menit"
  echo "      3. Certbot sudah generate SSL: sudo certbot --nginx -d ${DOMAIN} -d www.${DOMAIN}"
  echo "      4. Cek cert: sudo certbot certificates"
fi

# Frontend
if curl -sf -o /dev/null -w "%{http_code}" "https://${DOMAIN}/" 2>/dev/null | grep -q 200; then
  pass "Frontend: serving"
else
  warn "Frontend: belum bisa diakses via HTTPS"
fi

echo ""
echo "============================================"
echo "  Health check selesai!"
echo "============================================"
