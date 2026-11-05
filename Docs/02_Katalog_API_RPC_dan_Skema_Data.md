# Katalog API, Supabase RPC, Edge Functions, & Skema Data — Ninja Horizon

Dokumen ini memuat referensi teknis lengkap hasil ekstraksi *bytecode* dan *Shape Table* dari `assets/index.android.bundle` (Hermes Bytecode v98) untuk seluruh komunikasi jaringan, fungsi layanan (*Game Service Layer*), RPC PostgreSQL, dan skema objek data.

---

## 1. Konfigurasi Endpoint & Kunci Publik Tertanam

| Layanan | URL / Identifier | Nilai di Dalam Bundel |
| :--- | :--- | :--- |
| **Supabase Project URL** | `SUPABASE_URL` | `https://uoiuuecrfbvtoadtwrvj.supabase.co` |
| **Supabase Publishable Key** | `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_fmv5Sz29F8kwXJCsa0Q_uQ_F98vjN6J` |
| **Edge Function: Battle** | `POST /functions/v1/resolve-battle` | `https://uoiuuecrfbvtoadtwrvj.supabase.co/functions/v1/resolve-battle` |
| **Edge Function: Live PvP/Co-op** | `POST /functions/v1/pvp-live` | `https://uoiuuecrfbvtoadtwrvj.supabase.co/functions/v1/pvp-live` |
| **PostgREST RPC Endpoint** | `POST /rest/v1/rpc/<rpc_name>` | `https://uoiuuecrfbvtoadtwrvj.supabase.co/rest/v1/rpc/` |
| **Cloudflare Turnstile Gate** | `TURNSTILE_BRIDGE_URL` | `https://captcha.ninjahorizon.com/turnstile?mobile=1` |
| **Turnstile Site Key** | `TURNSTILE_SITE_KEY` | `0x4AAAAAAEmcj0VwmQw2VIvS` |
| **HotUpdater OTA Endpoint** | `HotUpdaterGetBaseURL` | `https://updates.ninjahorizon.com/api/check-update` |
| **HotUpdater Fingerprint** | `com.hotupdater.FINGERPRINT_HASH` | `c57ca294975fd60aa95a41af2dd0cad363e49f9f` |
| **Asset CDN Base URL** | `assets.ninjahorizon.com` | `https://assets.ninjahorizon.com` (CloudFront: `https://da08ctfrofx1b.cloudfront.net/`) |
| **Service Status JSON** | `service-status.json` | `https://assets.ninjahorizon.com/service-status.json` |
| **SWF Bundle Snapshot** | `fps36` | `https://assets.ninjahorizon.com/s/fps36-247e0ca78e9befaea45c` |
| **RevenueCat Android Key** | Public SDK Key | `goog_CmpcSKSyhhaMjtDXOURvuHwFgUj` |
| **RevenueCat iOS Key** | Public SDK Key | `appl_CzckDzXnCfcSquAteHvxTnuKvVm` |

---

## 2. Kontrak Supabase Edge Functions

### 2.1 `/functions/v1/resolve-battle`
Digunakan untuk memulai, menyelesaikan, atau menyerah (*forfeit*) pada pertarungan berbasis sesi (Mission, Hunting House, Tower, Exam, Clan Battle).

| Fungsi Klien (`fid` Wrapper / Generator) | Struktur `body` JSON (`Shape ID`) | Keterangan |
| :--- | :--- | :--- |
| `startBattle` (`fid 9480` / `23331`) | `{"session": <session>, "mode": "start"}` (`shape 5818` / `0x16ba`) | Menginisialisasi sesi pertarungan pada Edge Function. |
| `resolveBattle` (`fid 9475` / `23327`) | `{"session": <session>}` (`shape 5724` / `0x165c`) | Menyelesaikan/meminta status resolusi sesi pertarungan dengan *timeout* (`withBattleSaveDeadline`). |
| `finishBattle` (`fid 9482` / `23333`) | `{"session": <session>, "mode": "finish", "response": <verdict>, "actions": <action_log>}` (`shape 5819` / `0x16bb`) | Mengirim hasil simulasi klien beserta daftar `actions` untuk diverifikasi ulang oleh mesin **Oracle** di server. |
| `forfeitBattle` (`fid 9483` / `23334`) | `{"session": <session>, "mode": "forfeit"}` (`shape 5818` / `0x16ba`) | Menyerah/keluar dari pertarungan aktif. |

### 2.2 `/functions/v1/pvp-live`
Digunakan untuk seluruh interaksi *real-time* pada **Live PvP** dan **Co-op Boss Raid**.

| Fungsi Klien (`fid` Wrapper / Generator) | Struktur `body` JSON (`Shape ID`) | Keterangan |
| :--- | :--- | :--- |
| `pvpLiveBuild` (`fid 9586` / `23415`) | `{"match": <matchId>, "action": "build"}` (`shape 5869` / `0x16ed`) | Mengambil/menginisialisasi *snapshot build* kedua pihak di awal pertandingan. |
| `pvpLiveMove` (`fid 9587` / `23416`) | `{"match": <matchId>, "action": "move", "move": <moveObj>, "seq": <int>}` (`shape 5870` / `0x16ee`) | Mengirimkan aksi giliran pemain dengan nomor urut `seq`. |
| `pvpLiveReleaseStatus` (`fid 9590` / `23419`) | `{"match": <matchId>, "action": "release_status"}` (`shape 5869`) | Memeriksa status pelepasan kunci sesi pertandingan. |
| `pvpLiveSettle` (`fid 9591` / `23420`) | `{"match": <matchId>, "action": "settle"}` (`shape 5869`) | Menyelesaikan dan mencatat hasil akhir pertandingan PvP. |
| `coopLiveSettle` (`fid 9605` / `23433`) | `{"match": <matchId>, "action": "settle"}` (`shape 5869`) | Menyelesaikan pertandingan *Co-op Raid* (dengan *retry* lewat `settleCoopWithRetry` `fid 23574`). |
| `pvpLiveForfeit` (`fid 9592` / `23421`) | `{"match": <matchId>, "action": "forfeit"}` (`shape 5869`) | Menyerah dari pertandingan PvP. |
| `pvpLiveClaimDc` (`fid 9594` / `23423`) | `{"match": <matchId>, "action": "claim_dc"}` (`shape 5869`) | Mengklaim kemenangan ketika lawan terputus (*disconnect*) melewati batas waktu. |
| `pvpLiveConcede` (`fid 9595` / `23424`) | `{"match": <matchId>, "action": "concede"}` (`shape 5869`) | Mengakui kekalahan secara langsung. |
| `pvpLiveNudge` (`fid 9603` / `23431`) | `{"match": <matchId>, "action": "nudge"}` (`shape 5869`) | Memicu pemeriksaan batas waktu giliran lawan. |
| `pvpLiveLeave` (`fid 9604` / `23432`) | `{"match": <matchId>, "action": "leave"}` (`shape 5869`) | Keluar dari lobi/pertandingan Co-op Raid. |

---

## 3. Katalog Lengkap PostgreSQL RPC (`supabase.rpc`) & Query Tabel

Berikut adalah daftar fungsi di *Game Service Layer* beserta nama RPC / tabel Supabase dan parameter inputnya:

### 3.1 Akun, Profil Avatar, & Katalog Statis
| Fungsi JS (`fid`) | Target RPC / Tabel Supabase | Parameter Input (`Shape`) |
| :--- | :--- | :--- |
| `fetchAvatar` (`9460` / `23312`) | Tabel `player_avatar` (`.select('*').maybeSingle()`) | Token sesi pengguna aktif |
| `createAvatar` (`9472` / `23324`) | RPC `create_avatar` / `create_avatar_with_referral` | `p_creation_id`, `p_referral_code`, `name`, `gender`, `element`, `appearance` |
| `onboardingSet` (`9473` / `23325`) | RPC `onboarding_set` | `{"p_patch": <patch>}` (`shape 5815`) |
| `renamePlayer` (`9742`) | RPC `rename_player` | Nama baru karakter |
| `deleteAccount` (`9743`) | RPC `delete_account` | Konfirmasi penghapusan akun |
| `allocateAttribute` (`9517`) | RPC `allocate_attribute` | `{"p_element": <el>, "p_points": <int>}` (`shape 5828`) |
| `setAttributes` (`9518`) | RPC `set_attributes` | `{"p_attributes": <obj>}` (`shape 5829`) |
| `updateStyle` (`9529` / `23364`) | RPC `style_update` | `{"p_hair": <id>, "p_hair_color": <id>, "p_skin": <id>}` (`shape 5838`) |
| `setTitle` (`9560`) | RPC `set_title` | `{"p_title": <id>}` (`shape 5853`) |
| `setNameColor` (`9564`) | RPC `set_name_color` | `{"p_color": <id>}` (`shape 5854`) |
| `readStaticTable` | Tabel statis di cache/Supabase | `skill_defs`, `gear_defs`, `gear_set_defs`, `item_defs`, `pet_defs`, `enemy_defs`, `talent_defs`, `senjutsu_defs`, `senjutsu_skill_defs`, `mission_board_defs`, `gear_gender_pairs` |

### 3.2 Misi, Special Mission, Exam, World Boss, & Event Boss / Hunting House
| Fungsi JS (`fid`) | Target RPC / Tabel Supabase | Parameter Input (`Shape`) |
| :--- | :--- | :--- |
| `listMissions` (`9463` / `23315`) | RPC `mission_board_progress_state` + `mission_board_defs` | - |
| `startMission` (`9474` / `23326`) | RPC `mission_start` | `{"p_mission": <mission_id>}` (`shape 5812`) |
| `fetchMissionEconomy` (`23579`) | Tabel `game_config` (`.eq('key', 'mission_economy')`) | - |
| `fetchWorldBossState` (`9181` / `22870`) | RPC `world_boss_state` | - (Mengembalikan `week_id`, `available`, `milestones`, `ranking_rewards`, `boss`, `player`) |
| `startWorldBoss` (`9182` / `22871`) | RPC `world_boss_start` | `{"p_week_id": <week_id>, "p_request_id": <uuid>}` |
| `refillWorldBoss` (`9183` / `22872`) | RPC `world_boss_refill` | `{"p_request_id": <uuid>}` |
| `claimWorldBossMilestone` (`9184` / `22873`) | RPC `world_boss_claim` | `{"p_week_id": <week_id>, "p_milestone": <id>}` |
| `fetchWorldBossRankings` (`9185` / `22874`) | RPC `world_boss_rankings` | `{"p_week_id": <week_id>, "p_page": <int>}` |
| `fetchEventsSurfaceState` (`22877`) | RPC `events_surface_state` | - (Mengembalikan `events`, `storefronts`, `bosses`) |
| `fetchEventStamina` (`22715`) | RPC `event_stamina` | - |
| `refillEventStamina` (`22716`) | RPC `event_refill_stamina` | - |
| `fetchHuntingCatalog` (`29089`) | RPC `hunting_catalog_state` | - (Katalog monster/bos permanen) |
| `fetchHuntingPlayerPayload` (`9535` / `23366`) | RPC `hunting_player_state` | - (Status room dan limit pemain) |
| `huntStart` (`9537` / `22684` / `23368`) | RPC `hunt_start` | `{"p_room": <room_or_boss_id>}` (`shape 5840`) |
| `fetchExamState` (`9464` / `23316`) | RPC `exam_player_state` | `{"p_rank": <rank>}` (`shape 5808`) |
| `chooseSpecialClassJutsu` (`9465` / `23317`) | RPC `exam_special_class_choose` | `{"p_skill": <skill_id>}` (`shape 5810`) |
| `resetSpecialClass` (`9466` / `23318`) | RPC `exam_special_class_reset` | - |
| `fetchExamQuiz` (`9467` / `23319`) | RPC `exam_quiz_get` | `{"p_mission": <mission_id>}` (`shape 5812`) |
| `submitExamQuiz` (`9468` / `23320`) | RPC `exam_quiz_submit` | `{"p_mission": <mission_id>, "p_answers": <array>}` (`shape 5813`) |
| `examMinigameStart` (`9469` / `23321`) | RPC `exam_minigame_start` | `{"p_mission": <mission_id>}` (`shape 5812`) |
| `examMinigameClear` (`9470` / `23322`) | RPC `exam_minigame_clear` | `{"p_mission": <mission_id>}` (`shape 5812`) |
| `fetchSpecialMissionState` (`9681` / `23505`) | RPC `special_mission_state` | - |
| `startSpecialMission` (`9682` / `23506`) | RPC `special_mission_start` | `{"p_mission": <mission_id>}` |
| `completeSpecialMission` (`9683` / `23507`) | RPC `special_mission_complete` | `{"p_session": <session_id>, "p_proof": <proof>}` (`shape 5903`) |
| `failSpecialMission` (`9684` / `23508`) | RPC `special_mission_fail` | `{"p_session": <session_id>}` (`shape 5905`) |
| `fetchHuntingPlayerPayload` (`9535` / `23366`) | RPC `hunting_player_state` | - |
| `huntStart` (`9537` / `23368`) | RPC `hunt_start` | `{"p_room": <room_or_boss_id>}` (`shape 5840`) |

### 3.3 Jutsu, Gear, Academy, Talent, & Senjutsu (Sage Path)
| Fungsi JS (`fid`) | Target RPC Supabase | Parameter Input (`Shape`) |
| :--- | :--- | :--- |
| `fetchSkills` (`9503` / `23344`) | `player_skills_ownership_state` | - |
| `learnSkill` (`9663` / `23481`) | `learn_skill` | `{"p_skill": <skill_id>}` |
| `upgradeSkill` (`9664` / `23482`) | `upgrade_skill` | `{"p_from": <id>, "p_to": <id>}` (`shape 5894`) |
| `setModeSkillLoadout` (`23359`) | `set_mode_skill_loadout` | `{"p_mode": <mode>, "p_skills": <arr>, "p_revision": <int>}` (`shape 5833`) |
| `setAutoPlan` (`9526`) | `set_auto_plan` | `{"p_loadout": <id>, "p_plan": <plan>}` (`shape 5835`) |
| `equipGear` (`9527`) | `equip_gear` | `{"p_def_id": <gear_id>}` (`shape 5836`) |
| `unequipGear` (`9528`) | `unequip_gear` | `{"p_slot": <slot_name>}` (`shape 5837`) |
| `buyTalent` (`9669` / `23488`) | `buy_talent` | `{"p_talent": <talent_id>}` (`shape 5895`) |
| `resetTalent` (`9670` / `23489`) | `reset_talent` | `{"p_talent": <talent_id>}` (`shape 5895`) |
| `learnTalentSkill` (`9671` / `23490`) | `learn_talent_skill` | `{"p_node": <id>}` |
| `upgradeTalentSkill` (`9672` / `23491`) | `upgrade_talent_skill` | `{"p_node", "p_expected_skill", "p_target", "p_expected_cost", "p_request_id"}` (`shape 5896`) |
| `maxTalentSkill` (`9673` / `23492`) | `max_talent_skill` | `{"p_node", "p_from_level", "p_to_level", "p_expected_cost", "p_request_id"}` (`shape 5947`) |
| `fetchSenjutsuState` (`9676` / `23500`) | `senjutsu_state` | - |
| `chooseSenjutsuSchool` (`9677` / `23501`) | `senjutsu_choose_school` | `{"p_school": <school_id>}` (`shape 5898`) |
| `upgradeSenjutsu` (`9678` / `23502`) | `senjutsu_upgrade` | `{"p_skill_id": <id>}` (`shape 5899`) |
| `setSenjutsuLoadout` (`9679` / `23503`) | `senjutsu_set_loadout` | `{"p_skill_ids": <array>}` (`shape 5900`) |
| `resetSenjutsu` (`9680` / `23504`) | `senjutsu_reset` | - |

### 3.4 Pet, Recruit NPC, & Friends
| Fungsi JS (`fid`) | Target RPC Supabase | Parameter Input (`Shape`) |
| :--- | :--- | :--- |
| `trainPetSkill` (`9640` / `23464`) | `train_pet_skill` | `{"p_def_id": <pet_id>, "p_skill_idx": <idx>}` (`shape 5887`) |
| `buyPet` (`9641`) | `buy_pet` | `{"p_def_id": <pet_id>}` |
| `setActivePet` (`9642`) | `set_active_pet` | `{"p_def_id": <pet_id>}` |
| `petCombine` (`9644`) | `pet_combine` | `{"p_def_a": <id1>, "p_def_b": <id2>}` (`shape 5889`) |
| `petFeed` (`9645`) | `pet_feed` | `{"p_pet_def": <pet_id>, "p_item": <item_id>}` (`shape 5890`) |
| `recruitNpc` / `unrecruitNpc` (`9615` / `9618`) | `recruit_npc` / `unrecruit_npc` | `{"p_npc": <npc_id>}` (`shape 5876`) |
| `friendRequest` / `friendAccept` / `friendUnfriend` | `friend_request` / `friend_accept` / `friend_unfriend` | `{"p_target": <uid>}` / `{"p_other": <uid>}` (`shape 5885`/`5886`) |
| `recruitFriend` / `unrecruitFriend` (`9628` / `9629`) | `recruit_friend` / `unrecruit_friend` | `{"p_friend": <uid>}` (`shape 5881`) |

### 3.5 Clan & Clan Wars
Seluruh operasi klan dibungkus melalui helper `clanRpc` (`fid 9823` / `23567`):
* `clan_me` (`fid 9542` / `23373`)
* `clan_list` (`fid 9543` / `23374` — parameter `{"p_query", "p_offset", "p_limit"}` `shape 5844`)
* `clan_leaderboard` (`fid 9544` / `23375`)
* `clan_season_reward_catalog` (`fid 9545` / `23376` — parameter `{"p_catalog_season"}` `shape 5845`)
* `clan_building_catalog_state` (`fid 9546` / `23377`)
* `clan_respond_request` (`fid 9547` / `23378` — parameter `{"p_request", "p_accept"}` `shape 5846`)
* `clan_battle_start` (`fid 9548` / `23379` — parameter `{"p_target", "p_allies"}` `shape 5847`)
* `clan_history` (`fid 9550` / `23381` — parameter `{"p_offset", "p_limit"}` `shape 5849`)
* `clan_create` (`fid 9824`), `clan_request_join` (`fid 9825`), `clan_cancel_request` (`fid 9826`), `clan_leave` (`fid 9827`), `clan_kick` (`fid 9828`), `clan_disband` (`fid 9829`), `clan_donate` (`fid 9830`), `clan_upgrade_building` (`fid 9831`), `clan_set_announcement` (`fid 9832`), `clan_expand_slots` (`fid 9833`), `clan_promote_elder` (`fid 9834`), `clan_demote_elder` (`fid 9835`), `clan_swap_master` (`fid 9836`), `clan_buy_stamina` (`fid 9837`), `clan_upgrade_stamina` (`fid 9838`), `clan_use_stamina_roll` (`fid 9839`).

### 3.6 PvP, Arena, & Co-op Stamina/Matchmaking
| Fungsi JS (`fid`) | Target RPC / Tabel Supabase | Parameter Input (`Shape`) |
| :--- | :--- | :--- |
| `runPvpStart` (`9551` / `23382`) | RPC `pvp_start` (khusus mode `'arena'`) | `{"p_mode": "arena"}` (`shape 5850`) |
| `fetchArenaStamina` / `refillArenaStamina` (`9566`/`9567`) | RPC `arena_stamina` / `arena_refill_stamina` | - |
| `fetchCoopStamina` / `refillCoopStamina` (`9572`/`9573`) | RPC `coop_stamina` / `coop_refill_stamina` | - |
| `fetchCoopBosses` (`9597` / `23425`) | RPC `coop_boss_catalog_state` | - |
| `fetchCoopDropsToday` (`9599` / `23427`) | Tabel `coop_daily` (`.select('boss_id,drop_wins').eq('day', today)`) | - |
| `pvpEnqueue` / `pvpDequeue` (`9583`/`9584`) | RPC `pvp_enqueue` / `pvp_dequeue` | `{"p_mode": "pvp", "p_engine": ENGINE_VERSION}` (`shape 5867`) |
| `coopEnqueue` / `coopDequeue` (`9600`/`9601`) | RPC `coop_enqueue` / `coop_dequeue` | `{"p_engine": ENGINE_VERSION}` (`shape 5873`) |
| `coopRoomCreate` (`9602` / `23430`) | RPC `coop_room_create` | `{"p_team_size": <int>}` (`shape 5874`) |

### 3.7 Ekonomi, Gacha, Forge, Shop, & Klaim Hadiah
| Fungsi JS (`fid`) | Target RPC Supabase | Parameter Input (`Shape`) |
| :--- | :--- | :--- |
| `fetchForge` (`9538` / `23369`) | `forge_player_surface_state` | - |
| `forgeCraft` (`9539` / `23370`) | `forge_craft` | `{"p_recipe": <id>, "p_option": <opt>}` (`shape 5842`) |
| `fetchShopCatalogState` (`9655` / `23478`) | `shop_player_surface_state` | - |
| `buyShopProduct` (`9662` / `23480`) | `buy_shop_product` / `buy_shop_consumables` | `{"p_shop", "p_category", "p_product_id", "p_option"}` (`shape 5892`) / `{"p_qty"}` (`shape 5893`) |
| `sellBattleConsumables` (`9513` / `23350`) | `sell_battle_consumables` | `{"p_item_id", "p_qty", "p_expected_unit_gold", "p_request_id"}` (`shape 5826`) |
| `gachaSpin` (`9735` / `23552`) | `gacha_spin` | `{"p_shop": <shop_id>, "p_n": <1_or_10>}` (`shape 5930`) |
| `gachaBeginnerSpin` (`9736` / `23553`) | `gacha_beginner_spin` | - |
| `dragonRedeem` (`9733` / `23550`) | `dragon_redeem` | `{"p_item": <reward_id>}` (`shape 5928`) |
| `dragonBallSwap` (`9734` / `23551`) | `dragon_ball_swap` | - |
| `scratchPlay` (`9737` / `23554`) | `scratch_play` | - |
| `fetchLuckyDrawState` (`9738` / `23555`) | `daily_lucky_draw_state` | - |
| `dailyLuckyDrawSpin` (`9739` / `23556`) | `daily_lucky_draw_spin` | - |
| `dailyLoginClaim` (`9701`) | `daily_login_claim` | - |
| `dailyClaimQuest` / `dailyClaimQuests` / `dailyClaimAll` | `daily_claim_quest` / `daily_claim_quests` / `daily_claim_all` | `{"p_quest": <id>}` / `{"p_quests": <arr>}` (`shape 5911`/`5912`) |
| `dailyClaimChest` (`9700`) | `daily_claim_chest_v2` | `{"p_idx": <chest_idx>}` (`shape 5913`) |
| `dailyClaimEmblem` / `dailyClaimCard` (`9702`/`9703`) | `daily_claim_emblem` / `daily_claim_card` | - |
| `weeklyClaimQuest` / `weeklyClaimAll` / `weeklyClaimChest` | `weekly_claim_quest` / `weekly_claim_all` / `weekly_claim_chest` | `{"p_quest"}` / `{"p_idx"}` |
| `achievementClaim` / `achievementClaimAll` (`9716`/`9718`) | `achievement_claim` / `achievement_claim_all` | `{"p_id": <ach_id>}` (`shape 5917`) |
| `claimLevelJutsuReward` (`9722`) | `level_jutsu_reward_claim` | `{"p_reward": <id>, "p_skill": <skill_id>}` (`shape 5919`) |
| `journeyClaim` (`9726`) | `journey_claim` | `{"p_day": <day_num>}` (`shape 5922`) |
| `passClaim` (`9730`) | `pass_claim` | `{"p_tier": <tier>, "p_premium": <bool>}` (`shape 5923`) |
| `mailClaim` / `mailClaimAll` / `mailClear` (`9690`/`9691`/`9687`) | `mail_claim` / `mail_claim_all` / `mail_clear` | `{"p_mail_id": <id>}` (`shape 5907`) |
| `redeemRewardCode` (`9689` / `23512`) | `redeem_reward_code` | Kode promosi (`trim().toUpperCase()`) |

---

## 4. Skema Objek Utama di Hermes Shape Table

### 4.1 Skema `player_avatar` (`shape 5882` / `0x16fa`)
```json
[
  "user_id", "name", "gender", "level", "xp", "rank", "talented",
  "max_elements", "emblem", "attributes", "unspent_points",
  "skill_loadout", "equipped_gear", "appearance", "active_pet",
  "bloodline", "senjutsu", "senjutsu_school", "senjutsu_spirit",
  "senjutsu_loadout", "gear_overrides", "talent_points",
  "special_class_skill", "npcs", "recruited_friends", "tag",
  "onboarding", "title_id", "name_color_id", "banned_until", "ban_reason"
]
```

### 4.2 Skema `wallet` (`shape 5822` / `0x16be`)
```json
["gold", "token", "prestige", "honor", "glory", "merit"]
```

### 4.3 Skema `skill_defs` CSV Header (String `[9090]`)
```csv
id,name,category,element,rarity,level_req,cost,train_hours,base_damage,cp_cost,cooldown,hit_num,hit_chance,upgrade_group,tier_order,swf,premium,render_mobile,render_web,cast_offset_x_pct,cast_align_middle_y,cast_target_relative,description,cast_target,nature,pos_type,source,talent_id,talent_order,talent_dependency,is_passive,effects
```

### 4.4 Skema `gacha_state` (`shape 5925` / `0x1725`)
```json
[
  "sinceTop", "pityAt", "scratchFree", "scratchCredits", "scratchNextResetAt",
  "duplicatePolicy", "spinCost1", "spinCost10", "scratchPaidCost",
  "dragonSwapCost", "freePull", "nextFreeAt", "nextTopFeatured",
  "bannerEndsAt", "nextBannerStartsAt", "odds", "pools", "scratchPools",
  "balls", "dragons", "beginner"
]
```
