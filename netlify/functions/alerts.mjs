// Fonction Netlify : alertes réelles liées aux départs de Malmö C (Trafiklab Realtime APIs – Timetables)
// Appel : /api/alerts  -> { ok, source, count, alerts: [...] }
// La clé est lue dans la variable secrète TRAFIKLAB_KEY (la même que pour /api/departures).

const MALMO_C = { id: '740000003', lat: 55.6095, lng: 13.0008 };

function reponse(corps, statut = 200) {
  return new Response(JSON.stringify(corps), {
    status: statut,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=120' }
  });
}

const liste = (x) => (Array.isArray(x) ? x : x ? [x] : []);

// Type Trafiklab -> type attendu par le site (works / diversion / event / closed / alert)
function typeSite(t) {
  const x = String(t || '').toUpperCase();
  if (/CONSTRUCTION|MAINTENANCE|ROADWORK/.test(x)) return 'works';
  if (/DETOUR|MODIFIED|REROUT|DIVERS/.test(x)) return 'diversion';
  if (/STRIKE|DEMONSTRATION|EVENT|HOLIDAY/.test(x)) return 'event';
  if (/NO_SERVICE|STOP_MOVED|CLOSED|CANCEL/.test(x)) return 'closed';
  return 'alert';
}

function cle(a) {
  return `${a.title || ''}|${a.text || ''}`.slice(0, 300);
}

export default async (req) => {
  const cleApi = Netlify.env.get('TRAFIKLAB_KEY');
  if (!cleApi) return reponse({ ok: false, error: 'Variable TRAFIKLAB_KEY introuvable', alerts: [] }, 500);

  let res;
  try {
    res = await fetch(`https://realtime-api.trafiklab.se/v1/departures/${MALMO_C.id}?key=${encodeURIComponent(cleApi)}`);
  } catch (e) {
    return reponse({ ok: false, error: 'Trafiklab injoignable', alerts: [] }, 502);
  }
  if (!res.ok) return reponse({ ok: false, error: `Trafiklab a répondu ${res.status}`, alerts: [] }, 502);

  const data = await res.json();
  const vus = new Map();

  // Alertes de l'arrêt, puis alertes attachées aux départs
  const brutes = [];
  liste(data.stops).forEach((s) => liste(s.alerts).forEach((a) => brutes.push({ a, ligne: null })));
  liste(data.departures).forEach((d) => {
    const ligne = d.route && (d.route.designation || d.route.name);
    liste(d.alerts).forEach((a) => brutes.push({ a, ligne }));
  });

  for (const { a, ligne } of brutes) {
    const k = cle(a);
    if (!a || (!a.title && !a.text)) continue;
    if (!vus.has(k)) vus.set(k, { a, lignes: new Set() });
    if (ligne) vus.get(k).lignes.add(String(ligne));
  }

  const alerts = [...vus.values()].slice(0, 12).map(({ a, lignes }, i) => {
    const type = typeSite(a.type);
    const listeLignes = [...lignes].slice(0, 6);
    return {
      id: 'tl_' + i + '_' + cle(a).length,
      type,
      severity: type === 'closed' || /STRIKE|NO_SERVICE|CANCEL/i.test(String(a.type || '')) ? 'high' : 'medium',
      places: ['Malmö C', 'Malmö'],
      lat: MALMO_C.lat, lng: MALMO_C.lng, radiusKm: 3,
      title: a.title || 'Alerte Skånetrafiken',
      body: (a.text || '') + (listeLignes.length ? ` (lignes : ${listeLignes.join(', ')})` : ''),
      advice: 'Détails sur skanetrafiken.se',
      until: 'Temps réel'
    };
  });

  return reponse({
    ok: true,
    source: 'trafiklab-timetables',
    attribution: 'Données : Trafiklab.se (CC BY 4.0)',
    count: alerts.length,
    alerts
  });
};

export const config = { path: '/api/alerts' };
