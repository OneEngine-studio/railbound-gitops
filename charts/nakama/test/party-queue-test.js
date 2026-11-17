// How to run: the same local setup as queue-test.js (local Nakama with this chart's module, QUEUE_COUNTDOWN_SECONDS=8, mock-agones.js).
// Integration test of PARTY queueing: a party is seated as one unit in one session and becomes one team in the match; the game
// server learns each player's team from railbound_validate_join. Throwaway device accounts only. Node 22+.
const HOST = 'http://localhost:17350', WS = 'ws://localhost:17350/ws', SERVER_KEY = 'testkey', HTTP_KEY = 'test-http-key-not-the-default';
let pass = 0, fail = 0;
const check = (name, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(extra))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tag = Date.now().toString(36);

async function auth(name) {
  const r = await fetch(`${HOST}/v2/account/authenticate/device?create=true`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(SERVER_KEY + ':').toString('base64'), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: `party-test-${name}-${tag}-xxxxxxxx` }) });
  const b = await r.json(); const payload = JSON.parse(Buffer.from(b.token.split('.')[1], 'base64url').toString());
  return { name, token: b.token, uid: payload.uid };
}
async function rpc(user, id, obj) {
  const r = await fetch(`${HOST}/v2/rpc/${id}`, { method: 'POST', headers: { Authorization: 'Bearer ' + user.token, 'Content-Type': 'application/json' }, body: JSON.stringify(JSON.stringify(obj || {})) });
  const t = await r.text(); let b; try { b = JSON.parse(t); } catch (e) { b = t; }
  return b && b.payload ? JSON.parse(b.payload) : { httpStatus: r.status, body: b };
}
const srv = async (id, obj) => (await fetch(`${HOST}/v2/rpc/${id}?http_key=${encodeURIComponent(HTTP_KEY)}&unwrap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) })).json();

function connect(user) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}?lang=en&status=false&format=json&token=${encodeURIComponent(user.token)}`);
    const s = { ws, user, assigned: null, failed: null, pending: {}, cid: 0 };
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.cid && s.pending[m.cid]) { s.pending[m.cid](m); delete s.pending[m.cid]; return; }
      if (m.match_data) {
        const op = Number(m.match_data.op_code);
        const data = JSON.parse(Buffer.from(m.match_data.data || '', 'base64').toString() || '{}');
        if (op === 2) s.assigned = data; else if (op === 3) s.failed = data;
      }
    };
    ws.onopen = () => resolve(s); ws.onerror = reject;
  });
}
function send(s, body) { const cid = String(++s.cid); return new Promise(r => { s.pending[cid] = r; s.ws.send(JSON.stringify(Object.assign({ cid }, body))); }); }
async function queue(s, extra) {
  const r = await rpc(s.user, 'railbound_queue_join', Object.assign({ mode: 'br_solo' }, extra || {}));
  if (!r || r.status !== 'queued') return { reply: r };
  const j = await send(s, { match_join: { match_id: r.sessionId } });
  return { reply: r, join: j, ok: !!(j.match) };
}
const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(100); } return pred(); };
const team = async (s) => srv('railbound_validate_join', { matchId: s.assigned.matchId, userId: s.user.uid, token: s.assigned.token });

(async () => {
  // ---------------------------------------------------------------- 1. a party of 3 + 2 solo players
  const [A, B, C, D, E, Z] = await Promise.all(['A', 'B', 'C', 'D', 'E', 'Z'].map(auth).map(p => p.then(connect)));
  const partyId = `party-${tag}.nakama1`;
  const party = [A, B, C].map(s => s.user.uid);

  // a solo player is already counting down in the open session
  const d = await queue(D);
  check('a solo player starts a session', d.ok, d.reply);
  // the leader queues first, the members a moment later (they follow the leader's deploy signal)
  const a = await queue(A, { partyId, party });
  await sleep(1500);
  const [b, c] = await Promise.all([queue(B, { partyId, party }), queue(C, { partyId, party })]);
  check('every party member gets the same session', a.ok && b.ok && c.ok && a.reply.sessionId === b.reply.sessionId && b.reply.sessionId === c.reply.sessionId, [a.reply, b.reply, c.reply]);
  check('the party was put into the open session (it had room)', a.reply.sessionId === d.reply.sessionId, { party: a.reply.sessionId, solo: d.reply.sessionId });
  // somebody who is not in the party uses its id: queued alone, not into the party's team
  const z = await queue(Z, { partyId, party: [Z.user.uid, A.user.uid] });
  const e = await queue(E);

  const allIn = await waitFor(() => [A, B, C, D, E, Z].every(s => s.assigned), 30000);
  check('everybody is assigned a game server', allIn, [A, B, C, D, E, Z].map(s => !!s.assigned));
  const matchIds = new Set([A, B, C, D, E, Z].filter(s => s.assigned).map(s => s.assigned.matchId));
  check('one match for all of them (party + solos)', matchIds.size === 1, [...matchIds]);
  const [ta, tb, tc, td, te, tz] = await Promise.all([A, B, C, D, E, Z].map(team));
  check('the game server is told the party is one team', ta.valid && tb.valid && tc.valid && ta.team >= 0 && ta.team === tb.team && tb.team === tc.team, [ta, tb, tc]);
  check('party members have different slots (0, 1, 2)', new Set([ta.slot, tb.slot, tc.slot]).size === 3 && [ta.slot, tb.slot, tc.slot].every(x => x >= 0 && x <= 2), [ta.slot, tb.slot, tc.slot]);
  check('solo players are each a team of their own', td.team !== ta.team && te.team !== ta.team && td.team !== te.team, [td.team, te.team, ta.team]);
  check('a player outside the party cannot join its team by using its id', tz.valid && tz.team !== ta.team, tz);

  // ---------------------------------------------------------------- 2. a late member: the lock waits for the party
  const [P, Q] = await Promise.all(['P', 'Q'].map(auth).map(p => p.then(connect)));
  const party2 = `party2-${tag}.nakama1`;
  const p = await queue(P, { partyId: party2, party: [P.user.uid, Q.user.uid] });
  await sleep(10500);   // longer than the 8 s countdown: without the reservation the roster would lock without Q
  const q = await queue(Q, { partyId: party2, party: [P.user.uid, Q.user.uid] });
  check('a member who arrives after the countdown still gets the party session', p.ok && q.ok && p.reply.sessionId === q.reply.sessionId, [p.reply, q.reply]);
  await waitFor(() => P.assigned && Q.assigned, 30000);
  check('and plays in the same match as the leader', P.assigned && Q.assigned && P.assigned.matchId === Q.assigned.matchId, [P.assigned, Q.assigned]);
  const [tp, tq] = await Promise.all([team(P), team(Q)]);
  check('on the same team', tp.team === tq.team && tp.team >= 0, [tp, tq]);

  // ---------------------------------------------------------------- 3. a full session: the party gets a new one together
  const fillers = await Promise.all(Array.from({ length: 9 }, (_, i) => auth('F' + i).then(connect)));
  const fq = [];
  for (const f of fillers) fq.push(await queue(f));
  const fullSession = fq[0].reply.sessionId;
  check('9 solo players share one session', fq.every(x => x.ok && x.reply.sessionId === fullSession), fq.map(x => x.reply.sessionId));
  const [R1, R2] = await Promise.all(['R1', 'R2'].map(auth).map(p => p.then(connect)));
  const party3 = `party3-${tag}.nakama1`;
  const r1 = await queue(R1, { partyId: party3, party: [R1.user.uid, R2.user.uid] });
  const r2 = await queue(R2, { partyId: party3, party: [R1.user.uid, R2.user.uid] });
  check('a party of 2 does not split over the 1 free seat: it gets a new session together', r1.ok && r2.ok && r1.reply.sessionId === r2.reply.sessionId && r1.reply.sessionId !== fullSession, { full: fullSession, r1: r1.reply.sessionId, r2: r2.reply.sessionId });
  await waitFor(() => R1.assigned && R2.assigned, 30000);
  check('the pair plays together', R1.assigned && R2.assigned && R1.assigned.matchId === R2.assigned.matchId, [R1.assigned, R2.assigned]);

  for (const s of [A, B, C, D, E, Z, P, Q, R1, R2, ...fillers]) s.ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
