const App = (() => {
  const ENDPOINTS = {
    GEO_NAME: 'https://geocoding-api.open-meteo.com/v1/search',
    GEO_REV: 'https://geocoding-api.open-meteo.com/v1/reverse',
    FORECAST: 'https://api.open-meteo.com/v1/forecast'
  };

  const ELEMENTS = {
    LIST: 'weatherContainer',
    AUTOCOMPLETE: 'suggestions',
    ERROR_BOX: 'cityError',
    INPUT: 'cityInput',
    BTN_REFRESH: 'refreshBtn',
    BTN_ADD: 'addCityBtn',
    BTN_GEO: 'geoBtn',
    LOCATION_LABEL: 'currentLocation'
  };

  const CONFIG = {
    AUTOCOMPLETE_DELAY: 250,
    SUGGEST_LIMIT: 8,
    GEO_LIMIT: 5,
    FORECAST_DAYS: 3,
    GEO_TIMEOUT_MS: 10000,
    CACHE_TTL_MS: 5 * 60 * 1000,
    MAX_CONCURRENT: 3,
    STORAGE_KEY: 'cities'
  };

  const $id = (id) => document.getElementById(id);

  function safeParse(raw, fallback) {
    try {
      if (raw === null || typeof raw === 'undefined') return fallback;
      const parsed = JSON.parse(raw);
      return parsed === null ? fallback : parsed;
    } catch (e) {
      return fallback;
    }
  }

  function uid(n = 7) {
    return Math.random().toString(36).slice(2, 2 + n);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]));
  }

  function niceDate(iso) {
    try {
      const d = new Date(iso);
      if (isNaN(d)) return String(iso);
      const months = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
      return `${d.getDate()} ${months[d.getMonth()]}`;
    } catch (e) { return String(iso); }
  }

  function debounce(fn, t) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), t);
    };
  }

  const CODE_MAP = {
    0: "Ясно",1: "Частично облачно",2: "Облачно",3: "Пасмурно",45: "Туман",48: "Туман с инеем",
    51: "Мелкий дождь",53: "Умеренный дождь",55: "Сильный дождь",61: "Дождь",63: "Сильный дождь",
    65: "Сильный дождь",71: "Снег",73: "Сильный снег",75: "Очень сильный снег",80: "Ливень",
    81: "Сильный ливень",82: "Очень сильный ливень",95: "Гроза",96: "Гроза с небольшим градом",99: "Гроза с градом"
  };

  class ApiClient {
    constructor(endpoints) { this.endpoints = endpoints; }
    async geocode(q, limit = CONFIG.SUGGEST_LIMIT) {
      const url = `${this.endpoints.GEO_NAME}?name=${encodeURIComponent(q)}&count=${limit}&language=ru&format=json`;
      const r = await fetch(url);
      if (!r.ok) throw new Error('geocode error');
      return r.json();
    }
    async reverse(lat, lon, limit = 1) {
      try {
        const url = `${this.endpoints.GEO_REV}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&count=${limit}&language=ru`;
        const r = await fetch(url);
        if (!r.ok) return null;
        return r.json();
      } catch (e) { return null; }
    }
    async forecast(lat, lon, days = CONFIG.FORECAST_DAYS) {
      const url = `${this.endpoints.FORECAST}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto&forecast_days=${days}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error('forecast error');
      return r.json();
    }
  }

  class StorageService {
    constructor(key) { this.key = key; }
    load(defaultValue) {
      try { return safeParse(localStorage.getItem(this.key), defaultValue); } catch (e) { return defaultValue; }
    }
    save(value) {
      try { localStorage.setItem(this.key, JSON.stringify(value)); } catch (e) {}
    }
  }

  class RequestPool {
    constructor(max = CONFIG.MAX_CONCURRENT) { this.max = max; this.running = 0; this.queue = []; }
    push(fn) {
      return new Promise((resolve, reject) => {
        this.queue.push({fn, resolve, reject});
        this._runNext();
      });
    }
    _runNext() {
      if (this.running >= this.max || this.queue.length === 0) return;
      const item = this.queue.shift();
      this.running++;
      Promise.resolve().then(() => item.fn()).then(res => item.resolve(res)).catch(err => item.reject(err)).finally(() => { this.running--; this._runNext(); });
    }
  }

  class ForecastCache {
    constructor(ttl = CONFIG.CACHE_TTL_MS) { this.ttl = ttl; this.store = new Map(); }
    _key(lat, lon) { return `${(Math.round(lat*1e6)/1e6).toFixed(6)},${(Math.round(lon*1e6)/1e6).toFixed(6)}`; }
    get(lat, lon) {
      const key = this._key(lat, lon);
      const now = Date.now();
      const item = this.store.get(key);
      if (!item) return null;
      if (now - item.ts > this.ttl) { this.store.delete(key); return null; }
      return item.data;
    }
    set(lat, lon, data) {
      const key = this._key(lat, lon);
      this.store.set(key, { ts: Date.now(), data });
    }
    clear() { this.store.clear(); }
  }

  class CityStore {
    constructor(initial = []) { this.cities = Array.isArray(initial) ? initial : []; }
    all() { return this.cities.slice(); }
    add(city) { this.cities.push(city); }
    removeById(id) { this.cities = this.cities.filter(c => c.id !== id); }
    findGeo() { return this.cities.find(c => c.isGeo); }
    findById(id) { return this.cities.find(c => c.id === id); }
    hasCoords(lat, lon) {
      const toKey = (a,b) => `${(Math.round((a||0)*1e6)/1e6).toFixed(6)},${(Math.round((b||0)*1e6)/1e6).toFixed(6)}`;
      const key = toKey(lat, lon);
      return this.cities.some(c => toKey(c.lat || 0, c.lon || 0) === key);
    }
    replaceGeo(lat, lon, display) {
      const g = this.findGeo();
      if (g) { g.lat = lat; g.lon = lon; g.displayName = display; }
      else this.cities.unshift({ id: uid(), name: 'geo', displayName: display, lat, lon, isGeo: true });
    }
    saveTo(storageService) { storageService.save(this.cities); }
  }

  class UIRenderer {
    constructor(elements) {
      this.container = $id(elements.LIST);
      this.suggestions = $id(elements.AUTOCOMPLETE);
      this.errorBox = $id(elements.ERROR_BOX);
      this.input = $id(elements.INPUT);
      this.btnRefresh = $id(elements.BTN_REFRESH);
      this.btnAdd = $id(elements.BTN_ADD);
      this.btnGeo = $id(elements.BTN_GEO);
      this.locLabel = $id(elements.LOCATION_LABEL);
    }
    clearSuggestions() { if (this.suggestions) { this.suggestions.style.display = 'none'; this.suggestions.innerHTML = ''; } }
    renderSuggestions(list) {
      if (!this.suggestions) return;
      if (!list || list.length === 0) { this.clearSuggestions(); return; }
      this.suggestions.innerHTML = list.map(r => {
        const label = `${r.name}${r.admin1 ? ', ' + r.admin1 : ''}${r.country ? ', ' + r.country : ''}`;
        return `<li data-lat="${r.latitude}" data-lon="${r.longitude}" data-display="${esc(label)}">${esc(label)}</li>`;
      }).join('');
      this.suggestions.style.display = 'block';
    }
    setError(text) { if (this.errorBox) this.errorBox.textContent = text || ''; }
    createCard(city) {
      const wrap = document.createElement('div');
      wrap.className = 'weather-card';
      wrap.dataset.id = city.id;
      wrap.innerHTML = `
        <div class="card-top">
          <div>
            <div class="card-title">${esc(city.displayName || city.name)}</div>
            <div class="card-meta">${city.isGeo ? 'Текущее местоположение' : 'Город'}</div>
          </div>
          <div class="card-actions"><button class="btn remove-card">Удалить</button></div>
        </div>
        <div class="card-body"><p class="loading">Загрузка</p></div>
      `;
      const rem = wrap.querySelector('.remove-card');
      if (rem) rem.addEventListener('click', () => {
        const ev = new CustomEvent('city:remove', { detail: { id: city.id } });
        document.dispatchEvent(ev);
      });
      return wrap;
    }
    renderEmpty() {
      if (!this.container) return;
      this.container.innerHTML = `<p class="loading">Нет сохранённых городов</p>`;
    }
    async renderAllCards(cityList, fillFn) {
      if (!this.container) return;
      this.container.innerHTML = '';
      if (!Array.isArray(cityList) || cityList.length === 0) { this.renderEmpty(); return; }
      const nodes = cityList.map(c => this.createCard(c));
      nodes.forEach(n => this.container.appendChild(n));
      const fills = cityList.map((c, i) => fillFn(c, nodes[i]));
      try { await Promise.all(fills); } catch (e) {}
    }
    updateHeader(display) {
      if (!this.locLabel) return;
      this.locLabel.textContent = display ? `Местоположение: ${display}` : '';
    }
  }

  class WeatherApp {
    constructor() {
      this.api = new ApiClient(ENDPOINTS);
      this.storage = new StorageService(CONFIG.STORAGE_KEY);
      const initial = this.storage.load([]);
      this.store = new CityStore(initial);
      this.ui = new UIRenderer(ELEMENTS);
      this.pool = new RequestPool(CONFIG.MAX_CONCURRENT);
      this.cache = new ForecastCache(CONFIG.CACHE_TTL_MS);
      this._bindUI();
    }

    _bindUI() {
      if (this.ui.input) {
        this.ui.input.addEventListener('input', debounce(() => this._onType(), CONFIG.AUTOCOMPLETE_DELAY));
        this.ui.input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this._onAdd(); }
          if (e.key === 'Escape') this.ui.clearSuggestions();
        });
      }
      if (this.ui.suggestions) {
        this.ui.suggestions.addEventListener('click', (e) => {
          const li = e.target.closest('li'); if (!li) return;
          const lat = parseFloat(li.dataset.lat); const lon = parseFloat(li.dataset.lon);
          const disp = li.dataset.display || li.textContent.trim();
          this._selected = { name: disp.split(',')[0].trim(), display: disp, lat, lon };
          if (this.ui.input) this.ui.input.value = disp;
          this.ui.clearSuggestions();
        });
      }
      document.addEventListener('click', (e) => {
        if (this.ui.input && !this.ui.input.contains(e.target) && this.ui.suggestions && !this.ui.suggestions.contains(e.target)) this.ui.clearSuggestions();
      });
      if (this.ui.btnAdd) this.ui.btnAdd.addEventListener('click', () => this._onAdd());
      if (this.ui.btnRefresh) this.ui.btnRefresh.addEventListener('click', () => this.refreshAll(true));
      if (this.ui.btnGeo) this.ui.btnGeo.addEventListener('click', () => this.applyGeolocation(true));
      document.addEventListener('city:remove', (e) => {
        const id = e.detail && e.detail.id;
        if (!id) return;
        const wasGeo = this.store.findById(id) && this.store.findById(id).isGeo;
        this.store.removeById(id);
        this.store.saveTo(this.storage);
        this.render();
        if (wasGeo) this._refreshHeader();
      });
    }

    async _onType() {
      const q = this.ui.input && this.ui.input.value ? this.ui.input.value.trim() : '';
      this._selected = null;
      this.ui.setError('');
      if (!q) { this.ui.clearSuggestions(); return; }
      try {
        const cached = this._suggestCache && this._suggestCache[q];
        if (cached) { this.ui.renderSuggestions(cached); return; }
        const data = await this.api.geocode(q, CONFIG.SUGGEST_LIMIT);
        const list = (data && data.results) ? data.results : [];
        this._suggestCache = this._suggestCache || {};
        this._suggestCache[q] = list;
        this.ui.renderSuggestions(list);
      } catch (err) { this.ui.clearSuggestions(); }
    }

    async _onAdd() {
      const raw = this.ui.input && this.ui.input.value ? this.ui.input.value.trim() : '';
      this.ui.setError('');
      if (!raw) { this.ui.setError('Введите название города'); return; }
      try {
        if (this._selected && this._selected.display === raw) {
          const s = this._selected;
          if (this.store.hasCoords(s.lat, s.lon)) { this.ui.setError('Этот город уже добавлен'); return; }
          this.store.add({ id: uid(), name: s.name, displayName: s.display, lat: s.lat, lon: s.lon, isGeo: false });
          this.store.saveTo(this.storage);
          if (this.ui.input) this.ui.input.value = '';
          this._selected = null;
          await this.render();
          return;
        }
        this.ui.setError('Проверка');
        const geo = await this.api.geocode(raw, CONFIG.GEO_LIMIT);
        if (!geo.results || geo.results.length === 0) { this.ui.setError('Город не найден'); return; }
        const best = geo.results[0];
        if (this.store.hasCoords(best.latitude, best.longitude)) { this.ui.setError('Этот город уже добавлен'); return; }
        const display = `${best.name}${best.admin1 ? ', ' + best.admin1 : ''}${best.country ? ', ' + best.country : ''}`;
        this.store.add({ id: uid(), name: best.name, displayName: display, lat: best.latitude, lon: best.longitude, isGeo: false });
        this.store.saveTo(this.storage);
        if (this.ui.input) this.ui.input.value = '';
        this.ui.setError('');
        await this.render();
      } catch (err) { this.ui.setError('Ошибка сети'); }
    }

    async _fetchForecastWithPool(lat, lon, force = false) {
      const cached = this.cache.get(lat, lon);
      if (!force && cached) return cached;
      const task = () => this.api.forecast(lat, lon, CONFIG.FORECAST_DAYS);
      const res = await this.pool.push(task);
      this.cache.set(lat, lon, res);
      return res;
    }

    async _populateCard(city, elCard, force = false) {
      const body = elCard.querySelector('.card-body'); if (!body) return;
      body.innerHTML = `<p class="loading">Загрузка</p>`;
      try {
        let { lat, lon } = city;
        if ((!lat || !lon) && !city.isGeo) {
          const g = await this.api.geocode(city.name, 1);
          if (!g.results || g.results.length === 0) { body.innerHTML = `<p class="error">Город не найден</p>`; return; }
          const best = g.results[0];
          lat = best.latitude; lon = best.longitude; city.lat = lat; city.lon = lon; this.store.saveTo(this.storage);
        }
        const fx = await this._fetchForecastWithPool(lat, lon, force);
        const times = (fx.daily && fx.daily.time) ? fx.daily.time : [];
        const tmin = (fx.daily && fx.daily.temperature_2m_min) ? fx.daily.temperature_2m_min : [];
        const tmax = (fx.daily && fx.daily.temperature_2m_max) ? fx.daily.temperature_2m_max : [];
        const codes = (fx.daily && fx.daily.weathercode) ? fx.daily.weathercode : [];
        let html = '';
        for (let i = 0; i < 3; i++) {
          const label = (i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : 'Послезавтра');
          const timeVal = times[i] || null;
          const minV = (typeof tmin[i] !== 'undefined') ? Math.round(tmin[i]) : '—';
          const maxV = (typeof tmax[i] !== 'undefined') ? Math.round(tmax[i]) : '—';
          const text = (typeof codes[i] !== 'undefined' && CODE_MAP[codes[i]]) ? CODE_MAP[codes[i]] : '—';
          html += `<div class="day"><div><b>${label}${timeVal ? ` (${niceDate(timeVal)})` : ''}:</b><div class="desc">${esc(text)}</div></div><div class="temps">${minV}°C — ${maxV}°C</div></div>`;
        }
        body.innerHTML = html;
      } catch (err) {
        body.innerHTML = `<p class="error">Ошибка загрузки: ${esc(err.message || 'ошибка')}</p>`;
      }
    }

    async render() {
      const list = this.store.all();
      await this.ui.renderAllCards(list, (city, node) => this._populateCard(city, node));
      this._refreshHeader();
    }

    async refreshAll(force = false) {
      this.cache.clear();
      const cards = Array.from(document.querySelectorAll('.weather-card'));
      const promises = cards.map(c => {
        const id = c.dataset.id; const city = this.store.findById(id);
        if (city) return this._populateCard(city, c, force); return Promise.resolve();
      });
      return Promise.all(promises);
    }

    _refreshHeader() {
      const geo = this.store.findGeo();
      this.ui.updateHeader(geo ? geo.displayName || 'Текущее местоположение' : '');
    }

    _getCurrentPosition(opts = {}) {
      return new Promise((res, rej) => {
        if (!navigator.geolocation) return rej(new Error('Геолокация не поддерживается'));
        navigator.geolocation.getCurrentPosition(res, rej, opts);
      });
    }

    async applyGeolocation(showErr = true) {
      try {
        const pos = await this._getCurrentPosition({ timeout: CONFIG.GEO_TIMEOUT_MS });
        const lat = pos.coords.latitude; const lon = pos.coords.longitude;
        let display = null;
        const rev = await this.api.reverse(lat, lon, 1);
        if (rev && rev.results && rev.results[0]) {
          const r = rev.results[0];
          display = `${r.name}${r.admin1 ? ', ' + r.admin1 : ''}${r.country ? ', ' + r.country : ''}`;
        }
        if (!display) display = 'Текущее местоположение';
        this.store.replaceGeo(lat, lon, display);
        this.store.saveTo(this.storage);
        await this.render();
        this.ui.setError('');
      } catch (err) {
        if (!showErr) return;
        if (err && err.code === 1) this.ui.setError('Доступ к геопозиции запрещён');
        else this.ui.setError('Не удалось получить геопозицию');
      }
    }

    async start() {
      if ((!this.store.all() || this.store.all().length === 0) && navigator.geolocation) {
        try { await this.applyGeolocation(false); } catch (e) {}
      }
      await this.render();
    }
  }

  return new WeatherApp();
})();

document.addEventListener('DOMContentLoaded', () => { if (typeof App.start === 'function') App.start(); });
