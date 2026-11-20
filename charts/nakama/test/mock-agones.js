// mock of POST /apis/allocation.agones.dev/v1/namespaces/<ns>/gameserverallocations
// every allocation gets its own server name and port; GET /busy?on=1 makes it answer UnAllocated (all servers busy); GET /stats lists them
let n = 0, busy = false;
const allocations = [];
require('http').createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/busy')) { busy = req.url.includes('on=1'); res.end('busy=' + busy); return; }
  if (req.method === 'GET' && req.url.startsWith('/stats')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(allocations)); return; }
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (busy) { res.end(JSON.stringify({ status: { state: 'UnAllocated' } })); return; }
    n++;
    let body = {}; try { body = JSON.parse(b); } catch (e) { }
    const ann = (body.spec && body.spec.metadata && body.spec.metadata.annotations) || {};
    allocations.push({ name: 'mock-gs-' + n, matchId: ann['railbound.io/match-id'], players: ann['railbound.io/expected-players'] });
    res.end(JSON.stringify({ status: { state: 'Allocated', gameServerName: 'mock-gs-' + n, address: '127.0.0.1', ports: [{ name: 'game', port: 7100 + n }] } }));
  });
}).listen(18001, '0.0.0.0', () => console.log('mock agones on 18001'));
