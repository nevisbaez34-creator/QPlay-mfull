# 🎵 QPlay.js (v5.5.0-MFULL)

Librería multimedia universal, agnóstica y 100% pura en Vanilla JavaScript para la reproducción de audio, video, imágenes y streams adaptativos (HLS / DASH), equipada con un ecualizador Web Audio API de 5 bandas, control de velocidad, modo PiP y captura de snapshots.

---

## 📦 Características Principales
* **Agnóstica y Universal**: Soporta HTML5 nativo, Blob URLs, archivos locales (`File`), HLS (`.m3u8`) y DASH (`.mpd`).
* **Ecualizador Integrado**: Control de ganancia en tiempo real mediante la Web Audio API (5 bandas).
* **Gestión de Playlists**: Modos Shuffle (aleatorio), Repeat (off / one / all) y navegación fluida.
* **Funciones Avanzadas (MFULL)**: Control de velocidad (`playbackRate`), Picture-in-Picture (PiP), subtítulos WebVTT y exportación de fotogramas (`snapshot`).

---

## 🌐 CDN Oficial (jsDelivr)

Puedes integrar **QPlay.js MFULL** directamente en tus páginas web mediante CDN sin necesidad de descargar archivos locales:

```html
<script src="https://cdn.jsdelivr.net/gh/nevisbaez34-creator/QPlay-mfull@main/qplay.mfull.js"></script>
🚀 1. Uso en HTML Puro / Vanilla JavaScript
Implementación directa utilizando un contenedor <div> y el script de la CDN.

HTML
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>QPlay.js Demo</title>
</head>
<body>

    <!-- Contenedor del reproductor -->
    <div id="player-container" style="width: 640px; height: 360px;"></div>

    <button id="play-btn">Play / Pause</button>
    <button id="next-btn">Siguiente</button>

    <!-- Cargar QPlay.js desde la CDN -->
    <script src="[https://cdn.jsdelivr.net/gh/nevisbaez34-creator/QPlay-mfull@main/qplay.mfull.js](https://cdn.jsdelivr.net/gh/nevisbaez34-creator/QPlay-mfull@main/qplay.mfull.js)"></script>
    <script>
        // Inicializar QPlay
        const player = new QPlay('#player-container', {
            autoplay: false,
            controls: true
        });

        // Cargar una playlist
        player.loadPlaylist([
            '[https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4](https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4)',
            '[https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4](https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4)'
        ], 0);

        // Controles de botones
        document.getElementById('play-btn').addEventListener('click', () => {
            if (player.activeElement.paused) {
                player.play();
            } else {
                player.pause();
            }
        });

        document.getElementById('next-btn').addEventListener('click', () => {
            player.next();
        });

        // Escuchar eventos
        player.on('trackchange', (e) => {
            console.log('Reproduciendo pista índice:', e.index);
        });
    </script>
</body>
</html>
⚛️ 2. Uso en React
Ejemplo de integración usando un componente funcional y el ciclo de vida con useRef y useEffect. (Puedes importar el script globalmente en tu index.html o cargar el archivo localmente).

JavaScript
import React, { useEffect, useRef } from 'react';

export default function VideoPlayerComponent() {
  const containerRef = useRef(null);
  const playerRef = useRef(null);

  useEffect(() => {
    // Inicializar QPlay en el contenedor del DOM
    if (containerRef.current && window.QPlay) {
      playerRef.current = new window.QPlay(containerRef.current, {
        controls: true,
        autoplay: false
      });

      // Cargar recurso inicial
      playerRef.current.load('[https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4](https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4)');
    }

    // Limpieza al desmontar el componente
    return () => {
      if (playerRef.current) {
        playerRef.current.destroy();
      }
    };
  }, []);

  const handleForward = () => {
    if (playerRef.current) playerRef.current.forward(10); // Adelantar 10s
  };

  return (
    <div style={{ padding: '20px' }}>
      <div ref={containerRef} style={{ width: '100%', maxWidth: '640px', height: '360px' }} />
      <button onClick={handleForward} style={{ marginTop: '10px' }}>Adelantar 10s</button>
    </div>
  );
}
🟢 3. Uso en Vue.js (Composition API)
Ejemplo práctico utilizando Vue 3 con la directiva ref y el hook onMounted / onUnmounted.

Fragmento de código
<template>
  <div class="player-wrapper">
    <!-- Contenedor donde QPlay montará el elemento multimedia -->
    <div ref="playerContainer" class="media-box"></div>
    <div class="controls">
      <button @click="togglePlay">Play / Pause</button>
      <button @click="setSpeed(1.5)">Velocidad 1.5x</button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';

const playerContainer = ref(null);
let player = null;

onMounted(() => {
  if (window.QPlay) {
    player = new window.QPlay(playerContainer.value, {
      controls: true,
      autoplay: false
    });

    player.load('[https://www.w3schools.com/html/mov_bbb.mp4](https://www.w3schools.com/html/mov_bbb.mp4)');
  }
});

onUnmounted(() => {
  if (player) {
    player.destroy();
  }
});

const togglePlay = () => {
  if (!player || !player.activeElement) return;
  if (player.activeElement.paused) {
    player.play();
  } else {
    player.pause();
  }
};

const setSpeed = (rate) => {
  if (player) {
    player.setPlaybackRate(rate);
  }
};
</script>

<style scoped>
.media-box {
  width: 100%;
  max-width: 640px;
  height: 360px;
  background: #000;
}
.controls {
  margin-top: 10px;
}
</style>
📚 Referencia de API y Métodos Principales
⚙️ Inicialización y Carga
new QPlay(container, options): Crea una instancia vinculada a un elemento DOM.

player.load(source, forcedMime): Carga un recurso (string URL, Blob o File).

player.loadPlaylist(itemsArray, startIndex): Carga un arreglo de elementos multimedia e inicia la reproducción en el índice indicado.

player.destroy(): Detiene la reproducción, libera memoria de blobs y limpia el DOM.

🎮 Controles de Reproducción
player.play() / player.pause(): Reproduce o pausa el medio actual.

player.next() / player.previous(): Navega entre los elementos de la playlist.

player.seek(seconds) / player.seekRelative(seconds): Salta a una posición específica o de manera relativa (forward / rewind).

player.setVolume(vol) / player.toggleMute(): Ajusta el volumen (0.0 a 1.0) o silencia el audio.

⚡ Funciones Especiales (MFULL)
player.setPlaybackRate(rate): Modifica la velocidad de reproducción (ej. 0.5, 1.0, 2.0).

player.setEQ(bandIndex, gainDb): Configura el ecualizador de 5 bandas (índices 0 al 4, ganancias de -20 a +20 dB).

player.togglePiP(): Activa o desactiva el modo Picture-in-Picture flotante para videos.

player.snapshot(): Retorna una promesa con un Blob (PNG) del fotograma actual del video o imagen.

player.addSubtitleTrack(src, label, language): Inserta subtítulos externos en formato WebVTT.

📡 Sistema de Eventos (player.on)
Permite suscribirse a los eventos del reproductor:

JavaScript
player.on('trackchange', (data) => { /* { index, item, element, category } */ });
player.on('timeupdate', (data) => { /* { currentTime, duration, progress } */ });
player.on('play', () => {});
player.on('pause', () => {});
player.on('ended', () => {});
player.on('error', (err) => { /* { code, message, recoverable } */ });
