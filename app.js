'use strict';

// ── Constants & Config ───────────────────────────────────
const STORAGE_KEY     = 'flashlingo_sets';
const OLD_STORAGE_KEY = 'flashlingo_cards';
const API_KEY_STORE   = 'flashlingo_gemini_key';
const DEBOUNCE_MS     = 320;
const MYMEMORY_URL    = 'https://api.mymemory.translated.net/get';
const GEMINI_URL      = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

// ── DOM Refs ─────────────────────────────────────────────
const viewHome       = document.getElementById('viewHome');
const viewSet        = document.getElementById('viewSet');
const viewFlashcards = document.getElementById('viewFlashcards');
const viewQuiz       = document.getElementById('viewQuiz');

const setsGrid       = document.getElementById('setsGrid');
const currentSetTitleInput= document.getElementById('currentSetTitleInput');
const currentSetCount= document.getElementById('currentSetCount');
const cardsList      = document.getElementById('cardsList');
const emptyState     = document.getElementById('emptyState');

const dropdown       = document.getElementById('dropdown');
const suggList       = document.getElementById('suggList');

// Flashcards refs
const fcProgressText = document.getElementById('fcProgressText');
const fcProgressBar  = document.getElementById('fcProgressBar');
const fcInner        = document.getElementById('fcInner');
const fcFrontText    = document.getElementById('fcFrontText');
const fcBackText     = document.getElementById('fcBackText');

// Quiz (Learn) refs
const quizNeedMore  = document.getElementById('quizNeedMore');
const quizActive    = document.getElementById('quizActive');
const quizFinished  = document.getElementById('quizFinished');
const quizWord      = document.getElementById('quizWord');
const optionsGrid   = document.getElementById('optionsGrid');
const quizFeedback  = document.getElementById('quizFeedback');
const quizScoreEl   = document.getElementById('quizScore');
const quizStreakEl  = document.getElementById('quizStreak');
const btnRestart    = document.getElementById('btnRestart');
const finishMsg     = document.getElementById('finishMsg');
const finishSub     = document.getElementById('finishSub');
const finishIcon    = document.getElementById('finishIcon');
const modeEnRu      = document.getElementById('modeEnRu');
const modeRuEn      = document.getElementById('modeRuEn');
const quizLang      = document.getElementById('quizLang');

// Settings & Utilities
const settingsOverlay = document.getElementById('settingsOverlay');
const geminiKeyInput  = document.getElementById('geminiKeyInput');
const saveKeyBtn      = document.getElementById('saveKeyBtn');
const keyStatus       = document.getElementById('keyStatus');
const btnSettings     = document.getElementById('btnSettings');
const toastEl         = document.getElementById('toast');
const toastAction     = document.getElementById('toastAction');

// ── Sub-State ─────────────────────────────────────────────
let activeSetId  = null;
let suggestions  = [];
let activeIndex  = -1;
let debounceTimer= null;
let abortCtrl    = null;

let activeInputRef = null; // The input that triggered the dropdown

let lastDeletedCard = null;
let toastTimer      = null;

const STATS_KEY       = 'flashlingo_stats';

// Flashcards state
let fcDeck       = [];
let fcIdx        = 0;
let fcIsFlipped  = false;

// Quiz state
let quizDeck     = [];
let quizIdx      = 0;
let quizCorrect  = 0;
let quizTotal    = 0;
let streak       = 0;
let quizLocked   = false;
let quizReverse  = false;

// ── Storage (Sets Architecture) ───────────────────────────
const Store = {
  load() {
    try {
      let sets = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!sets) {
        const oldCards = JSON.parse(localStorage.getItem(OLD_STORAGE_KEY));
        if (oldCards && oldCards.length > 0) {
          sets = [{ id: 'set_' + Date.now(), title: 'Мой первый модуль', cards: oldCards.map(c => ({...c, correctCount:0, wrongCount:0})) }];
        } else {
          sets = [];
        }
        this.save(sets);
      }
      return sets || [];
    } catch { return []; }
  },
  save(sets) { localStorage.setItem(STORAGE_KEY, JSON.stringify(sets)); },
  
  loadStats() {
    try {
      const s = JSON.parse(localStorage.getItem(STATS_KEY)) || { streak: 0, lastDate: null, totalMastered: 0 };
      // Check streak
      const today = new Date().toDateString();
      if (s.lastDate && s.lastDate !== today) {
        const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
        if (s.lastDate !== yesterday.toDateString()) s.streak = 0;
      }
      return s;
    } catch { return { streak:0, totalMastered:0 }; }
  },
  saveStats(s) { localStorage.setItem(STATS_KEY, JSON.stringify(s)); },

  createSet(title) {
    const sets = this.load();
    const newSet = { id: 'set_' + Date.now(), title: title.trim() || 'Новый модуль', cards: [] };
    sets.unshift(newSet);
    this.save(sets);
    return newSet;
  },
  deleteSet(setId) {
    this.save(this.load().filter(s => s.id !== setId));
  },
  addCard(setId, en, ru, type='std') {
    const sets = this.load();
    const set = sets.find(s => s.id === setId);
    if (!set) return null;
    const card = { 
      id: Date.now()+Math.random(), en: en.trim(), ru: ru.trim(), type, date: Date.now(),
      correctCount: 0, wrongCount: 0, lastStudied: null
    };
    set.cards.push(card);
    this.save(sets);
    return card;
  },
  updateCard(setId, cardId, field, val) {
    const sets = this.load();
    const set = sets.find(s => s.id === setId);
    if (!set) return;
    const card = set.cards.find(c => c.id === cardId);
    if (card) {
      card[field] = val.trim();
      this.save(sets);
    }
  },
  removeCard(setId, cardId) {
    const sets = this.load();
    const set = sets.find(s => s.id === setId);
    if (set) {
      set.cards = set.cards.filter(c => c.id !== cardId);
      this.save(sets);
    }
  },
  updateSetTitle(setId, newTitle) {
    const sets = this.load();
    const set = sets.find(s => s.id === setId);
    if (set) { set.title = newTitle; this.save(sets); }
  },
  getCards(setId) {
    const set = this.load().find(s => s.id === setId);
    return set ? set.cards : [];
  },
  recordResult(setId, cardId, isCorrect) {
    const sets = this.load();
    const set = sets.find(s => s.id === setId);
    if (!set) return;
    const card = set.cards.find(c => c.id === cardId);
    if (!card) return;

    if (!card.correctCount) card.correctCount = 0;
    if (!card.wrongCount) card.wrongCount = 0;

    if (isCorrect) card.correctCount++;
    else card.wrongCount++;
    
    card.lastStudied = Date.now();
    this.save(sets);

    // Update global streak
    const stats = this.loadStats();
    const today = new Date().toDateString();
    if (isCorrect) {
      if (stats.lastDate !== today) {
        stats.streak++;
        stats.lastDate = today;
      }
    }
    this.saveStats(stats);
  }
};

// ── UI Navigation ─────────────────────────────────────────

function switchView(viewId) {
  [viewHome, viewSet, viewFlashcards, viewQuiz].forEach(v => {
    v.classList.remove('active');
    v.style.display = 'none';
  });
  const target = document.getElementById(viewId);
  if (target) {
    target.classList.add('active');
    target.style.display = 'block';
  }
}

window.goToHome = function() {
  activeSetId = null;
  closeDropdown();
  renderHome();
  switchView('viewHome');
};

function renderHome() {
  const sets = Store.load();
  const stats = Store.loadStats();
  
  // Dashboard stats
  document.getElementById('statsStreak').innerHTML = `🔥 ${stats.streak}`;
  
  // Overall mastery calculation
  let totalMastered = 0;
  sets.forEach(s => {
    s.cards.forEach(c => {
      if ((c.correctCount || 0) >= 3) totalMastered++;
    });
  });
  document.getElementById('statsMastered').innerHTML = `💎 ${totalMastered}`;

  setsGrid.innerHTML = '';
  const createBtnHTML = `
    <div class="set-card" style="border-style: dashed; align-items: center; justify-content: center; opacity: 0.8" onclick="createNewSet()">
      <h3 style="margin:0; color: var(--accent)">+ Создать новый модуль</h3>
    </div>
  `;
  if (!sets.length) {
    setsGrid.innerHTML = createBtnHTML;
    return;
  }
  sets.forEach(set => {
    const mastered = set.cards.filter(c => (c.correctCount || 0) >= 3).length;
    const progress = set.cards.length ? Math.round((mastered / set.cards.length) * 100) : 0;
    
    const div = document.createElement('div');
    div.className = 'set-card';
    div.innerHTML = `
      <h3>${esc(set.title)}</h3>
      <div class="set-card-meta">
        <span>${set.cards.length} ${plural(set.cards.length, 'термин','термина','терминов')}</span>
        <span>${progress}% изучено</span>
      </div>
      <div class="set-progress-wrap">
        <div class="set-progress-fill" style="width: ${progress}%"></div>
      </div>
    `;
    div.onclick = () => openSet(set.id);
    setsGrid.appendChild(div);
  });
  const cDiv = document.createElement('div');
  cDiv.innerHTML = createBtnHTML;
  setsGrid.appendChild(cDiv.firstElementChild);
}

window.createNewSet = function() {
  const title = prompt('Название нового модуля:');
  if (title !== null) {
    const newSet = Store.createSet(title || 'Новый модуль');
    openSet(newSet.id);
  }
};

function openSet(setId) {
  activeSetId = setId;
  const set = Store.load().find(s => s.id === setId);
  if (!set) return goToHome();
  
  currentSetTitleInput.value = set.title;
  currentSetTitleInput.onblur = () => {
    Store.updateSetTitle(setId, currentSetTitleInput.value);
  };
  currentSetTitleInput.onkeydown = (e) => {
    if (e.key === 'Enter') currentSetTitleInput.blur();
  };

  document.getElementById('btnDeleteSet').onclick = () => {
    if (confirm(`Точно удалить модуль «${set.title}» и все его карточки?`)) {
      Store.deleteSet(setId);
      goToHome();
    }
  };

  renderSetCards();
  switchView('viewSet');
  
  // Start with one empty row if no cards
  if (set.cards.length === 0) {
    addNewEmptyRow();
  }
}

function renderSetCards() {
  if (!activeSetId) return;
  const cards = Store.getCards(activeSetId);
  cardsList.innerHTML = '';
  currentSetCount.textContent = `${cards.length} ${plural(cards.length, 'термин','термина','терминов')}`;
  
  cards.forEach((card, idx) => {
    cardsList.appendChild(buildEditRow(card, idx + 1));
  });
}

function buildEditRow(card, index) {
  const row = document.createElement('div');
  row.className = 'card-edit-row';
  row.dataset.id = card.id;
  
  row.innerHTML = `
    <div class="card-row-header">
      <span class="card-index">${index}</span>
      <button class="card-del" title="Удалить карточку">🗑️</button>
    </div>
    <div class="card-row-inputs">
      <div class="qi-group">
        <input type="text" class="quizlet-input term-input" value="${esc(card.en)}" />
        <span class="qi-label">Термин</span>
      </div>
      <div class="qi-group">
        <input type="text" class="quizlet-input def-input" value="${esc(card.ru)}" />
        <span class="qi-label">Определение</span>
      </div>
    </div>
  `;

  const termInput = row.querySelector('.term-input');
  const defInput = row.querySelector('.def-input');

  termInput.onblur = () => Store.updateCard(activeSetId, card.id, 'en', termInput.value);
  defInput.onblur = () => Store.updateCard(activeSetId, card.id, 'ru', defInput.value);

  // Attach dropdown logic to Term input
  termInput.addEventListener('input', (e) => handleTyping(e.target));
  termInput.addEventListener('keydown', (e) => handleKeydown(e, termInput));
  
  row.querySelector('.card-del').onclick = () => {
    Store.removeCard(activeSetId, card.id);
    renderSetCards();
    showUndoToast(card, activeSetId);
  };

  return row;
}

window.addNewEmptyRow = function() {
  const row = document.createElement('div');
  row.className = 'card-edit-row';
  row.dataset.new = 'true';
  const newIndex = cardsList.children.length + 1;
  
  row.innerHTML = `
    <div class="card-row-header">
      <span class="card-index">${newIndex}</span>
      <button class="card-del" title="Очистить" onclick="this.closest('.card-edit-row').remove()">🗑️</button>
    </div>
    <div class="card-row-inputs">
      <div class="qi-group">
        <input type="text" class="quizlet-input new-term-input" placeholder="Введите термин..." />
        <span class="qi-label">Термин</span>
      </div>
      <div class="qi-group">
        <input type="text" class="quizlet-input new-def-input" placeholder="Введите определение..." />
        <span class="qi-label">Определение</span>
      </div>
      <div class="add-status"></div>
    </div>
  `;

  cardsList.appendChild(row);
  const termInp = row.querySelector('.new-term-input');
  const defInp = row.querySelector('.new-def-input');

  termInp.addEventListener('input', (e) => handleTyping(e.target, true));
  termInp.addEventListener('keydown', (e) => handleKeydown(e, termInp, true, row));
  defInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveNewRow(row);
  });
  
  termInp.focus();
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
};

function saveNewRow(rowEl) {
  const tInp = rowEl.querySelector('.new-term-input');
  const dInp = rowEl.querySelector('.new-def-input');
  const term = tInp.value.trim();
  const def = dInp.value.trim();
  
  if (term && def) {
    const fresh = Store.addCard(activeSetId, term, def, 'std');
    if (fresh) {
      renderSetCards();
      addNewEmptyRow(); // automatically append another line
    } else {
      const st = rowEl.querySelector('.add-status');
      st.textContent = 'Уже существует';
      st.style.color = 'var(--wrong)';
      st.classList.add('show');
      setTimeout(()=> st.classList.remove('show'), 2000);
    }
  }
}

// ── Dropdown & API Logistics ──────────────────────────────

function handleTyping(inputEl, isNewRow = false) {
  activeInputRef = { el: inputEl, isNew: isNewRow };
  const v = inputEl.value;
  if (v.trim().length < 2) { closeDropdown(); return; }
  
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => fetchTranslations(v.trim()), DEBOUNCE_MS);
}

function handleKeydown(e, inputEl, isNewRow = false, rowEl = null) {
  if (!suggestions.length && e.key !== 'Escape') {
    if (e.key === 'Enter' && isNewRow) saveNewRow(rowEl);
    return;
  }
  if(e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex+1, suggestions.length-1); renderDropdown(); }
  if(e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(-1, activeIndex-1); renderDropdown(); }
  if(e.key === 'Enter') { e.preventDefault(); pickSuggestion(Math.max(0, activeIndex)); }
  if(e.key === 'Escape') { closeDropdown(); }
}

function closeDropdown() {
  dropdown.style.display = 'none';
  suggestions = [];
  activeIndex = -1;
}

const SLANG_MAP = {
  "'bout":"about", "cuz":"because", "gonna":"going to", "wanna":"want to", "gotta":"got to",
  "kinda":"kind of", "tbh":"to be honest", "idk":"I do not know", "imo":"in my opinion",
  "rn":"right now", "asap":"as soon as possible", "brb":"be right back", "lol":"laughing out loud",
  "fr":"for real", "slay":"do great", "mid":"mediocre"
};
function isCyrillic(text) { return /[а-яА-ЯёЁ]/.test(text); }
function normalizeForTranslation(text) {
  const lower = text.trim().toLowerCase();
  return SLANG_MAP[lower] || text;
}

async function fetchTranslations(query) {
  if (abortCtrl) abortCtrl.abort();
  abortCtrl = new AbortController();
  const ruInput = isCyrillic(query);
  const apiQuery = ruInput ? query.trim() : normalizeForTranslation(query);

  try {
    const [mm, dict, gem] = await Promise.allSettled([
      fetchMyMemory(apiQuery, abortCtrl.signal, ruInput),
      ruInput ? Promise.resolve([]) : fetchDictionaryMeanings(apiQuery, abortCtrl.signal),
      fetchGemini(apiQuery, abortCtrl.signal, ruInput)
    ]);
    const mmData   = mm.status === 'fulfilled' ? mm.value : [];
    const dictData = dict.status === 'fulfilled' ? dict.value : [];
    const gemData  = gem.status === 'fulfilled' ? gem.value : [];

    const seen = new Set();
    suggestions = [];
    [...gemData, ...dictData, ...mmData].forEach(s => {
      const k = s.target.toLowerCase().trim();
      if (seen.has(k)) return;
      seen.add(k);
      suggestions.push({ ...s, query: query.trim(), isRuQuery: ruInput });
    });
    suggestions = suggestions.slice(0, 5);
    activeIndex = -1;
    renderDropdown();
  } catch(e) {
    if (e.name !== 'AbortError') { closeDropdown(); }
  }
}

// ── Dropdown Portal Placement ──
function renderDropdown() {
  if (!suggestions.length || !activeInputRef) { dropdown.style.display = 'none'; return; }
  suggList.innerHTML = '';
  suggestions.forEach((s, i) => {
    const tag  = s.source==='ai' ? 'AI' : 'СИСТЕМА';
    const el = document.createElement('div');
    el.className = `sug-item${i===activeIndex?' active':''}`;
    el.innerHTML = `
      <div class="sug-main">${esc(s.target)}</div>
      <span class="sug-tag">${tag}</span>
    `;
    el.onmousedown = (e) => { e.preventDefault(); pickSuggestion(i); };
    el.onmouseenter = () => {
      activeIndex = i;
      suggList.querySelectorAll('.sug-item').forEach((e,j) => e.classList.toggle('active', j===i));
    };
    suggList.appendChild(el);
  });
  
  // Position Dropdown under active input
  const rect = activeInputRef.el.getBoundingClientRect();
  dropdown.style.top = `${window.scrollY + rect.bottom + 8}px`;
  dropdown.style.left = `${rect.left}px`;
  dropdown.style.width = `${rect.width}px`;
  dropdown.style.display = 'block';
}

function pickSuggestion(i) {
  if (!activeInputRef) return;
  const s = suggestions[i];
  if (!s) return;
  const term = s.isRuQuery ? s.target : s.query;
  const def = s.isRuQuery ? s.query : s.target;

  const inp = activeInputRef.el;
  if (activeInputRef.isNew) {
    const row = inp.closest('.card-edit-row');
    row.querySelector('.new-term-input').value = term;
    row.querySelector('.new-def-input').value = def;
    saveNewRow(row);
  } else {
    // Fill the definition of existing card if user was editing term
    const row = inp.closest('.card-edit-row');
    row.querySelector('.term-input').value = term;
    row.querySelector('.def-input').value = def;
    
    // Auto-save to store
    Store.updateCard(activeSetId, row.dataset.id, 'en', term);
    Store.updateCard(activeSetId, row.dataset.id, 'ru', def);
  }
  closeDropdown();
}

document.addEventListener('mousedown', e => {
  if (activeInputRef && !activeInputRef.el.contains(e.target) && !dropdown.contains(e.target)) {
    closeDropdown();
  }
});


// ... Rest of the APIs ...
const POS_RU = { noun: 'сущ.', verb: 'гл.', adjective: 'прил.' };
async function fetchMyMemory(text, signal, isRu) {
  const pair = isRu ? 'ru|en' : 'en|ru';
  const res = await fetch(`${MYMEMORY_URL}?q=${encodeURIComponent(text)}&langpair=${pair}`, { signal });
  if (!res.ok) throw new Error();
  const data = await res.json();
  const out = [];
  if (data.responseData?.translatedText) out.push({ target: data.responseData.translatedText.trim(), type: 'std', source: 'std' });
  return out;
}
async function fetchDictionaryMeanings(word, signal) {
  if (word.trim().split(/\s+/).length > 3) return [];
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.trim())}`, { signal });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data) || !data[0]?.meanings) return [];
    const short = data[0].meanings[0]?.definitions?.[0]?.definition?.split(';')[0].split('.')[0].trim();
    if (!short) return [];
    const r = await fetch(`${MYMEMORY_URL}?q=${encodeURIComponent(short)}&langpair=en|ru`, { signal });
    const ru = (await r.json()).responseData?.translatedText?.trim();
    return ru ? [{ target: ru, type: 'std', source: 'dict' }] : [];
  } catch { return []; }
}
async function fetchGemini(text, signal, isRu) {
  const key = localStorage.getItem(API_KEY_STORE);
  if (!key) return [];
  const prompt = isRu 
    ? `You are an expert RU→EN dictionary. For: "${text}" Return JSON array max 3: [{"target": "English translation", "type": "slang"}]`
    : `You are an expert EN→RU dictionary. For: "${text}" Return JSON array max 3: [{"target": "перевод", "type": "slang"}]`;
  try {
    const res = await fetch(`${GEMINI_URL}?key=${key}`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.4,maxOutputTokens:400} }),
      signal
    });
    if (!res.ok) return [];
    const d = await res.json();
    const raw = (d?.candidates?.[0]?.content?.parts?.[0]?.text||'').replace(/```json|```/g,'').trim();
    return (Array.isArray(JSON.parse(raw))?JSON.parse(raw):[]).map(x=>({...x, source:'ai'}));
  } catch { return []; }
}


// ── Utilities (Audio, etc) ────────────────────────────────

window.playAudio = function(e, side) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  const text = side === 'front' ? fcFrontText.textContent : (side === 'back' ? fcBackText.textContent : side);
  speak(text);
};

function speak(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US'; u.rate = 0.9;
  speechSynthesis.speak(u);
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function plural(n, o, f, m) {
  const a = Math.abs(n)%100, a10 = a%10;
  if (a>10&&a<20)return m; if(a10===1)return o; if(a10>=2&&a10<=4)return f; return m;
}

window.exitStudy = function() {
  if (activeSetId) openSet(activeSetId); else goToHome();
};


// ── Undo Toast ────────────────────────────────────────────
function showUndoToast(card, setId) {
  lastDeletedCard = { card, setId };
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.classList.remove('show'); lastDeletedCard = null; }, 4000);
}
toastAction.onclick = () => {
  if (!lastDeletedCard) return;
  const sets = Store.load();
  const set = sets.find(s => s.id === lastDeletedCard.setId);
  if (set) {
    set.cards.push(lastDeletedCard.card);
    Store.save(sets);
    if (activeSetId === lastDeletedCard.setId) renderSetCards();
  }
  toastEl.classList.remove('show');
  lastDeletedCard = null;
};


// ── Study: Flashcards Mode ────────────────────────────────
window.startFlashcards = function() {
  const cards = Store.getCards(activeSetId);
  if (!cards.length) return alert('Сначала добавьте карточки.');
  fcDeck = [...cards]; fcIdx = 0; fcIsFlipped = false;
  renderFlashcard();
  switchView('viewFlashcards');
};
window.flipCard = function() {
  fcIsFlipped = !fcIsFlipped;
  fcInner.classList.toggle('is-flipped', fcIsFlipped);
};
window.nextCard = function() {
  if(fcIdx < fcDeck.length-1) { fcIdx++; fcIsFlipped=false; fcInner.classList.remove('is-flipped'); setTimeout(renderFlashcard,150);}
};
window.prevCard = function() {
  if(fcIdx > 0) { fcIdx--; fcIsFlipped=false; fcInner.classList.remove('is-flipped'); setTimeout(renderFlashcard,150);}
};
function renderFlashcard() {
  fcFrontText.textContent = fcDeck[fcIdx].en;
  fcBackText.textContent = fcDeck[fcIdx].ru;
  fcProgressText.textContent = `${fcIdx + 1} / ${fcDeck.length}`;
  fcProgressBar.style.width = `${((fcIdx + 1) / fcDeck.length) * 100}%`;
}

// ── Study: Learn Mode ─────────────────────────────────────
function shuffle(arr) {
  const a=[...arr];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;
}
window.startLearn = function() { updateQuizModeUI(); initLearnRound(); switchView('viewQuiz'); };
modeEnRu.onclick = () => { quizReverse=false; updateQuizModeUI(); initLearnRound(); };
modeRuEn.onclick = () => { quizReverse=true; updateQuizModeUI(); initLearnRound(); };
function updateQuizModeUI() {
  modeEnRu.classList.toggle('active', !quizReverse);
  modeRuEn.classList.toggle('active', quizReverse);
}
function initLearnRound() {
  const cards = Store.getCards(activeSetId);
  if (cards.length < 4) { quizNeedMore.style.display='block'; quizActive.style.display='none'; quizFinished.style.display='none'; return;}
  quizNeedMore.style.display='none'; quizFinished.style.display='none'; quizActive.style.display='block';
  quizDeck = shuffle(cards); quizIdx=0; quizCorrect=0; quizTotal=0; streak=0; quizLocked=false;
  showQuizQuestion();
}
function showQuizQuestion() {
  if(quizIdx >= quizDeck.length) return showQuizFinished();
  quizLocked = false; const card = quizDeck[quizIdx];
  quizLang.textContent = quizReverse ? 'RU' : 'EN';
  const wordTxt = quizReverse ? card.ru : card.en;
  quizWord.innerHTML = `${esc(wordTxt)} <button class="audio-btn" style="margin-left:16px" onclick="playAudio(event, '${wordTxt.replace(/'/g, "\\'")}')">🔊</button>`;
  quizFeedback.textContent='';
  const wrongs = shuffle(Store.getCards(activeSetId).filter(c=>c.id!==card.id)).slice(0,3);
  const g = c => quizReverse ? c.en : c.ru;
  const opts = shuffle([{t:g(card), c:true}, ...wrongs.map(w=>({t:g(w),c:false}))]);
  optionsGrid.innerHTML='';
  opts.forEach((o,i)=>{
    const btn = document.createElement('button'); btn.className='option-btn';
    btn.innerHTML=`<span class="option-num">${i+1}</span> ${esc(o.t)} <button class="audio-btn" style="margin-left:auto" onclick="playAudio(event, '${o.t.replace(/'/g, "\\'")}')">🔊</button>`;
    btn.onclick = () => answerQuiz(btn, o.c, g(card));
    optionsGrid.appendChild(btn);
  });
}
function answerQuiz(btn, isC, targetAns) {
  if(quizLocked) return; quizLocked=true; quizTotal++;
  const card = quizDeck[quizIdx];
  Store.recordResult(activeSetId, card.id, isC);

  if(isC){btn.classList.add('correct'); quizCorrect++; streak++; }
  else {
    btn.classList.add('wrong'); streak=0; 
    optionsGrid.querySelectorAll('.option-btn').forEach(b=>{if(b.textContent.includes(targetAns))b.classList.add('correct');});
  }
  optionsGrid.querySelectorAll('.option-btn').forEach(b=>b.disabled=true);
  quizScoreEl.textContent=`${quizCorrect} / ${quizTotal}`;
  quizStreakEl.textContent = streak>=3 ? `🔥 Серия: ${streak}`:'';
  quizIdx++; setTimeout(showQuizQuestion, 1200);
}
function showQuizFinished(){
  quizActive.style.display='none'; quizFinished.style.display='block';
  const pct = Math.round((quizCorrect/quizTotal)*100);
  finishMsg.textContent = pct>=80?'Отлично!':'Нужно больше практики';
  finishSub.textContent = `${quizCorrect} из ${quizTotal} правильно (${pct}%)`;
}
btnRestart.onclick=initLearnRound;

// ── Global Handlers ──
document.addEventListener('keydown', e => {
  if (viewFlashcards.classList.contains('active')) {
    if(e.code==='Space'){e.preventDefault();flipCard();}
    if(e.key==='ArrowRight'){e.preventDefault();nextCard();}
    if(e.key==='ArrowLeft'){e.preventDefault();prevCard();}
  }
  if (viewQuiz.classList.contains('active') && quizActive.style.display==='block' && !quizLocked) {
    const n = parseInt(e.key);
    if(n>=1 && n<=4) { const b = optionsGrid.querySelectorAll('.option-btn'); if(b[n-1]) b[n-1].click();}
  }
});
btnSettings.onclick = () => { settingsOverlay.classList.add('open'); geminiKeyInput.focus(); };
window.closeSettings = () => settingsOverlay.classList.remove('open');
settingsOverlay.onclick = e => { if(e.target===settingsOverlay) closeSettings(); };
saveKeyBtn.onclick = () => {
  const k = geminiKeyInput.value.trim();
  if(!k) {keyStatus.textContent='Введите ключ'; keyStatus.style.color='var(--wrong)'; return;}
  localStorage.setItem(API_KEY_STORE, k);
  keyStatus.textContent='✓ Сохранено'; keyStatus.style.color='var(--correct)';
  setTimeout(closeSettings, 1000);
};

// Start App
const savedKey = localStorage.getItem(API_KEY_STORE);
if (savedKey) geminiKeyInput.value = savedKey;
goToHome();
