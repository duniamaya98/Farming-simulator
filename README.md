# Ninja Horizon — Riset Reverse Engineering & Headless Bot

Repo ini berisi hasil investigasi reverse engineering (REA) terhadap aplikasi *Ninja Horizon* dan prototipe bot headless (Node.js, tanpa dependensi npm).

> [!WARNING]
> Repo ini dibuat untuk tujuan riset/edukasi. Mengotomasi gameplay kemungkinan melanggar Terms of Service game dan dapat menyebabkan akun di-ban. Risiko ditanggung pengguna sendiri.

## Struktur

| Path | Isi |
| --- | --- |
| `Docs/` | Laporan investigasi, katalog API/RPC, analisis mesin pertarungan, panduan bot |
| `bot/bot.js` | CLI bot (login SSO Google, status, farming Misi, World Boss, & Event Boss) |
| `bot/oracle_engine.js` | Interpreter bytecode Hermes v98 untuk menjalankan mesin pertarungan |
| `bot/config.example.json` | Template konfigurasi |

## File yang sengaja TIDAK disertakan

- **Kredensial**: `bot/session.json`, `bot/config.json`, `bot/daily.json` — dibuat otomatis secara lokal.
- **File proprietary milik game**: APK, `bot/oracle_bytecode.bin`, `bot/oracle_meta.json`, `bot/legacy_apk_engines/`, `Docs/lampiran/`.

Bot membutuhkan `oracle_bytecode.bin` + `oracle_meta.json` yang diekstrak dari bundle Hermes versi game terbaru (lihat `Docs/03_*` dan `Docs/04_*`).

## Penggunaan Singkat

```bash
cd bot
cp config.example.json config.json
node bot.js --login-google   # login SSO, token disimpan ke session.json (lokal)
node bot.js --status         # cek profil & stamina

# 1. Farming Misi (AFK EXP)
node bot.js --list-missions
node bot.js --runs 5

# 2. Farming World Boss
node bot.js --wb-status      # cek tiket WB, bos aktif, & milestone
node bot.js --wb             # gunakan semua tiket WB hari ini
node bot.js --wb --runs 2    # serang WB 2 ronde
node bot.js --wb --auto-claim # auto claim hadiah milestone setelah battle

# 3. Farming Event Boss / Hunting House
node bot.js --list-bosses    # lihat daftar event boss & hunting catalog
node bot.js --event          # serang event boss rekomendasi otomatis
node bot.js --event --boss-id <room_id>  # serang event boss spesifik
```
