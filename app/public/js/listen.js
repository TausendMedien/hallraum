// Public player: an episode (chapters, live transcript, search) or a topic playlist.
const STRINGS = JSON.parse(document.getElementById('i18n')?.textContent || '{}');
const t = (key, vars) => {
  let s = STRINGS[`player.${key}`] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return s;
};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const player = $('#player');
if (player) {
  const audio = $('audio', player);
  const seek = $('.seek', player);
  const now = $('.now', player);
  const rateSel = $('[data-act=rate]', player);
  const savedRate = store.get('rate');
  if (savedRate) { audio.playbackRate = savedRate; rateSel.value = String(savedRate); }

  const btn = (act, fn) => $$(`[data-act=${act}]`, player).forEach((b) => b.addEventListener('click', fn));
  btn('back', () => { audio.currentTime = Math.max(0, audio.currentTime - 15); });
  btn('fwd', () => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + 15); });
  btn('toggle', () => (audio.paused ? audio.play() : audio.pause()));
  rateSel.addEventListener('change', () => { audio.playbackRate = Number(rateSel.value); store.set('rate', audio.playbackRate); });

  const playBtn = $('.play', player);
  const syncPlay = () => { if (playBtn) { playBtn.textContent = audio.paused ? '▶' : '❚❚'; playBtn.setAttribute('aria-label', audio.paused ? t('play') : t('pause')); } };
  audio.addEventListener('play', syncPlay);
  audio.addEventListener('pause', syncPlay);

  // Keyboard: space = play/pause, arrows = ±15 s (not inside form fields)
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, button, a')) return;
    if (e.key === ' ') { e.preventDefault(); audio.paused ? audio.play() : audio.pause(); }
    if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 15);
    if (e.key === 'ArrowRight') audio.currentTime += 15;
  });

  if (player.dataset.mode === 'episode') initEpisode(); else initPlaylist();

  function initEpisode() {
    const epId = player.dataset.episode;
    const posKey = `pos:${epId}`;
    const cur = $('[data-cur]', player), dur = $('[data-dur]', player);
    const words = $$('#transcript span[data-s]');
    const starts = words.map((w) => Number(w.dataset.s));
    const chapters = $$('.chapters li');
    const chStarts = chapters.map((c) => Number(c.dataset.start));
    const follow = $('#follow');
    let active = null, activeCh = null, userScrolled = 0;

    // Start position: ?t= in the URL, otherwise the remembered position
    const t = Number(new URLSearchParams(location.search).get('t'));
    const saved = store.get(posKey);
    const startAt = Number.isFinite(t) && t > 0 ? t : saved || 0;
    if (startAt) audio.addEventListener('loadedmetadata', () => { audio.currentTime = startAt; }, { once: true });
    if (startAt && audio.preload !== 'none') audio.load();

    audio.addEventListener('loadedmetadata', () => { seek.max = Math.ceil(audio.duration); dur.textContent = fmt(audio.duration); });
    seek.addEventListener('input', () => { audio.currentTime = Number(seek.value); });

    const findIdx = (arr, time) => { // last index with arr[i] <= time
      let lo = 0, hi = arr.length - 1, ans = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= time) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
      return ans;
    };
    window.addEventListener('wheel', () => { userScrolled = Date.now(); }, { passive: true });
    window.addEventListener('touchmove', () => { userScrolled = Date.now(); }, { passive: true });

    let lastSave = 0;
    audio.addEventListener('timeupdate', () => {
      const time = audio.currentTime;
      cur.textContent = fmt(time);
      if (document.activeElement !== seek) seek.value = Math.floor(time);
      if (Date.now() - lastSave > 3000) { store.set(posKey, time); lastSave = Date.now(); }
      const wi = findIdx(starts, time + 0.05);
      const w = words[wi];
      if (w !== active) {
        active?.classList.remove('on');
        w?.classList.add('on');
        active = w;
        if (w && follow?.checked && !audio.paused && Date.now() - userScrolled > 4000) {
          const r = w.getBoundingClientRect();
          if (r.top < 120 || r.bottom > innerHeight - 80) w.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
      const ci = findIdx(chStarts, time + 0.05);
      const ch = chapters[ci];
      if (ch !== activeCh) {
        activeCh?.classList.remove('on'); activeCh?.removeAttribute('aria-current');
        ch?.classList.add('on'); ch?.setAttribute('aria-current', 'true');
        activeCh = ch;
        if (now) now.textContent = ch ? t('currentChapter', { title: $('a', ch).textContent.trim() }) : '';
      }
    });

    const jump = (sec) => { audio.currentTime = sec; if (audio.paused) audio.play(); };
    document.addEventListener('click', (e) => {
      const s = e.target.closest('[data-seek]');
      if (s) { e.preventDefault(); jump(Number(s.dataset.seek)); return; }
      const w = e.target.closest('#transcript span[data-s]');
      if (w) jump(Number(w.dataset.s));
    });

    btn('share', async () => {
      const url = `${location.origin}${location.pathname}?t=${Math.floor(audio.currentTime)}`;
      try { await navigator.clipboard.writeText(url); now.textContent = t('linkCopied'); }
      catch { prompt(t('linkToPosition'), url); }
    });

    // Search within the episode
    const tq = $('#tq'), tcount = $('.tcount');
    if (tq) {
      let hits = [], pos = 0;
      const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N} ]/gu, '');
      const texts = words.map((w) => norm(w.textContent));
      tq.addEventListener('input', () => {
        hits.forEach((i) => words[i].classList.remove('hit'));
        hits = []; pos = 0;
        const q = norm(tq.value.trim()).split(/\s+/).filter(Boolean);
        if (!q.length) { tcount.textContent = ''; return; }
        for (let i = 0; i < texts.length; i++) {
          if (q.every((part, k) => (texts[i + k] || '').startsWith(part))) for (let k = 0; k < q.length; k++) hits.push(i + k);
        }
        hits.forEach((i) => words[i].classList.add('hit'));
        tcount.textContent = hits.length ? t('hitsEnter', { n: hits.length / q.length }) : t('noHits');
        if (hits.length) words[hits[0]].scrollIntoView({ block: 'center' });
        tq.dataset.len = q.length;
      });
      tq.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !hits.length) return;
        e.preventDefault();
        pos = (pos + Number(tq.dataset.len)) % hits.length;
        words[hits[pos]].scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }
  }

  function initPlaylist() {
    const list = JSON.parse($('#playlist-data').textContent);
    const items = $$('.playlist li');
    let idx = -1;
    const playItem = (n) => {
      if (n >= list.length) { audio.pause(); now.textContent = t('playlistEnd'); items[idx]?.classList.remove('on'); idx = -1; return; }
      idx = n;
      const it = list[n];
      items.forEach((li, i) => li.classList.toggle('on', i === n));
      now.textContent = `${n + 1}/${list.length}: ${it.title || t('section')} – ${it.episode} (${fmt(it.start)})`;
      const go = () => { audio.currentTime = it.start; audio.play(); };
      if (!audio.src.endsWith(it.audio)) { audio.src = it.audio; audio.addEventListener('loadedmetadata', go, { once: true }); audio.load(); }
      else go();
    };
    audio.addEventListener('timeupdate', () => {
      if (idx < 0) return;
      const it = list[idx];
      seek.value = Math.round(((audio.currentTime - it.start) / (it.end - it.start)) * 1000);
      if (audio.currentTime >= it.end) playItem(idx + 1);
    });
    seek.addEventListener('input', () => { if (idx >= 0) { const it = list[idx]; audio.currentTime = it.start + (seek.value / 1000) * (it.end - it.start); } });
    btn('playall', () => playItem(0));
    btn('next', () => playItem(idx + 1));
    $$('[data-play]').forEach((b) => b.addEventListener('click', () => playItem(Number(b.dataset.play))));
    // Play/pause without a chosen section starts the playlist
    $$('[data-act=toggle]', player).forEach((b) => b.addEventListener('click', (e) => { if (idx < 0) { e.stopImmediatePropagation(); audio.pause(); playItem(0); } }, true));
  }
}
