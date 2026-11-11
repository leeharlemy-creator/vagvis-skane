(() => {
  'use strict';

  const STORAGE_KEY = 'vagvis-game-progress-v1';
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 14.8 9l6.7.6-5.1 4.4 1.6 6.5-6-3.5-6 3.5 1.6-6.5-5.1-4.4L9.2 9 12 2.5Z" fill="currentColor"/></svg>';
  let progress = readProgress();
  let challenge = null;
  let challengeLayer = null;
  let gameIsOpen = false;
  let mapChangedByGame = false;
  let viewBeforeGame = null;
  let poiLayerWasVisible = false;
  let poiLayerHiddenForChallenge = false;
  let panel;
  let missionArea;
  let mapClickHandler = null;
  const lastTargetByKind = { orientation: null, discovery: null, route: null };

  function readProgress() {
    const empty = { score: 0, completed: 0, streak: 0, bestStreak: 0 };
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!parsed || typeof parsed !== 'object') return empty;
      return {
        score: Math.max(0, Number(parsed.score) || 0),
        completed: Math.max(0, Number(parsed.completed) || 0),
        streak: Math.max(0, Number(parsed.streak) || 0),
        bestStreak: Math.max(0, Number(parsed.bestStreak) || 0)
      };
    } catch (_) {
      return empty;
    }
  }

  function saveProgress() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(progress)); } catch (_) { /* Le jeu reste jouable si le stockage est indisponible. */ }
  }

  function mapRef() {
    try { return typeof map !== 'undefined' ? map : null; } catch (_) { return null; }
  }

  function poiLayerRef() {
    try { return typeof poiLayer !== 'undefined' ? poiLayer : null; } catch (_) { return null; }
  }

  function restorePoiLayer() {
    const mapInstance = mapRef();
    const placesLayer = poiLayerRef();
    if (poiLayerHiddenForChallenge && poiLayerWasVisible && mapInstance && placesLayer) {
      try { if (!mapInstance.hasLayer(placesLayer)) placesLayer.addTo(mapInstance); } catch (_) { /* La carte reste utilisable si sa couche POI a disparu. */ }
    }
    poiLayerHiddenForChallenge = false;
    poiLayerWasVisible = false;
  }

  function hidePoiLayerForChallenge() {
    const mapInstance = mapRef();
    const placesLayer = poiLayerRef();
    if (!mapInstance || !placesLayer) return;
    try {
      poiLayerWasVisible = mapInstance.hasLayer(placesLayer);
      if (poiLayerWasVisible) {
        mapInstance.removeLayer(placesLayer);
        poiLayerHiddenForChallenge = true;
      }
    } catch (_) { /* La manche reste résoluble sur les tuiles cartographiques. */ }
  }

  function safeCities() {
    try {
      return typeof SKANE_CITIES !== 'undefined' && Array.isArray(SKANE_CITIES)
        ? SKANE_CITIES.filter(item => item && item.name && Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lng)))
        : [];
    } catch (_) { return []; }
  }

  function safePlaces() {
    try {
      return typeof POIS !== 'undefined' && Array.isArray(POIS)
        ? POIS.filter(item => item && item.name && Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lng)))
        : [];
    } catch (_) { return []; }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function distanceMeters(a, b) {
    const radians = degrees => degrees * Math.PI / 180;
    const dLat = radians(Number(b.lat) - Number(a.lat));
    const dLng = radians(Number(b.lng) - Number(a.lng));
    const lat1 = radians(Number(a.lat));
    const lat2 = radians(Number(b.lat));
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function formatDistance(meters) {
    if (!Number.isFinite(meters)) return '';
    return meters >= 1000 ? `${(meters / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(meters)} m`;
  }

  function randomItem(list, excludeId) {
    const usable = list.filter(item => String(item.id || item.name) !== String(excludeId || ''));
    const choices = usable.length ? usable : list;
    return choices[Math.floor(Math.random() * choices.length)];
  }

  function buildInterface() {
    if (document.getElementById('vagvis-game-layer')) return;

    const layer = document.createElement('div');
    layer.id = 'vagvis-game-layer';
    layer.innerHTML = `
      <button id="vagvis-game-open" class="vagvis-game-launcher" type="button" aria-expanded="false" aria-controls="vagvis-game-panel">
        <span class="vagvis-game-launcher__icon">${ICON}</span>
        <span class="vagvis-game-launcher__copy"><strong>VāgVis Défis</strong><small>Explorer Skåne</small></span>
        <span id="vagvis-game-launcher-score" class="vagvis-game-launcher__score">0 pts</span>
      </button>
      <section id="vagvis-game-panel" class="vagvis-game-panel" role="region" aria-label="Mode jeu VāgVis" hidden>
        <header class="vagvis-game-panel__header">
          <div class="vagvis-game-brand"><span class="vagvis-game-brand__mark">${ICON}</span><span><b>VāgVis</b><small>MODE EXPLORATION</small></span></div>
          <button id="vagvis-game-close" class="vagvis-game-icon-button" type="button" aria-label="Fermer le mode jeu">×</button>
        </header>
        <div class="vagvis-game-panel__content">
          <div class="vagvis-game-eyebrow"><span class="vagvis-game-live-dot"></span> CARTE · SKÅNE · SOLO</div>
          <h2 class="vagvis-game-title">Chaque détour<br><span>raconte un lieu.</span></h2>
          <p class="vagvis-game-intro">Repérez les villes, découvrez les lieux et choisissez vos trajets sur la carte VagVis.</p>
          <div class="vagvis-game-stats" aria-label="Votre progression">
            <div><strong id="vagvis-game-score">0</strong><span>points</span></div>
            <div><strong id="vagvis-game-completed">0</strong><span>défis réussis</span></div>
            <div><strong id="vagvis-game-streak">0</strong><span>en série</span></div>
          </div>
          <div class="vagvis-game-section-label"><span>CHOISIR UN DÉFI</span><span>01 — 03</span></div>
          <div class="vagvis-game-modes">
            <button class="vagvis-game-mode" type="button" data-vagvis-game-mode="orientation">
              <span class="vagvis-game-mode__number">01</span><span class="vagvis-game-mode__body"><strong>Cap sur la ville</strong><small>Placez-vous sur la bonne ville.</small></span><span class="vagvis-game-mode__arrow">↗</span>
            </button>
            <button class="vagvis-game-mode" type="button" data-vagvis-game-mode="discovery">
              <span class="vagvis-game-mode__number">02</span><span class="vagvis-game-mode__body"><strong>Chasse aux lieux</strong><small>Retrouvez un point d’intérêt.</small></span><span class="vagvis-game-mode__arrow">↗</span>
            </button>
            <button class="vagvis-game-mode" type="button" data-vagvis-game-mode="route">
              <span class="vagvis-game-mode__number">03</span><span class="vagvis-game-mode__body"><strong>Le meilleur trajet</strong><small>Comparez les options VagVis.</small></span><span class="vagvis-game-mode__arrow">↗</span>
            </button>
          </div>
          <div id="vagvis-game-mission" class="vagvis-game-mission" aria-live="polite">
            <div class="vagvis-game-empty"><span class="vagvis-game-empty__icon">⌖</span><strong>Votre carte, votre prochaine étape.</strong><span>Choisissez un défi pour commencer.</span></div>
          </div>
          <div class="vagvis-game-source"><span class="vagvis-game-source__icon">i</span><span>Les villes et lieux viennent des données intégrées à VagVis. Votre score est conservé sur cet appareil seulement.</span></div>
          <button id="vagvis-game-exit" class="vagvis-game-exit" type="button">Fermer les défis · Retour à la navigation</button>
        </div>
      </section>`;
    document.body.appendChild(layer);

    panel = document.getElementById('vagvis-game-panel');
    missionArea = document.getElementById('vagvis-game-mission');
    const launcher = document.getElementById('vagvis-game-open');
    const toolbar = document.querySelector('.top-toolbar');
    if (launcher && toolbar) toolbar.prepend(launcher);
    launcher?.addEventListener('click', openGame);
    document.getElementById('vagvis-game-close').addEventListener('click', closeGame);
    document.getElementById('vagvis-game-exit').addEventListener('click', closeGame);
    panel.addEventListener('click', handlePanelClick);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && gameIsOpen) closeGame();
    });
    updateProgressDisplay();
  }

  function updateProgressDisplay() {
    const score = document.getElementById('vagvis-game-score');
    const completed = document.getElementById('vagvis-game-completed');
    const streak = document.getElementById('vagvis-game-streak');
    const launcherScore = document.getElementById('vagvis-game-launcher-score');
    if (score) score.textContent = String(progress.score);
    if (completed) completed.textContent = String(progress.completed);
    if (streak) streak.textContent = String(progress.streak);
    if (launcherScore) launcherScore.textContent = `${progress.score} pts`;
  }

  function openGame() {
    const mapInstance = mapRef();
    if (!panel) return;
    if (!gameIsOpen && mapInstance) {
      try { viewBeforeGame = { center: mapInstance.getCenter(), zoom: mapInstance.getZoom() }; } catch (_) { viewBeforeGame = null; }
    }
    gameIsOpen = true;
    mapChangedByGame = false;
    panel.hidden = false;
    document.getElementById('vagvis-game-open')?.setAttribute('aria-expanded', 'true');
    updateProgressDisplay();
  }

  function closeGame() {
    gameIsOpen = false;
    if (panel) panel.hidden = true;
    document.getElementById('vagvis-game-open')?.setAttribute('aria-expanded', 'false');
    detachMapChallenge();
    clearChallengeLayer();
    restorePoiLayer();
    const mapInstance = mapRef();
    if (!mapChangedByGame && viewBeforeGame && mapInstance) {
      try { mapInstance.setView(viewBeforeGame.center, viewBeforeGame.zoom, { animate: false }); } catch (_) { /* La carte reste utilisable si la vue a changé entre-temps. */ }
    }
    challenge = null;
    viewBeforeGame = null;
    mapChangedByGame = false;
  }

  function clearChallengeLayer() {
    try { if (challengeLayer) challengeLayer.clearLayers(); } catch (_) { /* no-op */ }
  }

  function detachMapChallenge() {
    const mapInstance = mapRef();
    if (mapInstance && mapClickHandler) {
      try { mapInstance.off('click', mapClickHandler); } catch (_) { /* no-op */ }
    }
    mapClickHandler = null;
  }

  function handlePanelClick(event) {
    const modeButton = event.target.closest('[data-vagvis-game-mode]');
    if (modeButton) {
      startChallenge(modeButton.dataset.vagvisGameMode);
      return;
    }
    const routeButton = event.target.closest('[data-vagvis-game-route]');
    if (routeButton) {
      chooseRoute(Number(routeButton.dataset.vagvisGameRoute));
      return;
    }
    const actionButton = event.target.closest('[data-vagvis-game-action]');
    if (!actionButton) return;
    const action = actionButton.dataset.vagvisGameAction;
    if (action === 'next') {
      challenge = null;
      detachMapChallenge();
      clearChallengeLayer();
      missionArea.innerHTML = '<div class="vagvis-game-empty"><span class="vagvis-game-empty__icon">⌖</span><strong>Prêt pour la suite ?</strong><span>Choisissez un nouveau défi ci-dessus.</span></div>';
    } else if (action === 'open-target') {
      openTargetInVagVis();
    } else if (action === 'open-route') {
      openRouteInVagVis();
    }
  }

  function startChallenge(kind) {
    const cities = safeCities();
    const places = safePlaces();
    const mapInstance = mapRef();
    const previousTarget = challenge?.target?.id || challenge?.target?.name || lastTargetByKind[kind];
    detachMapChallenge();
    clearChallengeLayer();
    restorePoiLayer();
    challenge = null;

    if (!mapInstance || !window.L) {
      renderMessage('La carte VagVis n’est pas encore prête. Réessayez dans un instant.', 'warning');
      return;
    }
    if (!challengeLayer) challengeLayer = window.L.layerGroup().addTo(mapInstance);
    else if (!mapInstance.hasLayer(challengeLayer)) challengeLayer.addTo(mapInstance);

    if (kind === 'orientation') {
      if (!cities.length) return renderMessage('Les villes de Skåne ne sont pas disponibles dans cette version.', 'warning');
      const target = randomItem(cities, previousTarget);
      lastTargetByKind[kind] = target.id || target.name;
      challenge = { kind, target, radius: 3500, completed: false };
      renderOrientationChallenge(target);
      const bounds = window.L.latLngBounds(cities.map(city => [Number(city.lat), Number(city.lng)]));
      const bottomPadding = window.innerWidth < 720 ? Math.round(window.innerHeight * 0.48) : 36;
      mapInstance.fitBounds(bounds, { paddingTopLeft: [24, 112], paddingBottomRight: [24, bottomPadding], maxZoom: 8, animate: true });
      attachMapChallenge();
      return;
    }

    if (kind === 'discovery') {
      if (!places.length) return renderMessage('Les lieux VagVis ne sont pas disponibles dans cette version.', 'warning');
      const target = randomItem(places, previousTarget);
      lastTargetByKind[kind] = target.id || target.name;
      challenge = { kind, target, radius: 550, completed: false };
      renderDiscoveryChallenge(target);
      hidePoiLayerForChallenge();
      const bearing = Math.random() * Math.PI * 2;
      const offset = 850;
      const targetLat = Number(target.lat);
      const targetLng = Number(target.lng);
      const searchCenter = [
        targetLat + (Math.cos(bearing) * offset) / 111320,
        targetLng + (Math.sin(bearing) * offset) / (111320 * Math.cos(targetLat * Math.PI / 180))
      ];
      mapInstance.setView(searchCenter, 14, { animate: true });
      attachMapChallenge();
      return;
    }

    if (kind === 'route') {
      if (!cities.length) return renderMessage('Les destinations de Skåne ne sont pas disponibles.', 'warning');
      const target = randomItem(cities, previousTarget);
      lastTargetByKind[kind] = target.id || target.name;
      let routes = [];
      try { routes = typeof generateRoutes === 'function' ? generateRoutes(target.name, 'all') : []; } catch (_) { routes = []; }
      routes = Array.isArray(routes) ? routes.filter(route => Number.isFinite(Number(route.duration))) : [];
      if (!routes.length) return renderMessage('Aucune option de trajet n’est disponible pour ce défi.', 'warning');
      const fastest = routes.reduce((best, route) => Number(route.duration) < Number(best.duration) ? route : best, routes[0]);
      challenge = { kind, target, routes, fastestId: Number(fastest.id), completed: false };
      renderRouteChallenge(target, routes);
      const bottomPadding = window.innerWidth < 720 ? Math.round(window.innerHeight * 0.48) : 36;
      mapInstance.setView([Number(target.lat), Number(target.lng)], 9, { animate: true });
      mapInstance.panBy([0, Math.round(bottomPadding * 0.35)], { animate: true });
      return;
    }

    renderMessage('Choisissez un type de défi dans la liste.', 'warning');
  }

  function renderOrientationChallenge(target) {
    missionArea.innerHTML = `
      <div class="vagvis-game-challenge-head"><span class="vagvis-game-pill">ORIENTATION · 100 PTS</span><span class="vagvis-game-data-tag">Données VagVis</span></div>
      <h3 class="vagvis-game-challenge-title">Cap sur <span>${escapeHtml(target.name)}</span></h3>
      <p class="vagvis-game-challenge-copy">Repérez cette ville sur la carte, zoomez si besoin, puis touchez son emplacement. Données géographiques VagVis.</p>
      <div id="vagvis-game-status" class="vagvis-game-status" aria-live="polite">Déplacez la carte et touchez près de la destination.</div>
      <button class="vagvis-game-secondary" type="button" data-vagvis-game-action="next">Changer de défi</button>`;
  }

  function renderDiscoveryChallenge(target) {
    const category = String(target.type || 'lieu').replace(/[-_]/g, ' ');
    missionArea.innerHTML = `
      <div class="vagvis-game-challenge-head"><span class="vagvis-game-pill vagvis-game-pill--coral">DÉCOUVERTE · 80 PTS</span><span class="vagvis-game-data-tag">Données VagVis</span></div>
      <h3 class="vagvis-game-challenge-title">Retrouvez <span>${escapeHtml(target.name)}</span></h3>
      <p class="vagvis-game-challenge-copy">Cible : ${escapeHtml(category)}. Les repères VagVis sont masqués le temps de cette manche ; touchez près du lieu.</p>
      <div id="vagvis-game-status" class="vagvis-game-status" aria-live="polite">À vous de placer le point sur la carte.</div>
      <button class="vagvis-game-secondary" type="button" data-vagvis-game-action="next">Changer de défi</button>`;
  }

  function routeModeLabel(route) {
    const modes = Array.isArray(route.modes) ? route.modes : [];
    const names = { train: 'Train', bus: 'Bus', bike: 'Vélo', walk: 'Marche' };
    const label = modes.map(mode => names[mode] || mode).join(' + ');
    return label || 'Multimodal';
  }

  function renderRouteChallenge(target, routes) {
    const sorted = [...routes].sort((a, b) => Number(a.duration) - Number(b.duration));
    const choices = sorted.map(route => `
      <button class="vagvis-game-route-option" type="button" data-vagvis-game-route="${Number(route.id)}">
        <span class="vagvis-game-route-option__mode">${escapeHtml(routeModeLabel(route))}</span>
        <strong>${Math.round(Number(route.duration))}<small> min</small></strong>
        <span class="vagvis-game-route-option__detail">${escapeHtml(route.price || 'Option locale')}${Number.isFinite(Number(route.transfers)) ? ` · ${Number(route.transfers)} correspondance${Number(route.transfers) > 1 ? 's' : ''}` : ''}</span>
      </button>`).join('');
    missionArea.innerHTML = `
      <div class="vagvis-game-challenge-head"><span class="vagvis-game-pill vagvis-game-pill--violet">ITINÉRAIRE · 90 PTS</span><span class="vagvis-game-data-tag vagvis-game-data-tag--simulated">Simulation</span></div>
      <h3 class="vagvis-game-challenge-title">Quel trajet est le plus rapide vers <span>${escapeHtml(target.name)}</span> ?</h3>
      <p class="vagvis-game-challenge-copy">Comparez les options multimodales proposées dans le jeu. Choisissez le temps le plus court.</p>
      <div class="vagvis-game-route-options">${choices}</div>
      <div class="vagvis-game-simulation-note">Simulation locale : ces durées et tarifs sont indicatifs, pas des horaires temps réel.</div>
      <div id="vagvis-game-status" class="vagvis-game-status" aria-live="polite">Sélectionnez une option pour vérifier votre choix.</div>
      <button class="vagvis-game-secondary" type="button" data-vagvis-game-action="next">Changer de défi</button>`;
  }

  function showCityLabels(cities, target) {
    if (!challengeLayer || !window.L) return;
    cities.forEach(city => {
      const icon = window.L.divIcon({
        className: 'vagvis-game-map-icon',
        html: `<span class="vagvis-game-city-marker"><span class="vagvis-game-city-marker__dot"></span>${escapeHtml(city.name)}</span>`,
        iconSize: [132, 28],
        iconAnchor: [0, 14]
      });
      const marker = window.L.marker([Number(city.lat), Number(city.lng)], { icon, keyboard: true, title: `Ville : ${city.name}`, riseOnHover: true });
      marker.on('click', () => handleCityGuess(city));
      challengeLayer.addLayer(marker);
    });
  }

  function attachMapChallenge() {
    const mapInstance = mapRef();
    if (!mapInstance) return;
    mapClickHandler = event => {
      if (!challenge || challenge.completed || !event.latlng) return;
      const place = { lat: event.latlng.lat, lng: event.latlng.lng };
      const distance = distanceMeters(place, challenge.target);
      if (distance <= challenge.radius) {
        succeedChallenge(challenge.kind === 'orientation' ? 100 : 80, challenge.kind === 'orientation' ? 'Bien orienté !' : 'Lieu découvert !');
      } else {
        const status = document.getElementById('vagvis-game-status');
        if (status) status.textContent = `Encore ${formatDistance(distance)} de la cible. Zoomez ou déplacez la carte pour affiner.`;
      }
    };
    mapInstance.on('click', mapClickHandler);
  }

  function handleCityGuess(city) {
    if (!challenge || challenge.kind !== 'orientation' || challenge.completed) return;
    if (String(city.name) === String(challenge.target.name)) {
      succeedChallenge(100, 'Parfaitement orienté !');
    } else {
      const status = document.getElementById('vagvis-game-status');
      if (status) status.textContent = `${escapeHtml(city.name)} repérée. Continuez vers ${escapeHtml(challenge.target.name)}.`;
    }
  }

  function chooseRoute(routeId) {
    if (!challenge || challenge.kind !== 'route' || challenge.completed) return;
    if (routeId === challenge.fastestId) {
      const route = challenge.routes.find(item => Number(item.id) === routeId);
      challenge.selectedRoute = route || null;
      succeedChallenge(90, `Exact : ${Math.round(Number(route?.duration) || 0)} minutes, selon les options simulées.`);
      return;
    }
    progress.streak = 0;
    saveProgress();
    updateProgressDisplay();
    const correct = challenge.routes.find(item => Number(item.id) === challenge.fastestId);
    const status = document.getElementById('vagvis-game-status');
    if (status) status.textContent = `Pas encore : l’option la plus rapide est ${routeModeLabel(correct)} (${Math.round(Number(correct.duration))} min). Réessayez.`;
  }

  function succeedChallenge(points, message) {
    if (!challenge || challenge.completed) return;
    challenge.completed = true;
    detachMapChallenge();
    progress.score += points;
    progress.completed += 1;
    progress.streak += 1;
    progress.bestStreak = Math.max(progress.bestStreak, progress.streak);
    saveProgress();
    updateProgressDisplay();
    const targetName = escapeHtml(challenge.target.name);
    const routeResult = challenge.kind === 'route';
    missionArea.innerHTML = `
      <div class="vagvis-game-result">
        <div class="vagvis-game-result__check">✓</div>
        <div class="vagvis-game-result__eyebrow">DÉFI RÉUSSI · +${points} PTS</div>
        <h3>${escapeHtml(message)}</h3>
        <p>${routeResult ? `Destination : ${targetName}. Les options comparées étaient simulées.` : `Étape validée : ${targetName}.`}</p>
        <div class="vagvis-game-result__actions">
          ${routeResult
            ? '<button class="vagvis-game-primary" type="button" data-vagvis-game-action="open-route">Voir les itinéraires VagVis <span>→</span></button>'
            : '<button class="vagvis-game-primary" type="button" data-vagvis-game-action="open-target">Afficher dans VagVis <span>→</span></button>'}
          <button class="vagvis-game-secondary" type="button" data-vagvis-game-action="next">Continuer l’exploration</button>
        </div>
      </div>`;
  }

  function renderMessage(text, kind) {
    if (!missionArea) return;
    missionArea.innerHTML = `<div class="vagvis-game-status${kind === 'warning' ? ' vagvis-game-status--warning' : ''}" role="status">${escapeHtml(text)}</div>`;
  }

  function openTargetInVagVis() {
    if (!challenge || !challenge.target) return;
    const target = challenge.target;
    const targetKind = challenge.kind;
    mapChangedByGame = true;
    closeGame();
    const mapInstance = mapRef();
    if (mapInstance) {
      try { mapInstance.setView([Number(target.lat), Number(target.lng)], targetKind === 'orientation' ? 12 : 15, { animate: true }); } catch (_) { /* L’ouverture de la fiche reste prioritaire. */ }
    }
    try {
      if (target.type && typeof openPoi === 'function') openPoi(target);
      else if (typeof showToast === 'function') showToast(`Destination affichée : ${target.name}`);
    } catch (_) {
      try { if (typeof showToast === 'function') showToast(`Destination affichée : ${target.name}`); } catch (__) { /* no-op */ }
    }
  }

  function openRouteInVagVis() {
    if (!challenge || !challenge.target) return;
    const destination = challenge.target.name;
    mapChangedByGame = true;
    closeGame();
    try {
      if (typeof currentMode !== 'undefined') currentMode = 'all';
      document.querySelectorAll('.transport-tab[data-mode]').forEach(tab => tab.classList.toggle('active', tab.dataset.mode === 'all'));
      const search = document.getElementById('searchInput');
      if (search) search.value = destination;
      if (typeof searchAndRoute === 'function') searchAndRoute(destination);
      else if (typeof showToast === 'function') showToast(`Destination : ${destination}`);
    } catch (_) {
      try { if (typeof showToast === 'function') showToast(`Destination : ${destination}`); } catch (__) { /* no-op */ }
    }
  }

  function boot() {
    if (!document.getElementById('map') || !window.L) return;
    buildInterface();
    const mapInstance = mapRef();
    if (mapInstance) challengeLayer = window.L.layerGroup().addTo(mapInstance);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
