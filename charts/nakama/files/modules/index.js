// Railbound server logic for Nakama (JavaScript runtime): match allocation AND the player economy.
//
// ECONOMY (server-authoritative): coins, XP, level, owned operators and challenge progress live in the storage object
// player_economy/profile of each player. It is READ-ONLY for the client (permissionWrite 0); only this module writes it:
//   railbound_profile            player   -> the player's profile (created on first call) and the operator price table
//   railbound_buy_operator       player   -> spends coins on an operator from the SERVER price table
//   railbound_claim_challenge    player   -> pays a challenge the SERVER counted as complete
//   railbound_report_match       server   -> match results reported by the dedicated game server (HTTP key); XP and coins are computed here
//   railbound_validate_join      server   -> does this (matchId, userId, joinToken) belong to a real allocation? (connection approval)
// The two "server" RPCs are rejected for any call that carries a user session; they need the Nakama HTTP key (runtime.http_key),
// which therefore MUST be changed from the default and kept out of the client.
//
// ALLOCATION:
// The game client calls the RPC "railbound_allocate" with a match id after it has been matched (or has given up waiting).
// Every player of the same match sends the same id, and all of them get the SAME game server back:
//   - the first caller claims the match in Nakama storage and asks Agones for a Ready game server from the fleet,
//   - everybody else gets "pending" until the claim is finished, then the stored address.
//
// Agones is reached through a `kubectl proxy` sidecar in the Nakama pod (plain HTTP on 127.0.0.1:8001, authorised by the
// pod's service account), so no certificates or tokens are handled in this file.
//
// Settings come from `runtime.env` in the Nakama config (see the chart values, block `agones`):
//   AGONES_NAMESPACE   namespace of the fleet            (default: platform)
//   AGONES_FLEET       fleet name                        (default: railbound-br)
//   AGONES_API         base URL of the kubectl proxy     (default: http://127.0.0.1:8001)
//   PUBLIC_GAME_HOST   address players connect to        (default: the node address Agones reports)

var SYSTEM_USER = "00000000-0000-0000-0000-000000000000";
var COLLECTION = "railbound_matches";
var STALE_CLAIM_MS = 20000;

function envOr(ctx, key, fallback) {
  return ctx.env && ctx.env[key] ? ctx.env[key] : fallback;
}

function labelSafe(value) {
  // Kubernetes label values: at most 63 characters of [A-Za-z0-9_.-]
  return String(value).replace(/[^A-Za-z0-9_.-]/g, "-").substring(0, 63);
}

function readMatch(nk, matchId) {
  var objects = nk.storageRead([{ collection: COLLECTION, key: matchId, userId: SYSTEM_USER }]);
  return objects && objects.length > 0 ? objects[0] : null;
}

function writeMatch(nk, matchId, value, version) {
  var write = { collection: COLLECTION, key: matchId, userId: SYSTEM_USER, value: value, permissionRead: 0, permissionWrite: 0 };
  if (version !== undefined && version !== null) {
    write.version = version; // "*" = only if it does not exist yet; otherwise the version that was read
  }
  nk.storageWrite([write]);
}

function result(status, extra) {
  var out = { status: status };
  if (extra) {
    for (var key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) {
        out[key] = extra[key];
      }
    }
  }
  return JSON.stringify(out);
}

// Asks Agones for a Ready game server of the fleet. Returns { name, host, port } or null when none is Ready.
function allocateGameServer(ctx, nk, matchId, players) {
  var api = envOr(ctx, "AGONES_API", "http://127.0.0.1:8001");
  var namespace = envOr(ctx, "AGONES_NAMESPACE", "platform");
  var fleet = envOr(ctx, "AGONES_FLEET", "railbound-br");

  var body = {
    apiVersion: "allocation.agones.dev/v1",
    kind: "GameServerAllocation",
    spec: {
      selectors: [{ matchLabels: { "agones.dev/fleet": fleet }, gameServerState: "Ready" }],
      metadata: {
        labels: { "railbound.io/match": labelSafe(matchId) },
        annotations: { "railbound.io/match-id": String(matchId), "railbound.io/expected-players": String(players) }
      }
    }
  };

  var url = api + "/apis/allocation.agones.dev/v1/namespaces/" + namespace + "/gameserverallocations";
  var response = nk.httpRequest(url, "post", { "Content-Type": "application/json", Accept: "application/json" }, JSON.stringify(body), 8000);
  if (response.code < 200 || response.code >= 300) {
    throw new Error("Agones allocation failed: HTTP " + response.code + " " + response.body);
  }

  var allocation = JSON.parse(response.body);
  var status = allocation.status || {};
  if (status.state !== "Allocated") {
    return null; // UnAllocated: every server of the fleet is busy
  }

  var port = status.ports && status.ports.length > 0 ? status.ports[0].port : 0;
  return { name: status.gameServerName, host: envOr(ctx, "PUBLIC_GAME_HOST", status.address), port: port };
}

function rpcAllocate(ctx, logger, nk, payload) {
  if (!ctx.userId) {
    throw new Error("authentication required");
  }

  var request = payload ? JSON.parse(payload) : {};
  var matchId = request.matchId ? String(request.matchId) : "";
  if (!matchId || matchId.length > 100) {
    throw new Error("matchId is required (1-100 characters)");
  }
  var players = Math.max(1, Math.min(20, request.players | 0 || 1));

  var now = Date.now();
  var existing = readMatch(nk, matchId);
  if (existing) {
    var value = existing.value || {};
    if (value.roster && value.roster.indexOf(ctx.userId) < 0) {
      logger.warn("railbound_allocate: %s is not in the roster of match %s", ctx.userId, matchId);
      return result("not_in_match", { matchId: matchId });
    }
    if (value.status === "completed" || value.status === "failed") {
      return result("match_over", { matchId: matchId });
    }
    if (value.status === "ready") {
      return result("ready", { matchId: matchId, host: value.host, port: value.port, name: value.name, token: issueJoinToken(nk, matchId, ctx.userId) });
    }
    if (value.status === "allocating" && now - value.at < STALE_CLAIM_MS) {
      return result("pending", { matchId: matchId });
    }
  }

  // claim the match; if somebody else wins the race the write is rejected and this caller simply waits
  try {
    writeMatch(nk, matchId, { status: "allocating", at: now, by: ctx.userId }, existing ? existing.version : "*");
  } catch (e) {
    return result("pending", { matchId: matchId });
  }

  var server = null;
  try {
    server = allocateGameServer(ctx, nk, matchId, players);
  } catch (e) {
    logger.error("railbound_allocate: %s", e.message);
  }

  if (!server) {
    // release the claim so the next attempt can try again
    try {
      nk.storageDelete([{ collection: COLLECTION, key: matchId, userId: SYSTEM_USER }]);
    } catch (e) {
      logger.warn("railbound_allocate: could not release the claim: %s", e.message);
    }
    return result("unavailable", { matchId: matchId });
  }

  writeMatch(nk, matchId, { status: "ready", at: now, host: server.host, port: server.port, name: server.name });
  logger.info("railbound_allocate: match %s -> %s:%d (%s) for %d player(s)", matchId, server.host, server.port, server.name, players);
  return result("ready", { matchId: matchId, host: server.host, port: server.port, name: server.name, token: issueJoinToken(nk, matchId, ctx.userId) });
}

// ---------------------------------------------------------------------------------------------------------------------
// Join tokens. Every player who is told the server of a match also gets a random token that only Nakama knows, stored under
// that player (owner = the user, no client read/write). The game server asks railbound_validate_join before it lets a client in,
// so a client that never went through railbound_allocate for this match (or claims somebody else's user id) is refused.
// ---------------------------------------------------------------------------------------------------------------------
var JOIN_COLLECTION = "railbound_join";

function joinKey(nk, matchId) {
  return nk.sha256Hash(matchId); // 64 hex characters, always a valid storage key
}

function readJoin(nk, matchId, userId) {
  var objects = nk.storageRead([{ collection: JOIN_COLLECTION, key: joinKey(nk, matchId), userId: userId }]);
  return objects && objects.length > 0 ? objects[0] : null;
}

function issueJoinToken(nk, matchId, userId) {
  var existing = readJoin(nk, matchId, userId);
  if (existing && existing.value && existing.value.token) {
    return existing.value.token;
  }
  var token = nk.uuidv4().replace(/-/g, "");
  try {
    nk.storageWrite([{ collection: JOIN_COLLECTION, key: joinKey(nk, matchId), userId: userId, value: { token: token, matchId: matchId, at: Date.now() }, permissionRead: 0, permissionWrite: 0, version: "*" }]);
    return token;
  } catch (e) {
    // a second call of the same player was faster: use its token
    existing = readJoin(nk, matchId, userId);
    if (existing && existing.value && existing.value.token) {
      return existing.value.token;
    }
    throw e;
  }
}

// HTTP-key RPCs are called by the game server: there is no user session. A call that carries one comes from a client.
function requireServerCall(ctx) {
  if (ctx.userId) {
    throw new Error("this RPC is for the game server only");
  }
}

function rpcValidateJoin(ctx, logger, nk, payload) {
  requireServerCall(ctx);
  var request = payload ? JSON.parse(payload) : {};
  var matchId = request.matchId ? String(request.matchId) : "";
  var userId = request.userId ? String(request.userId) : "";
  var token = request.token ? String(request.token) : "";
  if (!matchId || matchId.length > 100 || !userId || userId.length > 64 || !token || token.length > 64) {
    return JSON.stringify({ valid: false, reason: "bad_request" });
  }
  var join = null;
  try {
    join = readJoin(nk, matchId, userId);
  } catch (e) {
    return JSON.stringify({ valid: false, reason: "unknown_user" });
  }
  if (!join || !join.value || join.value.token !== token) {
    return JSON.stringify({ valid: false, reason: "no_ticket" });
  }
  var match = readMatch(nk, matchId);
  if (match && match.value && (match.value.status === "completed" || match.value.status === "failed")) {
    return JSON.stringify({ valid: false, reason: "match_over" });
  }
  if (match && match.value && match.value.roster && match.value.roster.indexOf(userId) < 0) {
    return JSON.stringify({ valid: false, reason: "not_in_roster" });
  }
  return JSON.stringify({ valid: true });
}

// ---------------------------------------------------------------------------------------------------------------------
// Player economy
// ---------------------------------------------------------------------------------------------------------------------
var ECONOMY = "player_economy";
var PROFILE_KEY = "profile";
var MAX_LEVEL = 100;
var MAX_PAID_MATCHES = 40; // how many reported match ids a profile remembers (a match is paid once per player)

// Prices of the operators of the lobby store, by operator id. THE SERVER PRICE TABLE: the client only displays it.
// The starting operator is free and never listed. Keep in sync with Assets/Project/Resources/CharacterSkinCatalog.asset
// (ids are "op_" + skin id; op_vanguard / op_recon / op_support are the look variants of the starting model).
var OPERATOR_PRICES = {
  op_vanguard: 1500,
  op_recon: 1500,
  op_support: 1500,
  op_striker: 3000,
  op_cammy: 3500,
  op_tactical: 3500,
  op_swat: 3000
};

// Challenge definitions by tab. Progress is counted HERE from the match results of the game server (same numbers as ChallengeService.cs).
var CHALLENGE_DEFS = {
  daily: [
    { key: "d_play2", metric: "matches", goal: 2, xp: 300, coins: 75 },
    { key: "d_kill3", metric: "kills", goal: 3, xp: 400, coins: 100 },
    { key: "d_surv6", metric: "surviveMinutes", goal: 6, xp: 300, coins: 75 }
  ],
  weekly: [
    { key: "w_win1", metric: "wins", goal: 1, xp: 1200, coins: 300 },
    { key: "w_kill15", metric: "kills", goal: 15, xp: 1200, coins: 300 },
    { key: "w_play7", metric: "matches", goal: 7, xp: 900, coins: 225 },
    { key: "w_top5x3", metric: "top5", goal: 3, xp: 1200, coins: 300 }
  ],
  season: [
    { key: "s_play30", metric: "matches", goal: 30, xp: 3000, coins: 750 },
    { key: "s_win5", metric: "wins", goal: 5, xp: 4000, coins: 1000 },
    { key: "s_kill150", metric: "kills", goal: 150, xp: 5000, coins: 1250 }
  ]
};
var SEASON_ID = "S01";
var CHALLENGE_TABS = ["daily", "weekly", "season"];

function xpForLevel(level) {
  return 1000 + (Math.max(1, level) - 1) * 150;
}

function levelBonusCoins(newLevel) {
  return 100 + newLevel * 10;
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function dayId(date) {
  return date.getUTCFullYear() + "-" + pad2(date.getUTCMonth() + 1) + "-" + pad2(date.getUTCDate());
}

// ISO 8601 week id, e.g. 2026-W46 (same as the client's ISOWeek)
function weekId(date) {
  var d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  var dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  var yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  var week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + "-W" + pad2(week);
}

function periodId(tab, now) {
  var date = new Date(now);
  return tab === "daily" ? dayId(date) : tab === "weekly" ? weekId(date) : SEASON_ID;
}

function newProfile(now) {
  return {
    level: 1, xp: 0, totalXp: 0, coins: 0, gems: 0,
    matches: 0, wins: 0, kills: 0, playSeconds: 0, bestPlacement: 0,
    operators: [], challenges: {}, paid: [], lastAward: null,
    updatedAt: now, version: 2
  };
}

// Starts a new period of a challenge tab when the day / week / season changed (or a definition was added).
function rollChallenges(profile, now) {
  if (!profile.challenges) {
    profile.challenges = {};
  }
  for (var t = 0; t < CHALLENGE_TABS.length; t++) {
    var tab = CHALLENGE_TABS[t];
    var defs = CHALLENGE_DEFS[tab];
    var id = periodId(tab, now);
    var period = profile.challenges[tab];
    var ok = period && period.id === id && period.items && period.items.length === defs.length;
    if (ok) {
      for (var i = 0; i < defs.length; i++) {
        if (period.items[i].key !== defs[i].key) { ok = false; }
      }
    }
    if (!ok) {
      var items = [];
      for (var k = 0; k < defs.length; k++) {
        items.push({ key: defs[k].key, progress: 0, claimed: false });
      }
      profile.challenges[tab] = { id: id, items: items };
    }
  }
}

// Adds XP and coins and moves the level up as often as the XP allows. Returns what happened.
function grantXp(profile, xp, coins) {
  var award = { xp: xp, coins: coins, levelBonusCoins: 0, oldLevel: profile.level, newLevel: profile.level };
  profile.coins += coins;
  profile.totalXp += xp;
  if (profile.season) { profile.season.xp += xp; }
  if (profile.level < MAX_LEVEL) {
    profile.xp += xp;
    while (profile.level < MAX_LEVEL && profile.xp >= xpForLevel(profile.level)) {
      profile.xp -= xpForLevel(profile.level);
      profile.level++;
      var bonus = levelBonusCoins(profile.level);
      award.levelBonusCoins += bonus;
      profile.coins += bonus;
    }
    if (profile.level >= MAX_LEVEL) {
      profile.xp = 0;
    }
  }
  award.newLevel = profile.level;
  return award;
}

// What a finished match is worth: a base amount, kills, time survived and placement (a win is worth the most).
function matchReward(placement, totalPlayers, kills, survivedSeconds) {
  var placementBonus;
  if (placement === 1) {
    placementBonus = 1000;
  } else {
    placementBonus = Math.round(600 * (totalPlayers - placement) / Math.max(1, totalPlayers - 1));
  }
  var xp = 100 + kills * 75 + Math.floor(survivedSeconds / 60) * 10 + placementBonus;
  return { xp: xp, coins: Math.round(xp * 0.25) };
}

function readProfile(nk, userId) {
  var objects = nk.storageRead([{ collection: ECONOMY, key: PROFILE_KEY, userId: userId }]);
  return objects && objects.length > 0 ? objects[0] : null;
}

// Read - change - write with optimistic concurrency (the storage version), so two RPCs of the same player (a purchase while a match
// is being paid) can never overwrite each other. `change(profile, now)` returns the extra reply data, or null when it changed nothing.
// A new profile, or one whose challenge periods rolled over, is saved even when `change` returns null.
function mutateProfile(nk, userId, change) {
  var lastError = null;
  for (var attempt = 0; attempt < 6; attempt++) {
    var now = Date.now();
    var stored = readProfile(nk, userId);
    var profile = stored && stored.value ? stored.value : newProfile(now);
    var version = stored ? stored.version : "*";
    var before = stored ? JSON.stringify(profile) : "";
    rollChallenges(profile, now);
    if (!profile.operators) { profile.operators = []; }
    if (!profile.paid) { profile.paid = []; }
    normalizeProgression(profile);

    var extra = change(profile, now);
    if (extra === null && stored && JSON.stringify(profile) === before) {
      return { profile: profile, extra: null };
    }
    profile.updatedAt = now;
    try {
      nk.storageWrite([{ collection: ECONOMY, key: PROFILE_KEY, userId: userId, value: profile, version: version, permissionRead: 1, permissionWrite: 0 }]);
      return { profile: profile, extra: extra };
    } catch (e) {
      lastError = e; // version conflict: somebody changed it in between, read again
    }
  }
  throw lastError || new Error("could not save the profile");
}

// The profile as the client sees it (without the server's bookkeeping).
function publicProfile(profile) {
  var out = {};
  for (var key in profile) {
    if (Object.prototype.hasOwnProperty.call(profile, key) && key !== "paid") {
      out[key] = profile[key];
    }
  }
  return out;
}

function profileReply(status, profile, extra) {
  var out = { status: status, profile: publicProfile(profile), prices: OPERATOR_PRICES, tables: PROGRESSION_TABLES, seasonTier: seasonTier(profile), serverTime: Date.now() };
  if (extra) {
    for (var key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) {
        out[key] = extra[key];
      }
    }
  }
  return JSON.stringify(out);
}

function requireUser(ctx) {
  if (!ctx.userId) {
    throw new Error("authentication required");
  }
}

function currentProfile(nk, userId) {
  return mutateProfile(nk, userId, function () { return null; }).profile;
}

function rpcProfile(ctx, logger, nk, payload) {
  requireUser(ctx);
  return profileReply("ok", currentProfile(nk, ctx.userId));
}

function rpcBuyOperator(ctx, logger, nk, payload) {
  requireUser(ctx);
  var request = payload ? JSON.parse(payload) : {};
  var operatorId = request.operatorId ? String(request.operatorId) : "";
  if (!Object.prototype.hasOwnProperty.call(OPERATOR_PRICES, operatorId)) {
    return profileReply("unknown_operator", currentProfile(nk, ctx.userId));
  }
  var price = OPERATOR_PRICES[operatorId];
  var status = "ok";
  var done = mutateProfile(nk, ctx.userId, function (profile) {
    status = "ok";
    if (profile.operators.indexOf(operatorId) >= 0) {
      status = "already_owned";
      return null;
    }
    if (profile.coins < price) {
      status = "insufficient_coins";
      return null;
    }
    profile.coins -= price;
    profile.operators.push(operatorId);
    return {};
  });
  if (status === "ok") {
    logger.info("railbound_buy_operator: %s bought %s for %d coins", ctx.userId, operatorId, price);
  }
  return profileReply(status, done.profile);
}

function challengeDef(tab, key) {
  var defs = CHALLENGE_DEFS[tab];
  if (!defs) {
    return null;
  }
  for (var i = 0; i < defs.length; i++) {
    if (defs[i].key === key) {
      return defs[i];
    }
  }
  return null;
}

function rpcClaimChallenge(ctx, logger, nk, payload) {
  requireUser(ctx);
  var request = payload ? JSON.parse(payload) : {};
  var tab = request.tab ? String(request.tab) : "";
  var key = request.key ? String(request.key) : "";
  var def = Object.prototype.hasOwnProperty.call(CHALLENGE_DEFS, tab) ? challengeDef(tab, key) : null;
  if (!def) {
    return profileReply("unknown_challenge", currentProfile(nk, ctx.userId));
  }
  var status = "ok";
  var done = mutateProfile(nk, ctx.userId, function (profile) {
    status = "ok";
    var items = profile.challenges[tab].items;
    var entry = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].key === key) { entry = items[i]; }
    }
    if (!entry) { status = "unknown_challenge"; return null; }
    if (entry.claimed) { status = "already_claimed"; return null; }
    if (entry.progress < def.goal) { status = "not_complete"; return null; }
    entry.claimed = true;
    return { award: grantXp(profile, def.xp, def.coins) };
  });
  return profileReply(status, done.profile, done.extra);
}

function clampInt(value, min, max) {
  var n = Math.floor(Number(value));
  if (!isFinite(n)) { n = min; }
  return Math.max(min, Math.min(max, n));
}

// Counts one match towards the open challenges of the profile.
function countChallenges(profile, won, kills, survivedSeconds, placement) {
  for (var t = 0; t < CHALLENGE_TABS.length; t++) {
    var tab = CHALLENGE_TABS[t];
    var defs = CHALLENGE_DEFS[tab];
    var items = profile.challenges[tab].items;
    for (var i = 0; i < defs.length; i++) {
      var entry = items[i];
      if (entry.claimed || entry.progress >= defs[i].goal) { continue; }
      var add = 0;
      switch (defs[i].metric) {
        case "matches": add = 1; break;
        case "wins": add = won ? 1 : 0; break;
        case "kills": add = kills; break;
        case "surviveMinutes": add = Math.floor(survivedSeconds / 60); break;
        case "top5": add = placement <= 5 ? 1 : 0; break;
      }
      entry.progress = Math.min(defs[i].goal, entry.progress + add);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Progression: weapon mastery, the battle royale loadout, ability upgrades and the season battle pass.
// Every rule lives here; the client gets the tables with the profile and never decides a value.
//   railbound_set_loadout    player -> starting sidearm / melee / lethal, each gated by player level
//   railbound_upgrade_skill  player -> next level of Sonar or Medkit for coins (server prices, level gates)
//   railbound_claim_tier     player -> coins of a reached battle pass tier (once)
//   railbound_report_match   server -> also { weaponKills: { weaponId: kills } }: XP for the weapons that got the kills
// ---------------------------------------------------------------------------------------------------------------------
var WEAPON_DEFS = {
  p226: "P226", p226dual: "P226 DUAL", ump: "UMP", benelli: "BENELLI M4", m82: "M82",
  bat: "BASEBALL BAT", katana: "KATANA", grenade: "GRENADE"
};
var WEAPON_XP_PER_KILL = 100;
var WEAPON_MAX_LEVEL = 20;

function xpForWeaponLevel(level) {
  return 300 + (level - 1) * 150;
}

// XP needed to go from level n to n+1, for n = 1 .. max-1 (the client draws the progress bars from it)
function weaponLevelTable() {
  var out = [];
  for (var l = 1; l < WEAPON_MAX_LEVEL; l++) { out.push(xpForWeaponLevel(l)); }
  return out;
}

// what the player can start a match with; primaries are never chosen (they are loot in a battle royale)
var LOADOUT_SLOTS = {
  sidearm: { p226: 1, p226dual: 5 },
  melee: { none: 1, bat: 1, katana: 3 },
  lethal: { none: 1, grenade: 8 }
};
var DEFAULT_LOADOUT = { sidearm: "p226", melee: "none", lethal: "none" };

// level n of a skill costs costs[n-1] coins and needs player level requiredLevel[n-1]; effects[n] is what that level does
var SKILL_DEFS = {
  sonar: {
    name: "SONAR PULSE", maxLevel: 3, costs: [1000, 2500, 5000], requiredLevel: [2, 6, 12],
    effects: [
      { radius: 140, cooldown: 10, charges: 3 }, { radius: 170, cooldown: 9, charges: 3 },
      { radius: 200, cooldown: 8, charges: 4 }, { radius: 240, cooldown: 7, charges: 5 }
    ]
  },
  medkit: {
    name: "FIELD MEDKIT", maxLevel: 3, costs: [1000, 2500, 5000], requiredLevel: [3, 8, 15],
    effects: [
      { heal: 120, starting: 2, carry: 10 }, { heal: 135, starting: 3, carry: 10 },
      { heal: 150, starting: 3, carry: 12 }, { heal: 170, starting: 4, carry: 12 }
    ]
  }
};

var BP_TIERS = 40;
var BP_XP_PER_TIER = 1000;

// free track: coins on even tiers (more on every tenth), a cosmetic preview on odd tiers; premium: previews only (not on sale yet)
function battlePassRewards() {
  var cosmetics = ["EMBLEM", "CALLING CARD", "WEAPON CHARM", "OPERATOR LOOK", "STICKER"];
  var tiers = [];
  for (var t = 1; t <= BP_TIERS; t++) {
    var free = t % 2 === 0
      ? { type: "coins", amount: t % 10 === 0 ? 1000 : 250 }
      : { type: "cosmetic", kind: cosmetics[(t >> 1) % cosmetics.length], rarity: t % 5 === 0 ? "RARE" : "COMMON" };
    var premium = { type: "cosmetic", kind: cosmetics[(t + 2) % cosmetics.length], rarity: t % 10 === 0 ? "LEGENDARY" : t % 5 === 0 ? "EPIC" : "RARE" };
    tiers.push({ tier: t, free: free, premium: premium });
  }
  return tiers;
}
var BP_REWARDS = battlePassRewards();

var PROGRESSION_TABLES = {
  weapons: WEAPON_DEFS, weaponXpPerKill: WEAPON_XP_PER_KILL, weaponMaxLevel: WEAPON_MAX_LEVEL, weaponLevelXp: weaponLevelTable(),
  loadoutSlots: LOADOUT_SLOTS, defaultLoadout: DEFAULT_LOADOUT, skills: SKILL_DEFS,
  season: { id: SEASON_ID, tiers: BP_TIERS, xpPerTier: BP_XP_PER_TIER, rewards: BP_REWARDS }
};

// fields older profiles do not have yet
function normalizeProgression(profile) {
  if (!profile.weapons) { profile.weapons = {}; }
  if (!profile.loadout) { profile.loadout = { sidearm: DEFAULT_LOADOUT.sidearm, melee: DEFAULT_LOADOUT.melee, lethal: DEFAULT_LOADOUT.lethal }; }
  if (!profile.skills) { profile.skills = { sonar: 0, medkit: 0 }; }
  if (!profile.season || profile.season.id !== SEASON_ID) { profile.season = { id: SEASON_ID, xp: 0, claimed: [] }; }
}

function seasonTier(profile) {
  return Math.min(BP_TIERS, Math.floor((profile.season ? profile.season.xp : 0) / BP_XP_PER_TIER) + 1);
}

// weapon XP for kills; returns what changed, for the match result screen
function grantWeaponKills(profile, weaponKills, maxKills) {
  var gained = [];
  // the game server sends a list [{ weapon, kills }] (Unity's JsonUtility has no dictionaries); a map { id: kills } works too
  if (weaponKills && Object.prototype.toString.call(weaponKills) === "[object Array]") {
    var asMap = {};
    for (var i = 0; i < weaponKills.length; i++) {
      var e = weaponKills[i] || {};
      if (e.weapon) { asMap[String(e.weapon)] = (asMap[String(e.weapon)] || 0) + clampInt(e.kills, 0, 100); }
    }
    weaponKills = asMap;
  }
  if (!weaponKills || typeof weaponKills !== "object") { return gained; }
  var budget = maxKills;
  for (var id in weaponKills) {
    if (!Object.prototype.hasOwnProperty.call(weaponKills, id) || !Object.prototype.hasOwnProperty.call(WEAPON_DEFS, id) || budget <= 0) { continue; }
    var kills = Math.min(clampInt(weaponKills[id], 0, 100), budget);
    if (kills <= 0) { continue; }
    budget -= kills;
    var w = profile.weapons[id] || { level: 1, xp: 0, kills: 0 };
    var oldLevel = w.level;
    w.kills += kills;
    if (w.level < WEAPON_MAX_LEVEL) {
      w.xp += kills * WEAPON_XP_PER_KILL;
      while (w.level < WEAPON_MAX_LEVEL && w.xp >= xpForWeaponLevel(w.level)) {
        w.xp -= xpForWeaponLevel(w.level);
        w.level++;
      }
      if (w.level >= WEAPON_MAX_LEVEL) { w.xp = 0; }
    }
    profile.weapons[id] = w;
    gained.push({ weapon: id, kills: kills, xp: kills * WEAPON_XP_PER_KILL, oldLevel: oldLevel, newLevel: w.level });
  }
  return gained;
}

function rpcSetLoadout(ctx, logger, nk, payload) {
  requireUser(ctx);
  var request = payload ? JSON.parse(payload) : {};
  var status = "ok", reason = "";
  var done = mutateProfile(nk, ctx.userId, function (profile) {
    status = "ok"; reason = "";
    normalizeProgression(profile);
    var next = { sidearm: profile.loadout.sidearm, melee: profile.loadout.melee, lethal: profile.loadout.lethal };
    for (var slot in LOADOUT_SLOTS) {
      if (!Object.prototype.hasOwnProperty.call(LOADOUT_SLOTS, slot) || request[slot] === undefined) { continue; }
      var item = String(request[slot]);
      var options = LOADOUT_SLOTS[slot];
      if (!Object.prototype.hasOwnProperty.call(options, item)) { status = "unknown_item"; reason = slot; return null; }
      if (profile.level < options[item]) { status = "locked"; reason = slot + ":" + options[item]; return null; }
      next[slot] = item;
    }
    if (next.sidearm === profile.loadout.sidearm && next.melee === profile.loadout.melee && next.lethal === profile.loadout.lethal) { return null; }
    profile.loadout = next;
    return {};
  });
  if (status === "ok") { logger.info("railbound_set_loadout: %s -> %s", ctx.userId, JSON.stringify(done.profile.loadout)); }
  return profileReply(status, done.profile, reason ? { reason: reason } : null);
}

function rpcUpgradeSkill(ctx, logger, nk, payload) {
  requireUser(ctx);
  var request = payload ? JSON.parse(payload) : {};
  var skillId = request.skill ? String(request.skill) : "";
  if (!Object.prototype.hasOwnProperty.call(SKILL_DEFS, skillId)) {
    return profileReply("unknown_skill", currentProfile(nk, ctx.userId));
  }
  var def = SKILL_DEFS[skillId];
  var status = "ok", paid = 0;
  var done = mutateProfile(nk, ctx.userId, function (profile) {
    status = "ok"; paid = 0;
    normalizeProgression(profile);
    var level = profile.skills[skillId] | 0;
    if (level >= def.maxLevel) { status = "max_level"; return null; }
    if (profile.level < def.requiredLevel[level]) { status = "locked"; return null; }
    if (profile.coins < def.costs[level]) { status = "insufficient_coins"; return null; }
    profile.coins -= def.costs[level];
    paid = def.costs[level];
    profile.skills[skillId] = level + 1;
    return {};
  });
  if (status === "ok") { logger.info("railbound_upgrade_skill: %s %s -> level %d for %d coins", ctx.userId, skillId, done.profile.skills[skillId], paid); }
  return profileReply(status, done.profile);
}

function rpcClaimTier(ctx, logger, nk, payload) {
  requireUser(ctx);
  var request = payload ? JSON.parse(payload) : {};
  var tier = request.tier | 0;
  if (tier < 1 || tier > BP_TIERS) {
    return profileReply("unknown_tier", currentProfile(nk, ctx.userId));
  }
  var reward = BP_REWARDS[tier - 1].free;
  var status = "ok";
  var done = mutateProfile(nk, ctx.userId, function (profile) {
    status = "ok";
    normalizeProgression(profile);
    if (reward.type !== "coins") { status = "not_claimable"; return null; }
    if (seasonTier(profile) < tier) { status = "not_reached"; return null; }
    if (profile.season.claimed.indexOf(tier) >= 0) { status = "already_claimed"; return null; }
    profile.season.claimed.push(tier);
    profile.coins += reward.amount;
    return {};
  });
  if (status === "ok") { logger.info("railbound_claim_tier: %s claimed tier %d (%d coins)", ctx.userId, tier, reward.amount); }
  return profileReply(status, done.profile, { tier: tier });
}

// Called by the dedicated game server when a match is over: one entry per human player. The client is never asked.
// Payload: { matchId, players: [ { userId, placement, totalPlayers, kills, survivedSeconds } ] }
function rpcReportMatch(ctx, logger, nk, payload) {
  requireServerCall(ctx);
  var request = payload ? JSON.parse(payload) : {};
  var matchId = request.matchId ? String(request.matchId) : "";
  var players = request.players;
  if (!matchId || matchId.length > 100 || !players || !players.length || players.length > 100) {
    throw new Error("matchId and 1-100 players are required");
  }

  var results = [];
  for (var p = 0; p < players.length; p++) {
    var entry = players[p] || {};
    var userId = entry.userId ? String(entry.userId) : "";
    if (!userId || userId.length > 64) {
      results.push({ userId: userId, status: "bad_user" });
      continue;
    }
    try {
      // only players who were really sent to this match (railbound_allocate) can be paid for it
      if (!readJoin(nk, matchId, userId)) {
        results.push({ userId: userId, status: "not_in_match" });
        continue;
      }

      var totalPlayers = clampInt(entry.totalPlayers, 1, 100);
      var placement = clampInt(entry.placement, 1, totalPlayers);
      var kills = clampInt(entry.kills, 0, Math.max(0, totalPlayers - 1));
      var survived = clampInt(entry.survivedSeconds, 0, 7200);
      var reward = matchReward(placement, totalPlayers, kills, survived);
      var status = "paid";

      var done = mutateProfile(nk, userId, function (profile, now) {
        status = "paid";
        if (profile.paid.indexOf(matchId) >= 0) {
          status = "duplicate";
          return null;
        }
        profile.paid.push(matchId);
        while (profile.paid.length > MAX_PAID_MATCHES) { profile.paid.shift(); }

        var won = placement === 1;
        profile.matches++;
        if (won) { profile.wins++; }
        profile.kills += kills;
        profile.playSeconds += survived;
        if (profile.bestPlacement === 0 || placement < profile.bestPlacement) { profile.bestPlacement = placement; }
        countChallenges(profile, won, kills, survived, placement);

        var award = grantXp(profile, reward.xp, reward.coins);
        var weaponAward = grantWeaponKills(profile, entry.weaponKills, kills);
        profile.lastAward = {
          matchId: matchId, xp: award.xp, coins: award.coins, levelBonusCoins: award.levelBonusCoins,
          oldLevel: award.oldLevel, newLevel: award.newLevel,
          placement: placement, totalPlayers: totalPlayers, kills: kills, survivedSeconds: survived, at: now,
          weapons: weaponAward, seasonTier: seasonTier(profile)
        };
        return { award: award };
      });
      results.push({ userId: userId, status: status, xp: done.extra ? done.extra.award.xp : 0, coins: done.extra ? done.extra.award.coins : 0 });
    } catch (e) {
      logger.error("railbound_report_match: %s in %s: %s", userId, matchId, e.message);
      results.push({ userId: userId, status: "error" });
    }
  }
  try {
    var record = readMatch(nk, matchId);
    if (record && record.value && record.value.status !== "completed") {
      record.value.status = "completed";
      record.value.completedAt = Date.now();
      writeMatch(nk, matchId, record.value, record.version);
      logger.info("railbound_report_match: match %s -> COMPLETED", matchId);
    }
  } catch (e) {
    logger.warn("railbound_report_match: could not mark %s completed: %s", matchId, e.message);
  }
  logger.info("railbound_report_match: match %s, %d player(s) reported", matchId, players.length);
  return JSON.stringify({ status: "ok", results: results });
}

// ---------------------------------------------------------------------------------------------------------------------
// Server-authoritative matchmaking queue
// ---------------------------------------------------------------------------------------------------------------------
// Every queue session is an AUTHORITATIVE Nakama match ("railbound_queue"). Nakama runs a session's join attempts, joins, leaves and
// ticks one after the other on one thread, so "the countdown ended" and "a player joins" can never interleave: the roster is locked
// atomically. Its life:
//   WAITING      created, nobody in it yet
//   COUNTDOWN    the first player joined; QUEUE_COUNTDOWN_MS on the SERVER clock (clients only display it)
//   LOCKED       countdown over (or the session is full): the roster is final, joins are refused, the label says closed
//   STARTING     a new match id (uuid) is created and a game server is allocated for exactly the locked roster
//   IN_PROGRESS  every roster member got its own assignment (server address + its own join ticket); the session ends shortly after
//   COMPLETED    set on the match record when the game server reports the result (railbound_report_match)
//   FAILED       no game server could be allocated: the players are told and can queue again
// A player who queues while a session is locking or started gets a NEW session (never an existing match). A player can be in one
// session only (a per-player record, written with optimistic concurrency). Match ids are made here, never by a client.
var QUEUE_MODULE = "railbound_queue";
var QUEUE_OPEN_COLLECTION = "railbound_queue_open";     // system: mode -> the one open session (versioned, so two creators cannot both win)
var QUEUE_USER_COLLECTION = "railbound_queue_user";     // per player: the session (and later the match) the player is in
var QUEUE_COUNTDOWN_MS = 30000;
var QUEUE_MAX_PLAYERS = 10;
var QUEUE_TICK_RATE = 2;
var QUEUE_EMPTY_LIFETIME_MS = 60000;                    // a session nobody joined ends after this
var QUEUE_LINGER_MS = 20000;                            // after the assignment, so a slow client still receives it
var QUEUE_ALLOC_RETRY_MS = 2000;
var QUEUE_ALLOC_MAX_ATTEMPTS = 15;
var QUEUE_RECONNECT_MS = 15 * 60000;                    // a locked-in player may get its assignment again this long after the start
var OP_QUEUE_STATE = 1, OP_QUEUE_ASSIGNED = 2, OP_QUEUE_FAILED = 3;

// runtime.env QUEUE_COUNTDOWN_SECONDS (5-120) overrides the 30 s countdown (tests, events)
function queueCountdownMs(ctx) {
  var seconds = parseInt(envOr(ctx, "QUEUE_COUNTDOWN_SECONDS", ""), 10);
  return seconds >= 5 && seconds <= 120 ? seconds * 1000 : QUEUE_COUNTDOWN_MS;
}

function queueModeOf(value) {
  var mode = value ? String(value).toLowerCase() : "br_solo";
  return /^[a-z0-9_-]{1,32}$/.test(mode) ? mode : "br_solo";
}

function queueMemberCount(state) {
  var n = 0;
  for (var id in state.members) { if (Object.prototype.hasOwnProperty.call(state.members, id)) { n++; } }
  return n;
}

function queueLabel(state) {
  var open = state.phase === "WAITING" || state.phase === "COUNTDOWN" ? 1 : 0;
  return JSON.stringify({ mode: state.mode, open: open, phase: state.phase, players: queueMemberCount(state) });
}

function queueSetPhase(state, logger, dispatcher, phase, why) {
  if (state.phase === phase) { return; }
  logger.info("queue %s: %s -> %s (%s) players=%d match=%s", state.sessionId, state.phase, phase, why, queueMemberCount(state), state.gameMatchId || "-");
  state.phase = phase;
  if (dispatcher) { dispatcher.matchLabelUpdate(queueLabel(state)); }
}

function queueBroadcastState(state, dispatcher, now) {
  var left = state.phase === "COUNTDOWN" ? Math.max(0, Math.ceil((state.countdownEndsAt - now) / 1000)) : 0;
  dispatcher.broadcastMessage(OP_QUEUE_STATE, JSON.stringify({ sessionId: state.sessionId, phase: state.phase, countdown: left, players: queueMemberCount(state), max: QUEUE_MAX_PLAYERS }), null, null, true);
}

function readQueueUser(nk, userId) {
  var objects = nk.storageRead([{ collection: QUEUE_USER_COLLECTION, key: "current", userId: userId }]);
  return objects && objects.length > 0 ? objects[0] : null;
}

function clearQueueUser(nk, userId, sessionId) {
  try {
    var rec = readQueueUser(nk, userId);
    if (rec && rec.value && rec.value.sessionId === sessionId && !rec.value.matchId) {
      nk.storageDelete([{ collection: QUEUE_USER_COLLECTION, key: "current", userId: userId, version: rec.version }]);
    }
  } catch (e) { /* another writer won: the record is newer than this session */ }
}

// is that session still accepting players? (nk.matchGet returns null for a session that ended)
function queueSessionOpen(nk, sessionId) {
  if (!sessionId) { return false; }
  var m = null;
  try { m = nk.matchGet(sessionId); } catch (e) { return false; }
  if (!m || !m.label) { return false; }
  try {
    var label = JSON.parse(m.label);
    return label.open === 1 && label.players < QUEUE_MAX_PLAYERS;
  } catch (e) { return false; }
}

function queueSessionAlive(nk, sessionId) {
  try { return !!(sessionId && nk.matchGet(sessionId)); } catch (e) { return false; }
}

function queueInit(ctx, logger, nk, params) {
  var now = Date.now();
  var state = {
    sessionId: ctx.matchId, mode: queueModeOf(params && params.mode), phase: "WAITING", created: now,
    countdownEndsAt: 0, members: {}, roster: [], gameMatchId: "", server: null, allocAttempts: 0, nextAllocAt: 0, endAt: 0, lastBroadcast: 0,
    countdownMs: queueCountdownMs(ctx)
  };
  logger.info("queue %s: created for mode %s", ctx.matchId, state.mode);
  return { state: state, tickRate: QUEUE_TICK_RATE, label: queueLabel(state) };
}

function queueJoinAttempt(ctx, logger, nk, dispatcher, tick, state, presence, metadata) {
  var userId = presence.userId;
  if (state.phase !== "WAITING" && state.phase !== "COUNTDOWN") {
    // a locked-in player whose connection dropped may come back to receive its assignment; nobody else
    if (state.members[userId] && (state.phase === "LOCKED" || state.phase === "STARTING" || state.phase === "IN_PROGRESS")) {
      return { state: state, accept: true };
    }
    logger.info("queue %s: refused %s, session is %s", state.sessionId, userId, state.phase);
    return { state: state, accept: false, rejectMessage: "SESSION_LOCKED" };
  }
  if (!state.members[userId] && queueMemberCount(state) >= QUEUE_MAX_PLAYERS) {
    return { state: state, accept: false, rejectMessage: "SESSION_FULL" };
  }
  // one session per player: the per-player record must point here, or be free / stale
  var rec = null;
  try { rec = readQueueUser(nk, userId); } catch (e) { rec = null; }
  if (rec && rec.value && rec.value.sessionId && rec.value.sessionId !== state.sessionId && !rec.value.matchId && queueSessionOpen(nk, rec.value.sessionId)) {
    logger.info("queue %s: refused %s, already queued in %s", state.sessionId, userId, rec.value.sessionId);
    return { state: state, accept: false, rejectMessage: "ALREADY_QUEUED" };
  }
  if (!rec || !rec.value || rec.value.sessionId !== state.sessionId || rec.value.matchId) {
    try {
      nk.storageWrite([{ collection: QUEUE_USER_COLLECTION, key: "current", userId: userId, value: { sessionId: state.sessionId, mode: state.mode, at: Date.now() }, permissionRead: 1, permissionWrite: 0, version: rec ? rec.version : "*" }]);
    } catch (e) {
      return { state: state, accept: false, rejectMessage: "RETRY" };   // a concurrent queue request of the same player won
    }
  }
  return { state: state, accept: true };
}

function queueJoin(ctx, logger, nk, dispatcher, tick, state, presences) {
  var now = Date.now();
  for (var i = 0; i < presences.length; i++) {
    var p = presences[i];
    var known = state.members[p.userId];
    if (known) {
      known.presence = p;   // reconnect of a member (before or after the lock)
      logger.info("queue %s: %s reconnected", state.sessionId, p.userId);
      if (state.phase === "IN_PROGRESS" && state.server) {
        dispatcher.broadcastMessage(OP_QUEUE_ASSIGNED, queueAssignment(nk, state, p.userId), [p], null, true);
      }
      continue;
    }
    state.members[p.userId] = { presence: p, joinedAt: now };
    logger.info("queue %s: + %s (%s), players=%d", state.sessionId, p.userId, p.username, queueMemberCount(state));
  }
  if (state.phase === "WAITING" && queueMemberCount(state) > 0) {
    state.countdownEndsAt = now + state.countdownMs;
    queueSetPhase(state, logger, dispatcher, "COUNTDOWN", "first player");
  }
  dispatcher.matchLabelUpdate(queueLabel(state));
  queueBroadcastState(state, dispatcher, now);
  return { state: state };
}

function queueLeave(ctx, logger, nk, dispatcher, tick, state, presences) {
  for (var i = 0; i < presences.length; i++) {
    var p = presences[i];
    var m = state.members[p.userId];
    if (!m || !m.presence || m.presence.sessionId !== p.sessionId) { continue; }   // an older connection of a player who reconnected
    if (state.phase === "WAITING" || state.phase === "COUNTDOWN") {
      delete state.members[p.userId];
      clearQueueUser(nk, p.userId, state.sessionId);
      logger.info("queue %s: - %s left before the lock, players=%d", state.sessionId, p.userId, queueMemberCount(state));
    } else {
      m.presence = null;   // locked in: keeps the seat; railbound_queue_join gives the assignment back on reconnect
      logger.info("queue %s: %s disconnected after the lock (keeps the seat in %s)", state.sessionId, p.userId, state.gameMatchId || "-");
    }
  }
  if (dispatcher) { dispatcher.matchLabelUpdate(queueLabel(state)); }
  return { state: state };
}

function queueAssignment(nk, state, userId) {
  return JSON.stringify({ sessionId: state.sessionId, matchId: state.gameMatchId, host: state.server.host, port: state.server.port, name: state.server.name, token: issueJoinToken(nk, state.gameMatchId, userId), players: state.roster.length });
}

function queueLock(ctx, logger, nk, dispatcher, state, why) {
  state.roster = [];
  for (var id in state.members) { if (Object.prototype.hasOwnProperty.call(state.members, id)) { state.roster.push(id); } }
  state.gameMatchId = nk.uuidv4();
  queueSetPhase(state, logger, dispatcher, "LOCKED", why);
  writeMatch(nk, state.gameMatchId, { status: "allocating", at: Date.now(), by: "queue", sessionId: state.sessionId, mode: state.mode, roster: state.roster }, "*");
  // the per-player records now point at the match: a reconnecting player gets its assignment, a new request opens a new session
  for (var r = 0; r < state.roster.length; r++) {
    try {
      nk.storageWrite([{ collection: QUEUE_USER_COLLECTION, key: "current", userId: state.roster[r], value: { sessionId: state.sessionId, matchId: state.gameMatchId, mode: state.mode, at: Date.now() }, permissionRead: 1, permissionWrite: 0 }]);
    } catch (e) { logger.warn("queue %s: could not record %s: %s", state.sessionId, state.roster[r], e.message); }
  }
  logger.info("queue %s: LOCKED roster=[%s] -> match %s", state.sessionId, state.roster.join(","), state.gameMatchId);
  queueSetPhase(state, logger, dispatcher, "STARTING", "allocating a game server");
  state.nextAllocAt = 0;
}

function queueLoop(ctx, logger, nk, dispatcher, tick, state, messages) {
  var now = Date.now();
  var count = queueMemberCount(state);

  if (state.phase === "WAITING" && now - state.created > QUEUE_EMPTY_LIFETIME_MS) {
    logger.info("queue %s: ended, nobody joined", state.sessionId);
    return null;
  }
  if (state.phase === "COUNTDOWN") {
    if (count === 0) {
      logger.info("queue %s: ended, everybody left before the lock", state.sessionId);
      return null;
    }
    if (now >= state.countdownEndsAt) { queueLock(ctx, logger, nk, dispatcher, state, "countdown ended"); }
    else if (count >= QUEUE_MAX_PLAYERS) { queueLock(ctx, logger, nk, dispatcher, state, "session full"); }
  }
  if (state.phase === "STARTING" && now >= state.nextAllocAt) {
    state.allocAttempts++;
    var server = null;
    try { server = allocateGameServer(ctx, nk, state.gameMatchId, state.roster.length); }
    catch (e) { logger.error("queue %s: allocation attempt %d failed: %s", state.sessionId, state.allocAttempts, e.message); }
    if (server) {
      state.server = server;
      writeMatch(nk, state.gameMatchId, { status: "ready", at: now, startedAt: now, host: server.host, port: server.port, name: server.name, by: "queue", sessionId: state.sessionId, mode: state.mode, roster: state.roster });
      logger.info("queue %s: match %s -> %s:%d (%s) for %d player(s)", state.sessionId, state.gameMatchId, server.host, server.port, server.name, state.roster.length);
      for (var i = 0; i < state.roster.length; i++) {
        var m = state.members[state.roster[i]];
        if (m && m.presence) {
          dispatcher.broadcastMessage(OP_QUEUE_ASSIGNED, queueAssignment(nk, state, state.roster[i]), [m.presence], null, true);
          logger.info("queue %s: assigned %s to match %s", state.sessionId, state.roster[i], state.gameMatchId);
        }
      }
      queueSetPhase(state, logger, dispatcher, "IN_PROGRESS", "assignments sent");
      state.endAt = now + QUEUE_LINGER_MS;
    } else if (state.allocAttempts >= QUEUE_ALLOC_MAX_ATTEMPTS) {
      writeMatch(nk, state.gameMatchId, { status: "failed", at: now, by: "queue", sessionId: state.sessionId, roster: state.roster });
      for (var f = 0; f < state.roster.length; f++) {
        try { nk.storageDelete([{ collection: QUEUE_USER_COLLECTION, key: "current", userId: state.roster[f] }]); } catch (e) { }
      }
      dispatcher.broadcastMessage(OP_QUEUE_FAILED, JSON.stringify({ sessionId: state.sessionId, matchId: state.gameMatchId, reason: "servers_busy" }), null, null, true);
      queueSetPhase(state, logger, dispatcher, "FAILED", "no game server after " + state.allocAttempts + " attempts");
      state.endAt = now + 3000;
    } else {
      state.nextAllocAt = now + QUEUE_ALLOC_RETRY_MS;
    }
  }
  if ((state.phase === "IN_PROGRESS" || state.phase === "FAILED") && now >= state.endAt) {
    logger.info("queue %s: session closed (%s)", state.sessionId, state.phase);
    return null;
  }
  if (now - state.lastBroadcast >= 1000 && count > 0) {
    state.lastBroadcast = now;
    queueBroadcastState(state, dispatcher, now);
  }
  return { state: state };
}

function queueTerminate(ctx, logger, nk, dispatcher, tick, state, graceSeconds) {
  logger.info("queue %s: terminated by the server (phase %s)", state.sessionId, state.phase);
  return { state: state };
}

function queueSignal(ctx, logger, nk, dispatcher, tick, state, data) {
  return { state: state, data: queueLabel(state) };
}

// Player: put me into a matchmaking session. Payload { mode }. Replies
//   { status: "queued", sessionId }              join that authoritative match over the socket and wait for its messages
//   { status: "assigned", matchId, host, ... }   already locked into a running match (reconnect): go to that game server
function rpcQueueJoin(ctx, logger, nk, payload) {
  requireUser(ctx);
  var request = payload ? JSON.parse(payload) : {};
  var mode = queueModeOf(request.mode);

  // 1. the player is already in a session, or locked into a match
  var rec = readQueueUser(nk, ctx.userId);
  if (rec && rec.value) {
    if (rec.value.matchId) {
      var match = readMatch(nk, rec.value.matchId);
      var mv = match ? match.value : null;
      var inRoster = mv && mv.roster && mv.roster.indexOf(ctx.userId) >= 0;
      if (inRoster && mv.status === "ready" && Date.now() - (mv.startedAt || 0) < QUEUE_RECONNECT_MS && !request.newMatch) {
        logger.info("queue: %s gets its running match %s again (reconnect)", ctx.userId, rec.value.matchId);
        return result("assigned", { matchId: rec.value.matchId, host: mv.host, port: mv.port, name: mv.name, token: issueJoinToken(nk, rec.value.matchId, ctx.userId), players: mv.roster.length });
      }
      if (inRoster && mv.status === "allocating" && queueSessionAlive(nk, rec.value.sessionId)) {
        return result("queued", { sessionId: rec.value.sessionId, locked: true });   // its session is still allocating: rejoin for the assignment
      }
    } else if (rec.value.mode === mode && queueSessionOpen(nk, rec.value.sessionId)) {
      return result("queued", { sessionId: rec.value.sessionId });
    }
  }

  // 2. the open session of this mode, or a new one. The pointer is written with its version: of two players who both find no
  //    open session and both create one, only one pointer write succeeds; the other player uses the winner's session.
  for (var attempt = 0; attempt < 4; attempt++) {
    var objects = nk.storageRead([{ collection: QUEUE_OPEN_COLLECTION, key: mode, userId: SYSTEM_USER }]);
    var pointer = objects && objects.length > 0 ? objects[0] : null;
    if (pointer && pointer.value && queueSessionOpen(nk, pointer.value.sessionId)) {
      return result("queued", { sessionId: pointer.value.sessionId });
    }
    var sessionId = nk.matchCreate(QUEUE_MODULE, { mode: mode });
    try {
      nk.storageWrite([{ collection: QUEUE_OPEN_COLLECTION, key: mode, userId: SYSTEM_USER, value: { sessionId: sessionId, at: Date.now() }, permissionRead: 0, permissionWrite: 0, version: pointer ? pointer.version : "*" }]);
      logger.info("queue: %s opened session %s for mode %s", ctx.userId, sessionId, mode);
      return result("queued", { sessionId: sessionId });
    } catch (e) {
      // another request opened a session at the same time: ours stays empty and ends by itself; use theirs
      logger.info("queue: session %s lost the race for mode %s, retrying", sessionId, mode);
    }
  }
  throw new Error("could not open a matchmaking session");
}

function InitModule(ctx, logger, nk, initializer) {
  initializer.registerRpc("railbound_allocate", rpcAllocate);
  initializer.registerRpc("railbound_validate_join", rpcValidateJoin);
  initializer.registerRpc("railbound_profile", rpcProfile);
  initializer.registerRpc("railbound_buy_operator", rpcBuyOperator);
  initializer.registerRpc("railbound_claim_challenge", rpcClaimChallenge);
  initializer.registerRpc("railbound_report_match", rpcReportMatch);
  initializer.registerRpc("railbound_queue_join", rpcQueueJoin);
  initializer.registerRpc("railbound_set_loadout", rpcSetLoadout);
  initializer.registerRpc("railbound_upgrade_skill", rpcUpgradeSkill);
  initializer.registerRpc("railbound_claim_tier", rpcClaimTier);
  initializer.registerMatch(QUEUE_MODULE, {
    matchInit: queueInit,
    matchJoinAttempt: queueJoinAttempt,
    matchJoin: queueJoin,
    matchLeave: queueLeave,
    matchLoop: queueLoop,
    matchTerminate: queueTerminate,
    matchSignal: queueSignal
  });
  logger.info("Railbound module loaded: RPCs railbound_allocate, railbound_validate_join, railbound_profile, railbound_buy_operator, railbound_claim_challenge, railbound_report_match, railbound_queue_join, railbound_set_loadout, railbound_upgrade_skill, railbound_claim_tier and the railbound_queue match handler registered.");
}
