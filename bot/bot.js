#!/usr/bin/env node
/**
 * Ninja Horizon â€” Headless AFK EXP Bot (Metode A)
 * ===============================================
 * Menjalankan misi PvE secara otomatis di background tanpa emulator/UI (0% GPU)
 * dengan mengeksekusi bytecode asli mesin pertarungan Oracle (Hermes v98)
 * untuk menghasilkan payload `actions` dan `client` (`replayDiagnostic`) yang
 * 100% identik dengan aplikasi resmi.
 *
 * Penggunaan:
 *   node bot.js --test-sim          # Uji simulasi offline 3 versi mesin Oracle
 *   node bot.js --status            # Cek status karakter & kuota kemenangan harian
 *   node bot.js --list-missions     # Tampilkan daftar misi dari server
 *   node bot.js                     # Jalankan loop AFK EXP sesuai config.json
 *   node bot.js --mission msn_1     # Jalankan misi tertentu
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { exec } = require('child_process');
const {
  engineForBattle,
  supportedBattleEngines,
  battleEngineHeaders,
  simulateBattle,
} = require('./oracle_engine');

const LATEST_ENGINE_VERSION = supportedBattleEngines[0] || '8b314b03';

// ============================================================================
// Konstanta Protokol & Konfigurasi Server (Diekstrak dari func[582] & func[626])
// ============================================================================
const DEFAULT_SUPABASE_URL = 'https://uoiuuecrfbvtoadtwrvj.supabase.co';
const DEFAULT_SUPABASE_KEY = 'sb_publishable_fmv5Sz29F8kwXJCsa0Q_uQ_F98vjN6J';
const CLIENT_INFO_HEADER = 'supabase-js-react-native/2.97.0 nh-senjutsu/1';
const BATTLE_ENGINES_HEADER = battleEngineHeaders['x-battle-engines'];
const BATTLE_PROTOCOL_HEADER = '1';
const FALLBACK_REGION = 'us-east-1';
const FALLBACK_STICKY_MS = 60_000;

const CONFIG_PATH = path.join(__dirname, 'config.json');
const SESSION_PATH = path.join(__dirname, 'session.json');

// ============================================================================
// Utilitas Logging & Waktu
// ============================================================================
function timestamp() {
  const now = new Date();
  return now.toTimeString().split(' ')[0];
}

function logInfo(msg) {
  console.log(`[${timestamp()}] [INFO]  ${msg}`);
}

function logSuccess(msg) {
  console.log(`[${timestamp()}] [OK]    ${msg}`);
}

function logWarn(msg) {
  console.warn(`[${timestamp()}] [WARN]  ${msg}`);
}

function logError(msg) {
  console.error(`[${timestamp()}] [ERR]   ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// ============================================================================
// Kelas Klien API Ninja Horizon (Meniru func[22436] & func[26886])
// ============================================================================
class NinjaHorizonClient {
  constructor(config) {
    this.supabaseUrl = (config.supabaseUrl || DEFAULT_SUPABASE_URL).replace(/\/+$/, '');
    this.supabaseKey = config.supabaseKey || DEFAULT_SUPABASE_KEY;
    this.config = config;
    this.session = this.loadSession();
    this.fallbackUntil = 0;
  }

  loadSession() {
    try {
      if (fs.existsSync(SESSION_PATH)) {
        return JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
      }
    } catch (err) {
      logWarn(`Gagal membaca session.json: ${err.message}`);
    }
    return {
      accessToken: this.config.accessToken || '',
      refreshToken: this.config.refreshToken || '',
      expiresAt: 0,
      user: null,
    };
  }

  saveSession(sessionData) {
    this.session = {
      ...this.session,
      ...sessionData,
      updatedAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(SESSION_PATH, JSON.stringify(this.session, null, 2), 'utf8');
    } catch (err) {
      logWarn(`Gagal menyimpan session.json: ${err.message}`);
    }
  }

  getCommonHeaders(includeAuth = true) {
    const headers = {
      apikey: this.supabaseKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-client-info': CLIENT_INFO_HEADER,
      'x-battle-engines': BATTLE_ENGINES_HEADER,
      'x-battle-protocol': BATTLE_PROTOCOL_HEADER,
    };
    if (includeAuth && this.session.accessToken) {
      headers.Authorization = `Bearer ${this.session.accessToken}`;
    } else if (includeAuth) {
      headers.Authorization = `Bearer ${this.supabaseKey}`;
    }
    return headers;
  }

  /**
   * Memastikan token akses valid dan otomatis memperbarui jika hampir kedaluwarsa.
   */
  async ensureAuthenticated() {
    const nowSec = Math.floor(Date.now() / 1000);

    // Sinkronkan dari config jika session.json belum memiliki token
    if (!this.session.accessToken && this.config.accessToken) {
      this.session.accessToken = this.config.accessToken;
    }
    if (!this.session.refreshToken && this.config.refreshToken) {
      this.session.refreshToken = this.config.refreshToken;
    }

    // Periksa masa berlaku JWT
    if (this.session.accessToken) {
      const payload = decodeJwtPayload(this.session.accessToken);
      const exp = payload?.exp || this.session.expiresAt || 0;
      if (exp > nowSec + 90) {
        return this.session.accessToken;
      }
      logInfo('Access token kedaluwarsa atau hampir habis, memperbarui sesi...');
    }

    // Prioritas 1: Gunakan refresh_token
    if (this.session.refreshToken) {
      try {
        await this.loginWithRefreshToken(this.session.refreshToken);
        return this.session.accessToken;
      } catch (err) {
        logWarn(`Refresh token gagal (${err.message}), mencoba metode login lain...`);
      }
    }

    // Prioritas 2: Gunakan email & password
    if (this.config.email && this.config.password) {
      await this.loginWithPassword(this.config.email, this.config.password);
      return this.session.accessToken;
    }

    // Prioritas 3: Jika user hanya mengisi accessToken tanpa exp atau masih ingin dicoba
    if (this.session.accessToken) {
      return this.session.accessToken;
    }

    throw new Error(
      'Kredensial belum dikonfigurasi! Silakan isi email/password atau refreshToken/accessToken di bot/config.json'
    );
  }

  async loginWithPassword(email, password) {
    logInfo(`Login menggunakan email: ${email}...`);
    const url = `${this.supabaseUrl}/auth/v1/token?grant_type=password`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getCommonHeaders(false),
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const msg = data.error_description || data.msg || data.message || `HTTP ${res.status}`;
      throw new Error(`Login gagal: ${msg}`);
    }
    this.saveSession({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      user: data.user ? { id: data.user.id, email: data.user.email } : null,
    });
    logSuccess(`Login berhasil! User ID: ${data.user?.id || 'terautentikasi'}`);
  }

  async loginWithRefreshToken(refreshToken) {
    logInfo('Memperbarui token menggunakan refresh_token...');
    const url = `${this.supabaseUrl}/auth/v1/token?grant_type=refresh_token`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getCommonHeaders(false),
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const msg = data.error_description || data.msg || data.message || `HTTP ${res.status}`;
      throw new Error(`Refresh token gagal: ${msg}`);
    }
    this.saveSession({
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      user: data.user ? { id: data.user.id, email: data.user.email } : this.session.user,
    });
    logSuccess('Token sesi berhasil diperbarui dan disimpan ke session.json.');
  }

  /**
   * Memanggil PostgREST RPC (`/rest/v1/rpc/<fnName>`).
   */
  async rpc(fnName, params = {}) {
    await this.ensureAuthenticated();
    const url = `${this.supabaseUrl}/rest/v1/rpc/${fnName}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getCommonHeaders(true),
      body: JSON.stringify(params),
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!res.ok) {
      const errMsg =
        (data && (data.message || data.error || data.details || data.hint)) ||
        `HTTP ${res.status}`;
      const err = new Error(`RPC ${fnName} gagal: ${errMsg}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /**
   * Memanggil Edge Function `/functions/v1/resolve-battle` dengan dukungan
   * fallback region `us-east-1` seperti `createBattleRegionFetch` (`func[26886]`).
   */
  async invokeResolveBattle(body) {
    await this.ensureAuthenticated();

    const buildUrl = (useFallback) => {
      const base = `${this.supabaseUrl}/functions/v1/resolve-battle`;
      return useFallback ? `${base}?forceFunctionRegion=${FALLBACK_REGION}` : base;
    };

    const now = Date.now();
    const useFallbackInitially = now < this.fallbackUntil;

    const sendRequest = async (useFallback) => {
      const url = buildUrl(useFallback);
      const res = await fetch(url, {
        method: 'POST',
        headers: this.getCommonHeaders(true),
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = { raw: text };
      }
      return { res, payload };
    };

    let { res, payload } = await sendRequest(useFallbackInitially);

    // Logika shouldFallback di func[26886]: HTTP 502/504 atau 503 (bukan maintenance/PT503)
    if (!useFallbackInitially && (res.status === 502 || res.status === 504 || res.status === 503)) {
      const code = payload && typeof payload === 'object' ? payload.code : undefined;
      if (res.status !== 503 || (code !== 'maintenance' && code !== 'PT503')) {
        logWarn(
          `Edge Function mengembalikan HTTP ${res.status}, beralih ke fallback region ${FALLBACK_REGION} selama 60 detik...`
        );
        this.fallbackUntil = Date.now() + FALLBACK_STICKY_MS;
        ({ res, payload } = await sendRequest(true));
      }
    }

    if (!res.ok) {
      const code = payload?.code || '';
      const msg =
        payload?.error ||
        payload?.message ||
        `Edge Function resolve-battle gagal (HTTP ${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      err.code = code;
      err.payload = payload;
      throw err;
    }

    return payload;
  }

  /**
   * Query tabel PostgREST (`GET /rest/v1/<pathAndQuery>`), mis. `game_config?select=...`.
   */
  async rest(pathAndQuery) {
    await this.ensureAuthenticated();
    const res = await fetch(`${this.supabaseUrl}/rest/v1/${pathAndQuery}`, {
      headers: this.getCommonHeaders(true),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`REST ${pathAndQuery.split('?')[0]} gagal: ${data?.message || `HTTP ${res.status}`}`);
    }
    return data;
  }

  /** Membaca beberapa baris `game_config` sebagai objek { key: value } (meniru fetchMissionEconomy func[23579]). */
  async gameConfig(keys) {
    const rows = await this.rest(`game_config?select=key,value&key=in.(${keys.join(',')})`);
    const out = {};
    for (const row of rows || []) out[row.key] = row.value;
    return out;
  }

  /** Mengambil avatar pemain (tabel `player_avatar`, meniru fetchAvatar func[23312]). */
  async fetchAvatar() {
    const rows = await this.rest('player_avatar?select=name,level,xp,rank,auto_plan');
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  /**
   * Memulai sesi misi (`mission_start`) atau melanjutkan sesi yang belum selesai.
   */
  async startMission(missionId) {
    return await this.rpc('mission_start', { p_mission: missionId });
  }

  /**
   * Membatalkan sesi misi aktif jika diperlukan (`mission_abandon`).
   */
  async abandonMission(sessionId) {
    return await this.rpc('mission_abandon', { p_session: sessionId });
  }

  /**
   * Mengambil build awal pertarungan dari `/functions/v1/resolve-battle` (`mode: "start"`).
   */
  async startBattle(sessionId) {
    return await this.invokeResolveBattle({
      session: sessionId,
      mode: 'start',
    });
  }

  /**
   * Menyelesaikan pertarungan (`mode: "finish"`) dengan retry otomatis apabila
   * terjadi HTTP 504 / 546 timeout sesuai implementasi `func[23327]`.
   */
  async finishBattle(sessionId, actions, clientDiag, maxRetries = 4) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.invokeResolveBattle({
          session: sessionId,
          mode: 'finish',
          response: 'receipt',
          actions,
          client: clientDiag,
        });
      } catch (err) {
        const isTimeout = err.status === 504 || err.status === 546 || err.status === 502;
        if (isTimeout && attempt < maxRetries) {
          const waitMs = attempt * 3000;
          logWarn(
            `Resolusi battle timeout (HTTP ${err.status}), mencoba ulang (${attempt}/${maxRetries}) dalam ${waitMs / 1000}s...`
          );
          await sleep(waitMs);
          continue;
        }
        throw err;
      }
    }
  }
}

// ============================================================================
// Mode Uji Offline (`--test-sim`): Menguji Ketiga Versi Mesin Oracle
// ============================================================================
function runOfflineSimulationTest() {
  logInfo('============================================================');
  logInfo('UJI SIMULASI OFFLINE â€” MESIN PERTARUNGAN ORACLE (HERMES v98)');
  logInfo('============================================================');

  for (const ver of supportedBattleEngines) {
    engineForBattle(ver);
  }
  logInfo(
    `Versi mesin Oracle yang dimuat: ${supportedBattleEngines.join(', ')} (terbaru: ${LATEST_ENGINE_VERSION})`
  );

  for (const ver of supportedBattleEngines) {
    const engine = engineForBattle(ver);

    // Buat definisi catalog & unit sintetis untuk memvalidasi determinisme mesin
    const enemyDef = {
      id: 'e1',
      name: 'Bandit',
      hp: 100,
      cp: 80,
      agility: 10,
      damage: 12,
      ai_mode: 'priority_ready',
      skills: [],
    };
    const catalog = {
      schema: 'battle_catalog_v2',
      skill_defs: [],
      gear_defs: [{ id: 'wpn1', slot: 'weapon', bonuses: { damage: 45 }, level: 1 }],
      gear_set_defs: [],
      item_defs: [],
      enemy_defs: [enemyDef],
      pet_defs: [],
      talent_defs: [],
      senjutsu_defs: [],
      senjutsu_skill_defs: [],
    };

    const playerUnit = engine.buildAvatar(
      {
        id: 'p1',
        name: 'Hero',
        level: 10,
        rank: 'genin',
        equipped: { weapon: 'wpn1' },
        attributes: { wind: 10, fire: 15, earth: 5, water: 5, lightning: 5 },
      },
      catalog.skill_defs,
      null
    );

    const enemyUnit = engine.buildEnemy(enemyDef, catalog.skill_defs, 'enemy', 5);

    const syntheticBuild = {
      engineVersion: ver,
      seed: 12345,
      units: [playerUnit, enemyUnit],
      waves: [],
      catalog,
    };

    const t0 = Date.now();
    const simResult = simulateBattle(syntheticBuild);
    const elapsedMs = Date.now() - t0;

    // Verifikasi ulang dengan fungsi engine.replay(matchInput, actions)
    const replayState = engine.replay(
      {
        seed: syntheticBuild.seed,
        units: syntheticBuild.units,
        waves: syntheticBuild.waves,
        catalog: syntheticBuild.catalog,
      },
      simResult.actions
    );

    const checksumMatch = replayState.checksum === simResult.client.checksum;
    if (!checksumMatch || simResult.client.status !== 'win') {
      throw new Error(
        `Verifikasi mesin ${ver} gagal! status=${simResult.client.status}, checksumMatch=${checksumMatch}`
      );
    }

    logSuccess(
      `Engine [${ver}] -> Status: ${simResult.client.status.toUpperCase()} | ` +
        `Round: ${simResult.client.round} | Turns: ${simResult.client.turns} | ` +
        `Actions: ${simResult.actions.length} | Checksum: ${simResult.client.checksum} (Replay Verified) | ` +
        `Waktu: ${elapsedMs}ms`
    );
  }

  logInfo('------------------------------------------------------------');
  logSuccess('Semua versi mesin Oracle berjalan 100% deterministik dan siap digunakan!');
}

const DAILY_PATH = path.join(__dirname, 'daily.json');

/** Server tidak mengembalikan `wins_today`, jadi bot menghitung kemenangan harian sendiri (hari UTC). */
function loadDailyWins() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const d = JSON.parse(fs.readFileSync(DAILY_PATH, 'utf8'));
    if (d.date === today) return d;
  } catch {}
  return { date: today, wins: 0, xp: 0 };
}

function saveDailyWins(daily) {
  try {
    fs.writeFileSync(DAILY_PATH, JSON.stringify(daily, null, 2), 'utf8');
  } catch {}
}

/** Memastikan versi engine lokal masih diterima server (game_config.battle_engine_policy). */
async function checkEnginePolicy(client) {
  const { battle_engine_policy: policy } = await client.gameConfig(['battle_engine_policy']);
  if (!policy) return null;
  const accepted = new Set([policy.active, ...(policy.accepted || []), ...(policy.draining || [])]);
  const usable = supportedBattleEngines.filter((v) => accepted.has(v));
  if (usable.length === 0) {
    throw new Error(
      `Semua engine lokal (${supportedBattleEngines.join(', ')}) sudah tidak diterima server ` +
        `(active=${policy.active}, accepted=${(policy.accepted || []).join(', ')}). ` +
        `Perlu ekstrak ulang engine dari bundle OTA terbaru.`
    );
  }
  return { policy, usable };
}

/** Memilih misi non-exam dengan XP tertinggi yang levelnya <= level avatar. */
async function pickBestMission(client, level) {
  const rows = await client.rest(
    `mission_defs?select=id,name,grade,level,xp,gold&is_exam=eq.false&has_battle=eq.true` +
      `&level=lte.${level}&order=xp.desc,level.desc&limit=5`
  );
  return rows || [];
}

// ============================================================================
// Mode Status & Daftar Misi (`--status`, `--list-missions`)
// ============================================================================
async function showStatus(client) {
  logInfo('Mengambil status akun, ekonomi misi & kebijakan engine dari server...');
  const [avatar, cfg, progress] = await Promise.all([
    client.fetchAvatar().catch((e) => ({ error: e.message })),
    client.gameConfig(['mission_economy', 'battle_engine_policy', 'battle_xp_event']).catch((e) => ({ error: e.message })),
    client.rpc('mission_board_progress_state').catch((e) => ({ error: e.message })),
  ]);

  console.log('\n=== Karakter ===');
  if (avatar && !avatar.error) {
    logInfo(`Nama / Rank / Level : ${avatar.name} / ${avatar.rank} / Lv ${avatar.level}`);
    logInfo(`Total XP            : ${Number(avatar.xp).toLocaleString('id-ID')}`);
  } else {
    console.log(avatar);
  }

  const econ = cfg?.mission_economy;
  const daily = loadDailyWins();
  console.log('\n=== Ekonomi Misi (game_config.mission_economy) ===');
  if (econ) {
    logInfo(`Daily Double        : ${econ.daily_double?.wins ?? '-'} kemenangan pertama/hari x${econ.daily_double?.mult ?? '-'}`);
    logInfo(
      `Gold Soft-Cap       : setelah ${econ.mission_gold_soft?.full_wins ?? '-'} menang/hari, gold jadi ` +
        `${econ.mission_gold_soft?.soft_pct ?? '-'}%`
    );
  }
  logInfo(`Menang hari ini (bot, UTC ${daily.date}) : ${daily.wins} | XP: +${daily.xp.toLocaleString('id-ID')}`);
  const xpEvent = cfg?.battle_xp_event;
  if (xpEvent?.enabled && (!xpEvent.ends_at || new Date(xpEvent.ends_at) > new Date())) {
    logInfo(`Event XP aktif      : x${xpEvent.multiplier} (berakhir ${xpEvent.ends_at || '-'})`);
  }

  const policy = cfg?.battle_engine_policy;
  if (policy) {
    const accepted = new Set([policy.active, ...(policy.accepted || [])]);
    const ok = supportedBattleEngines.filter((v) => accepted.has(v));
    console.log('\n=== Kebijakan Engine Pertarungan ===');
    logInfo(`Server active/accepted : ${policy.active} / ${(policy.accepted || []).join(', ')}`);
    logInfo(`Engine lokal bot       : ${supportedBattleEngines.join(', ')} -> ${ok.length ? 'KOMPATIBEL' : 'TIDAK KOMPATIBEL'}`);
  }

  if (progress && Array.isArray(progress.clears)) {
    console.log('\n=== Progress Papan Misi ===');
    logInfo(`Misi yang sudah di-clear : ${progress.clears.length}`);
  }
}

async function listMissions(client) {
  const avatar = await client.fetchAvatar();
  const level = avatar?.level ?? 1;
  logInfo(`Misi dengan XP tertinggi untuk Lv ${level}:`);
  const rows = await client.rest(
    `mission_defs?select=id,name,grade,level,xp,gold&is_exam=eq.false&has_battle=eq.true` +
      `&level=lte.${level}&order=xp.desc,level.desc&limit=15`
  );
  console.table(rows);
}

// ============================================================================
// Mode Login SSO Google (`--login-google`) â€” Meniru func[10494] & func[25111]
// ============================================================================
function parseAuthCallbackUrl(rawInput) {
  const trimmed = String(rawInput || '').trim();
  const out = {};

  const grab = (segment) => {
    if (!segment) return;
    for (const pair of segment.split('&')) {
      if (!pair) continue;
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const k = decodeURIComponent(pair.slice(0, idx).trim());
      const v = decodeURIComponent(pair.slice(idx + 1).trim());
      if (k && v) out[k] = v;
    }
  };

  const [beforeHash, hashPart] = trimmed.split('#');
  grab(hashPart);
  if (beforeHash && beforeHash.includes('?')) {
    grab(beforeHash.split('?')[1]);
  }
  // Jika user langsung menempelkan isi fragment tanpa URL penuh (mis. access_token=...&refresh_token=...)
  if (!out.access_token && trimmed.includes('access_token=')) {
    grab(trimmed);
  }
  return out;
}

function openBrowserUrl(url) {
  const platform = process.platform;
  if (platform === 'win32') {
    exec(`start "" "${url}"`);
  } else if (platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

async function runGoogleSsoLogin(client, directCallbackUrl = null) {
  const oauthUrl = `${client.supabaseUrl}/auth/v1/authorize?provider=google&prompt=select_account`;

  logInfo('============================================================');
  logInfo('LOGIN SSO GOOGLE â€” NINJA HORIZON HEADLESS BOT');
  logInfo('============================================================');

  let callbackInput = directCallbackUrl;

  if (!callbackInput) {
    console.log('\nLangkah Login SSO Google (Tanpa Password di config.json):');
    console.log('1. Browser Anda akan terbuka otomatis ke halaman Login Google resmi Ninja Horizon.');
    console.log('   Jika tidak terbuka otomatis, buka link berikut di browser Anda:\n');
    console.log(`   ${oauthUrl}\n`);
    console.log('2. Pilih akun Google yang terhubung dengan karakter Ninja Horizon Anda.');
    console.log(
      '3. Setelah login selesai, browser akan diarahkan ke halaman "https://ninjahorizon.com/#access_token=..."'
    );
    console.log(
      '4. Salin (Copy) SELURUH URL dari Address Bar browser tersebut, lalu tempel (Paste) di bawah ini.\n'
    );

    openBrowserUrl(oauthUrl);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    callbackInput = await new Promise((resolve) => {
      rl.question('Tempel URL hasil redirect (https://ninjahorizon.com/#access_token=...): ', (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  const parsed = parseAuthCallbackUrl(callbackInput);
  if (parsed.error || parsed.error_description) {
    throw new Error(`Login OAuth gagal: ${parsed.error_description || parsed.error}`);
  }
  if (!parsed.access_token || !parsed.refresh_token) {
    throw new Error(
      'Tidak menemukan access_token dan refresh_token pada URL yang ditempelkan. ' +
        'Pastikan Anda menyalin seluruh URL dari Address Bar setelah memilih akun Google (yang mengandung #access_token=...&refresh_token=...).'
    );
  }

  const jwtPayload = decodeJwtPayload(parsed.access_token);
  const expiresAt =
    Number(parsed.expires_at) ||
    jwtPayload?.exp ||
    Math.floor(Date.now() / 1000) + Number(parsed.expires_in || 3600);

  client.saveSession({
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt,
    user: jwtPayload
      ? {
          id: jwtPayload.sub,
          email: jwtPayload.email || null,
          provider: jwtPayload.app_metadata?.provider || 'google',
        }
      : null,
  });

  logSuccess(
    `Sesi SSO Google berhasil disimpan ke bot/session.json! ` +
      `(User: ${jwtPayload?.email || jwtPayload?.sub || 'Terautentikasi'})`
  );
  logInfo('Menguji sesi dengan memperbarui token & mengambil status misi...');
  await client.loginWithRefreshToken(client.session.refreshToken);
  await showStatus(client);
}

// ============================================================================
// Loop Utama Bot AFK EXP
// ============================================================================
async function runAfkBot(client, config, cliOptions) {
  let missionId = cliOptions.missionId || config.missionId || 'auto';
  if (missionId === 'msn_1') missionId = 'auto'; // Fallback aman dari template konfigurasi lama
  const minDelaySec = Number(config.minDelaySeconds ?? 8);
  const maxDelaySec = Number(config.maxDelaySeconds ?? 15);
  const cooldownMinSec = Number(config.betweenMissionMinSeconds ?? 4);
  const cooldownMaxSec = Number(config.betweenMissionMaxSeconds ?? 9);
  const stopOnSoftCap = config.stopOnSoftCap !== false;
  const maxRuns = Number(cliOptions.maxRuns ?? config.maxRuns ?? 0); // 0 = tanpa batas
  const autoPlan = config.autoPlan !== false;

  // Pre-load semua mesin Oracle di awal agar run pertama langsung cepat
  for (const ver of supportedBattleEngines) {
    engineForBattle(ver);
  }

  // 1) Kompatibilitas engine dengan server
  const pol = await checkEnginePolicy(client);
  if (pol) logInfo(`Engine kompatibel dengan server: ${pol.usable.join(', ')} (server active: ${pol.policy.active})`);

  // 2) Data avatar, auto-plan & pemilihan misi otomatis
  const avatar = await client.fetchAvatar().catch(() => null);
  let lastXp = avatar ? Number(avatar.xp) : null;
  const tacticalPlan = autoPlan && avatar?.auto_plan && typeof avatar.auto_plan === 'object' ? avatar.auto_plan : null;
  if (String(missionId).toLowerCase() === 'auto') {
    const best = await pickBestMission(client, avatar?.level ?? 1);
    if (!best.length) throw new Error('Tidak menemukan misi yang cocok untuk level karakter.');
    missionId = best[0].id;
    logInfo(`Mode misi "auto": memilih ${best[0].id} "${best[0].name}" (Lv ${best[0].level}, ${best[0].xp.toLocaleString('id-ID')} XP)`);
  }

  // 3) Batas harian (gold soft-cap dari game_config.mission_economy)
  let softCapLimit = Number(config.maxWinsPerDay || 0);
  try {
    const { mission_economy: econ } = await client.gameConfig(['mission_economy']);
    if (!softCapLimit) softCapLimit = Number(econ?.mission_gold_soft?.full_wins || 15);
  } catch {
    if (!softCapLimit) softCapLimit = 15;
  }
  const daily = loadDailyWins();

  logInfo('============================================================');
  logInfo('NINJA HORIZON â€” HEADLESS AFK EXP BOT (METODE A)');
  logInfo('============================================================');
  if (avatar) logInfo(`Karakter           : ${avatar.name} (Lv ${avatar.level}, ${avatar.rank})`);
  logInfo(`Target Misi        : ${missionId}`);
  logInfo(`Mode Taktik AI     : ${tacticalPlan ? 'suggestPlannedAction (auto_plan akun)' : 'suggestPlayerAction (AI bawaan engine)'}`);
  logInfo(`Jeda Pertarungan   : ${minDelaySec}s - ${maxDelaySec}s (+ waktu per giliran)`);
  logInfo(`Batas Harian       : ${stopOnSoftCap ? `${softCapLimit} menang/hari (hari ini: ${daily.wins})` : 'Tidak dibatasi'}`);
  logInfo(`Batas Jumlah Run   : ${maxRuns > 0 ? `${maxRuns} kali` : 'Tak terbatas (AFK)'}`);
  logInfo('------------------------------------------------------------');

  if (stopOnSoftCap && daily.wins >= softCapLimit) {
    logWarn(`Batas harian sudah tercapai (${daily.wins}/${softCapLimit}). Bot berhenti (stopOnSoftCap=true).`);
    return;
  }
  let winsToday = daily.wins;

  let totalRuns = 0;
  let totalWins = 0;
  let totalXpGained = 0;

  while (maxRuns <= 0 || totalRuns < maxRuns) {
    if (stopOnSoftCap && winsToday >= softCapLimit) {
      logSuccess(
        `Target kuota harian tercapai (${winsToday}/${softCapLimit} kemenangan). ` +
          `Total EXP diperoleh sesi ini: +${totalXpGained} EXP. Bot berhenti dengan aman.`
      );
      break;
    }

    totalRuns++;
    logInfo(`--- [Run #${totalRuns}] Memulai misi "${missionId}" ---`);

    try {
      // 1. Mulai misi via RPC mission_start
      const sessionResp = await client.startMission(missionId);
      const session = sessionResp?.session || sessionResp;
      const sessionId = session?.id || session?.session_id || session?.sessionId;

      if (!sessionId) {
        throw new Error(`Tidak menemukan session.id dari respons mission_start: ${JSON.stringify(sessionResp)}`);
      }

      // 2. Ambil payload build pertarungan (dari session.start jika sudah disertakan, atau panggil resolve-battle mode:"start")
      let build = session?.start || null;
      if (!build || !Array.isArray(build.units)) {
        logInfo(`[Run #${totalRuns}] Meminta inisialisasi pertarungan (session: ${sessionId})...`);
        const startResp = await client.startBattle(sessionId);
        build = startResp?.build || startResp?.start || startResp;
      }

      if (!build || !Array.isArray(build.units)) {
        throw new Error(`Payload build pertarungan tidak valid: ${JSON.stringify(build)}`);
      }

      const engineVer = build.engineVersion || LATEST_ENGINE_VERSION;
      logInfo(
        `[Run #${totalRuns}] Battle dimulai! Engine: ${engineVer} | Seed: ${build.seed} | ` +
          `Units: ${build.units.length} | Waves: ${Array.isArray(build.waves) ? build.waves.length : 0}`
      );

      // 3. Jalankan simulasi deterministik di mesin Oracle
      const simStart = Date.now();
      const { state, actions, client: clientDiag } = simulateBattle(build, {
        autoPlan: tacticalPlan,
      });
      const simDurationMs = Date.now() - simStart;

      logInfo(
        `[Run #${totalRuns}] Simulasi selesai dalam ${simDurationMs}ms -> ` +
          `Status: ${clientDiag.status.toUpperCase()} | Round: ${clientDiag.round} | ` +
          `Turns: ${clientDiag.turns} | Actions: ${actions.length} | Checksum: ${clientDiag.checksum}`
      );

      // 4. Jeda waktu manusiawi proporsional dengan animasi per giliran (~650ms - 950ms/turn) + random jitter
      // Server Edge Function memvalidasi pacing pertarungan (terlalu cepat <500ms/turn akan dianulir menjadi lose)
      const perTurnMs = randomInt(700, 950);
      const turnDelayMs = clientDiag.turns * perTurnMs;
      const baseDelayMs = randomInt(minDelaySec * 1000, maxDelaySec * 1000);
      const totalWaitMs = Math.max(baseDelayMs, turnDelayMs);
      logInfo(
        `[Run #${totalRuns}] Menunggu pacing realistis ${(totalWaitMs / 1000).toFixed(1)} detik ` +
          `(${clientDiag.turns} turns @ ~${perTurnMs}ms/turn) sebelum mengirim penyelesaian battle...`
      );
      await sleep(totalWaitMs);

      // 5. Kirim hasil pertarungan ke /functions/v1/resolve-battle (mode: "finish")
      const receipt = await client.finishBattle(sessionId, actions, clientDiag);
      const verdict = receipt?.verdict || clientDiag.status;
      const grant = receipt?.grant || {};
      let xpAwarded = Number(
        grant.xp_granted ??
        grant.xpAwarded ??
        grant.xp_awarded ??
        grant.xpGained ??
        0
      );
      if (!xpAwarded && lastXp != null && Number.isFinite(Number(grant.xp))) {
        xpAwarded = Math.max(0, Number(grant.xp) - lastXp);
      }
      if (Number.isFinite(Number(grant.xp))) lastXp = Number(grant.xp);
      const currentXp = grant.xp ?? (lastXp != null ? lastXp + xpAwarded : '-');
      const currentLevel = grant.level ?? '-';
      const leveledUp = Boolean(grant.leveledUp ?? grant.leveled_up);
      const currentGold = grant.wallet?.gold != null ? grant.wallet.gold.toLocaleString('id-ID') : null;

      if (verdict === 'win') {
        totalWins++;
        winsToday++;
        if (xpAwarded > 0) {
          totalXpGained += xpAwarded;
        }
        daily.wins = winsToday;
        daily.xp += xpAwarded;
        saveDailyWins(daily);
        logSuccess(
          `[Run #${totalRuns}] MENANG! +${xpAwarded.toLocaleString('id-ID')} XP` +
            (currentGold ? ` | Gold: ${currentGold}` : '') +
            ` | Level: ${currentLevel}${leveledUp ? ' (LEVEL UP!)' : ''}` +
            ` | Kemenangan Hari Ini: ${winsToday}/${softCapLimit}`
        );
      } else {
        logWarn(
          `[Run #${totalRuns}] Pertarungan berakhir dengan verdict: ${verdict}. ` +
            `Detail: ${JSON.stringify(receipt)}`
        );
      }
    } catch (err) {
      logError(`[Run #${totalRuns}] Terjadi kesalahan: ${err.message}`);
      if (err.payload) {
        logError(`Detail respons server: ${JSON.stringify(err.payload)}`);
      }
      // Jika error autentikasi atau server sibuk, beri jeda ekstra sebelum mencoba lagi
      logInfo('Menunggu 15 detik sebelum mencoba ulang...');
      await sleep(15_000);
    }

    // Jeda antar misi jika masih berlanjut
    if ((maxRuns <= 0 || totalRuns < maxRuns) && !(stopOnSoftCap && winsToday >= softCapLimit)) {
      const pauseSec = randomInt(cooldownMinSec, cooldownMaxSec);
      logInfo(`Istirahat ${pauseSec} detik sebelum misi berikutnya...`);
      await sleep(pauseSec * 1000);
    }
  }
}

// ============================================================================
// CLI Entrypoint
// ============================================================================
function parseArgs(argv) {
  const opts = {
    testSim: false,
    status: false,
    listMissions: false,
    loginGoogle: false,
    callbackUrl: null,
    missionId: null,
    maxRuns: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--test-sim' || arg === '--test') {
      opts.testSim = true;
    } else if (arg === '--status') {
      opts.status = true;
    } else if (arg === '--list-missions') {
      opts.listMissions = true;
    } else if (arg === '--login-google' || arg === '--login') {
      opts.loginGoogle = true;
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        opts.callbackUrl = argv[++i];
      }
    } else if (arg === '--mission' && argv[i + 1]) {
      opts.missionId = argv[++i];
    } else if (arg === '--runs' && argv[i + 1]) {
      opts.maxRuns = Number(argv[++i]);
    }
  }
  return opts;
}

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      throw new Error(`Format bot/config.json tidak valid: ${err.message}`);
    }
  }
  const examplePath = path.join(__dirname, 'config.example.json');
  if (fs.existsSync(examplePath)) {
    return JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  }
  return {};
}

async function main() {
  const cliOptions = parseArgs(process.argv.slice(2));

  if (cliOptions.testSim) {
    runOfflineSimulationTest();
    return;
  }

  const config = loadConfig();
  const client = new NinjaHorizonClient(config);

  if (cliOptions.loginGoogle) {
    await runGoogleSsoLogin(client, cliOptions.callbackUrl);
    return;
  }

  if (cliOptions.status) {
    await showStatus(client);
    return;
  }

  if (cliOptions.listMissions) {
    await listMissions(client);
    return;
  }

  await runAfkBot(client, config, cliOptions);
}

main().catch((err) => {
  logError(err.message || String(err));
  process.exit(1);
});

