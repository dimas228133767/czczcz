'use strict';

/* ═══════════════════════════════════════════════════════════
   FlashLingo — Clean Architecture Rewrite
   
   State model:
   - Store:      localStorage CRUD (pure functions, no side-effects)
   - AppState:   single in-memory object, mutated only via setState()
   - UI modules: Flashcard, Quiz — isolated state, own render functions
   - Wiring:     all event handlers attached once in init()
   ═══════════════════════════════════════════════════════════ */

// ── Constants ──────────────────────────────────────────────
const STORAGE_KEY    = 'flashlingo_sets';
const OLD_STORAGE_KEY= 'flashlingo_cards';
const SYNC_KEY       = 'flashlingo_sync';   // { apiKey, binId }
const DEBOUNCE_MS    = 300;
const JSONBIN_URL    = 'https://api.jsonbin.io/v3/b';

/* ═══════════════════════════════════════════════════════════
   STORE — localStorage abstraction
   All functions return data, never touch the DOM.
   ═══════════════════════════════════════════════════════════ */
const Store = {
  /** Load all sets (with migration from old flat format) */
  load() {
    try {
      let sets = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!sets) {
        const old = JSON.parse(localStorage.getItem(OLD_STORAGE_KEY));
        sets = old?.length
          ? [{ id: uid(), title: 'Мой первый модуль', cards: old.map(c => ({...c, correct:0, wrong:0})) }]
          : [];
        this.save(sets);
      }
      return sets;
    } catch { return []; }
  },

  save(sets) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sets));
    SyncService.push(sets); // push to cloud on every change
  },

  getSet(id)   { return this.load().find(s => s.id === id) || null; },
  getCards(id) { return this.getSet(id)?.cards ?? []; },

  createSet(title) {
    const sets  = this.load();
    const newSet = { id: uid(), title: title.trim() || 'Новый модуль', cards: [] };
    sets.unshift(newSet);
    this.save(sets);
    return newSet;
  },

  deleteSet(id) { this.save(this.load().filter(s => s.id !== id)); },

  updateSetTitle(id, title) {
    const sets = this.load();
    const s    = sets.find(s => s.id === id);
    if (s) { s.title = title.trim() || s.title; this.save(sets); }
  },

  addCard(setId, en, ru) {
    const sets = this.load();
    const set  = sets.find(s => s.id === setId);
    if (!set) return null;
    const card = { id: uid(), en: en.trim(), ru: ru.trim(), correct: 0, wrong: 0, added: Date.now() };
    set.cards.push(card);
    this.save(sets);
    return card;
  },

  updateCard(setId, cardId, patch) {
    const sets = this.load();
    const set  = sets.find(s => s.id === setId);
    if (!set) return;
    const card = set.cards.find(c => c.id === cardId);
    if (card) { Object.assign(card, patch); this.save(sets); }
  },

  removeCard(setId, cardId) {
    const sets = this.load();
    const set  = sets.find(s => s.id === setId);
    if (set) { set.cards = set.cards.filter(c => c.id !== cardId); this.save(sets); }
  },

  restoreCard(setId, card) {
    const sets = this.load();
    const set  = sets.find(s => s.id === setId);
    if (set) { set.cards.push(card); this.save(sets); }
  }
};

/* ═══════════════════════════════════════════════════════════
   SYNC SERVICE — JSONbin.io cloud sync
   One shared database: same data on all devices.
   
   Flow:
   • pull() on app load — merge cloud data if newer
   • push() on every Store.save() — debounced 1.5s
   • Status indicator in header: 🔄 / ✓ / ✗
   ═══════════════════════════════════════════════════════════ */
const SyncService = {
  _pushTimer: null,

  /** Load sync config from localStorage */
  settings() {
    try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; }
    catch { return {}; }
  },

  /** Save sync config */
  saveSettings(apiKey, binId) {
    localStorage.setItem(SYNC_KEY, JSON.stringify({ apiKey, binId }));
  },

  /** Check if sync is configured */
  isConfigured() {
    const { apiKey, binId } = this.settings();
    return !!(apiKey && binId);
  },

  /** Update the sync indicator dot in the header */
  setStatus(status) {
    const dot = $('syncDot');
    if (!dot) return;
    dot.className = 'sync-dot sync-' + status;
    dot.title = { idle: '', syncing: 'Синхронизация...', ok: '✓ Синхронизировано', error: '✗ Ошибка синхронизации' }[status] || '';
  },

  /**
   * Create a new JSONbin bin for first-time setup.
   * Returns the binId or null on error.
   */
  async createBin(apiKey) {
    try {
      const res = await fetch(JSONBIN_URL, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'X-Master-Key':  apiKey,
          'X-Bin-Name':    'FlashLingo',
          'X-Bin-Private': 'false'   // public = visible to anyone with the URL / binId
        },
        body: JSON.stringify({ sets: Store.load(), updatedAt: Date.now() })
      });
      if (!res.ok) return null;
      const d = await res.json();
      return d.metadata?.id ?? null;
    } catch { return null; }
  },

  /**
   * Pull data from cloud.
   * If cloud is newer than local, merge and return the sets array.
   * Returns null on error or if local is up-to-date.
   */
  async pull() {
    const { apiKey, binId } = this.settings();
    if (!apiKey || !binId) return null;
    this.setStatus('syncing');
    try {
      const res = await fetch(`${JSONBIN_URL}/${binId}/latest`, {
        headers: { 'X-Master-Key': apiKey }
      });
      if (!res.ok) { this.setStatus('error'); return null; }
      const d = await res.json();
      const remote = d.record;
      if (!remote?.sets) { this.setStatus('ok'); return null; }

      // Compare timestamps
      const localUpdated  = parseInt(localStorage.getItem('flashlingo_updated') || '0');
      const remoteUpdated = remote.updatedAt || 0;
      this.setStatus('ok');

      if (remoteUpdated > localUpdated) {
        // Cloud is newer — overwrite local
        localStorage.setItem(STORAGE_KEY, JSON.stringify(remote.sets));
        localStorage.setItem('flashlingo_updated', String(remoteUpdated));
        return remote.sets;
      }
      return null; // local is up-to-date
    } catch { this.setStatus('error'); return null; }
  },

  /**
   * Push local data to cloud. Debounced 1.5s to batch rapid changes.
   */
  push(sets) {
    if (!this.isConfigured()) return;
    clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => this._doPush(sets), 1500);
  },

  async _doPush(sets) {
    const { apiKey, binId } = this.settings();
    if (!apiKey || !binId) return;
    this.setStatus('syncing');
    try {
      const now = Date.now();
      const res = await fetch(`${JSONBIN_URL}/${binId}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Master-Key': apiKey },
        body: JSON.stringify({ sets, updatedAt: now })
      });
      if (res.ok) {
        localStorage.setItem('flashlingo_updated', String(now));
        this.setStatus('ok');
      } else {
        this.setStatus('error');
      }
    } catch { this.setStatus('error'); }
  }
};

/* ═══════════════════════════════════════════════════════════
   APP STATE — single source of truth for navigation
   ═══════════════════════════════════════════════════════════ */
const AppState = {
  view:       'home',   // 'home' | 'set' | 'flashcards' | 'quiz'
  activeSetId: null
};

function setView(view, setId = null) {
  AppState.view       = view;
  AppState.activeSetId = setId;

  // Update header title
  const titleEl = $('headerTitle');
  if (view === 'home') {
    titleEl.textContent = '';
  } else if (setId) {
    titleEl.textContent = Store.getSet(setId)?.title ?? '';
  }

  // Show/hide sections
  ['viewHome','viewSet'].forEach(id => {
    const el = $(id);
    el.classList.toggle('active', id === 'view' + cap(view));
    // App-main views use class .view
  });
  // Study views (flex, not app-main)
  ['viewFlashcards','viewQuiz'].forEach(id => {
    const el = $(id);
    el.classList.toggle('active', id === 'view' + cap(view));
  });
}

/* ═══════════════════════════════════════════════════════════
   VIEW: HOME
   ═══════════════════════════════════════════════════════════ */
function renderHome() {
  setView('home');
  const sets   = Store.load();
  const grid   = $('setsGrid');
  grid.innerHTML = '';

  if (!sets.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-emoji">📭</div>
        <div class="empty-title">Нет модулей</div>
        <div class="empty-sub">Создайте первый модуль, чтобы начать</div>
      </div>`;
  }

  sets.forEach(set => {
    const mastered  = set.cards.filter(c => (c.correct ?? 0) >= 3).length;
    const progress  = set.cards.length ? Math.round(mastered / set.cards.length * 100) : 0;
    const card = el('div', 'set-card');
    card.innerHTML = `
      <div class="set-card-icon">📇</div>
      <div class="set-card-body">
        <div class="set-card-name">${esc(set.title)}</div>
        <div class="set-card-meta">${set.cards.length} ${pluralCard(set.cards.length)} · ${progress}% изучено</div>
        <div class="set-progress"><div class="set-progress-fill" style="width:${progress}%"></div></div>
      </div>
      <div class="set-card-arrow">›</div>`;
    card.onclick = () => openSet(set.id);
    grid.appendChild(card);
  });

  // "New set" card
  const newCard = el('div', 'set-card set-card-new');
  newCard.innerHTML = `<span class="set-card-new-label">+ Создать модуль</span>`;
  newCard.onclick = createNewSet;
  grid.appendChild(newCard);
}

/* ═══════════════════════════════════════════════════════════
   VIEW: SET EDITOR
   ═══════════════════════════════════════════════════════════ */
function openSet(setId) {
  const set = Store.getSet(setId);
  if (!set) return renderHome();

  AppState.activeSetId = setId;
  setView('set', setId);
  renderSetView();
}

function renderSetView() {
  const setId = AppState.activeSetId;
  const set   = Store.getSet(setId);
  if (!set) return renderHome();

  $('setTitleInput').value = set.title;
  updateCardCount();
  renderCardList();
}

function updateCardCount() {
  const cards = Store.getCards(AppState.activeSetId);
  $('setCardCount').textContent = `${cards.length} ${pluralCard(cards.length)}`;
}

function renderCardList() {
  const setId = AppState.activeSetId;
  const cards = Store.getCards(setId);
  const list  = $('cardsList');
  list.innerHTML = '';

  cards.forEach(card => list.appendChild(buildCardRow(card)));

  // If no cards yet, auto-open an empty row
  if (!cards.length) addNewEmptyRow();
}

/** Build an editable row for a saved card */
function buildCardRow(card) {
  const row   = el('div', 'card-row');
  row.dataset.cardId = card.id;

  const termInp = el('input', 'card-input');
  termInp.type        = 'text';
  termInp.value       = card.en;
  termInp.placeholder = 'Термин (English)';
  termInp.id          = `term_${card.id}`;

  const sep = el('div', 'card-sep');

  const defInp = el('input', 'card-input');
  defInp.type        = 'text';
  defInp.value       = card.ru;
  defInp.placeholder = 'Перевод (Russian)';
  defInp.id          = `def_${card.id}`;

  const delBtn = el('button', 'card-del-btn');
  delBtn.textContent = '✕';
  delBtn.title       = 'Удалить карточку';

  row.append(termInp, sep, defInp, delBtn);

  // Save on blur
  termInp.onblur = () => Store.updateCard(AppState.activeSetId, card.id, { en: termInp.value });
  defInp.onblur  = () => Store.updateCard(AppState.activeSetId, card.id, { ru: defInp.value  });

  // Delete with undo
  delBtn.onclick = () => {
    // Re-read fresh data before deleting
    const fresh = Store.getCards(AppState.activeSetId).find(c => c.id === card.id);
    if (fresh) {
      Store.removeCard(AppState.activeSetId, card.id);
      row.remove();
      updateCardCount();
      showToast(`Карточка удалена`, () => {
        Store.restoreCard(AppState.activeSetId, fresh);
        renderSetView();
      });
    }
  };

  // Tab from term → def
  termInp.addEventListener('keydown', e => {
    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); defInp.focus(); }
  });

  return row;
}

/** Build a temporary "new card" row. Saves when term + def both filled, Tab or Enter. */
function addNewEmptyRow() {
  const list = $('cardsList');

  const row     = el('div', 'card-row');
  row.dataset.new = 'true';

  const termInp = el('input', 'card-input');
  const sep = el('div', 'card-sep');

  const defInp = el('input', 'card-input');
  defInp.type        = 'text';
  defInp.placeholder = 'Перевод (Russian)';

  const delBtn = el('button', 'card-del-btn');
  delBtn.textContent = '✕';
  delBtn.title       = 'Убрать';
  delBtn.onclick     = () => { row.remove(); };

  row.append(termInp, sep, defInp, delBtn);
  list.appendChild(row);

  const save = () => {
    const t = termInp.value.trim();
    const d = defInp.value.trim();
    if (!t || !d) return;
    const card = Store.addCard(AppState.activeSetId, t, d);
    if (card) {
      row.dataset.new = '';
      row.dataset.cardId = card.id;
      const saved = buildCardRow(card);
      row.replaceWith(saved);
      updateCardCount();
      addNewEmptyRow();
    }
  };

  defInp.onkeydown = e => { if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); save(); } };
  termInp.onkeydown = e => {
    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); defInp.focus(); }
    if (e.key === 'Enter') { e.preventDefault(); defInp.focus(); }
  };

  termInp.focus();
  row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function createNewSet() {
  const name = prompt('Название нового модуля:');
  if (name === null) return;
  const newSet = Store.createSet(name);
  openSet(newSet.id);
}

/* ═══════════════════════════════════════════════════════════
   FLASHCARDS MODULE
   
   State is fully isolated inside FcModule.
   No global mutable vars — all contained here.
   ═══════════════════════════════════════════════════════════ */
const FcModule = {
  deck:      [],
  idx:       0,
  flipped:   false,
  knowCount: 0,

  /** Start a flashcard session */
  start(setId) {
    const cards = Store.getCards(setId);
    if (!cards.length) {
      alert('Сначала добавьте карточки.');
      return;
    }
    this.deck      = shuffle([...cards]);
    this.idx       = 0;
    this.flipped   = false;
    this.knowCount = 0;

    $('fcStudy').style.display   = 'flex';
    $('fcStudy').style.flexDirection = 'column';
    $('fcStudy').style.flex      = '1';
    $('fcFinished').style.display = 'none';

    this.render();
    setView('flashcards', setId);
    AttachSwipe($('fcWrapper'), () => this.next(), () => this.prev());
  },

  /** Render current card */
  render() {
    const card  = this.deck[this.idx];
    const total = this.deck.length;

    $('fcFrontWord').textContent = card.en;
    $('fcBackWord').textContent  = card.ru;
    $('fcFrontContext').textContent = card.context ?? '';
    $('fcBackContext').textContent  = card.context ?? '';
    $('fcCounter').textContent   = `${this.idx + 1} / ${total}`;
    $('fcProgressFill').style.width = `${((this.idx + 1) / total * 100).toFixed(1)}%`;

    // Reset flip state
    this.flipped = false;
    $('fcInner').classList.remove('flipped');
    $('fcVerdict').classList.add('hidden');
    $('btnFcPrev').disabled = this.idx === 0;
    $('btnFcNext').disabled = this.idx === total - 1;
  },

  /** Flip card */
  flip() {
    this.flipped = !this.flipped;
    $('fcInner').classList.toggle('flipped', this.flipped);
    // Show verdict buttons only when back is visible
    $('fcVerdict').classList.toggle('hidden', !this.flipped);
  },

  next() {
    if (this.idx < this.deck.length - 1) { this.idx++; this.render(); }
    else this.finish();
  },

  prev() {
    if (this.idx > 0) { this.idx--; this.render(); }
  },

  /** Record verdict (know / don't know) and advance */
  verdict(know) {
    const card = this.deck[this.idx];
    const patch = know
      ? { correct: (card.correct ?? 0) + 1 }
      : { wrong:   (card.wrong   ?? 0) + 1 };
    Store.updateCard(AppState.activeSetId, card.id, patch);
    if (know) this.knowCount++;
    this.next();
  },

  finish() {
    $('fcStudy').style.display    = 'none';
    $('fcFinished').style.display = 'flex';
    const pct = this.deck.length ? Math.round(this.knowCount / this.deck.length * 100) : 0;
    $('fcFinishedEmoji').textContent = pct >= 80 ? '🎉' : pct >= 50 ? '💪' : '📖';
    $('fcFinishedTitle').textContent = pct >= 80 ? 'Отлично!' : 'Продолжай учиться';
    $('fcFinishedSub').textContent   = `${this.knowCount} из ${this.deck.length} знал(а) (${pct}%)`;
  }
};


/* ═══════════════════════════════════════════════════════════
   TOAST
   ═══════════════════════════════════════════════════════════ */
let _toastTimer = null;

function showToast(msg, undoFn = null) {
  const toast = $('toast');
  $('toastMsg').textContent = msg;
  const undoEl = $('toastUndo');
  if (undoFn) {
    undoEl.style.display = 'inline';
    undoEl.onclick = () => { undoFn(); hideToast(); };
  } else {
    undoEl.style.display = 'none';
  }
  toast.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(hideToast, 4000);
}

function hideToast() {
  $('toast').classList.remove('show');
}

/* ═══════════════════════════════════════════════════════════
   SWIPE SUPPORT (touch)
   Attach swipe-left / swipe-right handlers to an element
   ═══════════════════════════════════════════════════════════ */
function AttachSwipe(el, onSwipeLeft, onSwipeRight) {
  let startX = 0;
  let startY = 0;

  el.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  el.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
      if (dx < 0) onSwipeLeft();
      else         onSwipeRight();
    }
  }, { passive: true });
}

/* ═══════════════════════════════════════════════════════════
   SPEECH
   ═══════════════════════════════════════════════════════════ */
function speak(text) {
  if (!text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US'; u.rate = 0.9;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/* ═══════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════ */
function $(id)      { return document.getElementById(id); }
function el(tag, className = '') {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}
function cap(s)     { return s.charAt(0).toUpperCase() + s.slice(1); }
function uid()      { return 's_' + Date.now() + '_' + Math.random().toString(36).slice(2); }
function esc(s)     { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function shuffle(a) { const b=[...a]; for(let i=b.length-1;i>0;i--){const j=0|Math.random()*(i+1);[b[i],b[j]]=[b[j],b[i]];} return b; }
function pluralCard(n) {
  const a = Math.abs(n) % 100, a10 = a % 10;
  if (a > 10 && a < 20) return 'карточек';
  if (a10 === 1)         return 'карточка';
  if (a10 >= 2 && a10 <= 4) return 'карточки';
  return 'карточек';
}

/* ═══════════════════════════════════════════════════════════
   EVENT WIRING — attach all handlers here, once on DOMContentLoaded
   No inline onclick in HTML (except where unavoidable).
   ═══════════════════════════════════════════════════════════ */
function init() {
  // ── Home ──
  $('btnHome').onclick      = renderHome;
  $('btnCreateSet').onclick = createNewSet;

  // ── Set View ──
  $('btnBackFromSet').onclick = renderHome;
  $('setTitleInput').onblur   = () => {
    Store.updateSetTitle(AppState.activeSetId, $('setTitleInput').value);
    $('headerTitle').textContent = $('setTitleInput').value;
  };
  $('setTitleInput').onkeydown = e => { if (e.key === 'Enter') $('setTitleInput').blur(); };

  $('btnDeleteSet').onclick = () => {
    const set = Store.getSet(AppState.activeSetId);
    if (!set) return;
    if (confirm(`Удалить модуль «${set.title}»?`)) {
      Store.deleteSet(AppState.activeSetId);
      renderHome();
    }
  };

  $('btnAddCard').onclick = addNewEmptyRow;

  // Study mode launch
  $('btnStartFlashcards').onclick = () => FcModule.start(AppState.activeSetId);

  // ── Flashcards ──
  $('btnExitFlashcards').onclick   = () => openSet(AppState.activeSetId);
  $('btnFlip').onclick             = () => FcModule.flip();
  $('fcWrapper').onclick           = e => {
    // Don't flip if audio button was clicked
    if (!e.target.classList.contains('fc-audio-btn')) FcModule.flip();
  };
  $('btnFcPrev').onclick           = () => FcModule.prev();
  $('btnFcNext').onclick           = () => FcModule.next();
  $('btnKnow').onclick             = () => FcModule.verdict(true);
  $('btnForget').onclick           = () => FcModule.verdict(false);
  $('btnFcRestart').onclick        = () => FcModule.start(AppState.activeSetId);
  $('btnFcExit').onclick           = () => openSet(AppState.activeSetId);

  // Audio buttons
  $('fcFrontAudio').onclick = e => { e.stopPropagation(); speak($('fcFrontWord').textContent); };
  $('fcBackAudio').onclick  = e => { e.stopPropagation(); speak($('fcFrontWord').textContent); };


  // ── Settings modal ──
  $('btnSettings').onclick       = openSettings;
  $('btnCloseSettings').onclick = closeSettings;
  $('settingsOverlay').onclick   = e => { if (e.target === $('settingsOverlay')) closeSettings(); };

  // ── Keyboard shortcuts ──
  document.addEventListener('keydown', e => {
    if ($('viewFlashcards').classList.contains('active')) {
      if (e.code  === 'Space')      { e.preventDefault(); FcModule.flip(); }
      if (e.key   === 'ArrowRight') { e.preventDefault(); FcModule.next(); }
      if (e.key   === 'ArrowLeft')  { e.preventDefault(); FcModule.prev(); }
      if (e.key   === 'y' || e.key === 'к') FcModule.verdict(true);
      if (e.key   === 'n' || e.key === 'т') FcModule.verdict(false);
    }
  });

  // ── Sync settings UI ──
  $('btnSyncConnect').onclick = connectSync;
  $('syncBinIdInput').onclick = e => e.stopPropagation();

  // Pre-fill sync fields
  const syncCfg = SyncService.settings();
  if (syncCfg.apiKey) $('syncApiKeyInput').value = syncCfg.apiKey;
  if (syncCfg.binId)  $('syncBinIdInput').value  = syncCfg.binId;
  updateSyncStatus();

  // ── Boot: render local immediately, then sync in background ──
  renderHome();
  SyncService.pull().then(remoteSets => {
    if (remoteSets) {
      showToast('☁ Данные загружены из облака');
      renderHome();
    }
  });
}

function openSettings() {
  // Refresh sync fields every time modal opens
  const cfg = SyncService.settings();
  if (cfg.apiKey) $('syncApiKeyInput').value = cfg.apiKey;
  if (cfg.binId)  $('syncBinIdInput').value  = cfg.binId;
  updateSyncStatus();
  $('settingsOverlay').classList.add('open');
}
function closeSettings() {
  $('settingsOverlay').classList.remove('open');
}

/** Show current sync connection status inside settings modal */
function updateSyncStatus() {
  const statusEl = $('syncStatus');
  const binRow   = $('syncBinRow');
  if (!statusEl) return;
  const { apiKey, binId } = SyncService.settings();
  if (apiKey && binId) {
    statusEl.textContent = '✓ Подключено';
    statusEl.style.color = 'var(--green)';
    binRow.style.display = 'block';
  } else {
    statusEl.textContent = apiKey ? 'Нажмите «Подключить»' : 'Не настроено';
    statusEl.style.color = 'var(--text-muted)';
    binRow.style.display = 'none';
  }
}

/**
 * Connect to cloud sync:
 * If no binId yet — create a new bin.
 * If binId exists — verify and save.
 */
async function connectSync() {
  const apiKey = $('syncApiKeyInput').value.trim();
  const statusEl = $('syncStatus');
  if (!apiKey) {
    statusEl.textContent = '⚠ Введите API Key';
    statusEl.style.color = 'var(--red)';
    return;
  }

  const btn = $('btnSyncConnect');
  btn.textContent = 'Подключаю...';
  btn.disabled = true;

  let { binId } = SyncService.settings();
  const existingBinId = $('syncBinIdInput').value.trim();

  if (existingBinId) {
    // Use provided Bin ID (syncing with existing database)
    binId = existingBinId;
    SyncService.saveSettings(apiKey, binId);
    const pulled = await SyncService.pull();
    if (pulled) {
      showToast('☁ Данные загружены из облака');
      renderHome();
    }
    statusEl.textContent = SyncService.isConfigured() ? '✓ Подключено' : '✗ Ошибка';
    statusEl.style.color = SyncService.isConfigured() ? 'var(--green)' : 'var(--red)';
  } else {
    // Create new bin
    binId = await SyncService.createBin(apiKey);
    if (binId) {
      SyncService.saveSettings(apiKey, binId);
      $('syncBinIdInput').value = binId;
      statusEl.textContent = '✓ Облако создано!';
      statusEl.style.color = 'var(--green)';
    } else {
      statusEl.textContent = '✗ Ошибка. Проверь API Key';
      statusEl.style.color = 'var(--red)';
    }
  }

  btn.textContent = 'Подключить';
  btn.disabled = false;
  updateSyncStatus();
}

// ── Kick off ──
document.addEventListener('DOMContentLoaded', init);
