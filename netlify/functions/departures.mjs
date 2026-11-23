// Fonction Netlify : prochains départs de n'importe quel arrêt (données Trafiklab.se)
// Appels : /api/departures?stop=Malmö C      (par nom : l'identifiant est cherché avec l'API de recherche d'arrêts)
//          /api/departures?id=740000003      (par identifiant d'arrêt)
//          /api/departures?stop=Lund C&debug=1  (diagnostic : réponse brute de la recherche, SANS la clé)
// La clé Trafiklab est lue dans la variable secrète TRAFIKLAB_KEY (jamais visible des visiteurs).

const API = 'https://realtime-api.trafiklab.se/v1';
const TTL_MS = 60 * 1000; // cache d'environ 60 secondes

// Arrêts déjà connus (pas besoin de les chercher) : Malmö C, utilisé depuis le début et qui fonctionne
const ARRETS_CONNUS = {
  'malmö c': { id: '740000003', name: 'Malmö Centralstation' },
  'malmo c': { id: '740000003', name: 'Malmö Centralstation' },
  'malmö centralstation': { id: '740000003', name: 'Malmö Centralstation' },
  'malmö': { id: '740000003', name: 'Malmö Centralstation' }
};

const idCache = new Map();   // nom normalisé -> { id, name }
const depCache = new Map();  // id -> { t, body }

const liste = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

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

function raccourcir(texte, max = 12) {
  const t = String(texte || '').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

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

async function resoudreArret(nom, cle, diag) {
  const k = norm(nom);
  if (ARRETS_CONNUS[k]) return ARRETS_CONNUS[k];
  if (idCache.has(k)) return idCache.get(k);
  const res = await fetch(`${API}/stops/name/${encodeURIComponent(nom)}?key=${encodeURIComponent(cle)}`);
  if (!res.ok) { diag.recherche = { statut: res.status }; return null; }
  const data = await res.json();
  diag.recherche = { champs: Object.keys(data || {}), apercu: JSON.stringify(data).slice(0, 700) };
  const best = meilleurResultat(extraireResultats(data), nom);
  if (!best) return null;
  const arret = { id: String(best.id), name: best.name || nom };
  idCache.set(k, arret);
  return arret;
}

function formaterDeparts(data) {
  // "timestamp" et "realtime" sont à la même heure locale : leur différence donne les minutes d'attente
  const maintenant = new Date(data.timestamp).getTime();
  return (data.departures || [])
    .filter((d) => !d.canceled)
    .map((d) => {
      const r = d.route || {};
      const train = r.transport_mode === 'TRAIN';
      const ligne = train
        ? raccourcir(r.name || r.designation || 'Tåg')
        : `Bus ${r.designation || r.name || ''}`.trim();
      const minutes = Math.max(
        0,
        Math.round((new Date(d.realtime || d.scheduled).getTime() - maintenant) / 60000)
      );
      return {
        line: ligne,
        dest: r.direction || (r.destination && r.destination.name) || '',
        type: train ? 'train' : 'bus',
        color: train ? '#dc2626' : '#2563eb',
        minutes
      };
    })
    .filter((d) => Number.isFinite(d.minutes))
    .sort((a, b) => a.minutes - b.minutes)
    .slice(0, 16);
}

export default async (req) => {
  const cle = Netlify.env.get('TRAFIKLAB_KEY');
  if (!cle) {
    return reponse({ error: 'Variable TRAFIKLAB_KEY introuvable', departures: [] }, 500);
  }
  const masquer = (s) => String(s || '').split(cle).join('***');

  const url = new URL(req.url);
  const debug = url.searchParams.get('debug') === '1';
  const nomDemande = (url.searchParams.get('stop') || 'Malmö C').trim().slice(0, 60);
  const idDemande = url.searchParams.get('id');
  const diag = {};

  let arret = null;
  try {
    if (idDemande) {
      if (!/^\d{6,18}$/.test(idDemande)) return reponse({ error: 'Identifiant d\'arrêt invalide', departures: [] }, 400);
      arret = { id: idDemande, name: (url.searchParams.get('stop') || '').trim().slice(0, 60) };
    } else {
      arret = await resoudreArret(nomDemande, cle, diag);
    }
  } catch (e) {
    return reponse({ error: 'Recherche d\'arrêt impossible : ' + masquer(e && e.message), departures: [] }, 502);
  }
  if (!arret) {
    return reponse({ error: 'Arrêt inconnu', departures: [], ...(debug ? { diagnostic: diag } : {}) }, 404);
  }

  // Cache d'environ 60 secondes par arrêt
  const enCache = depCache.get(arret.id);
  if (!debug && enCache && Date.now() - enCache.t < TTL_MS) return reponse(enCache.body);

  let res;
  try {
    res = await fetch(`${API}/departures/${encodeURIComponent(arret.id)}?key=${encodeURIComponent(cle)}`);
  } catch (e) {
    return reponse({ error: 'Trafiklab injoignable', departures: [] }, 502);
  }
  if (!res.ok) {
    return reponse({ error: `Trafiklab a répondu ${res.status}`, departures: [] }, 502);
  }

  const data = await res.json();
  const corps = {
    source: 'gtfs',
    attribution: 'Données : Trafiklab.se (CC BY 4.0)',
    stop: { id: arret.id, name: arret.name },
    departures: formaterDeparts(data)
  };
  depCache.set(arret.id, { t: Date.now(), body: corps });
  if (depCache.size > 200) depCache.clear();
  return reponse(debug ? { ...corps, diagnostic: diag } : corps);
};

export const config = { path: '/api/departures' };
