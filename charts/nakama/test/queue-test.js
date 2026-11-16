// How to run: a local Nakama 3.37 (docker) with this chart's module, runtime.http_key test-http-key-not-the-default,
// socket.server_key testkey, runtime.env AGONES_API=http://host.docker.internal:18001 and QUEUE_COUNTDOWN_SECONDS=8, port 17350;
// then: node mock-agones.js &  and  node queue-test.js   (Node 22+, built-in fetch and WebSocket). Never against the live server.
// Integration test of the server-authoritative matchmaking queue against a LOCAL Nakama (docker) with a mock Agones.
// Throwaway device accounts only. Countdown is 8 s here (runtime.env QUEUE_COUNTDOWN_SECONDS=8).
const HOST = 'http://localhost:17350', WS = 'ws://localhost:17350/ws', SERVER_KEY = 'testkey', HTTP_KEY = 'test-http-key-not-the-default';
const AGONES = 'http://localhost:18001';
let pass = 0, fail = 0;
const check = (name, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(extra))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tag = Date.now().toString(36);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function auth(name) {
  const r = await fetch(`${HOST}/v2/account/authenticate/device?create=true`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(SERVER_KEY + ':').toString('base64'), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: `queue-test-${name}-${tag}-xxxxxxxx` }) });
  const b = await r.json(); const payload = JSON.parse(Buffer.from(b.token.split('.')[1], 'base64url').toString());
  return { name, token: b.token, uid: payload.uid };
}
async function rpc(user, id, obj) {
  const r = await fetch(`${HOST}/v2/rpc/${id}`, { method: 'POST', headers: { Authorization: 'Bearer ' + user.token, 'Content-Type': 'application/json' }, body: JSON.stringify(JSON.stringify(obj || {})) });
  const t = await r.text(); let b; try { b = JSON.parse(t); } catch (e) { b = t; }
  return { status: r.status, data: b && b.payload ? JSON.parse(b.payload) : null, body: b };
}
async function srv(id, obj) {
  const r = await fetch(`${HOST}/v2/rpc/${id}?http_key=${encodeURIComponent(HTTP_KEY)}&unwrap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  return r.json();
}

// a realtime socket that records the queue messages it receives
function connect(user) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}?lang=en&status=false&format=json&token=${encodeURIComponent(user.token)}`);
    const s = { ws, user, states: [], assigned: null, failed: null, pending: {}, cid: 0 };
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.cid && s.pending[m.cid]) { s.pending[m.cid](m); delete s.pending[m.cid]; return; }
      if (m.match_data) {
        const op = Number(m.match_data.op_code);
        const data = JSON.parse(Buffer.from(m.match_data.data || '', 'base64').toString() || '{}');
        if (op === 1) s.states.push(data); else if (op === 2) s.assigned = data; else if (op === 3) s.failed = data;
      }
    };
    ws.onopen = () => resolve(s);
    ws.onerror = e => reject(e);
  });
}
function send(s, body) { const cid = String(++s.cid); return new Promise(r => { s.pending[cid] = r; s.ws.send(JSON.stringify(Object.assign({ cid }, body))); }); }
const join = (s, matchId) => send(s, { match_join: { match_id: matchId } });
const leave = (s, matchId) => send(s, { match_leave: { match_id: matchId } });
async function queue(s, mode) {
  const r = await rpc(s.user, 'railbound_queue_join', { mode: mode || 'br_solo' });
  if (!r.data) return { reply: r };
  if (r.data.status !== 'queued') return { reply: r.data };
  const j = await join(s, r.data.sessionId);
  return { reply: r.data, join: j };
}
const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(100); } return pred(); };
const stats = async () => (await fetch(AGONES + '/stats')).json();

(async () => {
  // ---------------------------------------------------------------- 1. five players queue AT THE SAME TIME
  const users = await Promise.all(['A', 'B', 'C', 'D', 'E', 'L', 'X'].map(auth));
  const [A, B, C, D, E, L, X] = await Promise.all(users.map(connect));
  const first = await Promise.all([A, B, C, D, E].map(s => queue(s)));
  const sessions = new Set(first.map(f => f.reply.sessionId));
  check('5 simultaneous requests -> exactly one session', sessions.size === 1, first.map(f => f.reply));
  check('all 5 joined the session over the socket', first.every(f => f.join && f.join.match && f.join.match.authoritative), first.map(f => f.join));
  const S1 = [...sessions][0];

  // the same player asking three times at once stays in one session
  const dup = await Promise.all([1, 2, 3].map(() => rpc(A.user, 'railbound_queue_join', { mode: 'br_solo' })));
  check('duplicate concurrent requests of one player -> its own session, no second seat', dup.every(d => d.data && d.data.sessionId === S1), dup.map(d => d.data));

  // X joins, then leaves before the lock
  const xq = await queue(X);
  check('X joined the same open session', xq.reply.sessionId === S1, xq.reply);
  await sleep(800);
  await leave(X, S1);

  await waitFor(() => A.states.length > 2, 4000);
  const st = A.states[A.states.length - 1] || {};
  check('server broadcasts COUNTDOWN with a server-side countdown and the player count', st.phase === 'COUNTDOWN' && st.countdown > 0 && st.countdown <= 8, st);

  // ---------------------------------------------------------------- 2. countdown ends -> LOCK, new match, assignments
  const got = await waitFor(() => [A, B, C, D, E].every(s => s.assigned), 15000);
  check('after the server countdown every locked player got an assignment', got, [A, B, C, D, E].map(s => !!s.assigned));
  const M = A.assigned ? A.assigned.matchId : '';
  check('the match id is a server-made uuid (not derived from the players)', UUID.test(M), M);
  check('all 5 got the SAME match and server', [B, C, D, E].every(s => s.assigned && s.assigned.matchId === M && s.assigned.port === A.assigned.port), [A, B, C, D, E].map(s => s.assigned));
  check('each player got its OWN join token', new Set([A, B, C, D, E].map(s => s.assigned && s.assigned.token)).size === 5, null);
  check('assignment says 5 players (X left before the lock)', A.assigned && A.assigned.players === 5, A.assigned);
  check('X (left before the lock) got no assignment', !X.assigned, X.assigned);
  const allocs = (await stats()).filter(a => a.matchId === M);
  check('exactly one game server allocated for the match, for 5 players', allocs.length === 1 && allocs[0].players === '5', allocs);

  // ---------------------------------------------------------------- 3. late arrival: never into the started match
  const late = await queue(L);
  check('a late player gets a NEW session, not the locked one', late.reply.status === 'queued' && late.reply.sessionId && late.reply.sessionId !== S1, late.reply);
  const sneak = await join(await connect(users[6]), S1);
  check('joining the locked session directly is refused', !!sneak.error, sneak);
  const lateAlloc = await rpc(users[5], 'railbound_allocate', { matchId: M, players: 1 });
  check('railbound_allocate refuses a player who is not in the roster', lateAlloc.data && lateAlloc.data.status === 'not_in_match', lateAlloc.data || lateAlloc.body);
  const vOut = await srv('railbound_validate_join', { matchId: M, userId: users[5].uid, token: 'x'.repeat(32) });
  check('validate_join refuses a non-roster player', vOut.valid === false, vOut);

  // ---------------------------------------------------------------- 4. reconnect of a locked-in player
  const re = await rpc(B.user, 'railbound_queue_join', { mode: 'br_solo' });
  check('a locked-in player asking again gets its running match back (reconnect)', re.data && re.data.status === 'assigned' && re.data.matchId === M && re.data.token === B.assigned.token, re.data);
  const vIn = await srv('railbound_validate_join', { matchId: M, userId: B.user.uid, token: B.assigned.token });
  check('validate_join accepts a roster player with its ticket', vIn.valid === true, vIn);
  const fresh = await rpc(B.user, 'railbound_queue_join', { mode: 'br_solo', newMatch: true });
  check('asking for a NEW match puts the player into a new session (never the running match)', fresh.data && fresh.data.status === 'queued' && fresh.data.sessionId !== S1, fresh.data);

  // ---------------------------------------------------------------- 5. match over -> COMPLETED
  const rep = await srv('railbound_report_match', { matchId: M, players: [{ userId: A.user.uid, placement: 1, totalPlayers: 20, kills: 0, survivedSeconds: 60 }] });
  check('report_match pays a roster player', rep.results && rep.results[0].status === 'paid', rep);
  const vDone = await srv('railbound_validate_join', { matchId: M, userId: B.user.uid, token: B.assigned.token });
  check('a completed match refuses joins', vDone.valid === false && vDone.reason === 'match_over', vDone);
  const reDone = await rpc(C.user, 'railbound_allocate', { matchId: M, players: 1 });
  check('a completed match is never handed out again', reDone.data && reDone.data.status === 'match_over', reDone.data);

  // ---------------------------------------------------------------- 6. a full session locks at once; the 11th player gets the next one
  const many = await Promise.all(Array.from({ length: 11 }, (_, i) => auth('F' + i)));
  const ms = await Promise.all(many.map(connect));
  const r6 = [];
  for (const s of ms) r6.push(await queue(s, 'br_full'));   // one after the other, as fast as possible
  const firstTen = new Set(r6.slice(0, 10).map(x => x.reply.sessionId));
  check('10 players fill one session', firstTen.size === 1, r6.slice(0, 10).map(x => x.reply.sessionId));
  check('the 11th player gets a different session', r6[10].reply.sessionId && !firstTen.has(r6[10].reply.sessionId), r6[10].reply);
  const full = await waitFor(() => ms.slice(0, 10).every(s => s.assigned), 6000);
  check('a full session locks without waiting for the countdown', full, ms.slice(0, 10).map(s => !!s.assigned));
  check('the 11th player was not assigned with them', !ms[10].assigned, ms[10].assigned);

  // ---------------------------------------------------------------- 7. no game server: the locked players are told, can queue again
  await fetch(AGONES + '/busy?on=1');
  const busyUsers = await Promise.all(['P', 'Q'].map(auth));
  const bs = await Promise.all(busyUsers.map(connect));
  await Promise.all(bs.map(s => queue(s, 'br_busy')));
  const failed = await waitFor(() => bs.every(s => s.failed), 50000);
  check('when no server can be allocated the players get FAILED (servers_busy)', failed && bs[0].failed.reason === 'servers_busy', bs.map(s => s.failed));
  await fetch(AGONES + '/busy?on=0');
  const again = await queue(bs[0], 'br_busy');
  check('after a failure the player can queue again (new session)', again.reply.status === 'queued' && again.reply.sessionId !== (bs[0].states[0] || {}).sessionId, again.reply);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
