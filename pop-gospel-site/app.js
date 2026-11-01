const $ = id => document.getElementById(id);

const state = {
  tracks: [],
  playlists: [],
  queue: [],
  index: -1,
  currentId: null,
  live: false,
  isLive: true
};

const audio = $('audio');
const API_BASE = `${location.origin}/pop-gospel/api`;
const STREAM_URL = `${location.origin}/pop-gospel/radio.mp3`;

function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
}

function setMessage(message = '') {
  $('player-message').textContent = message;
}

function setStatus() {
  $('status').textContent = state.live
    ? 'NO AR • TRANSMISSÃO AO VIVO'
    : 'PLAYER ONLINE • AGUARDANDO SINAL';
}

function selectedPlaylist() {
  const id = $('playlist-select').value;
  return state.playlists.find(playlist => playlist.id === id) || null;
}

function getVisibleTracks() {
  const playlist = selectedPlaylist();
  if (!playlist) return state.tracks.slice();
  const byId = new Map(state.tracks.map(track => [track.id, track]));
  return (Array.isArray(playlist.trackIds) ? playlist.trackIds : [])
    .map(id => byId.get(id))
    .filter(Boolean);
}

function updatePlaylistOptions(selectedId) {
  const select = $('playlist-select');
  const options = ['<option value="all">Todas as músicas</option>'];

  for (const playlist of state.playlists) {
    const count = Array.isArray(playlist.trackIds) ? playlist.trackIds.length : 0;
    options.push(
      `<option value="${escapeHTML(playlist.id)}">${escapeHTML(playlist.name)} (${count})</option>`
    );
  }

  select.innerHTML = options.join('');
  const exists = state.playlists.some(playlist => playlist.id === selectedId);
  select.value = exists ? selectedId : 'all';
}

function updateTrackButtons() {
  document.querySelectorAll('[data-play]').forEach(button => {
    const isCurrent = button.dataset.play === state.currentId;
    button.textContent = isCurrent && !audio.paused ? 'Ⅱ' : '▶';
    button.setAttribute('aria-label', `${isCurrent && !audio.paused ? 'Pausar' : 'Tocar'} ${button.dataset.title || 'música'}`);
    const row = button.closest('.track');
    if (row) row.classList.toggle('is-active', isCurrent);
  });
}

function renderTracks() {
  const list = getVisibleTracks();
  const container = $('tracks');

  if (!list.length) {
    const playlist = selectedPlaylist();
    container.innerHTML = playlist
      ? `<div class="empty-state"><span>♫</span><div><strong>${escapeHTML(playlist.name)}</strong><br>Esta playlist ainda não tem músicas. Adicione faixas pelo painel.</div></div>`
      : '<div class="empty-state"><span>♫</span><div><strong>A programação começa aqui.</strong><br>As músicas enviadas pelo painel aparecerão nesta área.</div></div>';
    return;
  }

  container.innerHTML = list.map(track => {
    const title = escapeHTML(track.title || 'Faixa sem título');
    const artist = escapeHTML(track.artist || 'Radio Pop Gospel');
    const isCurrent = track.id === state.currentId;
    const isPlaying = isCurrent && !audio.paused;
    return `<article class="track${isCurrent ? ' is-active' : ''}">
      <div class="track-art" aria-hidden="true">♫</div>
      <div class="track-info"><strong>${title}</strong><small>${artist}</small></div>
      <button type="button" data-play="${escapeHTML(track.id)}" data-title="${title}" aria-label="${isPlaying ? 'Pausar' : 'Tocar'} ${title}">${isPlaying ? 'Ⅱ' : '▶'}</button>
    </article>`;
  }).join('');
}

function syncPlayerLabels() {
  $('elapsed').textContent = formatTime(audio.currentTime);
  $('duration').textContent = state.isLive ? 'AO VIVO' : formatTime(audio.duration);
  $('seek').value = !state.isLive && audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  $('seek').disabled = state.isLive || !Number.isFinite(audio.duration) || audio.duration <= 0;
  $('play').textContent = audio.paused ? '▶' : 'Ⅱ';
  $('play').setAttribute('aria-label', audio.paused ? 'Reproduzir' : 'Pausar');
  $('play').title = audio.paused ? 'Reproduzir' : 'Pausar';
  document.body.classList.toggle('is-playing', !audio.paused);
  updateTrackButtons();
}

function stopAndClear(message) {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  state.currentId = null;
  state.index = -1;
  state.isLive = false;
  $('track-title').textContent = 'Escolha uma música';
  $('track-artist').textContent = 'A programação começa aqui';
  setMessage(message || '');
  syncPlayerLabels();
}

function buildQueue(preserveCurrent = true) {
  const previousId = preserveCurrent ? state.currentId : null;
  state.queue = getVisibleTracks();
  const preservedIndex = previousId
    ? state.queue.findIndex(track => track.id === previousId)
    : -1;

  if (preservedIndex >= 0) {
    state.index = preservedIndex;
  } else if (state.queue.length) {
    state.index = 0;
    if (previousId) stopAndClear('A faixa atual não está nesta playlist. Escolha outra música.');
  } else {
    state.index = -1;
    stopAndClear('Nenhuma música nesta seleção. Escolha outra playlist ou adicione faixas no painel.');
  }

  renderTracks();
  if (preservedIndex >= 0) updateTrackButtons();
}

async function selectTrack(index, autoplay = true) {
  if (!state.queue.length) {
    setMessage('Não há músicas nesta playlist.');
    return;
  }

  const nextIndex = (index + state.queue.length) % state.queue.length;
  const track = state.queue[nextIndex];
  state.index = nextIndex;
  state.currentId = track.id;
  state.isLive = false;
  audio.pause();
  audio.src = `${API_BASE}/audio/${encodeURIComponent(track.id)}`;
  audio.load();

  $('track-title').textContent = track.title || 'Faixa sem título';
  $('track-artist').textContent = track.artist || 'Radio Pop Gospel';
  setMessage('');
  renderTracks();
  syncPlayerLabels();

  if (autoplay) {
    try {
      await audio.play();
      setMessage('');
    } catch {
      setMessage('Toque em reproduzir para começar a ouvir.');
    }
  }
}

async function load() {
  $('tracks').innerHTML = '<div class="loading-state"><span class="loader"></span><p>Carregando a programação...</p></div>';
  try {
    const response = await fetch(`${API_BASE}/public`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Não foi possível acessar a programação.');
    const data = await response.json();

    state.tracks = Array.isArray(data.tracks) ? data.tracks : [];
    state.playlists = Array.isArray(data.playlists) ? data.playlists : [];
    state.live = data.live === true;

    $('tagline').textContent = data.tagline || 'Louvor que toca o coração';
    updatePlaylistOptions(data.selectedPlaylistId || 'all');
    setStatus();
    buildQueue(false);

    state.isLive = true;
    state.currentId = null;
    audio.pause();
    audio.src = STREAM_URL;
    audio.load();
    $('track-title').textContent = 'Radio Pop Gospel • AO VIVO';
    $('track-artist').textContent = 'Uma nova vibe. A mesma fé.';
    setMessage(state.live ? 'Conectado à transmissão ao vivo.' : 'Aguardando o sinal ao vivo.');
    syncPlayerLabels();
  } catch (error) {
    $('tracks').innerHTML = `<div class="error-state">${escapeHTML(error.message || 'Não foi possível carregar a programação.')}</div>`;
    $('playlist-select').innerHTML = '<option value="all">Programação indisponível</option>';
    setMessage('Verifique a conexão com a rádio e tente novamente.');
    $('status').textContent = 'CONECTANDO À RÁDIO';
  }
}

$('tracks').addEventListener('click', event => {
  const button = event.target.closest('[data-play]');
  if (!button) return;
  const index = state.queue.findIndex(track => track.id === button.dataset.play);
  if (index < 0) return;

  if (state.currentId === button.dataset.play && !audio.paused) {
    audio.pause();
  } else if (state.currentId === button.dataset.play && audio.paused && audio.src) {
    audio.play().catch(() => setMessage('Não foi possível iniciar a reprodução.'));
  } else {
    selectTrack(index, true);
  }
});

$('playlist-select').addEventListener('change', () => {
  const oldId = state.currentId;
  const wasPlaying = !audio.paused;
  buildQueue(true);
  if (oldId && state.currentId === oldId && wasPlaying) {
    audio.play().catch(() => setMessage('Toque em reproduzir para continuar.'));
  } else if (state.queue.length) {
    selectTrack(0, false);
  }
});

$('play').addEventListener('click', () => {
  if (state.isLive) {
    if (audio.paused) audio.play().catch(() => setMessage('A transmissão ainda não está disponível. Tente novamente em instantes.'));
    else audio.pause();
    return;
  }
  if (!state.queue.length) {
    setMessage('Ainda não há músicas nesta seleção.');
    return;
  }
  if (!audio.src || !state.currentId) {
    selectTrack(Math.max(state.index, 0), true);
  } else if (audio.paused) {
    audio.play().catch(() => setMessage('Não foi possível iniciar a reprodução.'));
  } else {
    audio.pause();
  }
});

$('prev').addEventListener('click', () => {
  if (state.queue.length) selectTrack(state.index <= 0 ? state.queue.length - 1 : state.index - 1, true);
});

$('next').addEventListener('click', () => {
  if (state.queue.length) selectTrack(state.index + 1, true);
});

audio.addEventListener('play', () => { setMessage(''); syncPlayerLabels(); });
audio.addEventListener('pause', syncPlayerLabels);
audio.addEventListener('ended', () => {
  if (state.queue.length) selectTrack(state.index + 1, true);
});
audio.addEventListener('timeupdate', syncPlayerLabels);
audio.addEventListener('loadedmetadata', syncPlayerLabels);
audio.addEventListener('durationchange', syncPlayerLabels);
audio.addEventListener('waiting', () => setMessage('Carregando áudio...'));
audio.addEventListener('playing', () => setMessage(''));
audio.addEventListener('error', () => {
  if (state.isLive) setMessage('A transmissão ao vivo está reconectando.');
  else if (state.currentId) setMessage('Não foi possível carregar esta música. Verifique o arquivo no painel.');
  syncPlayerLabels();
});

$('seek').addEventListener('input', () => {
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    $('elapsed').textContent = formatTime((Number($('seek').value) / 100) * audio.duration);
  }
});
$('seek').addEventListener('change', () => {
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    audio.currentTime = (Number($('seek').value) / 100) * audio.duration;
  }
});
$('volume').addEventListener('input', () => { audio.volume = Number($('volume').value); });
audio.volume = Number($('volume').value);

async function refreshLiveStatus(){try{const r=await fetch(`${API_BASE}/status`,{cache:'no-store'});if(!r.ok)return;const d=await r.json();state.live=!!d.onAir;setStatus();if(state.isLive&&d.currentTrack)$('track-title').textContent=d.currentTrack.includes('AO VIVO')?'Radio Pop Gospel • AO VIVO':d.currentTrack;}catch{}}

load();
setInterval(refreshLiveStatus,15000);
