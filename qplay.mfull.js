/**
 * QPlay.js v5.5.0 MFULL
 * Engine multimedia agnóstico en Vanilla JavaScript.
 * © Quail Software 2026
 */

class QPlayError extends Error {
  constructor(message, code = 'QPLAY_ERROR') {
    super(message);
    this.name = 'QPlayError';
    this.code = code;
  }
}

class QPlay {
  constructor(container, options = {}) {
    if (!(container instanceof HTMLElement)) {
      throw new QPlayError('Contenedor inválido provisto a QPlay.', 'INVALID_CONTAINER');
    }

    this.container = container;
    this.options = Object.assign({
      autoplay: true,
      controls: false,
      muted: false,
      loop: false,
      volume: 0.8
    }, options);

    this.playlist = [];
    this.currentIndex = -1;
    this.activeElement = null;
    this.events = {};
    
    // Web Audio API
    this.audioCtx = null;
    this.audioSource = null;
    this.gainNode = null;
    this.boostNode = null;
    this.eqFilters = [];

    // Estado MFULL v5.5.0
    this.playbackRate = 1.0;
    this.pitch = 1.0;
    this.isPitchLinked = false;
    this.extraVolumeBoost = 1.0; // Hasta 3.0x (300%)
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.isRecording = false;

    this._initContainer();
  }

  _initContainer() {
    this.container.style.position = 'relative';
    this.container.style.overflow = 'hidden';
    this.container.style.display = 'flex';
    this.container.style.alignItems = 'center';
    this.container.style.justifyContent = 'center';
  }

  // --- WEBAUDIO & EQ & VOLUMEN EXTRA ---
  _initAudioContext(mediaElement) {
    if (this.audioCtx) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      this.audioCtx = new AudioCtx();
      this.audioSource = this.audioCtx.createMediaElementSource(mediaElement);

      // Ecualizador 5 bandas (60Hz, 230Hz, 910Hz, 3.6kHz, 14kHz)
      const freqs = [60, 230, 910, 3600, 14000];
      this.eqFilters = freqs.map(freq => {
        const filter = this.audioCtx.createBiquadFilter();
        filter.type = freq <= 60 ? 'lowshelf' : (freq >= 14000 ? 'highshelf' : 'peaking');
        filter.frequency.value = freq;
        filter.gain.value = 0;
        return filter;
      });

      // Nodo de Boost para volumen extra (>100% a 300%)
      this.boostNode = this.audioCtx.createGain();
      this.boostNode.gain.value = this.extraVolumeBoost;

      // Conexión de cadena de audio
      let lastNode = this.audioSource;
      this.eqFilters.forEach(filter => {
        lastNode.connect(filter);
        lastNode = filter;
      });
      lastNode.connect(this.boostNode);
      this.boostNode.connect(this.audioCtx.destination);
    } catch (e) {
      console.warn('[QPlay MFULL] WebAudio restringido o ya inicializado:', e.message);
    }
  }

  setExtraVolume(factor = 1.0) {
    this.extraVolumeBoost = Math.max(1.0, Math.min(3.0, parseFloat(factor)));
    if (this.boostNode && this.audioCtx) {
      this.boostNode.gain.setValueAtTime(this.extraVolumeBoost, this.audioCtx.currentTime);
    }
  }

  setEQ(bandIndex, gainDb) {
    if (this.eqFilters[bandIndex] && this.audioCtx) {
      this.eqFilters[bandIndex].gain.setValueAtTime(parseFloat(gainDb), this.audioCtx.currentTime);
    }
  }

  // --- DESLIZADOR UNIDO TONO Y VELOCIDAD ---
  setPlaybackRate(rate) {
    this.playbackRate = parseFloat(rate);
    if (this.activeElement instanceof HTMLMediaElement) {
      this.activeElement.playbackRate = this.playbackRate;
      if (this.isPitchLinked) {
        this.activeElement.preservesPitch = false;
        this.pitch = this.playbackRate;
      } else {
        this.activeElement.preservesPitch = true;
      }
    }
  }

  setPitch(pitch) {
    this.pitch = parseFloat(pitch);
    if (this.activeElement instanceof HTMLMediaElement) {
      if (!this.isPitchLinked) {
        this.activeElement.preservesPitch = (this.pitch === 1.0);
      }
    }
  }

  linkPitchAndSpeed(enable = true) {
    this.isPitchLinked = Boolean(enable);
    this.setPlaybackRate(this.playbackRate);
  }

  // --- SUBTÍTULOS LOCALES (.vtt, .srt, .ass, .sub) ---
  async loadLocalSubtitle(file) {
    if (!(file instanceof File) || !this.activeElement || !(this.activeElement instanceof HTMLMediaElement)) {
      throw new QPlayError('Archivo de subtítulos o elemento multimedia no válido.', 'INVALID_SUBTITLE');
    }

    const text = await file.text();
    const extension = file.name.split('.').pop().toLowerCase();
    let vttContent = text;

    if (extension === 'srt') {
      vttContent = 'WEBVTT\n\n' + text.replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2');
    } else if (extension === 'ass' || extension === 'sub') {
      // Conversión básica de diálogos ASS/SUB a VTT
      const lines = text.split('\n');
      let cues = 'WEBVTT\n\n';
      lines.forEach(line => {
        if (line.startsWith('Dialogue:')) {
          const parts = line.split(',');
          if (parts.length >= 10) {
            const start = parts[1].trim();
            const end = parts[2].trim();
            const dialogueText = parts.slice(9).join(',').replace(/\\N/g, '\n').replace(/\{[^}]+\}/g, '');
            cues += `${start} --> ${end}\n${dialogueText}\n\n`;
          }
        }
      });
      vttContent = cues;
    }

    const blob = new Blob([vttContent], { type: 'text/vtt' });
    const trackUrl = URL.createObjectURL(blob);
    this.addSubtitleTrack(trackUrl, file.name, 'es');
  }

  addSubtitleTrack(src, label = 'Subtítulo', srclang = 'es') {
    if (this.activeElement instanceof HTMLMediaElement) {
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = label;
      track.srclang = srclang;
      track.src = src;
      track.default = true;
      this.activeElement.appendChild(track);
      track.track.mode = 'showing';
    }
  }

  // --- GRABADOR DE AUDIO Y VIDEO ---
  startRecording() {
    if (this.isRecording) return;
    if (!this.activeElement || !(this.activeElement instanceof HTMLVideoElement || this.activeElement instanceof HTMLAudioElement)) {
      throw new QPlayError('No hay reproducción activa para grabar.', 'NO_ACTIVE_MEDIA');
    }

    let stream = null;
    if (typeof this.activeElement.captureStream === 'function') {
      stream = this.activeElement.captureStream();
    } else if (typeof this.activeElement.mozCaptureStream === 'function') {
      stream = this.activeElement.mozCaptureStream();
    } else {
      throw new QPlayError('captureStream no está soportado en este navegador.', 'NOT_SUPPORTED');
    }

    this.recordedChunks = [];
    this.mediaRecorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : 'video/mp4' });

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.recordedChunks.push(e.data);
    };

    this.mediaRecorder.start();
    this.isRecording = true;
    this._emit('recordingstart');
  }

  stopRecording() {
    return new Promise((resolve, reject) => {
      if (!this.isRecording || !this.mediaRecorder) {
        return reject(new QPlayError('No hay una grabación activa.', 'NOT_RECORDING'));
      }

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.recordedChunks, { type: this.mediaRecorder.mimeType });
        this.isRecording = false;
        this.recordedChunks = [];
        this._emit('recordingstop', { blob });
        resolve(blob);
      };

      this.mediaRecorder.stop();
    });
  }

  // --- REPRODUCCIÓN, LISTAS Y MÉTODOS CORE ---
  async load(source) {
    this._cleanupActiveElement();
    let mediaEl;

    const isAudio = (typeof source === 'string' && (source.endsWith('.mp3') || source.endsWith('.ogg') || source.endsWith('.wav'))) ||
                    (source instanceof File && source.type.startsWith('audio/'));

    mediaEl = document.createElement(isAudio ? 'audio' : 'video');
    mediaEl.style.width = '100%';
    mediaEl.style.height = '100%';
    mediaEl.style.objectFit = 'contain';
    mediaEl.controls = this.options.controls;

    if (source instanceof File) {
      mediaEl.src = URL.createObjectURL(source);
    } else if (typeof source === 'string') {
      mediaEl.src = source;
    }

    this.container.appendChild(mediaEl);
    this.activeElement = mediaEl;

    this._bindMediaEvents(mediaEl);
    if (this.options.autoplay) {
      try { await mediaEl.play(); } catch(e) {}
    }

    const category = isAudio ? 'audio' : 'video';
    this._emit('trackchange', { index: this.currentIndex, item: source, category, element: mediaEl });
  }

  async loadPlaylist(playlist, startIdx = 0) {
    this.playlist = Array.isArray(playlist) ? playlist : [playlist];
    this.currentIndex = Math.max(0, Math.min(startIdx, this.playlist.length - 1));
    if (this.playlist.length > 0) {
      await this.load(this.playlist[this.currentIndex]);
    }
  }

  playIndex(index) {
    if (index >= 0 && index < this.playlist.length) {
      this.currentIndex = index;
      this.load(this.playlist[index]);
    }
  }

  next() {
    if (this.playlist.length === 0) return;
    this.currentIndex = (this.currentIndex + 1) % this.playlist.length;
    this.playIndex(this.currentIndex);
  }

  previous() {
    if (this.playlist.length === 0) return;
    this.currentIndex = (this.currentIndex - 1 + this.playlist.length) % this.playlist.length;
    this.playIndex(this.currentIndex);
  }

  play() { if (this.activeElement) this.activeElement.play(); }
  pause() { if (this.activeElement) this.activeElement.pause(); }
  seek(seconds) { if (this.activeElement) this.activeElement.currentTime = seconds; }
  forward(s = 10) { if (this.activeElement) this.activeElement.currentTime += s; }
  rewind(s = 10) { if (this.activeElement) this.activeElement.currentTime -= s; }

  setVolume(val) {
    if (this.activeElement) {
      this.activeElement.volume = Math.max(0, Math.min(1, parseFloat(val)));
    }
  }

  toggleMute() {
    if (this.activeElement) {
      this.activeElement.muted = !this.activeElement.muted;
      return this.activeElement.muted;
    }
    return false;
  }

  async togglePiP() {
    if (this.activeElement instanceof HTMLVideoElement) {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await this.activeElement.requestPictureInPicture();
      }
    }
  }

  async snapshot() {
    if (!(this.activeElement instanceof HTMLVideoElement)) return null;
    const canvas = document.createElement('canvas');
    canvas.width = this.activeElement.videoWidth || 1280;
    canvas.height = this.activeElement.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(this.activeElement, 0, 0, canvas.width, canvas.height);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  }

  _cleanupActiveElement() {
    if (this.activeElement) {
      if (this.activeElement.src && this.activeElement.src.startsWith('blob:')) {
        URL.revokeObjectURL(this.activeElement.src);
      }
      this.activeElement.remove();
      this.activeElement = null;
    }
  }

  _bindMediaEvents(el) {
    el.addEventListener('play', () => this._emit('play'));
    el.addEventListener('pause', () => this._emit('pause'));
    el.addEventListener('ended', () => {
      this._emit('ended');
      this.next();
    });
    el.addEventListener('timeupdate', () => {
      this._initAudioContext(el);
      this._emit('timeupdate', {
        currentTime: el.currentTime,
        duration: el.duration,
        progress: el.duration > 0 ? (el.currentTime / el.duration) * 100 : 0
      });
    });
    el.addEventListener('error', (e) => this._emit('error', new QPlayError('Error en el elemento multimedia.', 'MEDIA_ELEMENT_ERROR')));
  }

  on(event, handler) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(handler);
  }

  _emit(event, payload) {
    if (this.events[event]) {
      this.events[event].forEach(fn => fn(payload));
    }
  }

  destroy() {
    this._cleanupActiveElement();
    if (this.audioCtx) this.audioCtx.close();
    this.container.innerHTML = '';
    this.events = {};
  }
}

window.QPlay = QPlay;