// Fonction Netlify : vrais trajets en transports en commun (ResRobot / Trafiklab.se)
// Appel : /api/trip?from=55.60,13.00&to=55.70,13.19
// La clé est lue dans la variable secrète RESROBOT_KEY (jamais visible des visiteurs).

const NOMBRE = /^-?\d{1,3}(\.\d+)?$/;

function reponse(corps, statut = 200) {
  return new Response(JSON.stringify(corps), {
    status: statut,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=30'
    }
  });
}

function lireCoord(texte) {
  const [a, b] = String(texte || '').split(',').map((s) => s.trim());
  if (!NOMBRE.test(a || '') || !NOMBRE.test(b || '')) return null;
  const lat = Number(a), lng = Number(b);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

const liste = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const hhmm = (t) => String(t || '').slice(0, 5);
const horodatage = (date, heure) => new Date(`${date}T${String(heure || '00:00:00').slice(0, 8)}`).getTime();

function minutesEntre(d1, t1, d2, t2) {
  const m = Math.round((horodatage(d2, t2) - horodatage(d1, t1)) / 60000);
  return Number.isFinite(m) ? Math.max(0, m) : 0;
}

function dureeIso(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(String(iso || ''));
  return m ? Number(m[1] || 0) * 60 + Number(m[2] || 0) : null;
}

function raccourcir(texte, max = 14) {
  const t = String(texte || '').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function modeDe(leg) {
  const p = leg.Product || {};
  const t = [p.catOutL, p.catOutS, p.name, leg.category].join(' ').toLowerCase();
  if (/tunnelbana|metro|subway/.test(t)) return 'metro';
  if (/spårvagn|tram|lokalbana/.test(t)) return 'tram';
  if (/färja|ferry|båt|boat/.test(t)) return 'ferry';
  if (/buss|bus/.test(t)) return 'bus';
  if (/tåg|train|pågatåg/.test(t)) return 'train';
  return 'other';
}

function etiquetteDe(leg, mode) {
  const p = leg.Product || {};
  if (mode === 'bus') return `Bus ${p.num || ''}`.trim();
  if (mode === 'train') {
    const op = p.operator || '';
    if (/öresund/i.test(op)) return 'Öresundståg';
    if (/skånetrafiken/i.test(op)) return 'Pågatåg';
    return raccourcir(op || p.catOutL || 'Tåg');
  }
  return raccourcir(p.catOutL || p.name || 'Transport');
}

function point(o) {
  return {
    name: o.name || '',
    lat: Number(o.lat),
    lng: Number(o.lon),
    time: hhmm(o.time)
  };
}

function normaliserLeg(leg) {
  const o = leg.Origin || {};
  const d = leg.Destination || {};
  const from = point(o);
  const to = point(d);
  const minutes = minutesEntre(o.date, o.time, d.date, d.time);

  if (leg.type === 'JNY') {
    const mode = modeDe(leg);
    const arrets = liste(leg.Stops && leg.Stops.Stop);
    const chemin = arrets
      .map((s) => [Number(s.lat), Number(s.lon)])
      .filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
    return {
      kind: 'transit',
      mode,
      label: etiquetteDe(leg, mode),
      direction: leg.direction || '',
      from,
      to,
      minutes,
      stops: Math.max(0, arrets.length - 1),
      path: chemin.length > 1 ? chemin : [[from.lat, from.lng], [to.lat, to.lng]]
    };
  }

  // WALK (marche) ou TRSF (correspondance à pied)
  return {
    kind: 'walk',
    transfer: leg.type === 'TRSF',
    from,
    to,
    minutes,
    distM: Number(leg.dist) || 0,
    path: [[from.lat, from.lng], [to.lat, to.lng]]
  };
}

function normaliserTrip(trip) {
  const legs = liste(trip.LegList && trip.LegList.Leg).map(normaliserLeg);
  if (!legs.length) return null;
  const premier = legs[0];
  const dernier = legs[legs.length - 1];
  const transports = legs.filter((l) => l.kind === 'transit');
  const duree =
    dureeIso(trip.duration) ??
    legs.reduce((s, l) => s + (l.minutes || 0), 0);
  return {
    dep: premier.from.time,
    arr: dernier.to.time,
    durationMin: duree,
    transfers: Math.max(0, transports.length - 1),
    walkM: legs.filter((l) => l.kind === 'walk').reduce((s, l) => s + (l.distM || 0), 0),
    legs
  };
}

export default async (req) => {
  const cle = Netlify.env.get('RESROBOT_KEY');
  if (!cle) {
    return reponse({ error: 'Variable RESROBOT_KEY introuvable', trips: [] }, 500);
  }

  const url = new URL(req.url);
  const depart = lireCoord(url.searchParams.get('from'));
  const arrivee = lireCoord(url.searchParams.get('to'));
  if (!depart || !arrivee) {
    return reponse({ error: 'Coordonnées invalides (from=lat,lng&to=lat,lng)', trips: [] }, 400);
  }

  const params = new URLSearchParams({
    format: 'json',
    originCoordLat: String(depart.lat),
    originCoordLong: String(depart.lng),
    destCoordLat: String(arrivee.lat),
    destCoordLong: String(arrivee.lng),
    numF: '5',
    passlist: '1',
    accessId: cle
  });
  const date = url.searchParams.get('date');
  const heure = url.searchParams.get('time');
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) params.set('date', date);
  if (heure && /^\d{2}:\d{2}$/.test(heure)) params.set('time', heure);

  let res;
  try {
    res = await fetch(`https://api.resrobot.se/v2.1/trip?${params.toString()}`);
  } catch (e) {
    return reponse({ error: 'ResRobot injoignable', trips: [] }, 502);
  }
  if (!res.ok) {
    return reponse({ error: `ResRobot a répondu ${res.status}`, trips: [] }, 502);
  }

  const data = await res.json();
  if (data.errorCode) {
    // ex. SVC_NO_RESULT : aucun trajet trouvé (ce n'est pas une panne)
    return reponse({ error: data.errorText || data.errorCode, code: data.errorCode, trips: [] });
  }

  const trips = liste(data.Trip).map(normaliserTrip).filter(Boolean);
  return reponse({
    source: 'resrobot',
    attribution: 'Données : Trafiklab.se (ResRobot, CC BY 4.0)',
    trips
  });
};

export const config = { path: '/api/trip' };
