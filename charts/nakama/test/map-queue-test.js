// How to run: a local Nakama 3.37 (docker) with this chart's module, runtime.http_key test-http-key-not-the-default,
// socket.server_key testkey, runtime.env AGONES_API=http://host.docker.internal:18001 and QUEUE_COUNTDOWN_SECONDS=8, port 17350;
// then: node mock-agones.js &  and  node queue-test.js   (Node 22+, built-in fetch and WebSocket). Never against the live server.
// Integration test: a Classic BR queue on a chosen map (key "classic_solo-<map>") allocates a server with that map.
// Based on queue-test.js; the matchmaking queue against a LOCAL Nakama (docker) with a mock Agones.
// Throwaway device accounts only. Countdown is 8 s here (runtime.env QUEUE_COUNTDOWN_SECONDS=8).
const HOST = 'http://localhost:17350', WS = 'ws://localhost:17350/ws', SERVER_KEY = 'testkey', HTTP_KEY = 'test-http-key-not-the-default';
const AGONES = 'http://localhost:18001';
let pass = 0, fail = 0;
const check = (name, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(extra))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tag = Date.now().toString(36);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function auth(name) {
  const r = await fetch(`${HOST}/v2/account/authenticate/device?create=true`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(SERVER_KEY + ':').toString('base64'), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: `map-queue-test-${name}-${tag}-xxxxxxxx` }) });
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
  const users = await Promise.all(['M1', 'M2', 'D1', 'Z1'].map(auth));
  const [M1, M2, D1, Z1] = await Promise.all(users.map(connect));
  const before = (await stats()).length;

  // two players on DEPOT 9 share one session; a player on MAP-2 gets another; an unknown map is ignored
  const q = await Promise.all([queue(M1, 'classic_solo-depot9'), queue(M2, 'classic_solo-depot9'), queue(D1, 'classic_solo'), queue(Z1, 'classic_solo-nowhere')]);
  check('players on the same map share a session', q[0].reply.sessionId === q[1].reply.sessionId, q.map(x => x.reply));
  check('a MAP-2 player is in another session', q[2].reply.sessionId !== q[0].reply.sessionId, q.map(x => x.reply));

  const ok = await waitFor(() => M1.assigned && M2.assigned && D1.assigned && Z1.assigned, 40000);
  check('every player was assigned a server', ok, [M1.assigned, M2.assigned, D1.assigned, Z1.assigned]);
  const all = (await stats()).slice(before);
  const byMatch = m => all.find(a => a && a.matchId === (m.assigned || {}).matchId) || {};
  check('the DEPOT 9 match was allocated with map depot9', byMatch(M1).map === 'depot9', all);
  check('both DEPOT 9 players got the same match', M1.assigned && M2.assigned && M1.assigned.matchId === M2.assigned.matchId, [M1.assigned, M2.assigned]);
  check('the MAP-2 match has no map annotation', byMatch(D1).map === '', all);
  check('an unknown map is not passed to the server', byMatch(Z1).map === '', all);

  console.log(`
${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
