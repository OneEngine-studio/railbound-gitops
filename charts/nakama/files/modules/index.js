// Railbound server allocation for Nakama (JavaScript runtime).
//
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
      return result("ready", { matchId: matchId, host: value.host, port: value.port, name: value.name });
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
  return result("ready", { matchId: matchId, host: server.host, port: server.port, name: server.name });
}

function InitModule(ctx, logger, nk, initializer) {
  initializer.registerRpc("railbound_allocate", rpcAllocate);
  logger.info("Railbound module loaded: RPC railbound_allocate registered.");
}
