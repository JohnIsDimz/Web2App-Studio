# 📤 Panduan Upload Project ke VPS (Tanpa GitHub)

> 4 metode upload project Web2App Studio ke VPS Ubuntu, **TANPA GitHub**.

| Metode | Speed | Keamanan | Kompleksitas | Recommended |
|--------|-------|----------|--------------|-------------|
| **A. SCP** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Easy | ✅ **Untuk pertama kali** |
| **B. Rsync** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Medium | ✅ **Untuk update rutin** |
| **C. SFTP** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Easy | Untuk yang suka GUI |
| **D. Tar + Curl** | ⭐⭐ | ⭐⭐ | Easy | Kalau SCP/RSYNC gak tersedia |

---

## 🛠️ Prasyarat

```bash
# Di komputer LOKAL (bukan VPS)
# Pastikan Anda punya akses SSH ke VPS:
ssh root@VPS_IP
```

---

## 📋 Persiapan: Archive Project di Lokal

Sebelum upload, **pack project jadi 1 file** agar transfer lebih cepat & atomic:

```bash
# Di komputer lokal
cd /path/to/web2app-studio-parent

# Bikin archive (exclude node_modules, .env, storage)
tar czf web2app-studio.tar.gz \
  --exclude='web2app-studio/node_modules' \
  --exclude='web2app-studio/.git' \
  --exclude='web2app-studio/api/.env' \
  --exclude='web2app-studio/api/storage' \
  web2app-studio/

ls -lh web2app-studio.tar.gz
# Expected: ~200-400 KB
```

**Verifikasi isi archive:**
```bash
tar tzf web2app-studio.tar.gz | head -20
# Harus ada: index.html, api/, assets/, ops/
# TIDAK ada: node_modules, .git, .env
```

---

## 🅰️ Metode A: SCP (PALING SIMPEL) ⭐

### Upload Pertama Kali

**Dari komputer LOKAL:**

```bash
# 1. Upload archive
scp web2app-studio.tar.gz root@VPS_IP:/tmp/

# 2. SSH ke VPS
ssh root@VPS_IP

# 3. Extract di VPS
mkdir -p /var/www
cd /var/www
tar xzf /tmp/web2app-studio.tar.gz
chown -R webapp:webapp /var/www/web2app-studio
rm /tmp/web2app-studio.tar.gz
```

**Estimasi: 1-2 menit** untuk file ~300 KB.

### Update Rutin dengan SCP

```bash
# Di lokal: re-pack project
cd /path/to/web2app-studio-parent
tar czf web2app-studio.tar.gz \
  --exclude='web2app-studio/node_modules' \
  --exclude='web2app-studio/.git' \
  --exclude='web2app-studio/api/.env' \
  --exclude='web2app-studio/api/storage' \
  web2app-studio/

# Upload
scp web2app-studio.tar.gz root@VPS_IP:/tmp/

# SSH & deploy
ssh root@VPS_IP "cd /var/www && \
  rm -rf web2app-studio.bak && \
  mv web2app-studio web2app-studio.bak && \
  mkdir web2app-studio && \
  tar xzf /tmp/web2app-studio.tar.gz -C web2app-studio --strip-components=1 && \
  chown -R webapp:webapp web2app-studio && \
  cd web2app-studio/api && \
  sudo -u webapp npm ci --only=production && \
  cd /var/www/web2app-studio/ops/pm2 && \
  pm2 reload ecosystem.config.cjs"
```

---

## 🅱️ Metode B: Rsync (PALING EFISIEN) ⭐⭐⭐⭐⭐

**Rsync hanya transfer file yang berubah**, jauh lebih cepat untuk update rutin.

### Install Rsync

**Di lokal (macOS/Linux):**
```bash
# Biasanya sudah terinstall
rsync --version
```

**Di Windows:**
```bash
# Install via WSL atau download dari https://rsync.samba.org/
```

### Setup SSH Key (Sekali Saja, Supaya Gak Ketik Password)

```bash
# Di komputer LOKAL
ssh-keygen -t ed25519 -C "laptop-anda"
# Output: /home/you/.ssh/id_ed25519.pub

# Copy public key ke VPS
ssh-copy-id root@VPS_IP

# Test (gak boleh prompt password)
ssh root@VPS_IP "echo 'Login tanpa password works!'"
```

### Upload Pertama Kali dengan Rsync

```bash
# Di lokal
rsync -avz --progress \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='api/.env' \
  --exclude='api/storage' \
  /path/to/web2app-studio/ \
  root@VPS_IP:/var/www/web2app-studio/
```

**Penjelasan flags:**
- `-a` = archive mode (preserve permissions, timestamps, dll)
- `-v` = verbose (lihat apa yang di-transfer)
- `-z` = compress during transfer
- `--progress` = lihat progress bar

### Update Rutin dengan Rsync (RECOMMENDED) 🌟

Buat script `deploy-to-vps.sh` di lokal:

```bash
#!/bin/bash
# =============================================
# Quick Deploy ke VPS
# =============================================
# Usage: ./deploy-to-vps.sh
# =============================================

set -e

VPS_USER="root"
VPS_HOST="YOUR_VPS_IP"  # Ganti dengan IP VPS Anda
APP_DIR="/var/www/web2app-studio"
LOCAL_DIR="/path/to/web2app-studio"  # Ganti dengan path lokal

echo "============================================"
echo "  Deploy Web2App Studio → ${VPS_HOST}"
echo "============================================"

# 1. Sync files
echo ""
echo "→ Syncing files..."
rsync -avz --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='api/.env' \
  --exclude='api/storage' \
  --exclude='api/storage/*' \
  ${LOCAL_DIR}/ ${VPS_USER}@${VPS_HOST}:${APP_DIR}/

# 2. Reload PM2 (zero-downtime)
echo ""
echo "→ Reloading PM2..."
ssh ${VPS_USER}@${VPS_HOST} "cd ${APP_DIR}/ops/pm2 && pm2 reload ecosystem.config.cjs"

# 3. Show status
echo ""
echo "→ PM2 Status:"
ssh ${VPS_USER}@${VPS_HOST} "pm2 ls"

echo ""
echo "✅ Deploy selesai!"
```

**Cara pakai:**
```bash
chmod +x deploy-to-vps.sh
./deploy-to-vps.sh
```

**Update yang berubah saja, super cepat!**

---

## 🅲 Metode C: SFTP (GUI, untuk yang Suka Klik-klik)

### macOS: Cyberduck
1. Download https://cyberduck.io (gratis)
2. **Open Connection** → pilih **SFTP**
3. Isi:
   - Server: `VPS_IP`
   - Username: `root`
   - Password: (atau SSH key)
4. Drag & drop folder `web2app-studio` ke `/var/www/`

### Windows: WinSCP
1. Download https://winscp.net (gratis)
2. New Site → File protocol: **SFTP**
3. Isi host, username, password
4. Login → drag & drop folder

### Universal: VS Code Extension
1. Install extension **"SFTP"** by liximomo
2. Buka folder `web2app-studio` di VS Code
3. `Ctrl+Shift+P` → "SFTP: Config"
4. Edit config:
   ```json
   {
     "host": "VPS_IP",
     "username": "root",
     "remotePath": "/var/www/web2app-studio",
     "uploadOnSave": true
   }
   ```
5. Klik kanan file → "SFTP: Upload" atau auto-upload on save

---

## 🅳 Metode D: Tar + Curl/Wget (Untuk VPS yang Strict)

Kalau SCP/RSYNC gak available (mis. VPS minimum), bisa base64 + curl:

```bash
# Di LOKAL: pack & base64
cd /path/to/web2app-studio-parent
tar czf - web2app-studio/ | base64 > web2app-studio.b64

# Cek ukuran
ls -lh web2app-studio.b64
# Biasanya ~400-500 KB dalam base64

# Copy isi file
cat web2app-studio.b64 | xclip -selection clipboard   # Linux
cat web2app-studio.b64 | pbcopy                         # macOS
```

**Di VPS:**
```bash
# Buat file, paste (Ctrl+V), save (Ctrl+D)
cat > /tmp/web2app-studio.b64 << 'EOF'
# (paste isi clipboard di sini, lalu tekan Ctrl+D)
EOF

# Decode & extract
base64 -d /tmp/web2app-studio.b64 | tar xz -C /var/www/
chown -R webapp:webapp /var/www/web2app-studio
rm /tmp/web2app-studio.b64
```

⚠️ **Metode ini tidak direkomendasikan** untuk file besar. Pakai SCP/Rsync saja.

---

## 🔄 Workflow Lengkap (Recommended)

### 1️⃣ Pertama Kali Setup

```bash
# Di LOKAL: pack project
cd /path/to/web2app-studio-parent
tar czf web2app-studio.tar.gz \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='api/.env' \
  --exclude='api/storage' \
  web2app-studio/

# Upload
scp web2app-studio.tar.gz root@VPS_IP:/tmp/

# Di VPS
ssh root@VPS_IP
cd /var/www
tar xzf /tmp/web2app-studio.tar.gz
chown -R webapp:webapp web2app-studio
rm /tmp/web2app-studio.tar.gz
```

### 2️⃣ Setup SSH Key (supaya gak ketik password)

```bash
# Di LOKAL
ssh-keygen -t ed25519
ssh-copy-id root@VPS_IP
```

### 3️⃣ Buat Script Deploy Lokal

Simpan sebagai `deploy.sh` di folder project lokal:

```bash
#!/bin/bash
VPS="root@VPS_IP"  # ← GANTI
APP_DIR="/var/www/web2app-studio"

# Sync files
rsync -avz --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='api/.env' \
  --exclude='api/storage' \
  --exclude='api/storage/*' \
  ./ ${VPS}:${APP_DIR}/

# Reload PM2
ssh ${VPS} "cd ${APP_DIR}/ops/pm2 && pm2 reload ecosystem.config.cjs"

echo "✅ Deployed!"
```

```bash
chmod +x deploy.sh
./deploy.sh
```

### 4️⃣ Update Rutin (Cepat & Mudah)

```bash
# Edit file di lokal → save
# Run script:
./deploy.sh

# Done! Cuma transfer file yang berubah.
```

---

## 🔒 Tips Keamanan

### ⚠️ JANGAN Upload File Sensitif
Pastikan `.env` TIDAK ikut ke-upload. Selalu exclude:
```bash
--exclude='api/.env'        # Production secrets
--exclude='api/storage'     # Build outputs (bisa di-rebuild)
--exclude='.git'            # Git history (besar)
--exclude='node_modules'    # Dependencies (di-install via npm)
```

### ✅ Setup SSH Key (Wajib)
Password auth di SSH kurang aman. Pakai key:
```bash
# Generate
ssh-keygen -t ed25519 -C "laptop-anda"

# Upload ke VPS
ssh-copy-id root@VPS_IP

# Test (gak boleh prompt password)
ssh root@VPS_IP "echo OK"
```

### 🔐 Disable Password Login di VPS (Setelah SSH Key Setup)
```bash
# Di VPS
sudo nano /etc/ssh/sshd_config
# Ubah: PasswordAuthentication yes → PasswordAuthentication no
sudo systemctl restart sshd
```

### 📦 Backup Sebelum Update
```bash
# Di VPS, sebelum update
ssh root@VPS_IP "cp -r /var/www/web2app-studio /var/www/web2app-studio.bak"
```

---

## 🆘 Troubleshooting

### ❌ "Permission denied (publickey)"

```bash
# Cek SSH key
ls -la ~/.ssh/

# Pastikan ada id_ed25519.pub
# Kalau belum ada, generate:
ssh-keygen -t ed25519

# Copy ke VPS
ssh-copy-id root@VPS_IP
```

### ❌ "Connection refused" / "Connection timed out"

```bash
# Cek VPS hidup
ping VPS_IP

# Cek SSH port (default 22)
nc -zv VPS_IP 22

# Cek firewall VPS
ssh root@VPS_IP "ufw status"
# Kalau SSH port ke-block, allow dulu:
ssh root@VPS_IP "ufw allow 22/tcp"
```

### ❌ "No space left on device" (di VPS)

```bash
ssh root@VPS_IP "df -h"
# Hapus backup lama
ssh root@VPS_IP "rm -rf /var/www/web2app-studio.bak"

# Hapus log
ssh root@VPS_IP "journalctl --vacuum-time=7d"
ssh root@VPS_IP "pm2 flush"
```

### ❌ Rsync sangat lambat

```bash
# Tambahkan compression
rsync -avz --compress-level=9 ...

# Atau cek koneksi
scp -v /tmp/test root@VPS_IP:/tmp/
```

### ❌ "Host key verification failed"

```bash
# Hapus known_hosts entry lama
ssh-keygen -R VPS_IP
```

---

## 📊 Perbandingan Metode

| Aspek | SCP | Rsync | SFTP/GUI | Tar+Curl |
|-------|-----|-------|----------|----------|
| **Kecepatan upload pertama** | Cepat | Cepat | Cepat | Lambat |
| **Kecepatan update** | Lambat (semua file) | **Sangat cepat** (delta) | Manual | Lambat |
| **Atomicity** | ✅ (tar) | ✅ (rsync --delete) | ❌ (partial) | ✅ (tar) |
| **Resume** | ❌ | ✅ | ❌ | ❌ |
| **Scriptable** | ✅ | ✅ | ❌ | ✅ |
| **GUI** | ❌ | ❌ | ✅ | ❌ |
| **Default di macOS/Linux** | ✅ | ✅ | - | ✅ |
| **Default di Windows** | ❌ (perlu OpenSSH) | ❌ | ✅ (WinSCP) | ✅ |

---

## 🎯 Rekomendasi Final

**Untuk project Web2App Studio Anda:**

1. **Setup awal**: Pakai **SCP** (paling simpel) atau **rsync** (lebih cepat)
2. **Update rutin**: Pakai **Rsync** dengan script `deploy.sh` (hanya transfer file yang berubah, hemat bandwidth)
3. **Kalau pakai Windows**: Install WSL atau pakai **WinSCP** untuk setup awal
4. **Bisa pakai GUI**: **VS Code + SFTP extension** paling nyaman untuk development

**Workflow yang saya rekomendasikan:**

```bash
# 1. Setup sekali: SSH key + script deploy
ssh-copy-id root@VPS_IP
# (save deploy.sh script di project root lokal)

# 2. Setiap hari:
#    - Edit file di lokal
#    - Save
#    - Run: ./deploy.sh
#    - Done! (< 30 detik untuk file kecil)
```

---

## 📖 Langkah Setelah Upload

Setelah project ada di `/var/www/web2app-studio`, lanjut ke:

1. **Pointing domain Rumahweb → VPS** (DNS A record) → lihat `panduan_vps.md` bagian "Setup Domain"
2. **Install dependencies** → `sudo bash ops/install.sh`
3. **SSL Let's Encrypt** diurus otomatis certbot di `ops/scripts/deploy.sh`
4. **Configure & deploy** → `sudo bash ops/scripts/deploy.sh`

Total waktu: **~35 menit** dari VPS kosong sampai aplikasi running.
