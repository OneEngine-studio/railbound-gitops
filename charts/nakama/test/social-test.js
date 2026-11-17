// Integration test of the social platform (leaderboards, notifications, chat moderation) against a LOCAL Nakama (docker), with
// the same setup as queue-test.js / progression-test.js: server key testkey, http key test-http-key-not-the-default, port 17350,
// mock-agones.js on 18001, and the env LEADERBOARD_WEEKLY_CRON="* * * * *" so the weekly boards reset every minute and the reset
// payout can be tested for real. Throwaway device accounts only. Needs Node 22+ (global fetch and WebSocket).
const HOST = 'http://localhost:17350', WS = 'ws://localhost:17350/ws', SERVER_KEY = 'testkey', HTTP_KEY = 'test-http-key-not-the-default';
let pass = 0, fail = 0;
const check = (name, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(extra))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tag = Date.now().toString(36);

async function auth(name) {
  const r = await fetch(`${HOST}/v2/account/authenticate/device?create=true&username=${name}_${tag}`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(SERVER_KEY + ':').toString('base64'), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: `social-test-${name}-${tag}-xxxxxxxx` }) });
  const b = await r.json(); const payload = JSON.parse(Buffer.from(b.token.split('.')[1], 'base64url').toString());
  return { name, token: b.token, uid: payload.uid, username: payload.usn };
}
async function api(user, method, path, body) {
  const r = await fetch(`${HOST}${path}`, { method, headers: { Authorization: 'Bearer ' + user.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let b; try { b = JSON.parse(t); } catch (e) { b = t; }
  return { status: r.status, body: b };
}
async function rpc(user, id, obj) {
  const r = await api(user, 'POST', `/v2/rpc/${id}`, JSON.stringify(obj || {}));
  return r.body && r.body.payload ? JSON.parse(r.body.payload) : { httpStatus: r.status, body: r.body };
}
async function srv(id, obj) {
  const r = await fetch(`${HOST}/v2/rpc/${id}?http_key=${encodeURIComponent(HTTP_KEY)}&unwrap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  const t = await r.text(); try { return JSON.parse(t); } catch (e) { return { httpStatus: r.status, body: t }; }
}
async function playMatch(user, matchId, placement, kills, weaponKills) {
  await rpc(user, 'railbound_allocate', { matchId, players: 1 });
  return srv('railbound_report_match', { matchId, players: [{ userId: user.uid, placement, totalPlayers: 20, kills, survivedSeconds: 600, weaponKills }] });
}
const profile = async u => { const r = await rpc(u, 'railbound_profile'); if (!r.profile) throw new Error('profile: ' + JSON.stringify(r)); return r.profile; };
const board = (u, b, scope, limit) => rpc(u, 'railbound_leaderboard', { board: b, scope: scope || 'top', limit: limit || 50 });
const inbox = async u => (await rpc(u, 'railbound_inbox')).notifications || [];

// a minimal Nakama realtime client: request / response by cid, and a log of pushed messages and notifications
function socket(user) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}?lang=en&status=true&token=${user.token}`);
    const pending = new Map(); const pushed = []; let cid = 0;
    const s = {
      pushed,
      send(msg) { const id = String(++cid); msg.cid = id; ws.send(JSON.stringify(msg)); return new Promise(res => pending.set(id, res)); },
      join(target, type) { return s.send({ channel_join: { target, type, persistence: true, hidden: false } }); },
      say(channelId, message) { return s.send({ channel_message_send: { channel_id: channelId, content: JSON.stringify({ message }) } }); },
      waitFor(pred, ms) {
        return new Promise(res => {
          const t0 = Date.now();
          const tick = () => { const hit = pushed.find(pred); if (hit) return res(hit); if (Date.now() - t0 > ms) return res(null); setTimeout(tick, 50); };
          tick();
        });
      },
      close() { ws.close(); }
    };
    ws.onopen = () => resolve(s);
    ws.onerror = e => reject(e);
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.cid && pending.has(m.cid)) { pending.get(m.cid)(m); pending.delete(m.cid); }
      else pushed.push(m);
    };
  });
}

(async () => {
  // ================================================================== leaderboards
  // the weekly boards reset every minute here: start right after a minute boundary so every write lands in one period
  const sec = new Date().getUTCSeconds();
  if (sec > 8) { console.log(`(waiting ${62 - sec}s for a fresh leaderboard period)`); await sleep((62 - sec) * 1000); }
  const [A, B, C, D] = await Promise.all(['a', 'b', 'c', 'd'].map(auth));

  let r = await rpc(A, 'railbound_leaderboard', {});
  check('catalog lists the 4 boards with the weekly payouts', r.status === 'ok' && r.boards.length === 4 && r.boards.find(b => b.board === 'weekly_kills').payouts[0] === 1000, r);

  await playMatch(A, `soc-${tag}-a1`, 1, 6, { ump: 4, p226: 2 });
  await playMatch(B, `soc-${tag}-b1`, 3, 3, { benelli: 3 });
  await playMatch(C, `soc-${tag}-c1`, 2, 9, { m82: 9 });
  const coinsAfterMatch = {}; for (const u of [A, B, C]) coinsAfterMatch[u.name] = (await profile(u)).coins;

  r = await board(A, 'weekly_kills');
  const ours = r.records.filter(x => [A.uid, B.uid, C.uid].includes(x.userId));
  check('weekly kills: C (9) > A (6) > B (3), with real ranks', ours.map(x => x.userId).join() === [C.uid, A.uid, B.uid].join() && ours.map(x => x.score).join() === '9,6,3' && ours[0].rank < ours[1].rank && ours[1].rank < ours[2].rank, ours);
  check('the reply marks the caller and carries the next reset', r.me && r.me.userId === A.uid && r.me.isMe && r.resetsAt > Date.now() / 1000, { me: r.me, resetsAt: r.resetsAt });
  r = await board(A, 'weekly_wins');
  check('weekly wins: only the winner has a record', r.records.some(x => x.userId === A.uid && x.score === 1) && !r.records.some(x => x.userId === B.uid || x.userId === C.uid), r.records);
  r = await board(B, 'season_xp');
  check('season XP board has the match XP of each player', r.records.filter(x => [A.uid, B.uid, C.uid].includes(x.userId)).length === 3 && r.me && r.me.score > 0, r.me);
  r = await board(B, 'weekly_kills', 'around_me', 5);
  check('around me contains the caller', r.records.some(x => x.isMe && x.userId === B.uid), r.records);

  // friends: A and B become mutual friends; C is not
  await api(A, 'POST', `/v2/friend?ids=${B.uid}`); await api(B, 'POST', `/v2/friend?ids=${A.uid}`);
  r = await board(A, 'weekly_kills', 'friends');
  check('friends board: only A and B, ranked among themselves', r.records.length === 2 && r.records[0].userId === A.uid && r.records[0].rank === 1 && r.records[1].userId === B.uid && r.records[1].rank === 2, r.records);

  // a duplicate report adds nothing; a client cannot write a score
  await srv('railbound_report_match', { matchId: `soc-${tag}-a1`, players: [{ userId: A.uid, placement: 1, totalPlayers: 20, kills: 6, survivedSeconds: 600 }] });
  r = await board(A, 'alltime_kills');
  check('a match reported twice is counted once', r.me && r.me.score === 6, r.me);
  const w = await api(A, 'POST', `/v2/leaderboard/railbound_weekly_kills`, { score: '9999' });
  check('a client cannot write to a leaderboard', w.status >= 400, w);
  r = await rpc(A, 'railbound_leaderboard_payout', { board: 'weekly_kills', expiry: 1 });
  check('a client cannot run a payout', r.httpStatus >= 400, r);
  r = await srv('railbound_leaderboard_payout', { board: 'weekly_kills', expiry: Math.floor(Date.now() / 1000) + 3600 });
  check('a payout of a period that has not ended is refused', r.status === 'period_not_ended', r);

  // ================================================================== notifications from the match
  let notes = await inbox(A);
  const codes = notes.map(n => n.code);
  check('A got a match result (100), a level up (101), a weapon level up (102) and a battle pass tier (103)', [100, 101, 102, 103].every(c => codes.includes(c)), notes.map(n => [n.code, n.subject]));
  const res = notes.find(n => n.code === 100);
  check('the match result has placement, kills, XP and coins', res && res.content.placement === 1 && res.content.kills === 6 && res.content.xp > 0 && res.content.coins > 0, res);
  const wl = notes.find(n => n.code === 102);
  check('the weapon level up names the UMP', wl && wl.content.weapons.some(x => x.weapon === 'ump' && x.level === 2), wl);

  // ================================================================== gifts and announcements
  r = await srv('railbound_send_gift', { giftId: `gift-${tag}-a`, coins: 300, subject: 'SORRY FOR THE DOWNTIME', message: 'thanks for playing', userIds: [A.uid] });
  check('ops send a gift to A', r.status === 'ok', r);
  r = await srv('railbound_send_gift', { giftId: `gift-${tag}-a`, coins: 300, userIds: [A.uid] });
  check('the same gift id cannot be sent twice', r.status === 'exists', r);
  r = await rpc(A, 'railbound_send_gift', { giftId: `gift-${tag}-x`, coins: 10000 });
  check('a client cannot send a gift', r.httpStatus >= 400, r);
  notes = await rpc(A, 'railbound_inbox');
  const gn = notes.notifications.find(n => n.code === 120);
  check('A has the gift in the inbox, unclaimed', gn && gn.content.coins === 300 && gn.claimed === false && notes.unclaimedGifts === 1, gn);
  const before = (await profile(A)).coins;
  r = await rpc(A, 'railbound_claim_gift', { giftId: `gift-${tag}-a` });
  check('A claims it: +300 coins', r.status === 'ok' && r.profile.coins === before + 300, { status: r.status, coins: r.profile && r.profile.coins, before });
  r = await rpc(A, 'railbound_claim_gift', { giftId: `gift-${tag}-a` });
  check('a gift is paid once', r.status === 'already_claimed' && r.profile.coins === before + 300, r.status);
  r = await rpc(B, 'railbound_claim_gift', { giftId: `gift-${tag}-a` });
  check('B cannot claim a gift addressed to A', r.status === 'not_eligible', r.status);
  notes = await rpc(A, 'railbound_inbox');
  check('the inbox now shows the gift as claimed', notes.notifications.find(n => n.code === 120).claimed === true && notes.unclaimedGifts === 0, notes.unclaimedGifts);
  const par = await Promise.all([1, 2, 3, 4].map(() => rpc(B, 'railbound_claim_gift', { giftId: `gift-${tag}-all` })));
  r = await srv('railbound_send_gift', { giftId: `gift-${tag}-all`, coins: 50, subject: 'WEEKEND BONUS' });
  const bBefore = (await profile(B)).coins;
  const claims = await Promise.all([1, 2, 3, 4].map(() => rpc(B, 'railbound_claim_gift', { giftId: `gift-${tag}-all` })));
  const bAfter = (await profile(B)).coins;
  check('a gift to everybody: 4 parallel claims pay exactly once', par.every(x => x.status === 'unknown_gift') && claims.filter(x => x.status === 'ok').length === 1 && bAfter === bBefore + 50, { statuses: claims.map(x => x.status), bBefore, bAfter });

  const listen = await socket(D);
  r = await srv('railbound_announce', { subject: `SERVER MAINTENANCE ${tag}`, message: 'Friday 02:00 UTC', toChat: true });
  check('ops announce to everybody', r.status === 'ok', r);
  const live = await listen.waitFor(m => m.notifications && m.notifications.notifications.some(n => n.code === 130 && n.subject.includes(tag)), 3000);
  check('an online player gets the announcement live', !!live, listen.pushed.slice(-3));
  check('and it stays in the inbox', (await inbox(D)).some(n => n.code === 130 && n.subject.includes(tag)), null);

  // ================================================================== chat
  const sa = await socket(A), sb = await socket(B), sc = await socket(C);
  let j = await sa.join('global', 1);
  const globalId = j.channel && j.channel.id;
  check('players can join the global room', !!globalId, j);
  for (const s of [sb, sc, listen]) await s.join('global', 1);
  j = await sa.join('secret-room', 1);
  check('a room that is not on the list is refused', !!j.error, j);
  j = await sa.join(D.uid, 2);
  check('a direct message to a non-friend is refused', !!j.error, j);
  j = await sa.join(B.uid, 2);
  check('a direct message to a friend is allowed', !!(j.channel && j.channel.id), j);

  // the victory feed and the announcement are in the room history
  const hist = await api(A, 'GET', `/v2/channel/${encodeURIComponent(globalId)}?limit=100&forward=false`);
  const texts = (hist.body.messages || []).map(m => JSON.parse(m.content));
  check('the global room shows the server victory feed for A', texts.some(t => t.system && t.kind === 'victory' && t.message.includes(A.username)), texts.slice(0, 5));
  check('the announcement was posted to the global room', texts.some(t => t.system && t.kind === 'announcement' && t.message.includes(tag)), texts.slice(0, 5));

  // the filter
  let ack = await sc.say(globalId, 'you are a fuuuck1ng sh1t, visit www.cheats.ru for aimbot');
  const filtered = await listen.waitFor(m => m.channel_message && m.channel_message.message_id === (ack.channel_message_ack || {}).message_id, 2000);
  const fc = filtered ? JSON.parse(filtered.channel_message.content) : {};
  check('blocked words are starred and links removed', ack.channel_message_ack && fc.filtered === true && !/fu+ck|sh1t/i.test(fc.message) && fc.message.includes('[link removed]') && fc.message.includes('aimbot'), fc);
  ack = await sc.say(globalId, 'x'.repeat(201));
  check('a message over 200 characters is refused', !!ack.error, ack);
  ack = await sc.say(globalId, '   ');
  check('an empty message is refused', !!ack.error, ack);
  await sc.say(globalId, 'gg everyone');
  ack = await sc.say(globalId, 'GG everyone');
  check('the same message again is refused as spam', !!ack.error && /same message/.test(ack.error.message), ack);

  // mentions
  await sleep(1100);
  ack = await sc.say(globalId, `nice shot @${B.username}`);
  const ping = await sb.waitFor(m => m.notifications && m.notifications.notifications.some(n => n.code === 141), 2000);
  check('an @mention pings the mentioned player', !!ack.channel_message_ack && !!ping, { ack, last: sb.pushed.slice(-2) });

  // the rate limit
  const burst = [];
  for (let i = 0; i < 12; i++) burst.push(await sb.say(globalId, `burst ${i} ${tag}`));
  const refused = burst.filter(x => x.error && /slow down/.test(x.error.message)).length;
  check('a burst of 12 messages is rate limited (at most 5 per 10 s)', refused >= 2 && burst.length - refused <= 10, { refused });

  // reports: three different players report A, A is muted automatically and told
  const bad = await sa.say(globalId, `buy cheap coins ${tag}`);
  const msgId = bad.channel_message_ack.message_id;
  r = await rpc(B, 'railbound_chat_report', { channelId: globalId, messageId: 'not-a-message', reason: 'spam' });
  check('a report of a message that does not exist is refused', r.status === 'not_found', r);
  r = await rpc(A, 'railbound_chat_report', { channelId: globalId, messageId: msgId, reason: 'spam' });
  check('a player cannot report their own message', r.status === 'not_reportable', r);
  r = await rpc(B, 'railbound_chat_report', { channelId: globalId, messageId: msgId, reason: 'spam' });
  const r2 = await rpc(B, 'railbound_chat_report', { channelId: globalId, messageId: msgId, reason: 'spam' });
  check('a second report by the same player is ignored', r.status === 'ok' && !r.autoMuted && r2.status === 'already_reported', [r, r2]);
  r = await rpc(C, 'railbound_chat_report', { channelId: globalId, messageId: msgId, reason: 'spam' });
  check('two reporters: not muted yet', r.status === 'ok' && !r.autoMuted, r);
  r = await rpc(D, 'railbound_chat_report', { channelId: globalId, messageId: msgId, reason: 'spam' });
  check('the third reporter mutes A', r.status === 'ok' && r.autoMuted === true, r);
  ack = await sa.say(globalId, 'am I muted?');
  check('a muted player cannot send', !!ack.error && /muted/.test(ack.error.message), ack);
  const muteNote = await sa.waitFor(m => m.notifications && m.notifications.notifications.some(n => n.code === 140), 2000);
  check('A is told about the mute', !!muteNote, sa.pushed.slice(-2));
  r = await rpc(A, 'railbound_chat_mute', { userId: A.uid, minutes: 0 });
  check('a client cannot unmute itself', r.httpStatus >= 400, r);
  r = await srv('railbound_chat_mute', { userId: A.uid, minutes: 0, reason: 'appeal accepted' });
  ack = await sa.say(globalId, `back again ${tag}`);
  check('ops unmute A and A can talk again', r.status === 'ok' && !!ack.channel_message_ack, { r, ack });
  for (const s of [sa, sb, sc, listen]) s.close();

  // ================================================================== the weekly reset pays the top 3
  const lb = await board(A, 'weekly_kills');
  const expiry = lb.resetsAt;
  const waitS = Math.max(0, expiry - Math.floor(Date.now() / 1000)) + 4;
  console.log(`(waiting ${waitS}s for the weekly boards to reset)`);
  await sleep(waitS * 1000);
  let payA = 0, payB = 0, payC = 0;
  for (let i = 0; i < 20; i++) {
    const [pa, pb, pc] = await Promise.all([profile(A), profile(B), profile(C)]);
    payA = pa.coins - coinsAfterMatch.a - 300; payB = pb.coins - coinsAfterMatch.b - 50; payC = pc.coins - coinsAfterMatch.c;
    if (payA >= 1500 && payB >= 250 && payC >= 1000) break;
    await sleep(1000);
  }
  check('reset paid weekly kills #1 C 1000, #2 A 500, #3 B 250 and weekly wins #1 A 1000', payC === 1000 && payA === 1500 && payB === 250, { payA, payB, payC });
  notes = await inbox(C);
  const lbn = notes.find(n => n.code === 110);
  check('the winner gets a leaderboard reward notification', lbn && lbn.content.rank === 1 && lbn.content.coins === 1000 && lbn.content.board === 'weekly_kills', lbn);
  r = await srv('railbound_leaderboard_payout', { board: 'weekly_kills', expiry });
  const again = (r.paid || []).filter(p => [A.uid, B.uid, C.uid].includes(p.userId));
  check('running the payout of that period again pays nobody twice', r.status === 'ok' && again.length === 3 && again.every(p => p.status === 'already_paid'), r);
  r = await board(A, 'weekly_kills');
  check('the new week starts empty for these players', !r.records.some(x => [A.uid, B.uid, C.uid].includes(x.userId)), r.records.length);
  r = await board(A, 'alltime_kills');
  check('all-time kills keep counting across the reset', r.me && r.me.score === 6, r.me);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
