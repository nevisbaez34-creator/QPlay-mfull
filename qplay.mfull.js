/**
 * QPlay.js v4.0.0-MFULL - Librería Multimedia Agnóstica Universal y Avanzada
 * Con Ecualizador Web Audio API, Control de Velocidad, PiP, Snapshots, Subtítulos y Estado Extendido.
 */

class QPlayError extends Error {
  /**
   * @param {string} code - Código estable (p. ej. 'LOAD_FAILED', 'UNSUPPORTED').
   * @param {string} message
   * @param {*} [cause]
   */
  constructor(code, message, cause) {
    super(message);
    this.name = 'QPlayError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

class QPlay {
  static get version() { return '4.0.0-MFULL'; }

  /**
   * @param {HTMLElement|string} container - Elemento del DOM o selector.
   * @param {Object} options - Configuración inicial.
   */
  constructor(container, options = {}) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    if (!this.container) {
      throw new QPlayError('NO_CONTAINER', '[QPlay] Contenedor DOM no encontrado.');
    }

    this.options = {
      autoplay: false,
      controls: true,
      muted: false,
      loop: false,
      crossOrigin: 'anonymous',
      objectFit: 'contain',
      hlsConfig: {},
      hlsUrl: 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js',
      dashUrl: 'https://cdn.jsdelivr.net/npm/dashjs@5/dist/modern/umd/dash.all.min.js',
      sniffTimeout: 4000,
      ...options
    };

    this.activeElement = null;
    this.activeBlobUrl = null;
    this.hlsInstance = null;
    this.dashInstance = null;

    // --- Estado de Playlist y Reproducción ---
    this.playlist = [];
    this.currentIndex = -1;
    this.isShuffle = false;
    this.repeatMode = 'off'; // 'off' | 'one' | 'all'

    // --- Web Audio API (Ecualizador) ---
    this.audioCtx = null;
    this.audioSourceNode = null;
    this.eqFilters = [];

    // --- Estado interno ---
    this._loadId = 0;
    this._abort = null;
    this._listeners = {};
    this._history = [];
    this._played = new Set();
    this._goingBack = false;
    this._hlsRetries = 0;

    this._setupContainer();
  }

  _setupContainer() {
    const c = this.container;
    const cs = getComputedStyle(c);
    if (cs.position === 'static') c.style.position = 'relative';
    c.style.overflow = 'hidden';
    c.style.display = 'flex';
    c.style.alignItems = 'center';
    c.style.justifyContent = 'center';
    if (cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent') {
      c.style.backgroundColor = '#000';
    }
  }

  // --- Eventos ---
  on(type, fn) {
    if (typeof fn !== 'function') throw new TypeError('[QPlay] on() requiere una función.');
    (this._listeners[type] = this._listeners[type] || new Set()).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    if (this._listeners[type]) this._listeners[type].delete(fn);
  }

  _emit(type, detail = {}) {
    const set = this._listeners[type];
    if (!set) return;
    [...set].forEach((fn) => {
      try { fn(detail); } catch (err) { console.error('[QPlay] Error en un listener de "' + type + '":', err); }
    });
  }

  /**
   * Carga cualquier recurso (URL HTTP, Blob o File local).
   * @param {string|File|Blob} source - Fuente del medio.
   * @param {string} [forcedMime] - Tipo MIME opcional.
   * @returns {Promise<HTMLElement|null>}
   */
  async load(source, forcedMime = '') {
    this.destroy();
    const id = this._loadId;

    let mediaUrl = '';
    let mimeType = forcedMime;
    let hint = '';

    try {
      if (source instanceof Blob) {
        this.activeBlobUrl = URL.createObjectURL(source);
        mediaUrl = this.activeBlobUrl;
        hint = source.name || '';
        mimeType = mimeType || source.type || '';
      } else if (typeof source === 'string') {
        mediaUrl = source;
        hint = source;
        mimeType = mimeType || await this._sniffUrl(mediaUrl);
      } else {
        throw new QPlayError('INVALID_SOURCE', '[QPlay] La fuente proporcionada no es válida.');
      }
      if (id !== this._loadId) return null;

      const category = this._getCategory(mimeType, hint || mediaUrl);

      let element;
      switch (category) {
        case 'hls':
          element = await this._renderHLS(mediaUrl, id);
          break;
        case 'dash':
          element = await this._renderDASH(mediaUrl, id);
          break;
        case 'image':
          element = this._renderImage(mediaUrl);
          break;
        case 'audio':
          element = this._renderAudio(mediaUrl);
          break;
        case 'video':
        default:
          element = this._renderVideo(mediaUrl);
          break;
      }
      if (!element || id !== this._loadId) return null;

      this._bindEvents(element);
      this._initEqualizer(element);

      this._emit('trackchange', {
        index: this.currentIndex,
        item: this.playlist[this.currentIndex],
        element,
        category
      });
      this._probeAutoplay(element);
      return element;
    } catch (err) {
      if (id !== this._loadId) return null;
      const error = err instanceof QPlayError
        ? err
        : new QPlayError('LOAD_FAILED', '[QPlay] No se pudo cargar el recurso: ' + (err && err.message ? err.message : err), err);
      this.destroy();
      this._emit('error', { code: error.code, message: error.message, error, recoverable: false });
      throw error;
    }
  }

  _bindEvents(el) {
    const ac = new AbortController();
    this._abort = ac;
    const opt = { signal: ac.signal };

    if (el instanceof HTMLMediaElement) {
      el.addEventListener('ended', () => {
        this._emit('ended', { index: this.currentIndex });
        if (this.repeatMode === 'one') {
          el.currentTime = 0;
          this._safePlay();
        } else if (this.playlist.length > 0) {
          this.next().catch(() => {});
        }
      }, opt);
      el.addEventListener('play', () => this._emit('play', { index: this.currentIndex }), opt);
      el.addEventListener('pause', () => this._emit('pause', { index: this.currentIndex }), opt);
      el.addEventListener('timeupdate', () => this._emit('timeupdate', {
        currentTime: el.currentTime,
        duration: el.duration,
        progress: el.duration ? (el.currentTime / el.duration) * 100 : 0
      }), opt);
      el.addEventListener('volumechange', () => this._emit('volumechange', {
        volume: el.volume,
        muted: el.muted
      }), opt);
      el.addEventListener('error', () => {
        const me = el.error;
        this._emit('error', {
          code: 'MEDIA_ERROR',
          message: (me && me.message) || 'El navegador no pudo reproducir este medio.',
          mediaCode: me ? me.code : undefined,
          recoverable: false
        });
      }, opt);
    } else {
      el.addEventListener('error', () => {
        this._emit('error', { code: 'IMAGE_ERROR', message: 'No se pudo mostrar la imagen.', recoverable: false });
      }, opt);
    }
  }

  _probeAutoplay(el) {
    if (!this.options.autoplay || !(el instanceof HTMLMediaElement)) return;
    const p = el.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        if (err && err.name === 'NotAllowedError') {
          this._emit('error', {
            code: 'PLAYBACK_BLOCKED',
            message: 'El navegador bloqueó la reproducción automática. Hace falta una interacción del usuario.',
            recoverable: true,
            error: err
          });
        }
      });
    }
  }

  _safePlay() {
    const p = this.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        if (err && err.name === 'AbortError') return;
        this._emit('error', {
          code: err && err.name === 'NotAllowedError' ? 'PLAYBACK_BLOCKED' : 'PLAY_FAILED',
          message: err && err.message ? err.message : 'No se pudo reproducir.',
          recoverable: !!(err && err.name === 'NotAllowedError'),
          error: err
        });
      });
    }
  }

  // --- Web Audio API (Ecualizador de 5 bandas) ---

  _initEqualizer(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;

      if (!this.audioCtx) {
        this.audioCtx = new AudioContext();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      if (!this.audioSourceNode) {
        this.audioSourceNode = this.audioCtx.createMediaElementSource(el);
      }

      // Definir 5 frecuencias estándar: 60Hz, 230Hz, 910Hz, 3600Hz, 14000Hz
      const frequencies = [60, 230, 910, 3600, 14000];
      let lastNode = this.audioSourceNode;

      this.eqFilters = frequencies.map((freq) => {
        const filter = this.audioCtx.createBiquadFilter();
        filter.type = 'peaking';
        filter.frequency.value = freq;
        filter.Q.value = 1.0;
        filter.gain.value = 0; // Neutro por defecto (0 dB)
        lastNode.connect(filter);
        lastNode = filter;
        return filter;
      });

      lastNode.connect(this.audioCtx.destination);
    } catch (e) {
      console.warn('[QPlay] Web Audio API / Ecualizador no soportado o bloqueado por CORS:', e);
    }
  }

  /**
   * Ajusta la ganancia de una banda del ecualizador.
   * @param {number} bandIndex - Índice de 0 a 4.
   * @param {number} gainDb - Ganancia en decibelios (ej. -20 a +20).
   */
  setEQ(bandIndex, gainDb) {
    if (this.eqFilters[bandIndex]) {
      this.eqFilters[bandIndex].gain.value = gainDb;
      this._emit('eqchange', { band: bandIndex, gain: gainDb });
    }
  }

  // --- Funciones MFULL Avanzadas ---

  /**
   * Cambia la velocidad de reproducción.
   * @param {number} rate - Velocidad (ej. 0.5, 1.0, 1.5, 2.0).
   */
  setPlaybackRate(rate) {
    if (this.activeElement instanceof HTMLMediaElement) {
      this.activeElement.playbackRate = rate;
      this._emit('ratechange', { rate });
    }
  }

  getPlaybackRate() {
    return this.activeElement instanceof HTMLMediaElement ? this.activeElement.playbackRate : 1;
  }

  /**
   * Control de Volumen (0 a 1).
   */
  setVolume(vol) {
    if (this.activeElement instanceof HTMLMediaElement) {
      this.activeElement.volume = Math.max(0, Math.min(1, vol));
    }
  }

  getVolume() {
    return this.activeElement instanceof HTMLMediaElement ? this.activeElement.volume : 1;
  }

  toggleMute() {
    if (this.activeElement instanceof HTMLMediaElement) {
      this.activeElement.muted = !this.activeElement.muted;
      return this.activeElement.muted;
    }
    return false;
  }

  /**
   * Activa o Desactiva el modo Picture-in-Picture (PiP) para video.
   */
  async togglePiP() {
    const el = this.activeElement;
    if (!(el instanceof HTMLVideoElement)) return false;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return false;
      } else if (document.pictureInPictureEnabled) {
        await el.requestPictureInPicture();
        return true;
      }
    } catch (err) {
      console.error('[QPlay] Error en PiP:', err);
    }
    return false;
  }

  /**
   * Captura un fotograma actual del video o imagen en formato Blob (PNG).
   * @returns {Promise<Blob|null>}
   */
  async snapshot() {
    const el = this.activeElement;
    if (!el) return null;

    const canvas = document.createElement('canvas');
    let w = 0, h = 0;

    if (el instanceof HTMLVideoElement) {
      w = el.videoWidth;
      h = el.videoHeight;
    } else if (el instanceof HTMLImageElement) {
      w = el.naturalWidth;
      h = el.naturalHeight;
    }
    if (!w || !h) return null;

    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    try {
      ctx.drawImage(el, 0, 0, w, h);
      return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    } catch (e) {
      console.error('[QPlay] Error al generar snapshot (posible CORS):', e);
      return null;
    }
  }

  /**
   * Añade una pista de subtítulos externa (WebVTT).
   * @param {string} src - URL del archivo .vtt
   * @param {string} [label='Español']
   * @param {string} [language='es']
   */
  addSubtitleTrack(src, label = 'Español', language = 'es') {
    const el = this.activeElement;
    if (!(el instanceof HTMLVideoElement)) return;
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = label;
    track.srclang = language;
    track.src = src;
    track.default = true;
    el.appendChild(track);
  }

  // --- Gestión de Playlist ---

  async loadPlaylist(items = [], startIndex = 0) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new QPlayError('INVALID_PLAYLIST', '[QPlay] La playlist debe ser un array con al menos un elemento.');
    }
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= items.length) {
      throw new RangeError('[QPlay] startIndex fuera de rango.');
    }
    this.playlist = [...items];
    this._history = [];
    this._played = new Set();
    return await this.playIndex(startIndex);
  }

  async playIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.playlist.length) return;
    if (this.currentIndex >= 0 && index !== this.currentIndex && !this._goingBack) {
      this._history.push(this.currentIndex);
      if (this._history.length > 200) this._history.shift();
    }
    this.currentIndex = index;
    const item = this.playlist[index];
    this._played.add(item);
    return await this.load(item);
  }

  _unplayedIndices() {
    const out = [];
    this.playlist.forEach((item, i) => {
      if (i !== this.currentIndex && !this._played.has(item)) out.push(i);
    });
    return out;
  }

  async next() {
    if (this.playlist.length === 0) return;

    if (this.isShuffle) {
      let candidates = this._unplayedIndices();
      if (candidates.length === 0) {
        if (this.repeatMode !== 'all') return;
        this._played = new Set();
        candidates = this.playlist.map((_, i) => i);
        if (candidates.length > 1) candidates = candidates.filter((i) => i !== this.currentIndex);
      }
      const randomIndex = candidates[Math.floor(Math.random() * candidates.length)];
      return await this.playIndex(randomIndex);
    }

    let nextIndex = this.currentIndex + 1;
    if (nextIndex >= this.playlist.length) {
      if (this.repeatMode === 'all') {
        nextIndex = 0;
      } else {
        return;
      }
    }

    return await this.playIndex(nextIndex);
  }

  async previous() {
    if (this.playlist.length === 0) return;

    let prevIndex;
    if (this.isShuffle) {
      while (this._history.length) {
        const h = this._history.pop();
        if (h >= 0 && h < this.playlist.length && h !== this.currentIndex) { prevIndex = h; break; }
      }
      if (prevIndex === undefined) return;
    } else {
      prevIndex = this.currentIndex - 1;
      if (prevIndex < 0) {
        prevIndex = this.repeatMode === 'all' ? this.playlist.length - 1 : 0;
      }
    }

    this._goingBack = true;
    const p = this.playIndex(prevIndex);
    this._goingBack = false;
    return await p;
  }

  toggleShuffle(enable) {
    this.isShuffle = typeof enable === 'boolean' ? enable : !this.isShuffle;
    const current = this.playlist[this.currentIndex];
    this._played = new Set(current !== undefined ? [current] : []);
    return this.isShuffle;
  }

  setRepeatMode(mode) {
    if (['off', 'all', 'one'].includes(mode)) {
      this.repeatMode = mode;
    } else {
      const modes = ['off', 'all', 'one'];
      const currentPos = modes.indexOf(this.repeatMode);
      this.repeatMode = modes[(currentPos + 1) % modes.length];
    }
    return this.repeatMode;
  }

  // --- Controles de Tiempo (-10s / +10s) ---

  seek(timeInSeconds) {
    const el = this.activeElement;
    if (!(el instanceof HTMLMediaElement)) return;
    const max = isFinite(el.duration) ? el.duration : 0;
    el.currentTime = Math.max(0, Math.min(max, timeInSeconds));
  }

  seekRelative(seconds) {
    const el = this.activeElement;
    if (!(el instanceof HTMLMediaElement)) return;
    const max = isFinite(el.duration) ? el.duration : Infinity;
    el.currentTime = Math.max(0, Math.min(max, el.currentTime + seconds));
  }

  forward(seconds = 10) {
    this.seekRelative(seconds);
  }

  rewind(seconds = 10) {
    this.seekRelative(-seconds);
  }

  // --- Detección Agnóstica Pura ---

  async _sniffUrl(url) {
    if (url.startsWith('data:')) {
      const m = /^data:([^;,]+)/.exec(url);
      return m ? m[1] : '';
    }

    if (url.startsWith('blob:')) return '';

    const lowerUrl = url.toLowerCase();
    if (lowerUrl.includes('.m3u8')) return 'application/x-mpegURL';
    if (lowerUrl.includes('.mpd')) return 'application/dash+xml';

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.options.sniffTimeout);
    try {
      const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
      const ct = res.headers.get('content-type');
      const clean = ct ? ct.split(';')[0].trim() : '';
      if (clean && clean !== 'application/octet-stream') return clean;
    } catch (_) {
      /* CORS, red o timeout */
    } finally {
      clearTimeout(timer);
    }
    return '';
  }

  _getCategory(mimeType, hint) {
    const mime = String(mimeType || '').toLowerCase();
    const name = String(hint || '').toLowerCase();

    if (mime.includes('mpegurl') || mime.includes('hls') || name.includes('.m3u8')) return 'hls';
    if (mime.includes('dash') || name.includes('.mpd')) return 'dash';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';

    return 'video';
  }

  _applyStyles(el) {
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.objectFit = this.options.objectFit;
  }

  _mount(el) {
    this.container.appendChild(el);
    this.activeElement = el;
    return el;
  }

  _createMedia(tag, url) {
    const el = document.createElement(tag);
    el.controls = this.options.controls;
    el.autoplay = this.options.autoplay;
    el.muted = this.options.muted;
    el.loop = this.options.loop;
    if (this.options.crossOrigin) el.crossOrigin = this.options.crossOrigin;
    if (tag === 'video') {
      el.playsInline = true;
      this._applyStyles(el);
    } else {
      el.style.width = '90%';
      el.style.maxWidth = '500px';
    }
    if (url) el.src = url;
    return el;
  }

  _renderImage(url) {
    const img = document.createElement('img');
    img.decoding = 'async';
    if (this.options.crossOrigin) img.crossOrigin = this.options.crossOrigin;
    img.src = url;
    this._applyStyles(img);
    return this._mount(img);
  }

  _renderVideo(url) {
    return this._mount(this._createMedia('video', url));
  }

  _renderAudio(url) {
    return this._mount(this._createMedia('audio', url));
  }

  async _renderHLS(url, id) {
    const video = this._createMedia('video', null);

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      return this._mount(video);
    }

    await this._loadScript(this.options.hlsUrl, 'Hls');
    if (id !== this._loadId) return null;

    const Hls = window.Hls;
    if (!Hls || !Hls.isSupported()) {
      throw new QPlayError('UNSUPPORTED', '[QPlay] Este navegador no puede reproducir HLS (falta MediaSource).');
    }

    this._mount(video);
    const hls = new Hls(this.options.hlsConfig);
    this.hlsInstance = hls;
    this._hlsRetries = 0;

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data || !data.fatal) return;
      const network = data.type === Hls.ErrorTypes.NETWORK_ERROR;
      const media = data.type === Hls.ErrorTypes.MEDIA_ERROR;
      const canRetry = (network || media) && this._hlsRetries < 3;
      this._emit('error', {
        code: 'HLS_' + String(data.type || 'ERROR').toUpperCase(),
        message: data.details || 'Error fatal de HLS.',
        recoverable: canRetry,
        error: data
      });
      if (canRetry) {
        this._hlsRetries++;
        if (network) hls.startLoad(); else hls.recoverMediaError();
      } else if (this.hlsInstance === hls) {
        hls.destroy();
        this.hlsInstance = null;
      }
    });

    hls.loadSource(url);
    hls.attachMedia(video);
    return video;
  }

  async _renderDASH(url, id) {
    const video = this._createMedia('video', null);

    await this._loadScript(this.options.dashUrl, 'dashjs');
    if (id !== this._loadId) return null;

    if (!window.dashjs) {
      throw new QPlayError('UNSUPPORTED', '[QPlay] dash.js no está disponible.');
    }

    this._mount(video);
    const player = window.dashjs.MediaPlayer().create();
    this.dashInstance = player;
    player.on(window.dashjs.MediaPlayer.events.ERROR, (e) => {
      const detail = e && e.error;
      this._emit('error', {
        code: 'DASH_ERROR',
        message: (detail && detail.message) || 'Error de DASH.',
        recoverable: false,
        error: e
      });
    });
    player.initialize(video, url, this.options.autoplay);
    return video;
  }

  _loadScript(src, globalName) {
    if (globalName && window[globalName]) return Promise.resolve();
    const cache = (QPlay._scripts = QPlay._scripts || {});
    if (cache[src]) return cache[src];

    cache[src] = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        delete cache[src];
        script.remove();
        reject(new QPlayError('SCRIPT_LOAD_FAILED', `[QPlay] Error al cargar: ${src}`));
      };
      document.head.appendChild(script);
    });
    return cache[src];
  }

  play() {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    if (this.activeElement && typeof this.activeElement.play === 'function') {
      return this.activeElement.play();
    }
  }

  pause() {
    if (this.activeElement && typeof this.activeElement.pause === 'function') {
      this.activeElement.pause();
    }
  }

  destroy() {
    this._loadId++;

    if (this._abort) {
      this._abort.abort();
      this._abort = null;
    }

    if (this.hlsInstance) {
      try { this.hlsInstance.destroy(); } catch (_) {}
      this.hlsInstance = null;
    }

    if (this.dashInstance) {
      try { this.dashInstance.reset(); } catch (_) {}
      this.dashInstance = null;
    }

    const el = this.activeElement;
    if (el) {
      if (el instanceof HTMLMediaElement) {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } else {
        el.removeAttribute('src');
      }
      el.remove();
      this.activeElement = null;
    }

    if (this.activeBlobUrl) {
      URL.revokeObjectURL(this.activeBlobUrl);
      this.activeBlobUrl = null;
    }

    this._hlsRetries = 0;
  }
}

QPlay.Error = QPlayError;

// Exportación Universal (UMD)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = QPlay;
} else if (typeof define === 'function' && define.amd) {
  define([], () => QPlay);
} else {
  (typeof globalThis !== 'undefined' ? globalThis : window).QPlay = QPlay;
}