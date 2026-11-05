# Ninja Horizon — Riset Reverse Engineering & Headless Bot

Repo ini berisi hasil investigasi reverse engineering (REA) terhadap aplikasi *Ninja Horizon* dan prototipe bot headless (Node.js, tanpa dependensi npm).

> [!WARNING]
> Repo ini dibuat untuk tujuan riset/edukasi. Mengotomasi gameplay kemungkinan melanggar Terms of Service game dan dapat menyebabkan akun di-ban. Risiko ditanggung pengguna sendiri.

## Struktur

| Path | Isi |
| --- | --- |
| `Docs/` | Laporan investigasi, katalog API/RPC, analisis mesin pertarungan, panduan bot |
| `bot/bot.js` | CLI bot (login SSO Google, status, farming Misi, World Boss, Hunting House, Eudemon Garden, & Event Boss) |
| `bot/oracle_engine.js` | Interpreter bytecode Hermes v98 untuk menjalankan mesin pertarungan |
| `bot/extract_oracle.py` | Script ekstraksi bytecode & metadata Oracle dari bundle Hermes |
| `bot/config.example.json` | Template konfigurasi |

## File yang sengaja TIDAK disertakan

- **Kredensial**: `bot/session.json`, `bot/config.json`, `bot/daily.json` — dibuat otomatis secara lokal.
- **File proprietary milik game**: APK, `bot/oracle_bytecode.bin`, `bot/oracle_meta.json`, `bot/legacy_apk_engines/`, `Docs/lampiran/`.

Bot membutuhkan `oracle_bytecode.bin` + `oracle_meta.json` yang dapat diekstrak otomatis menggunakan `python bot/extract_oracle.py`.

## Penggunaan Singkat

```bash
cd bot
cp config.example.json config.json
node bot.js --login-google   # login SSO, token disimpan ke session.json (lokal)
node bot.js --status         # cek profil & level karakter

# 1. Farming Misi (AFK EXP)
node bot.js --list-missions  # rekomendasi misi XP tertinggi sesuai level
node bot.js --runs 10        # jalankan 10 ronde misi otomatis

# 2. Farming World Boss
node bot.js --wb-status      # cek tiket WB, bos aktif, & milestone
node bot.js --wb             # habiskan seluruh tiket World Boss hari ini
node bot.js --wb --runs 2    # serang World Boss 2 ronde
node bot.js --wb --auto-claim # otomatis klaim hadiah milestone damage

# 3. Farming Hunting House (Kari Badges — Minimal Lv 10)
node bot.js --hunt-status    # cek saldo Kari Badge & room terbuka
node bot.js --hunting        # auto: pilih room hunting tertinggi sesuai level (Ginkotsu s.d Mutoh)
node bot.js --hunting --room hunt_ginkotsu  # farming room spesifik

# 4. Farming Eudemon Garden (EXP Tinggi & Material Forge — Minimal Lv 10)
node bot.js --eudemon        # auto: pilih room garden tertinggi sesuai level (Kamaitachi s.d Chimera)
node bot.js --eudemon --room eudemon_kamaitachi  # farming room spesifik

# 5. Farming Event Boss (Event Stamina)
node bot.js --list-bosses    # lihat katalog lengkap event & hunting
node bot.js --event          # serang event boss aktif (mis. Pumpkin Graveyard)
node bot.js --event --runs 5 # serang event boss 5 ronde
```
