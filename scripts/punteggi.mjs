// Punteggi e classifica di una lega, calcolati come nell'app (src/app.js: scoreRound, standings).
// Servono alle notifiche di recap (fine giornata, sera, sorpassi). Se cambi le regole nell'app, cambiale anche qui.
const ROLE = { A: 4, C: 8, D: 18, P: 60 };
const X12 = [-50, -20, 0, 6, 10, 15, 25, 60, 150, 350];
const MULT_EX = [0, 1, 2.5, 6];
const isNum = v => v !== null && v !== '' && v !== undefined && !isNaN(Number(v));
const r1 = x => Math.round(x * 10) / 10;
export const tokens = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').split(' ').filter(t => t.length >= 2);
export const outcome = m => { const h = +m.hg, a = +m.ag; return h > a ? '1' : h < a ? '2' : 'X'; };
export const validMatch = m => !m.nullo && isNum(m.hg) && isNum(m.ag);
function exactBase(h, a) { h = +h; a = +a; const t = h + a; if (t <= 2) return 6; if (t >= 5 || Math.abs(h - a) >= 4) return 25; return 12; }

/* tutti i dati di una lega che servono al calcolo */
export async function leagueData(L) {
  const f = L.ref.collection('fantabet');
  const [cfgS, adjS, roseS, gS] = await Promise.all([f.doc('config').get(), f.doc('rettifiche').get(), f.doc('rose').get(), L.ref.collection('giornate').get()]);
  const cfg = cfgS.data() || {};
  const pids = Object.keys(cfg.players || {}).filter(k => /^p\d+$/.test(k)).sort((a, b) => a.slice(1) - b.slice(1));
  const rounds = {};
  gS.docs.forEach(d => { const x = d.data(); if (isNum(x.num)) rounds[+x.num] = x; });
  const slips = {};
  for (const u of new Set(Object.values(cfg.members || {}).filter(Boolean))) {
    slips[u] = {};
    (await L.ref.collection('schedine').doc(u).collection('giornate').get()).docs.forEach(d => {
      const x = d.data(); if (!x || !isNum(x.num)) return;
      const ts = x.consegnataTs?.toDate ? x.consegnataTs.toDate().toISOString() : '';
      slips[u][+x.num] = { ...x, consegnata: x.consegnata || ts };
    });
  }
  return { cfg, pids, rounds, slips, adj: adjS.data()?.items || [], rose: roseS.data()?.p || {} };
}

export function makeScorer(D) {
  const { cfg, pids, slips, rose } = D;
  const memberOf = pid => cfg.members?.[pid] || null;
  const name = pid => cfg.players?.[pid] || pid;
  function getPred(r, pid) {
    const u = memberOf(pid); const p = (u && slips[u]?.[r.num]) || r.preds?.[pid] || {};
    const x12 = Array.isArray(p.x12) ? p.x12.slice(0, 10) : []; while (x12.length < 10) x12.push('');
    const exact = Array.isArray(p.exact) ? p.exact.slice(0, 3) : []; while (exact.length < 3) exact.push({ m: -1, h: '', a: '' });
    const scorers = Array.isArray(p.scorers) ? p.scorers.slice(0, 3) : []; while (scorers.length < 3) scorers.push({ name: '', role: 'A' });
    return { status: p.status || '', x12, exact, scorers, consegnata: p.consegnata || '' };
  }
  function playerOf(n) {
    const pt = tokens(n); if (!pt.length) return null; const ns = new Set();
    for (const k of Object.keys(rose)) { const st = tokens(k); const long = st.filter(x => x.length >= 3);
      if (pt.every(x => st.includes(x)) || (long.length && long.every(x => pt.includes(x)))) ns.add(k); }
    return ns.size === 1 ? [...ns][0] : null;
  }
  function samePlayer(a, b) {
    if (!String(a || '').trim() || !String(b || '').trim()) return false;
    const pa = playerOf(a), pb = playerOf(b); if (pa && pb) return pa === pb;
    const A = tokens(a).filter(t => t.length >= 3), B = tokens(b).filter(t => t.length >= 3);
    if (!A.length || !B.length) return tokens(a).join(' ') === tokens(b).join(' ');
    return A.every(t => B.includes(t)) || B.every(t => A.includes(t));
  }
  const exKey = e => isNum(e.h) && isNum(e.a) && +e.m >= 0 ? `${+e.m}:${+e.h}-${+e.a}` : '';
  function clashes(r, pid) {
    const p = getPred(r, pid); if (p.status === 'consegnato' && !p.consegnata) return { ex: {}, sc: {} };
    const before = p.consegnata || null; const tex = {}, tsc = [];
    for (const q of pids) { if (q === pid) continue; const o = getPred(r, q);
      if (o.status !== 'consegnato' || !o.consegnata) continue; if (before && !(o.consegnata < before)) continue;
      o.exact.forEach(e => { const k = exKey(e); if (k && !tex[k]) tex[k] = q; });
      o.scorers.forEach(x => { if (String(x.name || '').trim()) tsc.push({ name: x.name, q }); }); }
    const ex = {}, sc = {};
    p.exact.forEach((e, k) => { const q = tex[exKey(e)]; if (q) ex[k] = q; });
    p.scorers.forEach((x, k) => { const o = tsc.find(y => samePlayer(x.name, y.name)); if (o) sc[k] = o.q; });
    return { ex, sc };
  }
  function findGoals(r, n) {
    const pt = tokens(n); if (!pt.length) return 0; let goals = 0;
    for (const s of r.scorers || []) { const st = tokens(s.name); if (!st.length) continue; const long = st.filter(t => t.length >= 3);
      if (pt.every(t => st.includes(t)) || (long.length && long.every(t => pt.includes(t)))) goals += Number(s.goals) || 0; }
    return goals;
  }
  function scoreRound(r, pid) {
    const p = getPred(r, pid); const status = p.status || (r.calcolata ? 'mancato' : '');
    const base = { state: status || 'vuoto', total: 0, x12: 0, hits: 0, valid: 0, golden: false, exact: 0, exactHits: 0, sc: 0, scored: 0 };
    if (status === 'mancato') return { ...base, state: 'mancato', total: -50, x12: -50 };
    if (status !== 'consegnato') return base;
    const ms = r.matches || [];
    let hits = 0, valid = 0;
    ms.forEach((m, i) => { if (!validMatch(m)) return; valid++; if (p.x12[i] === outcome(m)) hits++; });
    const golden = valid === 10 && hits === 10; const x12 = golden ? 0 : X12[hits];
    let exSum = 0, exactHits = 0; const usedM = new Set(); const cl = p.consegnata ? clashes(r, pid) : { ex: {}, sc: {} };
    p.exact.forEach((e, k) => { const m = ms[e.m]; if (!m || !isNum(e.h) || !isNum(e.a) || cl.ex[k] || usedM.has(+e.m)) return; usedM.add(+e.m);
      if (!validMatch(m)) return; if (+e.h === +m.hg && +e.a === +m.ag) { exactHits++; exSum += exactBase(e.h, e.a); } });
    const exact = r1(exSum * MULT_EX[exactHits]);
    let scSum = 0, scored = 0, named = 0; const usedS = [];
    p.scorers.forEach((s, k) => { if (!s.name.trim() || cl.sc[k]) return; if (usedS.some(n => samePlayer(n, s.name))) return; usedS.push(s.name); named++;
      const g = findGoals(r, s.name); if (g > 0) { scored++; scSum += (ROLE[s.role] || 4) * Math.min(g, 3); } });
    const sc = r1(named === 3 && scored === 3 ? scSum * 2.5 : scSum);
    return { ...base, state: 'consegnato', total: r1(x12 + exact + sc), x12, hits, valid, golden, exact, exactHits, sc, scored };
  }
  /* classifica con le giornate confermate; except = numero di giornata da escludere (per la classifica "prima") */
  function standings(except) {
    const nums = Object.keys(D.rounds).map(Number).filter(n => n !== except && D.rounds[n].calcolata && pids.some(p => getPred(D.rounds[n], p).status)).sort((a, b) => a - b);
    const rows = pids.map(pid => ({ pid, tot: 0, rec: null, x12: 0, ex: 0 }));
    for (const n of nums) for (const row of rows) { const s = scoreRound(D.rounds[n], row.pid); row.tot = r1(row.tot + s.total); row.rec = row.rec === null ? s.total : Math.max(row.rec, s.total); row.x12 += s.x12; row.ex += s.exactHits; }
    for (const row of rows) row.tot = r1(row.tot + D.adj.filter(a => a.pid === row.pid).reduce((t, a) => t + (Number(a.pts) || 0), 0));
    const cmp = (a, b) => b.tot - a.tot || (b.rec ?? 0) - (a.rec ?? 0) || b.x12 - a.x12 || b.ex - a.ex;
    rows.sort(cmp); rows.forEach((r, i) => { r.rank = i > 0 && cmp(rows[i - 1], r) === 0 ? rows[i - 1].rank : i + 1; });
    return rows;
  }
  return { getPred, scoreRound, standings, name, memberOf, samePlayer, pidOf: u => Object.keys(cfg.members || {}).find(p => cfg.members[p] === u) || null };
}
