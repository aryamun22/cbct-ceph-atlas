/* Skull Surgery Sandbox - engine.js (MIT licence)
   Rigid-piece scene graph, landmark carriage, cephalometric metrics and the plan engine.
   The metric definitions and the plan steps are a line-by-line port of analysis-results/simulator/sim.py (v3):
   measure(), _decompensate(), _mx_pitch(), _first_contact(), incisor_clearance(), the mandible modes and the genioplasty.
   Frame: GL mm, x = patient left, y = up (FH normal), z = anterior, origin nasion. sim.py works in (ant, sup) = (z, y).
   "Clockwise" (CW, +) = patient facing right: chin down and back = rotation about +x by +angle. */
(function () {
  'use strict';
  const D = window.SANDBOX_DATA;
  const DEG = Math.PI / 180;
  const LM0 = D.landmarks;                 // home positions (GL)
  const MEMBER = D.membership;             // landmark -> piece id, or [maxilla_R, maxilla_L] (mean)
  const BILATERAL = {Po: ['PoR', 'PoL'], Or: ['OrR', 'OrL'], Co: ['CoR', 'CoL'], Ar: ['ArR', 'ArL'], Go: ['GoR', 'GoL'],
    J: ['JR', 'JL'], Ag: ['AgR', 'AgL'], Zy: ['ZyR', 'ZyL'], IOF: ['IOFR', 'IOFL'], Mal: ['MalR', 'MalL'], Rim: ['RimR', 'RimL'],
    UMol: ['UMolR', 'UMolL'], LMol: ['LMolR', 'LMolL'], UPm: ['UPmR', 'UPmL'], LPm: ['LPmR', 'LPmL']};
  const MXW0 = 59.0, MDW0 = 64.5;          // Penn basal widths at the first molars (given in sim.py)
  const TOOTH = {U1_crown_mm: 10.5, L1_crown_mm: 9.0, crest_below_CEJ_mm: 1.5, cres_fraction_of_root_from_crest: 0.40};
  const U1_LINGUAL_SURFACE_DEG = 20.0;
  // Wheeler crown heights (mm) used for every other tooth's centre of resistance (same rule as sim.py TOOTH)
  const CROWN = {1: [10.5, 9.0], 2: [9.0, 9.5], 3: [10.0, 11.0], 4: [8.5, 8.5], 5: [8.5, 8.0], 6: [7.5, 7.5], 7: [7.0, 7.0]};

  /* ------------------------------------------------------------------ node graph */
  const NODES = {};      // id -> {id, parent, kind, label, short, pivots:[{name, p}], fixed}
  const ORDER = [];      // parents before children
  function addNode(id, parent, kind, label, short, pivots, extra) {
    NODES[id] = Object.assign({id, parent, kind, label, short, pivots, children: []}, extra || {});
    if (parent) NODES[parent].children.push(id);
    ORDER.push(id);
  }
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const CO_MID = mid(LM0.CoR, LM0.CoL);
  const HINGE = {R: [0.6 * LM0.JR[0], D.planes.lefort_I.height_mm + 12, LM0.JR[2]],
                 L: [0.6 * LM0.JL[0], D.planes.lefort_I.height_mm + 12, LM0.JL[2]]};
  const UPPER_INC = ['tooth_11', 'tooth_21', 'tooth_12', 'tooth_22'];   // carried with the U1 decompensation (U1 landmarks on 11)
  const LOWER_INC = ['tooth_31', 'tooth_41', 'tooth_32', 'tooth_42'];   // carried with the L1 decompensation (L1 landmarks on 31)

  function toothPivots(meta) {
    const fdi = meta.fdi, q = Math.floor(fdi / 10), n = fdi % 10, upper = q <= 2;
    const tip = meta.tip, apex = meta.apex;
    const L = Math.hypot(apex[0] - tip[0], apex[1] - tip[1], apex[2] - tip[2]);
    const crest = CROWN[n][upper ? 0 : 1] + TOOTH.crest_below_CEJ_mm;
    const f = (crest + TOOTH.cres_fraction_of_root_from_crest * Math.max(L - crest, 0)) / L;
    const cres = [0, 1, 2].map(i => tip[i] + f * (apex[i] - tip[i]));
    return [{name: 'Centre of resistance (' + Math.round(f * 100) + ' % tip to apex)', p: cres},
            {name: 'Root apex', p: apex.slice()}, {name: (n <= 3 ? 'Incisal edge / cusp tip' : 'Cusp tip'), p: tip.slice()}];
  }

  function buildGraph(PIECES) {
    const P = id => PIECES[id];
    addNode('cranium', null, 'piece', 'Cranium (skull base, vault, zygomas, upper midface)', 'Cranium',
      [{name: 'Nasion (frame origin)', p: [0, 0, 0]}], {fixed: true});
    addNode('spine', null, 'piece', 'Cervical spine (C1 to C3)', 'Spine', [{name: 'Basion', p: P('spine').pivot}]);
    addNode('hyoid', null, 'piece', 'Hyoid bone', 'Hyoid', [{name: 'Centroid', p: P('hyoid').pivot}]);
    addNode('maxilla', null, 'group', 'Le Fort I segment (both maxilla halves + upper teeth)', 'Le Fort I segment',
      [{name: 'Upper incisor edge (U1tip)', p: LM0.U1tip}, {name: 'PNS', p: LM0.PNS}]);
    for (const s of ['R', 'L']) {
      addNode('maxilla_' + s, 'maxilla', 'piece', 'Maxilla, ' + (s === 'R' ? 'right' : 'left') + ' half', 'Maxilla ' + s,
        [{name: 'Upper incisor edge (U1tip)', p: LM0.U1tip}, {name: 'Expansion hinge (' + s + ')', p: HINGE[s]}]);
    }
    addNode('mandible', null, 'group', 'Whole mandible (rami + body + chin + lower teeth)', 'Whole mandible',
      [{name: 'Condylar hinge axis (CoR-CoL midpoint)', p: CO_MID}]);
    addNode('ramus_R', 'mandible', 'piece', 'Ramus, right (BSSO proximal segment)', 'Ramus R', [{name: 'Right condylion', p: LM0.CoR}]);
    addNode('ramus_L', 'mandible', 'piece', 'Ramus, left (BSSO proximal segment)', 'Ramus L', [{name: 'Left condylion', p: LM0.CoL}]);
    addNode('mandible_body', 'mandible', 'piece', 'Mandible body (BSSO distal segment, carries the lower teeth)', 'Mandible body',
      [{name: 'Condylar hinge axis (CoR-CoL midpoint)', p: CO_MID}, {name: 'Lower incisor edge (L1tip)', p: LM0.L1tip}]);
    addNode('chin', 'mandible_body', 'piece', 'Chin (genioplasty segment)', 'Chin', [{name: 'Centre of the osteotomy surface', p: P('chin').pivot}]);
    const teeth = Object.keys(PIECES).filter(k => k.startsWith('tooth_')).sort((a, b) => {
      const fa = PIECES[a].fdi, fb = PIECES[b].fdi, qa = Math.floor(fa / 10), qb = Math.floor(fb / 10);
      const oa = [1, 0, 2, 3][qa - 1] * 10 + (qa === 1 || qa === 4 ? 10 - fa % 10 : fa % 10);
      const ob = [1, 0, 2, 3][qb - 1] * 10 + (qb === 1 || qb === 4 ? 10 - fb % 10 : fb % 10);
      return oa - ob;
    });
    const NAMES = {1: 'central incisor', 2: 'lateral incisor', 3: 'canine', 4: 'first premolar', 5: 'second premolar', 6: 'first molar', 7: 'second molar'};
    for (const t of teeth) {
      const m = PIECES[t], q = Math.floor(m.fdi / 10);
      const parent = q === 1 ? 'maxilla_R' : q === 2 ? 'maxilla_L' : 'mandible_body';
      addNode(t, parent, 'tooth', 'Tooth ' + m.fdi + ' (' + (q <= 2 ? 'upper ' : 'lower ') + (q === 1 || q === 4 ? 'right ' : 'left ') + NAMES[m.fdi % 10] + ')',
        'Tooth ' + m.fdi, toothPivots(m), {fdi: m.fdi, arch: q <= 2 ? 'upper' : 'lower'});
    }
    return teeth;
  }

  /* ------------------------------------------------------------------ pose = {id: THREE.Matrix4 (local, relative to the home position)} */
  function newPose() { const p = {}; for (const id of ORDER) p[id] = new THREE.Matrix4(); return p; }
  function clonePose(P) { const q = {}; for (const id of ORDER) q[id] = P[id].clone(); return q; }
  function worlds(P) {
    const W = {};
    for (const id of ORDER) { const n = NODES[id]; W[id] = n.parent ? W[n.parent].clone().multiply(P[id]) : P[id].clone(); }
    return W;
  }
  function worldOf(P, id) {
    const chain = []; for (let n = id; n; n = NODES[n].parent) chain.unshift(n);
    const m = new THREE.Matrix4(); for (const n of chain) m.multiply(P[n]); return m;
  }
  /* apply a WORLD-space rigid transform T to node id (and so to its descendants) */
  function applyWorld(P, id, T) {
    const n = NODES[id];
    if (!n.parent) { P[id].premultiply(T); return; }
    const PW = worldOf(P, n.parent), PWi = PW.clone().invert();
    P[id].premultiply(PW).premultiply(T).premultiply(PWi);
  }
  const _v = new THREE.Vector3();
  function lmWorld(P, name, W) {
    const mem = MEMBER[name]; const h = LM0[name];
    if (Array.isArray(mem)) {
      const a = _v.set(h[0], h[1], h[2]).applyMatrix4(W ? W[mem[0]] : worldOf(P, mem[0])).toArray();
      const b = _v.set(h[0], h[1], h[2]).applyMatrix4(W ? W[mem[1]] : worldOf(P, mem[1])).toArray();
      return mid(a, b);
    }
    return _v.set(h[0], h[1], h[2]).applyMatrix4(W ? W[mem] : worldOf(P, mem)).toArray();
  }

  /* ------------------------------------------------------------------ landmark state used by the metrics and the plan engine */
  class State {
    constructor(P) { this.P = P || newPose(); this.cache = null; this.W = null; this.mxwExtra = 0; }
    copy() { const s = new State(clonePose(this.P)); s.mxwExtra = this.mxwExtra; return s; }
    touch() { this.cache = null; this.W = null; }
    p3(k) {
      if (!this.cache) { this.cache = {}; this.W = worlds(this.P); }
      if (this.cache[k]) return this.cache[k];
      let v;
      if (k in LM0) v = lmWorld(this.P, k, this.W);
      else { const [a, b] = BILATERAL[k]; v = mid(this.p3(a), this.p3(b)); }
      this.cache[k] = v; return v;
    }
    p2(k) { const v = this.p3(k); return [v[2], v[1]]; }      // (ant, sup)
    // rigid 2-D ops in the sagittal plane, applied to nodes
    rot(ids, c, deg) { const T = rotCWMatrix(c, deg); for (const id of ids) applyWorld(this.P, id, T); this.touch(); }
    trans(ids, d) { const T = new THREE.Matrix4().makeTranslation(0, d[1], d[0]); for (const id of ids) applyWorld(this.P, id, T); this.touch(); }
  }
  function rotCWMatrix(c, deg) {    // rotation about the lateral axis through (ant, sup) = c, + = clockwise
    return new THREE.Matrix4().makeTranslation(0, c[1], c[0])
      .multiply(new THREE.Matrix4().makeRotationX(deg * DEG))
      .multiply(new THREE.Matrix4().makeTranslation(0, -c[1], -c[0]));
  }

  /* 2-D helpers (sim.py) */
  const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]], add2 = (a, b) => [a[0] + b[0], a[1] + b[1]];
  const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1], nrm2 = a => Math.hypot(a[0], a[1]);
  const mul2 = (a, s) => [a[0] * s, a[1] * s];
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const ANT = [1, 0], POST = [-1, 0];
  function vang(u, v) { return Math.acos(clamp(dot2(u, v) / nrm2(u) / nrm2(v), -1, 1)) / DEG; }
  function incl(u) { return Math.atan2(u[1], u[0]) / DEG; }
  function rotCW(p, c, deg) {
    const t = deg * DEG, d = sub2(p, c);
    return [c[0] + d[0] * Math.cos(t) + d[1] * Math.sin(t), c[1] - d[0] * Math.sin(t) + d[1] * Math.cos(t)];
  }
  function bisect(f, lo, hi, n) {
    n = n || 80; let flo = f(lo); const fhi = f(hi);
    if (flo * fhi > 0) throw new Error('no sign change');
    for (let i = 0; i < n; i++) { const m = 0.5 * (lo + hi), fm = f(m); if (flo * fm <= 0) hi = m; else { lo = m; flo = fm; } }
    return 0.5 * (lo + hi);
  }
  const pymod = (a, b) => ((a % b) + b) % b;

  /* ------------------------------------------------------------------ measurements (sim.py measure(), hard tissue) */
  function upperLine(S) {
    const a = S.p2('UMol'); let d = sub2(S.p2('UPm'), a); d = mul2(d, 1 / nrm2(d));
    if (d[0] < 0) d = mul2(d, -1);
    return [a, d, [-d[1], d[0]]];
  }
  function occlGap(S, k, pt) { const [a, , n] = upperLine(S); const q = pt || S.p2(k); return -dot2(sub2(q, a), n); }
  function molarApOffset(S) { const [, d] = upperLine(S); return dot2(sub2(S.p2('UMol'), S.p2('LMol')), d); }

  function measure(S) {
    const p2 = k => S.p2(k), M = {};
    const ang = (a, b, c) => vang(sub2(p2(a), p2(b)), sub2(p2(c), p2(b)));
    const dist2 = (a, b) => nrm2(sub2(p2(a), p2(b)));
    const dToLine = (pt, a, b) => {
      const p = p2(pt), A = p2(a), B = p2(b); const d = mul2(sub2(B, A), 1 / nrm2(sub2(B, A))); let n = [d[1], -d[0]];
      if (n[0] < 0) n = mul2(n, -1); return dot2(sub2(p, A), n);
    };
    const SN = sub2(p2('N'), p2('S')), MP_GoGn = sub2(p2('GnT'), p2('Go')), MP_GoMe = sub2(p2('MeT'), p2('Go'));
    const MPc_GoGn = sub2(p2('Gn'), p2('Go')), MPc_GoMe = sub2(p2('Me'), p2('Go'));
    const U1up = sub2(p2('U1apex'), p2('U1tip')), L1up = sub2(p2('L1tip'), p2('L1apex')), PP = sub2(p2('ANS'), p2('PNS'));
    const mol = mul2(add2(p2('UMol'), p2('LMol')), 0.5), pm = mul2(add2(p2('UPm'), p2('LPm')), 0.5), inc = mul2(add2(p2('U1tip'), p2('L1tip')), 0.5);
    const opDir = (a, b) => { const d = sub2(a, b); return mul2(d, 1 / nrm2(d)); };
    const wits = (a, b) => { const d = opDir(a, b); return dot2(sub2(p2('A'), b), d) - dot2(sub2(p2('B'), b), d); };
    M.SNA = ang('S', 'N', 'A'); M.SNB = ang('S', 'N', 'B'); M.ANB = M.SNA - M.SNB;
    M.Wits_incisor_molar_OP = wits(inc, mol); M.Wits_functional_OP = wits(pm, mol);
    M.A_to_Nperp = p2('A')[0]; M.Pog_to_Nperp = p2('Pog')[0]; M.B_to_Nperp = p2('B')[0];
    M.facial_depth = vang(sub2(p2('Pog'), p2('N')), POST);
    M.convexity_A_to_NPog = dToLine('A', 'N', 'Pog');
    M.FMA = -incl(MP_GoMe); M.SN_GoGn = incl(SN) - incl(MP_GoGn);
    M.FMA_contour = -incl(MPc_GoMe); M.SN_GoGn_contour = incl(SN) - incl(MPc_GoGn);
    M.N_Me = dist2('N', 'Me'); M.ANS_Me = dist2('ANS', 'Me'); M.N_ANS = dist2('N', 'ANS');
    M.LAFH_pct_of_TAFH = 100 * M.ANS_Me / M.N_Me;
    M.S_Go = dist2('S', 'Go'); M.S_Go_over_N_Me_pct = 100 * M.S_Go / M.N_Me;
    M.Ar_Go = dist2('Ar', 'Go'); M.Co_Go = dist2('Co', 'Go'); M.Co_Gn = dist2('Co', 'GnT'); M.Co_Gn_contour = dist2('Co', 'Gn');
    M.Co_A = dist2('Co', 'A'); M.Go_Me = dist2('Go', 'Me');
    M.gonial_angle_Ar_Go_Me = ang('Ar', 'Go', 'MeT'); M.gonial_angle_contour = ang('Ar', 'Go', 'Me');
    M.Bjork_sum = ang('N', 'S', 'Ar') + ang('S', 'Ar', 'Go') + M.gonial_angle_Ar_Go_Me;
    M.U1_FH = vang(ANT, U1up); M.U1_SN = vang(SN, U1up); M.U1_PP = vang(PP, U1up);
    M.IMPA = vang(sub2(p2('Go'), p2('MeT')), L1up); M.FMIA = 180 - M.FMA - M.IMPA;
    M.IMPA_contour = vang(sub2(p2('Go'), p2('Me')), L1up);
    M.interincisal = vang(U1up, mul2(L1up, -1));
    M.overjet = p2('U1tip')[0] - p2('L1tip')[0]; M.overbite = p2('L1tip')[1] - p2('U1tip')[1];
    M.occlusal_plane_to_FH = -incl(opDir(inc, mol)); M.functional_OP_to_FH = -incl(opDir(pm, mol));
    M.palatal_plane_to_FH = incl(PP);
    M.posterior_occlusal_gap = occlGap(S, 'LMol'); M.premolar_occlusal_gap = occlGap(S, 'LPm');
    M.molar_AP_offset_UMol_minus_LMol = molarApOffset(S);
    M.upper_posterior_occlusal_line_to_FH = -incl(upperLine(S)[1]);
    // transverse (3-D, from the carried landmarks): the simulator adds skeletal_mm to 59.0; here the J-J change is used
    const J = S.p3('JL')[0] - S.p3('JR')[0], J0 = LM0.JL[0] - LM0.JR[0];
    const UM = S.p3('UMolL')[0] - S.p3('UMolR')[0], UM0 = LM0.UMolL[0] - LM0.UMolR[0];
    M.basal_width_change_JJ = J - J0; M.intermolar_width_change = UM - UM0;
    M.maxillary_basal_width = MXW0 + M.basal_width_change_JJ; M.Penn_differential_Mx_minus_Md = M.maxillary_basal_width - MDW0;
    // AP change of B and Pog from the start, and bony Pog before any genioplasty (Pog carried by the body only)
    M.B_AP_change = p2('B')[0] - LM0.B[2];
    M.Pog_AP_change = p2('Pog')[0] - LM0.Pog[2];
    const pogT = new THREE.Vector3(...LM0.Pog).applyMatrix4(S.W.mandible_body);
    M.PogT_AP_change = pogT.z - LM0.Pog[2];
    M.PNS_vertical_change = p2('PNS')[1] - LM0.PNS[1];
    return M;
  }

  /* ------------------------------------------------------------------ plan engine (sim.py simulate(), hard tissue only) */
  const DEFAULT_PLAN = {
    expansion: {skeletal_mm: 0, drop_mm: 0, forward_mm: 0},
    decompensation: {u1_fh_target_deg: null, u1_centre: 'cres', u1_edge_vertical: null, u1_fh_target_is: 'final', u1_extrusion_mm: 0,
      l1_impa_target_deg: null, l1_centre: 'cres', l1_edge_vertical: null, l1_extrusion_mm: 0},
    maxilla: {level: 'standard', adv_mm: 0, ant_vertical_mm: 0, post_vertical_mm: 0, nasion_adv_mm: null},
    mandible: {mode: 'none', distal_ap_mm: null, distal_pitch_deg: 0, ramus_lengthening_mm: 0},
    targets: {overjet_mm: 2.5, overbite_mm: 2.0},
    genioplasty: {ap_mm: 0, vertical_mm: 0},
    adjuncts: {angle_implant_lateral_mm_per_side: 0, angle_implant_vertical_mm: 0, malar_implant_mm: 0, infraorbital_implant_mm: 0,
      rhinoplasty_tip_mm: 0, radix_mm: 0},
  };
  // app-only extensions (not part of the sim.py schema; exported separately)
  const DEFAULT_EXTRAS = {expansion_pattern: 'parallel', hinge_deg: 0};

  function normalisePlan(plan) {
    const P = JSON.parse(JSON.stringify(DEFAULT_PLAN)); const notes = [];
    for (const [k, v] of Object.entries(plan || {})) {
      if (k in P && v && typeof v === 'object') {
        for (const [kk, vv] of Object.entries(v)) { if (kk in P[k]) P[k][kk] = vv; else notes.push('ignored unknown field ' + k + '.' + kk); }
      } else if (['ratios', 'name', 'notes', 'label'].includes(k)) P[k] = v;
      else notes.push('ignored unknown section "' + k + '"');
    }
    if (P.maxilla.level !== 'standard') { notes.push('maxilla.level "' + P.maxilla.level + '" moves cranial landmarks; the sandbox models the standard Le Fort I only (applied as standard)'); P.maxilla.level = 'standard'; }
    if (P.mandible.mode === 'inverted_l') { notes.push('inverted_l is applied as a BSSO (ramus lengthening is not shown on the pieces)'); P.mandible.mode = 'bsso'; }
    for (const k of ['skeletal_mm', 'drop_mm', 'forward_mm']) P.expansion[k] = +P.expansion[k] || 0;
    for (const k of ['adv_mm', 'ant_vertical_mm', 'post_vertical_mm']) P.maxilla[k] = +P.maxilla[k] || 0;
    for (const k of ['ap_mm', 'vertical_mm']) P.genioplasty[k] = +P.genioplasty[k] || 0;
    P.mandible.distal_pitch_deg = +P.mandible.distal_pitch_deg || 0;
    if (P.mandible.distal_ap_mm !== null && P.mandible.distal_ap_mm !== '' && P.mandible.distal_ap_mm !== undefined) P.mandible.distal_ap_mm = +P.mandible.distal_ap_mm; else P.mandible.distal_ap_mm = null;
    return {P, notes};
  }

  function cresPoint(S, tooth) {
    const tip = S.p2(tooth + 'tip'), apex = S.p2(tooth + 'apex'), L = nrm2(sub2(apex, tip));
    const crest = TOOTH[tooth + '_crown_mm'] + TOOTH.crest_below_CEJ_mm;
    const f = (crest + TOOTH.cres_fraction_of_root_from_crest * Math.max(L - crest, 0)) / L;
    return [add2(tip, mul2(sub2(apex, tip), f)), f];
  }
  function solveRotHeight(p, c, yTarget) {
    const d = sub2(p, c), Rr = Math.hypot(d[0], d[1]), h = yTarget - c[1];
    const beta = Math.atan2(d[0], d[1]); const q = Rr > 0 ? h / Rr : 2.0; const ok = Math.abs(q) <= 1;
    const a = Math.acos(clamp(q, -1, 1)); const cands = [];
    for (const s of [a, -a]) { let t = s - beta; t = pymod(t + Math.PI, 2 * Math.PI) - Math.PI; cands.push(t); }
    const t = Math.abs(cands[1]) < Math.abs(cands[0]) ? cands[1] : cands[0];
    return [t / DEG, ok];
  }
  function solveRotLine(p, c, a, d, n) {
    const P = [dot2(sub2(p, a), d), dot2(sub2(p, a), n)], C = [dot2(sub2(c, a), d), dot2(sub2(c, a), n)];
    return solveRotHeight(P, C, 0.0);
  }
  function incisorClearance(S, l1) {
    const u = S.p2('U1tip'); l1 = l1 || S.p2('L1tip');
    let ax = sub2(S.p2('U1apex'), u); ax = mul2(ax, 1 / nrm2(ax));
    const lg = rotCW(ax, [0, 0], -U1_LINGUAL_SURFACE_DEG); let nf = [lg[1], -lg[0]];
    if (nf[1] > 0) nf = mul2(nf, -1);
    return Math.max(dot2(sub2(l1, u), nf), u[1] - l1[1], (l1[0] - u[0]) - 1.0);
  }
  function gapsAfter(S, c, a, obTarget, incisor) {
    if (incisor === undefined) incisor = true;
    const [p0, , n] = upperLine(S); const g = {};
    for (const k of ['LMol', 'LPm']) g[k] = -dot2(sub2(rotCW(S.p2(k), c, a), p0), n);
    if (incisor) {
      const l1 = rotCW(S.p2('L1tip'), c, a);
      g.incisors = obTarget == null ? incisorClearance(S, l1) : S.p2('U1tip')[1] + obTarget - l1[1];
    }
    return g;
  }
  const minv = o => Math.min(...Object.values(o));
  function firstContact(S, c, obTarget, incisor) {
    if (incisor === undefined) incisor = true;
    const [p0, d, n] = upperLine(S); const cands = {};
    for (const k of ['LMol', 'LPm']) cands[k] = solveRotLine(S.p2(k), c, p0, d, n)[0];
    if (incisor) {
      if (obTarget != null) cands.incisors = solveRotHeight(S.p2('L1tip'), c, S.p2('U1tip')[1] + obTarget)[0];
      else if (incisorClearance(S) < 0) {
        const f = a => incisorClearance(S, rotCW(S.p2('L1tip'), c, a));
        try { cands.incisors = bisect(f, 0.0, 25.0); } catch (e) { /* no sign change: leave it out, as sim.py */ }
      }
    }
    let best = null, bestv = -Infinity;
    for (const k of Object.keys(cands)) { const v = minv(gapsAfter(S, c, cands[k], obTarget, incisor)); if (v > bestv) { bestv = v; best = k; } }
    return [best, cands[best], gapsAfter(S, c, cands[best], obTarget, incisor), cands];
  }
  function mxPitch(S, mx) {
    const tip = S.p2('U1tip'), r = sub2(S.p2('PNS'), tip);
    const dvert = mx.ant_vertical_mm - mx.post_vertical_mm;
    const a = -r[0], b = r[1], q = (dvert + r[1]) / Math.hypot(a, b);
    if (Math.abs(q) > 1) throw new Error('maxilla prescription unreachable: ant - post vertical = ' + dvert.toFixed(1) + ' mm is more than a rigid pitch can give');
    return (Math.asin(q) - Math.atan2(b, a)) / DEG;
  }
  function decompensate(S, dc, u1Target, rep) {
    if (u1Target != null) {
      const cur = vang(ANT, sub2(S.p2('U1apex'), S.p2('U1tip'))); const delta = u1Target - cur;
      const c = dc.u1_centre === 'apex' ? S.p2('U1apex') : cresPoint(S, 'U1')[0];
      const tip0 = S.p2('U1tip');
      S.rot(UPPER_INC, c, -delta);
      const free = sub2(S.p2('U1tip'), tip0);
      if (dc.u1_edge_vertical === 'hold') S.trans(UPPER_INC, [0, -free[1]]);
      const ext = +dc.u1_extrusion_mm || 0; if (ext) S.trans(UPPER_INC, [0, -ext]);
      if (rep) rep.u1_rot = delta;
    } else if (+dc.u1_extrusion_mm) S.trans(UPPER_INC, [0, -(+dc.u1_extrusion_mm)]);
    if (dc.l1_impa_target_deg != null) {
      const c = dc.l1_centre === 'apex' ? S.p2('L1apex') : cresPoint(S, 'L1')[0];
      const impaAfter = deg => vang(sub2(S.p2('Go'), S.p2('MeT')), sub2(rotCW(S.p2('L1tip'), c, deg), rotCW(S.p2('L1apex'), c, deg)));
      const cur = impaAfter(0), delta = dc.l1_impa_target_deg - cur, sgn = impaAfter(1.0) > cur ? 1 : -1;
      const tip0 = S.p2('L1tip');
      S.rot(LOWER_INC, c, sgn * delta);
      const free = sub2(S.p2('L1tip'), tip0);
      if (dc.l1_edge_vertical === 'hold') S.trans(LOWER_INC, [0, -free[1]]);
      const ext = +dc.l1_extrusion_mm || 0; if (ext) S.trans(LOWER_INC, [0, ext]);
      if (rep) rep.l1_rot = delta;
    } else if (+dc.l1_extrusion_mm) S.trans(LOWER_INC, [0, +dc.l1_extrusion_mm]);
  }
  /* V-pattern expansion: each half rotates about an antero-posterior axis through its hinge (high on that side) */
  function hingeMatrix(side, psi) {
    const h = HINGE[side], th = side === 'R' ? -psi : psi;
    return new THREE.Matrix4().makeTranslation(h[0], h[1], h[2]).multiply(new THREE.Matrix4().makeRotationZ(th))
      .multiply(new THREE.Matrix4().makeTranslation(-h[0], -h[1], -h[2]));
  }
  /* each side gets its own roll so that its first molar moves out exactly mm/2 (the hinges sit at different
     distances from the midline because the skull is asymmetric; one shared angle widened the sides unevenly) */
  function expandV(S, mm) {
    const out = {};
    for (const side of ['R', 'L']) {
      const id = 'maxilla_' + side, lm = 'UMol' + side, sg = side === 'R' ? -1 : 1;
      const x0 = S.p3(lm)[0];
      const lateral = psi => { const s = S.copy(); s.P[id].premultiply(hingeMatrix(side, psi)); s.touch(); return sg * (s.p3(lm)[0] - x0); };
      let psi = 0;
      try { psi = bisect(p => lateral(p) - mm / 2, 0, 0.6, 50); } catch (e) { psi = 0.6; }
      out[side] = psi / DEG;
      S.P[id].premultiply(hingeMatrix(side, psi)); S.touch();
    }
    return out;   // degrees of roll, each side
  }

  function simulate(plan, extras) {
    const {P, notes} = normalisePlan(plan); const X = Object.assign({}, DEFAULT_EXTRAS, extras || {});
    const S = new State(); const rep = {notes, flags: []};
    // 1. expansion
    const ex = P.expansion;
    if (ex.skeletal_mm) {
      if (X.expansion_pattern === 'V') rep.hinge_roll_deg = expandV(S, ex.skeletal_mm);
      else { S.P.maxilla_R.premultiply(new THREE.Matrix4().makeTranslation(-ex.skeletal_mm / 2, 0, 0));
             S.P.maxilla_L.premultiply(new THREE.Matrix4().makeTranslation(ex.skeletal_mm / 2, 0, 0)); S.touch(); }
    }
    if (ex.drop_mm || ex.forward_mm) S.trans(['maxilla'], [ex.forward_mm, -ex.drop_mm]);
    // 2. decompensation (u1 target "final": pre-surgical target = final + planned maxillary pitch)
    const dc = P.decompensation, mx = P.maxilla;
    for (const t of ['u1', 'l1']) if (dc[t + '_edge_vertical'] == null) dc[t + '_edge_vertical'] = 'hold';
    const mxMoves = !!(mx.adv_mm || mx.ant_vertical_mm || mx.post_vertical_mm);
    const u1t = dc.u1_fh_target_deg == null || dc.u1_fh_target_deg === '' ? null : +dc.u1_fh_target_deg;
    if (dc.l1_impa_target_deg === '') dc.l1_impa_target_deg = null;
    if (dc.l1_impa_target_deg != null) dc.l1_impa_target_deg = +dc.l1_impa_target_deg;
    let pitchGuess = 0;
    if (u1t != null && dc.u1_fh_target_is === 'final' && mxMoves) {
      for (let i = 0; i < 6; i++) { const St = S.copy(); decompensate(St, dc, u1t + pitchGuess); pitchGuess = mxPitch(St, mx); }
    }
    decompensate(S, dc, u1t == null ? null : u1t + pitchGuess, rep);
    // 3. maxilla (standard Le Fort I): pitch about the U1 edge, then translate the edge by (adv, -ant_vertical)
    rep.pitch_mx = 0;
    if (mxMoves) {
      const tip = S.p2('U1tip'); const pitch = mxPitch(S, mx); rep.pitch_mx = pitch;
      S.rot(['maxilla'], tip, pitch); S.trans(['maxilla'], [mx.adv_mm, -mx.ant_vertical_mm]);
    }
    // 4. mandible
    const md = P.mandible, tg = P.targets, mode = md.mode;
    const u1 = S.p2('U1tip'), l1 = S.p2('L1tip'); const need0 = (u1[0] - tg.overjet_mm) - l1[0];
    rep.mode = mode; rep.mand_rot = 0; rep.limiting = null;
    const CN = {LMol: 'molars', LPm: 'premolars', incisors: 'incisors'};
    if (mode === 'none') {
      const co = S.p2('Co'); const g0 = gapsAfter(S, co, 0.0);
      if (minv(g0) < -0.02) {
        const [lim, hinge] = firstContact(S, co);
        S.rot(['mandible'], co, hinge); rep.mand_rot = hinge; rep.limiting = 'propped open on the ' + CN[lim];
        rep.flags.push('The moved upper teeth would overlap the lower teeth, so the mandible is propped open ' + hinge.toFixed(1) + '° about the condyles (first contact: ' + CN[lim] + ').');
      }
    } else if (mode === 'autorotate') {
      const co = S.p2('Co'); const [lim, hinge] = firstContact(S, co, +tg.overbite_mm);
      S.rot(['mandible'], co, hinge); rep.mand_rot = hinge;
      rep.limiting = lim === 'incisors' ? 'incisors (overbite target reached)' : CN[lim] + ' (first contact; overbite target not reached)';
    } else if (mode === 'bsso') {
      const solved = md.distal_ap_mm == null; const ap = solved ? need0 : md.distal_ap_mm; rep.distal_ap = ap; rep.distal_ap_solved = solved;
      const t = [l1[0] + ap, u1[1] + (+tg.overbite_mm)];
      S.trans(['mandible_body'], sub2(t, l1));
      const [lim, th, g1] = firstContact(S, t, null, false);
      S.rot(['mandible_body'], t, th);
      const extra = md.distal_pitch_deg; if (extra) S.rot(['mandible_body'], t, extra);
      rep.mand_rot = th + extra; rep.limiting = 'seated: incisors at the target overjet/overbite, ' + CN[lim] + ' on the upper occlusal line';
      if (Math.max(...Object.values(g1)) > 0.5) rep.flags.push('The lower ' + (lim === 'LPm' ? 'molars' : 'premolars') + ' stay ' + Math.max(...Object.values(g1)).toFixed(1) + ' mm open after seating.');
    }
    // 5. genioplasty
    const ge = P.genioplasty;
    if (ge.ap_mm || ge.vertical_mm) S.trans(['chin'], [ge.ap_mm, -ge.vertical_mm]);
    // app extension: free hinge rotation of the whole mandible about the condylar axis (+ = clockwise / opening)
    if (+X.hinge_deg) S.rot(['mandible'], S.p2('Co'), +X.hinge_deg);
    rep.sim_plan = P;
    return {pose: S.P, report: rep, state: S};
  }

  /* ------------------------------------------------------------------ pivot-relative parameters for the inspector and for tweening */
  // local = T(p + t) * R * T(-p);  R = Ry(yaw) * Rz(roll) * Rx(pitch)  (three.js Euler order 'YZX')
  function decompose(M, p) {
    const pv = new THREE.Vector3(...p); const t = pv.clone().applyMatrix4(M).sub(pv);
    const e = new THREE.Euler().setFromRotationMatrix(M, 'YZX');
    return {t: [t.x, t.y, t.z], r: [e.x / DEG, e.z / DEG, e.y / DEG]};   // r = [pitch, roll, yaw]
  }
  function compose(params, p) {
    const R = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(params.r[0] * DEG, params.r[2] * DEG, params.r[1] * DEG, 'YZX'));
    return new THREE.Matrix4().makeTranslation(p[0] + params.t[0], p[1] + params.t[1], p[2] + params.t[2])
      .multiply(R).multiply(new THREE.Matrix4().makeTranslation(-p[0], -p[1], -p[2]));
  }
  const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
  function lerpPose(A, B, s, out) {
    out = out || {};
    for (const id of ORDER) {
      const p = NODES[id].pivots[0].p, pv = new THREE.Vector3(...p);
      const ta = pv.clone().applyMatrix4(A[id]).sub(pv), tb = pv.clone().applyMatrix4(B[id]).sub(pv);
      _q1.setFromRotationMatrix(A[id]); _q2.setFromRotationMatrix(B[id]); _q1.slerp(_q2, s);
      const t = ta.lerp(tb, s);
      const m = out[id] || new THREE.Matrix4();
      m.makeRotationFromQuaternion(_q1);
      const rp = pv.clone().applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(_q1));
      m.setPosition(p[0] + t.x - rp.x, p[1] + t.y - rp.y, p[2] + t.z - rp.z);
      out[id] = m;
    }
    return out;
  }
  function poseIsHome(P, id) { return P[id].equals(new THREE.Matrix4()); }

  /* ------------------------------------------------------------------ simulator agreement test */
  function selftest() {
    const keys = D.hard_keys.filter(k => k !== 'maxillary_basal_width' && k !== 'Penn_differential_Mx_minus_Md');
    const rows = []; let worst = 0, worstAt = '';
    for (const [name, c] of Object.entries(D.sim_cases)) {
      const r = simulate(c.plan, {expansion_pattern: 'parallel'}); const m = measure(r.state); let mx = 0, at = '';
      for (const k of keys) { const d = Math.abs(m[k] - c.metrics[k]); if (d > mx) { mx = d; at = k; } }
      // the simulator adds skeletal_mm to the basal width; the sandbox measures the J-J change of the carried pieces
      const w = Math.abs(m.maxillary_basal_width - c.metrics.maxillary_basal_width); if (w > mx) { mx = w; at = 'maxillary_basal_width'; }
      rows.push({name, max_abs_diff: +mx.toFixed(3), at}); if (mx > worst) { worst = mx; worstAt = name + ' / ' + at; }
    }
    return {cases: rows.length, metrics: keys.length + 1, worst: +worst.toFixed(3), worstAt, rows};
  }

  window.Engine = {NODES, ORDER, LM0, MEMBER, HINGE, CO_MID, UPPER_INC, LOWER_INC, DEFAULT_PLAN, DEFAULT_EXTRAS, BILATERAL,
    buildGraph, newPose, clonePose, worlds, worldOf, applyWorld, State, measure, simulate, normalisePlan, decompose, compose,
    lerpPose, poseIsHome, rotCWMatrix, selftest, DEG};
})();
