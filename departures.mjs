// Fonction Netlify : donne les prochains départs à Malmö C (données Trafiklab.se)
// La clé Trafiklab est lue dans la variable secrète TRAFIKLAB_KEY (jamais visible des visiteurs).

const ARRETS_CONNUS = {
  'malmö c': '740000003',
  'malmo c': '740000003',
  'malmö centralstation': '740000003',
  'malmö': '740000003'
};

function reponse(corps, statut = 200) {
  return new Response(JSON.stringify(corps), {
    status: statut,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=30'
    }
  });
}

function raccourcir(texte, max = 12) {
  const t = String(texte || '').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export default async (req) => {
  const cle = Netlify.env.get('TRAFIKLAB_KEY');
  if (!cle) {
    return reponse({ error: 'Variable TRAFIKLAB_KEY introuvable', departures: [] }, 500);
  }

  const url = new URL(req.url);
  const nomArret = (url.searchParams.get('stop') || 'Malmö C').trim().toLowerCase();
  const idArret = url.searchParams.get('id') || ARRETS_CONNUS[nomArret];

  if (!idArret || !/^\d+$/.test(idArret)) {
    return reponse({ error: 'Arrêt inconnu', departures: [] }, 404);
  }

  let res;
  try {
    res = await fetch(
      `https://realtime-api.trafiklab.se/v1/departures/${idArret}?key=${encodeURIComponent(cle)}`
    );
  } catch (e) {
    return reponse({ error: 'Trafiklab injoignable', departures: [] }, 502);
  }
  if (!res.ok) {
    return reponse({ error: `Trafiklab a répondu ${res.status}`, departures: [] }, 502);
  }

  const data = await res.json();
  // "timestamp" et "realtime" sont à la même heure locale : leur différence donne les minutes d'attente
  const maintenant = new Date(data.timestamp).getTime();

  const departures = (data.departures || [])
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

  return reponse({
    source: 'gtfs',
    attribution: 'Données : Trafiklab.se (CC BY 4.0)',
    departures
  });
};

export const config = { path: '/api/departures' };
