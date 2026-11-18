// Fonction Netlify : alertes réelles pour toute la Skåne (Trafiklab Realtime APIs – Timetables)
// Appel : /api/alerts            -> { ok, source, count, alerts: [...] }
//         /api/alerts?debug=1    -> diagnostic (réponse brute de la recherche d'arrêts, SANS la clé)
// La clé est lue dans la variable secrète TRAFIKLAB_KEY (la même que pour /api/departures).
// Les identifiants d'arrêts sont cherchés avec l'API de recherche d'arrêts de Trafiklab (jamais inventés),
// sauf Malmö C (740000003), déjà utilisé par l'ancienne version et qui fonctionne.

const API = 'https://realtime-api.trafiklab.se/v1';
const TTL_MS = 60 * 1000; // cache d'environ 60 secondes

// Gares / arrêts principaux de la Skåne : nom cherché, nom affiché, position (centre-ville)
const TOWNS = [
  { query: 'Malmö C', label: 'Malmö', id: '740000003', lat: 55.6095, lng: 13.0008 },
  { query: 'Lund C', label: 'Lund', lat: 55.7047, lng: 13.1932 },
  { query: 'Helsingborg C', label: 'Helsingborg', lat: 56.0465, lng: 12.6945 },
  { query: 'Kristianstad C', label: 'Kristianstad', lat: 56.0294, lng: 14.1567 },
  { query: 'Hässleholm C', label: 'Hässleholm', lat: 56.1591, lng: 13.7664 },
  { query: 'Ystad station', label: 'Ystad', lat: 55.4297, lng: 13.8204 },
  { query: 'Trelleborg C', label: 'Trelleborg', lat: 55.3750, lng: 13.1570 },
  { query: 'Landskrona station', label: 'Landskrona', lat: 55.8708, lng: 12.8300 },
  { query: 'Eslöv station', label: 'Eslöv', lat: 55.8393, lng: 13.3039 },
  { query: 'Ängelholm station', label: 'Ängelholm', lat: 56.2428, lng: 12.8622 }
];

const idCache = new Map(); // nom cherché -> identifiant d'arrêt (gardé tant que la fonction reste « chaude »)
let cache = { t: 0, body: null };

const liste = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

function reponse(corps, statut = 200) {
  return new Response(JSON.stringify(corps), {
    status: statut,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'Netlify-CDN-Cache-Control': 'public, max-age=60, stale-while-revalidate=120'
    }
  });
}

// Type Trafiklab -> type attendu par le site (works / diversion / event / closed / alert)
function typeSite(t) {
  const x = String(t || '').toUpperCase();
  if (/CONSTRUCTION|MAINTENANCE|ROADWORK/.test(x)) return 'works';
  if (/DETOUR|MODIFIED|REROUT|DIVERS/.test(x)) return 'diversion';
  if (/STRIKE|DEMONSTRATION|EVENT|HOLIDAY/.test(x)) return 'event';
  if (/NO_SERVICE|STOP_MOVED|CLOSED|CANCEL/.test(x)) return 'closed';
  return 'alert';
}

const cleAlerte = (a) => `${a.title || ''}|${a.text || ''}`.slice(0, 300);

// Résultats de la recherche d'arrêts de Trafiklab : { stop_groups: [{ id, name, area_type, average_daily_stop_times, transport_modes, stops: [{ lat, lon }] }] }
function extraireResultats(data) {
  if (!data || typeof data !== 'object') return [];
  const groupes = data.stop_groups || data.stopGroups || data.stops || data.results || data.stop_locations || [];
  return liste(groupes).map((g) => {
    const p = liste(g.stops)[0] || g;
    const lat = Number(p.lat !== undefined ? p.lat : p.latitude);
    const lon = Number(p.lon !== undefined ? p.lon : (p.lng !== undefined ? p.lng : p.longitude));
    return {
      id: g.id || g.stop_group_id || g.stop_id || g.stopId || g.extId || null,
      name: g.name || g.stop_name || g.stopName || '',
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
      modes: liste(g.transport_modes),
      trafic: Number(g.average_daily_stop_times) || 0
    };
  }).filter((g) => g.id);
}

// Skåne (avec Copenhague) : on ne garde que les arrêts situés dans cette zone
function dansSkane(r) {
  return r.lat !== null && r.lon !== null && r.lat >= 55.3 && r.lat <= 56.55 && r.lon >= 12.35 && r.lon <= 14.65;
}

function meilleurResultat(resultats, requete) {
  const q = norm(requete);
  const premierMot = norm(requete.split(' ')[0]);
  const avecPosition = resultats.filter((r) => r.lat !== null && r.lon !== null);
  const candidats = avecPosition.length ? avecPosition.filter(dansSkane) : resultats;
  if (!candidats.length) return null;
  const gare = /\b(c|station|centralstation|central)\b/.test(q);
  let meilleur = null, scoreMax = -1;
  for (const r of candidats) {
    const n = norm(r.name);
    let score = 0;
    if (n === q) score += 100;
    else if (n.startsWith(q)) score += 60;
    else if (n.startsWith(premierMot)) score += 40;
    else if (n.includes(q)) score += 20;
    else if (n.includes(premierMot)) score += 10;
    if (gare && r.modes.includes('TRAIN')) score += 15;
    score += Math.log10(1 + r.trafic);
    if (score > scoreMax) { scoreMax = score; meilleur = r; }
  }
  return scoreMax >= 10 ? meilleur : null;
}

async function trouverId(town, cleApi, diag) {
  if (town.id) return town.id;
  if (idCache.has(town.query)) return idCache.get(town.query);
  const essais = [...new Set([town.query, town.label])];
  for (const nom of essais) {
    const url = `${API}/stops/name/${encodeURIComponent(nom)}?key=${encodeURIComponent(cleApi)}`;
    const res = await fetch(url);
    if (!res.ok) { diag.push({ town: town.label, etape: 'recherche', nom, statut: res.status }); continue; }
    const data = await res.json();
    const best = meilleurResultat(extraireResultats(data), nom);
    if (best) {
      idCache.set(town.query, best.id);
      return best.id;
    }
    diag.push({ town: town.label, etape: 'recherche', nom, resultat: 'aucun arrêt trouvé' });
  }
  return null;
}

async function alertesDeLaVille(town, cleApi, diag) {
  const id = await trouverId(town, cleApi, diag);
  if (!id) return [];
  const res = await fetch(`${API}/departures/${encodeURIComponent(id)}?key=${encodeURIComponent(cleApi)}`);
  if (!res.ok) { diag.push({ town: town.label, etape: 'départs', statut: res.status }); return []; }
  const data = await res.json();
  const brutes = [];
  liste(data.stops).forEach((s) => liste(s.alerts).forEach((a) => brutes.push({ a, ligne: null })));
  liste(data.departures).forEach((d) => {
    const ligne = d.route && (d.route.designation || d.route.name);
    liste(d.alerts).forEach((a) => brutes.push({ a, ligne }));
  });
  return brutes.filter(({ a }) => a && (a.title || a.text)).map((b) => ({ ...b, town }));
}

async function construire(cleApi, diag) {
  const lots = await Promise.all(TOWNS.map((t) => alertesDeLaVille(t, cleApi, diag).catch((e) => {
    diag.push({ town: t.label, etape: 'erreur', message: String(e && e.message || e).split(cleApi).join('***') });
    return [];
  })));
  const vus = new Map();
  lots.flat().forEach(({ a, ligne, town }) => {
    const k = cleAlerte(a);
    if (!vus.has(k)) vus.set(k, { a, lignes: new Set(), villes: new Map() });
    const v = vus.get(k);
    if (ligne) v.lignes.add(String(ligne));
    v.villes.set(town.label, town);
  });

  return [...vus.values()].slice(0, 30).map(({ a, lignes, villes }, i) => {
    const type = typeSite(a.type);
    const listeLignes = [...lignes].slice(0, 6);
    const lv = [...villes.values()];
    const premiere = lv[0];
    return {
      id: 'tl_' + i + '_' + cleAlerte(a).length,
      type,
      severity: type === 'closed' || /STRIKE|NO_SERVICE|CANCEL/i.test(String(a.type || '')) ? 'high' : 'medium',
      places: [...lv.map((t) => t.label), 'Skåne'],
      lat: premiere.lat, lng: premiere.lng, radiusKm: lv.length > 1 ? 6 : 4,
      title: a.title || 'Alerte Skånetrafiken',
      body: String(a.text || '').trim() + (listeLignes.length ? ` (lignes : ${listeLignes.join(', ')})` : ''),
      advice: 'Détails sur skanetrafiken.se',
      until: 'Temps réel'
    };
  });
}

export default async (req) => {
  const cleApi = Netlify.env.get('TRAFIKLAB_KEY');
  if (!cleApi) return reponse({ ok: false, error: 'Variable TRAFIKLAB_KEY introuvable', alerts: [] }, 500);

  const debug = new URL(req.url).searchParams.get('debug') === '1';
  if (!debug && cache.body && Date.now() - cache.t < TTL_MS) return reponse(cache.body);

  const diag = [];
  let alerts;
  try {
    alerts = await construire(cleApi, diag);
  } catch (e) {
    return reponse({ ok: false, error: 'Trafiklab injoignable', alerts: [] }, 502);
  }

  const corps = {
    ok: true,
    source: 'trafiklab-timetables',
    attribution: 'Données : Trafiklab.se (CC BY 4.0)',
    villes: TOWNS.length,
    count: alerts.length,
    alerts
  };
  if (debug) return reponse({ ...corps, diagnostic: diag, ids: Object.fromEntries(idCache) });
  // On ne garde en cache que les réponses où au moins une ville a répondu
  if (diag.length < TOWNS.length) cache = { t: Date.now(), body: corps };
  return reponse(corps);
};

export const config = { path: '/api/alerts' };
