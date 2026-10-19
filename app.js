'use strict';

/* ==========================================================================
   Données & persistance (localStorage)
   ========================================================================== */

const STORAGE_KEY = 'chesstournament.v1';
const DEFAULT_ELO = 1000;

function defaultState() {
  return { players: [], games: [], tournaments: [], settings: { k: 32 } };
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (raw && Array.isArray(raw.players)) {
      const s = Object.assign(defaultState(), raw);
      s.settings = Object.assign(defaultState().settings, raw.settings);
      return s;
    }
  } catch (e) { /* données corrompues : on repart de zéro */ }
  return defaultState();
}

let state = load();

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    toast("Impossible d'enregistrer (stockage plein ou bloqué).");
  }
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ==========================================================================
   Elo : recalculé en rejouant toutes les parties dans l'ordre chronologique.
   Ainsi, modifier ou supprimer un résultat garde tout cohérent.
   ========================================================================== */

let R = { rating: {}, stats: {}, history: {}, deltas: {} };

function computeRatings() {
  const K = Number(state.settings.k) || 32;
  const rating = {}, stats = {}, history = {}, deltas = {};
  for (const p of state.players) {
    rating[p.id] = p.initialElo ?? DEFAULT_ELO;
    stats[p.id] = { w: 0, d: 0, l: 0 };
    history[p.id] = [{ elo: rating[p.id], gameId: null }];
  }
  const games = [...state.games].sort((a, b) => a.playedAt - b.playedAt);
  for (const g of games) {
    if (!(g.white in rating) || !(g.black in rating)) continue;
    const rw = rating[g.white], rb = rating[g.black];
    const expected = 1 / (1 + 10 ** ((rb - rw) / 400));
    const d = K * (g.result - expected);
    rating[g.white] = rw + d;
    rating[g.black] = rb - d;
    deltas[g.id] = { white: d, black: -d, whiteBefore: rw, blackBefore: rb };
    const sw = stats[g.white], sb = stats[g.black];
    if (g.result === 1) { sw.w++; sb.l++; }
    else if (g.result === 0) { sw.l++; sb.w++; }
    else { sw.d++; sb.d++; }
    history[g.white].push({ elo: rating[g.white], gameId: g.id });
    history[g.black].push({ elo: rating[g.black], gameId: g.id });
  }
  R = { rating, stats, history, deltas };
}

const elo = id => Math.round(R.rating[id] ?? DEFAULT_ELO);
const player = id => state.players.find(p => p.id === id);
const pname = id => (id && player(id)?.name) || '?';
const gameById = id => id ? state.games.find(g => g.id === id) : null;
const tournamentById = id => state.tournaments.find(t => t.id === id);

function addGame(white, black, result, extra = {}) {
  const g = { id: uid(), white, black, result, playedAt: Date.now(), ...extra };
  state.games.push(g);
  return g;
}

function removeGame(id) {
  state.games = state.games.filter(g => g.id !== id);
}

/* ==========================================================================
   Formats de tournoi & recommandation
   ========================================================================== */

const FORMATS = {
  roundrobin: { label: 'Poule unique', desc: 'Tout le monde joue contre tout le monde. Le plus juste, idéal en petit comité.' },
  groups: { label: 'Poules + phase finale', desc: 'Plusieurs poules, les meilleurs de chaque poule se qualifient pour un tableau final.' },
  knockout: { label: 'Tableau', desc: 'Élimination directe, têtes de série selon l\'Elo. Rapide, même avec beaucoup de joueurs.' },
};

const rrGames = (n, double) => (n * (n - 1) / 2) * (double ? 2 : 1);

function groupSizes(n, g) {
  const base = Math.floor(n / g), extra = n % g;
  return Array.from({ length: g }, (_, i) => base + (i < extra ? 1 : 0));
}

function maxQualifiers(n, g) { return Math.min(...groupSizes(n, g)); }

function estimate(format, n, opts) {
  if (n < 2) return 0;
  if (format === 'roundrobin') return rrGames(n, opts.doubleRound);
  if (format === 'knockout') return n - 1 + (opts.thirdPlace && n >= 4 ? 1 : 0);
  const sizes = groupSizes(n, opts.groupCount);
  const q = opts.groupCount * opts.qualifiers;
  return sizes.reduce((s, x) => s + rrGames(x, opts.doubleRound), 0) + (q - 1) + (opts.thirdPlace && q >= 4 ? 1 : 0);
}

function recommend(n) {
  if (n < 2) return null;
  if (n === 2) return { format: 'knockout', reason: 'Deux joueurs : une finale directe suffit.' };
  if (n <= 6) return {
    format: 'roundrobin',
    reason: `Avec ${n} joueurs, une poule unique reste courte (${rrGames(n)} parties, ${n % 2 ? n : n - 1} rondes) et c'est le format le plus équitable.`,
  };
  if (n <= 20) {
    const groupCount = n <= 11 ? 2 : 4;
    const sizes = groupSizes(n, groupCount);
    const min = Math.min(...sizes), max = Math.max(...sizes);
    return {
      format: 'groups', groupCount, qualifiers: 2,
      reason: `Avec ${n} joueurs, une poule unique ferait ${rrGames(n)} parties. Mieux vaut ${groupCount} poules de ${min === max ? min : min + '–' + max} joueurs, `
        + `puis ${groupCount === 2 ? 'demi-finales' : 'quarts de finale'} avec les 2 premiers de chaque poule.`,
    };
  }
  return {
    format: 'knockout',
    reason: `Avec ${n} joueurs, les poules deviennent longues : un tableau à élimination directe garde le tournoi rapide (${n - 1} parties).`,
  };
}

/* ==========================================================================
   Génération : rondes (méthode du cercle), poules (serpentin), tableau
   ========================================================================== */

function roundRobin(ids, double) {
  const list = [...ids];
  if (list.length % 2) list.push(null);
  const n = list.length, rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i], b = list[n - 1 - i];
      if (a && b) {
        const swap = i === 0 ? r % 2 === 1 : i % 2 === 1;
        pairs.push(swap ? [b, a] : [a, b]);
      }
    }
    rounds.push(pairs);
    list.splice(1, 0, list.pop());
  }
  if (double) rounds.push(...rounds.map(rd => rd.map(([w, b]) => [b, w])));
  return rounds;
}

function makeGroup(name, ids, double) {
  const matches = roundRobin(ids, double).flatMap((rd, r) =>
    rd.map(([white, black]) => ({ id: uid(), round: r + 1, white, black, gameId: null })));
  return { name, playerIds: ids, matches };
}

function snakeGroups(sortedIds, g) {
  const groups = Array.from({ length: g }, () => []);
  sortedIds.forEach((id, i) => {
    const row = Math.floor(i / g), col = i % g;
    groups[row % 2 === 0 ? col : g - 1 - col].push(id);
  });
  return groups;
}

function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const s = order.length * 2;
    order = order.flatMap(x => [x, s + 1 - x]);
  }
  return order;
}

function makeBracket(seeds, groupOf) {
  let size = 2;
  while (size < seeds.length) size *= 2;
  const order = seedOrder(size);
  const pairs = [];
  for (let i = 0; i < size; i += 2) pairs.push([seeds[order[i] - 1] ?? null, seeds[order[i + 1] - 1] ?? null]);
  // Évite, si possible, que deux joueurs de la même poule se retrouvent au 1er tour.
  if (groupOf) {
    for (const p of pairs) {
      if (!p[0] || !p[1] || groupOf[p[0]] !== groupOf[p[1]]) continue;
      const q = pairs.find(q => q !== p && q[0] && q[1]
        && groupOf[q[1]] !== groupOf[p[0]] && groupOf[p[1]] !== groupOf[q[0]]);
      if (q) [p[1], q[1]] = [q[1], p[1]];
    }
  }
  return { size, slots: pairs.flat(), matches: {} };
}

/* ==========================================================================
   Lecture d'un tournoi : classements de poule, tableau dérivé, vainqueur
   ========================================================================== */

function groupStandings(group) {
  const rows = {};
  for (const id of group.playerIds) rows[id] = { id, pts: 0, played: 0, w: 0, d: 0, l: 0, sb: 0 };
  const results = [];
  for (const m of group.matches) {
    const g = gameById(m.gameId);
    if (!g) continue;
    const w = rows[m.white], b = rows[m.black];
    w.played++; b.played++;
    w.pts += g.result; b.pts += 1 - g.result;
    if (g.result === 1) { w.w++; b.l++; } else if (g.result === 0) { b.w++; w.l++; } else { w.d++; b.d++; }
    results.push([m.white, m.black, g.result]);
  }
  // Départage Sonneborn-Berger
  for (const [wi, bi, r] of results) {
    rows[wi].sb += r * rows[bi].pts;
    rows[bi].sb += (1 - r) * rows[wi].pts;
  }
  return Object.values(rows).sort((a, b) => b.pts - a.pts || b.sb - a.sb || b.w - a.w || elo(b.id) - elo(a.id));
}

const groupDone = group => group.matches.every(m => gameById(m.gameId));

function bracketView(t) {
  const b = t.bracket;
  const nRounds = Math.log2(b.size);
  const rounds = [];
  const resolve = (key, a, c) => {
    const m = b.matches[key] || {};
    const game = gameById(m.gameId);
    const swap = !!m.swap;
    const white = swap ? c : a, black = swap ? a : c;
    let winner;
    if (a === null && c === null) winner = null;
    else if (a === null) winner = c;
    else if (c === null) winner = a;
    else if (a === undefined || c === undefined || !game) winner = undefined;
    else if (game.result === 1) winner = white;
    else if (game.result === 0) winner = black;
    else winner = m.tiebreakWinner;
    const bye = a === null || c === null;
    const loser = winner && !bye ? (winner === a ? c : a) : undefined;
    return { key, a, b: c, white, black, game, winner, loser, bye, tiebreakWinner: m.tiebreakWinner, swap };
  };
  for (let r = 0; r < nRounds; r++) {
    const count = b.size / 2 ** (r + 1), list = [];
    for (let i = 0; i < count; i++) {
      const a = r === 0 ? b.slots[2 * i] : rounds[r - 1][2 * i].winner;
      const c = r === 0 ? b.slots[2 * i + 1] : rounds[r - 1][2 * i + 1].winner;
      list.push({ ...resolve(`${r}-${i}`, a, c), r, i });
    }
    rounds.push(list);
  }
  let third = null;
  if (t.settings.thirdPlace && nRounds >= 2) {
    const semis = rounds[nRounds - 2];
    const real = semis.every(m => !m.bye);
    if (real) third = { ...resolve('3rd', semis[0].loser, semis[1].loser), r: -1, i: 0 };
  }
  const final = rounds[nRounds - 1][0];
  const done = final.winner !== undefined && (!third || third.winner !== undefined);
  return { rounds, third, final, champion: final.winner, done, nRounds };
}

function findBracketMatch(view, key) {
  if (key === '3rd') return view.third;
  const [r, i] = key.split('-').map(Number);
  return view.rounds[r]?.[i];
}

function bracketLocked(t, view, key) {
  if (key === '3rd') return false;
  const [r, i] = key.split('-').map(Number);
  const next = t.bracket.matches[`${r + 1}-${Math.floor(i / 2)}`];
  if (next?.gameId) return true;
  if (r === view.nRounds - 2 && t.bracket.matches['3rd']?.gameId) return true;
  return false;
}

function tournamentStatus(t) {
  if (t.bracket) {
    const v = bracketView(t);
    if (v.done) return { done: true, champion: v.champion, runnerUp: v.final.loser, third: v.third?.winner, label: 'Terminé' };
    return { done: false, label: t.groups.length ? 'Phase finale' : 'En cours' };
  }
  if (t.format === 'roundrobin' && t.groups[0] && groupDone(t.groups[0])) {
    const st = groupStandings(t.groups[0]);
    return { done: true, champion: st[0]?.id, runnerUp: st[1]?.id, third: st[2]?.id, label: 'Terminé' };
  }
  return { done: false, label: t.format === 'groups' ? 'Phase de poules' : 'En cours' };
}

function roundName(r, nRounds) {
  const left = nRounds - r;
  if (left === 1) return 'Finale';
  if (left === 2) return 'Demi-finales';
  if (left === 3) return 'Quarts de finale';
  if (left === 4) return 'Huitièmes de finale';
  return `1/${2 ** (left - 1)} de finale`;
}

/* ==========================================================================
   Utilitaires d'affichage
   ========================================================================== */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const fmtDate = ts => new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtPts = x => (Number.isInteger(x) ? String(x) : (Math.floor(x) || '') + '½');
const resultText = r => (r === 1 ? '1 – 0' : r === 0 ? '0 – 1' : '½ – ½');

function deltaHtml(d) {
  if (d === undefined) return '';
  const v = Math.round(d);
  const cls = v > 0 ? 'up' : v < 0 ? 'down' : '';
  return `<span class="delta ${cls}">${v > 0 ? '+' : ''}${v}</span>`;
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function sparkline(points) {
  if (points.length < 2) return '<p class="muted small">Pas encore de partie jouée.</p>';
  const min = Math.min(...points), max = Math.max(...points);
  const pad = Math.max(10, (max - min) * 0.1);
  const lo = min - pad, hi = max + pad;
  const W = 100, H = 40;
  const y = v => H - ((v - lo) / (hi - lo)) * H;
  const pts = points.map((v, i) => `${(i / (points.length - 1)) * W},${y(v).toFixed(2)}`).join(' ');
  const base = y(DEFAULT_ELO);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Évolution de l'Elo">
    ${base >= 0 && base <= H ? `<line x1="0" x2="${W}" y1="${base}" y2="${base}"/>` : ''}
    <polyline points="${pts}"/></svg>
    <div class="row small muted" style="justify-content:space-between"><span>min ${Math.round(min)}</span><span>max ${Math.round(max)}</span></div>`;
}

/* ==========================================================================
   Vues
   ========================================================================== */

const app = document.getElementById('app');
let draft = null; // brouillon de création de tournoi

function route() {
  const h = location.hash.replace(/^#/, '') || 'players';
  const [name, id] = h.split('/');
  return { name, id };
}

function render() {
  computeRatings();
  const { name, id } = route();
  const tab = name === 't' || name === 'new' ? 'tournaments' : name;
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  let html;
  switch (name) {
    case 'tournaments': html = viewTournaments(); break;
    case 'new': html = viewNewTournament(); break;
    case 't': html = viewTournament(id); break;
    case 'games': html = viewGames(); break;
    case 'settings': html = viewSettings(); break;
    default: html = viewPlayers();
  }
  app.innerHTML = html;
  renderModal();
}

/* ---------- Joueurs ---------- */

function titlesCount() {
  const c = {};
  for (const t of state.tournaments) {
    const s = tournamentStatus(t);
    if (s.done && s.champion) c[s.champion] = (c[s.champion] || 0) + 1;
  }
  return c;
}

function viewPlayers() {
  const titles = titlesCount();
  const sorted = [...state.players].sort((a, b) => R.rating[b.id] - R.rating[a.id] || a.name.localeCompare(b.name));
  const medals = ['🥇', '🥈', '🥉'];
  const rows = sorted.map((p, i) => {
    const s = R.stats[p.id], n = s.w + s.d + s.l;
    const hist = R.history[p.id];
    const last = hist.length > 1 ? hist[hist.length - 1].elo - hist[hist.length - 2].elo : undefined;
    return `<tr class="clickable" data-action="openPlayer" data-id="${p.id}">
      <td class="rank">${n && i < 3 ? `<span class="medal">${medals[i]}</span>` : i + 1}</td>
      <td><strong>${esc(p.name)}</strong> ${titles[p.id] ? `<span class="badge gold" title="Tournois gagnés">🏆 ${titles[p.id]}</span>` : ''}</td>
      <td class="r"><span class="elo">${elo(p.id)}</span> ${deltaHtml(last)}</td>
      <td class="r num">${n}</td>
      <td class="r num hide-sm">${s.w} / ${s.d} / ${s.l}</td>
    </tr>`;
  }).join('');

  return `
    <div class="page-head"><h1>Classement</h1></div>
    <div class="card">
      <form id="add-player" class="row" autocomplete="off">
        <input type="text" name="name" placeholder="Nom du joueur" maxlength="40" required>
        <input type="number" name="elo" placeholder="Elo (${DEFAULT_ELO})" min="100" max="3500" style="width:120px">
        <button class="btn primary" type="submit">Ajouter</button>
      </form>
      <p class="muted small" style="margin:8px 0 0">Chaque nouveau joueur démarre à ${DEFAULT_ELO} Elo (modifiable ci-dessus).</p>
    </div>
    <div class="card">
      ${state.players.length ? `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Joueur</th><th class="r">Elo</th><th class="r">Parties</th><th class="r hide-sm">V / N / D</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
      : `<div class="empty"><div class="big">♟</div><p>Aucun joueur pour l'instant.<br>Ajoutez-en ci-dessus pour commencer.</p></div>`}
    </div>`;
}

/* ---------- Tournois ---------- */

function viewTournaments() {
  const list = state.tournaments.map(t => {
    const s = tournamentStatus(t);
    return `<a class="card t-item" href="#t/${t.id}">
      <div class="card-head"><h3>${esc(t.name)}</h3><span class="badge ${s.done ? 'win' : 'accent'}">${s.label}</span></div>
      <div class="meta">${FORMATS[t.format].label} · ${t.playerIds.length} joueurs · ${fmtDate(t.createdAt)}</div>
      ${s.done && s.champion ? `<div style="margin-top:8px">🏆 <strong>${esc(pname(s.champion))}</strong></div>` : ''}
    </a>`;
  }).join('');
  return `
    <div class="page-head"><h1>Tournois</h1><a class="btn primary" href="#new">+ Nouveau tournoi</a></div>
    ${state.tournaments.length ? `<div class="grid">${list}</div>`
      : `<div class="card empty"><div class="big">🏆</div><p>Aucun tournoi.<br>Créez-en un en sélectionnant des joueurs.</p></div>`}`;
}

function newDraft() {
  return { name: '', playerIds: new Set(), format: null, touched: false, groupCount: 2, qualifiers: 2, doubleRound: false, thirdPlace: false };
}

function syncDraft() {
  const n = draft.playerIds.size;
  const rec = recommend(n);
  if (!draft.touched && rec) {
    draft.format = rec.format;
    if (rec.groupCount) { draft.groupCount = rec.groupCount; draft.qualifiers = rec.qualifiers; }
  }
  const maxG = Math.max(2, Math.floor(n / 2));
  draft.groupCount = Math.min(Math.max(2, draft.groupCount), maxG);
  if (n >= 4) draft.qualifiers = Math.min(Math.max(1, draft.qualifiers), maxQualifiers(n, draft.groupCount));
  if (draft.format === 'groups' && n < 4) draft.format = rec?.format ?? null;
  return rec;
}

function viewNewTournament() {
  if (!draft) draft = newDraft();
  const rec = syncDraft();
  const n = draft.playerIds.size;
  const sorted = [...state.players].sort((a, b) => R.rating[b.id] - R.rating[a.id]);
  const chips = sorted.map(p => `<button type="button" class="chip ${draft.playerIds.has(p.id) ? 'on' : ''}" data-action="toggleDraftPlayer" data-id="${p.id}">
      ${esc(p.name)}<span class="elo">${elo(p.id)}</span></button>`).join('');

  const formatCard = f => {
    const disabled = n < 2 || (f === 'groups' && n < 4);
    const est = disabled ? '' : `<p><strong style="display:inline">≈ ${estimate(f, n, draft)}</strong> parties</p>`;
    return `<button type="button" class="format ${draft.format === f ? 'on' : ''}" data-action="setFormat" data-format="${f}" ${disabled ? 'disabled' : ''}>
      <strong>${FORMATS[f].label} ${rec?.format === f ? '<span class="badge accent">Recommandé</span>' : ''}</strong>
      <p>${FORMATS[f].desc}</p>${est}</button>`;
  };

  let options = '';
  if (draft.format === 'groups' && n >= 4) {
    const maxG = Math.floor(n / 2);
    const gOpts = Array.from({ length: maxG - 1 }, (_, i) => i + 2)
      .map(g => `<option value="${g}" ${g === draft.groupCount ? 'selected' : ''}>${g} poules (${[...new Set(groupSizes(n, g))].join(' ou ')} joueurs)</option>`).join('');
    const maxQ = maxQualifiers(n, draft.groupCount);
    const qOpts = Array.from({ length: maxQ }, (_, i) => i + 1)
      .map(q => `<option value="${q}" ${q === draft.qualifiers ? 'selected' : ''}>${q} par poule (${q * draft.groupCount} en phase finale)</option>`).join('');
    options += `<div class="row" style="margin-top:12px">
      <label class="field">Nombre de poules<select data-draft="groupCount">${gOpts}</select></label>
      <label class="field">Qualifiés<select data-draft="qualifiers">${qOpts}</select></label></div>`;
  }
  const extras = [];
  if (draft.format === 'roundrobin' || draft.format === 'groups')
    extras.push(`<label class="check"><input type="checkbox" data-draft="doubleRound" ${draft.doubleRound ? 'checked' : ''}> Aller-retour (chaque paire joue avec les deux couleurs)</label>`);
  if ((draft.format === 'knockout' && n >= 4) || (draft.format === 'groups' && draft.groupCount * draft.qualifiers >= 4))
    extras.push(`<label class="check"><input type="checkbox" data-draft="thirdPlace" ${draft.thirdPlace ? 'checked' : ''}> Petite finale (3e place)</label>`);
  if (extras.length) options += `<div class="row" style="margin-top:8px;gap:16px">${extras.join('')}</div>`;

  return `
    <div class="page-head"><h1>Nouveau tournoi</h1><a class="btn ghost" href="#tournaments">Annuler</a></div>
    <div class="card">
      <label class="field">Nom du tournoi
        <input type="text" id="draft-name" value="${esc(draft.name)}" placeholder="Tournoi du ${fmtDate(Date.now())}" maxlength="60"></label>
    </div>
    <div class="card">
      <div class="card-head"><h2>Participants <span class="badge">${n}</span></h2>
        <div class="row"><button class="btn sm" data-action="draftAll">Tous</button><button class="btn sm" data-action="draftNone">Aucun</button></div></div>
      ${state.players.length ? `<div class="chips">${chips}</div>`
      : `<p class="muted">Aucun joueur. <a href="#players">Ajoutez des joueurs</a> d'abord.</p>`}
    </div>
    <div class="card">
      <h2>Format</h2>
      ${rec ? `<div class="advice">💡 <strong>Conseil :</strong> ${esc(rec.reason)}</div>` : '<p class="muted">Sélectionnez au moins 2 joueurs.</p>'}
      <div class="formats">${['roundrobin', 'groups', 'knockout'].map(formatCard).join('')}</div>
      ${options}
    </div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn primary" data-action="createTournament" ${n < 2 || !draft.format ? 'disabled' : ''}>Créer le tournoi</button>
    </div>`;
}

function createTournament() {
  const ids = [...draft.playerIds].filter(player).sort((a, b) => R.rating[b] - R.rating[a]);
  if (ids.length < 2 || !draft.format) return;
  const t = {
    id: uid(),
    name: draft.name.trim() || `Tournoi du ${fmtDate(Date.now())}`,
    createdAt: Date.now(),
    format: draft.format,
    playerIds: ids,
    settings: {
      doubleRound: draft.doubleRound && draft.format !== 'knockout',
      thirdPlace: draft.thirdPlace && draft.format !== 'roundrobin',
      groupCount: draft.format === 'groups' ? draft.groupCount : 1,
      qualifiers: draft.format === 'groups' ? draft.qualifiers : 0,
    },
    groups: [],
    bracket: null,
  };
  if (t.format === 'roundrobin') {
    t.groups = [makeGroup('Poule unique', ids, t.settings.doubleRound)];
  } else if (t.format === 'groups') {
    t.groups = snakeGroups(ids, t.settings.groupCount)
      .map((g, i) => makeGroup(`Poule ${String.fromCharCode(65 + i)}`, g, t.settings.doubleRound));
  } else {
    t.bracket = makeBracket(ids, null);
  }
  state.tournaments.unshift(t);
  save();
  draft = null;
  location.hash = `#t/${t.id}`;
}

function buildFinals(t) {
  if (t.bracket || !t.groups.every(groupDone)) return;
  const q = t.settings.qualifiers;
  const standings = t.groups.map(groupStandings);
  const groupOf = {};
  t.groups.forEach((g, gi) => g.playerIds.forEach(id => { groupOf[id] = gi; }));
  const seeds = [];
  for (let rank = 0; rank < q; rank++) {
    const tier = standings.map(st => st[rank]).filter(Boolean)
      .sort((a, b) => b.pts / (b.played || 1) - a.pts / (a.played || 1) || b.sb - a.sb || elo(b.id) - elo(a.id));
    seeds.push(...tier.map(r => r.id));
  }
  t.bracket = makeBracket(seeds, groupOf);
  save();
  render();
}

function matchHtml({ t, kind, ref, white, black, game, editable, winner, extra = '' }) {
  const d = game ? R.deltas[game.id] : null;
  const cls = id => (winner === undefined || winner === null) ? '' : (id === winner ? 'winner' : 'loser');
  const side = (id, color, right) => `<div class="side ${right ? 'right' : ''}">
      <span class="name ${cls(id)}">${right ? '' : `<span class="piece">${color}</span>`}${esc(pname(id))}${right ? `<span class="piece">${color}</span>` : ''}</span>
      <span class="meta">${d ? `${Math.round(right ? d.blackBefore : d.whiteBefore)} ${deltaHtml(right ? d.black : d.white)}` : elo(id)}</span></div>`;
  let center;
  if (editable) {
    const btn = (v, label) => `<button class="btn ${game?.result === v ? 'on' : ''}" data-action="result" data-t="${t.id}" data-kind="${kind}" data-ref="${ref}" data-value="${v}" title="${resultText(v)}">${label}</button>`;
    center = `<div class="score-btns">${btn(1, '1-0')}${btn(0.5, '½')}${btn(0, '0-1')}</div>`;
  } else {
    center = `<div class="score-final">${game ? resultText(game.result) : '–'}</div>`;
  }
  const clear = editable && game ? `<button class="btn ghost sm" data-action="clearResult" data-t="${t.id}" data-kind="${kind}" data-ref="${ref}">Effacer</button>` : '';
  const extras = [extra, clear].filter(Boolean).join('');
  return `<div class="match">${side(white, '♔', false)}${center}${side(black, '♚', true)}${extras ? `<div class="match-extra">${extras}</div>` : ''}</div>`;
}

function viewGroup(t, group, gi) {
  const st = groupStandings(group);
  const locked = !!t.bracket;
  const q = t.format === 'groups' ? t.settings.qualifiers : 0;
  const rows = st.map((r, i) => `<tr class="${i < q ? 'qualified' : ''}">
      <td class="rank">${i + 1}</td><td><strong>${esc(pname(r.id))}</strong> <span class="muted small">${elo(r.id)}</span></td>
      <td class="r num"><strong>${fmtPts(r.pts)}</strong></td><td class="r num">${r.played}</td>
      <td class="r num hide-sm">${r.w}/${r.d}/${r.l}</td><td class="r num hide-sm">${fmtPts(r.sb)}</td></tr>`).join('');
  const byRound = {};
  for (const m of group.matches) (byRound[m.round] ||= []).push(m);
  const rounds = Object.entries(byRound).map(([r, ms]) => `<div class="round-title">Ronde ${r}</div>` + ms.map(m => {
    const game = gameById(m.gameId);
    const winner = game ? (game.result === 1 ? m.white : game.result === 0 ? m.black : null) : undefined;
    return matchHtml({ t, kind: 'g', ref: `${gi}:${m.id}`, white: m.white, black: m.black, game, editable: !locked, winner });
  }).join('')).join('');
  const played = group.matches.filter(m => gameById(m.gameId)).length;
  return `<div class="card">
    <div class="card-head"><h2>${esc(group.name)}</h2><span class="badge">${played}/${group.matches.length} parties</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Joueur</th><th class="r">Pts</th><th class="r">J</th><th class="r hide-sm">V/N/D</th><th class="r hide-sm" title="Sonneborn-Berger">SB</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${q ? `<p class="muted small" style="margin:6px 0 0">Les ${q} premier${q > 1 ? 's' : ''} se qualifient. Départage : Sonneborn-Berger, victoires, Elo.</p>` : ''}
    ${rounds}
  </div>`;
}

function bracketMatchHtml(t, view, m) {
  if (m.bye) {
    const who = m.a ?? m.b;
    return `<div class="bye">${who ? `<strong>${esc(pname(who))}</strong> — exempt, qualifié d'office` : '—'}</div>`;
  }
  if (m.a === undefined || m.b === undefined) {
    const label = x => x === undefined ? '<span class="muted">À déterminer</span>' : esc(pname(x));
    return `<div class="match pending"><div class="side"><span class="name">${label(m.a)}</span></div><div class="score-final">–</div><div class="side right"><span class="name">${label(m.b)}</span></div></div>`;
  }
  const locked = bracketLocked(t, view, m.key);
  const extras = [];
  if (!m.game && !locked) extras.push(`<button class="btn ghost sm" data-action="swapColors" data-t="${t.id}" data-ref="${m.key}" title="Inverser les couleurs">⇄ Couleurs</button>`);
  if (m.game && m.game.result === 0.5) {
    if (locked) extras.push(`<span class="muted">Départage gagné par <strong>${esc(pname(m.tiebreakWinner))}</strong></span>`);
    else {
      const tb = id => `<button class="btn sm ${m.tiebreakWinner === id ? 'primary' : ''}" data-action="tiebreak" data-t="${t.id}" data-ref="${m.key}" data-winner="${id}">${esc(pname(id))}</button>`;
      extras.push(`<span class="muted">Nulle — vainqueur du départage :</span>${tb(m.white)}${tb(m.black)}`);
    }
  }
  return matchHtml({ t, kind: 'b', ref: m.key, white: m.white, black: m.black, game: m.game, editable: !locked, winner: m.winner, extra: extras.join('') });
}

function viewBracket(t) {
  const view = bracketView(t);
  const cols = view.rounds.map((list, r) => `<div class="bracket-col">
      <div class="round-title">${roundName(r, view.nRounds)}</div>
      <div class="slots">${list.map(m => bracketMatchHtml(t, view, m)).join('')}</div></div>`).join('');
  const third = view.third ? `<div class="round-title">Petite finale</div><div style="max-width:420px">${bracketMatchHtml(t, view, view.third)}</div>` : '';
  const canCancel = t.groups.length && !Object.values(t.bracket.matches).some(m => m.gameId);
  return `<div class="card">
    <div class="card-head"><h2>${t.groups.length ? 'Phase finale' : 'Tableau'}</h2>
      ${canCancel ? `<button class="btn sm" data-action="cancelFinals" data-t="${t.id}">Revenir aux poules</button>` : ''}</div>
    <p class="muted small" style="margin-top:0">En cas de nulle, indiquez le vainqueur du départage (blitz, Armageddon…). L'Elo compte la partie comme nulle.</p>
    <div class="bracket">${cols}</div>${third}</div>`;
}

function viewTournament(id) {
  const t = tournamentById(id);
  if (!t) return `<div class="card empty"><p>Tournoi introuvable.</p><a class="btn" href="#tournaments">Retour</a></div>`;
  const s = tournamentStatus(t);
  const podium = s.done ? `<div class="card champion"><div class="trophy">🏆</div><div>
      <div class="muted small">Vainqueur</div><div class="who">${esc(pname(s.champion))}</div>
      <div class="small muted">${s.runnerUp ? `🥈 ${esc(pname(s.runnerUp))}` : ''}${s.third ? ` · 🥉 ${esc(pname(s.third))}` : ''}</div></div></div>` : '';
  let body = '';
  if (t.groups.length) {
    const allDone = t.groups.every(groupDone);
    if (t.format === 'groups' && !t.bracket) {
      body += `<div class="card"><div class="row" style="justify-content:space-between">
        <span>${allDone ? '✅ Toutes les parties de poule sont jouées.' : 'Saisissez les résultats des poules. La phase finale sera générée ensuite.'}</span>
        <button class="btn primary" data-action="buildFinals" data-t="${t.id}" ${allDone ? '' : 'disabled'}>Générer la phase finale</button></div></div>`;
    }
    if (t.bracket) body += viewBracket(t);
    body += `<div class="grid">${t.groups.map((g, gi) => viewGroup(t, g, gi)).join('')}</div>`;
  } else {
    body += viewBracket(t);
  }
  const opts = [];
  if (t.settings.doubleRound) opts.push('aller-retour');
  if (t.settings.thirdPlace) opts.push('petite finale');
  if (t.format === 'groups') opts.push(`${t.settings.qualifiers} qualifié${t.settings.qualifiers > 1 ? 's' : ''} par poule`);
  return `
    <div class="page-head"><div>
      <a href="#tournaments" class="small">← Tournois</a>
      <h1>${esc(t.name)}</h1>
      <div class="muted">${FORMATS[t.format].label} · ${t.playerIds.length} joueurs${opts.length ? ' · ' + opts.join(', ') : ''} · ${fmtDate(t.createdAt)}</div></div>
      <div class="row"><span class="badge ${s.done ? 'win' : 'accent'}">${s.label}</span>
        <button class="btn sm" data-action="renameTournament" data-t="${t.id}">Renommer</button>
        <button class="btn sm danger" data-action="deleteTournament" data-t="${t.id}">Supprimer</button></div>
    </div>
    ${podium}${body}`;
}

/* ---------- Parties ---------- */

function gameContext(g) {
  if (!g.tournamentId) return 'Partie libre';
  const t = tournamentById(g.tournamentId);
  return `${t ? esc(t.name) : 'Tournoi'}${g.label ? ' · ' + esc(g.label) : ''}`;
}

function viewGames() {
  const players = [...state.players].sort((a, b) => a.name.localeCompare(b.name));
  const opts = players.map(p => `<option value="${p.id}">${esc(p.name)} (${elo(p.id)})</option>`).join('');
  const games = [...state.games].sort((a, b) => b.playedAt - a.playedAt);
  const rows = games.map(g => {
    const d = R.deltas[g.id];
    return `<tr>
      <td class="small muted">${fmtDate(g.playedAt)}</td>
      <td><strong>${esc(pname(g.white))}</strong> ${d ? deltaHtml(d.white) : ''}</td>
      <td class="num" style="text-align:center;white-space:nowrap"><strong>${resultText(g.result)}</strong></td>
      <td><strong>${esc(pname(g.black))}</strong> ${d ? deltaHtml(d.black) : ''}</td>
      <td class="small muted hide-sm">${gameContext(g)}</td>
      <td class="r">${g.tournamentId ? '' : `<button class="btn ghost sm" data-action="deleteGame" data-id="${g.id}" title="Supprimer">✕</button>`}</td></tr>`;
  }).join('');
  return `
    <div class="page-head"><h1>Parties</h1></div>
    <div class="card">
      <h2>Partie libre</h2>
      ${players.length < 2 ? '<p class="muted">Il faut au moins 2 joueurs.</p>' : `
      <form id="free-game" class="row">
        <label class="field" style="flex:1 1 160px">♔ Blancs<select name="white" required>${opts}</select></label>
        <label class="field" style="flex:1 1 160px">♚ Noirs<select name="black" required>${players.length > 1 ? opts.replace(`value="${players[1].id}"`, `value="${players[1].id}" selected`) : opts}</select></label>
        <label class="field">Résultat<select name="result">
          <option value="1">1 – 0 (Blancs gagnent)</option><option value="0.5">½ – ½ (Nulle)</option><option value="0">0 – 1 (Noirs gagnent)</option></select></label>
        <button class="btn primary" type="submit" style="margin-bottom:12px">Enregistrer</button>
      </form>`}
    </div>
    <div class="card">
      <h2>Historique <span class="badge">${games.length}</span></h2>
      ${games.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Blancs</th><th style="text-align:center">Score</th><th>Noirs</th><th class="hide-sm">Contexte</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : '<p class="muted">Aucune partie jouée.</p>'}
    </div>`;
}

/* ---------- Réglages ---------- */

function viewSettings() {
  const k = state.settings.k;
  const kOpts = [16, 20, 24, 32, 40].map(v => `<option value="${v}" ${v === k ? 'selected' : ''}>K = ${v}</option>`).join('');
  return `
    <div class="page-head"><h1>Réglages</h1></div>
    <div class="card">
      <h2>Calcul de l'Elo</h2>
      <label class="field" style="max-width:260px">Facteur K<select id="k-factor">${kOpts}</select></label>
      <p class="muted small">Le facteur K fixe l'amplitude des variations : avec K = 32, battre un adversaire de même niveau rapporte +16.
      Tout l'historique est recalculé quand on change ce réglage.</p>
    </div>
    <div class="card">
      <h2>Données</h2>
      <p class="muted small">Tout est stocké dans ce navigateur (localStorage). Exportez une sauvegarde pour changer d'appareil ou ne rien perdre.</p>
      <div class="row">
        <button class="btn" data-action="exportData">⬇ Exporter (JSON)</button>
        <label class="btn">⬆ Importer<input type="file" id="import-file" accept="application/json,.json" hidden></label>
        <button class="btn danger" data-action="resetData">Tout effacer</button>
      </div>
    </div>`;
}

/* ---------- Fiche joueur (modale) ---------- */

let modal = null;

function renderModal() {
  const root = document.getElementById('modal-root');
  if (!modal) { root.innerHTML = ''; return; }
  const p = player(modal.id);
  if (!p) { modal = null; root.innerHTML = ''; return; }
  const s = R.stats[p.id], n = s.w + s.d + s.l;
  const hist = R.history[p.id];
  const games = hist.slice(1).map(h => gameById(h.gameId)).filter(Boolean).reverse();
  const rows = games.slice(0, 30).map(g => {
    const isWhite = g.white === p.id;
    const opp = isWhite ? g.black : g.white;
    const score = isWhite ? g.result : 1 - g.result;
    const d = R.deltas[g.id];
    return `<tr><td class="small muted">${fmtDate(g.playedAt)}</td>
      <td>${isWhite ? '♔' : '♚'} ${esc(pname(opp))}</td>
      <td><span class="badge ${score === 1 ? 'win' : ''}">${score === 1 ? 'Victoire' : score === 0 ? 'Défaite' : 'Nulle'}</span></td>
      <td class="r">${deltaHtml(isWhite ? d.white : d.black)}</td></tr>`;
  }).join('');
  const titles = titlesCount()[p.id] || 0;
  root.innerHTML = `<div class="modal-backdrop" data-action="closeModal">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="card-head"><h2>${esc(p.name)}</h2><button class="btn ghost sm" data-action="closeModal">✕</button></div>
      <div class="stats">
        <div class="stat"><b>${elo(p.id)}</b><span>Elo</span></div>
        <div class="stat"><b>${n}</b><span>Parties</span></div>
        <div class="stat"><b>${n ? Math.round((s.w + s.d / 2) / n * 100) : 0}%</b><span>Score</span></div>
        <div class="stat"><b>${titles}</b><span>Titres</span></div>
      </div>
      ${sparkline(hist.map(h => h.elo))}
      <h3 style="margin-top:16px">Dernières parties</h3>
      ${rows ? `<div class="table-wrap"><table><tbody>${rows}</tbody></table></div>` : '<p class="muted small">Aucune partie.</p>'}
      <div class="row" style="margin-top:16px;justify-content:flex-end">
        <button class="btn sm" data-action="renamePlayer" data-id="${p.id}">Renommer</button>
        <button class="btn sm danger" data-action="deletePlayer" data-id="${p.id}">Supprimer</button>
      </div>
    </div></div>`;
}

/* ==========================================================================
   Actions
   ========================================================================== */

function findGroupMatch(t, ref) {
  const [gi, mid] = ref.split(':');
  const group = t.groups[Number(gi)];
  return group && { group, match: group.matches.find(m => m.id === mid) };
}

const actions = {
  openPlayer({ id }) { modal = { id }; renderModal(); },
  closeModal(_, el, e) {
    if (el.classList.contains('modal-backdrop') && e.target !== el) return;
    modal = null; renderModal();
  },
  renamePlayer({ id }) {
    const p = player(id);
    const name = prompt('Nouveau nom :', p.name);
    if (name && name.trim()) { p.name = name.trim().slice(0, 40); save(); render(); }
  },
  deletePlayer({ id }) {
    const p = player(id);
    if (state.games.some(g => g.white === id || g.black === id) || state.tournaments.some(t => t.playerIds.includes(id))) {
      toast(`${p.name} a déjà joué ou participe à un tournoi : suppression impossible.`);
      return;
    }
    if (!confirm(`Supprimer ${p.name} ?`)) return;
    state.players = state.players.filter(x => x.id !== id);
    modal = null; save(); render();
  },

  toggleDraftPlayer({ id }) {
    draft.playerIds.has(id) ? draft.playerIds.delete(id) : draft.playerIds.add(id);
    render();
  },
  draftAll() { state.players.forEach(p => draft.playerIds.add(p.id)); render(); },
  draftNone() { draft.playerIds.clear(); render(); },
  setFormat({ format }) { draft.format = format; draft.touched = true; render(); },
  createTournament,

  result({ t: tid, kind, ref, value }) {
    const t = tournamentById(tid);
    const v = Number(value);
    let match, white, black, label;
    if (kind === 'g') {
      if (t.bracket) return toast('La phase finale est lancée : les poules sont verrouillées.');
      const found = findGroupMatch(t, ref);
      if (!found?.match) return;
      ({ match } = found); white = match.white; black = match.black;
      label = `${found.group.name} · Ronde ${match.round}`;
    } else {
      const view = bracketView(t);
      const bm = findBracketMatch(view, ref);
      if (!bm || bm.bye || bm.a === undefined || bm.b === undefined) return;
      if (bracketLocked(t, view, ref)) return toast('Le tour suivant a déjà commencé.');
      match = t.bracket.matches[ref] ||= {};
      white = bm.white; black = bm.black;
      label = ref === '3rd' ? 'Petite finale' : roundName(bm.r, view.nRounds);
    }
    const existing = gameById(match.gameId);
    if (existing) {
      if (existing.result === v) return;
      existing.result = v;
    } else {
      match.gameId = addGame(white, black, v, { tournamentId: t.id, label }).id;
    }
    if (kind === 'b' && v !== 0.5) delete match.tiebreakWinner;
    save(); render();
  },
  clearResult({ t: tid, kind, ref }) {
    const t = tournamentById(tid);
    let match;
    if (kind === 'g') {
      if (t.bracket) return;
      match = findGroupMatch(t, ref)?.match;
    } else {
      if (bracketLocked(t, bracketView(t), ref)) return;
      match = t.bracket.matches[ref];
      if (match) delete match.tiebreakWinner;
    }
    if (!match?.gameId) return;
    removeGame(match.gameId);
    match.gameId = null;
    save(); render();
  },
  tiebreak({ t: tid, ref, winner }) {
    const t = tournamentById(tid);
    if (bracketLocked(t, bracketView(t), ref)) return;
    (t.bracket.matches[ref] ||= {}).tiebreakWinner = winner;
    save(); render();
  },
  swapColors({ t: tid, ref }) {
    const t = tournamentById(tid);
    const m = t.bracket.matches[ref] ||= {};
    if (m.gameId) return;
    m.swap = !m.swap;
    save(); render();
  },
  buildFinals({ t }) { buildFinals(tournamentById(t)); },
  cancelFinals({ t: tid }) {
    const t = tournamentById(tid);
    if (Object.values(t.bracket.matches).some(m => m.gameId)) return;
    t.bracket = null; save(); render();
  },
  renameTournament({ t: tid }) {
    const t = tournamentById(tid);
    const name = prompt('Nom du tournoi :', t.name);
    if (name && name.trim()) { t.name = name.trim().slice(0, 60); save(); render(); }
  },
  deleteTournament({ t: tid }) {
    const t = tournamentById(tid);
    const n = state.games.filter(g => g.tournamentId === tid).length;
    if (!confirm(`Supprimer « ${t.name} » ?${n ? `\n\nSes ${n} partie(s) seront supprimées et l'Elo recalculé.` : ''}`)) return;
    state.games = state.games.filter(g => g.tournamentId !== tid);
    state.tournaments = state.tournaments.filter(x => x.id !== tid);
    save();
    location.hash = '#tournaments';
  },

  deleteGame({ id }) {
    if (!confirm('Supprimer cette partie ? L\'Elo sera recalculé.')) return;
    removeGame(id); save(); render();
  },

  exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tournois-echecs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  resetData() {
    if (!confirm('Effacer TOUS les joueurs, parties et tournois ? Cette action est irréversible.')) return;
    state = defaultState(); save(); render(); toast('Données effacées.');
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  if (el.tagName === 'BUTTON') e.preventDefault();
  actions[el.dataset.action](el.dataset, el, e);
});

document.addEventListener('submit', e => {
  const form = e.target;
  e.preventDefault();
  if (form.id === 'add-player') {
    const name = form.name.value.trim();
    if (!name) return;
    if (state.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return toast('Ce joueur existe déjà.');
    const initial = Number(form.elo.value);
    state.players.push({ id: uid(), name: name.slice(0, 40), initialElo: initial >= 100 && initial <= 3500 ? Math.round(initial) : DEFAULT_ELO, createdAt: Date.now() });
    save(); render();
    document.querySelector('#add-player input[name=name]')?.focus();
    toast(`${name} ajouté.`);
  } else if (form.id === 'free-game') {
    const white = form.white.value, black = form.black.value;
    if (white === black) return toast('Choisissez deux joueurs différents.');
    addGame(white, black, Number(form.result.value));
    save(); render();
    const d = R.deltas[state.games[state.games.length - 1].id];
    toast(`Partie enregistrée : ${pname(white)} ${d.white >= 0 ? '+' : ''}${Math.round(d.white)}, ${pname(black)} ${d.black >= 0 ? '+' : ''}${Math.round(d.black)}`);
  }
});

document.addEventListener('input', e => {
  if (e.target.id === 'draft-name' && draft) draft.name = e.target.value;
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.draft && draft) {
    const key = el.dataset.draft;
    draft[key] = el.type === 'checkbox' ? el.checked : Number(el.value);
    if (key === 'groupCount' || key === 'qualifiers') draft.touched = true;
    render();
  } else if (el.id === 'k-factor') {
    state.settings.k = Number(el.value); save(); render(); toast('Elo recalculé.');
  } else if (el.id === 'import-file' && el.files[0]) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.players) || !Array.isArray(data.games) || !Array.isArray(data.tournaments)) throw new Error();
        if (!confirm('Remplacer les données actuelles par celles du fichier ?')) return;
        state = Object.assign(defaultState(), data);
        state.settings = Object.assign(defaultState().settings, data.settings);
        save(); render(); toast('Données importées.');
      } catch { toast('Fichier invalide.'); }
    };
    reader.readAsText(el.files[0]);
    el.value = '';
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && modal) { modal = null; renderModal(); }
});

window.addEventListener('hashchange', () => {
  if (route().name !== 'new') draft = null;
  modal = null;
  render();
  window.scrollTo(0, 0);
});

window.addEventListener('storage', e => {
  if (e.key === STORAGE_KEY) { state = load(); render(); }
});

render();
