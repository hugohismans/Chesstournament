'use strict';

/* ==========================================================================
   Pendule d'échecs plein écran
   Chaque joueur tape sur sa moitié d'écran après avoir joué : son temps
   s'arrête (+ incrément) et celui de l'adversaire démarre.
   Chargé avant app.js : n'utilise ses fonctions qu'au moment des appels.
   ========================================================================== */

const CLOCK_PRESETS = [[1, 0], [3, 0], [3, 2], [5, 0], [5, 3], [10, 0], [10, 5], [15, 10], [30, 0]];
const LOW_TIME_MS = 10000;

let clockDraft = null; // réglages avant le lancement
let clock = null;      // partie en cours (overlay)
let wakeLock = null;

const otherSide = s => (s === 'w' ? 'b' : 'w');

function newClockDraft(ctx = null, white = '', black = '') {
  const pref = state.settings.clock || { minutes: 5, inc: 3 };
  return { ctx, white, black, minutes: pref.minutes, inc: pref.inc };
}

function fmtClock(ms) {
  ms = Math.max(0, ms);
  if (ms < 20000) return (Math.floor(ms / 100) / 10).toFixed(1);
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const presetLabel = (m, i) => `${m}+${i}`;

/* ---------- Écran de réglage (onglet Pendule ou depuis un match) ---------- */

function clockSetupHtml() {
  const d = clockDraft;
  const fixed = !!d.ctx;
  const players = [...state.players].sort((a, b) => a.name.localeCompare(b.name));
  const sel = (side, value) => `<select data-clock="${side}"><option value="">— Sans joueur —</option>${players
    .map(p => `<option value="${p.id}" ${p.id === value ? 'selected' : ''}>${esc(p.name)} (${elo(p.id)})</option>`).join('')}</select>`;
  const chips = CLOCK_PRESETS.map(([m, i]) => `<button type="button" class="chip ${m === d.minutes && i === d.inc ? 'on' : ''}"
      data-action="clockPreset" data-m="${m}" data-i="${i}">${presetLabel(m, i)}</button>`).join('');
  const names = fixed
    ? `<p><strong>♔ ${esc(pname(d.white))}</strong> <span class="muted">contre</span> <strong>♚ ${esc(pname(d.black))}</strong></p>`
    : `<div class="row"><label class="field" style="flex:1 1 160px">♔ Blancs${sel('white', d.white)}</label>
       <label class="field" style="flex:1 1 160px">♚ Noirs${sel('black', d.black)}</label></div>
       <p class="muted small" style="margin-top:0">Facultatif : avec deux joueurs, le résultat pourra être enregistré comme partie libre (Elo mis à jour).</p>`;
  return `
    ${names}
    <h3>Cadence</h3>
    <div class="chips">${chips}</div>
    <div class="row" style="margin-top:12px">
      <label class="field">Minutes<input type="number" data-clock="minutes" min="0.25" max="180" step="0.25" value="${d.minutes}" style="width:110px"></label>
      <label class="field">Incrément (s)<input type="number" data-clock="inc" min="0" max="60" value="${d.inc}" style="width:110px"></label>
    </div>
    <div class="row" style="justify-content:flex-end">
      ${fixed ? '<button class="btn ghost" data-action="clockExit">Annuler</button>' : ''}
      <button class="btn primary" data-action="clockStart">▶ Lancer la pendule</button>
    </div>`;
}

function viewClockPage() {
  if (!clockDraft || clockDraft.ctx) clockDraft = newClockDraft();
  return `
    <div class="page-head"><h1>Pendule</h1></div>
    <div class="card">${clockSetupHtml()}</div>
    <p class="muted small">Posez le téléphone entre les joueurs. Chacun tape sur sa moitié de l'écran après avoir joué.
    Les Noirs tapent en premier pour lancer le temps des Blancs. Depuis un match de tournoi, le bouton ⏱ ouvre la pendule
    et permet d'enregistrer le résultat directement.</p>`;
}

/* ---------- Overlay plein écran ---------- */

function sideHtml(side, pos) {
  const c = clock;
  const id = side === 'w' ? c.white : c.black;
  const name = id ? pname(id) : (side === 'w' ? 'Blancs' : 'Noirs');
  const cls = ['clock-side', pos,
    c.active === side ? 'active' : '',
    c.flagged === side ? 'flagged' : '',
    c.time[side] < LOW_TIME_MS ? 'low' : ''].join(' ');
  let hint = '';
  if (c.flagged === side) hint = 'Temps écoulé';
  else if (!c.started && side === 'b') hint = 'Touchez pour lancer la pendule';
  else if (!c.started) hint = 'Les Noirs lancent la pendule';
  return `<button class="${cls}" data-side="${side}" type="button">
      <span class="clock-name">${side === 'w' ? '♔' : '♚'} ${esc(name)}</span>
      <span class="clock-time" id="clock-time-${side}">${fmtClock(c.time[side])}</span>
      <span class="clock-meta">${hint || `${c.moves[side]} coup${c.moves[side] > 1 ? 's' : ''}`}</span>
    </button>`;
}

function clockResultHtml() {
  const c = clock;
  if (!c.white || !c.black) return '';
  const suggested = c.flagged ? (c.flagged === 'w' ? 0 : 1) : null;
  const btn = (v, label) => `<button class="btn ${suggested === v ? 'primary' : ''}" data-action="clockRecord" data-value="${v}">${label}</button>`;
  return `<div class="clock-result">
      <strong>${c.flagged ? `Temps écoulé pour ${esc(pname(c.flagged === 'w' ? c.white : c.black))}` : 'Enregistrer le résultat'}</strong>
      <div class="row" style="justify-content:center">
        ${btn(1, `1-0 ${esc(pname(c.white))}`)}${btn(0.5, '½-½')}${btn(0, `0-1 ${esc(pname(c.black))}`)}
      </div></div>`;
}

function renderClock() {
  const root = document.getElementById('clock-root');
  if (!clockDraft?.ctx && !clock) { root.innerHTML = ''; document.body.classList.remove('clock-open'); return; }
  document.body.classList.add('clock-open');
  if (!clock) {
    root.innerHTML = `<div class="clock-overlay setup"><div class="modal"><div class="card-head"><h2>⏱ Pendule</h2>
      <button class="btn ghost sm" data-action="clockExit">✕</button></div>${clockSetupHtml()}</div></div>`;
    return;
  }
  const c = clock;
  const top = otherSide(c.bottom);
  const paused = c.started && !c.running && !c.flagged;
  const bar = `<div class="clock-bar">
      <span class="clock-cadence">${presetLabel(c.minutes, c.inc)}</span>
      ${c.started && !c.flagged ? `<button class="btn sm" data-action="clockPause">${c.running ? '⏸ Pause' : '▶ Reprendre'}</button>` : ''}
      ${!c.started ? '<button class="btn sm" data-action="clockSwap" title="Inverser haut / bas">⇅ Inverser</button>' : ''}
      ${c.started ? '<button class="btn sm" data-action="clockReset">↺ Remettre à zéro</button>' : ''}
      <button class="btn sm" data-action="clockExit">✕ Quitter</button>
    </div>`;
  root.innerHTML = `<div class="clock-overlay play">
      ${sideHtml(top, 'top')}
      ${bar}
      ${(paused || c.flagged) ? clockResultHtml() : ''}
      ${sideHtml(c.bottom, 'bottom')}
    </div>`;
}

function updateClockTimes() {
  for (const s of ['w', 'b']) {
    const el = document.getElementById(`clock-time-${s}`);
    if (el) el.textContent = fmtClock(clock.time[s]);
    const side = el?.closest('.clock-side');
    if (side) side.classList.toggle('low', clock.time[s] < LOW_TIME_MS);
  }
}

function clockTick() {
  if (!clock?.running) return;
  const now = performance.now();
  const s = clock.active;
  clock.time[s] -= now - clock.lastTs;
  clock.lastTs = now;
  if (clock.time[s] <= 0) {
    clock.time[s] = 0;
    clock.running = false;
    clock.flagged = s;
    beep();
    navigator.vibrate?.([200, 100, 200]);
    renderClock();
    return;
  }
  updateClockTimes();
  requestAnimationFrame(clockTick);
}

function clockTap(side) {
  const c = clock;
  if (!c || c.flagged) return;
  if (!c.started) {
    c.started = true;
    c.running = true;
    c.active = otherSide(side);
  } else {
    if (!c.running || c.active !== side) return;
    c.time[side] += c.inc * 1000;
    c.moves[side]++;
    c.active = otherSide(side);
  }
  c.lastTs = performance.now();
  navigator.vibrate?.(25);
  renderClock();
  requestAnimationFrame(clockTick);
}

let audioCtx;
function beep() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.25, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.8);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.8);
  } catch (e) { /* pas de son disponible */ }
}

async function enterFullscreen() {
  try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.(); } catch (e) { /* non supporté (iPhone) */ }
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) { /* écran de veille non bloquable */ }
}

function leaveFullscreen() {
  try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) { /* ignore */ }
  try { wakeLock?.release(); } catch (e) { /* ignore */ }
  wakeLock = null;
}

function closeClock() {
  clock = null;
  if (clockDraft?.ctx) clockDraft = null;
  leaveFullscreen();
  renderClock();
  render();
}

const clockActions = {
  openClock({ t, kind, ref, white, black }) {
    clockDraft = newClockDraft({ t, kind, ref }, white, black);
    renderClock();
  },
  clockPreset({ m, i }) {
    clockDraft.minutes = Number(m);
    clockDraft.inc = Number(i);
    clockDraft.ctx ? renderClock() : render();
  },
  clockStart() {
    const d = clockDraft;
    if (!(d.minutes > 0)) return toast('Indiquez une durée.');
    if (d.white && d.white === d.black) return toast('Choisissez deux joueurs différents.');
    state.settings.clock = { minutes: d.minutes, inc: d.inc };
    save();
    const ms = d.minutes * 60000;
    clock = {
      ctx: d.ctx, white: d.white || null, black: d.black || null,
      minutes: d.minutes, inc: d.inc,
      time: { w: ms, b: ms }, moves: { w: 0, b: 0 },
      active: null, running: false, started: false, flagged: null, lastTs: 0, bottom: 'w',
    };
    enterFullscreen();
    renderClock();
  },
  clockPause() {
    if (!clock?.started || clock.flagged) return;
    if (clock.running) {
      clockTick();
      clock.running = false;
    } else {
      clock.running = true;
      clock.lastTs = performance.now();
      requestAnimationFrame(clockTick);
    }
    renderClock();
  },
  clockReset() {
    if (!confirm('Remettre la pendule à zéro ?')) return;
    const ms = clock.minutes * 60000;
    Object.assign(clock, { time: { w: ms, b: ms }, moves: { w: 0, b: 0 }, active: null, running: false, started: false, flagged: null });
    renderClock();
  },
  clockSwap() { clock.bottom = otherSide(clock.bottom); renderClock(); },
  clockExit() {
    if (clock?.started && !clock.flagged && !confirm('Quitter la pendule ? Le temps en cours sera perdu.')) return;
    closeClock();
  },
  clockRecord({ value }) {
    const c = clock, v = Number(value);
    if (c.ctx) {
      actions.result({ t: c.ctx.t, kind: c.ctx.kind, ref: c.ctx.ref, value });
    } else {
      addGame(c.white, c.black, v);
      save();
    }
    closeClock();
    toast(`Résultat enregistré : ${pname(c.white)} ${resultText(v)} ${pname(c.black)}`);
  },
};

document.addEventListener('pointerdown', e => {
  const side = e.target.closest('.clock-side');
  if (!side) return;
  e.preventDefault();
  clockTap(side.dataset.side);
});

document.addEventListener('keydown', e => {
  // Clavier (ordinateur) : barre espace = le joueur au trait passe la main.
  if (clock && e.code === 'Space') {
    e.preventDefault();
    clockTap(clock.started ? clock.active : 'b');
  }
});

document.addEventListener('input', e => {
  const key = e.target.dataset?.clock;
  if (!key || !clockDraft) return;
  if (key === 'minutes' || key === 'inc') clockDraft[key] = Number(e.target.value);
  else clockDraft[key] = e.target.value;
  e.target.closest('.card, .modal')?.querySelectorAll('.chips .chip').forEach(ch =>
    ch.classList.toggle('on', Number(ch.dataset.m) === clockDraft.minutes && Number(ch.dataset.i) === clockDraft.inc));
});
