// VāgVis — itinéraires réels (bus, train, marche) via ResRobot / Trafiklab
// Appel : /api/trip?fromLat=..&fromLng=..&toLat=..&toLng=..
// La clé se range dans Netlify (variable d'environnement RESROBOT_KEY), jamais dans le code.

export const config = { path: '/api/trip' };

function parseIso(iso) {
  if (!iso || typeof iso !== 'string') return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!m) return 0;
  return parseInt(m[1] || '0', 10) * 60 + parseInt(m[2] || '0', 10) + Math.round(parseInt(m[3] || '0', 10) / 60);
}

function toMs(date, time) {
  if (!date || !time) return NaN;
  return new Date(`${date}T${time}`).getTime();
}

function hhmm(t) {
  return typeof t === 'string' ? t.slice(0, 5) : '';
}

function product(leg) {
  const p = leg.Product;
  if (Array.isArray(p)) return p[0] || {};
  return p || {};
}

function legKind(leg) {
  const t = String(leg.type || '').toUpperCase();
  if (t !== 'JNY') return 'walk'; // WALK, TRSF (changement à pied), etc.
  const p = product(leg);
  const txt = `${leg.name || ''} ${p.name || ''} ${p.catOutL || ''} ${p.catOut || ''}`.toLowerCase();
  if (/tåg|tag\b|train|pendel|öresund|oresund|pågatåg|pagatag|jnt/.test(txt)) return 'train';
  return 'bus';
}

function legLabel(leg, kind) {
  const p = product(leg);
  let name = String(leg.name || p.name || '').trim();
  name = name.replace(/^.*? - /, '').replace(/^Buss\b/i, 'Bus').trim();
  if (!name) name = kind === 'train' ? 'Train' : 'Bus';
  return name.slice(0, 28);
}

export function mapTrips(data) {
  const raw = data.Trip || data.trip || [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.slice(0, 6).map((trip, idx) => {
    const legRaw = (trip.LegList && trip.LegList.Leg) || [];
    const legs = Array.isArray(legRaw) ? legRaw : [legRaw];
    let walking = 0;
    const modes = new Set();
    const pills = [];
    const steps = [];
    const outLegs = [];
    legs.forEach((leg) => {
      const kind = legKind(leg);
      modes.add(kind);
      const o = leg.Origin || {};
      const d = leg.Destination || {};
      let mins = parseIso(leg.duration);
      if (!mins) {
        const a = toMs(o.date, o.time), b = toMs(d.date || o.date, d.time);
        if (Number.isFinite(a) && Number.isFinite(b)) mins = Math.max(1, Math.round((b - a) / 60000));
      }
      if (!mins) mins = 1;
      const label = kind === 'walk' ? `${mins} min` : legLabel(leg, kind);
      if (kind === 'walk') {
        walking += mins;
        if (mins >= 2) pills.push({ type: 'walk', label });
      } else {
        pills.push({ type: kind, label });
      }
      steps.push({
        type: kind,
        instruction: kind === 'walk' ? `Marchez vers ${d.name || "l'arrêt"}` : `${label} → ${d.name || ''}`.trim(),
        duration: mins, time: hhmm(o.time), arrive: hhmm(d.time), from: o.name || '', to: d.name || ''
      });
      outLegs.push({
        type: kind, label, from: o.name || '', to: d.name || '',
        dep: hhmm(o.time), arr: hhmm(d.time), direction: leg.direction || '', minutes: mins
      });
    });
    const first = (legs[0] && legs[0].Origin) || {};
    const last = (legs[legs.length - 1] && legs[legs.length - 1].Destination) || {};
    let duration = parseIso(trip.duration);
    if (!duration) {
      const a = toMs(first.date, first.time), b = toMs(last.date || first.date, last.time);
      duration = Number.isFinite(a) && Number.isFinite(b) ? Math.max(1, Math.round((b - a) / 60000)) : steps.reduce((s, x) => s + x.duration, 0);
    }
    const transit = outLegs.filter((l) => l.type !== 'walk');
    const hasTransit = transit.length > 0;
    return {
      id: idx + 1,
      source: 'resrobot',
      modes: [...modes],
      duration,
      price: hasTransit ? '25–34 kr' : 'Gratuit',
      walking,
      transfers: Math.max(0, transit.length - 1),
      pills: pills.length ? pills : [{ type: 'walk', label: 'Marche' }],
      steps,
      legs: outLegs,
      departure: hhmm(first.time),
      arrival: hhmm(last.time),
      firstTransit: hasTransit ? { from: transit[0].from, dep: transit[0].dep, label: transit[0].label, direction: transit[0].direction } : null
    };
  });
}

export default async (req) => {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });

  // La clé peut avoir été rangée sous l'un de ces noms dans Netlify (variables d'environnement)
  const KEY_NAMES = ['RESROBOT_KEY', 'RESROBOT_API_KEY', 'TRAFIKLAB_RESROBOT_KEY', 'TRAFIKLAB_KEY'];
  let key = '';
  for (const name of KEY_NAMES) {
    try { key = (globalThis.Netlify && Netlify.env && Netlify.env.get(name)) || ''; } catch (_) {}
    if (!key && typeof process !== 'undefined' && process.env) key = process.env[name] || '';
    if (key) break;
  }
  if (!key) {
    return json({ ok: false, code: 'NO_KEY', error: 'Clé ResRobot absente', message: 'Variable RESROBOT_KEY non configurée sur Netlify (ou nom différent)', routes: [] }, 503);
  }

  const sp = new URL(req.url).searchParams;
  const [fromLat, fromLng, toLat, toLng] = ['fromLat', 'fromLng', 'toLat', 'toLng'].map((k) => Number(sp.get(k)));
  if (![fromLat, fromLng, toLat, toLng].every(Number.isFinite)) {
    return json({ ok: false, code: 'BAD_COORDS', error: 'Coordonnées invalides', message: 'fromLat, fromLng, toLat, toLng requis', routes: [] }, 400);
  }

  const q = new URLSearchParams({
    format: 'json',
    accessId: key,
    originCoordLat: String(fromLat),
    originCoordLong: String(fromLng),
    destCoordLat: String(toLat),
    destCoordLong: String(toLng),
    numF: '5'
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(`https://api.resrobot.se/v2.1/trip?${q.toString()}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'VagVis/1.2' },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (res.status === 401 || res.status === 403) {
      return json({ ok: false, code: 'AUTH', error: 'Clé refusée', message: 'Clé ResRobot invalide ou non autorisée', routes: [] }, 502);
    }
    if (res.status === 429) {
      return json({ ok: false, code: 'RATE_LIMIT', error: 'Quota dépassé', message: 'Quota Trafiklab dépassé, réessaie plus tard', routes: [] }, 429);
    }
    if (!res.ok) {
      return json({ ok: false, code: 'UPSTREAM', error: `HTTP ${res.status}`, message: 'ResRobot est indisponible', routes: [] }, 502);
    }
    const data = await res.json();
    if (data && data.errorCode) {
      return json({ ok: false, code: 'RESROBOT_' + data.errorCode, error: String(data.errorText || data.errorCode).split(key).join('***'), message: 'ResRobot a refusé la requête', routes: [] }, 502);
    }
    const routes = mapTrips(data);
    if (!routes.length) {
      return json({ ok: false, code: 'NO_TRIPS', error: 'Aucun trajet', message: 'Aucun itinéraire trouvé', routes: [] }, 404);
    }
    return json({ ok: true, source: 'resrobot', count: routes.length, routes, attribution: 'Données : Trafiklab.se (ResRobot)' });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e && e.name === 'AbortError';
    // Sécurité : on n'affiche jamais la clé, même si un message d'erreur la contenait
    const safeMsg = String((e && e.message) || e).split(key).join('***');
    return json({ ok: false, code: aborted ? 'TIMEOUT' : 'NETWORK', error: safeMsg, message: 'ResRobot ne répond pas', routes: [] }, 504);
  }
};
