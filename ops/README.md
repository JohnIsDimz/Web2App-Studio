# ops/ — Production Operations

Folder ini berisi semua file untuk **deploy & maintain** Web2App Studio di VPS.

## 📂 Isi

| File | Fungsi |
|------|--------|
| **`install.sh`** | ⭐ **Master installer** — Install semua dependencies (Node, Redis, PM2, JDK, Android SDK, Nginx) dalam 1 command |
| **`panduan_vps.md`** | ⭐ **Mulai dari sini** — Panduan deploy step-by-step Bahasa Indonesia |
| `panduan_supabase.md` | Setup database Supabase (overview, OAuth, project setup) |
| `panduan_supabase_sql.md` | Setup database Supabase (5 file SQL, step-by-step) |
| `panduan_pakasir_saldo.md` | Setup akun Pakasir + alur saldo internal |
| `panduan_upload.md` | Upload project ke VPS via Git/SFTP/manual |
| `scripts/deploy.sh` | Deploy aplikasi + start PM2 + setup Nginx + certbot Let's Encrypt |
| `scripts/99-verify-all.sh` | Health check setelah deploy |
| `nginx/web2appstudio.my.id.conf` | Konfigurasi Nginx reverse proxy |
| `pm2/ecosystem.config.cjs` | Konfigurasi PM2 process manager |

## 🚀 Quick Deploy (3 Langkah)

```bash
# 1. SSH ke VPS & install dependencies (~20 menit)
ssh root@YOUR_VPS_IP
cd /var/www/web2app-studio/ops
sudo bash install.sh

# 2. Pointing domain Rumahweb ke VPS (DNS A record)
# Login panel Rumahweb → Domain → Manage DNS → tambah A record:
#   Type: A, Name: @, Value: IP_VPS_KAMU, TTL: 300
#   Type: A, Name: www, Value: IP_VPS_KAMU, TTL: 300
# Tunggu propagasi 5-30 menit. SSL Let's Encrypt diurus otomatis certbot di langkah deploy.

# 3. Configure & deploy (~3 menit)
cd /var/www/web2app-studio/api
sudo cp .env.example .env
sudo nano .env     # isi Supabase + Pakasir + COOKIE_SECRET + CRON_SECRET
cd /var/www/web2app-studio
sudo bash ops/scripts/deploy.sh
```

**Total: ~30-35 menit**

Detail lengkap: **`panduan_vps.md`**
