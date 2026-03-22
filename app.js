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
const API_KEY_STORE  = 'flashlingo_gemini_key';
const DEBOUNCE_MS    = 300;
const MYMEMORY_URL   = 'https://api.mymemory.translated.net/get';
const GEMINI_URL     = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

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

  save(sets) { localStorage.setItem(STORAGE_KEY, JSON.stringify(sets)); },

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

  // Autocomplete on term input
  termInp.addEventListener('input',   () => handleAutocomplete(termInp));
  termInp.addEventListener('keydown', e  => handleDropdownKey(e, termInp, null));

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
  termInp.type        = 'text';
  termInp.placeholder = 'Термин (English)';

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
      // Convert to permanent row
      const saved = buildCardRow(card);
      row.replaceWith(saved);
      updateCardCount();
      addNewEmptyRow(); // auto next row
    }
  };

  // Save on Tab out of def, or Enter anywhere
  defInp.addEventListener('keydown', e => { if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); save(); } });
  termInp.addEventListener('keydown', e => {
    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); defInp.focus(); }
    if (e.key === 'Enter') { e.preventDefault(); defInp.focus(); }
  });

  // Autocomplete on new row
  termInp.addEventListener('input',   () => handleAutocomplete(termInp, defInp));
  termInp.addEventListener('keydown', e  => handleDropdownKey(e, termInp, defInp));

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
   AUTOCOMPLETE (dropdown)
   ═══════════════════════════════════════════════════════════ */
let _debTimer    = null;
let _abortCtrl   = null;
let _suggestions = [];
let _dropAnchor  = null; // { termEl, defEl|null }
let _dropIdx     = -1;

const dropdown = $('dropdownPortal');

function handleAutocomplete(termEl, defEl = null) {
  _dropAnchor = { termEl, defEl };
  const q = termEl.value.trim();
  if (q.length < 2) { closeDropdown(); return; }

  clearTimeout(_debTimer);
  _debTimer = setTimeout(() => fetchSuggestions(q), DEBOUNCE_MS);
}

async function fetchSuggestions(q) {
  if (_abortCtrl) _abortCtrl.abort();
  _abortCtrl = new AbortController();
  const sig   = _abortCtrl.signal;
  const isRu  = /[а-яА-ЯёЁ]/.test(q);

  try {
    const [mm, gem] = await Promise.allSettled([
      fetchMyMemory(q, sig, isRu),
      fetchGemini(q, sig, isRu)
    ]);
    const seen = new Set();
    _suggestions = [];
    [...(gem.value ?? []), ...(mm.value ?? [])].forEach(s => {
      const k = s.t.toLowerCase().trim();
      if (!seen.has(k)) { seen.add(k); _suggestions.push({ ...s, isRu }); }
    });
    _suggestions = _suggestions.slice(0, 5);
    _dropIdx = -1;
    renderDropdown();
  } catch(e) {
    if (e.name !== 'AbortError') closeDropdown();
  }
}

function renderDropdown() {
  if (!_suggestions.length || !_dropAnchor) { dropdown.style.display = 'none'; return; }

  dropdown.innerHTML = '';
  _suggestions.forEach((s, i) => {
    const item = el('div', `drop-item${i === _dropIdx ? ' active' : ''}`);
    item.innerHTML = `<span>${esc(s.t)}</span><span class="drop-tag">${s.src}</span>`;
    item.onmousedown = e => { e.preventDefault(); pickSuggestion(i); };
    item.onmouseenter = () => {
      _dropIdx = i;
      dropdown.querySelectorAll('.drop-item').forEach((el,j) => el.classList.toggle('active', j===i));
    };
    dropdown.appendChild(item);
  });

  // Position under anchor input
  const rect = _dropAnchor.termEl.getBoundingClientRect();
  dropdown.style.display = 'block';
  dropdown.style.top     = `${rect.bottom + 6}px`;
  dropdown.style.left    = `${rect.left}px`;
  dropdown.style.width   = `${Math.max(rect.width, 220)}px`;
}

function handleDropdownKey(e, termEl, defEl) {
  if (!_suggestions.length) return;
  if (e.key === 'ArrowDown')  { e.preventDefault(); _dropIdx = Math.min(_dropIdx+1, _suggestions.length-1); renderDropdown(); }
  if (e.key === 'ArrowUp')    { e.preventDefault(); _dropIdx = Math.max(-1, _dropIdx-1); renderDropdown(); }
  if (e.key === 'Enter')      { e.preventDefault(); pickSuggestion(Math.max(0, _dropIdx)); }
  if (e.key === 'Escape')     { closeDropdown(); }
}

function pickSuggestion(i) {
  const s = _suggestions[i];
  if (!s || !_dropAnchor) return;
  const { termEl, defEl } = _dropAnchor;

  if (s.isRu) {
    termEl.value = s.ru ?? termEl.value;
    if (defEl) defEl.value = s.t;
    else {
      // Existing card row: find the def sibling
      const row = termEl.closest('.card-row');
      if (row) {
        const inputs = row.querySelectorAll('.card-input');
        if (inputs[1]) inputs[1].value = s.t;
        // Save
        const id = row.dataset.cardId;
        if (id) Store.updateCard(AppState.activeSetId, id, { en: termEl.value, ru: s.t });
      }
    }
  } else {
    termEl.value = s.q ?? termEl.value;
    if (defEl) defEl.value = s.t;
    else {
      const row = termEl.closest('.card-row');
      if (row) {
        const inputs = row.querySelectorAll('.card-input');
        if (inputs[1]) inputs[1].value = s.t;
        const id = row.dataset.cardId;
        if (id) Store.updateCard(AppState.activeSetId, id, { en: termEl.value, ru: s.t });
      }
    }
  }

  closeDropdown();

  // If new row, trigger save
  if (_dropAnchor.defEl) {
    const row = termEl.closest('.card-row');
    if (row?.dataset.new) {
      const inputs = row.querySelectorAll('.card-input');
      const t = inputs[0].value.trim(), d = inputs[1].value.trim();
      if (t && d) {
        const card = Store.addCard(AppState.activeSetId, t, d);
        if (card) {
          const saved = buildCardRow(card);
          row.replaceWith(saved);
          updateCardCount();
          addNewEmptyRow();
        }
      }
    }
  }
}

function closeDropdown() {
  dropdown.style.display = 'none';
  _suggestions = [];
  _dropIdx     = -1;
}

// Close dropdown when clicking outside
document.addEventListener('mousedown', e => {
  if (!dropdown.contains(e.target) && _dropAnchor && !_dropAnchor.termEl.contains(e.target)) {
    closeDropdown();
  }
});

/* ── API: MyMemory ── */
async function fetchMyMemory(q, signal, isRu) {
  const pair = isRu ? 'ru|en' : 'en|ru';
  try {
    const r = await fetch(`${MYMEMORY_URL}?q=${encodeURIComponent(q)}&langpair=${pair}`, { signal });
    if (!r.ok) return [];
    const d = await r.json();
    const t = d.responseData?.translatedText?.trim();
    return t && t !== q ? [{ t, src: 'MM', q }] : [];
  } catch { return []; }
}

/* ── API: Gemini (optional, if key stored) ── */
async function fetchGemini(q, signal, isRu) {
  const key = localStorage.getItem(API_KEY_STORE);
  if (!key) return [];
  const prompt = isRu
    ? `Dictionary RU→EN. Word: "${q}". Return JSON array max 3: [{"t":"translation"}]. Only JSON.`
    : `Dictionary EN→RU. Word: "${q}". Return JSON array max 3: [{"t":"перевод"}]. Only JSON.`;
  try {
    const r = await fetch(`${GEMINI_URL}?key=${key}`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 200 } })
    });
    if (!r.ok) return [];
    const d   = await r.json();
    const raw = (d?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').replace(/```json|```/g,'').trim();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(x => ({ t: x.t, src: 'AI', q })) : [];
  } catch { return []; }
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
   QUIZ MODULE
   4-option multiple choice, EN→RU or RU→EN
   ═══════════════════════════════════════════════════════════ */
const QuizModule = {
  deck:     [],
  idx:      0,
  correct:  0,
  total:    0,
  streak:   0,
  locked:   false,
  reverse:  false, // false = EN→RU, true = RU→EN

  start(setId, reverse = this.reverse) {
    const cards = Store.getCards(setId);
    if (cards.length < 4) {
      $('quizNeedMore').style.display  = 'flex';
      $('quizActive').style.display    = 'none';
      $('quizFinished').style.display  = 'none';
      setView('quiz', setId);
      return;
    }
    this.reverse  = reverse;
    this.deck     = shuffle([...cards]);
    this.idx      = 0;
    this.correct  = 0;
    this.total    = 0;
    this.streak   = 0;
    this.locked   = false;

    $('quizNeedMore').style.display  = 'none';
    $('quizActive').style.display    = 'block';
    $('quizFinished').style.display  = 'none';

    // Sync toggle UI
    $('modeEnRu').classList.toggle('active', !reverse);
    $('modeRuEn').classList.toggle('active',  reverse);

    setView('quiz', setId);
    this.renderQuestion();
  },

  renderQuestion() {
    if (this.idx >= this.deck.length) return this.finish();
    this.locked = false;
    const card  = this.deck[this.idx];

    // Update progress
    $('quizProgressFill').style.width = `${(this.idx / this.deck.length * 100).toFixed(1)}%`;
    $('quizScore').textContent        = `${this.correct} / ${this.total}`;

    // Streak badge
    const badgeEl = $('streakBadge');
    badgeEl.textContent = this.streak >= 3 ? `🔥 ${this.streak} подряд` : '';

    // Question: if reverse=true, show RU, answer EN; else show EN, answer RU
    const qText  = this.reverse ? card.ru : card.en;
    const ansKey = this.reverse ? 'en' : 'ru';
    const ans    = card[ansKey];

    $('quizLangTag').textContent = this.reverse ? 'RU' : 'EN';
    $('quizWord').textContent    = qText;

    // Build 4 options: 1 correct + 3 random wrong
    const pool  = Store.getCards(AppState.activeSetId).filter(c => c.id !== card.id);
    const wrongs = shuffle(pool).slice(0, 3).map(c => c[ansKey]);
    const options = shuffle([{ text: ans, correct: true }, ...wrongs.map(t => ({ text: t, correct: false }))]);

    const grid = $('optionsGrid');
    grid.innerHTML = '';
    options.forEach(opt => {
      const btn = el('button', 'option-btn');
      btn.textContent = opt.text;
      btn.onclick = () => this.answer(btn, opt.correct, ans);
      grid.appendChild(btn);
    });
  },

  answer(btn, isCorrect, correctAns) {
    if (this.locked) return;
    this.locked = true;
    this.total++;

    if (isCorrect) {
      btn.classList.add('correct');
      this.correct++;
      this.streak++;
    } else {
      btn.classList.add('wrong');
      this.streak = 0;
      // Reveal correct answer
      $('optionsGrid').querySelectorAll('.option-btn').forEach(b => {
        if (b.textContent === correctAns) b.classList.add('reveal');
      });
    }

    $('optionsGrid').querySelectorAll('.option-btn').forEach(b => b.disabled = true);
    Store.updateCard(AppState.activeSetId, this.deck[this.idx].id, {
      correct: (this.deck[this.idx].correct ?? 0) + (isCorrect ? 1 : 0),
      wrong:   (this.deck[this.idx].wrong   ?? 0) + (isCorrect ? 0 : 1)
    });

    this.idx++;
    setTimeout(() => this.renderQuestion(), 900);
  },

  finish() {
    $('quizActive').style.display   = 'none';
    $('quizFinished').style.display = 'flex';
    const pct = this.total ? Math.round(this.correct / this.total * 100) : 0;
    $('quizFinishedTitle').textContent = pct >= 80 ? 'Отлично! 🎉' : pct >= 60 ? 'Хороший результат 💪' : 'Нужно ещё практики 📖';
    $('quizFinishedSub').textContent   = `${this.correct} из ${this.total} правильно · ${pct}%`;
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
  $('btnStartQuiz').onclick       = () => QuizModule.start(AppState.activeSetId);

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

  // ── Quiz ──
  $('btnExitQuiz').onclick    = () => openSet(AppState.activeSetId);
  $('modeEnRu').onclick       = () => QuizModule.start(AppState.activeSetId, false);
  $('modeRuEn').onclick       = () => QuizModule.start(AppState.activeSetId, true);
  $('btnGoAddCards').onclick  = () => openSet(AppState.activeSetId);
  $('btnQuizRestart').onclick = () => QuizModule.start(AppState.activeSetId, QuizModule.reverse);
  $('btnQuizExit').onclick    = () => openSet(AppState.activeSetId);

  // ── Settings modal ──
  $('btnSettings').onclick       = openSettings;
  $('btnCloseSettings').onclick  = closeSettings;
  $('btnCancelSettings').onclick = closeSettings;
  $('settingsOverlay').onclick   = e => { if (e.target === $('settingsOverlay')) closeSettings(); };
  $('btnSaveKey').onclick        = saveGeminiKey;

  // Pre-fill key
  const savedKey = localStorage.getItem(API_KEY_STORE);
  if (savedKey) $('geminiKeyInput').value = savedKey;

  // ── Keyboard shortcuts ──
  document.addEventListener('keydown', e => {
    if ($('viewFlashcards').classList.contains('active')) {
      if (e.code  === 'Space')      { e.preventDefault(); FcModule.flip(); }
      if (e.key   === 'ArrowRight') { e.preventDefault(); FcModule.next(); }
      if (e.key   === 'ArrowLeft')  { e.preventDefault(); FcModule.prev(); }
      if (e.key   === 'y' || e.key === 'к') FcModule.verdict(true);
      if (e.key   === 'n' || e.key === 'т') FcModule.verdict(false);
    }
    if ($('viewQuiz').classList.contains('active') && !QuizModule.locked) {
      const n = parseInt(e.key);
      if (n >= 1 && n <= 4) {
        const btns = $('optionsGrid').querySelectorAll('.option-btn');
        if (btns[n-1]) btns[n-1].click();
      }
    }
  });

  // ── Boot ──
  renderHome();
}

function openSettings() {
  $('settingsOverlay').classList.add('open');
  $('geminiKeyInput').focus();
}
function closeSettings() {
  $('settingsOverlay').classList.remove('open');
  $('keyStatus').textContent = '';
}
function saveGeminiKey() {
  const k = $('geminiKeyInput').value.trim();
  if (!k) { $('keyStatus').textContent = '⚠ Введите ключ'; $('keyStatus').style.color = 'var(--red)'; return; }
  localStorage.setItem(API_KEY_STORE, k);
  $('keyStatus').textContent = '✓ Сохранено';
  $('keyStatus').style.color = 'var(--green)';
  setTimeout(closeSettings, 900);
}

// ── Kick off ──
document.addEventListener('DOMContentLoaded', init);
