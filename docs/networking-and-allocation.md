# Railbound networking and match allocation

How a player gets from the lobby into a match on the home cluster, and what to set up for it.

## The path

```text
                              HTTPS / WSS (TCP 443)
  Unity client ───────────────────────────────────────────►  Cloudflare ──► cloudflared (k3s)
        │                                                                          │
        │  1. matchmaker ticket (socket)                                           ▼
        │  2. RPC railbound_allocate  ──────────────────────────────►  Nakama (apps/nakama:7350)
        │                                                               │  JS module, kubectl-proxy sidecar
        │                                                               ▼
        │                                                         Agones GameServerAllocation
        │                                                               │  picks a Ready server of Fleet railbound-br
        │   3. reply: 134.185.84.226 : 7xxx                             ▼
        │◄──────────────────────────────────────────────────────  GameServer pod (Unity server, UDP 7777 inside)
        │
        │  4. Netcode for GameObjects, UDP
        ▼
  134.185.84.226:7xxx  (OCI Ubuntu, public)
        │  DNAT UDP 7000-8000  →  WireGuard (10.8.0.1 ↔ 10.8.0.2)
        ▼
  Debian node 10.8.0.2:7xxx  ──hostPort──►  GameServer pod :7777
```

Agones gives every game server a free host port from its dynamic range, 7000-8000. That is exactly the range the OCI
ingress rules and the relay forward, so a new match never needs a firewall change.

## What the repo contains

| Piece | Where |
| :--- | :--- |
| Fleet of dedicated servers + autoscaler (2 idle servers kept ready) | `charts/agones-fleet`, Argo app `app/platform/agones-fleet-app.yaml` |
| Nakama module with the allocation RPC `railbound_allocate` | `charts/nakama/files/modules/index.js` |
| Kubernetes access for Nakama (service account, Role limited to `gameserverallocations`, `kubectl proxy` sidecar) | `charts/nakama/templates/agones-rbac.yaml`, `deployment.yaml` |
| Unity: server reports `/ready`, `/health`, `/shutdown` to the Agones sidecar | `Assets/Project/Scripts/Networking/AgonesServerLifecycle.cs` |
| Unity: lobby asks Nakama for the server and connects to it | `ServerAllocationClient.cs`, `MatchConnection.cs`, `LobbyMatchmakingController.cs` |
| Image build: CI bumps the image tag in both `game-server` and `agones-fleet` values | `.github/workflows/build-server.yml` (Unity repo) |

## One-time setup, step by step

### 1. OCI Ubuntu relay: already in place (checked 2026-11-08)

Read from the live server, nothing had to be changed:

* `net.ipv4.ip_forward = 1`
* `nat PREROUTING  -i ens3 -p udp --dport 7000:8000 -j DNAT --to-destination 10.8.0.2`
* `nat POSTROUTING -o wg0 -d 10.8.0.2 -p udp --dport 7000:8000 -j SNAT --to-source 10.8.0.1`
  (the node therefore answers to the relay's tunnel address and every reply comes back through the tunnel)
* `FORWARD` accepts wg0 -> ens3 and ens3 -> wg0 for UDP 7000-8000 before the final REJECT
* the rules are saved (`iptables-persistent`), and the VCN ingress rules allow UDP 7000-8000 and 51820

If the relay is ever rebuilt, these are the commands that produce exactly that state:

```bash
sudo sysctl -w net.ipv4.ip_forward=1
echo 'net.ipv4.ip_forward=1' | sudo tee /etc/sysctl.d/99-forward.conf
sudo iptables -t nat -A PREROUTING  -i ens3 -p udp --dport 7000:8000 -j DNAT --to-destination 10.8.0.2
sudo iptables -t nat -A POSTROUTING -o wg0 -p udp -d 10.8.0.2 --dport 7000:8000 -j SNAT --to-source 10.8.0.1
sudo iptables -I FORWARD 1 -i wg0  -o ens3 -j ACCEPT
sudo iptables -I FORWARD 2 -i ens3 -o wg0  -p udp --dport 7000:8000 -j ACCEPT
sudo apt-get install -y iptables-persistent && sudo netfilter-persistent save
```

### 2. Debian node: tunnel and k3s (checked 2026-11-08)

* `wg0` is `10.8.0.2/24`, the OCI peer has `PersistentKeepalive = 25`, the last handshake was seconds old, and
  `wg-quick@wg0` is enabled.
* k3s runs with `node-ip: 10.8.0.2`, `node-external-ip: 134.185.84.226` and `flannel-iface: wg0`, so Agones already
  reports the public address for every game server. The allocation module still hands out `agones.publicHost`, so it
  keeps working if that k3s setting is ever removed.
* Agones 1.61.0 hands out host ports 7000-8000 (`MIN_PORT` / `MAX_PORT`), the same range the relay forwards.
* hostPort mapping works: the old static server on UDP 7777 shows up as a CNI portmap rule.
* The node can pull from `registry.k8s.io` (the `kubectl` sidecar image) and Docker Hub (the server image).
* Capacity: 8 CPUs, 19 GB RAM, plenty of disk.

### 3. Check the tunnel with a raw UDP packet

On the Debian node: `nc -u -l -p 7500` (or `sudo ss -ulnp` to see listeners).
From any machine on the internet (PowerShell):

```powershell
$u = New-Object System.Net.Sockets.UdpClient; $b = [Text.Encoding]::ASCII.GetBytes("ping"); $u.Send($b,$b.Length,"134.185.84.226",7500)
```

`ping` must appear in the Debian terminal. If it does not: `sudo iptables -t nat -L PREROUTING -n -v` on the OCI server
shows whether the counter of the DNAT rule goes up (packets arrive but are not forwarded) or stays at 0 (blocked before
the instance: check the VCN rules and that the packets really go to the right public IP).

### 4. Cluster: let Argo CD roll the new pieces out

Order matters. The Unity server image must contain `AgonesServerLifecycle` before any Fleet server starts, otherwise
Agones sees servers that never report ready and restarts them.

1. Merge the Unity branch to `main`. The workflow builds the image and (with `DEPLOY_GITOPS=true`) bumps the tag in both
   `charts/game-server/values.yaml` and `charts/agones-fleet/values.yaml`.
2. Merge this repo to `main`. Argo CD (app-of-apps) updates `nakama-service` (adds the allocation module and the proxy
   sidecar) and creates `platform-agones-fleet`, which starts with 0 servers.
3. In `charts/agones-fleet/values.yaml` set `autoscaler.enabled: true` (and push). Two servers start and become Ready.

```bash
kubectl -n argocd get applications
kubectl -n platform get fleet,fleetautoscaler,gameserver -o wide      # 2 GameServers should reach Ready
kubectl -n apps get pod -l app.kubernetes.io/name=nakama               # 2/2 containers: nakama + agones-proxy
kubectl -n apps logs deploy/nakama -c nakama | grep -i railbound       # "RPC railbound_allocate registered"
```

The old `platform-game-server` (static server on hostPort 7777) can run next to the fleet for now. 7777 is inside Agones'
range, so once the fleet works, scale the old one to `replicaCount: 0` to avoid a port clash.

### 5. Test the allocation without the game

```bash
HOST=https://restapinakama.kushanherath.me
TOKEN=$(curl -s -X POST "$HOST/v2/account/authenticate/device?create=true" \
  -H "Authorization: Basic $(printf 'defaultkey:' | base64)" -H 'Content-Type: application/json' \
  -d '{"id":"railbound-test-device-0001"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')

curl -s -X POST "$HOST/v2/rpc/railbound_allocate" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '"{\"matchId\":\"test1\",\"players\":1}"'
```

Expected: `{"payload":"{\"status\":\"ready\",\"host\":\"134.185.84.226\",\"port\":7xxx,...}"}`.
Repeat with the same `matchId` and you get the same server. `kubectl -n platform get gs` then shows one `Allocated`
server; it shuts itself down 120 s later if nobody connects, and the fleet starts a replacement.

## Match lifecycle on the server

1. Unity server starts, listens, tells Agones **Ready**.
2. Nakama allocates it; the match id and the number of expected players arrive as GameServer annotations.
3. The match coordinator waits for the expected number of players (or the 30 s lobby window), runs the 10 s warmup, starts the storm.
4. When the match ends (or nobody joined, or everybody left) the server calls **/shutdown** and exits. The fleet creates a new Ready server.

## Things to fix before real players use this

* **Default secrets.** `charts/nakama/values.yaml` still has `defaultkey`, `defaulthttpkey`, `defaultencryptionkey`,
  `defaultsigningkey` and the console login `admin / password`. The console is published at `nakama.kushanherath.me`, so
  anybody can open it. Put a Cloudflare Access policy in front of the console and Argo CD hostnames, and move the keys
  and the password into Kubernetes Secrets before the game is public.
* **Join authorisation.** The server accepts any Netcode client that knows its address. Add connection approval that checks
  the match id against the player's Nakama session.
* **Bots are not networked yet.** See `Assets/Project/Docs/BattleRoyale_Hybrid_MatchLoop_Plan.md` in the Unity repo.
* **Node address.** Agones reports the node's private address; the allocation module replaces it with `agones.publicHost`
  (`134.185.84.226`). If the relay address ever changes, change that one value.
