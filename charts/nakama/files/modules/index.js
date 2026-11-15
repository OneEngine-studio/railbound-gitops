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
  var out = { status: status, profile: publicProfile(profile), prices: OPERATOR_PRICES, serverTime: Date.now() };
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
        profile.lastAward = {
          matchId: matchId, xp: award.xp, coins: award.coins, levelBonusCoins: award.levelBonusCoins,
          oldLevel: award.oldLevel, newLevel: award.newLevel,
          placement: placement, totalPlayers: totalPlayers, kills: kills, survivedSeconds: survived, at: now
        };
        return { award: award };
      });
      results.push({ userId: userId, status: status, xp: done.extra ? done.extra.award.xp : 0, coins: done.extra ? done.extra.award.coins : 0 });
    } catch (e) {
      logger.error("railbound_report_match: %s in %s: %s", userId, matchId, e.message);
      results.push({ userId: userId, status: "error" });
    }
  }
  logger.info("railbound_report_match: match %s, %d player(s) reported", matchId, players.length);
  return JSON.stringify({ status: "ok", results: results });
}

function InitModule(ctx, logger, nk, initializer) {
  initializer.registerRpc("railbound_allocate", rpcAllocate);
  initializer.registerRpc("railbound_validate_join", rpcValidateJoin);
  initializer.registerRpc("railbound_profile", rpcProfile);
  initializer.registerRpc("railbound_buy_operator", rpcBuyOperator);
  initializer.registerRpc("railbound_claim_challenge", rpcClaimChallenge);
  initializer.registerRpc("railbound_report_match", rpcReportMatch);
  logger.info("Railbound module loaded: RPCs railbound_allocate, railbound_validate_join, railbound_profile, railbound_buy_operator, railbound_claim_challenge, railbound_report_match registered.");
}
