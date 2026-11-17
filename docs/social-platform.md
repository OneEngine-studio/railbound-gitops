# Railbound social platform: leaderboards, notifications, chat

All three run in the Nakama module (`charts/nakama/files/modules/index.js`, section "Social platform") and are server-authoritative
like the economy: a game client can read, claim and chat, but it can never write a score, send a gift or lift a mute.
"Server" RPCs need Nakama's HTTP key (`runtime.http_key`, from the Kubernetes Secret) and refuse any call with a user session.

## Leaderboards

| Board (`board`)  | Nakama id                       | Score                         | Reset                     | Payout (coins) |
|------------------|---------------------------------|-------------------------------|---------------------------|----------------|
| `weekly_kills`   | `railbound_weekly_kills`        | kills, added per match        | Monday 00:00 UTC          | 1000 / 500 / 250 |
| `weekly_wins`    | `railbound_weekly_wins`         | wins                          | Monday 00:00 UTC          | 1000 / 500 / 250 |
| `season_xp`      | `railbound_season_xp_S01`       | match XP of the season        | never (new id per season) | -              |
| `alltime_kills`  | `railbound_alltime_kills`       | kills                         | never                     | -              |

* The boards are authoritative: only `railbound_report_match` (the game server) writes them, once per paid player per match, so a
  duplicate report adds nothing.
* `railbound_leaderboard { board, scope, limit, cursor }` (player). `scope`: `top` (paged), `around_me`, `friends` (the player and
  their mutual friends, ranked among themselves; `globalRank` keeps the real one). The reply has `me`, `resetsAt` (unix seconds) and
  `payouts`. Without `board` it returns the catalog.
* When a weekly board resets, Nakama calls the reset hook and the top 3 of the ENDED period are paid, with a notification (code 110).
  A profile remembers the periods it was paid for, so a second run never pays twice. If the hook failed, operations can run it
  again for that period: `railbound_leaderboard_payout { board, expiry }` (server; refused for a period that has not ended).
* Tests set `LEADERBOARD_WEEKLY_CRON` (runtime env) to `* * * * *` so the weekly boards reset every minute. Leave it unset in
  production. Note that Nakama keeps the schedule of an existing board: changing it later means a new board id.

## Notifications

Persistent in-app notifications (Nakama's inbox), sent by the server:

| Code | Meaning | Sent by | Content |
|------|---------|---------|---------|
| 100 | match result | match report | `matchId, placement, totalPlayers, kills, xp, coins` |
| 101 | level up | match report | `oldLevel, newLevel, bonusCoins` |
| 102 | weapon level up | match report | `weapons: [{ weapon, level }]` |
| 103 | battle pass tier reached | match report | `oldTier, newTier, claimableTiers` |
| 110 | leaderboard reward | weekly reset | `board, title, rank, score, coins, period` |
| 120 | gift (claimable) | operations | `giftId, coins, message, expiresAt` |
| 130 | announcement | operations | `message, at` |
| 140 | chat muted | moderation | `until, minutes, reason` |
| 141 | chat mention (not persisted) | chat | `channelId, from, message` |

Negative codes are Nakama's own (for example `-2`, a friend request).

* `railbound_inbox { limit, cursor }` (player): the persistent notifications, newest first; gifts carry `claimed` / `expired`, and
  `unclaimedGifts` counts the ones still waiting.
* `railbound_claim_gift { giftId }` (player): pays a gift once. It must be addressed to the player (or to everybody) and not expired.
  Parallel claims cannot pay twice (the profile is written with optimistic concurrency).
* `railbound_send_gift { giftId, coins, subject, message, userIds?, expiresInHours }` (server): without `userIds` it goes to
  everybody. A gift id can be created once, so a retried send cannot make a second gift. At most 10,000 coins, 30 days.
* `railbound_announce { subject, message, toChat, persistent }` (server): to everybody; `toChat` also posts it in the global room.

```bash
HTTP_KEY='<from the railbound-nakama Secret>'
HOST='https://restapinakama.kushanherath.me'
curl -s -X POST "$HOST/v2/rpc/railbound_send_gift?http_key=$HTTP_KEY&unwrap" \
  -d '{"giftId":"downtime-2026-11","coins":250,"subject":"SORRY FOR THE DOWNTIME","expiresInHours":72}'
curl -s -X POST "$HOST/v2/rpc/railbound_announce?http_key=$HTTP_KEY&unwrap" \
  -d '{"subject":"SERVER MAINTENANCE","message":"Friday 02:00 UTC, about 30 minutes","toChat":true}'
```

## Chat

Nakama's realtime chat, with hooks in front of `ChannelJoin` and `ChannelMessageSend`:

* Rooms: only `global`, `lfg` and `help` (always persisted, never hidden). Direct messages only between mutual friends. Group chat:
  Nakama checks the membership.
* Messages: JSON `{ "message": "..." }`, 1-200 characters. Control and zero-width characters are dropped, whitespace collapsed,
  links replaced by `[link removed]`, blocked words starred (also l33t / stretched spellings; more words with the runtime env
  `CHAT_BLOCKED_WORDS`, comma separated). A filtered message carries `filtered: true`. Only the server's fields go out.
* At most 5 messages in 10 seconds per player, and the same text again within 30 seconds is refused. The counters live in the
  node's local cache (`nk.localcache*`), so with several Nakama nodes the limit is per node.
* `@username` in a room pings that player (notification 141, up to 3 per message).
* `railbound_chat_report { channelId, messageId, reason }` (player): the message must exist in that channel (the last 100 messages),
  a player cannot report themselves or the server, and a report counts once per reporter and message. Three different reporters
  within an hour mute the player for 15 minutes (notification 140). Reports are kept for operations in `railbound_chat_reports`.
* `railbound_chat_mute { userId, minutes, reason }` (server): mute (0 minutes = unmute). Muted players can still read.
* The server posts to the global room as `RAILBOUND`: the winner of every reported match (`kind: victory`) and announcements.

## Testing

Against a local Nakama (docker) set up as for the other tests (server key `testkey`, a non-default HTTP key, port 17350,
`test/mock-agones.js` on 18001, runtime env `LEADERBOARD_WEEKLY_CRON=* * * * *`):

```bash
node charts/nakama/test/social-test.js
```

52 checks: board ordering and ranks, friends and around-me views, duplicate reports, client writes refused, all match notifications,
gifts (once, addressed, parallel claims), announcements live and in the inbox, room and DM rules, the filter, length, spam, mentions,
the rate limit, reports and auto-mute, ops unmute, and the real weekly reset paying the top 3 once.
