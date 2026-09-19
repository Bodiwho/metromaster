// TMB Metro Master
(() => {
    'use strict';

    // --- Configuration ---
    const ARRIVALS_URL = 'https://api.tmb.cat/v1/itransit/metro/estacions';
    const SCHEDULE_URL = 'https://api.tmb.cat/v1/transit/core/horaris/';
    // Tried in order. If TMB rejects a pair (401/403/429) the next one is used.
    const CREDENTIALS = [
        { id: '00ebfbd8', key: '106da0e97d453028e6751b44e675f208' },
        { id: '4c132798', key: 'a828910cef5a0376607986191db19d14' }
    ];
    const STATIONS_CSV_PATH = 'estacions_linia.csv';
    const AUTO_REFRESH_INTERVAL = 120 * 1000; // same as v2; countdowns tick locally in between
    const RETRY_INTERVAL = 30 * 1000;
    const STALE_AFTER = 30 * 1000;          // refetch when coming back to the app after this long
    const SCHEDULE_CACHE_TTL = 30 * 60 * 1000;
    const TRAINS_PER_DIRECTION = 2;
    const NOW_WINDOW = 15 * 1000;           // show "Now" when a train is this close
    const DEPARTED_AFTER = 20 * 1000;       // drop a train this long after its arrival time
    const TIME_ZONE = 'Europe/Madrid';
    const LANGUAGES = ['en', 'es', 'ca', 'zh'];
    const MAX_RECENT = 5;
    const MAX_FAVORITE_LINKS = 12;
    const KEYS = {
        favorites: 'metromaster.favorites',
        recent: 'metromaster.recent',
        lang: 'metromaster.lang',
        compact: 'metromaster.compact',
        session: 'metromaster.session'
    };

    const ICONS = {
        handle: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14M5 12h14M5 16h14"/></svg>',
        remove: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 12h7"/></svg>',
        location: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4 4 11l7 2 2 7z"/></svg>'
    };

    // --- Storage (can be unavailable in private modes, so every access is guarded) ---
    function openStorage(name) {
        try {
            const store = window[name];
            store.setItem('__probe__', '1');
            store.removeItem('__probe__');
            return store;
        } catch {
            return null;
        }
    }
    const local = openStorage('localStorage');
    const session = openStorage('sessionStorage');

    function readJSON(store, key, fallback) {
        try {
            const raw = store && store.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch {
            return fallback;
        }
    }

    function writeJSON(store, key, value) {
        try {
            if (store) store.setItem(key, JSON.stringify(value));
        } catch {
            // Storage full or blocked: the URL still carries the important state.
        }
    }

    // --- DOM ---
    const $ = (id) => document.getElementById(id);
    const el = {
        searchOpen: $('search-open'),
        favorites: $('favorites'),
        favoritesEdit: $('favorites-edit'),
        favoriteChips: $('favorite-chips'),
        station: $('station'),
        stationName: $('station-name'),
        favoriteToggle: $('favorite-toggle'),
        shareBtn: $('share-btn'),
        status: $('status'),
        refreshBtn: $('refresh-btn'),
        densityBtn: $('density-btn'),
        lineFilters: $('line-filters'),
        results: $('results'),
        home: $('home'),
        homeNearby: $('home-nearby'),
        homeHint: $('home-hint'),
        homeRecent: $('home-recent'),
        pageError: $('page-error'),
        languages: $('languages'),
        searchDialog: $('search-dialog'),
        searchInput: $('search-input'),
        searchCancel: $('search-cancel'),
        searchResults: $('search-results'),
        favoritesDialog: $('favorites-dialog'),
        favoritesDone: $('favorites-done'),
        editList: $('favorites-edit-list'),
        toasts: $('toasts')
    };

    // --- State ---
    const state = {
        stations: [],
        bySlug: new Map(),
        lineColors: new Map(),
        lang: 'en',
        compact: false,
        favorites: [],
        favoritesSeed: '',
        station: null,
        board: null,
        updatedAt: 0,
        loading: false,
        failed: false,
        filter: null,
        nearby: null
    };

    const queryParams = new URLSearchParams(location.search);
    let basePath = location.pathname;
    let refreshTimer = null;
    let tickTimer = null;
    let loadController = null;
    let loadToken = 0;
    let credentialIndex = 0;
    const scheduleCache = new Map();
    const renderedTimes = new WeakMap();

    // --- Utilities ---
    function escapeHTML(value) {
        return String(value).replace(/[&<>"']/g, (ch) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
        ));
    }

    /**
     * Converts a station name to its URL slug.
     * Must stay exactly as it is: saved links and home-screen shortcuts depend on it.
     */
    function stationNameToSlug(stationName) {
        return stationName
            .toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    function foldText(text) {
        return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    }

    /** Sorts line names numerically: L1, L2 … L9N, L9S, L10N, L10S, L11, FM. */
    function sortLinesNumerically(a, b) {
        const number = (name) => {
            const match = name.match(/L(\d+)/);
            return match ? parseInt(match[1], 10) : 9999;
        };
        const suffix = (name) => {
            const match = name.match(/L\d+(.*)/);
            return match ? match[1] : name;
        };
        return number(a) - number(b) || suffix(a).localeCompare(suffix(b));
    }

    function lineColor(lineName) {
        const hex = state.lineColors.get(lineName);
        return hex && /^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : '#7a7f87';
    }

    function badgeHTML(lineName, small = false) {
        return `<span class="badge${small ? ' badge--small' : ''}" style="--line:${lineColor(lineName)}">${escapeHTML(lineName)}</span>`;
    }

    let clockFormatter = null;
    function formatClock(timestamp) {
        if (!clockFormatter) {
            const options = { hour: '2-digit', minute: '2-digit', hour12: false };
            try {
                clockFormatter = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: TIME_ZONE });
            } catch {
                clockFormatter = new Intl.DateTimeFormat('en-GB', options);
            }
        }
        return clockFormatter.format(timestamp);
    }

    function formatDistance(meters) {
        if (meters < 1000) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
        const km = new Intl.NumberFormat(state.lang, { maximumFractionDigits: 1 }).format(meters / 1000);
        return `${km} km`;
    }

    function distanceBetween(lat1, lon1, lat2, lon2) {
        const toRad = (deg) => deg * Math.PI / 180;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
        return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // --- Translations ---
    function t(key, vars) {
        const dictionary = translations[state.lang] || translations.en;
        let text = dictionary[key] ?? translations.en[key] ?? key;
        if (vars) text = text.replace(/\{(\w+)\}/g, (_, name) => (vars[name] ?? ''));
        return text;
    }

    function detectLanguage() {
        const fromUrl = queryParams.get('lang');
        if (LANGUAGES.includes(fromUrl)) return fromUrl;
        const saved = readJSON(local, KEYS.lang, null);
        if (LANGUAGES.includes(saved)) return saved;
        const preferred = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
        for (const tag of preferred) {
            const base = String(tag).toLowerCase().split('-')[0];
            if (LANGUAGES.includes(base)) return base;
            if (base === 'gl' || base === 'eu') return 'es';
        }
        return 'en';
    }

    function applyTranslations() {
        document.documentElement.lang = state.lang;
        document.querySelectorAll('[data-i18n]').forEach((node) => {
            node.textContent = t(node.dataset.i18n);
        });
        document.querySelectorAll('[data-i18n-label]').forEach((node) => {
            const label = t(node.dataset.i18nLabel);
            node.setAttribute('aria-label', label);
            if (node.classList.contains('icon-btn')) node.title = label;
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
            node.placeholder = t(node.dataset.i18nPlaceholder);
        });
        el.languages.querySelectorAll('button').forEach((button) => {
            button.setAttribute('aria-pressed', String(button.dataset.lang === state.lang));
        });
    }

    function setLanguage(lang) {
        if (!LANGUAGES.includes(lang) || lang === state.lang) return;
        state.lang = lang;
        writeJSON(local, KEYS.lang, lang);
        queryParams.set('lang', lang);
        writeURL();
        applyTranslations();
        renderAll();
        if (openSheet === el.searchDialog) renderSearch();
    }

    // --- URL ---
    // Format (unchanged from earlier versions, so saved links keep working):
    //   /?lang=es&compact=true#station-slug&favorites=slug-1,slug-2
    function readHash() {
        let raw = location.hash.replace(/^#/, '');
        try {
            raw = decodeURIComponent(raw);
        } catch {
            // Keep the raw value if it is not valid percent-encoding.
        }
        let station = null;
        let favorites = null;
        raw.split('&').forEach((part) => {
            if (!part) return;
            if (part.startsWith('favorites=')) {
                favorites = part.slice('favorites='.length).split(',').map((slug) => slug.trim()).filter(Boolean);
            } else if (!part.includes('=') && station === null) {
                station = part;
            }
        });
        return { station, favorites };
    }

    /** Supports the older path-style links (/station-slug or /index.html/station-slug). */
    function readPathStation() {
        const path = location.pathname;
        const marker = path.indexOf('/index.html/');
        if (marker !== -1) basePath = path.slice(0, marker + 1);
        const tail = marker !== -1 ? path.slice(marker + '/index.html'.length) : path;
        const segments = tail.split('/').filter(Boolean);
        const last = segments[segments.length - 1];
        if (!last || /\.html?$/i.test(last)) return null;
        const station = resolveSlug(last, true);
        if (station && marker === -1) basePath = path.slice(0, path.lastIndexOf(last));
        return station;
    }

    function writeURL() {
        const hashParts = [];
        if (state.station) hashParts.push(state.station.slug);
        if (state.favorites.length) hashParts.push(`favorites=${state.favorites.join(',')}`);
        const query = queryParams.toString();
        const hash = hashParts.join('&');
        const url = `${basePath}${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`;
        if (url !== `${location.pathname}${location.search}${location.hash}`) {
            try {
                history.replaceState(history.state, '', url);
            } catch {
                // Some embedded browsers refuse replaceState; the app still works without it.
            }
        }
        writeJSON(session, KEYS.session, { seed: state.favoritesSeed, written: state.favorites.join(',') });
        document.title = state.station ? `${state.station.name} - ${t('title')}` : t('title');
    }

    function resolveSlug(slug, exactOnly = false) {
        if (!slug) return null;
        const wanted = slug.toLowerCase();
        const exact = state.bySlug.get(wanted);
        if (exact || exactOnly) return exact || null;
        return state.stations.find((station) => station.slug.includes(wanted) || wanted.includes(station.slug)) || null;
    }

    // --- Favorites ---
    // Favorites travel in the page link, so a home-screen shortcut carries them. They are also
    // saved on the device per launch link: changes made after opening a link are shown the next
    // time that same link is opened, instead of the list that was frozen into it.
    function sanitizeSlugs(list) {
        if (!Array.isArray(list)) return [];
        const seen = new Set();
        return list.filter((slug) => {
            if (typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug) || seen.has(slug)) return false;
            seen.add(slug);
            return true;
        }).slice(0, 40);
    }

    function initFavorites(urlFavorites) {
        const urlValue = urlFavorites ? urlFavorites.join(',') : '';
        const sessionInfo = readJSON(session, KEYS.session, null);
        // Reloading a URL this tab wrote itself keeps the link it was launched from.
        const seed = sessionInfo && typeof sessionInfo.seed === 'string' && sessionInfo.written === urlValue
            ? sessionInfo.seed
            : urlValue;
        const saved = readJSON(local, KEYS.favorites, {}) || {};
        let list;
        if (saved[seed]) {
            list = saved[seed].list;
        } else if (seed) {
            list = urlFavorites;
        } else {
            // Plain link without favorites: show the most recently edited list on this device.
            const latest = Object.values(saved).sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
            list = latest ? latest.list : [];
        }
        state.favoritesSeed = seed;
        state.favorites = sanitizeSlugs(list);
    }

    function saveFavorites() {
        const saved = readJSON(local, KEYS.favorites, {}) || {};
        saved[state.favoritesSeed] = { list: state.favorites, ts: Date.now() };
        const kept = Object.entries(saved)
            .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0))
            .slice(0, MAX_FAVORITE_LINKS);
        writeJSON(local, KEYS.favorites, Object.fromEntries(kept));
        writeURL();
    }

    function setFavorites(list) {
        state.favorites = sanitizeSlugs(list);
        saveFavorites();
        renderFavorites();
        renderStationHeader();
        if (openSheet === el.favoritesDialog) renderEditList();
    }

    function toggleFavorite() {
        if (!state.station) return;
        const slug = state.station.slug;
        const previous = [...state.favorites];
        if (previous.includes(slug)) {
            setFavorites(previous.filter((item) => item !== slug));
            toast(t('removedFromFavorites'), { action: t('undo'), onAction: () => setFavorites(previous) });
        } else {
            setFavorites([...previous, slug]);
            toast(t('addedToFavorites'));
        }
    }

    function removeFavorite(slug) {
        const previous = [...state.favorites];
        setFavorites(previous.filter((item) => item !== slug));
        toast(t('removedFromFavorites'), { action: t('undo'), onAction: () => setFavorites(previous) });
    }

    /** Applies a new order for the visible favorites; unresolvable ones keep their place at the end. */
    function applyFavoriteOrder(order) {
        setFavorites([...order, ...state.favorites.filter((slug) => !order.includes(slug))]);
    }

    function favoriteStations() {
        const seen = new Set();
        return state.favorites
            .map((slug) => resolveSlug(slug, true))
            .filter((station) => station && !seen.has(station) && seen.add(station));
    }

    // --- Recent stations ---
    function pushRecent(slug) {
        const recent = readJSON(local, KEYS.recent, []);
        const list = (Array.isArray(recent) ? recent : []).filter((item) => item !== slug);
        list.unshift(slug);
        writeJSON(local, KEYS.recent, list.slice(0, MAX_RECENT));
    }

    function recentStations() {
        const recent = readJSON(local, KEYS.recent, []);
        return (Array.isArray(recent) ? recent : []).map((slug) => resolveSlug(slug, true)).filter(Boolean);
    }

    // --- Stations ---
    /** CSV line parser that handles quoted fields containing commas. */
    function parseCsvLine(line) {
        const columns = [];
        let current = '';
        let inQuote = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                inQuote = !inQuote;
            } else if (char === ',' && !inQuote) {
                columns.push(current);
                current = '';
            } else {
                current += char;
            }
        }
        columns.push(current);
        return columns;
    }

    /** Builds a folded search string plus a map back to positions in the original name. */
    function buildSearchIndex(name) {
        let text = '';
        const map = [];
        for (let i = 0; i < name.length; i++) {
            for (const ch of foldText(name[i])) {
                if (/[a-z0-9]/.test(ch)) {
                    text += ch;
                    map.push(i);
                } else if (text && !text.endsWith(' ')) {
                    text += ' ';
                    map.push(i);
                }
            }
        }
        if (text.endsWith(' ')) {
            text = text.slice(0, -1);
            map.pop();
        }
        return { text, map };
    }

    async function loadStations() {
        const response = await fetch(STATIONS_CSV_PATH);
        if (!response.ok) throw new Error(`Could not load the stations file: ${response.status}`);
        const rows = (await response.text()).split(/\r?\n/);
        const header = parseCsvLine(rows[0] || '').map((name) => name.trim().replace(/^﻿/, ''));
        const column = (name, fallback) => {
            const index = header.indexOf(name);
            return index === -1 ? fallback : index;
        };
        const COL = {
            code: column('CODI_ESTACIO', 6),
            name: column('NOM_ESTACIO', 7),
            line: column('NOM_LINIA', 11),
            color: column('COLOR_LINIA', 23),
            geometry: column('GEOMETRY', 26)
        };

        const byName = new Map();
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i].trim();
            if (!row) continue;
            const cols = parseCsvLine(row);
            const name = (cols[COL.name] || '').trim();
            const code = (cols[COL.code] || '').trim();
            const lineName = (cols[COL.line] || '').trim();
            if (!name || !code || !lineName) continue;

            const color = (cols[COL.color] || '').trim();
            if (color) state.lineColors.set(lineName, color);

            let station = byName.get(name);
            if (!station) {
                station = { name, slug: stationNameToSlug(name), lines: [], codes: [], codesByLine: {}, points: [] };
                byName.set(name, station);
            }
            if (!station.lines.includes(lineName)) station.lines.push(lineName);
            if (!station.codes.includes(code)) station.codes.push(code);
            const lineCodes = station.codesByLine[lineName] || (station.codesByLine[lineName] = []);
            if (!lineCodes.includes(code)) lineCodes.push(code);

            const point = /POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(cols[COL.geometry] || '');
            if (point) station.points.push([parseFloat(point[2]), parseFloat(point[1])]);
        }

        // Same ordering as earlier versions, so partial slug matches resolve identically.
        state.stations = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
        state.stations.forEach((station) => {
            station.lines.sort(sortLinesNumerically);
            if (station.points.length) {
                station.lat = station.points.reduce((sum, p) => sum + p[0], 0) / station.points.length;
                station.lon = station.points.reduce((sum, p) => sum + p[1], 0) / station.points.length;
            }
            delete station.points;
            station.index = buildSearchIndex(station.name);
            station.compact = station.index.text.replace(/ /g, '');
            // Catalan "l·l" is often typed as a single "l" (Paral·lel → "paralel").
            station.simple = foldText(station.name).replace(/l[·.]l/g, 'l').replace(/[^a-z0-9]/g, '');
            if (!state.bySlug.has(station.slug)) state.bySlug.set(station.slug, station);
        });
    }

    // --- TMB API ---
    async function tmbFetch(url, params, signal) {
        let lastError = null;
        for (let attempt = 0; attempt < CREDENTIALS.length; attempt++) {
            const index = (credentialIndex + attempt) % CREDENTIALS.length;
            const { id, key } = CREDENTIALS[index];
            const query = new URLSearchParams({ ...params, app_id: id, app_key: key });
            const response = await fetch(`${url}?${query}`, { signal });
            if (response.ok) {
                credentialIndex = index;
                return response.json();
            }
            lastError = new Error(`TMB API responded with ${response.status}`);
            if (![401, 403, 429].includes(response.status)) break;
        }
        throw lastError;
    }

    async function fetchSchedule(code, signal) {
        const cached = scheduleCache.get(code);
        if (cached && Date.now() - cached.at < SCHEDULE_CACHE_TTL) return cached.data;
        const data = await tmbFetch(SCHEDULE_URL, {
            transit_namespace: 'metro',
            transit_namespace_element: 'metro',
            codi_element: code
        }, signal);
        scheduleCache.set(code, { at: Date.now(), data });
        return data;
    }

    // --- Arrivals board ---
    // Board: Map<lineName, { name, directions: Map<destination, { destination, order, trains, list }> }>
    function addTrains(board, station, lineName, color, destination, order, trains) {
        // Trains whose destination is this station terminate here; nobody boards them.
        if (stationNameToSlug(destination) === station.slug) return;
        if (color && /^[0-9a-f]{6}$/i.test(color)) state.lineColors.set(lineName, color);

        let line = board.get(lineName);
        if (!line) {
            line = { name: lineName, directions: new Map() };
            board.set(lineName, line);
        }
        let direction = line.directions.get(destination);
        if (!direction) {
            direction = { destination, order: Number(order) || 9, trains: new Map(), list: [] };
            line.directions.set(destination, direction);
        }
        trains.forEach((train) => {
            const known = direction.trains.get(train.at);
            // A live estimate for the same moment wins over a timetable entry.
            direction.trains.set(train.at, known === false ? false : train.scheduled);
        });
    }

    function addArrivals(board, station, data) {
        (data && data.linies || []).forEach((line) => {
            (line.estacions || []).forEach((platform) => {
                (platform.linies_trajectes || []).forEach((route) => {
                    // Stations shared by L9 and L10 list every route under both lines, so the
                    // route's own line decides where it belongs (duplicates merge by time).
                    const lineName = route.nom_linia || line.nom_linia;
                    const destination = (route.desti_trajecte || '').trim();
                    if (!lineName || !destination) return;
                    const trains = (route.propers_trens || [])
                        .filter((train) => Number.isFinite(train.temps_arribada))
                        .map((train) => ({ at: train.temps_arribada, scheduled: train.temps_teoric === true }));
                    addTrains(board, station, lineName, route.color_linia || line.color_linia, destination, platform.id_sentit, trains);
                });
            });
        });
    }

    function serviceDayStart(day) {
        const parsed = Date.parse(day);
        if (Number.isFinite(parsed)) return parsed;
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        return midnight.getTime();
    }

    function addSchedule(board, station, lineName, data, now) {
        (data && data.features || []).forEach((feature) => {
            const props = feature.properties || {};
            if (props.NOM_LINIA !== lineName || !props.HORES_PAS || !props.DESTI_TRAJECTE) return;
            const dayStart = serviceDayStart(props.DIA);
            const trains = [];
            for (const value of props.HORES_PAS.split(',')) {
                const [hours, minutes, seconds = '0'] = value.trim().split(':');
                const offset = (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000;
                if (!Number.isFinite(offset)) continue;
                const at = dayStart + offset;
                if (at > now - DEPARTED_AFTER) trains.push({ at, scheduled: true });
                if (trains.length >= 6) break;
            }
            addTrains(board, station, lineName, null, props.DESTI_TRAJECTE.trim(), props.ID_SENTIT, trains);
        });
    }

    function hasUpcoming(line, now) {
        if (!line) return false;
        for (const direction of line.directions.values()) {
            for (const at of direction.trains.keys()) {
                if (at > now - DEPARTED_AFTER) return true;
            }
        }
        return false;
    }

    async function loadBoard(station, signal) {
        const board = new Map();
        const now = Date.now();
        let liveError = null;

        try {
            // One request covers every line at the station. temps_teoric=true is what makes
            // L9/L10 return times at all (they only publish timetable-based arrivals).
            const data = await tmbFetch(ARRIVALS_URL, { estacions: station.codes.join(','), temps_teoric: 'true' }, signal);
            addArrivals(board, station, data);
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            liveError = error;
        }

        // Lines without upcoming trains (e.g. the Montjuïc funicular) fall back to the timetable.
        const missing = station.lines.filter((lineName) => !hasUpcoming(board.get(lineName), now));
        if (missing.length) {
            const codes = [...new Set(missing.flatMap((lineName) => station.codesByLine[lineName] || []))];
            const schedules = await Promise.all(codes.map((code) => fetchSchedule(code, signal).catch((error) => {
                if (error.name === 'AbortError') throw error;
                return null;
            })));
            missing.forEach((lineName) => {
                schedules.forEach((data) => addSchedule(board, station, lineName, data, now));
            });
        }

        if (liveError && ![...board.values()].some((line) => hasUpcoming(line, now))) throw liveError;

        board.forEach((line) => {
            line.directions.forEach((direction) => {
                direction.list = [...direction.trains]
                    .map(([at, scheduled]) => ({ at, scheduled }))
                    .sort((a, b) => a.at - b.at);
            });
        });
        return board;
    }

    function upcomingTrains(direction, now) {
        return direction.list.filter((train) => train.at > now - DEPARTED_AFTER).slice(0, TRAINS_PER_DIRECTION);
    }

    // --- Loading & refreshing ---
    async function refresh() {
        const station = state.station;
        if (!station) return;
        clearTimeout(refreshTimer);
        if (loadController) loadController.abort();
        const controller = new AbortController();
        loadController = controller;
        const token = ++loadToken;
        state.loading = true;
        el.results.setAttribute('aria-busy', 'true');
        renderStatus();

        try {
            const board = await loadBoard(station, controller.signal);
            if (token !== loadToken) return;
            state.board = board;
            state.updatedAt = Date.now();
            state.failed = false;
            renderBoard();
        } catch (error) {
            if (error.name === 'AbortError' || token !== loadToken) return;
            state.failed = true;
            // Keep showing the last good data; only show an error when there is nothing to show.
            if (!state.board) renderBoard();
        } finally {
            if (token === loadToken) {
                state.loading = false;
                loadController = null;
                el.results.removeAttribute('aria-busy');
                renderStatus();
                scheduleRefresh();
            }
        }
    }

    function scheduleRefresh() {
        clearTimeout(refreshTimer);
        if (!state.station || document.hidden) return;
        refreshTimer = setTimeout(refresh, state.failed ? RETRY_INTERVAL : AUTO_REFRESH_INTERVAL);
    }

    function refreshIfStale() {
        if (state.station && !state.loading && Date.now() - state.updatedAt > STALE_AFTER) {
            refresh();
        } else {
            scheduleRefresh();
        }
    }

    /** Fetches as soon as the current data is old enough, without hammering the API. */
    function refreshSoon() {
        if (!state.station || state.loading || document.hidden) return;
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refresh, Math.max(0, state.updatedAt + STALE_AFTER - Date.now()));
    }

    function selectStation(station, { scrollToTop = false } = {}) {
        if (!station) return;
        if (station === state.station) {
            refreshIfStale();
            return;
        }
        if (loadController) loadController.abort();
        state.station = station;
        state.board = null;
        state.updatedAt = 0;
        state.failed = false;
        state.filter = null;
        pushRecent(station.slug);
        writeURL();
        renderAll();
        if (scrollToTop) window.scrollTo(0, 0);
        refresh();
    }

    // --- Rendering ---
    function renderAll() {
        renderFavorites();
        renderStationHeader();
        renderHome();
        if (state.station) renderBoard();
        renderStatus();
    }

    function renderFavorites() {
        const stations = favoriteStations();
        el.favorites.hidden = stations.length === 0;
        el.favoriteChips.innerHTML = stations.map((station) => `
            <li><button type="button" class="chip" data-slug="${station.slug}" aria-current="${station === state.station}">
                <span>${escapeHTML(station.name)}</span>
                <span class="chip-dots" aria-hidden="true">${station.lines.map((lineName) => `<i style="--line:${lineColor(lineName)}"></i>`).join('')}</span>
            </button></li>`).join('');
        keepCurrentChipVisible();
    }

    function keepCurrentChipVisible() {
        const chip = el.favoriteChips.querySelector('[aria-current="true"]');
        if (!chip) return;
        const scroller = el.favoriteChips.parentElement;
        const bounds = scroller.getBoundingClientRect();
        const rect = chip.getBoundingClientRect();
        if (rect.left < bounds.left + 16) scroller.scrollLeft -= bounds.left + 16 - rect.left;
        else if (rect.right > bounds.right - 16) scroller.scrollLeft += rect.right - (bounds.right - 16);
    }

    function renderStationHeader() {
        const station = state.station;
        el.station.hidden = !station;
        if (!station) return;
        el.stationName.textContent = station.name;
        const isFavorite = state.favorites.includes(station.slug);
        const label = isFavorite ? t('removeFromFavorites') : t('addToFavorites');
        el.favoriteToggle.classList.toggle('is-active', isFavorite);
        el.favoriteToggle.setAttribute('aria-label', label);
        el.favoriteToggle.title = label;
        el.densityBtn.setAttribute('aria-pressed', String(state.compact));
        renderFilters();
    }

    function renderFilters() {
        const lines = state.station ? state.station.lines : [];
        el.lineFilters.hidden = lines.length < 2;
        el.lineFilters.classList.toggle('is-filtered', Boolean(state.filter));
        if (lines.length < 2) {
            el.lineFilters.innerHTML = '';
            return;
        }
        el.lineFilters.innerHTML =
            `<button type="button" class="filter filter--all" data-filter="" aria-pressed="${!state.filter}" aria-label="${escapeHTML(t('showAll'))}">${escapeHTML(t('all'))}</button>` +
            lines.map((lineName) => `<button type="button" class="filter" data-filter="${escapeHTML(lineName)}" style="--line:${lineColor(lineName)}" aria-pressed="${state.filter === lineName}" aria-label="${escapeHTML(t('showOnly', { line: lineName }))}">${escapeHTML(lineName)}</button>`).join('');
    }

    function setFilter(lineName) {
        state.filter = lineName && state.filter !== lineName ? lineName : null;
        renderFilters();
        applyFilter();
    }

    function applyFilter() {
        el.results.querySelectorAll('.line').forEach((section) => {
            section.hidden = Boolean(state.filter) && section.dataset.line !== state.filter;
        });
    }

    function skeletonHTML(station) {
        const row = '<li class="dir"><span class="dir-dest"><span class="skeleton skeleton--dest"></span></span><span class="dir-times"><span class="eta"><span class="skeleton skeleton--time"></span></span></span></li>';
        return station.lines.map((lineName) => `
            <section class="line" data-line="${escapeHTML(lineName)}" aria-hidden="true">
                <div class="line-head">${badgeHTML(lineName)}</div>
                <ul class="dirs">${row}${row}</ul>
            </section>`).join('');
    }

    function lineHTML(lineName, line) {
        const directions = line
            ? [...line.directions.values()].sort((a, b) => a.order - b.order || a.destination.localeCompare(b.destination))
            : [];
        const trains = directions.flatMap((direction) => direction.list);
        const scheduledOnly = trains.length > 0 && trains.every((train) => train.scheduled);
        const note = scheduledOnly ? escapeHTML(t('scheduledTimes')) : '';
        const rows = directions.map((direction) => `
            <li class="dir" data-destination="${escapeHTML(direction.destination)}" hidden>
                <span class="dir-dest">${escapeHTML(direction.destination)}</span>
                <span class="dir-times"></span>
            </li>`).join('');
        return `
            <section class="line" data-line="${escapeHTML(lineName)}">
                <div class="line-head">${badgeHTML(lineName)}${note ? `<span class="line-note">${note}</span>` : ''}</div>
                <ul class="dirs">${rows}<li class="dir dir--empty" hidden>${escapeHTML(t('noTrains'))}</li></ul>
                ${note ? `<p class="line-note line-note--foot">${note}</p>` : ''}
            </section>`;
    }

    function renderBoard() {
        const station = state.station;
        if (!station) return;
        el.results.classList.toggle('is-compact', state.compact);
        if (!state.board) {
            el.results.innerHTML = state.failed
                ? `<div class="results-error"><p>${escapeHTML(t('couldNotGetInfo'))}</p><button type="button" class="pill-btn" data-action="retry">${escapeHTML(t('retry'))}</button></div>`
                : skeletonHTML(station);
            applyFilter();
            return;
        }
        const lineNames = [...station.lines];
        state.board.forEach((_, lineName) => {
            if (!lineNames.includes(lineName)) lineNames.push(lineName);
        });
        el.results.innerHTML = lineNames.map((lineName) => lineHTML(lineName, state.board.get(lineName))).join('');
        applyFilter();
        tick();
    }

    function etaHTML(train, now) {
        const wait = train.at - now;
        let label;
        if (wait <= NOW_WINDOW) label = t('now');
        else if (wait < 60 * 1000) label = t('seconds', { n: Math.floor(wait / 1000) });
        else label = t('minutes', { n: Math.floor(wait / 60000) });
        return `<span class="eta${wait <= NOW_WINDOW ? ' is-now' : ''}"><span class="eta-wait">${escapeHTML(label)}</span><span class="eta-clock">${formatClock(train.at)}</span></span>`;
    }

    /** Runs every second: updates countdowns, rolls departed trains off, refreshes the status line. */
    function tick() {
        const now = Date.now();
        if (state.station && state.board) {
            let ranOut = false;
            el.results.querySelectorAll('.line').forEach((section) => {
                const line = state.board.get(section.dataset.line);
                let visible = 0;
                section.querySelectorAll('.dir[data-destination]').forEach((row) => {
                    const direction = line && line.directions.get(row.dataset.destination);
                    const upcoming = direction ? upcomingTrains(direction, now) : [];
                    if (!upcoming.length) {
                        if (row.dataset.shown) {
                            ranOut = true;
                            delete row.dataset.shown;
                        }
                        row.hidden = true;
                        return;
                    }
                    visible++;
                    row.hidden = false;
                    row.dataset.shown = '1';
                    const times = row.querySelector('.dir-times');
                    const html = upcoming.map((train) => etaHTML(train, now)).join('');
                    if (renderedTimes.get(times) !== html) {
                        times.innerHTML = html;
                        renderedTimes.set(times, html);
                    }
                });
                const empty = section.querySelector('.dir--empty');
                if (empty) empty.hidden = visible > 0;
            });
            // A direction just ran out of known trains: fetch fresh data early.
            if (ranOut) refreshSoon();
        }
        renderStatus(now);
    }

    function renderStatus(now = Date.now()) {
        if (!state.station) return;
        let text = '';
        let warning = false;
        if (!navigator.onLine) {
            text = t('offline');
            warning = true;
        } else if (state.failed && !state.loading) {
            text = t('updateFailed');
            warning = true;
        } else if (!state.board) {
            text = state.loading ? t('updating') : '';
        } else if (state.updatedAt) {
            const minutes = Math.floor((now - state.updatedAt) / 60000);
            text = minutes < 1 ? t('updatedJustNow') : t('updatedAgo', { n: minutes });
        }
        if (el.status.textContent !== text) el.status.textContent = text;
        el.status.classList.toggle('is-warning', warning);
        el.refreshBtn.classList.toggle('is-spinning', state.loading);
    }

    function startTicking() {
        if (!tickTimer) tickTimer = setInterval(tick, 1000);
    }

    function stopTicking() {
        clearInterval(tickTimer);
        tickTimer = null;
    }

    // --- Station lists (search, nearby, recent) ---
    function highlight(name, index, start, length) {
        if (start < 0 || !length) return escapeHTML(name);
        const from = index.map[start];
        const to = index.map[start + length - 1] + 1;
        return `${escapeHTML(name.slice(0, from))}<mark>${escapeHTML(name.slice(from, to))}</mark>${escapeHTML(name.slice(to))}`;
    }

    function stationRowsHTML(items) {
        return `<ul class="list-group">${items.map(({ station, match, distance }) => `
            <li><button type="button" class="station-row" data-slug="${station.slug}">
                <span class="station-row-name">${match ? highlight(station.name, station.index, match.start, match.length) : escapeHTML(station.name)}</span>
                ${distance !== undefined ? `<span class="station-row-meta">${formatDistance(distance)}</span>` : ''}
                <span class="badges">${station.lines.map((lineName) => badgeHTML(lineName, true)).join('')}</span>
            </button></li>`).join('')}</ul>`;
    }

    function actionRowHTML(label, disabled) {
        return `<ul class="list-group"><li><button type="button" class="station-row station-row--action" data-action="nearby"${disabled ? ' disabled' : ''}>
            ${ICONS.location}<span class="station-row-name">${escapeHTML(label)}</span>
        </button></li></ul>`;
    }

    function searchStations(query) {
        const q = buildSearchIndex(query).text;
        const qCompact = q.replace(/ /g, '');
        if (!q) return [];

        // "L3", "l9", "L10S" list the stations on that line.
        const lineQuery = /^l\s?(\d{1,2})\s?([ns])?$/.exec(q);
        if (lineQuery || q === 'fm') {
            const wanted = q === 'fm' ? 'fm' : `l${lineQuery[1]}${lineQuery[2] || ''}`;
            const onLine = state.stations.filter((station) => station.lines.some((lineName) => {
                const name = lineName.toLowerCase();
                return name === wanted || (!lineQuery?.[2] && /^l\d+[ns]$/.test(name) && name.slice(0, -1) === wanted);
            }));
            if (onLine.length) return onLine.map((station) => ({ station }));
        }

        const results = [];
        state.stations.forEach((station) => {
            const text = station.index.text;
            let score = -1;
            let start = -1;
            if (text.startsWith(q)) {
                score = 0;
                start = 0;
            } else if (text.includes(` ${q}`)) {
                score = 1;
                start = text.indexOf(` ${q}`) + 1;
            } else if (text.includes(q)) {
                score = 2;
                start = text.indexOf(q);
            } else if (qCompact && (station.compact.includes(qCompact) || station.simple.includes(qCompact))) {
                score = 3;
            }
            if (score >= 0) results.push({ score, station, match: { start, length: start >= 0 ? q.length : 0 } });
        });
        return results.sort((a, b) => a.score - b.score || a.station.name.localeCompare(b.station.name));
    }

    function nearbyHTML(withAction) {
        const nearby = state.nearby;
        if (!nearby) return withAction ? actionRowHTML(t('nearMe')) : '';
        if (nearby.status === 'locating') {
            return withAction ? actionRowHTML(t('locating'), true) : `<p class="list-note">${escapeHTML(t('locating'))}</p>`;
        }
        if (nearby.status === 'error') {
            return withAction ? actionRowHTML(t('locationUnavailable')) : `<p class="list-note">${escapeHTML(t('locationUnavailable'))}</p>`;
        }
        return `<h3 class="list-label">${escapeHTML(t('nearby'))}</h3>${stationRowsHTML(nearby.list)}`;
    }

    function renderSearch() {
        const query = el.searchInput.value.trim();
        let html = '';
        if (!state.stations.length) {
            html = '';
        } else if (!query) {
            html += `<div class="list-block">${nearbyHTML(true)}</div>`;
            const recent = recentStations();
            if (recent.length) {
                html += `<h3 class="list-label">${escapeHTML(t('recent'))}</h3>${stationRowsHTML(recent.map((station) => ({ station })))}`;
            }
            html += `<h3 class="list-label">${escapeHTML(t('allStations'))}</h3>${stationRowsHTML(state.stations.map((station) => ({ station })))}`;
        } else {
            const matches = searchStations(query);
            html = matches.length
                ? `<div class="list-block">${stationRowsHTML(matches)}</div>`
                : `<p class="list-note">${escapeHTML(t('noResults'))}</p>`;
        }
        el.searchResults.innerHTML = html;
    }

    function renderHome() {
        const visible = !state.station && state.stations.length > 0;
        el.home.hidden = !visible;
        if (!visible) return;
        el.homeHint.hidden = state.favorites.length > 0;
        el.homeNearby.hidden = Boolean(state.nearby && state.nearby.status === 'ok');
        el.homeNearby.disabled = Boolean(state.nearby && state.nearby.status === 'locating');
        let html = nearbyHTML(false);
        const recent = recentStations();
        if (recent.length) {
            html += `<h2 class="list-label">${escapeHTML(t('recent'))}</h2>${stationRowsHTML(recent.map((station) => ({ station })))}`;
        }
        el.homeRecent.className = html ? 'home-list' : '';
        el.homeRecent.innerHTML = html;
    }

    function locateNearby() {
        const rerender = () => {
            renderHome();
            if (openSheet === el.searchDialog && !el.searchInput.value.trim()) renderSearch();
        };
        if (!navigator.geolocation) {
            state.nearby = { status: 'error' };
            rerender();
            return;
        }
        state.nearby = { status: 'locating' };
        rerender();
        navigator.geolocation.getCurrentPosition((position) => {
            const { latitude, longitude } = position.coords;
            const list = state.stations
                .filter((station) => Number.isFinite(station.lat))
                .map((station) => ({ station, distance: distanceBetween(latitude, longitude, station.lat, station.lon) }))
                .sort((a, b) => a.distance - b.distance)
                .slice(0, 6);
            state.nearby = { status: 'ok', list };
            rerender();
        }, () => {
            state.nearby = { status: 'error' };
            rerender();
        }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
    }

    // --- Favorites editor ---
    function renderEditList() {
        const stations = favoriteStations();
        el.editList.innerHTML = stations.length
            ? stations.map((station) => `
                <li class="edit-item" data-slug="${station.slug}">
                    <button type="button" class="icon-btn drag-handle" aria-label="${escapeHTML(t('reorder', { name: station.name }))}">${ICONS.handle}</button>
                    <span class="edit-name">${escapeHTML(station.name)}</span>
                    <span class="badges">${station.lines.map((lineName) => badgeHTML(lineName, true)).join('')}</span>
                    <button type="button" class="icon-btn remove-btn" data-remove="${station.slug}" aria-label="${escapeHTML(t('remove', { name: station.name }))}">${ICONS.remove}</button>
                </li>`).join('')
            : `<li class="list-note edit-empty">${escapeHTML(t('favoritesHint'))}</li>`;
    }

    function startDrag(event, handle) {
        const item = handle.closest('.edit-item');
        const items = [...el.editList.querySelectorAll('.edit-item')];
        if (!item || items.length < 2) return;
        event.preventDefault();

        const from = items.indexOf(item);
        const rects = items.map((li) => li.getBoundingClientRect());
        const step = rects[1].top - rects[0].top;
        const minOffset = rects[0].top - rects[from].top;
        const maxOffset = rects[items.length - 1].top - rects[from].top;
        const startY = event.clientY;
        let to = from;

        handle.setPointerCapture(event.pointerId);
        item.classList.add('is-dragging');
        items.forEach((li) => {
            if (li !== item) li.classList.add('is-shifting');
        });

        const onMove = (moveEvent) => {
            const offset = Math.max(minOffset, Math.min(maxOffset, moveEvent.clientY - startY));
            item.style.transform = `translateY(${offset}px)`;
            to = Math.max(0, Math.min(items.length - 1, from + Math.round(offset / step)));
            items.forEach((li, i) => {
                if (li === item) return;
                let shift = 0;
                if (from < to && i > from && i <= to) shift = -step;
                else if (from > to && i < from && i >= to) shift = step;
                li.style.transform = shift ? `translateY(${shift}px)` : '';
            });
        };
        const onEnd = () => {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onEnd);
            handle.removeEventListener('pointercancel', onEnd);
            items.forEach((li) => {
                li.style.transform = '';
                li.classList.remove('is-shifting', 'is-dragging');
            });
            if (to !== from) {
                const order = items.map((li) => li.dataset.slug);
                order.splice(to, 0, order.splice(from, 1)[0]);
                applyFavoriteOrder(order);
            }
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onEnd);
        handle.addEventListener('pointercancel', onEnd);
    }

    function moveWithKeyboard(event) {
        const handle = event.target.closest('.drag-handle');
        if (!handle || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
        event.preventDefault();
        const items = [...el.editList.querySelectorAll('.edit-item')];
        const order = items.map((li) => li.dataset.slug);
        const from = items.indexOf(handle.closest('.edit-item'));
        const to = from + (event.key === 'ArrowUp' ? -1 : 1);
        if (to < 0 || to >= order.length) return;
        order.splice(to, 0, order.splice(from, 1)[0]);
        applyFavoriteOrder(order);
        const moved = el.editList.querySelector(`.edit-item[data-slug="${order[to]}"] .drag-handle`);
        if (moved) moved.focus();
    }

    // --- Sheets (dialogs) ---
    // Opening a sheet adds a history entry so the Android back button/gesture closes it
    // instead of leaving the app.
    let openSheet = null;
    let sheetHistory = false;
    let sheetClosing = false;
    let afterSheetClose = null;

    function showSheet(dialog) {
        if (openSheet) return;
        openSheet = dialog;
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
        document.documentElement.classList.add('is-locked');
        try {
            history.pushState({ metromasterSheet: true }, '', location.href);
            sheetHistory = true;
        } catch {
            sheetHistory = false;
        }
    }

    function hideSheet(then) {
        const dialog = openSheet;
        if (!dialog) {
            if (then) then();
            return;
        }
        if (sheetHistory) {
            afterSheetClose = then || null;
            sheetClosing = true;
            history.back();
            // Safety net in case the browser is slow to deliver popstate.
            setTimeout(() => {
                if (openSheet === dialog) finishSheetClose();
            }, 800);
        } else {
            afterSheetClose = then || null;
            finishSheetClose();
        }
    }

    function finishSheetClose() {
        const dialog = openSheet;
        const then = afterSheetClose;
        openSheet = null;
        sheetHistory = false;
        afterSheetClose = null;
        document.documentElement.classList.remove('is-locked');
        if (dialog) {
            if (typeof dialog.close === 'function' && dialog.open) dialog.close();
            else dialog.removeAttribute('open');
        }
        document.body.appendChild(el.toasts);
        // Going back restored the URL from before the sheet opened; re-apply the current state.
        writeURL();
        if (then) then();
    }

    function openSearch() {
        el.searchInput.value = '';
        if (state.nearby && state.nearby.status !== 'ok') state.nearby = null;
        renderSearch();
        showSheet(el.searchDialog);
        el.searchResults.scrollTop = 0;
        el.searchInput.focus();
    }

    function openFavoritesEditor() {
        renderEditList();
        showSheet(el.favoritesDialog);
    }

    // --- Share & toasts ---
    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            const area = document.createElement('textarea');
            area.value = text;
            area.setAttribute('readonly', '');
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            let copied = false;
            try {
                copied = document.execCommand('copy');
            } catch {
                copied = false;
            }
            area.remove();
            return copied;
        }
    }

    async function shareStation() {
        const url = location.href;
        const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        if (navigator.share && touch) {
            try {
                await navigator.share({ title: document.title, url });
            } catch {
                // Share sheet dismissed.
            }
            return;
        }
        if (await copyText(url)) toast(t('linkCopied'));
    }

    let toastTimer = null;
    function toast(message, { action, onAction } = {}) {
        const host = openSheet || document.body;
        if (el.toasts.parentNode !== host) host.appendChild(el.toasts);
        clearTimeout(toastTimer);
        el.toasts.replaceChildren();

        const node = document.createElement('div');
        node.className = 'toast';
        const text = document.createElement('span');
        text.textContent = message;
        node.appendChild(text);

        const dismiss = () => {
            node.classList.add('is-leaving');
            setTimeout(() => node.remove(), 200);
        };
        if (action && onAction) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = action;
            button.addEventListener('click', () => {
                onAction();
                dismiss();
            });
            node.appendChild(button);
        }
        el.toasts.appendChild(node);
        toastTimer = setTimeout(dismiss, action ? 4500 : 2200);
    }

    function toggleCompact() {
        state.compact = !state.compact;
        writeJSON(local, KEYS.compact, state.compact);
        if (state.compact) queryParams.set('compact', 'true');
        else queryParams.delete('compact');
        writeURL();
        el.densityBtn.setAttribute('aria-pressed', String(state.compact));
        el.results.classList.toggle('is-compact', state.compact);
    }

    // --- Events ---
    function stationFromEvent(event) {
        const row = event.target.closest('[data-slug]');
        return row ? resolveSlug(row.dataset.slug, true) : null;
    }

    function bindEvents() {
        el.searchOpen.addEventListener('click', openSearch);
        el.searchCancel.addEventListener('click', () => hideSheet());
        el.searchInput.addEventListener('input', () => {
            el.searchResults.scrollTop = 0;
            renderSearch();
        });
        el.searchInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                const first = el.searchResults.querySelector('.station-row[data-slug]');
                if (first) first.click();
            } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                const first = el.searchResults.querySelector('.station-row:not([disabled])');
                if (first) first.focus();
            }
        });
        el.searchResults.addEventListener('click', (event) => {
            if (event.target.closest('[data-action="nearby"]')) {
                el.searchInput.blur();
                locateNearby();
                return;
            }
            const station = stationFromEvent(event);
            if (station) hideSheet(() => selectStation(station, { scrollToTop: true }));
        });
        el.searchResults.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            const rows = [...el.searchResults.querySelectorAll('.station-row:not([disabled])')];
            const index = rows.indexOf(document.activeElement);
            if (index === -1) return;
            event.preventDefault();
            const next = event.key === 'ArrowDown' ? rows[index + 1] : (rows[index - 1] || el.searchInput);
            if (next) next.focus();
        });
        // Dismiss the on-screen keyboard when the list is scrolled.
        el.searchResults.addEventListener('touchmove', () => {
            if (document.activeElement === el.searchInput) el.searchInput.blur();
        }, { passive: true });

        el.favoriteChips.addEventListener('click', (event) => selectStation(stationFromEvent(event)));
        el.favoritesEdit.addEventListener('click', openFavoritesEditor);
        el.favoritesDone.addEventListener('click', () => hideSheet());
        el.editList.addEventListener('pointerdown', (event) => {
            const handle = event.target.closest('.drag-handle');
            if (handle && event.button === 0) startDrag(event, handle);
        });
        el.editList.addEventListener('keydown', moveWithKeyboard);
        el.editList.addEventListener('click', (event) => {
            const button = event.target.closest('[data-remove]');
            if (button) removeFavorite(button.dataset.remove);
        });

        el.favoriteToggle.addEventListener('click', toggleFavorite);
        el.shareBtn.addEventListener('click', shareStation);
        el.refreshBtn.addEventListener('click', () => refresh());
        el.densityBtn.addEventListener('click', toggleCompact);
        el.lineFilters.addEventListener('click', (event) => {
            const button = event.target.closest('[data-filter]');
            if (button) setFilter(button.dataset.filter);
        });
        el.results.addEventListener('click', (event) => {
            if (event.target.closest('[data-action="retry"]')) refresh();
        });

        el.homeNearby.addEventListener('click', locateNearby);
        el.homeRecent.addEventListener('click', (event) => selectStation(stationFromEvent(event), { scrollToTop: true }));
        el.languages.addEventListener('click', (event) => {
            const button = event.target.closest('[data-lang]');
            if (button) setLanguage(button.dataset.lang);
        });

        [el.searchDialog, el.favoritesDialog].forEach((dialog) => {
            dialog.addEventListener('cancel', (event) => {
                event.preventDefault();
                hideSheet();
            });
            dialog.addEventListener('click', (event) => {
                if (event.target === dialog) hideSheet();
            });
        });

        window.addEventListener('popstate', () => {
            const closing = sheetClosing;
            sheetClosing = false;
            if (openSheet) finishSheetClose();
            // A late popstate after the safety net closed the sheet: re-apply the current URL.
            else if (closing) writeURL();
        });
        window.addEventListener('hashchange', onHashChange);

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                clearTimeout(refreshTimer);
                stopTicking();
            } else {
                startTicking();
                tick();
                refreshIfStale();
            }
        });
        window.addEventListener('pageshow', (event) => {
            if (event.persisted) refreshIfStale();
        });
        window.addEventListener('online', () => {
            if (state.station) refresh();
        });
        window.addEventListener('offline', () => renderStatus());
    }

    /** Handles links or manual edits that change the hash while the page is open. */
    function onHashChange() {
        if (openSheet || !state.stations.length) return;
        const hash = readHash();
        if (hash.favorites && hash.favorites.join(',') !== state.favorites.join(',')) {
            const seed = hash.favorites.join(',');
            const saved = readJSON(local, KEYS.favorites, {}) || {};
            state.favoritesSeed = seed;
            state.favorites = sanitizeSlugs(saved[seed] ? saved[seed].list : hash.favorites);
            renderFavorites();
            renderStationHeader();
        }
        const station = hash.station ? resolveSlug(hash.station) : null;
        if (station && station !== state.station) {
            selectStation(station);
        } else if (!hash.station && state.station) {
            if (loadController) loadController.abort();
            clearTimeout(refreshTimer);
            state.station = null;
            state.board = null;
            renderAll();
        }
        writeURL();
    }

    // --- Init ---
    async function init() {
        state.lang = detectLanguage();
        state.compact = queryParams.get('compact') === 'true'
            || (!queryParams.has('compact') && readJSON(local, KEYS.compact, false) === true);
        if (state.compact) el.results.classList.add('is-compact');
        applyTranslations();
        bindEvents();
        startTicking();

        const hash = readHash();
        try {
            await loadStations();
        } catch {
            el.pageError.textContent = t('couldNotLoadStations');
            el.pageError.hidden = false;
            return;
        }

        initFavorites(hash.favorites);
        const pathStation = readPathStation();
        const station = hash.station ? resolveSlug(hash.station) : pathStation;
        if (station) {
            state.station = station;
            pushRecent(station.slug);
        }
        writeURL();
        renderAll();
        if (openSheet === el.searchDialog) renderSearch();
        if (state.station) refresh();
    }

    init();
})();
