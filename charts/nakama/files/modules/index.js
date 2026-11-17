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
    if (Object.prototype.hasOwnProperty.call(profile, key) && key !== "paid" && key !== "lbPaid") {
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

// leaderboards, notifications and the victory feed for one paid player; failures here never undo the payment
function afterMatchPaid(nk, logger, userId, extra, kills, profile) {
  var username = "";
  try {
    var users = nk.usersGetId([userId]);
    username = users && users.length > 0 ? users[0].username : "";
  } catch (e) {
    logger.warn("report: no account for %s: %s", userId, e.message);
  }
  writeMatchScores(nk, logger, userId, username, extra.level, extra.won, kills, extra.award.xp);
  matchNotifications(nk, logger, userId, extra.award, extra.oldTier, extra.newTier, profile);
  if (extra.won && username) {
    systemChat(nk, logger, "global", username + " won a match with " + kills + " kill" + (kills === 1 ? "" : "s"), "victory");
  }
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

        var oldTier = seasonTier(profile);
        var award = grantXp(profile, reward.xp, reward.coins);
        var weaponAward = grantWeaponKills(profile, entry.weaponKills, kills);
        profile.lastAward = {
          matchId: matchId, xp: award.xp, coins: award.coins, levelBonusCoins: award.levelBonusCoins,
          oldLevel: award.oldLevel, newLevel: award.newLevel,
          placement: placement, totalPlayers: totalPlayers, kills: kills, survivedSeconds: survived, at: now,
          weapons: weaponAward, seasonTier: seasonTier(profile)
        };
        return { award: award, oldTier: oldTier, newTier: seasonTier(profile), won: won, level: profile.level };
      });
      if (status === "paid" && done.extra) {
        afterMatchPaid(nk, logger, userId, done.extra, kills, done.profile);
      }
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
// Social platform: leaderboards, notifications (inbox, gifts, announcements) and chat moderation
// ---------------------------------------------------------------------------------------------------------------------
// Everything here is server-authoritative like the economy:
//   LEADERBOARDS   authoritative boards (a client can never write a score). Scores come ONLY from railbound_report_match (the game
//                  server). The weekly boards pay their top 3 in coins when they reset (idempotent, with a notification).
//     railbound_leaderboard        player -> { board?, scope: top | around_me | friends, limit, cursor } (no board: the catalog)
//     railbound_leaderboard_payout server -> { board, expiry } pays an ENDED period again if the reset hook failed (idempotent)
//   NOTIFICATIONS  a typed inbox (codes below). Match results, level-ups, weapon level-ups and battle pass tiers are sent by the
//                  match report; operations send announcements and claimable coin gifts.
//     railbound_inbox              player -> the persistent notifications, gifts marked claimed / expired
//     railbound_claim_gift         player -> { giftId } pays a gift once (it must be addressed to the player and not expired)
//     railbound_send_gift          server -> { giftId, coins, subject, message, userIds? (none = everybody), expiresInHours }
//     railbound_announce           server -> { subject, message, toChat } to everybody (and the global chat room)
//   CHAT           Nakama's realtime chat with hooks in front of it: only the rooms in CHAT_ROOMS, direct messages only between
//                  friends, a rate limit, duplicate spam blocking, a word / link filter, @mentions that notify the player, player
//                  reports that mute a player automatically, and mutes set by operations.
//     railbound_chat_report        player -> { channelId, messageId, reason } (the message must exist in that channel)
//     railbound_chat_mute          server -> { userId, minutes (0 = unmute), reason }
// "server" RPCs are rejected for any call with a user session: they need the HTTP key, like railbound_report_match.

// A storage value is a Go-backed object in this runtime: an array ASSIGNED to one of its properties is stored as a copy, so a push
// on that property afterwards is lost. Arrays are therefore built as plain JS arrays and assigned once, after the last change.
function jsArray(value) {
  return value ? Array.prototype.slice.call(value) : [];
}

// ---- notification codes (positive: Nakama reserves the negative ones, e.g. -2 friend request) ----
var NOTE_MATCH_RESULT = 100;
var NOTE_LEVEL_UP = 101;
var NOTE_WEAPON_LEVEL_UP = 102;
var NOTE_TIER_REACHED = 103;
var NOTE_LEADERBOARD_REWARD = 110;
var NOTE_GIFT = 120;
var NOTE_ANNOUNCEMENT = 130;
var NOTE_CHAT_MUTED = 140;
var NOTE_CHAT_MENTION = 141;

// ---- leaderboards ----
var LB_PREFIX = "railbound_";
var LEADERBOARDS = {
  weekly_kills: { title: "WEEKLY KILLS", weekly: true, payouts: [1000, 500, 250] },
  weekly_wins: { title: "WEEKLY WINS", weekly: true, payouts: [1000, 500, 250] },
  season_xp: { title: "SEASON XP", weekly: false, payouts: [] },
  alltime_kills: { title: "ALL-TIME KILLS", weekly: false, payouts: [] }
};
var WEEKLY_RESET_CRON = "0 0 * * 1";   // Monday 00:00 UTC (overridable for tests: env LEADERBOARD_WEEKLY_CRON)
var LB_MAX_LIMIT = 50;
var MAX_LB_PAID = 30;                   // leaderboard periods a profile remembers having been paid for

function leaderboardId(board) {
  return board === "season_xp" ? LB_PREFIX + "season_xp_" + SEASON_ID : LB_PREFIX + board;
}

function boardOfId(id) {
  for (var b in LEADERBOARDS) {
    if (Object.prototype.hasOwnProperty.call(LEADERBOARDS, b) && leaderboardId(b) === id) { return b; }
  }
  return null;
}

function createLeaderboards(ctx, logger, nk) {
  var weeklyCron = envOr(ctx, "LEADERBOARD_WEEKLY_CRON", WEEKLY_RESET_CRON);
  for (var board in LEADERBOARDS) {
    if (!Object.prototype.hasOwnProperty.call(LEADERBOARDS, board)) { continue; }
    var def = LEADERBOARDS[board];
    try {
      // authoritative, best first, scores add up; ranks on so the client gets real positions
      nk.leaderboardCreate(leaderboardId(board), true, "descending", "increment", def.weekly ? weeklyCron : null, { title: def.title }, true);
    } catch (e) {
      logger.error("leaderboard %s: %s", board, e.message);
    }
  }
}

// a score for one paid player of a match (called by railbound_report_match; never by a client)
function writeMatchScores(nk, logger, userId, username, level, won, kills, xp) {
  var meta = { level: level };
  var writes = [["alltime_kills", kills], ["weekly_kills", kills], ["weekly_wins", won ? 1 : 0], ["season_xp", xp]];
  for (var i = 0; i < writes.length; i++) {
    if (writes[i][1] <= 0) { continue; }
    try {
      nk.leaderboardRecordWrite(leaderboardId(writes[i][0]), userId, username, writes[i][1], 0, meta);
    } catch (e) {
      logger.warn("leaderboard %s write for %s: %s", writes[i][0], userId, e.message);
    }
  }
}

function recordOut(r, me) {
  var meta = r.metadata || {};
  return { rank: r.rank, userId: r.ownerId, username: r.username || "", score: r.score, level: meta.level || 0, isMe: r.ownerId === me };
}

function rpcLeaderboard(ctx, logger, nk, payload) {
  requireUser(ctx);
  var request = payload ? JSON.parse(payload) : {};
  if (!request.board) {
    var catalog = [];
    for (var b in LEADERBOARDS) {
      if (Object.prototype.hasOwnProperty.call(LEADERBOARDS, b)) {
        catalog.push({ board: b, title: LEADERBOARDS[b].title, weekly: LEADERBOARDS[b].weekly, payouts: LEADERBOARDS[b].payouts });
      }
    }
    return result("ok", { boards: catalog });
  }
  var board = String(request.board);
  if (!LEADERBOARDS[board]) { return result("unknown_board"); }
  var id = leaderboardId(board);
  var limit = clampInt(request.limit || 20, 1, LB_MAX_LIMIT);
  var scope = request.scope || "top";
  var me = ctx.userId;
  var records = [];
  var mine = null;
  var cursor = "";

  if (scope === "friends") {
    // the player and their mutual friends (state 0), ranked among themselves
    var owners = [me];
    var fl = nk.friendsList(me, 100, 0, "");
    var friends = fl && fl.friends ? fl.friends : [];
    for (var f = 0; f < friends.length; f++) {
      if (friends[f].user && friends[f].user.userId) { owners.push(friends[f].user.userId); }
    }
    var listed = nk.leaderboardRecordsList(id, owners, 0, "", 0);
    var own = listed && listed.ownerRecords ? listed.ownerRecords : [];
    own.sort(function (a, c) { return c.score - a.score || (a.updateTime < c.updateTime ? -1 : 1); });
    for (var o = 0; o < own.length && o < limit; o++) {
      var out = recordOut(own[o], me);
      out.globalRank = out.rank;
      out.rank = o + 1;
      records.push(out);
      if (out.isMe) { mine = out; }
    }
  } else if (scope === "around_me") {
    var hay = nk.leaderboardRecordsHaystack(id, me, limit, "", 0);
    var hr = hay && hay.records ? hay.records : [];
    for (var h = 0; h < hr.length; h++) {
      var ho = recordOut(hr[h], me);
      records.push(ho);
      if (ho.isMe) { mine = ho; }
    }
  } else {
    var top = nk.leaderboardRecordsList(id, [me], limit, request.cursor ? String(request.cursor) : "", 0);
    var tr = top && top.records ? top.records : [];
    for (var t = 0; t < tr.length; t++) { records.push(recordOut(tr[t], me)); }
    if (top && top.ownerRecords && top.ownerRecords.length > 0) { mine = recordOut(top.ownerRecords[0], me); }
    cursor = top && top.nextCursor ? top.nextCursor : "";
  }
  var lb = nk.leaderboardsGetId([id]);
  var resetsAt = lb && lb.length > 0 && lb[0].nextReset ? lb[0].nextReset : 0;
  return result("ok", { board: board, title: LEADERBOARDS[board].title, scope: scope, records: records, me: mine, nextCursor: cursor, resetsAt: resetsAt, payouts: LEADERBOARDS[board].payouts });
}

// pays the top of an ENDED period of a board (its records have expiry == `expiry`). A profile remembers the periods it was paid for,
// so the reset hook and a manual re-run can never pay twice.
function payLeaderboardPeriod(logger, nk, board, expiry) {
  var def = LEADERBOARDS[board];
  var paid = [];
  if (!def || !def.payouts || def.payouts.length === 0) { return paid; }
  var listed = nk.leaderboardRecordsList(leaderboardId(board), [], def.payouts.length, "", expiry);
  var records = listed && listed.records ? listed.records : [];
  var key = board + ":" + expiry;
  for (var i = 0; i < records.length && i < def.payouts.length; i++) {
    var r = records[i];
    var coins = def.payouts[i];
    var rank = i + 1;
    var status = "paid";
    try {
      mutateProfile(nk, r.ownerId, function (profile) {
        status = "paid";
        var lbPaid = jsArray(profile.lbPaid);
        if (lbPaid.indexOf(key) >= 0) { status = "already_paid"; return null; }
        lbPaid.push(key);
        while (lbPaid.length > MAX_LB_PAID) { lbPaid.shift(); }
        profile.lbPaid = lbPaid;
        profile.coins += coins;
        return {};
      });
      if (status === "paid") {
        notify(nk, logger, r.ownerId, NOTE_LEADERBOARD_REWARD, "#" + rank + " in " + def.title + ": +" + coins + " coins",
          { board: board, title: def.title, rank: rank, score: r.score, coins: coins, period: expiry });
      }
    } catch (e) {
      status = "error";
      logger.error("leaderboard payout %s #%d %s: %s", key, rank, r.ownerId, e.message);
    }
    paid.push({ userId: r.ownerId, rank: rank, score: r.score, coins: coins, status: status });
  }
  logger.info("leaderboard payout %s: %s", key, JSON.stringify(paid));
  return paid;
}

function onLeaderboardReset(ctx, logger, nk, leaderboard, reset) {
  var board = boardOfId(leaderboard.id);
  if (board) { payLeaderboardPeriod(logger, nk, board, reset); }
}

function rpcLeaderboardPayout(ctx, logger, nk, payload) {
  requireServerCall(ctx);
  var request = payload ? JSON.parse(payload) : {};
  var board = String(request.board || "");
  var expiry = request.expiry | 0;
  if (!LEADERBOARDS[board]) { return result("unknown_board"); }
  if (expiry <= 0 || expiry > Math.floor(Date.now() / 1000)) { return result("period_not_ended"); }
  return result("ok", { paid: payLeaderboardPeriod(logger, nk, board, expiry) });
}

// ---- notifications ----
function notify(nk, logger, userId, code, subject, content) {
  try {
    nk.notificationsSend([{ userId: userId, subject: subject, content: content, code: code, persistent: true }]);
  } catch (e) {
    logger.warn("notification %d to %s: %s", code, userId, e.message);
  }
}

// what one paid match produced, as a few typed notifications (sent after the profile was saved)
function matchNotifications(nk, logger, userId, award, oldTier, newTier, profile) {
  var notes = [];
  var a = profile.lastAward || {};
  notes.push({ userId: userId, code: NOTE_MATCH_RESULT, persistent: true,
    subject: a.placement === 1 ? "VICTORY - " + a.kills + " kills" : "#" + a.placement + " of " + a.totalPlayers + " - " + a.kills + " kills",
    content: { matchId: a.matchId, placement: a.placement, totalPlayers: a.totalPlayers, kills: a.kills, xp: award.xp, coins: award.coins + award.levelBonusCoins } });
  if (award.newLevel > award.oldLevel) {
    notes.push({ userId: userId, code: NOTE_LEVEL_UP, persistent: true, subject: "LEVEL " + award.newLevel + " REACHED",
      content: { oldLevel: award.oldLevel, newLevel: award.newLevel, bonusCoins: award.levelBonusCoins } });
  }
  var ups = [];
  var weapons = a.weapons || [];
  for (var i = 0; i < weapons.length; i++) {
    if (weapons[i].newLevel > weapons[i].oldLevel) { ups.push({ weapon: weapons[i].weapon, level: weapons[i].newLevel }); }
  }
  if (ups.length > 0) {
    notes.push({ userId: userId, code: NOTE_WEAPON_LEVEL_UP, persistent: true,
      subject: ups.length === 1 ? String(WEAPON_DEFS[ups[0].weapon] || ups[0].weapon).toUpperCase() + " LEVEL " + ups[0].level : ups.length + " WEAPONS LEVELED UP",
      content: { weapons: ups } });
  }
  if (newTier > oldTier) {
    var claimable = [];
    for (var t = oldTier + 1; t <= newTier; t++) {
      if (BP_REWARDS[t - 1] && BP_REWARDS[t - 1].free.type === "coins") { claimable.push(t); }
    }
    notes.push({ userId: userId, code: NOTE_TIER_REACHED, persistent: true,
      subject: "BATTLE PASS TIER " + newTier + (claimable.length > 0 ? " - " + claimable.length + " reward(s) to claim" : ""),
      content: { oldTier: oldTier, newTier: newTier, claimableTiers: claimable } });
  }
  try { nk.notificationsSend(notes); } catch (e) { logger.warn("match notifications for %s: %s", userId, e.message); }
}

var GIFT_COLLECTION = "railbound_gifts";
var MAX_GIFTS_REMEMBERED = 200;
var MAX_GIFT_COINS = 10000;

function readGift(nk, giftId) {
  var objects = nk.storageRead([{ collection: GIFT_COLLECTION, key: giftId, userId: SYSTEM_USER }]);
  return objects && objects.length > 0 ? objects[0].value : null;
}

function rpcSendGift(ctx, logger, nk, payload) {
  requireServerCall(ctx);
  var request = payload ? JSON.parse(payload) : {};
  var giftId = request.giftId ? String(request.giftId) : "";
  var coins = request.coins | 0;
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(giftId) || coins < 1 || coins > MAX_GIFT_COINS) {
    throw new Error("giftId ([A-Za-z0-9_.-], 3-64) and coins 1-" + MAX_GIFT_COINS + " are required");
  }
  var userIds = request.userIds && request.userIds.length ? request.userIds.slice(0, 500).map(String) : null;
  var hours = clampInt(request.expiresInHours || 168, 1, 24 * 30);
  var gift = {
    giftId: giftId, coins: coins, subject: String(request.subject || "A GIFT FROM RAILBOUND").substring(0, 80),
    message: String(request.message || "").substring(0, 300), audience: userIds ? userIds : "all",
    createdAt: Date.now(), expiresAt: Date.now() + hours * 3600000
  };
  try {
    // version "*": a gift id can be created once, so a retried send cannot make a second gift
    nk.storageWrite([{ collection: GIFT_COLLECTION, key: giftId, userId: SYSTEM_USER, value: gift, version: "*", permissionRead: 0, permissionWrite: 0 }]);
  } catch (e) {
    return result("exists");
  }
  var content = { giftId: giftId, coins: coins, message: gift.message, expiresAt: gift.expiresAt };
  if (userIds) {
    var notes = [];
    for (var i = 0; i < userIds.length; i++) { notes.push({ userId: userIds[i], code: NOTE_GIFT, subject: gift.subject, content: content, persistent: true }); }
    nk.notificationsSend(notes);
  } else {
    nk.notificationSendAll(gift.subject, content, NOTE_GIFT, true);
  }
  logger.info("gift %s: %d coins to %s", giftId, coins, userIds ? userIds.length + " player(s)" : "everybody");
  return result("ok", { gift: gift });
}

function rpcClaimGift(ctx, logger, nk, payload) {
  requireUser(ctx);
  var request = payload ? JSON.parse(payload) : {};
  var giftId = request.giftId ? String(request.giftId) : "";
  var gift = giftId ? readGift(nk, giftId) : null;
  if (!gift) { return profileReply("unknown_gift", currentProfile(nk, ctx.userId)); }
  if (Date.now() > gift.expiresAt) { return profileReply("expired", currentProfile(nk, ctx.userId)); }
  if (gift.audience !== "all" && gift.audience.indexOf(ctx.userId) < 0) { return profileReply("not_eligible", currentProfile(nk, ctx.userId)); }
  var status = "ok";
  var done = mutateProfile(nk, ctx.userId, function (profile) {
    status = "ok";
    var gifts = jsArray(profile.gifts);
    if (gifts.indexOf(giftId) >= 0) { status = "already_claimed"; return null; }
    gifts.push(giftId);
    while (gifts.length > MAX_GIFTS_REMEMBERED) { gifts.shift(); }
    profile.gifts = gifts;
    profile.coins += gift.coins;
    return {};
  });
  if (status === "ok") { logger.info("gift %s claimed by %s (%d coins)", giftId, ctx.userId, gift.coins); }
  return profileReply(status, done.profile, { giftId: giftId, coins: status === "ok" ? gift.coins : 0 });
}

// the persistent notifications of the player, newest first, with the state of gifts (claimed / expired) the client cannot know
function rpcInbox(ctx, logger, nk, payload) {
  requireUser(ctx);
  var request = payload ? JSON.parse(payload) : {};
  var listed = nk.notificationsList(ctx.userId, clampInt(request.limit || 50, 1, 100), request.cursor ? String(request.cursor) : "");
  var notes = listed && listed.notifications ? listed.notifications : [];
  var profile = currentProfile(nk, ctx.userId);
  var claimedGifts = jsArray(profile.gifts);
  var now = Date.now();
  var out = [];
  var unclaimed = 0;
  for (var i = 0; i < notes.length; i++) {
    var n = notes[i];
    var content = n.content;
    if (typeof content === "string") { try { content = JSON.parse(content); } catch (e) { content = {}; } }
    var item = { id: n.id, code: n.code, subject: n.subject, content: content || {}, createTime: n.createTime, senderId: n.senderId || "" };
    if (n.code === NOTE_GIFT && content && content.giftId) {
      item.claimed = claimedGifts.indexOf(content.giftId) >= 0;
      item.expired = content.expiresAt ? now > content.expiresAt : false;
      if (!item.claimed && !item.expired) { unclaimed++; }
    }
    out.push(item);
  }
  out.sort(function (a, b) { return a.createTime < b.createTime ? 1 : -1; });
  return result("ok", { notifications: out, unclaimedGifts: unclaimed, cursor: listed && listed.cacheableCursor ? listed.cacheableCursor : "" });
}

function rpcAnnounce(ctx, logger, nk, payload) {
  requireServerCall(ctx);
  var request = payload ? JSON.parse(payload) : {};
  var subject = String(request.subject || "").substring(0, 80);
  var message = String(request.message || "").substring(0, 300);
  if (!subject) { throw new Error("subject is required"); }
  nk.notificationSendAll(subject, { message: message, at: Date.now() }, NOTE_ANNOUNCEMENT, request.persistent !== false);
  if (request.toChat) { systemChat(nk, logger, "global", subject + (message ? " - " + message : ""), "announcement"); }
  logger.info("announcement: %s", subject);
  return result("ok");
}

// ---- chat ----
var CHAT_ROOMS = { global: true, lfg: true, help: true };   // the only rooms a player can join
var CHAT_MAX_LENGTH = 200;
var CHAT_RATE_COUNT = 5;            // at most this many messages ...
var CHAT_RATE_WINDOW_S = 10;        // ... in this many seconds
var CHAT_DUPLICATE_WINDOW_S = 30;   // the same text again within this is spam
var CHAT_MAX_MENTIONS = 3;
var CHAT_REPORTS_TO_MUTE = 3;       // distinct players reporting the same player ...
var CHAT_REPORT_WINDOW_MS = 3600000; // ... within an hour mute them
var CHAT_AUTO_MUTE_MINUTES = 15;
var MUTE_COLLECTION = "railbound_chat_mutes";
var REPORT_COLLECTION = "railbound_chat_reports";
var SYSTEM_NAME = "RAILBOUND";
// a short default list; more words come from the env CHAT_BLOCKED_WORDS (comma separated)
var CHAT_BLOCKED = ["fuck", "fucking", "shit", "bitch", "cunt", "asshole", "bastard", "dick", "pussy", "whore", "slut", "nigger", "faggot", "retard"];

function blockedWords(ctx) {
  var extra = envOr(ctx, "CHAT_BLOCKED_WORDS", "");
  return extra ? CHAT_BLOCKED.concat(extra.toLowerCase().split(",").map(function (w) { return w.trim(); }).filter(function (w) { return w.length > 1; })) : CHAT_BLOCKED;
}

// letters a filter evader swaps in, back to the letters they stand for
var LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };

function normalizeWord(word) {
  var out = "";
  var w = word.toLowerCase();
  for (var i = 0; i < w.length; i++) { out += LEET[w.charAt(i)] || w.charAt(i); }
  return out.replace(/[^a-z]/g, "").replace(/(.)\1{2,}/g, "$1$1");   // "fuuuuck" -> "fuuck"
}

// returns { text, filtered }: blocked words become stars, links are removed, control characters dropped, whitespace collapsed
function cleanChat(ctx, text) {
  var filtered = false;
  var s = String(text).replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, "").replace(/\s+/g, " ").trim();
  var noLinks = s.replace(/\b((https?:\/\/|www\.)\S+|\S+\.(com|net|org|gg|io|ru|xyz|me|tk)(\/\S*)?)\b/gi, "[link removed]");
  if (noLinks !== s) { filtered = true; s = noLinks; }
  var words = blockedWords(ctx);
  var parts = s.split(" ");
  for (var i = 0; i < parts.length; i++) {
    var n = normalizeWord(parts[i]);
    if (!n) { continue; }
    for (var w = 0; w < words.length; w++) {
      var bw = words[w];
      if (n === bw || n === bw + "s" || (bw.length >= 4 && n.indexOf(bw) >= 0) || n.replace(/(.)\1+/g, "$1") === bw.replace(/(.)\1+/g, "$1")) {
        parts[i] = new Array(parts[i].length + 1).join("*");
        filtered = true;
        break;
      }
    }
  }
  return { text: parts.join(" "), filtered: filtered };
}

function muteUntil(nk, userId) {
  var cached = nk.localcacheGet("mute:" + userId);
  if (cached !== null && cached !== undefined) { return Number(cached) || 0; }
  var objects = nk.storageRead([{ collection: MUTE_COLLECTION, key: userId, userId: SYSTEM_USER }]);
  var until = objects && objects.length > 0 && objects[0].value ? objects[0].value.until : 0;
  if (until && until < Date.now()) { until = 0; }
  nk.localcachePut("mute:" + userId, until ? String(until) : "0", 30);
  return until;
}

function setMute(nk, logger, userId, minutes, reason, by) {
  var until = minutes > 0 ? Date.now() + minutes * 60000 : 0;
  nk.storageWrite([{ collection: MUTE_COLLECTION, key: userId, userId: SYSTEM_USER, value: { until: until, reason: reason, by: by, at: Date.now() }, permissionRead: 0, permissionWrite: 0 }]);
  nk.localcachePut("mute:" + userId, until ? String(until) : "0", 30);
  if (minutes > 0) {
    notify(nk, logger, userId, NOTE_CHAT_MUTED, "CHAT MUTED FOR " + minutes + " MIN", { until: until, minutes: minutes, reason: reason });
  }
  logger.info("chat mute %s: %d min (%s, by %s)", userId, minutes, reason, by);
  return until;
}

// a fixed-window rate limit and the last message, in the node's local cache (shared by every runtime of the node)
function chatAllowed(nk, userId, text) {
  var now = Math.floor(Date.now() / 1000);
  var window = Math.floor(now / CHAT_RATE_WINDOW_S);
  var rateKey = "chatrate:" + userId + ":" + window;
  var count = Number(nk.localcacheGet(rateKey) || 0) + 1;
  nk.localcachePut(rateKey, String(count), CHAT_RATE_WINDOW_S + 1);
  if (count > CHAT_RATE_COUNT) { return "rate_limited"; }
  var lastKey = "chatlast:" + userId;
  var last = nk.localcacheGet(lastKey);
  var norm = normalizeWord(text) || text.toLowerCase();
  if (last && last === norm) { return "duplicate"; }
  nk.localcachePut(lastKey, norm, CHAT_DUPLICATE_WINDOW_S);
  return null;
}

function channelMode(channelId) {
  // Nakama channel ids: "<mode>.<subject>.<subcontext>.<label>", mode 2 = room, 3 = group, 4 = direct message
  var mode = parseInt(String(channelId || "").split(".")[0], 10);
  return mode === 2 ? "room" : mode === 3 ? "group" : mode === 4 ? "dm" : "unknown";
}

function isFriend(nk, userId, otherId) {
  var cursor = "";
  for (var page = 0; page < 10; page++) {
    var fl = nk.friendsList(userId, 100, 0, cursor);
    var friends = fl && fl.friends ? fl.friends : [];
    for (var i = 0; i < friends.length; i++) {
      if (friends[i].user && friends[i].user.userId === otherId) { return true; }
    }
    if (!fl || !fl.cursor) { return false; }
    cursor = fl.cursor;
  }
  return false;
}

function beforeChannelJoin(ctx, logger, nk, envelope) {
  var join = envelope.channelJoin;
  if (!join) { return envelope; }
  var type = join.type | 0;   // 1 room, 2 direct message, 3 group
  if (type === 1) {
    var room = String(join.target || "").toLowerCase();
    if (!CHAT_ROOMS[room]) { throw new Error("unknown chat room"); }
    join.target = room;
    join.persistence = true;
    join.hidden = false;
  } else if (type === 2) {
    if (!isFriend(nk, ctx.userId, String(join.target || ""))) { throw new Error("direct messages are only between friends"); }
    join.persistence = true;
  }
  return envelope;   // groups: Nakama checks the membership itself
}

function beforeChannelMessageSend(ctx, logger, nk, envelope) {
  var send = envelope.channelMessageSend;
  if (!send) { return envelope; }
  var until = muteUntil(nk, ctx.userId);
  if (until > Date.now()) { throw new Error("muted until " + new Date(until).toISOString()); }
  var content;
  try { content = JSON.parse(send.content || "{}"); } catch (e) { throw new Error("message content must be JSON"); }
  var raw = content && typeof content.message === "string" ? content.message : "";
  if (!raw.replace(/\s/g, "")) { throw new Error("empty message"); }
  if (raw.length > CHAT_MAX_LENGTH) { throw new Error("message longer than " + CHAT_MAX_LENGTH + " characters"); }
  var clean = cleanChat(ctx, raw);
  var limit = chatAllowed(nk, ctx.userId, clean.text);
  if (limit === "rate_limited") { throw new Error("slow down: at most " + CHAT_RATE_COUNT + " messages in " + CHAT_RATE_WINDOW_S + " seconds"); }
  if (limit === "duplicate") { throw new Error("same message sent again"); }

  // only the fields the server knows about go out
  var out = { message: clean.text };
  if (clean.filtered) { out.filtered = true; }

  // @mentions in rooms notify the players (not persisted: it is a ping, the message itself is in the room history)
  if (channelMode(send.channelId) === "room") {
    var mentions = clean.text.match(/@([A-Za-z0-9_.-]{3,32})/g) || [];
    var names = [];
    for (var m = 0; m < mentions.length && names.length < CHAT_MAX_MENTIONS; m++) {
      var name = mentions[m].substring(1);
      if (names.indexOf(name) < 0) { names.push(name); }
    }
    if (names.length > 0) {
      try {
        var users = nk.usersGetUsername(names);
        var notes = [];
        for (var u = 0; u < users.length; u++) {
          if (users[u].userId === ctx.userId) { continue; }
          notes.push({ userId: users[u].userId, code: NOTE_CHAT_MENTION, persistent: false, senderId: ctx.userId,
            subject: (ctx.username || "A player") + " mentioned you", content: { channelId: send.channelId, from: ctx.username || "", message: clean.text } });
        }
        if (notes.length > 0) { nk.notificationsSend(notes); out.mentions = notes.length; }
      } catch (e) {
        logger.warn("chat mentions: %s", e.message);
      }
    }
  }
  send.content = JSON.stringify(out);
  return envelope;
}

function systemChat(nk, logger, room, text, kind) {
  try {
    var channelId = nk.channelIdBuild(SYSTEM_USER, room, 1);
    nk.channelMessageSend(channelId, { message: text, system: true, kind: kind }, SYSTEM_USER, SYSTEM_NAME, true);
  } catch (e) {
    logger.warn("system chat %s: %s", room, e.message);
  }
}

function rpcChatReport(ctx, logger, nk, payload) {
  requireUser(ctx);
  var request = payload ? JSON.parse(payload) : {};
  var channelId = String(request.channelId || "");
  var messageId = String(request.messageId || "");
  var reason = String(request.reason || "abuse").substring(0, 60);
  if (!channelId || !messageId) { return result("bad_request"); }
  // the reported message must really be in that channel (the client cannot blame somebody for a message they never sent)
  var found = null;
  try {
    var history = nk.channelMessagesList(channelId, 100, false, "");
    var messages = history && history.messages ? history.messages : [];
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].messageId === messageId) { found = messages[i]; break; }
    }
  } catch (e) {
    return result("not_found");
  }
  if (!found) { return result("not_found"); }
  var target = found.senderId;
  if (!target || target === ctx.userId || target === SYSTEM_USER) { return result("not_reportable"); }

  var muted = false;
  for (var attempt = 0; attempt < 5; attempt++) {
    var objects = nk.storageRead([{ collection: REPORT_COLLECTION, key: target, userId: SYSTEM_USER }]);
    var stored = objects && objects.length > 0 ? objects[0] : null;
    var now = Date.now();
    var reports = jsArray(stored && stored.value ? stored.value.reports : null).filter(function (x) { return now - x.at < 7 * 24 * 3600000; });
    var already = false;
    for (var r = 0; r < reports.length; r++) {
      if (reports[r].by === ctx.userId && reports[r].messageId === messageId) { already = true; }
    }
    if (already) { return result("already_reported"); }
    var excerpt = "";
    try { excerpt = String(JSON.parse(found.content).message || "").substring(0, 120); } catch (e) { excerpt = ""; }
    reports.push({ by: ctx.userId, at: now, messageId: messageId, channelId: channelId, reason: reason, excerpt: excerpt });
    while (reports.length > 100) { reports.shift(); }
    try {
      nk.storageWrite([{ collection: REPORT_COLLECTION, key: target, userId: SYSTEM_USER, value: { reports: reports }, version: stored ? stored.version : "*", permissionRead: 0, permissionWrite: 0 }]);
    } catch (e) {
      continue;   // another report was saved in between: read again
    }
    // distinct reporters in the last hour
    var reporters = {};
    var count = 0;
    for (var k = 0; k < reports.length; k++) {
      var rep = reports[k];
      if (now - rep.at < CHAT_REPORT_WINDOW_MS && !reporters[rep.by]) { reporters[rep.by] = true; count++; }
    }
    if (count >= CHAT_REPORTS_TO_MUTE && !(muteUntil(nk, target) > now)) {
      setMute(nk, logger, target, CHAT_AUTO_MUTE_MINUTES, "reported by " + count + " players", "auto");
      muted = true;
    }
    logger.info("chat report: %s reported %s (%s), %d reporter(s) this hour", ctx.userId, target, reason, count);
    return result("ok", { autoMuted: muted });
  }
  return result("busy");
}

function rpcChatMute(ctx, logger, nk, payload) {
  requireServerCall(ctx);
  var request = payload ? JSON.parse(payload) : {};
  var userId = String(request.userId || "");
  if (!userId) { throw new Error("userId is required"); }
  var minutes = clampInt(request.minutes, 0, 60 * 24 * 30);
  var until = setMute(nk, logger, userId, minutes, String(request.reason || "moderator").substring(0, 80), "ops");
  return result("ok", { until: until });
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
  initializer.registerRpc("railbound_leaderboard", rpcLeaderboard);
  initializer.registerRpc("railbound_leaderboard_payout", rpcLeaderboardPayout);
  initializer.registerRpc("railbound_inbox", rpcInbox);
  initializer.registerRpc("railbound_claim_gift", rpcClaimGift);
  initializer.registerRpc("railbound_send_gift", rpcSendGift);
  initializer.registerRpc("railbound_announce", rpcAnnounce);
  initializer.registerRpc("railbound_chat_report", rpcChatReport);
  initializer.registerRpc("railbound_chat_mute", rpcChatMute);
  initializer.registerRtBefore("ChannelJoin", beforeChannelJoin);
  initializer.registerRtBefore("ChannelMessageSend", beforeChannelMessageSend);
  initializer.registerLeaderboardReset(onLeaderboardReset);
  createLeaderboards(ctx, logger, nk);
  initializer.registerMatch(QUEUE_MODULE, {
    matchInit: queueInit,
    matchJoinAttempt: queueJoinAttempt,
    matchJoin: queueJoin,
    matchLeave: queueLeave,
    matchLoop: queueLoop,
    matchTerminate: queueTerminate,
    matchSignal: queueSignal
  });
  logger.info("Railbound module loaded: RPCs railbound_allocate, railbound_validate_join, railbound_profile, railbound_buy_operator, railbound_claim_challenge, railbound_report_match, railbound_queue_join, railbound_set_loadout, railbound_upgrade_skill, railbound_claim_tier, the social RPCs (leaderboard, inbox, gifts, announcements, chat moderation), the chat hooks, the leaderboard reset hook and the railbound_queue match handler registered.");
}
