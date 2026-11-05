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
const crypto = require('crypto');
const { exec } = require('child_process');

function generateRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'req_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
}
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
      let rawMsg =
        (data && (data.message || data.error || data.details || data.hint)) ||
        `HTTP ${res.status}`;
      
      const ptLockMatch = String(rawMsg).match(/^PTLOCK:([^:]+):(\d+)/);
      if (ptLockMatch) {
        rawMsg = `Fitur '${ptLockMatch[1]}' terkunci oleh server (membutuhkan minimal Level ${ptLockMatch[2]})`;
      } else if (
        String(rawMsg).includes('player_event_stamina_user_id_fkey') ||
        rawMsg === 'no avatar' ||
        rawMsg === 'player avatar is missing' ||
        String(data?.details || '').includes('is not present in table "player_avatar"')
      ) {
        rawMsg = `Karakter belum dibuat di akun ini! Silakan buat karakter (Avatar) di dalam game terlebih dahulu.`;
      }

      const err = new Error(`RPC ${fnName} gagal: ${rawMsg}`);
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

  // ==========================================================================
  // World Boss RPCs (func[9182] - func[9185])
  // ==========================================================================
  async fetchWorldBossState() {
    return await this.rpc('world_boss_state');
  }

  async startWorldBoss(weekId, requestId = generateRequestId()) {
    return await this.rpc('world_boss_start', {
      p_week_id: weekId,
      p_request_id: requestId,
    });
  }

  async refillWorldBoss(requestId = generateRequestId()) {
    return await this.rpc('world_boss_refill', {
      p_request_id: requestId,
    });
  }

  async claimWorldBoss(weekId, milestone) {
    return await this.rpc('world_boss_claim', {
      p_week_id: weekId,
      p_milestone: milestone,
    });
  }

  async fetchWorldBossRankings(weekId, page = 1) {
    return await this.rpc('world_boss_rankings', {
      p_week_id: weekId,
      p_page: page,
    });
  }

  // ==========================================================================
  // Event Boss & Hunting House RPCs (func[22684], func[22877], func[29089])
  // ==========================================================================
  async fetchEventsSurfaceState() {
    return await this.rpc('events_surface_state');
  }

  async fetchEventStamina() {
    return await this.rpc('event_stamina');
  }

  async refillEventStamina(requestId = generateRequestId()) {
    return await this.rpc('event_refill_stamina', {
      p_request_id: requestId,
    });
  }

  async fetchHuntingCatalog() {
    return await this.rpc('hunting_catalog_state');
  }

  async fetchHuntingPlayerState() {
    return await this.rpc('hunting_player_state');
  }

  async startHunt(roomId) {
    return await this.rpc('hunt_start', {
      p_room: roomId,
    });
  }

  async fetchTowerState() {
    return await this.rpc('tower_state');
  }

  async startTower(weekId, floor) {
    return await this.rpc('tower_start', {
      p_week_id: weekId,
      p_floor: floor,
    });
  }

  async sweepTower(weekId) {
    return await this.rpc('tower_sweep', {
      p_week_id: weekId,
    });
  }

  async fetchTowerRankings(weekId, page = 1, pageSize = 20) {
    return await this.rpc('tower_rankings', {
      p_week_id: weekId,
      p_page: page,
      p_page_size: pageSize,
    });
  }

  async fetchExamPlayerState(rank = 'genin') {
    return await this.rpc('exam_player_state', {
      p_rank: rank,
    });
  }

  async fetchExamQuiz(missionId) {
    return await this.rpc('exam_quiz_get', {
      p_mission: missionId,
    });
  }

  async submitExamQuiz(missionId, answers) {
    return await this.rpc('exam_quiz_submit', {
      p_mission: missionId,
      p_answers: answers,
    });
  }

  async startExamMinigame(missionId) {
    return await this.rpc('exam_minigame_start', {
      p_mission: missionId,
    });
  }

  async clearExamMinigame(missionId) {
    return await this.rpc('exam_minigame_clear', {
      p_mission: missionId,
    });
  }

  async chooseSpecialClassJutsu(skillId) {
    return await this.rpc('exam_special_class_choose', {
      p_skill: skillId,
    });
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
  } catch { }
  return { date: today, wins: 0, xp: 0 };
}

function saveDailyWins(daily) {
  try {
    fs.writeFileSync(DAILY_PATH, JSON.stringify(daily, null, 2), 'utf8');
  } catch { }
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

// ============================================================================
// Eksekutor Sesi Pertarungan Bersama (Misi, World Boss, Event Boss, Hunting)
// ============================================================================
async function executeBattleSession(client, sessionResp, tacticalPlan, options = {}) {
  const { minDelaySec = 8, maxDelaySec = 15, label = 'Battle' } = options;

  const session = sessionResp?.session || sessionResp;
  const sessionId = session?.id || session?.session_id || session?.sessionId;
  if (!sessionId) {
    throw new Error(`Tidak menemukan sessionId dari respons pertarungan: ${JSON.stringify(sessionResp)}`);
  }

  let build = session?.start || null;
  if (!build || !Array.isArray(build.units)) {
    logInfo(`[${label}] Meminta inisialisasi pertarungan (session: ${sessionId})...`);
    const startResp = await client.startBattle(sessionId);
    build = startResp?.build || startResp?.start || startResp;
  }

  if (!build || !Array.isArray(build.units)) {
    throw new Error(`Payload build pertarungan tidak valid: ${JSON.stringify(build)}`);
  }

  const engineVer = build.engineVersion || LATEST_ENGINE_VERSION;
  logInfo(
    `[${label}] Battle dimulai! Engine: ${engineVer} | Seed: ${build.seed} | ` +
    `Units: ${build.units.length} | Waves: ${Array.isArray(build.waves) ? build.waves.length : 0}`
  );

  const simStart = Date.now();
  const { state, actions, client: clientDiag } = simulateBattle(build, {
    autoPlan: tacticalPlan,
  });
  const simDurationMs = Date.now() - simStart;

  logInfo(
    `[${label}] Simulasi selesai dalam ${simDurationMs}ms -> ` +
    `Status: ${clientDiag.status.toUpperCase()} | Round: ${clientDiag.round} | ` +
    `Turns: ${clientDiag.turns} | Actions: ${actions.length} | Checksum: ${clientDiag.checksum}`
  );

  const perTurnMs = randomInt(700, 950);
  const turnDelayMs = clientDiag.turns * perTurnMs;
  const baseDelayMs = randomInt(minDelaySec * 1000, maxDelaySec * 1000);
  const totalWaitMs = Math.max(baseDelayMs, turnDelayMs);
  logInfo(
    `[${label}] Menunggu pacing realistis ${(totalWaitMs / 1000).toFixed(1)} detik ` +
    `(${clientDiag.turns} turns @ ~${perTurnMs}ms/turn) sebelum mengirim penyelesaian battle...`
  );
  await sleep(totalWaitMs);

  const receipt = await client.finishBattle(sessionId, actions, clientDiag);
  const verdict = receipt?.verdict || clientDiag.status;
  const grant = receipt?.grant || {};

  return { sessionId, build, receipt, verdict, grant, clientDiag, actions };
}

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
    logWarn('Belum ada karakter (Avatar) yang dibuat pada akun ini!');
    logInfo('Silakan buka aplikasi Ninja Horizon di HP dan buat karakter ninja Anda terlebih dahulu,');
    logInfo('atau login dengan akun Google yang memiliki karakter via: node bot.js --login-google');
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

async function showWorldBossStatus(client) {
  logInfo('Mengambil status World Boss & leaderboard dari server...');
  try {
    const avatar = await client.fetchAvatar().catch(() => null);
    if (!avatar) {
      logWarn('Belum ada karakter (Avatar) yang dibuat pada akun ini!');
      logInfo('World Boss memerlukan akun dengan karakter yang sudah terdaftar di Ninja Horizon.');
      return;
    }
    const wbState = await client.fetchWorldBossState();
    console.log('\n=== World Boss State ===');
    logInfo(`Available / Active : ${wbState?.available ? 'YA (AKTIF)' : 'TIDAK (TUTUP)'}`);
    if (wbState?.week_id) logInfo(`Week ID            : ${wbState.week_id}`);
    if (wbState?.boss) {
      logInfo(`Boss Name / Level  : ${wbState.boss.name || wbState.boss.id} (Lv ${wbState.boss.level || '-'})`);
      if (wbState.boss.hp) logInfo(`Boss HP            : ${Number(wbState.boss.hp).toLocaleString('id-ID')}`);
    }
    if (wbState?.player) {
      const p = wbState.player;
      logInfo(`Attempts Left      : ${p.attempts ?? p.tickets ?? p.fights_left ?? '-'}`);
      logInfo(`Total Damage Dealt : ${Number(p.total_damage || p.damage || 0).toLocaleString('id-ID')}`);
      logInfo(`Score / Rank       : ${p.score || '-'} / #${p.rank || '-'}`);
    }
    if (Array.isArray(wbState?.milestones)) {
      console.log('\n=== Milestones Hadiah Damage ===');
      for (const m of wbState.milestones) {
        const claimed = m.claimed ? '[SUDAH KLAIM]' : (m.achieved || m.completed ? '[SIAP KLAIM]' : '[BELUM]');
        logInfo(`- Milestone ${m.id || m.target_damage}: Target ${Number(m.damage || m.score || m.target_damage).toLocaleString('id-ID')} -> ${claimed}`);
      }
    }
    if (wbState?.week_id) {
      const ranks = await client.fetchWorldBossRankings(wbState.week_id, 1).catch(() => null);
      const rows = ranks?.leaderboard || ranks?.rankings || (Array.isArray(ranks) ? ranks : []);
      if (Array.isArray(rows) && rows.length > 0) {
        console.log('\n=== Top 5 Leaderboard World Boss ===');
        console.table(rows.slice(0, 5));
      }
    }
  } catch (err) {
    logError(`Gagal mengambil status World Boss: ${err.message}`);
  }
}

async function showHuntingStatus(client) {
  logInfo('Mengambil status Hunting House, Eudemon Garden, & Kari Badge dari server...');
  try {
    const avatar = await client.fetchAvatar().catch(() => null);
    const [huntState, huntCatalog, econCfg] = await Promise.all([
      client.fetchHuntingPlayerState().catch((e) => ({ error: e.message })),
      client.fetchHuntingCatalog().catch((e) => ({ error: e.message })),
      client.gameConfig(['kari_badge_economy']).catch((e) => ({ error: e.message })),
    ]);

    const charLevel = Number(avatar?.level || 1);
    console.log('\n=== Status Kari Badge (Hunting House) ===');
    const kari = huntState?.kari;
    const econ = econCfg?.kari_badge_economy;
    if (kari && !huntState.error) {
      logInfo(`Saldo Kari Badge  : ${kari.balance ?? 0}`);
      logInfo(`Biaya Masuk / Run : ${kari.entry_cost ?? econ?.entry_cost ?? 5} Badges`);
      logInfo(`Hadiah Menang     : ${kari.win_return ?? econ?.win_return ?? 1} Badge kembali`);
    } else {
      logInfo(`Kari Badge Economy: Masuk ${econ?.entry_cost ?? 5} Badges, Gratis harian ${econ?.daily_free ?? 10} Badges`);
      if (huntState?.error) logWarn(`Info pemain: ${huntState.error}`);
    }

    const defs = huntCatalog?.definitions || [];
    const huntRooms = defs.filter((d) => d.venue === 'hunting').sort((a, b) => (a.encounter_level || 0) - (b.encounter_level || 0));
    const eudemonRooms = defs.filter((d) => d.venue === 'eudemon').sort((a, b) => (a.encounter_level || 0) - (b.encounter_level || 0));

    console.log('\n=== Room Hunting House (Karakter Level ' + charLevel + ') ===');
    console.table(
      huntRooms.map((r) => ({
        RoomID: r.id,
        Name: r.name,
        LevelReq: r.encounter_level,
        Status: charLevel >= Number(r.encounter_level) ? 'TERBUKA' : 'TERKUNCI',
        XP: Number(r.xp || 0).toLocaleString('id-ID'),
        Gold: Number(r.gold || 0).toLocaleString('id-ID'),
      }))
    );

    console.log('\n=== Room Eudemon Garden (Karakter Level ' + charLevel + ') ===');
    console.table(
      eudemonRooms.map((r) => ({
        RoomID: r.id,
        Name: r.name,
        LevelReq: r.encounter_level,
        Status: charLevel >= Number(r.encounter_level) ? 'TERBUKA' : 'TERKUNCI',
        XP: Number(r.xp || 0).toLocaleString('id-ID'),
        Gold: Number(r.gold || 0).toLocaleString('id-ID'),
      }))
    );
  } catch (err) {
    logError(`Gagal mengambil status hunting: ${err.message}`);
  }
}

async function listBosses(client) {
  logInfo('Mengambil katalog bos Event & Hunting House dari server...');
  try {
    const [eventsState, eventStam, huntCatalog] = await Promise.all([
      client.fetchEventsSurfaceState().catch((e) => ({ error: e.message })),
      client.fetchEventStamina().catch((e) => ({ error: e.message })),
      client.fetchHuntingCatalog().catch((e) => ({ error: e.message })),
    ]);

    const definitions = huntCatalog?.definitions || [];
    const defMap = new Map(definitions.map((d) => [d.id, d]));

    console.log('\n=== Event Bosses (Aktif) ===');
    if (eventStam && !eventStam.error) {
      logInfo(`Event Stamina: ${eventStam.stamina ?? eventStam.current ?? '-'}/${eventStam.max ?? '-'}`);
    }
    const rawBosses = eventsState?.bosses || [];
    const eventBosses = rawBosses.filter((b) => {
      const id = b.id || b.room_id || '';
      return !id.startsWith('world_boss_') && b.event_id !== 'world_boss_vadar';
    });

    if (Array.isArray(eventBosses) && eventBosses.length > 0) {
      console.table(
        eventBosses.map((b) => {
          const def = defMap.get(b.id) || {};
          return {
            RoomID: b.id || b.room_id,
            Name: def.name || b.name || b.id,
            Event: b.event_id || '-',
            LevelReq: def.encounter_level || b.level || 10,
            Drops: def.drops?.materials ? `${def.drops.materials.length} material types` : 'Event Materials',
          };
        })
      );
    } else {
      logInfo('Tidak ada Event Boss khusus (selain World Boss) yang aktif saat ini.');
    }

    console.log('\n=== Hunting House Bosses (Permanen — Syarat Lv 10+) ===');
    const huntRooms = definitions.filter((r) => r.venue === 'hunting');
    if (huntRooms.length > 0) {
      console.table(
        huntRooms.map((r) => ({
          RoomID: r.id,
          Name: r.name || r.id,
          LevelReq: r.encounter_level ?? r.level ?? '-',
          XP: r.xp != null ? Number(r.xp).toLocaleString('id-ID') : '-',
          Gold: r.gold != null ? Number(r.gold).toLocaleString('id-ID') : '-',
        }))
      );
    } else {
      logInfo('Katalog Hunting House tidak mengembalikan daftar room.');
    }

    const eudemonRooms = definitions.filter((r) => r.venue === 'eudemon');
    if (eudemonRooms.length > 0) {
      console.log('\n=== Eudemon Garden Bosses (Syarat Lv 10+) ===');
      console.table(
        eudemonRooms.slice(0, 5).map((r) => ({
          RoomID: r.id,
          Name: r.name || r.id,
          LevelReq: r.encounter_level ?? r.level ?? '-',
          XP: r.xp != null ? Number(r.xp).toLocaleString('id-ID') : '-',
        }))
      );
    }
  } catch (err) {
    logError(`Gagal mengambil daftar bos: ${err.message}`);
  }
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
  let avatar = await client.fetchAvatar().catch(() => null);
  let lastXp = avatar ? Number(avatar.xp) : null;

  // Auto Exam Check saat memulai bot jika level sudah mencapai cap (20, 40, 60, 80)
  const shouldAutoExam = config.autoExam !== false || cliOptions.autoExam;
  if (shouldAutoExam && avatar && [20, 40, 60, 80].includes(avatar.level)) {
    logInfo(`[Auto Exam] Karakter berada di Level ${avatar.level}. Memeriksa status kelulusan ujian promosi...`);
    const examPassed = await runExamBot(client, config, {
      silentNoExam: true,
      track: cliOptions.track || config.examTrack,
    });
    if (examPassed) {
      avatar = (await client.fetchAvatar().catch(() => null)) || avatar;
      lastXp = avatar ? Number(avatar.xp) : lastXp;
    }
  }

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

        // Auto Exam Trigger saat mencapai level 20, 40, 60, 80 atau EXP tertahan (level cap)
        const numericLvl = Number(currentLevel);
        const hitCapLevel = [20, 40, 60, 80].includes(numericLvl);
        if (shouldAutoExam && hitCapLevel && (leveledUp || xpAwarded === 0)) {
          logInfo(`[Auto Exam] Terdeteksi Level ${numericLvl} (level cap). Menjalankan ujian promosi ninja otomatis...`);
          const examSuccess = await runExamBot(client, config, {
            silentNoExam: true,
            track: cliOptions.track || config.examTrack,
          });
          if (examSuccess) {
            logSuccess(`[Auto Exam] Ujian promosi selesai! Memperbarui data karakter & misi...`);
            const freshAvatar = await client.fetchAvatar().catch(() => null);
            if (freshAvatar) {
              avatar = freshAvatar;
              if (String(cliOptions.missionId || config.missionId || 'auto').toLowerCase() === 'auto') {
                const best = await pickBestMission(client, freshAvatar.level);
                if (best.length) {
                  missionId = best[0].id;
                  logInfo(`[Auto Exam] Target misi otomatis dialihkan ke ${best[0].id} "${best[0].name}" (Lv ${best[0].level})`);
                }
              }
            }
          }
        }
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
// Loop Farming World Boss
// ============================================================================
async function runWorldBossBot(client, config, cliOptions) {
  const minDelaySec = Number(config.minDelaySeconds ?? 8);
  const maxDelaySec = Number(config.maxDelaySeconds ?? 15);
  const cooldownMinSec = Number(config.betweenMissionMinSeconds ?? 4);
  const cooldownMaxSec = Number(config.betweenMissionMaxSeconds ?? 9);
  const maxRuns = Number(cliOptions.maxRuns ?? config.maxRuns ?? 0);
  const autoPlan = config.autoPlan !== false;
  const autoClaim = cliOptions.autoClaim || config.worldBoss?.autoClaimMilestones !== false;
  const autoRefill = cliOptions.autoRefill || config.worldBoss?.autoRefill === true;

  for (const ver of supportedBattleEngines) {
    engineForBattle(ver);
  }

  const pol = await checkEnginePolicy(client);
  if (pol) logInfo(`Engine kompatibel: ${pol.usable.join(', ')} (server active: ${pol.policy.active})`);

  const avatar = await client.fetchAvatar().catch(() => null);
  if (!avatar) {
    logError('============================================================');
    logError('KESALAHAN: Karakter (Avatar) tidak ditemukan pada akun ini!');
    logError('Pastikan Anda telah membuat karakter di dalam aplikasi Ninja Horizon,');
    logError('atau pastikan Anda login dengan akun Google yang benar via:');
    logError('  node bot.js --login-google');
    logError('============================================================');
    return;
  }

  const tacticalPlan = autoPlan && avatar?.auto_plan && typeof avatar.auto_plan === 'object' ? avatar.auto_plan : null;

  logInfo('============================================================');
  logInfo('NINJA HORIZON — FARMING WORLD BOSS (HEADLESS BOT)');
  logInfo('============================================================');
  logInfo(`Karakter           : ${avatar.name} (Lv ${avatar.level}, ${avatar.rank})`);

  const wbState = await client.fetchWorldBossState();
  if (!wbState || !wbState.available) {
    logWarn('World Boss saat ini sedang TIDAK TERSEDIA atau ditutup oleh server.');
    return;
  }

  const weekId = wbState.week_id;
  logInfo(`World Boss Aktif   : Week ID ${weekId}`);
  logInfo(`Auto Claim Hadiah  : ${autoClaim ? 'AKTIF' : 'NON-AKTIF'}`);
  logInfo(`Auto Refill Tiket  : ${autoRefill ? 'AKTIF' : 'NON-AKTIF'}`);
  logInfo('------------------------------------------------------------');

  let totalRuns = 0;
  let totalDamageDealt = 0;

  while (maxRuns <= 0 || totalRuns < maxRuns) {
    totalRuns++;
    const runLabel = `WorldBoss #${totalRuns}`;
    logInfo(`--- [${runLabel}] Menantang World Boss (Week: ${weekId})... ---`);

    try {
      let startResp;
      try {
        startResp = await client.startWorldBoss(weekId, generateRequestId());
      } catch (err) {
        const isOutOfAttempts = err.message?.toLowerCase().includes('attempt') ||
          err.message?.toLowerCase().includes('ticket') ||
          err.message?.toLowerCase().includes('limit');
        if (isOutOfAttempts && autoRefill) {
          logInfo(`[${runLabel}] Tiket habis, mencoba refill tiket via world_boss_refill...`);
          await client.refillWorldBoss(generateRequestId());
          logSuccess(`[${runLabel}] Refill tiket berhasil! Mengulang start...`);
          startResp = await client.startWorldBoss(weekId, generateRequestId());
        } else {
          throw err;
        }
      }

      const { receipt, verdict, grant } = await executeBattleSession(
        client,
        startResp,
        tacticalPlan,
        { minDelaySec, maxDelaySec, label: runLabel }
      );

      const dmg = grant.damage ?? grant.total_damage ?? receipt?.damage ?? 0;
      totalDamageDealt += Number(dmg);
      logSuccess(
        `[${runLabel}] Pertarungan selesai! Status: ${verdict.toUpperCase()}` +
        (dmg ? ` | Damage: ${Number(dmg).toLocaleString('id-ID')}` : '') +
        ` | Akumulasi Sesi: ${totalDamageDealt.toLocaleString('id-ID')} Total Damage`
      );

      // Auto-claim milestones yang telah tercapai
      if (autoClaim) {
        const freshState = await client.fetchWorldBossState().catch(() => null);
        if (freshState && Array.isArray(freshState.milestones)) {
          for (const m of freshState.milestones) {
            if ((m.achieved || m.completed) && !m.claimed) {
              try {
                const milestoneKey = m.id ?? m.milestone ?? m.milestone_id ?? m.target_damage;
                logInfo(`[${runLabel}] Mengklaim hadiah milestone ${milestoneKey}...`);
                await client.claimWorldBoss(weekId, milestoneKey);
                logSuccess(`[${runLabel}] Hadiah milestone ${milestoneKey} berhasil diklaim!`);
              } catch (cErr) {
                logWarn(`Gagal klaim milestone: ${cErr.message}`);
              }
            }
          }
        }
      }
    } catch (err) {
      logError(`[${runLabel}] Kesalahan: ${err.message}`);
      if (err.payload) logError(`Server payload: ${JSON.stringify(err.payload)}`);
      break;
    }

    if (maxRuns <= 0 || totalRuns < maxRuns) {
      const pauseSec = randomInt(cooldownMinSec, cooldownMaxSec);
      logInfo(`Istirahat ${pauseSec} detik sebelum pertarungan berikutnya...`);
      await sleep(pauseSec * 1000);
    }
  }

  logSuccess(
    `Selesai farming World Boss! Total pertarungan: ${totalRuns}, Total damage: ${totalDamageDealt.toLocaleString('id-ID')}`
  );
}

// ============================================================================
// Loop Farming Hunting House, Eudemon Garden, & Event Boss
// ============================================================================
async function runHuntBot(client, config, cliOptions, mode = 'hunting') {
  const modeKey = String(mode).toLowerCase();
  const isHunting = modeKey === 'hunting' || modeKey === 'hunt';
  const isEudemon = modeKey === 'eudemon' || modeKey === 'garden';
  const isEvent = modeKey === 'event' || modeKey === 'event_boss';

  let modeTitle = 'HUNTING HOUSE';
  let runPrefix = 'Hunt';
  if (isEudemon) {
    modeTitle = 'EUDEMON GARDEN';
    runPrefix = 'Eudemon';
  } else if (isEvent) {
    modeTitle = 'EVENT BOSS';
    runPrefix = 'EventBoss';
  }

  const minDelaySec = Number(config.minDelaySeconds ?? 8);
  const maxDelaySec = Number(config.maxDelaySeconds ?? 15);
  const cooldownMinSec = Number(config.betweenMissionMinSeconds ?? 4);
  const cooldownMaxSec = Number(config.betweenMissionMaxSeconds ?? 9);
  const maxRuns = Number(cliOptions.maxRuns ?? config.maxRuns ?? 0);
  const autoPlan = config.autoPlan !== false;
  const autoRefillStamina = cliOptions.autoRefill || config.eventBoss?.autoRefillStamina === true;
  let targetBossId = cliOptions.bossId || config.bossId || 'auto';

  for (const ver of supportedBattleEngines) {
    engineForBattle(ver);
  }

  const pol = await checkEnginePolicy(client);
  if (pol) logInfo(`Engine kompatibel: ${pol.usable.join(', ')} (server active: ${pol.policy.active})`);

  const avatar = await client.fetchAvatar().catch(() => null);
  if (!avatar) {
    logError('============================================================');
    logError('KESALAHAN: Karakter (Avatar) tidak ditemukan pada akun ini!');
    logError('Pastikan Anda telah membuat karakter di dalam aplikasi Ninja Horizon,');
    logError('atau pastikan Anda login dengan akun Google yang benar via:');
    logError('  node bot.js --login-google');
    logError('============================================================');
    return;
  }

  const charLevel = Number(avatar.level || 1);
  if (charLevel < 10) {
    logError('============================================================');
    logError(`KESALAHAN: Level karakter (${charLevel}) belum mencukupi!`);
    logError(`Fitur ${modeTitle} mensyaratkan minimal Level 10 (PTLOCK:hunting:10).`);
    logError('Silakan naikkan level karakter Anda terlebih dahulu menggunakan farming misi:');
    logError('  node bot.js --runs 10');
    logError('============================================================');
    return;
  }

  const tacticalPlan = autoPlan && avatar?.auto_plan && typeof avatar.auto_plan === 'object' ? avatar.auto_plan : null;

  logInfo('============================================================');
  logInfo(`NINJA HORIZON — FARMING ${modeTitle} (HEADLESS BOT)`);
  logInfo('============================================================');
  logInfo(`Karakter           : ${avatar.name} (Lv ${avatar.level}, ${avatar.rank})`);

  // Pemilihan otomatis (Mode "auto")
  if (String(targetBossId).toLowerCase() === 'auto') {
    const catalog = await client.fetchHuntingCatalog().catch(() => null);
    const definitions = catalog?.definitions || [];
    const defMap = new Map(definitions.map((d) => [d.id, d]));

    if (isEvent) {
      const eventsState = await client.fetchEventsSurfaceState().catch(() => null);
      const rawBosses = eventsState?.bosses || [];
      const eventBosses = rawBosses.filter((b) => {
        const id = b.id || b.room_id || '';
        return !id.startsWith('world_boss_') && b.event_id !== 'world_boss_vadar';
      });

      if (!eventBosses.length) {
        logWarn('Tidak ada Event Boss khusus (selain World Boss) yang aktif saat ini.');
        logInfo('Tips: Anda dapat menjalankan mode Hunting House permanen menggunakan:');
        logInfo('  node bot.js --hunting');
        return;
      }

      const eligible = eventBosses.map((b) => {
        const def = defMap.get(b.id) || {};
        return {
          id: b.id,
          name: def.name || b.name || b.id,
          level: Number(def.encounter_level || b.level || 10),
          event_id: b.event_id,
        };
      }).filter((b) => b.level <= charLevel);

      const chosen = eligible.length ? eligible[eligible.length - 1] : eventBosses[0];
      targetBossId = chosen.id;
      const chosenDef = defMap.get(chosen.id);
      logInfo(`Mode "auto": memilih Event Boss "${chosenDef?.name || chosen.name || targetBossId}" (Room: ${targetBossId}, Lv ${chosen.level ?? 10})`);
    } else if (isEudemon) {
      const eudemonRooms = definitions
        .filter((r) => r.venue === 'eudemon')
        .sort((a, b) => Number(a.encounter_level || a.level || 0) - Number(b.encounter_level || b.level || 0));

      if (!eudemonRooms.length) {
        logWarn('Tidak ada room Eudemon Garden yang ditemukan di katalog.');
        return;
      }

      const eligible = eudemonRooms.filter((r) => Number(r.encounter_level || r.level || 10) <= charLevel);
      if (!eligible.length) {
        logWarn(`Level karakter Anda (Lv ${charLevel}) belum cukup untuk membuka room Eudemon Garden manapun (minimal Lv 10).`);
        return;
      }
      const chosen = eligible[eligible.length - 1];
      targetBossId = chosen.id;
      logInfo(`Mode "auto": memilih Eudemon Garden "${chosen.name}" (Room: ${targetBossId}, Lv ${chosen.encounter_level || chosen.level}, XP: ${Number(chosen.xp || 0).toLocaleString('id-ID')})`);
    } else {
      // Hunting House
      const huntRooms = definitions
        .filter((r) => r.venue === 'hunting')
        .sort((a, b) => Number(a.encounter_level || a.level || 0) - Number(b.encounter_level || b.level || 0));

      if (!huntRooms.length) {
        logWarn('Tidak ada room Hunting House yang ditemukan di katalog.');
        return;
      }

      const eligible = huntRooms.filter((r) => Number(r.encounter_level || r.level || 10) <= charLevel);
      if (!eligible.length) {
        logWarn(`Level karakter Anda (Lv ${charLevel}) belum cukup untuk membuka room Hunting House manapun (minimal Lv 10).`);
        return;
      }
      const chosen = eligible[eligible.length - 1];
      targetBossId = chosen.id;
      logInfo(`Mode "auto": memilih Hunting House "${chosen.name}" (Room: ${targetBossId}, Lv ${chosen.encounter_level || chosen.level}, XP: ${Number(chosen.xp || 0).toLocaleString('id-ID')})`);
    }
  }

  logInfo(`Target Room/Boss ID: ${targetBossId}`);
  logInfo(`Mode Pertarungan   : ${modeTitle}`);
  logInfo('------------------------------------------------------------');

  let totalRuns = 0;
  let totalWins = 0;

  while (maxRuns <= 0 || totalRuns < maxRuns) {
    // 1. Cek Stamina jika mode Event
    if (isEvent) {
      const stam = await client.fetchEventStamina().catch(() => null);
      if (stam && (stam.stamina != null || stam.current != null)) {
        const cur = Number(stam.stamina ?? stam.current);
        const cost = Number(stam.cost || 20);
        logInfo(`Event Stamina saat ini: ${cur}/${stam.max ?? 100}`);
        if (cur < cost) {
          if (autoRefillStamina) {
            logInfo('Event stamina kurang, mencoba refill stamina via event_refill_stamina...');
            await client.refillEventStamina(generateRequestId());
            logSuccess('Refill event stamina berhasil!');
          } else {
            logWarn(`Event stamina tidak cukup (${cur} < ${cost}). Berhenti farming.`);
            break;
          }
        }
      }
    }

    // 2. Cek Saldo Kari Badge jika mode Hunting House
    if (isHunting) {
      const huntState = await client.fetchHuntingPlayerState().catch(() => null);
      if (huntState?.kari) {
        const balance = Number(huntState.kari.balance ?? 0);
        const cost = Number(huntState.kari.entry_cost ?? 5);
        logInfo(`Kari Badge saat ini: ${balance} (Biaya masuk: ${cost} badges)`);
        if (balance < cost) {
          logWarn(`Kari Badge tidak mencukupi (${balance} < ${cost}). Berhenti farming Hunting House.`);
          break;
        }
      }
    }

    totalRuns++;
    const runLabel = `${runPrefix} #${totalRuns}`;
    logInfo(`--- [${runLabel}] Menantang room "${targetBossId}"... ---`);

    try {
      const startResp = await client.startHunt(targetBossId);
      const { receipt, verdict, grant } = await executeBattleSession(
        client,
        startResp,
        tacticalPlan,
        { minDelaySec, maxDelaySec, label: runLabel }
      );

      if (verdict === 'win') {
        totalWins++;
        const xp = grant.xp_granted || grant.xp || 0;
        const gold = grant.wallet?.gold ?? grant.gold ?? 0;
        const items = grant.items || grant.drops || grant.reward_items || [];
        let itemsStr = '';
        if (Array.isArray(items) && items.length) {
          itemsStr = ` | Drops: ${items.map((it) => (typeof it === 'object' ? `${it.id || it.item} x${it.qty || 1}` : it)).join(', ')}`;
        }
        logSuccess(
          `[${runLabel}] MENANG! +${Number(xp).toLocaleString('id-ID')} XP` +
          (gold ? ` | Gold: ${Number(gold).toLocaleString('id-ID')}` : '') +
          itemsStr
        );
      } else {
        logWarn(`[${runLabel}] Pertarungan selesai dengan status: ${verdict}`);
      }
    } catch (err) {
      logError(`[${runLabel}] Kesalahan: ${err.message}`);
      if (err.payload) logError(`Server payload: ${JSON.stringify(err.payload)}`);
      break;
    }

    if (maxRuns <= 0 || totalRuns < maxRuns) {
      const pauseSec = randomInt(cooldownMinSec, cooldownMaxSec);
      logInfo(`Istirahat ${pauseSec} detik sebelum pertarungan berikutnya...`);
      await sleep(pauseSec * 1000);
    }
  }

  logSuccess(`Selesai farming ${modeTitle}! Total run: ${totalRuns}, Menang: ${totalWins}`);
}

// ============================================================================
// Mode Shinobi Tower (Tower of Trials)
// ============================================================================
async function showTowerStatus(client) {
  logInfo('Mengambil status Shinobi Tower dari server...');
  const avatar = await client.fetchAvatar().catch(() => null);
  const state = await client.fetchTowerState();

  console.log('\n============================================================');
  console.log('STATUS SHINOBI TOWER (TOWER OF TRIALS)');
  console.log('============================================================');

  if (avatar?.name) {
    console.log(`Karakter         : ${avatar.name} (Lv ${avatar.level || '?'}, ${avatar.rank || 'ninja'})`);
  }
  console.log(`Minggu Aktif     : ${state.week_id}`);
  if (state.ends_at) {
    console.log(`Batas Mingguan   : ${new Date(state.ends_at).toLocaleString('id-ID')}`);
  }
  console.log(`Lantai Tertinggi : Lantai ${state.record_floor ?? 0} (Best: Lantai ${state.best_floor ?? 0})`);
  console.log(`Lantai Berikutnya: Lantai ${(state.record_floor ?? 0) + 1}`);
  console.log(`Peringkat Anda   : #${state.rank ?? '-'} (Top Server Minggu Ini: Lantai ${state.week_top_floor ?? '-'})`);

  console.log('\n=== Status Sweep ===');
  const sw = state.sweep || {};
  console.log(`Target Sweep     : Lantai ${sw.target ?? '-'}`);
  console.log(`Tersedia         : ${sw.available ? 'YA (Dapat di-sweep sekarang!)' : 'TIDAK (Sudah di-sweep / belum memenuhi)'}`);
  console.log(`Rekor Minggu Lalu: Lantai ${sw.last_week_best ?? '-'}`);

  if (Array.isArray(state.milestones) && state.milestones.length) {
    console.log('\n=== Hadiah Milestone Terdekat ===');
    const upcoming = state.milestones.filter((m) => !m.claimed && m.floor > (state.record_floor ?? 0)).slice(0, 5);
    if (upcoming.length) {
      upcoming.forEach((m) => {
        const rewStr = Object.entries(m.rewards || {})
          .map(([k, v]) => `${k}: +${v}`)
          .join(', ');
        console.log(`- Lantai ${m.floor.toString().padStart(3, ' ')} : ${rewStr}`);
      });
    } else {
      console.log('Semua milestone pada jangkauan lantai saat ini telah diklaim!');
    }
  }

  // Tampilkan musuh di lantai berikutnya jika ada di cache floors
  const nextFloor = (state.record_floor ?? 0) + 1;
  const floorDef = (state.floors || []).find((f) => f.floor === nextFloor);
  if (floorDef) {
    console.log(`\n=== Lawan di Lantai ${nextFloor} (${floorDef.kind.toUpperCase()}) ===`);
    console.log(`Level Musuh      : Lv ${floorDef.level}`);
    floorDef.enemies.forEach((ene, idx) => {
      console.log(`  ${idx + 1}. ${ene.name} | HP: ${Number(ene.hp).toLocaleString('id-ID')} | AGI: ${ene.agi} | DMG: ${ene.dmg} | Role: ${ene.role}`);
    });
  }
  console.log('============================================================\n');
}

async function sweepTowerAction(client) {
  logInfo('Mengambil status tower untuk penyapuan (sweep)...');
  const state = await client.fetchTowerState();
  const sw = state.sweep || {};

  if (!sw.available) {
    logWarn(`Penyapuan (sweep) tidak tersedia saat ini. Target: Lantai ${sw.target ?? '-'}, Minggu lalu: Lantai ${sw.last_week_best ?? '-'}.`);
    return false;
  }

  logInfo(`Menjalankan sweep Shinobi Tower hingga target Lantai ${sw.target}...`);
  const res = await client.sweepTower(state.week_id);
  const wallet = res.wallet || {};
  logSuccess(
    `Sweep berhasil! Status: Lantai ${res.state?.record_floor ?? sw.target} | ` +
    `Gold: ${Number(wallet.gold ?? 0).toLocaleString('id-ID')} | Token: ${wallet.token ?? 0}`
  );
  return true;
}

async function runTowerBot(client, config, cliOptions) {
  logInfo('============================================================');
  logInfo('NINJA HORIZON — FARMING SHINOBI TOWER (HEADLESS BOT)');
  logInfo('============================================================');

  // Pre-flight check avatar
  const avatar = await client.fetchAvatar().catch((err) => {
    if (err.message && err.message.includes('Karakter belum dibuat')) {
      throw err;
    }
    return null;
  });

  const charLevel = Number(avatar?.level || 0);
  if (avatar && charLevel < 10) {
    logWarn(`Level karakter Anda (Lv ${charLevel}) belum mencukupi untuk Shinobi Tower (minimal Lv 10).`);
    return;
  }

  // Cek apakah sweep otomatis diinginkan
  if (cliOptions.autoSweep || config.towerAutoSweep) {
    await sweepTowerAction(client).catch((e) => logWarn(`Auto-sweep gagal: ${e.message}`));
  }

  let state = await client.fetchTowerState();
  let currentFloor = (state.record_floor ?? 0) + 1;
  const targetFloor = cliOptions.targetFloor || config.towerTargetFloor || null;
  const maxFloors = cliOptions.maxFloors || cliOptions.maxRuns || config.towerMaxFloors || 0;
  const tacticalPlan = config.tacticalPlan !== false;

  const minDelaySec = cliOptions.minDelay || config.minDelaySec || 4;
  const maxDelaySec = cliOptions.maxDelay || config.maxDelaySec || 8;
  const cooldownMinSec = cliOptions.cooldownMin || config.cooldownMinSec || 3;
  const cooldownMaxSec = cliOptions.cooldownMax || config.cooldownMaxSec || 6;

  logInfo(`Karakter          : ${avatar?.name || 'Ninja'} (Lv ${charLevel || '?'})`);
  logInfo(`Minggu ID         : ${state.week_id}`);
  logInfo(`Mulai dari Lantai : Lantai ${currentFloor}`);
  if (targetFloor) logInfo(`Target Akhir      : Lantai ${targetFloor}`);
  if (maxFloors > 0) logInfo(`Maksimal Pendakian: ${maxFloors} lantai`);
  logInfo('------------------------------------------------------------');

  let climbedCount = 0;
  let totalWins = 0;

  while (true) {
    if (targetFloor && currentFloor > targetFloor) {
      logSuccess(`Target pendakian tercapai (Lantai ${targetFloor})!`);
      break;
    }
    if (maxFloors > 0 && climbedCount >= maxFloors) {
      logSuccess(`Batas kuota pendakian sesi ini tercapai (${maxFloors} lantai).`);
      break;
    }

    const runLabel = `Tower Floor ${currentFloor}`;
    logInfo(`--- [${runLabel}] Memulai pertarungan lantai ${currentFloor}... ---`);

    try {
      const startResp = await client.startTower(state.week_id, currentFloor);
      const enemies = startResp.context?.tower_enemies || [];
      if (enemies.length) {
        logInfo(`[${runLabel}] Lawan: ${enemies.map((e) => `${e.name} (HP: ${Number(e.hp).toLocaleString('id-ID')})`).join(', ')}`);
      }

      const { verdict, grant } = await executeBattleSession(
        client,
        startResp,
        tacticalPlan,
        { minDelaySec, maxDelaySec, label: runLabel }
      );

      if (verdict === 'win') {
        climbedCount++;
        totalWins++;
        const tw = grant.tower || {};
        const newBestStr = tw.new_best ? ' [REKOR BARU!]' : '';
        const milestoneRewards = tw.milestone?.rewards
          ? ` | Milestone: ${Object.entries(tw.milestone.rewards).map(([k, v]) => `${k} +${v}`).join(', ')}`
          : '';
        logSuccess(`[${runLabel}] MENANG! Berhasil mendaki ke lantai ${currentFloor}${newBestStr}${milestoneRewards}`);
        currentFloor++;
      } else {
        logWarn(`[${runLabel}] Pertarungan kalah atau terhenti (verdict: ${verdict}). Berhenti memanjat Shinobi Tower.`);
        break;
      }
    } catch (err) {
      logError(`[${runLabel}] Kesalahan: ${err.message}`);
      if (err.payload) logError(`Server payload: ${JSON.stringify(err.payload)}`);
      break;
    }

    // Istirahat realistis antar lantai
    const pauseSec = randomInt(cooldownMinSec, cooldownMaxSec);
    logInfo(`Istirahat ${pauseSec} detik sebelum lantai berikutnya...`);
    await sleep(pauseSec * 1000);
  }

  logSuccess(`Selesai sesi Shinobi Tower! Total lantai didaki: ${climbedCount}, Menang: ${totalWins}. Posisi sekarang: Lantai ${currentFloor - 1}`);
}

// ============================================================================
// Mode Ujian Kenaikan Tingkat Ninja (Auto Exam: Level 20, 40, 60, & 80)
// ============================================================================
const EXAM_RANKS = [
  {
    level: 20,
    rank: 'genin',
    nextRank: 'chunin',
    name: 'Chunin Exam (Level 20)',
    desc: 'Membuka Pet Centre & Level Cap 40',
    normalMissions: ['msn55', 'msn56', 'msn57', 'msn58', 'msn59'],
    talentedMissions: ['msn815', 'msn816', 'msn817', 'msn818', 'msn819'],
  },
  {
    level: 40,
    rank: 'chunin',
    nextRank: 'jounin',
    name: 'Jounin Exam (Level 40)',
    desc: 'Membuka Fitur Talents & Level Cap 60',
    normalMissions: ['msn132', 'msn133', 'msn134', 'msn135', 'msn136'],
    talentedMissions: ['msn823', 'msn820', 'msn824', 'msn821', 'msn822'],
  },
  {
    level: 60,
    rank: 'jounin',
    nextRank: 'special_jounin',
    name: 'Special Jounin Exam (Level 60)',
    desc: 'Membuka Special Jounin Class Jutsu & Level Cap 80',
    normalMissions: ['msn227', 'msn229', 'msn231', 'msn233', 'msn235', 'msn236', 'msn237', 'msn238'],
    talentedMissions: ['msn205', 'msn206', 'msn207', 'msn208', 'msn209', 'msn210', 'msn211', 'msn212'],
  },
  {
    level: 80,
    rank: 'special_jounin',
    nextRank: 'tutor',
    name: 'Ninja Tutor Exam (Level 80)',
    desc: 'Membuka Senjutsu (Sage Arts) & Level Cap 100',
    normalMissions: ['msn252', 'msn253', 'msn254', 'msn255', 'msn256', 'msn257', 'msn258'],
    talentedMissions: ['msn259', 'msn260', 'msn261', 'msn262', 'msn263', 'msn264', 'msn265'],
  },
];

async function showExamStatus(client) {
  logInfo('Mengambil data status ujian promosi ninja dari server...');
  const avatar = await client.fetchAvatar().catch(() => null);
  const geninState = await client.fetchExamPlayerState('genin').catch(() => null);
  const clears = new Set(geninState?.clears || []);

  console.log('\n============================================================');
  console.log('STATUS UJIAN PROMOSI NINJA (LEVEL 20, 40, 60, 80)');
  console.log('============================================================');

  if (avatar?.name) {
    console.log(`Karakter         : ${avatar.name} (Lv ${avatar.level || '?'}, Pangkat: ${avatar.rank ? avatar.rank.toUpperCase() : 'GENIN'})`);
  }

  for (const ex of EXAM_RANKS) {
    const normalDone = ex.normalMissions.filter((m) => clears.has(m)).length;
    const talentedDone = ex.talentedMissions.filter((m) => clears.has(m)).length;
    const isPassed = normalDone === ex.normalMissions.length || talentedDone === ex.talentedMissions.length;

    console.log(`\n--- [Lv ${ex.level}] ${ex.name} -> PANGKAT ${ex.nextRank.toUpperCase()} ---`);
    console.log(`Manfaat          : ${ex.desc}`);
    console.log(`Status Kelulusan : ${isPassed ? '✓ LULUS (CLEARED)' : '✕ BELUM LULUS'}`);
    console.log(`Track Normal     : ${normalDone}/${ex.normalMissions.length} stage selesai [${ex.normalMissions.join(', ')}]`);
    console.log(`Track Tensai     : ${talentedDone}/${ex.talentedMissions.length} stage selesai [${ex.talentedMissions.join(', ')}]`);
  }
  console.log('============================================================\n');
}

async function solveExamQuiz(client, missionId) {
  logInfo(`[Quiz] Mengambil soal kuis ujian (${missionId})...`);
  const quizData = await client.fetchExamQuiz(missionId).catch((e) => {
    logWarn(`Gagal mengambil kuis via exam_quiz_get: ${e.message}`);
    return null;
  });

  let answers = [];
  if (quizData && Array.isArray(quizData.questions)) {
    logInfo(`[Quiz] Ditemukan ${quizData.questions.length} pertanyaan kuis.`);
    answers = quizData.questions.map((q) => (q.correct_index != null ? q.correct_index : 0));
  }

  logInfo(`[Quiz] Mengirim lembar jawaban untuk misi ${missionId}...`);
  const submitRes = await client.submitExamQuiz(missionId, answers).catch(async (err) => {
    logWarn(`Submit quiz pertama gagal (${err.message}), mencoba payload alternatif...`);
    return await client.submitExamQuiz(missionId, { answers });
  });

  logSuccess(`[Quiz] Ujian kuis (${missionId}) selesai diproses! Hasil: ${JSON.stringify(submitRes)}`);
  return submitRes;
}

async function solveExamMinigame(client, missionId, trialKind) {
  logInfo(`[Minigame] Memulai minigame "${trialKind}" (${missionId})...`);
  await client.startExamMinigame(missionId).catch((e) => logWarn(`Minigame start: ${e.message}`));

  const waitMs = randomInt(2500, 4000);
  logInfo(`[Minigame] Menyelesaikan tantangan segel/kekkai (${(waitMs / 1000).toFixed(1)}s)...`);
  await sleep(waitMs);

  const clearRes = await client.clearExamMinigame(missionId);
  logSuccess(`[Minigame] Berhasil menyelesaikan minigame "${trialKind}" (${missionId})!`);
  return clearRes;
}

async function runExamBot(client, config, cliOptions = {}) {
  logInfo('============================================================');
  logInfo('NINJA HORIZON — AUTO EXAM PROMOTION BOT (HEADLESS)');
  logInfo('============================================================');

  const avatar = await client.fetchAvatar().catch((err) => {
    if (err.message && err.message.includes('Karakter belum dibuat')) throw err;
    return null;
  });

  const charLevel = Number(avatar?.level || 1);
  const charRank = String(avatar?.rank || 'genin').toLowerCase();

  let targetExam = null;
  const requestedLevel = Number(cliOptions.examLevel || config.examLevel || 0);

  if (requestedLevel > 0) {
    targetExam = EXAM_RANKS.find((e) => e.level === requestedLevel);
  } else {
    if (charRank === 'genin' || (charLevel >= 20 && charRank === 'genin')) {
      targetExam = EXAM_RANKS.find((e) => e.rank === 'genin');
    } else if (charRank === 'chunin' || (charLevel >= 40 && charRank === 'chunin')) {
      targetExam = EXAM_RANKS.find((e) => e.rank === 'chunin');
    } else if (charRank === 'jounin' || (charLevel >= 60 && charRank === 'jounin')) {
      targetExam = EXAM_RANKS.find((e) => e.rank === 'jounin');
    } else if (charRank === 'special_jounin' || (charLevel >= 80 && charRank === 'special_jounin')) {
      targetExam = EXAM_RANKS.find((e) => e.rank === 'special_jounin');
    }
  }

  if (!targetExam) {
    if (!cliOptions.silentNoExam) {
      logWarn(
        `Karakter Anda (${avatar?.name || 'Ninja'}, Lv ${charLevel}, Pangkat: ${charRank.toUpperCase()}) ` +
        `belum memenuhi syarat ujian promosi berikutnya, atau sudah mencapai pangkat tertinggi.`
      );
    }
    return false;
  }

  const trackMode = String(cliOptions.track || config.examTrack || 'normal').toLowerCase();
  const isTalented = trackMode === 'talented' || trackMode === 'tensai';
  const stageMissions = isTalented ? targetExam.talentedMissions : targetExam.normalMissions;

  logInfo(`Karakter          : ${avatar?.name || 'Ninja'} (Lv ${charLevel}, ${charRank.toUpperCase()})`);
  logInfo(`Ujian Promosi     : ${targetExam.name} -> Pangkat ${targetExam.nextRank.toUpperCase()}`);
  logInfo(`Jalur (Track)     : ${isTalented ? 'Tensai / Talented' : 'Normal'}`);
  logInfo(`Total Stage       : ${stageMissions.length} tahap [${stageMissions.join(', ')}]`);
  logInfo('------------------------------------------------------------');

  const state = await client.fetchExamPlayerState(targetExam.rank).catch(() => null);
  const clears = new Set(state?.clears || []);
  const defsMap = new Map((state?.definitions || []).map((d) => [d.id, d]));

  let stagesCleared = 0;
  const tacticalPlan = config.tacticalPlan !== false;
  const minDelaySec = Number(config.minDelaySeconds ?? 5);
  const maxDelaySec = Number(config.maxDelaySeconds ?? 10);
  const cooldownMinSec = Number(config.betweenMissionMinSeconds ?? 3);
  const cooldownMaxSec = Number(config.betweenMissionMaxSeconds ?? 6);

  for (let idx = 0; idx < stageMissions.length; idx++) {
    const missionId = stageMissions[idx];
    const stageNum = idx + 1;
    const def = defsMap.get(missionId) || { id: missionId, name: `Stage ${stageNum}` };

    if (clears.has(missionId)) {
      logInfo(`[Stage ${stageNum}/${stageMissions.length}] ${missionId} "${def.name}" sudah pernah di-clear. Melewati...`);
      stagesCleared++;
      continue;
    }

    const stageLabel = `Exam ${targetExam.nextRank.toUpperCase()} [${stageNum}/${stageMissions.length}]`;
    logInfo(`--- [${stageLabel}] Memulai "${def.name}" (${missionId})... ---`);

    try {
      if (def.trial_kind === 'quiz') {
        await solveExamQuiz(client, missionId);
        clears.add(missionId);
        stagesCleared++;
      } else if (def.trial_kind === 'handseals' || def.trial_kind === 'kekkai') {
        await solveExamMinigame(client, missionId, def.trial_kind);
        clears.add(missionId);
        stagesCleared++;
      } else {
        const sessionResp = await client.startMission(missionId);
        const { verdict } = await executeBattleSession(
          client,
          sessionResp,
          tacticalPlan,
          { minDelaySec, maxDelaySec, label: stageLabel }
        );

        if (verdict === 'win') {
          logSuccess(`[${stageLabel}] MENANG! Berhasil menaklukkan stage "${def.name}"!`);
          clears.add(missionId);
          stagesCleared++;
        } else {
          logWarn(`[${stageLabel}] Pertarungan kalah atau terhenti (verdict: ${verdict}). Berhenti sementara.`);
          return false;
        }
      }
    } catch (err) {
      logError(`[${stageLabel}] Kesalahan: ${err.message}`);
      if (err.payload) logError(`Server payload: ${JSON.stringify(err.payload)}`);
      return false;
    }

    if (idx < stageMissions.length - 1) {
      const pauseSec = randomInt(cooldownMinSec, cooldownMaxSec);
      logInfo(`Istirahat ${pauseSec} detik sebelum stage ujian berikutnya...`);
      await sleep(pauseSec * 1000);
    }
  }

  const updatedAvatar = await client.fetchAvatar().catch(() => null);
  const newRank = updatedAvatar?.rank ? updatedAvatar.rank.toUpperCase() : targetExam.nextRank.toUpperCase();

  logSuccess('\n============================================================');
  logSuccess(`SELAMAT! Anda telah menyelesaikan ${targetExam.name}!`);
  logSuccess(`Pangkat Baru : ${newRank}`);
  logSuccess(`Manfaat      : ${targetExam.desc}`);
  logSuccess('============================================================\n');
  return true;
}




// ============================================================================
// CLI Entrypoint
// ============================================================================
function parseArgs(argv) {
  const opts = {
    testSim: false,
    status: false,
    listMissions: false,
    listBosses: false,
    wbStatus: false,
    worldBoss: false,
    eventBoss: false,
    hunting: false,
    eudemon: false,
    huntStatus: false,
    tower: false,
    towerStatus: false,
    towerSweep: false,
    autoSweep: false,
    exam: false,
    autoExam: false,
    examStatus: false,
    track: null,
    examLevel: null,
    targetFloor: null,
    maxFloors: null,
    loginGoogle: false,
    callbackUrl: null,
    missionId: null,
    bossId: null,
    maxRuns: null,
    autoClaim: false,
    autoRefill: false,
    mode: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--test-sim' || arg === '--test') {
      opts.testSim = true;
    } else if (arg === '--status') {
      opts.status = true;
    } else if (arg === '--list-missions') {
      opts.listMissions = true;
    } else if (arg === '--list-bosses' || arg === '--bosses') {
      opts.listBosses = true;
    } else if (arg === '--wb-status' || arg === '--world-boss-status') {
      opts.wbStatus = true;
    } else if (arg === '--world-boss' || arg === '--wb') {
      opts.worldBoss = true;
      opts.mode = 'wb';
    } else if (arg === '--event-boss' || arg === '--event') {
      opts.eventBoss = true;
      opts.mode = 'event';
    } else if (arg === '--hunting' || arg === '--hunt') {
      opts.hunting = true;
      opts.mode = 'hunting';
    } else if (arg === '--eudemon' || arg === '--garden') {
      opts.eudemon = true;
      opts.mode = 'eudemon';
    } else if (arg === '--hunt-status' || arg === '--hunting-status') {
      opts.huntStatus = true;
    } else if (arg === '--tower') {
      opts.tower = true;
      opts.mode = 'tower';
    } else if (arg === '--tower-status') {
      opts.towerStatus = true;
    } else if (arg === '--tower-sweep') {
      opts.towerSweep = true;
    } else if (arg === '--auto-sweep') {
      opts.autoSweep = true;
    } else if (arg === '--exam' || arg === '--auto-exam') {
      opts.exam = true;
      opts.mode = 'exam';
    } else if (arg === '--exam-status') {
      opts.examStatus = true;
    } else if (arg === '--track' && argv[i + 1]) {
      opts.track = argv[++i];
    } else if ((arg === '--exam-level' || arg === '--exam-rank') && argv[i + 1]) {
      opts.examLevel = Number(argv[++i]);
    } else if ((arg === '--target-floor' || arg === '--floor') && argv[i + 1]) {
      opts.targetFloor = Number(argv[++i]);
    } else if (arg === '--max-floors' && argv[i + 1]) {
      opts.maxFloors = Number(argv[++i]);
    } else if (arg === '--login-google' || arg === '--login') {
      opts.loginGoogle = true;
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        opts.callbackUrl = argv[++i];
      }
    } else if (arg === '--mission' && argv[i + 1]) {
      opts.missionId = argv[++i];
    } else if ((arg === '--boss' || arg === '--room') && argv[i + 1]) {
      opts.bossId = argv[++i];
    } else if (arg === '--runs' && argv[i + 1]) {
      opts.maxRuns = Number(argv[++i]);
    } else if (arg === '--auto-claim') {
      opts.autoClaim = true;
    } else if (arg === '--auto-refill') {
      opts.autoRefill = true;
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

  if (cliOptions.help) {
    console.log(`
Ninja Horizon AFK Farming Bot (Misi, World Boss, Event Boss, Hunting House, Shinobi Tower)

Penggunaan:
  node bot.js [opsi]

Opsi Umum & Akun:
  --help, -h               Tampilkan bantuan ini
  --login-google           Login SSO Google via browser lokal
  --status                 Tampilkan status profil, stamina, dan koin
  --test-sim               Jalankan pengujian offline mesin simulasi Oracle

Farming Misi (AFK EXP):
  --list-missions          Tampilkan daftar misi dan status clears
  --mission <id>           Tentukan ID misi (default: "auto")
  --runs <jumlah>          Jumlah ronde yang ingin dijalankan (default: sesuai config)

Farming World Boss:
  --wb-status              Tampilkan status World Boss, sisa tiket, & milestone
  --wb, --world-boss       Jalankan bot mode World Boss (menghabiskan tiket)
  --auto-claim             Klaim milestone World Boss yang tercapai secara otomatis
  --auto-refill            Beli refill tiket World Boss menggunakan token jika habis

Farming Hunting House, Eudemon Garden, & Event Boss:
  --list-bosses, --bosses  Tampilkan katalog Event Boss, Hunting House, & Eudemon Garden
  --hunt-status            Tampilkan saldo Kari Badge & daftar room terbuka
  --hunting, --hunt        Jalankan farming otomatis Hunting House (Kari Badge)
  --eudemon, --garden      Jalankan farming otomatis Eudemon Garden (EXP Tinggi & Senjata Forge)
  --event, --event-boss    Jalankan farming otomatis Event Boss (Event Stamina)
  --boss <id>, --room <id> Tentukan ID bos / room tertentu (default: auto rekomendasi)

Farming Shinobi Tower (Tower of Trials):
  --tower-status           Tampilkan status rekor lantai, rank mingguan, & sweep Shinobi Tower
  --tower                  Jalankan auto-climb Shinobi Tower memanjat lantai demi lantai
  --tower-sweep            Jalankan penyapuan (sweep) hadiah lantai jika tersedia
  --target-floor <lantai>  Tentukan lantai target akhir untuk berhenti (contoh: --target-floor 80)
  --max-floors <jumlah>    Batas maksimal jumlah lantai yang dinaiki dalam satu kali sesi
  --auto-sweep             Lakukan sweep otomatis sebelum memulai pendakian lantai

Ujian Kenaikan Tingkat (Auto Exam Lv 20, 40, 60, 80):
  --exam-status            Tampilkan status kelulusan ujian semua tingkatan pangkat
  --exam, --auto-exam      Jalankan ujian promosi ninja secara otomatis sesuai level
  --track <normal|tensai>  Pilih jalur ujian: 'normal' atau 'tensai' / 'talented' (default: normal)
  --exam-level <20|40|60|80> Paksa menjalankan ujian untuk tingkatan level tertentu
`);
    return;
  }

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

  if (cliOptions.wbStatus) {
    await showWorldBossStatus(client);
    return;
  }

  if (cliOptions.listMissions) {
    await listMissions(client);
    return;
  }

  if (cliOptions.listBosses) {
    await listBosses(client);
    return;
  }

  if (cliOptions.huntStatus) {
    await showHuntingStatus(client);
    return;
  }

  if (cliOptions.towerStatus) {
    await showTowerStatus(client);
    return;
  }

  if (cliOptions.towerSweep) {
    await sweepTowerAction(client);
    return;
  }

  if (cliOptions.examStatus) {
    await showExamStatus(client);
    return;
  }

  const selectedMode =
    cliOptions.mode ||
    (cliOptions.exam ? 'exam' : null) ||
    (cliOptions.worldBoss ? 'wb' : null) ||
    (cliOptions.eventBoss ? 'event' : null) ||
    (cliOptions.hunting ? 'hunting' : null) ||
    (cliOptions.eudemon ? 'eudemon' : null) ||
    (cliOptions.tower ? 'tower' : null) ||
    config.mode ||
    'mission';

  if (selectedMode === 'exam') {
    await runExamBot(client, config, cliOptions);
  } else if (selectedMode === 'wb' || selectedMode === 'world_boss') {
    await runWorldBossBot(client, config, cliOptions);
  } else if (selectedMode === 'event' || selectedMode === 'event_boss') {
    await runHuntBot(client, config, cliOptions, 'event');
  } else if (selectedMode === 'hunting' || selectedMode === 'hunt') {
    await runHuntBot(client, config, cliOptions, 'hunting');
  } else if (selectedMode === 'eudemon' || selectedMode === 'garden') {
    await runHuntBot(client, config, cliOptions, 'eudemon');
  } else if (selectedMode === 'tower') {
    await runTowerBot(client, config, cliOptions);
  } else {
    await runAfkBot(client, config, cliOptions);
  }
}

if (require.main === module) {
  main().catch((err) => {
    logError(err.message || String(err));
    process.exit(1);
  });
}

module.exports = {
  NinjaHorizonClient,
  executeBattleSession,
  showTowerStatus,
  sweepTowerAction,
  runTowerBot,
  showExamStatus,
  runExamBot,
  EXAM_RANKS,
};

