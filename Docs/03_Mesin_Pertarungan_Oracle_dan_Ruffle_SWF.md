# Mesin Pertarungan Deterministik "Oracle" & Jembatan Ruffle SWF — Ninja Horizon

Dokumen ini menjelaskan cara kerja internal dari dua subsistem paling kompleks di dalam **Ninja Horizon**:
1. **Mesin Pertarungan Deterministik `"Oracle"`** (yang di-*obfuscate* dengan `javascript-obfuscator` di dalam bundel Hermes).
2. **Arsitektur Rendering Animasi Flash (`.swf`) berbasis Ruffle WebAssembly/WebGL** di dalam `react-native-webview`.

---

## 1. Bedah Mesin Pertarungan Deterministik `"Oracle"`

### 1.1 Mengapa Modul Ini Di-obfuscate?
Saat menganalisis `assets/index.android.bundle`, ditemukan bahwa modul UI dan layanan API tidak mengalami obfuskasi nama fungsi, namun terdapat **1.774 simbol `_0x...`** dan **3.559 string terenkripsi Base64 kustom** (`a-zA-Z0-9+/=`) milik `javascript-obfuscator`.

Setelah seluruh 3.559 string tersebut didekode (lihat [`lampiran/decoded_jsobf_strings.json`](./lampiran/decoded_jsobf_strings.json)), terungkap bahwa bagian yang sengaja disembunyikan tersebut adalah **mesin simulasi pertarungan bernama `"Oracle"`**.

Alasan teknis obfuskasi ini adalah karena Ninja Horizon menggunakan arsitektur **Deterministic Client-Side Simulation with Server-Side Replay**:
* Pertarungan PvE (Mission, Hunting, Exam, Tower, Clan Battle) **tidak** melakukan request HTTP per giliran (*turn*), melainkan disimulasikan secara penuh di klien oleh mesin **Oracle**.
* Di akhir pertarungan, klien mengirimkan daftar tindakan (`actions`) ke `/functions/v1/resolve-battle`, dan server menjalankan kode mesin **Oracle** yang persis sama untuk memvalidasi apakah urutan `actions` dengan `seed` awal benar-benar menghasilkan kemenangan tersebut.

### 1.2 Bukti String Kunci dari Mesin `Oracle`
Berikut adalah string diagnostik dan pesan *assertion* internal yang berhasil didekode dari dalam mesin **Oracle**:

| Index String HBC | String Hasil Dekode (`decoded_jsobf_strings.json`) | Makna Arsitektural |
| :--- | :--- | :--- |
| `[2397]` | `"MatchState is detached from its Oracle session; reinitialize from seed + build snapshot"` | State pertarungan sepenuhnya deterministik dan diinisialisasi dari `seed` PRNG + `build snapshot`. |
| `[2401]` | `"withOracleRuntime operation must be synchronous"` | Eksekusi langkah di dalam runtime Oracle wajib berjalan sinkron tanpa operasi I/O asinkron. |
| `[1990]` | `" requires an explicit learned-skill snapshot"` | Setiap unit harus memiliki *snapshot* daftar *skill* yang dipelajari secara eksplisit. |
| `[10005]` | `" requires an explicit owner snapshot"` | Validasi kepemilikan unit/karakter pada awal simulasi. |
| `[11853]` | `"Battle snapshot has no battle_catalog_v2 definition catalog"` | Mesin Oracle membutuhkan katalog definisi `battle_catalog_v2` (`skill_defs`, `gear_defs`, `enemy_action_v1`, `pet_action_v2`, `npc_action_v1`). |
| `[14577]` | `"Oracle ATB did not produce a turn within "` | Sistem giliran menggunakan *Active Time Battle* (ATB) dengan konstanta `BATTLE_ATB_ACTION_TIME` (`[12912]`). |
| `[10253]` | `"Oracle reactive follow-up chain exceeded 32 actions"` | Batas pengaman (*guard*) terhadap *infinite loop* pada efek pasif/balasan (*reactive follow-up*) maksimal 32 aksi beruntun. |
| `[18917]` | `" requires an explicit player action"` | Ketika giliran jatuh pada karakter utama pemain, mesin berhenti dan menunggu input eksplisit pemain. |
| `[10673]` | `"CharacterBattle.nextRound@346:Central.battle.syncHpCpCommandAction"` | Bukti langsung bahwa logika *Oracle* diturunkan dari kode sumber ActionScript 3 *Ninja Saga* (`Central.battle`, `CharacterBattle`). |
| `[870]` | `"https://www.facebook.com/pages/忍者傳說/155835877865597"` | Sisa konstanta URL halaman Facebook asli *Ninja Saga* (*忍者傳說*) di dalam kode mesin pertarungan. |

### 1.3 Mekanisme Siklus Giliran (*Turn Lifecycle*) di Dalam `Oracle`
Berdasarkan fungsi dan string internal yang didekode:
1. **Inisialisasi (`prepareActor`, `snapshotUnit`, `rngState`)**:
   * Membangun *actor* untuk pemain (`ally-side main character`), NPC/rekrutan (`oracle_npc_`), *pet* (`oracle_pet_`), dan musuh (`oracle_enemy_`).
   * Menghitung statistik dasar dan bonus pasif dari *gear set*, *talent* (`Oracle talent`), *senjutsu* (`SENJUTSU_SKILL_DATA_ARR`), dan bangunan klan (`clan_hp_bonus`, `clan_cp_bonus`, `clan_damage_bonus`).
   * Mencatat integritas HP/CP/SP melalui `hpHashString` (`[10204]`), `cpHashString` (`[14359]`), dan `spHashString` (`[3725]`).
2. **Kalkulasi ATB & Permulaan Giliran (`beginTurn`, `characterTurn`, `nextReadyTurn`)**:
   * Menggerakkan *tick* ATB (`shape 5768`: `['actorId', 'ticks', 'atb']`) hingga salah satu unit mencapai ambang giliran.
   * Pada awal giliran (`beginTurn`), memproses efek *buff/debuff* aktif (`isBattleBuffActive`, `burnTurns`, `poisonTurns`, `petTurns`, `rallyTurns`, `furyTurns`, `lingerTurns`), regenerasi HP/CP/SP, serta pengurangan *cooldown* (`syncCoolDownObj`).
   * Memeriksa apakah unit terkena efek lewati giliran (`checkSkipBattleTurn`, seperti *Stun*, *Sleep*, *Freeze*, *Restriction*, *Lock*, atau *skill3007*).
3. **Pemilihan & Eksekusi Aksi (`setupAction`, `processBattleAction`, `finalizeBattleAction`)**:
   * Untuk pemain: menerima perintah melalui `setCommand` / `updateBattleAction` (serangan senjata, `ACTION_SKILL`, `ACTION_CLASS_SKILL`, `Skip Battle Turn`, `charge`, atau item). Terdapat fungsi pembantu `suggestPlayerAction` (`[12664]`) dan rencana otomatis (`setAutoPlan`).
   * Untuk AI (Musuh / Pet / NPC): memilih aksi secara deterministik menggunakan `aiAction` (`[17171]`) dan `rngState` (`nextInt` / `getRandom`) berdasarkan tabel probabilitas `enemy_action_v1`, `pet_action_v2`, dan `npc_action_v1`.
   * Menghitung *damage* (`processDamage`), peluang *dodge*, *critical* (`critMultiplier`, `EFFECT_DEFENDER_CRITICAL_CHANCE`), *shield/guard*, *drain HP/CP*, *reactive force*, *extra turn* (`checkExtraTurn`, `commitExtraTurn`), serta kebangkitan (`resurrectionObj`, `undyingAction`).

---

## 2. Arsitektur Jembatan WebView & Ruffle Flash (`.swf`) Renderer

Untuk menampilkan grafis karakter dan animasi jurus `.swf` secara mulus di Android tanpa *flicker* atau kehabisan memori WebGL, aplikasi menyematkan kode pengendali khusus di dalam `WebView` (terekstrak lengkap pada [`lampiran/stage_controller.js`](./lampiran/stage_controller.js)).

### 2.1 Manajemen Multi-Realm (`iframe`) & Pencegahan *WebGL Context Lost*
* **Realm Isolation (String `[283]` & `[21849]`)**:
  * Setiap pergantian layar (*scene*) membuat elemen `<iframe>` baru (`makeRealm(epoch, hidden)`) dengan `opacity: 0`.
  * `iframe` lama baru dihancurkan (`retire(s.from)` -> `r.win.__dispose()`) **setelah** `iframe` baru mengirimkan sinyal siap (`rigReady`, `faceoffReady`, atau `battleReady` pada `commitSwap()`).
* **Frame Pump (`requestAnimationFrame` Interceptor, String `[497]`)**:
  * Sebelum Ruffle dimuat, script membajak `window.requestAnimationFrame` untuk menahan pemutaran frame saat panggung (*stage*) disembunyikan (`__holdFrames`) dan memungkinkan pengambilan gambar diam (*stills* untuk ikon *action-bar* lewat `takeStills()`) dalam 1 frame tanpa memutar waktu film secara mundur.
* **Pemulihan Kerusakan WebGL (`hookContexts`, String `[21850]`)**:
  * Memasang pendengar `webglcontextlost` pada setiap `<canvas>` di dalam Shadow DOM Ruffle. Jika konteks WebGL hilang, WebView mengirimkan pesan `{type: 'rendererFault', cause: 'webgl-context-lost'}` ke React Native agar *stage* di-*remount* secara otomatis.

### 2.2 Protokol Komunikasi React Native ↔ WebView (`stage_controller.js`)

#### A. Perintah dari React Native ke WebView (`window.__invoke` / `window.<fn>`)
* **`window.__warm(id, urls)`** & **`window.__prefetch(urls)`**: Memuat awal (*pre-warm* HTTP cache menggunakan 4 *worker* paralel) daftar URL `.swf` dari `https://assets.ninjahorizon.com/a/swf36/...` dan mengirimkan sinyal `{type: 'skillsReady', id}` setelah seluruh *body* `.swf` selesai diunduh.
* **`window.__rig(spec)`**: Merender tampilan karakter kustomisasi (*dress-up*) menggunakan `/core/mobile/dress_v3-36.swf` (`applyDress`: mengatur `hair`, `face`, `set`/pakaian, `back` item, `wpn`/senjata, dan warna kulit/rambut).
* **`window.__faceoff(spec)`**: Merender layar berhadapan (*vs screen*) sebelum pertarungan dimulai.
* **`window.__battle(spec)`**: Memuat panggung pertarungan utama (`/action_base-36.swf`), mengatur posisi unit kawan/lawan, dan menjalankan animasi serangan/jurus.
* **`window.__gear(spec)`**: Merender pratinjau ikon item/perlengkapan.
* **`window.__marker(spec)`**: Menampilkan indikator target di atas kepala unit saat memilih sasaran jurus.
* **`window.__clear()` / `window.__dispose()`**: Membersihkan memori pemain Ruffle.

#### B. Callback dari ActionScript (.swf) / WebView ke React Native (`window.ReactNativeWebView.postMessage`)
* **`window.__castDone()`** -> `{type: 'castDone'}`: Dipanggil oleh `.swf` saat animasi jurus selesai diputar.
* **`window.__castHit()`** -> `{type: 'castHit'}`: Dipanggil oleh `.swf` tepat pada *frame* benturan serangan untuk memicu angka *damage* dan efek suara (SFX).
* **`window.__reviveDone()`** -> `{type: 'reviveDone'}`: Dipanggil saat animasi kebangkitan selesai.
* **`{type: 'ready'}` / `{type: 'rigReady'}` / `{type: 'faceoffReady'}` / `{type: 'battleReady'}`**: Sinyal sinkronisasi kesiapan kanvas Ruffle ke React Native.
* **`{type: 'fps', value: <int>}`**: Telemetri kecepatan *frame* per detik dari WebView ke host React Native.
