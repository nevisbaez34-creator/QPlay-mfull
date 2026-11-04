/**
 * QPlay.js v6.6.0-MFULL - Librería Multimedia Agnóstica Universal y Avanzada
 * Soporte integrado para HLS, DASH, MP4, RTMP, RTSP y flujos de red avanzados.
 * Inyección autónoma de marca de agua en la esquina inferior derecha.
 * © Quail Software 2026
 */

class QPlayError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'QPlayError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

class QPlay {
  static get version() { return '6.6.0-MFULL'; }

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
      ...options
    };

    this.activeElement = null;
    this.activeBlobUrl = null;
    this.hlsInstance = null;
    this.dashInstance = null;

    this.playlist = [];
    this.currentIndex = -1;
    this.repeatMode = 'off';

    this.audioCtx = null;
    this.audioSourceNode = null;
    this.extraGainNode = null;
    this.eqFilters = [];
    this.extraVolume = 1.0;

    this.isPitchLinked = false;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.isRecording = false;

    this._loadId = 0;
    this._abort = null;
    this._listeners = {};

    this._setupContainer();
    this._injectWatermark();
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

  _injectWatermark() {
    if (document.getElementById('qplay-watermark-styles')) return;

    const style = document.createElement('style');
    style.id = 'qplay-watermark-styles';
    style.textContent = `
      .qplay-auto-watermark {
        position: absolute;
        bottom: 12px;
        right: 12px;
        z-index: 9999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 11px;
        font-weight: 700;
        color: rgba(240, 246, 252, 0.9);
        background: rgba(8, 13, 26, 0.75);
        padding: 5px 10px;
        border-radius: 6px;
        pointer-events: none;
        letter-spacing: 0.05em;
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border: 1px solid rgba(0, 242, 254, 0.25);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        user-select: none;
      }
      .qplay-auto-watermark span {
        color: #00f2fe;
      }
    `;
    document.head.appendChild(style);

    const badge = document.createElement('div');
    badge.className = 'qplay-auto-watermark';
    badge.innerHTML = `QPlay <span>v6.6.0 MFULL</span>`;
    this.container.appendChild(badge);
  }

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
      try { fn(detail); } catch (err) { console.error('[QPlay] Error en listener "' + type + '":', err); }
    });
  }

  async load(source, forcedMime = '') {
    this.destroy();
    const id = this._loadId;

    let mediaUrl = '';
    let mimeType = forcedMime;
    let hint = '';

    try {
      let resolvedSource = source;
      if (typeof source === 'object' && source !== null && source.url) {
        resolvedSource = source.url;
      }

      if (resolvedSource instanceof Blob || resolvedSource instanceof File) {
        this.activeBlobUrl = URL.createObjectURL(resolvedSource);
        mediaUrl = this.activeBlobUrl;
        hint = resolvedSource.name || '';
        mimeType = mimeType || resolvedSource.type || '';
      } else if (typeof resolvedSource === 'string') {
        mediaUrl = resolvedSource;
        hint = resolvedSource;
        mimeType = mimeType || await this._sniffUrl(mediaUrl);
      } else {
        throw new QPlayError('INVALID_SOURCE', '[QPlay] Fuente no válida.');
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
        case 'rtmp_rtsp':
          element = this._renderRtmpRtsp(mediaUrl);
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
        item: this.playlist[this.currentIndex] || source,
        element,
        category
      });
      this._probeAutoplay(element);
      return element;
    } catch (err) {
      if (id !== this._loadId) return null;
      const error = err instanceof QPlayError
        ? err
        : new QPlayError('LOAD_FAILED', '[QPlay] Error al cargar: ' + (err && err.message ? err.message : err), err);
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
      el.addEventListener('error', () => {
        const me = el.error;
        this._emit('error', {
          code: 'MEDIA_ERROR',
          message: (me && me.message) || 'Error de reproducción o protocolo incompatible.',
          recoverable: false
        });
      }, opt);
    }
  }

  _probeAutoplay(el) {
    if (!this.options.autoplay || !(el instanceof HTMLMediaElement)) return;
    const p = el.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        if (err && err.name === 'NotAllowedError') {
          this._emit('error', { code: 'PLAYBACK_BLOCKED', message: 'Autoplay bloqueado.', recoverable: true, error: err });
        }
      });
    }
  }

  _safePlay() {
    const p = this.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        if (err && err.name === 'AbortError') return;
        this._emit('error', { code: 'PLAY_FAILED', message: err?.message || 'Error al reproducir.', error: err });
      });
    }
  }

  _initEqualizer(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      if (!this.audioCtx) this.audioCtx = new AudioContext();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

      if (this.audioSourceNode) {
        try { this.audioSourceNode.disconnect(); } catch (_) {}
      }

      this.audioSourceNode = this.audioCtx.createMediaElementSource(el);
      const frequencies = [60, 230, 910, 3600, 14000];
      let lastNode = this.audioSourceNode;

      this.eqFilters = frequencies.map((freq) => {
        const filter = this.audioCtx.createBiquadFilter();
        filter.type = 'peaking';
        filter.frequency.value = freq;
        filter.Q.value = 1.0;
        filter.gain.value = 0;
        lastNode.connect(filter);
        lastNode = filter;
        return filter;
      });

      this.extraGainNode = this.audioCtx.createGain();
      this.extraGainNode.gain.value = this.extraVolume;
      lastNode.connect(this.extraGainNode);
      this.extraGainNode.connect(this.audioCtx.destination);
    } catch (e) {
      console.warn('[QPlay] Web Audio API restringido:', e.message);
    }
  }

  setExtraVolume(factor = 1.0) {
    this.extraVolume = Math.max(1.0, Math.min(3.0, parseFloat(factor)));
    if (this.extraGainNode && this.audioCtx) {
      this.extraGainNode.gain.setValueAtTime(this.extraVolume, this.audioCtx.currentTime);
    }
  }

  setEQ(bandIndex, gainDb) {
    if (this.eqFilters[bandIndex] && this.audioCtx) {
      this.eqFilters[bandIndex].gain.setValueAtTime(parseFloat(gainDb), this.audioCtx.currentTime);
    }
  }

  setPlaybackRate(rate) {
    if (this.activeElement instanceof HTMLMediaElement) {
      this.activeElement.playbackRate = parseFloat(rate);
      this.activeElement.preservesPitch = !this.isPitchLinked;
    }
  }

  linkPitchAndSpeed(enable = true) {
    this.isPitchLinked = Boolean(enable);
    if (this.activeElement instanceof HTMLMediaElement) {
      this.setPlaybackRate(this.activeElement.playbackRate);
    }
  }

  startRecording() {
    if (this.isRecording) return;
    if (!this.activeElement || !(this.activeElement instanceof HTMLMediaElement)) {
      throw new QPlayError('NO_ACTIVE_MEDIA', '[QPlay] No hay medio activo para grabar.');
    }
    const stream = typeof this.activeElement.captureStream === 'function' ? this.activeElement.captureStream() : null;
    if (!stream) throw new QPlayError('NOT_SUPPORTED', '[QPlay] captureStream no soportado.');

    this.recordedChunks = [];
    this.mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    this.mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) this.recordedChunks.push(e.data); };
    this.mediaRecorder.start();
    this.isRecording = true;
  }

  stopRecording() {
    return new Promise((resolve, reject) => {
      if (!this.isRecording || !this.mediaRecorder) return reject(new QPlayError('NOT_RECORDING', 'Sin grabación activa.'));
      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
        this.isRecording = false;
        this.recordedChunks = [];
        resolve(blob);
      };
      this.mediaRecorder.stop();
    });
  }

  async loadLocalSubtitle(file) {
    if (!(file instanceof File) || !(this.activeElement instanceof HTMLVideoElement)) return;
    const text = await file.text();
    const ext = file.name.split('.').pop().toLowerCase();
    let vtt = ext === 'srt' ? 'WEBVTT\n\n' + text.replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2') : text;
    const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
    const track = document.createElement('track');
    track.kind = 'subtitles'; track.label = file.name; track.srclang = 'es'; track.src = url; track.default = true;
    this.activeElement.appendChild(track);
  }

  setVolume(vol) { if (this.activeElement instanceof HTMLMediaElement) this.activeElement.volume = Math.max(0, Math.min(1, vol)); }
  toggleMute() { if (this.activeElement instanceof HTMLMediaElement) { this.activeElement.muted = !this.activeElement.muted; return this.activeElement.muted; } return false; }
  
  async togglePiP() {
    if (!(this.activeElement instanceof HTMLVideoElement)) return false;
    if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return false; }
    else if (document.pictureInPictureEnabled) { await this.activeElement.requestPictureInPicture(); return true; }
    return false;
  }

  async snapshot() {
    if (!this.activeElement) return null;
    const canvas = document.createElement('canvas');
    let w = this.activeElement.videoWidth || this.activeElement.naturalWidth || 0;
    let h = this.activeElement.videoHeight || this.activeElement.naturalHeight || 0;
    if (!w || !h) return null;
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(this.activeElement, 0, 0, w, h);
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  }

  async loadPlaylist(items = [], startIndex = 0) {
    if (!Array.isArray(items) || items.length === 0) return;
    this.playlist = [...items];
    return await this.playIndex(startIndex);
  }

  async playIndex(index) {
    if (index < 0 || index >= this.playlist.length) return;
    this.currentIndex = index;
    return await this.load(this.playlist[index]);
  }

  async next() { if (this.playlist.length) return await this.playIndex((this.currentIndex + 1) % this.playlist.length); }
  async previous() { if (this.playlist.length) return await this.playIndex((this.currentIndex - 1 + this.playlist.length) % this.playlist.length); }

  seek(time) {
    if (this.activeElement instanceof HTMLMediaElement && isFinite(this.activeElement.duration)) {
      this.activeElement.currentTime = Math.max(0, Math.min(this.activeElement.duration, time));
    }
  }

  async _sniffUrl(url) {
    const l = url.toLowerCase();
    if (l.includes('.m3u8')) return 'application/x-mpegURL';
    if (l.includes('.mpd')) return 'application/dash+xml';
    if (l.startsWith('rtmp://') || l.startsWith('rtsp://') || l.startsWith('fsv://')) return 'stream/network';
    return '';
  }

  _getCategory(mime, hint) {
    const m = String(mime).toLowerCase();
    const h = String(hint).toLowerCase();
    if (m.includes('mpegurl') || h.includes('.m3u8')) return 'hls';
    if (m.includes('dash') || h.includes('.mpd')) return 'dash';
    if (m.includes('stream/network') || h.startsWith('rtmp://') || h.startsWith('rtsp://') || h.startsWith('fsv://')) return 'rtmp_rtsp';
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('audio/')) return 'audio';
    return 'video';
  }

  _applyStyles(el) {
    el.style.width = '100%'; el.style.height = '100%'; el.style.objectFit = this.options.objectFit;
  }

  _mount(el) {
    this.container.appendChild(el);
    this.activeElement = el;
    return el;
  }

  _createMedia(tag, url) {
    const el = document.createElement(tag);
    el.controls = this.options.controls; el.autoplay = this.options.autoplay;
    el.muted = this.options.muted; el.loop = this.options.loop;
    if (this.options.crossOrigin) el.crossOrigin = this.options.crossOrigin;
    if (tag === 'video') { el.playsInline = true; this._applyStyles(el); }
    else { el.style.width = '90%'; el.style.maxWidth = '500px'; }
    if (url) el.src = url;
    return el;
  }

  _renderImage(url) {
    const img = document.createElement('img');
    img.src = url; this._applyStyles(img);
    return this._mount(img);
  }

  _renderVideo(url) { return this._mount(this._createMedia('video', url)); }
  _renderAudio(url) { return this._mount(this._createMedia('audio', url)); }

  _renderRtmpRtsp(url) {
    const video = this._createMedia('video', null);
    this._mount(video);
    // Nota: Los navegadores modernos requieren pasarelas o WebRTC/MSE para RTMP/RTSP directo, 
    // pero configuramos la fuente de red para integraciones o proxies compatibles.
    video.src = url;
    return video;
  }

  async _renderHLS(url, id) {
    const video = this._createMedia('video', null);
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url; return this._mount(video);
    }
    await this._loadScript(this.options.hlsUrl, 'Hls');
    if (id !== this._loadId) return null;
    const Hls = window.Hls;
    if (!Hls || !Hls.isSupported()) throw new QPlayError('UNSUPPORTED', 'HLS no soportado.');
    this._mount(video);
    this.hlsInstance = new Hls(this.options.hlsConfig);
    this.hlsInstance.loadSource(url);
    this.hlsInstance.attachMedia(video);
    return video;
  }

  async _renderDASH(url, id) {
    const video = this._createMedia('video', null);
    await this._loadScript(this.options.dashUrl, 'dashjs');
    if (id !== this._loadId) return null;
    if (!window.dashjs) throw new QPlayError('UNSUPPORTED', 'dash.js no disponible.');
    this._mount(video);
    this.dashInstance = window.dashjs.MediaPlayer().create();
    this.dashInstance.initialize(video, url, this.options.autoplay);
    return video;
  }

  _loadScript(src, globalName) {
    if (globalName && window[globalName]) return Promise.resolve();
    const cache = (QPlay._scripts = QPlay._scripts || {});
    if (cache[src]) return cache[src];
    cache[src] = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src; script.async = true;
      script.onload = () => resolve();
      script.onerror = () => { delete cache[src]; script.remove(); reject(new QPlayError('SCRIPT_LOAD_FAILED', src)); };
      document.head.appendChild(script);
    });
    return cache[src];
  }

  play() { if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume(); if (this.activeElement?.play) return this.activeElement.play(); }
  pause() { if (this.activeElement?.pause) this.activeElement.pause(); }

  destroy() {
    this._loadId++;
    if (this._abort) { this._abort.abort(); this._abort = null; }
    if (this.hlsInstance) { try { this.hlsInstance.destroy(); } catch (_) {} this.hlsInstance = null; }
    if (this.dashInstance) { try { this.dashInstance.reset(); } catch (_) {} this.dashInstance = null; }
    if (this.activeElement) {
      if (this.activeElement instanceof HTMLMediaElement) { this.activeElement.pause(); this.activeElement.removeAttribute('src'); this.activeElement.load(); }
      this.activeElement.remove(); this.activeElement = null;
    }
    if (this.activeBlobUrl) { URL.revokeObjectURL(this.activeBlobUrl); this.activeBlobUrl = null; }
  }
}

QPlay.Error = QPlayError;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = QPlay;
} else {
  (typeof globalThis !== 'undefined' ? globalThis : window).QPlay = QPlay;
}