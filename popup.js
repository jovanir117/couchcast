// ponytail: one TV. Settings page if a second TV ever shows up.
// No setup: the TV is found on the LAN. The router hands it a new IP now and then: remember the last one,
// scan its /24 when it stops answering, and the usual home subnets on first run.
let TV = '';
const avtUrl = () => `http://${TV}:9197/upnp/control/AVTransport1`;

// Standby still answers on 8001 ("PowerState":"standby"); off or another network does not answer at all
const tvInfo = (ip) => fetch(`http://${ip}:8001/api/v2/`, { signal: AbortSignal.timeout(2500) })
  .then((r) => r.json()).then((j) => (j.device?.PowerState ? j.device : null)).catch(() => null);
const powerState = async (ip) => (await tvInfo(ip))?.PowerState || null;

async function tvState() {
  TV = (await chrome.storage.local.get('tv')).tv || '';
  let info = TV ? await tvInfo(TV) : null;
  const subnets = [TV.split('.').slice(0, 3).join('.'), '192.168.1', '192.168.0', '192.168.100', '10.0.0'];
  for (const base of [...new Set(subnets.filter((s) => s.includes('.')))]) {
    if (info) break;
    const hits = await Promise.all(Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`)
      .map(async (ip) => [ip, await tvInfo(ip)]));
    const hit = hits.find(([, d]) => d);
    if (hit) [TV, info] = hit;
  }
  if (!info) return null;
  // The MAC lets the PC relay wake the TV later (Wake-on-LAN)
  chrome.storage.local.set({ tv: TV, ...(info.wifiMac && { tvMac: info.wifiMac }) });
  return info.PowerState;
}

const list = document.getElementById('list');
const status = document.getElementById('status');
const say = (msg, err = false, busy = false) => { status.textContent = msg; status.className = err ? 'err' : busy ? 'busy' : ''; };
const pill = document.getElementById('tv');
const powerBtn = document.getElementById('power');
function showTv(state) {
  pill.className = state === 'on' ? 'on' : state ? 'standby' : 'off';
  pill.textContent = state === 'on' ? 'Prendida' : state ? 'En reposo' : 'No la encuentro';
  powerBtn.hidden = state === 'on';
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// DLNA AVTransport call (the TV's own player does the decoding, so it plays smooth)
async function soap(service, action, args = '') {
  await ready;
  const urn = `urn:schemas-upnp-org:service:${service}:1`;
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${urn}"><InstanceID>0</InstanceID>${args}</u:${action}></s:Body></s:Envelope>`;
  const res = await fetch(`http://${TV}:9197/upnp/control/${service}1`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${urn}#${action}"` },
    body
  });
  const text = await res.text().catch(() => '');
  // 716 = the TV could not open the URL, 714 = format it does not take
  if (!res.ok) throw new Error(`La tele rechazó ${action} (${text.match(/<errorCode>(\d+)/)?.[1] || res.status})`);
  return text;
}
const avt = (action, args) => soap('AVTransport', action, args);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// The TV's player sometimes drops the connection while it digests a failed URL: give it a moment
const avtRetry = (action, args) => avt(action, args).catch(() => wait(2000).then(() => avt(action, args)));

async function tvOn() { return (await tvState()) === 'on'; }

// A site can hand out a URL the TV cannot open (needs the browser's login, or blocks other devices)
async function playingOnTv() {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch(avtUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: '"urn:schemas-upnp-org:service:AVTransport:1#GetTransportInfo"' },
      body: '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetTransportInfo></s:Body></s:Envelope>'
    }).catch(() => null);
    const state = (await res?.text().catch(() => ''))?.match(/<CurrentTransportState>(\w+)/)?.[1];
    if (state === 'PLAYING') return true;
    if (state === 'STOPPED' && i >= 2) return false; // gave up on the URL
  }
  return false;
}

const hms = (s) => [s / 3600, (s % 3600) / 60, s % 60].map((n) => String(Math.floor(n)).padStart(2, '0')).join(':');

async function castUrl(url, startAt, live) {
  const mime = /\.m3u8(\?|$)/i.test(url) ? 'application/vnd.apple.mpegurl' : /\.webm(\?|$)/i.test(url) ? 'video/webm' : 'video/mp4';
  const didl = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>TV Cast</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo="http-get:*:${mime}:*">${esc(url)}</res></item></DIDL-Lite>`;
  await avtRetry('SetAVTransportURI', `<CurrentURI>${esc(url)}</CurrentURI><CurrentURIMetaData>${esc(didl)}</CurrentURIMetaData>`);
  await avtRetry('Play', '<Speed>1</Speed>');
  if (!await playingOnTv()) throw new Error('La tele no pudo abrir este video (el sitio no lo deja salir). Usa su app en la tele.');
  if (startAt > 5 && !live) { // seeking a live stream lands outside its window
    // The TV only accepts Seek once it is playing
    setTimeout(() => avt('Seek', `<Unit>REL_TIME</Unit><Target>${hms(startAt)}</Target>`).catch(() => {}), 4000);
  }
}

// DIAL: opens the TV's YouTube app on this video (its own app, full quality)
async function castYouTube(id, startAt) {
  const res = await fetch(`http://${TV}:8080/ws/apps/YouTube`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset="utf-8"' },
    body: `v=${encodeURIComponent(id)}&t=${Math.floor(startAt)}`
  });
  if (!res.ok && res.status !== 201) throw new Error(`YouTube en la tele no respondió (${res.status})`);
}

// HLS master -> its variants, best first. The TV's player starts low and climbs slowly; naming the top
// variant gets full quality from the first second. Not when audio is a separate track: a variant alone is mute.
async function hlsVariants(url) {
  const text = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(4000) }).then((r) => r.ok ? r.text() : '').catch(() => '');
  if (!text.includes('#EXT-X-STREAM-INF') || /#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI=/.test(text)) return [];
  const lines = text.split(/\r?\n/);
  return lines.flatMap((l, i) => {
    if (!l.startsWith('#EXT-X-STREAM-INF')) return [];
    const uri = lines.slice(i + 1).find((x) => x && !x.startsWith('#'));
    if (!uri) return [];
    const bw = +(l.match(/[:,]BANDWIDTH=(\d+)/)?.[1] || 0);
    const h = +(l.match(/RESOLUTION=\d+x(\d+)/)?.[1] || 0);
    return [{ url: new URL(uri, url).href, bw, h }];
  }).sort((a, b) => b.h - a.h || b.bw - a.bw);
}

// Relay on this PC (relay/relay.js): for sites that only serve the browser (Referer/Origin/cookies)
const RELAY = 'http://127.0.0.1:8723';
const relayUp = () => fetch(`${RELAY}/ping`, { signal: AbortSignal.timeout(800) }).then((r) => r.ok).catch(() => false);

async function viaPc(url, origin) {
  const cookies = await chrome.cookies.getAll({ url }).catch(() => []);
  const headers = { 'User-Agent': navigator.userAgent, Referer: origin + '/', Origin: origin };
  if (cookies.length) headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  await ready;
  const res = await fetch(`${RELAY}/new`, {
    method: 'POST', headers: { 'X-TV-Cast': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, headers, tv: TV }), signal: AbortSignal.timeout(5000)
  }).catch(() => null);
  if (res?.status === 502) throw new Error('Este sitio solo le da el video a Chrome, ni la PC puede sacarlo. Prueba otro canal.');
  if (!res?.ok) throw new Error('El relay de la PC no responde. Ábrelo con relay\\iniciar.vbs');
  return (await res.json()).url;
}

const quality = (v) => [v.h && `${v.h}p`, v.bw && `${(v.bw / 1e6).toFixed(1)} Mbps`].filter(Boolean).join(' · ');

function youTubeId(pageUrl) {
  const u = new URL(pageUrl);
  if (u.hostname === 'youtu.be') return u.pathname.slice(1);
  if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
  return u.searchParams.get('v') || u.pathname.match(/^\/(shorts|live)\/([\w-]+)/)?.[2] || null;
}

// Runs inside the page: playing <video> elements plus media files the page has loaded
function scanPage() {
  const videos = [...document.querySelectorAll('video')].map((v) => ({ src: v.currentSrc, time: v.currentTime || 0, live: v.duration === Infinity, h: v.videoHeight }));
  const files = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.(m3u8|mp4|webm)(\?|$)/i.test(n));
  return { videos, files, origin: location.origin };
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: scanPage }).catch(() => []);
  const videos = results.flatMap((r) => r.result?.videos || []);
  const startAt = Math.max(0, ...videos.map((v) => v.time));
  const live = videos.some((v) => v.live);
  const items = [];

  const yt = tab.url && youTubeId(tab.url);
  if (yt) items.push({ label: 'Abrir en YouTube de la tele', kind: `video ${yt}`, run: () => castYouTube(yt, startAt) });
  say('Buscando la mejor calidad…', false, true);

  // Streams first. Loose .mp4 files only when there is no stream: sites that load video in pieces
  // fetch dozens of segment .mp4s, none playable alone
  const files = [...new Set(results.flatMap((r) => r.result?.files || []))];
  // The frame that loaded each URL is who the site expects as Referer
  const originOf = new Map();
  for (const r of results) for (const u of [...(r.result?.files || []), ...(r.result?.videos || []).map((v) => v.src)]) if (!originOf.has(u)) originOf.set(u, r.result.origin);
  const streams = files.filter((f) => /\.m3u8/i.test(f));
  const urls = new Set([
    ...streams,
    ...videos.map((v) => v.src).filter((s) => /^https?:/.test(s)),
    ...(streams.length ? [] : files)
  ]);
  // DLNA play controls do not reach the YouTube app; volume does
  if (yt) document.querySelectorAll('[data-cmd], .row .sep').forEach((x) => { x.hidden = true; });
  if (!yt) {
    // Best first; the master stays after its variants so the TV can still pick on its own if a variant fails
    // Hosts whose single-quality URLs the TV refused before: straight to the full playlist
    const { masterOnly = [] } = await chrome.storage.local.get('masterOnly');
    const hls = await Promise.all(streams.map(async (url) => ({ url, variants: masterOnly.includes(new URL(url).host) ? [] : await hlsVariants(url) })));
    const best = hls.flatMap((x) => x.variants.map((v) => ({ ...v, origin: originOf.get(x.url) }))).sort((a, b) => b.h - a.h || b.bw - a.bw)
      .map((v) => ({ label: `Mejor calidad (${quality(v) || 'HLS'})`, url: v.url, variant: true, origin: v.origin }));
    const rest = [...urls].map((url) => ({
      label: /\.m3u8/i.test(url) ? (hls.find((x) => x.url === url)?.variants.length ? 'Automática (la tele elige)' : 'Transmisión (HLS)') : 'Video',
      url,
      origin: originOf.get(url)
    }));
    const seen = new Set();
    const direct = [];
    for (const c of [...best.slice(0, 2), ...rest]) {
      if (seen.has(c.url) || direct.length >= 4) continue;
      seen.add(c.url);
      direct.push({ label: c.label, kind: c.url, variant: c.variant, run: () => castUrl(c.url, startAt, live) });
    }
    // Same options through the PC, tried after the direct ones fail. Hosts that needed it before go first.
    const relayed = await relayUp() ? direct.map((d) => {
      const c = [...best, ...rest].find((x) => x.url === d.kind);
      return { ...d, label: `Por la PC: ${d.label}`, relay: true, run: async () => castUrl(await viaPc(d.kind, c.origin || new URL(tab.url).origin), startAt, live) };
    }) : [];
    const { viaPcHosts = [] } = await chrome.storage.local.get('viaPcHosts');
    const needsPc = direct.some((d) => viaPcHosts.includes(new URL(d.kind).host));
    items.push(...(needsPc ? [...relayed, ...direct] : [...direct, ...relayed]));
  }
  say('');

  if (!items.length) {
    say(videos.length
      ? 'Este sitio protege su video (no da un archivo). Usa la app del sitio en la tele.'
      : 'No encontré videos en esta página. Dale play primero y vuelve a abrir esto.', true);
    return;
  }

  // One big button for the best option; the rest stay folded (the big one falls through them anyway)
  const host = (k) => { try { return new URL(k).host; } catch { return k; } };
  const buttons = [];
  items.forEach((item, idx) => {
    const b = idx === 0 ? document.getElementById('go') : document.createElement('button');
    b.innerHTML = idx === 0
      ? `▶ Mandar a la tele<span class="kind">${esc(item.label)}</span>`
      : `${esc(item.label)}<span class="kind">${esc(host(item.kind))}</span>`;
    b.title = item.kind;
    buttons.push(b);
    b.onclick = async () => {
      buttons.forEach((x) => { x.disabled = true; });
      say('Mandando…', false, true);
      try {
        if (!await tvOn()) throw new Error('La tele está apagada o en reposo. Préndela y vuelve a intentar.');
        let err;
        for (const next of items.slice(idx)) {
          try {
            if (next !== item) {
              say(`Esa no jaló, probando: ${next.label}…`, false, true);
              await avt('Stop').catch(() => {}); // clear the failed URL before the next one
              await wait(1500);
            }
            await next.run();
            const host = new URL(next.kind).host;
            if (next.relay && items.slice(idx).some((x) => !x.relay && items.indexOf(x) < items.indexOf(next))) {
              // Antifragile: direct failed and the PC worked; next time this site goes through the PC first
              const { viaPcHosts = [] } = await chrome.storage.local.get('viaPcHosts');
              if (!viaPcHosts.includes(host)) chrome.storage.local.set({ viaPcHosts: [...viaPcHosts, host].slice(-50) });
            }
            if (!next.relay && !next.variant && items.slice(idx).some((x) => x.variant)) {
              // Antifragile: the TV refused the single-quality URL but took the full playlist; remember the host
              const { masterOnly = [] } = await chrome.storage.local.get('masterOnly');
              if (!masterOnly.includes(host)) chrome.storage.local.set({ masterOnly: [...masterOnly, host].slice(-50) });
            }
            err = null;
            break;
          } catch (e) { err = e; }
        }
        if (err) throw err;
        // Stop the copy playing here so the sound does not double up
        chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => document.querySelectorAll('video').forEach((v) => v.pause()) });
        say(live ? 'En la tele, en vivo.' : startAt > 5 ? `En la tele, desde ${hms(startAt)}.` : 'En la tele.');
      } catch (e) {
        say(e.message.includes('fetch') ? 'No encontré la tele. ¿Está prendida?' : e.message, true);
      } finally {
        buttons.forEach((x) => { x.disabled = false; });
      }
    };
    if (idx === 0) { b.hidden = false; return; }
    const li = document.createElement('li');
    li.append(b);
    list.append(li);
  });
  document.getElementById('more').hidden = items.length < 2;
}

const tvError = (e) => say(e.message.includes('fetch') ? 'No encontré la tele. ¿Está prendida?' : e.message, true);
document.querySelectorAll('[data-cmd]').forEach((b) => {
  b.onclick = () => avt(b.dataset.cmd, b.dataset.cmd === 'Play' ? '<Speed>1</Speed>' : '')
    .then(() => say({ Pause: 'En pausa.', Play: 'Reproduciendo.', Stop: 'Detenido.' }[b.dataset.cmd]))
    .catch(tvError);
});
document.querySelectorAll('[data-vol]').forEach((b) => {
  b.onclick = async () => {
    try {
      const now = +(await soap('RenderingControl', 'GetVolume', '<Channel>Master</Channel>')).match(/<CurrentVolume>(\d+)/)?.[1];
      const v = Math.max(0, Math.min(100, now + +b.dataset.vol));
      await soap('RenderingControl', 'SetVolume', `<Channel>Master</Channel><DesiredVolume>${v}</DesiredVolume>`);
      say(`Volumen ${v}`);
    } catch (e) { tvError(e); }
  };
});

// A browser cannot send the Wake-on-LAN packet (UDP); the relay on the PC does it
powerBtn.onclick = async () => {
  const { tvMac } = await chrome.storage.local.get('tvMac');
  if (!tvMac) { say('Préndela con el control una vez; después ya la puedo prender desde aquí.', true); return; }
  powerBtn.disabled = true;
  say('Prendiendo la tele…', false, true);
  const sent = await fetch(`${RELAY}/wake`, {
    method: 'POST', headers: { 'X-TV-Cast': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ mac: tvMac, tv: TV }), signal: AbortSignal.timeout(5000)
  }).then((r) => r.ok).catch(() => false);
  if (!sent) { powerBtn.disabled = false; say('Para prenderla desde aquí abre el relay de la PC (relay\\iniciar.vbs). O préndela con el control.', true); return; }
  for (let i = 0; i < 10; i++) {
    await wait(2000);
    const st = await powerState(TV);
    if (st === 'on') { showTv(st); say('Lista.'); powerBtn.disabled = false; return; }
  }
  powerBtn.disabled = false;
  say('No despertó. En la tele activa "Encender con dispositivo móvil" (Ajustes › General › Red › Ajustes de expertos).', true);
};

const ready = tvState(); // Pausa/Play/Detener need the current IP too
ready.then(showTv);
main();
