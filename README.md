# Ninja Horizon — Riset Reverse Engineering & Headless Bot

Repo ini berisi hasil investigasi reverse engineering (REA) terhadap aplikasi *Ninja Horizon* dan prototipe bot headless (Node.js, tanpa dependensi npm).

> [!WARNING]
> Repo ini dibuat untuk tujuan riset/edukasi. Mengotomasi gameplay kemungkinan melanggar Terms of Service game dan dapat menyebabkan akun di-ban. Risiko ditanggung pengguna sendiri.

## Struktur

| Path | Isi |
| --- | --- |
| `Docs/` | Laporan investigasi, katalog API/RPC, analisis mesin pertarungan, panduan bot |
| `bot/bot.js` | CLI bot (login SSO Google, status, farming Misi, World Boss, Hunting House, Eudemon Garden, Shinobi Tower, Auto Exam, TP & SS Training) |
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

# 6. Auto-Climb Shinobi Tower (Tower of Trials — Minimal Lv 10)
node bot.js --tower-status   # cek rekor lantai saat ini, rank mingguan, & sweep
node bot.js --tower          # auto-climb: daki lantai demi lantai secara berurutan
node bot.js --tower --max-floors 5     # batasi pendakian maksimal 5 lantai
node bot.js --tower --target-floor 80  # berhenti setelah mencapai lantai target
node bot.js --tower-sweep    # klaim instan hadiah sweep jika tersedia
node bot.js --tower --auto-sweep       # otomatis lakukan sweep sebelum mulai memanjat

# 7. Ujian Promosi Ninja (Auto Exam Lv 20, 40, 60, & 80)
node bot.js --exam-status    # cek status kelulusan ujian semua rank (Chunin, Jounin, Sp. Jounin, Tutor)
node bot.js --exam           # jalankan ujian promosi otomatis sesuai level karakter saat ini
node bot.js --exam --track tensai   # ambil jalur Tensai (Talented track)
node bot.js --exam-level 20  # paksa jalankan ujian tingkatan tertentu (20, 40, 60, atau 80)
# Bot AFK EXP secara otomatis mendeteksi saat karakter mencapai Lv 20, 40, 60, 80 dan menjalankan ujian promosi tanpa intervensi manual!

# 8. Special Training Harian (TP Training & SS Training)
node bot.js --training-status # cek saldo TP & Senjutsu Spirit serta penawaran training hari ini
node bot.js --tp             # selesaikan seluruh TP Training harian otomatis (Talent Points, Lv 40+)
node bot.js --ss             # selesaikan seluruh SS Training harian otomatis (Senjutsu Spirit, Lv 80+)
node bot.js --training       # jalankan seluruh Special Training yang tersedia (TP & SS sekaligus)
```
