// Integration test of the progression RPCs (weapon mastery, loadout, skills, battle pass) against a LOCAL Nakama (docker).
// Throwaway device accounts only. Same setup as queue-test.js (http key test-http-key-not-the-default, server key testkey, port 17350).
const HOST = 'http://localhost:17350', SERVER_KEY = 'testkey', HTTP_KEY = 'test-http-key-not-the-default';
let pass = 0, fail = 0;
const check = (name, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(extra))); };
const tag = Date.now().toString(36);

async function auth(name) {
  const r = await fetch(`${HOST}/v2/account/authenticate/device?create=true`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(SERVER_KEY + ':').toString('base64'), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: `prog-test-${name}-${tag}-xxxxxxxx` }) });
  const b = await r.json(); const payload = JSON.parse(Buffer.from(b.token.split('.')[1], 'base64url').toString());
  return { name, token: b.token, uid: payload.uid };
}
async function rpc(user, id, obj) {
  const r = await fetch(`${HOST}/v2/rpc/${id}`, { method: 'POST', headers: { Authorization: 'Bearer ' + user.token, 'Content-Type': 'application/json' }, body: JSON.stringify(JSON.stringify(obj || {})) });
  const t = await r.text(); let b; try { b = JSON.parse(t); } catch (e) { b = t; }
  return b && b.payload ? JSON.parse(b.payload) : { httpStatus: r.status, body: b };
}
async function srv(id, obj) {
  const r = await fetch(`${HOST}/v2/rpc/${id}?http_key=${encodeURIComponent(HTTP_KEY)}&unwrap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  return r.json();
}
// a real allocation so the report pays this player (only players sent to the match are paid)
async function playMatch(user, matchId, placement, kills, weaponKills) {
  await rpc(user, 'railbound_allocate', { matchId, players: 1 });
  return srv('railbound_report_match', { matchId, players: [{ userId: user.uid, placement, totalPlayers: 20, kills, survivedSeconds: 600, weaponKills }] });
}

(async () => {
  const A = await auth('A');

  // ---- profile: defaults and the rule tables come from the server
  let r = await rpc(A, 'railbound_profile');
  check('profile has the default loadout (P226, no melee, no lethal)', r.profile && r.profile.loadout.sidearm === 'p226' && r.profile.loadout.melee === 'none' && r.profile.loadout.lethal === 'none', r.profile && r.profile.loadout);
  check('skills start at level 0', r.profile && r.profile.skills.sonar === 0 && r.profile.skills.medkit === 0, r.profile && r.profile.skills);
  check('season starts at tier 1 with 0 XP', r.seasonTier === 1 && r.profile.season.xp === 0, { tier: r.seasonTier, season: r.profile && r.profile.season });
  check('reply carries the rule tables (loadout unlocks, skills, 40 battle pass tiers)', r.tables && r.tables.loadoutSlots.sidearm.p226dual === 5 && r.tables.skills.sonar.costs[0] === 1000 && r.tables.season.rewards.length === 40, r.tables && Object.keys(r.tables));

  // ---- loadout: level gates and validation
  r = await rpc(A, 'railbound_set_loadout', { sidearm: 'p226dual' });
  check('P226 DUAL is locked at level 1', r.status === 'locked' && r.profile.loadout.sidearm === 'p226', r);
  r = await rpc(A, 'railbound_set_loadout', { sidearm: 'ump' });
  check('a primary cannot be a starting sidearm', r.status === 'unknown_item', r.status);
  r = await rpc(A, 'railbound_set_loadout', { melee: 'bat' });
  check('the bat (level 1) can be equipped', r.status === 'ok' && r.profile.loadout.melee === 'bat', r.status);
  r = await rpc(A, 'railbound_set_loadout', { lethal: 'grenade' });
  check('the grenade is locked below level 8', r.status === 'locked' && r.profile.loadout.lethal === 'none', r.status);

  // ---- skills: level gate and coins
  r = await rpc(A, 'railbound_upgrade_skill', { skill: 'sonar' });
  check('sonar level 1 needs player level 2', r.status === 'locked' && r.profile.skills.sonar === 0, r.status);
  r = await rpc(A, 'railbound_upgrade_skill', { skill: 'jetpack' });
  check('unknown skill is refused', r.status === 'unknown_skill', r.status);

  // ---- the client cannot write the profile itself
  const w = await fetch(`${HOST}/v2/storage`, { method: 'PUT', headers: { Authorization: 'Bearer ' + A.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ objects: [{ collection: 'player_economy', key: 'profile', value: JSON.stringify({ skills: { sonar: 3 }, loadout: { lethal: 'grenade' } }), permission_read: 1, permission_write: 1 }] }) });
  check('client cannot overwrite skills or loadout', w.status >= 400, w.status);

  // ---- a match: weapon XP for the weapons that got the kills, season XP, level-ups
  let rep = await playMatch(A, 'prog-' + tag + '-1', 1, 6, { ump: 4, p226: 2, rocket_launcher: 5 });
  r = await rpc(A, 'railbound_profile');
  const ump = r.profile.weapons.ump, p226 = r.profile.weapons.p226;
  check('UMP got 4 kills of weapon XP (400 XP: level 2 with 100 left)', ump && ump.kills === 4 && ump.level === 2 && ump.xp === 100, ump);
  check('P226 got 2 kills (200 XP, still level 1)', p226 && p226.kills === 2 && p226.level === 1 && p226.xp === 200, p226);
  check('an unknown weapon id is ignored', !r.profile.weapons.rocket_launcher, Object.keys(r.profile.weapons));
  check('match result lists the weapon progress', r.profile.lastAward && r.profile.lastAward.weapons && r.profile.lastAward.weapons.length === 2, r.profile.lastAward && r.profile.lastAward.weapons);
  check('season XP grew by the match XP (win, 6 kills, 10 min: 1650)', r.profile.season.xp === 1650 && r.seasonTier === 2, { xp: r.profile.season.xp, tier: r.seasonTier });

  rep = await playMatch(A, 'prog-' + tag + '-2', 5, 2, { ump: 50 });
  r = await rpc(A, 'railbound_profile');
  check('weapon kills are capped at the kills of the match (2, not 50)', r.profile.weapons.ump.kills === 6, r.profile.weapons.ump);
  rep = await playMatch(A, 'prog-' + tag + '-2', 5, 2, { ump: 2 });
  r = await rpc(A, 'railbound_profile');
  check('a match is paid once (weapon XP too)', r.profile.weapons.ump.kills === 6, r.profile.weapons.ump);

  // ---- battle pass: claim coins of a reached tier, once
  r = await rpc(A, 'railbound_claim_tier', { tier: 2 });
  const coinsAfter = r.profile && r.profile.coins;
  check('tier 2 (reached) pays its 250 coins', r.status === 'ok' && r.profile.season.claimed.indexOf(2) >= 0, r.status);
  r = await rpc(A, 'railbound_claim_tier', { tier: 2 });
  check('tier 2 cannot be claimed twice', r.status === 'already_claimed' && r.profile.coins === coinsAfter, r.status);
  r = await rpc(A, 'railbound_claim_tier', { tier: 1 });
  check('a cosmetic tier is not claimable yet', r.status === 'not_claimable', r.status);
  r = await rpc(A, 'railbound_claim_tier', { tier: 40 });
  check('a tier not reached cannot be claimed', r.status === 'not_reached', r.status);

  // ---- enough matches for level 5+: then P226 DUAL and the first skill upgrades unlock
  for (let i = 0; i < 6; i++) await playMatch(A, 'prog-' + tag + '-lv' + i, 1, 8, { p226dual: 3 });
  r = await rpc(A, 'railbound_profile');
  check('the player is level 5 or higher now', r.profile.level >= 5, r.profile.level);
  r = await rpc(A, 'railbound_set_loadout', { sidearm: 'p226dual' });
  check('P226 DUAL can be equipped from level 5', r.status === 'ok' && r.profile.loadout.sidearm === 'p226dual', r.status);
  const before = r.profile.coins;
  r = await rpc(A, 'railbound_upgrade_skill', { skill: 'sonar' });
  check('sonar level 1 costs 1000 coins', r.status === 'ok' && r.profile.skills.sonar === 1 && r.profile.coins === before - 1000, { status: r.status, coins: r.profile && r.profile.coins, before });
  const results = await Promise.all([1, 2, 3, 4].map(() => rpc(A, 'railbound_upgrade_skill', { skill: 'medkit' })));
  r = await rpc(A, 'railbound_profile');
  const oks = results.filter(x => x.status === 'ok').length;
  check('4 parallel medkit upgrades: no lost or double charge (level matches what was paid)', r.profile.skills.medkit === oks, { oks, level: r.profile.skills.medkit, statuses: results.map(x => x.status) });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
