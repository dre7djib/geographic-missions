// Geographic Missions: career missions for Subway Builder
// v0.9.0: general missions + geographic missions (zones per city).
// Packs: Paris / Île-de-France (main), Lyon, Marseille, New York, London.
// + career missions (api.career) tracking passenger flows from origin -> destination.
// Hooks, game state, per-game storage, React floating panel, notifications,
// map highlight of a mission's zones.

(function () {
  'use strict';

  const api = window.SubwayBuilderAPI;
  if (!api) {
    console.error('[Missions] SubwayBuilderAPI not found!');
    return;
  }

  const TAG = '[Missions]';
  const NOTIF_TITLE = 'Geographic Missions';

  // Storage bound to this mod, usable even after an `await`
  const storage = api.storage.scoped();

  const { React, components } = api.utils;
  const h = React.createElement;
  const { Badge, Progress } = components;

  const fmt = (n) => Math.round(n).toLocaleString('en-US');

  // ---------------------------------------------------------------------------
  // Reward scale (per city)
  //
  // Rewards are written below in base millions (rewardMillions(3) = 3 M$ at
  // scale 1). The amount actually paid = base reward x the city's `rewardScale`
  // (set in each pack below). In the game's normal mode the starting budget is
  // $3 billion and a line easily costs over $1 billion, so the factor grows
  // with the size of the metro area (longer, more expensive links):
  //   x25  -> 25 M$ to 200 M$ per mission (a full city adds ~+50% of the start budget)
  //   x50  -> 50 M$ to 400 M$ per mission (~+100%)
  //   x100 -> 100 M$ to 800 M$ per mission (~+200%, makes the game much easier)
  // DEFAULT_REWARD_SCALE is used when the city is not recognized.
  // ---------------------------------------------------------------------------
  const DEFAULT_REWARD_SCALE = 50;
  const rewardMillions = (millions) => millions * 1_000_000;

  // Compact money format: $950, $950K, $400M, $1.25B (handles negatives)
  const fmtMoney = (n) => {
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    const trim = (x, digits) => String(Number(x.toFixed(digits)));
    if (abs >= 1e9) return `${sign}$${trim(abs / 1e9, 2)}B`;
    if (abs >= 1e6) return `${sign}$${trim(abs / 1e6, 1)}M`;
    if (abs >= 1e3) return `${sign}$${trim(abs / 1e3, 1)}K`;
    return `${sign}$${Math.round(abs)}`;
  };

  // ===========================================================================
  // 1. GENERAL MISSIONS (valid in every city)
  // measure() returns { value, target, label }; the mission is completed
  // when value >= target. `reward` is added to the budget.
  // ===========================================================================
  const BASE_MISSIONS = [
    {
      id: 'first-line',
      title: 'First Line',
      description: 'Create your first metro line and get trains running on it.',
      reward: rewardMillions(1),
      measure: () => {
        const routes = api.gameState.getRoutes().filter((r) => !r.tempParentId);
        const running = routesWithTrains();
        const inService = routes.filter((r) => running.has(r.id)).length;
        const waiting = routes.length - inService;
        let label = `${inService} / 1 line in service`;
        if (waiting > 0) label += ` · ${waiting} created, no train yet`;
        return { value: inService, target: 1, label };
      },
    },
    {
      id: 'ten-stations',
      title: 'Build the Network',
      description: 'Build 10 stations, each on a line with trains running.',
      reward: rewardMillions(2),
      measure: () => {
        const c = serviceCounts(api.gameState.getStations(), routesWithTrains());
        return { value: c.served, target: 10, label: `${c.served} / 10 stations in service${serviceNote(c)}` };
      },
    },
    {
      id: 'transfers',
      title: 'Transfers',
      description: 'Have 3 built stations in a transfer hub, served by lines with trains.',
      reward: rewardMillions(2),
      measure: () => {
        const hub = new Set(api.gameState.getTransferStationIds());
        const running = routesWithTrains();
        const n = api.gameState.getStations().filter((st) => hub.has(st.id) && isBuilt(st) && stationRoutes(st).some((r) => running.has(r))).length;
        return { value: n, target: 3, label: `${n} / 3 transfer stations in service` };
      },
    },
    {
      id: 'riders-1000',
      title: 'First Riders',
      description: 'Reach 1,000 riders per hour on the network.',
      reward: rewardMillions(3),
      measure: () => {
        const n = api.gameState.getRidershipStats().totalRidersPerHour || 0;
        return { value: n, target: 1000, label: `${fmt(n)} / 1,000 riders/h` };
      },
    },
    {
      id: 'mode-share-10',
      title: 'Mode Shift',
      description: 'Convince 10% of home-to-work trips to use the metro.',
      reward: rewardMillions(5),
      measure: () => {
        const m = api.gameState.getModeChoiceStats();
        const total = m.walking + m.driving + m.transit;
        const pct = total > 0 ? (m.transit / total) * 100 : 0;
        return { value: pct, target: 10, label: `${pct.toFixed(1)} / 10% by public transit` };
      },
    },
    {
      id: 'profit',
      title: 'In the Black',
      description: 'Make a positive profit over 24 h with at least one line.',
      reward: rewardMillions(4),
      measure: () => {
        const routes = api.gameState.getRouteFinancials();
        if (!routes || routes.length === 0) {
          return { value: 0, target: 1, label: 'No line in service' };
        }
        const profit = routes.reduce((sum, r) => sum + (r.last24Hours?.profit || 0), 0);
        return { value: profit, target: 1, label: `24 h profit: ${fmtMoney(profit)}` };
      },
    },
    {
      id: 'day-30',
      title: 'Survive a Month',
      description: 'Keep trains running on your network for 30 days.',
      reward: rewardMillions(3),
      measure: () => {
        const n = serviceDays.size;
        return { value: n, target: 30, label: `${n} / 30 days with trains running` };
      },
    },
  ];

  // ===========================================================================
  // 2. GEOGRAPHIC MISSIONS
  //
  // A "pack" = one city (the mod is multi-city; Paris is the main pack): a
  // bounding box (to detect the city being played), named zones (boxes
  // [west, south, east, north] in degrees, longitude/latitude) and mission
  // definitions. Each pack also has a `rewardScale` (see "Reward scale" above).
  //
  // Mission types:
  //   stationsIn    : n stations in a zone
  //   connect       : a single line serves a station in zone A AND a station
  //                   in zone B
  //   zoneRidership : total riders across the stations of a zone
  //   coverage      : at least one station in each of the listed zones
  //
  // WARNING: the boxes below are approximations that need calibrating.
  // Turn on the "station coordinates (debug)" setting and click a station to
  // see its coordinates, then adjust the boxes.
  // ===========================================================================
  const PACKS = [
    {
      // Paris has been in the game since v1.6.0
      id: 'paris',
      cityCode: 'PAR',
      rewardScale: 50, // huge metro area, long links (was x100: too generous, ~2x the starting budget)
      name: 'Paris / Île-de-France',
      bbox: [1.9, 48.1, 3.2, 49.3],
      zones: {
        laDefense: { name: 'La Défense', box: [2.225, 48.885, 2.255, 48.9] },
        chatelet: { name: 'Châtelet – Les Halles', box: [2.335, 48.855, 2.355, 48.867] },
        gareNord: { name: 'Gare du Nord', box: [2.345, 48.877, 2.365, 48.885] },
        orly: { name: 'Orly', box: [2.35, 48.71, 2.4, 48.74] },
        cdg: { name: 'Roissy – CDG', box: [2.52, 48.985, 2.58, 49.02] },
        stadeDeFrance: { name: 'Stade de France', box: [2.345, 48.915, 2.375, 48.935] },
        disneyland: { name: 'Disneyland Paris', box: [2.76, 48.85, 2.81, 48.89] },
        saclay: { name: 'Paris-Saclay', box: [2.14, 48.69, 2.21, 48.74] },
        eiffelTower: { name: 'Eiffel Tower', box: [2.285, 48.853, 2.304, 48.864] },
        arcDeTriomphe: { name: 'Arc de Triomphe', box: [2.286, 48.869, 2.304, 48.878] },
        notreDame: { name: 'Notre-Dame', box: [2.341, 48.849, 2.359, 48.8545] },
      },
      defs: [
        { id: 'defense-chatelet', type: 'connect', a: 'laDefense', b: 'chatelet', reward: rewardMillions(3),
          title: 'From the Grande Arche to Les Halles', description: 'Connect La Défense to Châtelet – Les Halles with a single line.' },
        { id: 'chatelet-orly', type: 'connect', a: 'chatelet', b: 'orly', reward: rewardMillions(6),
          title: 'Heading to Orly', description: 'Connect Châtelet – Les Halles to Orly with a single line.' },
        { id: 'nord-cdg', type: 'connect', a: 'gareNord', b: 'cdg', reward: rewardMillions(8),
          title: 'Roissy Express', description: 'Connect Gare du Nord to Roissy – CDG with a single line.' },
        { id: 'chatelet-riders', type: 'zoneRidership', zone: 'chatelet', n: 2000, reward: rewardMillions(5),
          title: 'Europe’s Biggest Hub', description: 'Get 2,000 riders through the Châtelet – Les Halles stations.' },
        { id: 'paris-tour', type: 'coverage', zones: ['laDefense', 'chatelet', 'gareNord', 'eiffelTower', 'arcDeTriomphe', 'notreDame'], reward: rewardMillions(4),
          title: 'Tour of Paris', description: 'Serve La Défense, Châtelet, Gare du Nord and three landmarks: the Eiffel Tower, the Arc de Triomphe and Notre-Dame.' },
        { id: 'nord-stade', type: 'connect', a: 'gareNord', b: 'stadeDeFrance', reward: rewardMillions(3),
          title: 'Night at the Stade de France', description: 'Connect Gare du Nord to the Stade de France with a single line.' },
        { id: 'chatelet-disney', type: 'connect', a: 'chatelet', b: 'disneyland', reward: rewardMillions(6),
          title: 'Heading to Disneyland', description: 'Connect Châtelet – Les Halles to Disneyland Paris with a single line.' },
        { id: 'chatelet-saclay', type: 'connect', a: 'chatelet', b: 'saclay', reward: rewardMillions(6),
          title: 'The Saclay Plateau', description: 'Connect Châtelet – Les Halles to Paris-Saclay with a single line.' },
      ],
    },
    {
      id: 'lyon',
      cityCode: 'LYO',
      rewardScale: 25, // smaller network, shorter links
      name: 'Lyon',
      bbox: [4.2, 45.3, 5.6, 46.2],
      zones: {
        partDieu: { name: 'Part-Dieu', box: [4.85, 45.755, 4.87, 45.77] },
        bellecour: { name: 'Bellecour', box: [4.825, 45.752, 4.842, 45.765] },
        laDoua: { name: 'La Doua', box: [4.865, 45.775, 4.895, 45.795] },
        laSoie: { name: 'La Soie', box: [4.89, 45.755, 4.93, 45.775] },
        saintExupery: { name: 'Saint-Exupéry Airport', box: [5.04, 45.7, 5.12, 45.75] },
        fourviere: { name: 'Fourvière Basilica', box: [4.815, 45.758, 4.8245, 45.767] },
        terreaux: { name: 'Place des Terreaux', box: [4.828, 45.765, 4.842, 45.771] },
        teteDOr: { name: 'Parc de la Tête d’Or', box: [4.848, 45.77, 4.864, 45.784] },
      },
      defs: [
        { id: 'partdieu-bellecour', type: 'connect', a: 'partDieu', b: 'bellecour', reward: rewardMillions(3),
          title: 'Part-Dieu – Bellecour', description: 'Connect Part-Dieu to Bellecour with a single line.' },
        { id: 'partdieu-doua', type: 'connect', a: 'partDieu', b: 'laDoua', reward: rewardMillions(3),
          title: 'La Doua Campus', description: 'Connect Part-Dieu to La Doua with a single line.' },
        { id: 'partdieu-airport', type: 'connect', a: 'partDieu', b: 'saintExupery', reward: rewardMillions(7),
          title: 'Heading to Saint-Exupéry', description: 'Connect Part-Dieu to Saint-Exupéry Airport with a single line.' },
        { id: 'partdieu-riders', type: 'zoneRidership', zone: 'partDieu', n: 2000, reward: rewardMillions(5),
          title: 'The Business Heart', description: 'Get 2,000 riders through the Part-Dieu stations.' },
        { id: 'lyon-tour', type: 'coverage', zones: ['partDieu', 'bellecour', 'laDoua', 'fourviere', 'terreaux', 'teteDOr'], reward: rewardMillions(4),
          title: 'Tour of Lyon', description: 'Serve Part-Dieu, Bellecour, La Doua and three landmarks: Fourvière Basilica, Place des Terreaux and the Parc de la Tête d’Or.' },
      ],
    },
    {
      id: 'marseille',
      cityCode: 'MAR',
      rewardScale: 25, // smaller network, shorter links
      name: 'Marseille',
      bbox: [4.9, 43.0, 5.8, 43.7],
      zones: {
        saintCharles: { name: 'Saint-Charles', box: [5.37, 43.298, 5.392, 43.31] },
        vieuxPort: { name: 'Old Port', box: [5.36, 43.285, 5.385, 43.2975] },
        velodrome: { name: 'Stade Vélodrome', box: [5.385, 43.26, 5.405, 43.278] },
        airport: { name: 'Marseille Provence Airport', box: [5.18, 43.41, 5.26, 43.46] },
        aix: { name: 'Aix-en-Provence', box: [5.42, 43.51, 5.48, 43.55] },
        notreDameDeLaGarde: { name: 'Notre-Dame de la Garde', box: [5.364, 43.279, 5.379, 43.2845] },
        laMajor: { name: 'La Major Cathedral', box: [5.356, 43.298, 5.368, 43.306] },
        palaisLongchamp: { name: 'Palais Longchamp', box: [5.392, 43.302, 5.402, 43.309] },
      },
      defs: [
        { id: 'charles-vieuxport', type: 'connect', a: 'saintCharles', b: 'vieuxPort', reward: rewardMillions(3),
          title: 'From the Station to the Old Port', description: 'Connect Saint-Charles to the Old Port with a single line.' },
        { id: 'charles-velodrome', type: 'connect', a: 'saintCharles', b: 'velodrome', reward: rewardMillions(4),
          title: 'Night at the Vélodrome', description: 'Connect Saint-Charles to the Stade Vélodrome with a single line.' },
        { id: 'charles-airport', type: 'connect', a: 'saintCharles', b: 'airport', reward: rewardMillions(7),
          title: 'Marseille Provence', description: 'Connect Saint-Charles to Marseille Provence Airport with a single line.' },
        { id: 'charles-aix', type: 'connect', a: 'saintCharles', b: 'aix', reward: rewardMillions(8),
          title: 'Aix-Marseille', description: 'Connect Saint-Charles to Aix-en-Provence with a single line.' },
        { id: 'marseille-tour', type: 'coverage', zones: ['saintCharles', 'vieuxPort', 'velodrome', 'notreDameDeLaGarde', 'laMajor', 'palaisLongchamp'], reward: rewardMillions(3),
          title: 'Tour of Marseille', description: 'Serve Saint-Charles, the Old Port, the Vélodrome and three landmarks: Notre-Dame de la Garde, La Major Cathedral and Palais Longchamp.' },
      ],
    },
    {
      id: 'nyc',
      cityCode: 'NYC',
      rewardScale: 50, // large but compact metro area
      name: 'New York',
      bbox: [-74.3, 40.45, -73.65, 40.95],
      zones: {
        bushwick: { name: 'Bushwick / Williamsburg', box: [-73.975, 40.688, -73.9, 40.725] },
        lowerManhattan: { name: 'Lower Manhattan', box: [-74.025, 40.7, -73.99, 40.725] },
        midtown: { name: 'Midtown', box: [-74.0, 40.745, -73.965, 40.765] },
        downtownBk: { name: 'Downtown Brooklyn', box: [-73.998, 40.685, -73.975, 40.7] },
        jfk: { name: 'JFK', box: [-73.82, 40.62, -73.76, 40.66] },
        laGuardia: { name: 'LaGuardia', box: [-73.89, 40.765, -73.85, 40.785] },
        empireState: { name: 'Empire State Building', box: [-73.992, 40.745, -73.979, 40.752] },
        timesSquare: { name: 'Times Square', box: [-73.992, 40.754, -73.979, 40.762] },
        centralPark: { name: 'Central Park', box: [-73.986, 40.765, -73.968, 40.775] },
      },
      defs: [
        { id: 'bushwick-stations', type: 'stationsIn', zone: 'bushwick', n: 3, reward: rewardMillions(2),
          title: 'A Foothold in Bushwick', description: 'Build 3 stations in Bushwick / Williamsburg.' },
        { id: 'bushwick-express', type: 'connect', a: 'bushwick', b: 'lowerManhattan', reward: rewardMillions(5),
          title: 'Bushwick Express', description: 'Connect Bushwick / Williamsburg to Lower Manhattan with a single line.' },
        { id: 'lm-riders', type: 'zoneRidership', zone: 'lowerManhattan', n: 1500, reward: rewardMillions(5),
          title: 'Wall Street Never Sleeps', description: 'Get 1,500 riders through the Lower Manhattan stations.' },
        { id: 'midtown-jfk', type: 'connect', a: 'midtown', b: 'jfk', reward: rewardMillions(8),
          title: 'Heading to JFK', description: 'Connect Midtown to JFK Airport with a single line.' },
        { id: 'midtown-lga', type: 'connect', a: 'midtown', b: 'laGuardia', reward: rewardMillions(6),
          title: 'Heading to LaGuardia', description: 'Connect Midtown to LaGuardia with a single line.' },
        { id: 'nyc-tour', type: 'coverage', zones: ['bushwick', 'lowerManhattan', 'downtownBk', 'empireState', 'timesSquare', 'centralPark'], reward: rewardMillions(4),
          title: 'Tour of the City', description: 'Serve Bushwick, Lower Manhattan, Downtown Brooklyn and three landmarks: the Empire State Building, Times Square and Central Park.' },
      ],
    },
    {
      id: 'london',
      cityCode: 'LON',
      rewardScale: 50, // large metro area
      name: 'London',
      bbox: [-0.6, 51.28, 0.35, 51.7],
      zones: {
        canaryWharf: { name: 'Canary Wharf', box: [-0.035, 51.495, -0.005, 51.515] },
        city: { name: 'The City', box: [-0.105, 51.505, -0.065, 51.522] },
        westEnd: { name: 'West End', box: [-0.17, 51.495, -0.11, 51.52] },
        heathrow: { name: 'Heathrow', box: [-0.5, 51.455, -0.41, 51.485] },
        stratford: { name: 'Stratford', box: [-0.015, 51.535, 0.015, 51.55] },
        bigBen: { name: 'Big Ben', box: [-0.131, 51.497, -0.118, 51.504] },
        buckinghamPalace: { name: 'Buckingham Palace', box: [-0.15, 51.495, -0.132, 51.508] },
        britishMuseum: { name: 'British Museum', box: [-0.134, 51.516, -0.12, 51.523] },
      },
      defs: [
        { id: 'city-canary', type: 'connect', a: 'city', b: 'canaryWharf', reward: rewardMillions(3),
          title: 'City – Canary Wharf', description: 'Connect the City to Canary Wharf with a single line.' },
        { id: 'heathrow-westend', type: 'connect', a: 'heathrow', b: 'westEnd', reward: rewardMillions(8),
          title: 'Heathrow Express', description: 'Connect Heathrow to the West End with a single line.' },
        { id: 'stratford-stations', type: 'stationsIn', zone: 'stratford', n: 2, reward: rewardMillions(2),
          title: 'Heading East', description: 'Build 2 stations in Stratford.' },
        { id: 'canary-riders', type: 'zoneRidership', zone: 'canaryWharf', n: 1500, reward: rewardMillions(5),
          title: 'The Business District', description: 'Get 1,500 riders through the Canary Wharf stations.' },
        { id: 'london-tour', type: 'coverage', zones: ['canaryWharf', 'city', 'stratford', 'bigBen', 'buckinghamPalace', 'britishMuseum'], reward: rewardMillions(4),
          title: 'Tour of London', description: 'Serve Canary Wharf, the City, Stratford and three landmarks: Big Ben, Buckingham Palace and the British Museum.' },
      ],
    },
  ];

  // --- Geometry helpers ------------------------------------------------------

  // coords = [longitude, latitude]; box = [west, south, east, north]
  function inBox(coords, box) {
    if (!coords || coords.length < 2) return false;
    const lng = coords[0];
    const lat = coords[1];
    return lng >= box[0] && lng <= box[2] && lat >= box[1] && lat <= box[3];
  }

  function stationsIn(box) {
    return api.gameState.getStations().filter((s) => inBox(s.coords, box));
  }

  function stationRoutes(station) {
    return Array.isArray(station.routeIds) ? station.routeIds : [];
  }

  // A station is "built" only once constructed (not a blueprint or a preview).
  // A station without a buildType (older game versions) is treated as built.
  function isBuilt(station) {
    return !station.buildType || station.buildType === 'constructed';
  }

  // Ids of the routes that currently have at least one train running
  function routesWithTrains() {
    const ids = new Set();
    try {
      for (const t of api.gameState.getTrains()) ids.add(t.routeId);
    } catch (e) {
      // trains unavailable: nothing counts as served
    }
    return ids;
  }

  // Service status of a zone:
  //   'served'  : a built station in the zone is on a route that has trains
  //   'built'   : built station(s), but no route with trains serves them yet
  //   'planned' : only blueprint/preview stations (not built yet)
  //   'none'    : no station at all
  function zoneServiceStatus(box, running) {
    const inside = stationsIn(box);
    if (inside.length === 0) return 'none';
    const built = inside.filter(isBuilt);
    if (built.length === 0) return 'planned';
    return built.some((s) => stationRoutes(s).some((r) => running.has(r))) ? 'served' : 'built';
  }

  // Counts how many of the given stations are in service / built only / not built
  function serviceCounts(stations, running) {
    let served = 0;
    let built = 0;
    let planned = 0;
    for (const s of stations) {
      if (!isBuilt(s)) planned++;
      else if (stationRoutes(s).some((r) => running.has(r))) served++;
      else built++;
    }
    return { served, built, planned };
  }

  // " · 1 built, no train yet · 2 not built yet" (empty when everything is in service)
  function serviceNote(c) {
    let note = '';
    if (c.built > 0) note += ` · ${c.built} built, no train yet`;
    if (c.planned > 0) note += ` · ${c.planned} not built yet`;
    return note;
  }

  const ZONE_STATE_TEXT = {
    served: 'in service ✓',
    built: 'built, no train yet',
    planned: 'not built yet',
    none: 'no station',
  };

  // --- Geographic mission factory --------------------------------------------

  function buildGeoMission(pack, def) {
    const mission = {
      id: `geo:${pack.id}:${def.id}`,
      title: def.title,
      description: def.description,
      reward: def.reward,
      rewardScale: pack.rewardScale,
      geo: true,
    };

    if (def.type === 'stationsIn') {
      const zone = pack.zones[def.zone];
      mission.zones = [{ name: zone.name, box: zone.box, role: 'zone' }];
      mission.description = `${def.description} Stations must be built and on a line with trains running.`;
      mission.measure = () => {
        const c = serviceCounts(stationsIn(zone.box), routesWithTrains());
        return { value: c.served, target: def.n, label: `${c.served} / ${def.n} stations in service (${zone.name})${serviceNote(c)}` };
      };
    } else if (def.type === 'connect') {
      const zA = pack.zones[def.a];
      const zB = pack.zones[def.b];
      mission.zones = [
        { name: zA.name, box: zA.box, role: 'from' },
        { name: zB.name, box: zB.box, role: 'to' },
      ];
      mission.link = true; // draw a dashed line between the two zones
      mission.description = `${def.description} Both ends need a built station, and trains must run on the line.`;
      mission.measure = () => {
        const running = routesWithTrains();
        const stateA = zoneServiceStatus(zA.box, running);
        const stateB = zoneServiceStatus(zB.box, running);
        // Only built stations on routes that have trains can link the two zones
        const servedIn = (box) =>
          stationsIn(box).filter((s) => isBuilt(s) && stationRoutes(s).some((r) => running.has(r)));
        const routesA = new Set(servedIn(zA.box).flatMap(stationRoutes).filter((r) => running.has(r)));
        const connected = servedIn(zB.box).some((s) => stationRoutes(s).some((r) => routesA.has(r)));
        // 1 point per zone in service + 1 point if a single running line links them
        const value = (stateA === 'served' ? 1 : 0) + (stateB === 'served' ? 1 : 0) + (connected ? 1 : 0);
        const label = connected
          ? 'Link established'
          : `${zA.name}: ${ZONE_STATE_TEXT[stateA]} · ${zB.name}: ${ZONE_STATE_TEXT[stateB]}` +
            (stateA === 'served' && stateB === 'served' ? ' · not connected yet' : '');
        return { value, target: 3, label };
      };
    } else if (def.type === 'zoneRidership') {
      const zone = pack.zones[def.zone];
      mission.zones = [{ name: zone.name, box: zone.box, role: 'zone' }];
      mission.measure = () => {
        let total = 0;
        for (const s of stationsIn(zone.box).filter(isBuilt)) {
          const stats = api.gameState.getStationRidership(s.id);
          total += (stats && stats.total) || 0;
        }
        return {
          value: total,
          target: def.n,
          label: `${fmt(total)} / ${fmt(def.n)} riders (${zone.name})`,
        };
      };
    } else if (def.type === 'coverage') {
      mission.zones = def.zones.map((k) => ({ name: pack.zones[k].name, box: pack.zones[k].box, role: 'zone' }));
      mission.description = `${def.description} Each zone needs a built station on a line with trains running.`;
      mission.measure = () => {
        const running = routesWithTrains();
        const status = def.zones.map((k) => zoneServiceStatus(pack.zones[k].box, running));
        const count = (x) => status.filter((v) => v === x).length;
        const served = count('served');
        const built = count('built');
        const planned = count('planned');
        let label = `${served} / ${def.zones.length} zones served`;
        if (built > 0) label += ` · ${built} built, no train yet`;
        if (planned > 0) label += ` · ${planned} not built yet`;
        return { value: served, target: def.zones.length, label };
      };
    } else {
      console.error(TAG, `Unknown mission type: ${def.type}`);
      mission.measure = () => ({ value: 0, target: 1, label: 'Invalid mission' });
    }
    return mission;
  }

  PACKS.forEach((pack) => {
    pack.missions = pack.defs.map((def) => buildGeoMission(pack, def));
  });

  // --- Detecting the city being played ---------------------------------------
  // 1) city code received via onCityLoad; 2) centroid of existing stations;
  // 3) otherwise the map center (via onMapReady / utils.getMap).

  let mapRef = null;
  let lastCityCode = null;

  function detectPack() {
    // 1) City code received via onCityLoad: works from zero stations
    if (lastCityCode) {
      const byCode = PACKS.find((p) => p.cityCode === lastCityCode);
      if (byCode) return byCode;
    }

    let point = null;
    try {
      const stations = api.gameState.getStations();
      if (stations.length > 0) {
        let lng = 0;
        let lat = 0;
        let count = 0;
        for (const s of stations) {
          if (s.coords && s.coords.length >= 2) {
            lng += s.coords[0];
            lat += s.coords[1];
            count++;
          }
        }
        if (count > 0) point = [lng / count, lat / count];
      }
    } catch (e) {
      // no game loaded
    }
    if (!point) {
      try {
        const map = mapRef || (api.utils.getMap && api.utils.getMap());
        if (map && typeof map.getCenter === 'function') {
          const c = map.getCenter();
          point = [c.lng, c.lat];
        }
      } catch (e) {
        // map unavailable
      }
    }
    if (!point) return null;
    return PACKS.find((p) => inBox(point, p.bbox)) || null;
  }

  function getMissions() {
    const pack = detectPack();
    return pack ? BASE_MISSIONS.concat(pack.missions) : BASE_MISSIONS;
  }

  // Amount actually paid: base reward x the city's factor. A geographic mission
  // carries its own city's factor; general missions use the detected city's.
  function rewardFor(mission) {
    const pack = detectPack();
    const scale = mission.rewardScale || (pack && pack.rewardScale) || DEFAULT_REWARD_SCALE;
    return mission.reward * scale;
  }

  // ===========================================================================
  // 2b. CAREER MISSIONS (native api.career API)
  //
  // Unlike the mod's own panel, api.career can track REAL passenger flows
  // between two zones (origin -> destination), like Bushwick Express. It is
  // used here for "suburb -> job hub" missions.
  // If api.career is missing (different game version), this part is skipped.
  //
  // Each mission has 3 stars: stations in the origin zone, then two passenger
  // tiers. The zones come from the packs above.
  // ===========================================================================
  const CAREER_FLOWS = [
    { pack: 'paris', cityCode: 'PAR', id: 'nord-defense', origin: 'stadeDeFrance', dest: 'laDefense',
      name: 'Northern Suburbs → La Défense', stations: 2, targets: [1000, 5000],
      description: 'Connect Saint-Denis / Stade de France to the La Défense business district.' },
    { pack: 'paris', cityCode: 'PAR', id: 'est-chatelet', origin: 'disneyland', dest: 'chatelet',
      name: 'Marne-la-Vallée → Châtelet', stations: 2, targets: [1000, 5000],
      description: 'Connect eastern Île-de-France (Marne-la-Vallée) to the heart of Paris.' },
    { pack: 'lyon', cityCode: 'LYO', id: 'soie-partdieu', origin: 'laSoie', dest: 'partDieu',
      name: 'La Soie → Part-Dieu', stations: 2, targets: [1000, 5000],
      description: 'Connect eastern Lyon (La Soie) to the Part-Dieu business district.' },
    { pack: 'marseille', cityCode: 'MAR', id: 'aix-charles', origin: 'aix', dest: 'saintCharles',
      name: 'Aix → Saint-Charles', stations: 2, targets: [1000, 5000],
      description: 'Connect Aix-en-Provence to Marseille Saint-Charles station.' },
    { pack: 'london', cityCode: 'LON', id: 'stratford-canary', origin: 'stratford', dest: 'canaryWharf',
      name: 'Stratford → Canary Wharf', stations: 2, targets: [1000, 5000],
      description: 'Connect east London (Stratford) to the jobs at Canary Wharf.' },
  ];

  function registerCareerMissions() {
    const career = api.career;
    if (!career || typeof career.registerMission !== 'function') {
      console.log(TAG, 'api.career unavailable: career missions skipped.');
      return;
    }
    const M = career.METRICS || {};
    if (!M.STATIONS_IN_REGION || !M.PASSENGERS_BETWEEN_REGIONS) {
      console.warn(TAG, 'Expected career metrics not found:', Object.keys(M));
      return;
    }

    let registered = 0;
    for (const f of CAREER_FLOWS) {
      const pack = PACKS.find((p) => p.id === f.pack);
      const o = pack && pack.zones[f.origin];
      const d = pack && pack.zones[f.dest];
      if (!o || !d) {
        console.error(TAG, `Zones not found for mission ${f.id}`);
        continue;
      }

      const missionId = `missions-geo.${f.pack}.${f.id}`;
      const flowParams = { originBbox: o.box, destBbox: d.box };
      const [t1, t2] = f.targets;

      try {
        // Avoid duplicates after a hot reload
        if (typeof career.unregisterMission === 'function') career.unregisterMission(missionId);

        const ok = career.registerMission({
          id: missionId,
          cityCode: f.cityCode,
          name: f.name,
          description: f.description,
          tier: 'starter',
          stars: [
            {
              id: 'star1',
              label: `Build ${f.stations} stations in ${o.name}`,
              shortLabel: `${f.stations} stations: ${o.name}`,
              icon: '🚇',
              metric: M.STATIONS_IN_REGION,
              target: f.stations,
              params: { bbox: o.box },
              howTo: [
                `Open the construction panel`,
                `Place stations in ${o.name}`,
                `Target residential areas to attract riders`,
              ],
              actionPanel: 'construction',
              actionLabel: 'Build',
            },
            {
              id: 'star2',
              label: `Carry ${fmt(t1)} riders from ${o.name} to ${d.name}`,
              shortLabel: `${fmt(t1)} riders ${o.name} → ${d.name}`,
              icon: '🎯',
              metric: M.PASSENGERS_BETWEEN_REGIONS,
              target: t1,
              params: flowParams,
              howTo: [
                `Connect ${o.name} to ${d.name} with a direct line`,
                `Residents of ${o.name} commute there for work`,
                `Track your progress in the demand panel`,
              ],
              actionPanel: 'demand-stats',
              actionLabel: 'View demand',
            },
            {
              id: 'star3',
              label: `Carry ${fmt(t2)} riders from ${o.name} to ${d.name}`,
              shortLabel: `${fmt(t2)} riders ${o.name} → ${d.name}`,
              icon: '🏆',
              metric: M.PASSENGERS_BETWEEN_REGIONS,
              target: t2,
              params: flowParams,
              howTo: [
                `Increase service frequency and add more trains`,
                `Expand coverage of ${o.name}`,
                `Make the trip faster than driving`,
              ],
            },
          ],
        });

        if (ok) registered++;
        else console.error(TAG, `Failed to register mission ${missionId}`);
      } catch (e) {
        console.error(TAG, `Error registering ${missionId}:`, e);
      }
    }
    console.log(TAG, `${registered} / ${CAREER_FLOWS.length} career missions registered.`);
  }

  registerCareerMissions();

  // ===========================================================================
  // 3. STATE AND PERSISTENCE (per game, via the session ID)
  // ===========================================================================
  let runId = null;
  let completed = {}; // { missionId: completionDay }
  let loaded = false;
  let loading = false;
  let serviceDays = new Set(); // game days on which at least one train was running

  function currentRunId() {
    return api.gameState.getGameSessionId() || 'no-session';
  }

  function saveState() {
    if (!runId) return Promise.resolve();
    return storage
      .set(`run:${runId}:completed`, completed)
      .catch((e) => console.error(TAG, 'Save error:', e));
  }

  function saveServiceDays() {
    if (!runId) return Promise.resolve();
    return storage
      .set(`run:${runId}:serviceDays`, Array.from(serviceDays))
      .catch((e) => console.error(TAG, 'Save error:', e));
  }

  // Counts the current game day as "in service" once a train has been seen running
  function trackServiceDay() {
    const day = api.gameState.getCurrentDay();
    if (serviceDays.has(day) || routesWithTrains().size === 0) return;
    serviceDays.add(day);
    saveServiceDays();
  }

  async function loadState() {
    loaded = false;
    loading = true;
    runId = currentRunId();
    try {
      completed = await storage.get(`run:${runId}:completed`, {});
      const days = await storage.get(`run:${runId}:serviceDays`, []);
      serviceDays = new Set(Array.isArray(days) ? days : []);
    } catch (e) {
      console.error(TAG, 'Load error:', e);
      completed = {};
      serviceDays = new Set();
    }
    loaded = true;
    loading = false;
    console.log(TAG, `Game ${runId}: ${Object.keys(completed).length} mission(s) already completed`);
    evaluate();
  }

  // ===========================================================================
  // 3b. "MISSION COMPLETED" POPIN
  //
  // The game's UI API has no modal window: the popin is therefore built with
  // native DOM (no React), using the game's light/dark theme colors.
  // Several missions completed at the same time are shown one after another.
  // If the popin cannot be displayed, we fall back to the notification.
  // ===========================================================================
  const POPIN_ID = 'missions-geo-popin';
  const popinQueue = [];
  let popinEl = null;
  let popinKeyHandler = null;

  function removePopinElement() {
    if (popinKeyHandler) {
      document.removeEventListener('keydown', popinKeyHandler, true);
      popinKeyHandler = null;
    }
    if (popinEl) {
      popinEl.remove();
      popinEl = null;
    }
  }

  // Clean up a popin left over from a mod hot reload
  if (typeof document !== 'undefined') {
    if (typeof window.__missionsGeoPopinCleanup === 'function') {
      try {
        window.__missionsGeoPopinCleanup();
      } catch (e) {
        // previous instance already cleaned up
      }
    }
    const stale = document.getElementById(POPIN_ID);
    if (stale) stale.remove();
    window.__missionsGeoPopinCleanup = removePopinElement;
  }

  function popinPalette() {
    let theme = 'dark';
    try {
      theme = api.ui.getResolvedTheme();
    } catch (e) {
      // theme unavailable: default to dark
    }
    return theme === 'light'
      ? { bg: '#ffffff', fg: '#111827', muted: '#6b7280', border: '#e5e7eb', accent: '#16a34a', btnBg: '#111827', btnFg: '#ffffff' }
      : { bg: '#18181b', fg: '#fafafa', muted: '#a1a1aa', border: '#3f3f46', accent: '#22c55e', btnBg: '#fafafa', btnFg: '#18181b' };
  }

  function el(tag, styles, text) {
    const node = document.createElement(tag);
    if (styles) Object.assign(node.style, styles);
    if (text != null) node.textContent = text;
    return node;
  }

  function toastCompletion(entry) {
    api.ui.showNotification(
      `${entry.title} completed! +${fmtMoney(entry.reward)}`,
      'success',
      NOTIF_TITLE
    );
  }

  function closePopin() {
    removePopinElement();
    showNextPopin();
  }

  function renderPopin(entry, remaining) {
    const c = popinPalette();

    const overlay = el('div', {
      position: 'fixed', top: '0', right: '0', bottom: '0', left: '0',
      zIndex: '2147483000', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.55)', opacity: '0', transition: 'opacity 180ms ease',
    });
    overlay.id = POPIN_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Mission completed');

    const card = el('div', {
      background: c.bg, color: c.fg, border: `1px solid ${c.border}`, borderRadius: '14px',
      padding: '24px 28px', width: 'min(380px, 90vw)', textAlign: 'center',
      boxShadow: '0 20px 60px rgba(0,0,0,0.45)', fontFamily: 'inherit',
      transform: 'scale(0.94)', transition: 'transform 180ms ease',
    });

    card.append(
      el('div', { fontSize: '40px', lineHeight: '1', marginBottom: '8px' }, '🏆'),
      el('div', {
        color: c.accent, fontSize: '12px', fontWeight: '700',
        letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '6px',
      }, entry.day ? `Mission completed · day ${entry.day}` : 'Mission completed'),
      el('div', { fontSize: '20px', fontWeight: '700', marginBottom: '6px' }, entry.title),
      el('div', { color: c.muted, fontSize: '14px', marginBottom: '14px' }, entry.description),
      el('div', {
        color: c.accent, fontSize: '18px', fontWeight: '700',
        marginBottom: remaining > 0 ? '6px' : '18px',
      }, `+${fmtMoney(entry.reward)}`)
    );

    if (remaining > 0) {
      card.append(el('div', { color: c.muted, fontSize: '12px', marginBottom: '14px' },
        `${remaining} more mission${remaining > 1 ? 's' : ''} completed`));
    }

    const btn = el('button', {
      background: c.btnBg, color: c.btnFg, border: 'none', borderRadius: '8px',
      padding: '8px 20px', fontSize: '14px', fontWeight: '600', cursor: 'pointer',
    }, remaining > 0 ? 'Next' : 'Awesome!');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (popinEl === overlay) closePopin();
    });
    card.append(btn);
    overlay.append(card);

    // Click outside the card, Escape or Enter: close
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay && popinEl === overlay) closePopin();
    });
    popinKeyHandler = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        closePopin();
      }
    };
    document.addEventListener('keydown', popinKeyHandler, true);

    document.body.appendChild(overlay);
    popinEl = overlay;

    (window.requestAnimationFrame || ((f) => setTimeout(f, 16)))(() => {
      overlay.style.opacity = '1';
      card.style.transform = 'scale(1)';
    });
    btn.focus();
  }

  function showNextPopin() {
    if (popinEl) return;
    const entry = popinQueue.shift();
    if (!entry) return;
    try {
      renderPopin(entry, popinQueue.length);
    } catch (e) {
      console.error(TAG, 'Popin failed, falling back to a notification:', e);
      removePopinElement();
      toastCompletion(entry);
      showNextPopin();
    }
  }

  function announceCompletion(mission, reward) {
    const entry = {
      title: mission.title,
      description: mission.description,
      reward,
      day: completed[mission.id],
    };
    if (typeof document === 'undefined' || !document.body) {
      toastCompletion(entry);
      return;
    }
    popinQueue.push(entry);
    // Deferred by an instant: gives every mission completed in the same
    // evaluation time to enter the queue before the first one is shown
    Promise.resolve().then(showNextPopin);
  }

  // ===========================================================================
  // 3c. MAP HIGHLIGHT: show a mission's zones on the map when it is clicked
  //
  // Uses the documented map API (registerSource / registerLayer, which survive
  // map style changes) and the MapLibre instance from utils.getMap(). Zone names
  // are drawn as small DOM labels positioned with map.project(), because text
  // layers depend on the map style's glyph/font setup.
  // ===========================================================================
  const ZONES_SOURCE = 'missions-geo-zones';
  const LINK_SOURCE = 'missions-geo-link';
  const ZONE_COLORS = { from: '#3b82f6', to: '#f97316', zone: '#22c55e' };
  const LINK_COLOR = '#a855f7';

  // These two objects are mutated in place, so if the API re-adds the sources
  // after a style reload they come back with the current selection.
  const zonesData = { type: 'FeatureCollection', features: [] };
  const linkData = { type: 'FeatureCollection', features: [] };

  let mapApiRegistered = false;
  let styleHandlerMap = null;
  let selectedMissionId = null;
  let labelHost = null;
  let labelEls = [];
  let labelMap = null;

  function getMapInstance() {
    try {
      return (api.utils.getMap && api.utils.getMap()) || mapRef || null;
    } catch (e) {
      return null;
    }
  }

  function boxPolygon(box) {
    const [w, s, e, n] = box;
    return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
  }

  function boxCenter(box) {
    return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  }

  // Push the current data into the map's sources. A source can be missing for a
  // moment (right after registering, or while the style reloads): retry briefly.
  function pushData(map, attempt) {
    const tries = attempt || 0;
    const zs = map.getSource && map.getSource(ZONES_SOURCE);
    const ls = map.getSource && map.getSource(LINK_SOURCE);
    if (zs && ls) {
      zs.setData(zonesData);
      ls.setData(linkData);
      return;
    }
    if (tries < 20) {
      setTimeout(() => pushData(map, tries + 1), 50);
    } else {
      console.warn(TAG, 'Zone sources not found on the map: the highlight cannot be drawn.');
    }
  }

  function onStyleLoad() {
    const map = styleHandlerMap;
    if (map && selectedMissionId) pushData(map);
  }

  function ensureMapLayers(map) {
    if (mapApiRegistered) return;
    api.map.registerSource(ZONES_SOURCE, { type: 'geojson', data: zonesData });
    api.map.registerSource(LINK_SOURCE, { type: 'geojson', data: linkData });
    api.map.registerLayer({
      id: 'missions-geo-fill',
      type: 'fill',
      source: ZONES_SOURCE,
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 },
    });
    api.map.registerLayer({
      id: 'missions-geo-outline',
      type: 'line',
      source: ZONES_SOURCE,
      paint: { 'line-color': ['get', 'color'], 'line-width': 2.5 },
    });
    api.map.registerLayer({
      id: 'missions-geo-link',
      type: 'line',
      source: LINK_SOURCE,
      paint: { 'line-color': LINK_COLOR, 'line-width': 2.5, 'line-dasharray': [2, 2] },
    });
    mapApiRegistered = true;

    // After a full style reload, re-push the current selection
    if (typeof map.on === 'function') {
      map.on('style.load', onStyleLoad);
      styleHandlerMap = map;
    }
  }

  // --- Zone name labels (DOM, positioned with map.project) -------------------
  function placeLabels() {
    if (!labelMap) return;
    for (const item of labelEls) {
      const pt = labelMap.project(item.center);
      item.el.style.left = `${pt.x}px`;
      item.el.style.top = `${pt.y}px`;
    }
  }

  function clearLabels() {
    if (labelMap && typeof labelMap.off === 'function') {
      try {
        labelMap.off('move', placeLabels);
      } catch (e) {
        // map already gone
      }
    }
    labelMap = null;
    if (labelHost) {
      labelHost.remove();
      labelHost = null;
    }
    labelEls = [];
  }

  function showLabels(map, zones) {
    clearLabels();
    if (typeof document === 'undefined' || typeof map.getContainer !== 'function') return;
    const container = map.getContainer();
    if (!container) return;

    labelHost = document.createElement('div');
    Object.assign(labelHost.style, {
      position: 'absolute', top: '0', right: '0', bottom: '0', left: '0',
      pointerEvents: 'none', overflow: 'hidden', zIndex: '5',
    });
    labelHost.id = 'missions-geo-labels';

    for (const z of zones) {
      const el = document.createElement('div');
      el.textContent = z.name;
      Object.assign(el.style, {
        position: 'absolute', transform: 'translate(-50%, -50%)', whiteSpace: 'nowrap',
        background: 'rgba(15,23,42,0.88)', color: '#ffffff', fontSize: '11px', lineHeight: '1.2',
        fontWeight: '600', fontFamily: 'system-ui, sans-serif', padding: '3px 8px', borderRadius: '999px',
        boxShadow: '0 2px 6px rgba(0,0,0,0.35)',
      });
      labelHost.appendChild(el);
      labelEls.push({ el, center: boxCenter(z.box) });
    }
    container.appendChild(labelHost);

    labelMap = map;
    map.on('move', placeLabels);
    placeLabels();
  }

  function fitToZones(map, zones) {
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    for (const z of zones) {
      w = Math.min(w, z.box[0]);
      s = Math.min(s, z.box[1]);
      e = Math.max(e, z.box[2]);
      n = Math.max(n, z.box[3]);
    }
    try {
      map.fitBounds([[w, s], [e, n]], { padding: 100, maxZoom: 13.5, duration: 800 });
    } catch (err) {
      console.warn(TAG, 'fitBounds failed:', err);
    }
  }

  function clearSelection() {
    selectedMissionId = null;
    zonesData.features.length = 0;
    linkData.features.length = 0;
    clearLabels();
    const map = getMapInstance();
    if (map && mapApiRegistered) pushData(map);
  }

  // Click a mission: show its zones. Click it again: hide them.
  function selectMission(m) {
    if (!m || !m.zones || m.zones.length === 0) return false;
    if (selectedMissionId === m.id) {
      clearSelection();
      return true;
    }

    const map = getMapInstance();
    if (!map) {
      api.ui.showNotification('The map is not ready yet.', 'warning', NOTIF_TITLE);
      return false;
    }
    try {
      ensureMapLayers(map);
    } catch (e) {
      console.error(TAG, 'Could not register the map layers:', e);
      api.ui.showNotification('Could not draw the zones on the map.', 'error', NOTIF_TITLE);
      return false;
    }

    selectedMissionId = m.id;
    zonesData.features.length = 0;
    linkData.features.length = 0;
    for (const z of m.zones) {
      zonesData.features.push({
        type: 'Feature',
        properties: { name: z.name, color: ZONE_COLORS[z.role] || ZONE_COLORS.zone },
        geometry: boxPolygon(z.box),
      });
    }
    if (m.link && m.zones.length >= 2) {
      linkData.features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [boxCenter(m.zones[0].box), boxCenter(m.zones[1].box)] },
      });
    }

    pushData(map);
    showLabels(map, m.zones);
    fitToZones(map, m.zones);
    return true;
  }

  // Clean up after a mod hot reload (labels and map listeners of the old instance)
  if (typeof window.__missionsGeoMapCleanup === 'function') {
    try {
      window.__missionsGeoMapCleanup();
    } catch (e) {
      // previous instance already cleaned up
    }
  }
  window.__missionsGeoMapCleanup = () => {
    clearLabels();
    if (styleHandlerMap && typeof styleHandlerMap.off === 'function') {
      try {
        styleHandlerMap.off('style.load', onStyleLoad);
      } catch (e) {
        // map already gone
      }
    }
  };

  // ===========================================================================
  // 4. EVALUATION
  // ===========================================================================
  function evaluate() {
    if (!loaded) return;
    trackServiceDay();
    let changed = false;

    for (const mission of getMissions()) {
      if (completed[mission.id]) continue;

      let result;
      try {
        result = mission.measure();
      } catch (e) {
        console.error(TAG, `Error in mission ${mission.id}:`, e);
        continue;
      }

      if (result.value >= result.target) {
        completed[mission.id] = api.gameState.getCurrentDay();
        changed = true;
        const reward = rewardFor(mission);
        api.actions.addMoney(reward);
        console.log(TAG, `Mission completed: ${mission.id} (+${fmtMoney(reward)})`);
        announceCompletion(mission, reward);
      }
    }

    if (changed) saveState();
  }

  // ===========================================================================
  // 5. HOOKS: registered once, at the top level of the script
  // ===========================================================================
  api.hooks.onGameInit(() => {
    loadState();
  });

  api.hooks.onGameLoaded(() => {
    loadState();
  });

  api.hooks.onHourChange(() => {
    evaluate();
  });

  // Check shortly after the player builds something (the game updates its state
  // a moment after the event), even when the game is paused
  api.hooks.onStationBuilt(() => scheduleEvaluate());
  api.hooks.onRouteCreated(() => scheduleEvaluate());
  api.hooks.onPauseChanged(() => scheduleEvaluate());

  // Useful for filling in city codes and calibrating zones
  api.hooks.onCityLoad((cityCode) => {
    lastCityCode = cityCode;
    console.log(TAG, `City loaded: ${cityCode}`);
    clearSelection();
  });

  api.hooks.onGameEnd(() => {
    clearSelection();
  });

  api.hooks.onMapReady((map) => {
    mapRef = map;
  });

  // Debug: show the coordinates of the selected station
  let debugCoords = false;
  api.hooks.onStationSelected((station) => {
    if (!debugCoords || !station || !station.coords) return;
    const [lng, lat] = station.coords;
    const msg = `${station.name}: [${lng.toFixed(4)}, ${lat.toFixed(4)}]`;
    console.log(TAG, msg);
    api.ui.showNotification(msg, 'info', `${NOTIF_TITLE} (coordinates)`);
  });

  // After a hot reload in the middle of a game
  try {
    if (api.gameState.getGameSessionId()) loadState();
  } catch (e) {
    // No game in progress (main menu): nothing to do
  }

  // ===========================================================================
  // 6. INTERFACE: floating panel
  // ===========================================================================
  function renderMission(m, onSelect) {
    const isDone = Boolean(completed[m.id]);
    let r = { value: 0, target: 1, label: '' };
    try {
      r = m.measure();
    } catch (e) {
      // No game loaded: show 0
    }
    const pct = isDone
      ? 100
      : Math.min(100, Math.round((Math.max(0, r.value) / r.target) * 100));

    // A mission with zones is clickable: it shows/hides its zones on the map
    const clickable = Boolean(m.zones && m.zones.length > 0);
    const selected = clickable && selectedMissionId === m.id;
    const rowProps = { key: m.id, className: 'space-y-1 mb-3' };
    if (clickable) {
      Object.assign(rowProps, {
        role: 'button',
        tabIndex: 0,
        'aria-pressed': selected,
        title: selected ? 'Click to hide its zones from the map' : 'Click to show its zones on the map',
        onClick: () => onSelect && onSelect(m),
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (onSelect) onSelect(m);
          }
        },
        style: {
          cursor: 'pointer',
          borderRadius: 6,
          outline: selected ? '2px solid #3b82f6' : 'none',
          outlineOffset: 3,
        },
      });
    }

    return h('div', rowProps, [
      h('div', { key: 'top', className: 'flex items-center justify-between' }, [
        h('span', { key: 'name', className: 'font-medium text-sm' }, m.title),
        h(
          Badge,
          { key: 'badge', variant: isDone ? 'default' : 'secondary' },
          isDone ? 'Completed' : `+${fmtMoney(rewardFor(m))}`
        ),
      ]),
      h('p', { key: 'desc', className: 'text-xs text-muted-foreground' }, m.description),
      h(Progress, { key: 'bar', value: pct }),
      h(
        'p',
        { key: 'label', className: 'text-xs text-muted-foreground' },
        isDone ? `Completed on day ${completed[m.id]}` : r.label
      ),
      selected
        ? h('p', { key: 'onmap', className: 'text-xs', style: { color: '#3b82f6' } },
            '📍 Shown on the map · click to hide')
        : null,
    ]);
  }

  // --- Drawers (collapsible sections), state remembered between sessions -----
  const drawers = { general: true, region: true };
  Promise.resolve(storage.get('ui:drawers', null))
    .then((saved) => {
      if (saved && typeof saved === 'object') Object.assign(drawers, saved);
    })
    .catch(() => {});

  function renderDrawer(key, title, missions, onToggle, onSelect) {
    const isOpen = drawers[key] !== false;
    const done = missions.filter((m) => completed[m.id]).length;
    const allDone = missions.length > 0 && done === missions.length;
    const toggle = () => onToggle(key);

    return h('div', { key, className: 'mb-3 rounded-md border' }, [
      h(
        'div',
        {
          key: 'head',
          role: 'button',
          tabIndex: 0,
          'aria-expanded': isOpen,
          onClick: toggle,
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggle();
            }
          },
          className: 'flex items-center justify-between px-2 py-2 cursor-pointer select-none',
        },
        [
          h('span', { key: 'title', className: 'text-xs font-semibold uppercase' },
            `${isOpen ? '▾' : '▸'} ${title}`),
          h(Badge, { key: 'count', variant: allDone ? 'default' : 'secondary' },
            `${done} / ${missions.length}`),
        ]
      ),
      isOpen ? h('div', { key: 'body', className: 'px-2 pt-1' }, missions.map((m) => renderMission(m, onSelect))) : null,
    ]);
  }

  // Height reserved for the floating panel's title bar (adjustable)
  const PANEL_CHROME = 48;

  function MissionsPanel(props) {
    // Re-render every 2 s to refresh progress
    const [, setTick] = React.useState(0);
    React.useEffect(() => {
      const timer = setInterval(() => setTick((x) => x + 1), 2000);
      return () => clearInterval(timer);
    }, []);

    const toggleDrawer = (key) => {
      drawers[key] = !(drawers[key] !== false);
      setTick((x) => x + 1);
      Promise.resolve(storage.set('ui:drawers', drawers)).catch(() => {});
    };

    const onSelectMission = (m) => {
      selectMission(m);
      setTick((x) => x + 1);
    };

    const pack = detectPack();
    const all = pack ? BASE_MISSIONS.concat(pack.missions) : BASE_MISSIONS;
    const doneCount = all.filter((m) => completed[m.id]).length;

    const children = [
      h('p', { key: 'summary', className: 'text-sm mb-3' },
        `${doneCount} / ${all.length} missions completed`),
      renderDrawer('general', 'General Missions', BASE_MISSIONS, toggleDrawer, onSelectMission),
    ];

    if (pack) {
      children.push(
        h('p', { key: 'hint', className: 'text-xs text-muted-foreground mb-2' },
          'Tip: click a mission to show its zones on the map.'),
        renderDrawer('region', `Missions: ${pack.name}`, pack.missions, toggleDrawer, onSelectMission)
      );
    } else {
      children.push(
        h(
          'p',
          { key: 'no-pack', className: 'text-xs text-muted-foreground mt-2' },
          `City not recognized${lastCityCode ? ` (${lastCityCode})` : ''}: place a first station, ` +
            'or add a zone pack for this city in index.js.'
        )
      );
    }

    // The panel provides its height: use it to enable scrolling
    const height = props && props.height;
    return h(
      'div',
      {
        style: {
          height: height ? `${Math.max(120, height - PANEL_CHROME)}px` : '100%',
          overflowY: 'auto',
          boxSizing: 'border-box',
          padding: 8,
        },
        onWheel: (e) => e.stopPropagation(),
      },
      children
    );
  }

  // Panel icon: a book (story). The docs only guarantee a "curated" set of
  // Lucide icons, so we take the first available book icon.
  function pickPanelIcon() {
    const available = (api.utils && api.utils.icons) || {};
    const candidates = ['BookOpen', 'Book', 'BookMarked', 'BookText', 'Library', 'ScrollText'];
    const found = candidates.find((name) => Boolean(available[name]));
    if (found) {
      console.log(TAG, `Panel icon: ${found}`);
      return found;
    }
    console.warn(TAG, 'No book icon available, falling back to Train. Game icons:', Object.keys(available));
    return 'Train';
  }

  api.ui.addFloatingPanel({
    id: 'missions-geo-panel',
    icon: pickPanelIcon(),
    tooltip: 'Missions',
    title: NOTIF_TITLE,
    defaultWidth: 340,
    defaultHeight: 520,
    minWidth: 260,
    minHeight: 240,
    render: MissionsPanel,
  });

  // Settings
  api.ui.addToggle('settings-menu', {
    id: 'missions-geo-debug-coords',
    label: 'Missions: show station coordinates (debug)',
    defaultValue: false,
    onChange: (enabled) => {
      debugCoords = Boolean(enabled);
    },
  });

  // Rewards will be granted again as soon as the conditions are met again
  api.ui.addButton('settings-menu', {
    id: 'missions-geo-reset',
    label: 'Missions: reset (debug)',
    onClick: async () => {
      completed = {};
      await saveState();
      api.ui.showNotification('Missions reset.', 'info', NOTIF_TITLE);
    },
  });

  // ===========================================================================
  // 7. REAL-TIME CHECK + DIAGNOSTIC
  //
  // evaluate() used to run only on onHourChange: once per in-game hour, and
  // never while the game is paused (which is when most building happens). It now
  // also runs every 2 s of real time and 0.3 s after a station/route is built.
  // It also (re)loads the saved progress if that has not happened yet.
  // ===========================================================================
  const EVALUATE_INTERVAL_MS = 2000;
  let soonTimer = null;

  function hasSession() {
    try {
      return Boolean(api.gameState.getGameSessionId());
    } catch (e) {
      return false;
    }
  }

  function safeEvaluate() {
    try {
      if (!loaded && !loading && hasSession()) loadState();
      evaluate();
    } catch (e) {
      console.error(TAG, 'Evaluation error:', e);
    }
  }

  function scheduleEvaluate() {
    clearTimeout(soonTimer);
    soonTimer = setTimeout(safeEvaluate, 300);
  }

  // A mod hot reload must not leave the previous instance's timer running
  // (two instances would both pay the same reward)
  if (window.__missionsGeoTimer) clearInterval(window.__missionsGeoTimer);
  window.__missionsGeoTimer = setInterval(safeEvaluate, EVALUATE_INTERVAL_MS);

  // Console diagnostic: window.__missionsGeoStatus()
  window.__missionsGeoStatus = () => {
    const rows = getMissions().map((m) => {
      let r;
      try {
        r = m.measure();
      } catch (e) {
        r = { value: 'error', target: '', label: String(e) };
      }
      return {
        id: m.id,
        done: completed[m.id] ? `day ${completed[m.id]}` : '',
        value: typeof r.value === 'number' ? Math.round(r.value * 100) / 100 : r.value,
        target: r.target,
        label: r.label,
      };
    });
    const pack = detectPack();
    console.log(TAG, { loaded, loading, runId, city: lastCityCode, pack: pack ? pack.id : null });
    console.table(rows);
    return rows;
  };

  console.log(TAG, 'Loaded!');
})();