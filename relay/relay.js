// TV Cast relay: the TV asks this PC for the video, this PC asks the site with the browser's headers.
// Sites that gate on Referer/Origin/cookies then serve the TV too. Bytes pass through untouched (no transcoding).
const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');

const PORT = 8723;
const LOG = path.join(os.tmpdir(), 'tv-cast-relay.log');
const sessions = new Map(); // id -> { headers, seen }

const log = (...a) => fs.appendFile(LOG, `${new Date().toISOString()} ${a.join(' ')}\n`, () => {});
process.on('uncaughtException', (e) => log('uncaught', e.stack || e)); // one bad request must not kill the relay
process.on('unhandledRejection', (e) => log('rejection', e && e.stack || e));

// Only the LAN talks to us: without this the relay would be an open proxy
const local = (ip) => /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)|^::1$/.test(ip || '');

// Every URI in a playlist (segments, sub-playlists, keys, audio tracks) goes back through us with the same headers
function rewrite(text, base, id, origin) {
  const wrap = (u) => {
    const abs = new URL(u, base).href;
    const ext = /\.m3u8(\?|$)/i.test(abs) ? 'm3u8' : (abs.match(/\.(\w{1,5})(\?|$)/)?.[1] || 'bin');
    return `${origin}/${id}/x.${ext}?u=${encodeURIComponent(abs)}`;
  };
  return text.split(/\r?\n/).map((l) =>
    !l ? l : l.startsWith('#') ? l.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(u)}"`) : wrap(l.trim())
  ).join('\n');
}

// Our address as the TV sees it: the interface that routes to the TV
function lanIp(tv) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.connect(9, tv, (err) => { const ip = err ? null : s.address().address; s.close(); resolve(ip); });
  });
}

// Magic packet: 6 x 0xFF then the MAC 16 times, broadcast on the TV's subnet (or everywhere)
const magic = (mac) => Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(Buffer.from(mac.replace(/[:-]/g, ''), 'hex'))]);
function wake(mac, tv) {
  const to = /^\d+\.\d+\.\d+\.\d+$/.test(tv) ? tv.replace(/\.\d+$/, '.255') : '255.255.255.255';
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(() => {
      s.setBroadcast(true);
      const pkt = magic(mac);
      let left = 3; // UDP gets lost; three tries is the usual
      for (let i = 0; i < 3; i++) s.send(pkt, 9, to, () => { if (--left === 0) { s.close(); resolve(); } });
    });
  });
}

async function upstream(url, headers, req) {
  const h = { ...headers };
  if (req.headers.range) h.range = req.headers.range; // seeking in plain .mp4
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { headers: h, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      if (res.status >= 500 && i === 0) continue; // CDNs hiccup; one retry
      return res;
    } catch (e) { if (i > 0) throw e; }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!local(req.socket.remoteAddress)) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/ping') { res.writeHead(200).end('ok'); return; }

    // The extension registers a stream. The custom header forces a CORS preflight we never answer,
    // so web pages cannot register streams; the extension has host permission and skips CORS.
    if (url.pathname === '/new' && req.method === 'POST') {
      if (req.headers['x-tv-cast'] !== '1') { res.writeHead(403).end(); return; }
      let body = '';
      for await (const c of req) body += c;
      const { url: target, headers = {}, tv } = JSON.parse(body);
      const ip = await lanIp(tv);
      // Try it before handing it to the TV: a site that refuses us too would only show up as a vague 716 there
      const probe = await upstream(target, headers, { headers: {} }).catch(() => null);
      if (!probe?.ok) {
        probe?.body?.cancel().catch(() => {});
        log('refused', probe?.status, new URL(target).host);
        res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: probe?.status || 0 }));
        return;
      }
      probe.body?.cancel().catch(() => {});
      const id = crypto.randomBytes(9).toString('base64url');
      sessions.set(id, { headers, seen: Date.now() });
      const ext = /\.m3u8(\?|$)/i.test(target) ? 'm3u8' : (target.match(/\.(\w{1,5})(\?|$)/)?.[1] || 'mp4');
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ url: `http://${ip}:${PORT}/${id}/x.${ext}?u=${encodeURIComponent(target)}` }));
      log('new', id, new URL(target).host);
      return;
    }

    // Wake-on-LAN for the TV: browsers cannot send UDP. Same header guard as /new.
    if (url.pathname === '/wake' && req.method === 'POST') {
      if (req.headers['x-tv-cast'] !== '1') { res.writeHead(403).end(); return; }
      let body = '';
      for await (const c of req) body += c;
      const { mac = '', tv = '' } = JSON.parse(body);
      if (!/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(mac)) { res.writeHead(400).end(); return; }
      await wake(mac, tv);
      res.writeHead(200).end('ok');
      return;
    }

    const [, id] = url.pathname.split('/');
    const s = sessions.get(id);
    const target = url.searchParams.get('u');
    if (!s || !target || !/^https?:/.test(target)) { res.writeHead(404).end(); return; }
    s.seen = Date.now();

    const up = await upstream(target, s.headers, req);
    const type = up.headers.get('content-type') || '';
    if (/mpegurl/i.test(type) || /\.m3u8(\?|$)/i.test(target)) {
      const text = await up.text();
      if (!up.ok || !text.startsWith('#EXTM3U')) { log('playlist', up.status, new URL(target).host); res.writeHead(up.ok ? 502 : up.status).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' })
        .end(rewrite(text, up.url || target, id, `http://${req.headers.host}`));
      return;
    }
    const out = { 'Content-Type': type || 'application/octet-stream' };
    for (const k of ['content-length', 'content-range', 'accept-ranges']) if (up.headers.get(k)) out[k] = up.headers.get(k);
    if (up.headers.get('content-encoding')) delete out['content-length']; // fetch already decompressed it
    res.writeHead(up.status, out);
    if (!up.body) { res.end(); return; }
    const body = Readable.fromWeb(up.body);
    body.on('error', () => res.destroy());
    res.on('close', () => body.destroy()); // TV hung up: stop downloading
    body.pipe(res);
  } catch (e) {
    log('req', req.url.slice(0, 120), e.message);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
});

// Sessions die after 12 h idle; a match plus extra time fits easily
setInterval(() => { for (const [id, s] of sessions) if (Date.now() - s.seen > 12 * 3600e3) sessions.delete(id); }, 3600e3).unref();

if (process.argv[2] === '--selftest') {
  const out = rewrite('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:5,\nseg/1.ts?t=a\nhttps://cdn.x/2.ts\n', 'https://s.tv/live/index.m3u8?tok=1', 'ID', 'http://pc:8723');
  const lines = out.split('\n');
  const check = (cond, msg) => { if (!cond) { console.error('FAIL', msg, '\n' + out); process.exit(1); } };
  check(lines[1] === `#EXT-X-KEY:METHOD=AES-128,URI="http://pc:8723/ID/x.bin?u=${encodeURIComponent('https://s.tv/live/key.bin')}"`, 'key');
  check(lines[3] === `http://pc:8723/ID/x.ts?u=${encodeURIComponent('https://s.tv/live/seg/1.ts?t=a')}`, 'relative segment');
  check(lines[4].endsWith(encodeURIComponent('https://cdn.x/2.ts')), 'absolute segment');
  check(local('::ffff:192.168.1.20') && local('127.0.0.1') && !local('8.8.8.8'), 'lan filter');
  const pkt = magic('AA:BB:CC:DD:EE:FF');
  check(pkt.length === 102 && pkt.subarray(0, 6).every((b) => b === 0xff) && pkt.subarray(96).toString('hex') === 'aabbccddeeff', 'magic packet');
  console.log('selftest ok');
  process.exit(0);
}

server.on('error', (e) => { log('listen', e.code); process.exit(e.code === 'EADDRINUSE' ? 0 : 1); }); // already running = fine
server.listen(PORT, '0.0.0.0', () => log('listening', PORT));
