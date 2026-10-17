/* Skull Surgery Sandbox - app.js (MIT licence)
   Rendering (three.js r128 core only), own orbit control and gizmo-free drag, GPU picking, piece list, inspector,
   presets / plan builder, live readout, occlusion and airway checks, missions, undo/redo, export/import. */
(function () {
  'use strict';
  const D = window.SANDBOX_DATA, E = window.Engine, DEG = Math.PI / 180;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const fmt = (x, d) => { d = d == null ? 1 : d; if (x == null || !isFinite(x)) return '–'; const v = +(+x).toFixed(d); return (Object.is(v, -0) ? 0 : v).toFixed(d).replace('-', '−'); };
  const sgn = (x, d) => { d = d == null ? 1 : d; if (x == null || !isFinite(x)) return '–'; const v = +(+x).toFixed(d); return (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d); };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('sss.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('sss.' + k, JSON.stringify(v)); } catch (e) { /* storage blocked: fine */ } },
  };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const deep = o => JSON.parse(JSON.stringify(o));

  /* ================================================================== theme */
  let theme = store.get('theme', 'auto');
  function applyTheme() {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', theme);
    const b = $('#btnTheme'); b.textContent = 'Theme: ' + theme; b.setAttribute('aria-label', 'Colour theme: ' + theme + ' (click to change)');
    if (renderer) renderer.setClearColor(new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim() || '#0b1014'), 1);
  }
  $('#btnTheme').addEventListener('click', () => { theme = {auto: 'light', light: 'dark', dark: 'auto'}[theme]; store.set('theme', theme); applyTheme(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());

  /* ================================================================== toast */
  let toastT = 0;
  function toast(msg, ms) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms || 3200); }

  /* ================================================================== tabs */
  function initTabs(list) {
    const tabs = $$('[role=tab]', list);
    const show = (t, focus) => { for (const x of tabs) { const on = x === t; x.setAttribute('aria-selected', on); x.tabIndex = on ? 0 : -1; $('#' + x.getAttribute('aria-controls')).hidden = !on; } if (focus) t.focus(); };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => show(t));
      t.addEventListener('keydown', e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const j = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length; show(tabs[j], true); e.preventDefault(); } });
    });
    show(tabs.find(t => t.getAttribute('aria-selected') === 'true') || tabs[0]);
    return id => show($('#' + id));
  }
  const showLeft = initTabs($('#left .tabs')), showRight = initTabs($('#right .tabs'));

  /* ================================================================== loading */
  const FILES = [{f: 'pieces_cranium.js', label: 'skull base, spine and hyoid', mb: 2.87}, {f: 'pieces_jaws.js', label: 'maxilla, mandible and chin', mb: 1.37},
    {f: 'pieces_teeth_upper.js', label: '14 upper teeth', mb: 2.63}, {f: 'pieces_teeth_lower.js', label: '14 lower teeth', mb: 2.54}];
  function setProgress(f, text) {
    $('#lfill').style.width = Math.round(f * 100) + '%'; $('#ltext').textContent = text;
    $('#loader').setAttribute('aria-valuenow', Math.round(f * 100));
  }
  const nextFrame = () => new Promise(r => setTimeout(r, 0));   // yield so the progress bar paints (rAF stalls in background tabs)
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('could not load ' + src)); document.head.appendChild(s); });
  }
  function b64(s) { const b = atob(s), n = b.length, u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = b.charCodeAt(i); return u.buffer; }
  function geomOf(P) {
    const p16 = new Int16Array(b64(P.pos)), pos = new Float32Array(p16.length);
    for (let i = 0; i < p16.length; i++) pos[i] = p16[i] * P.scale;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(b64(P.idx)), 1));
    g.computeVertexNormals(); g.computeBoundingSphere();
    delete P.pos; delete P.idx;
    return g;
  }

  /* ================================================================== three.js setup */
  let renderer = null;
  const canvas = $('#c'), stage = $('#stage');
  try {
    renderer = new THREE.WebGLRenderer({canvas, antialias: true});
  } catch (e) {
    setProgress(0, 'WebGL is not available in this browser, so the 3-D view cannot start.'); return;
  }
  const coarse = matchMedia('(pointer: coarse)').matches;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2));   // phones: fewer pixels, steadier frame rate
  renderer.outputEncoding = THREE.sRGBEncoding;
  applyTheme();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 2, 4000);
  scene.add(camera);
  scene.add(new THREE.HemisphereLight(0xc9d8ec, 0x2a2118, 0.55));
  const key = new THREE.DirectionalLight(0xfff1dc, 0.75); key.position.set(60, 80, 140); scene.add(key);
  const fill = new THREE.DirectionalLight(0x9fc0ff, 0.3); fill.position.set(-120, 20, -60); scene.add(fill);
  const head = new THREE.DirectionalLight(0xffffff, 0.45); head.position.set(0, 0, 1); camera.add(head);

  /* ---------- orbit camera (own control) ---------- */
  const orbit = {
    target: new THREE.Vector3(0, -45, -35), theta: 0.62, phi: 1.36, radius: 560,
    update() {
      const r = this.radius, s = Math.sin(this.phi);
      camera.position.set(this.target.x + r * s * Math.sin(this.theta), this.target.y + r * Math.cos(this.phi), this.target.z + r * s * Math.cos(this.theta));
      camera.lookAt(this.target);
    },
    rotate(dx, dy) { this.theta -= dx * 0.0065; this.phi = clamp(this.phi - dy * 0.0065, 0.04, Math.PI - 0.04); },
    pan(dx, dy) {
      const h = stage.clientHeight || 600, s = 2 * this.radius * Math.tan(camera.fov * DEG / 2) / h;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
      this.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
    },
    zoom(f) { this.radius = clamp(this.radius * f, 60, 1600); },
  };
  const VIEWS = {home: {theta: 0.62, phi: 1.36, radius: 560, t: [0, -45, -35]}, front: {theta: 0, phi: Math.PI / 2, radius: 520, t: [0, -45, -20]},
    right: {theta: -Math.PI / 2, phi: Math.PI / 2, radius: 520, t: [0, -50, -40]}, left: {theta: Math.PI / 2, phi: Math.PI / 2, radius: 520, t: [0, -50, -40]},
    below: {theta: 0, phi: Math.PI - 0.12, radius: 330, t: [0, -72, -20]}};
  // a narrow (portrait) stage shows less width: pull the camera back so the skull fits
  const fitK = () => { const a = camera.aspect || 1; return a < 1.15 ? Math.min(2.2, 1.15 / a) : 1; };
  let userMovedCam = false;
  function setView(name) {
    const v0 = VIEWS[name]; if (!v0) return; const v = Object.assign({}, v0, {radius: v0.radius * fitK()});
    const a = {theta: orbit.theta, phi: orbit.phi, radius: orbit.radius, t: orbit.target.clone()};
    let dth = v.theta - a.theta; dth = ((dth + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    tween(650, e => { orbit.theta = a.theta + dth * e; orbit.phi = a.phi + (v.phi - a.phi) * e; orbit.radius = a.radius + (v.radius - a.radius) * e;
      orbit.target.set(a.t.x + (v.t[0] - a.t.x) * e, a.t.y + (v.t[1] - a.t.y) * e, a.t.z + (v.t[2] - a.t.z) * e); }, null, 'view');
  }
  $$('.views [data-view]').forEach(b => b.addEventListener('click', () => { userMovedCam = true; setView(b.dataset.view); }));

  /* ---------- tweens ---------- */
  const tweens = [];
  function tween(dur, fn, done, tag) {
    if (tag) for (let i = tweens.length - 1; i >= 0; i--) if (tweens[i].tag === tag) tweens.splice(i, 1);
    tweens.push({t0: performance.now(), dur: reduceMotion ? 1 : dur, fn, done, tag});
  }
  const ease = s => s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2;
  function stepTweens(now) {
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i], s = clamp((now - tw.t0) / tw.dur, 0, 1); tw.fn(ease(s));
      if (s >= 1) { tweens.splice(i, 1); if (tw.done) tw.done(); }
    }
  }
  const animating = () => tweens.some(t => t.tag === 'pose' || t.tag === 'explode');

  /* ================================================================== state */
  let PIECES = null;               // window.PIECES (meta only after decoding)
  const G = {};                    // node id -> THREE.Group
  const MESH = {};                 // piece id -> THREE.Mesh
  const MAT = {};                  // piece id -> material
  let pose = null;                 // current pose (node -> local Matrix4)
  let builder = {plan: deep(E.DEFAULT_PLAN), extras: deep(E.DEFAULT_EXTRAS)};
  let planPose = null;             // pose produced by the last applied plan (to tell hand moves apart)
  let selected = null, hoverPiece = null;
  let groupMode = true, dragMode = 'move', chinDetached = false;
  const locked = new Set(), hidden = new Set();
  const pivotIdx = {};
  let explode = 0, exploded = false;
  const EXV = {};
  let metrics = null, baseMetrics = null, occ = {maxPen: 0, contacts: 0, pen: 0};
  let displayDirty = true, metricsDirty = true, occDirty = true, inspectorDirty = true;
  let lastSimCheck = null;

  const COLORS = {cranium: '#e9e1cf', spine: '#cdc6b8', hyoid: '#d8c69c', maxilla_R: '#efc27c', maxilla_L: '#f3d197', mandible_body: '#eab296',
    ramus_R: '#d3c494', ramus_L: '#dccfa5', chin: '#e79d84'};
  const TOOTH_COL = {upper: '#fbf8f1', lower: '#f8f1e3'};
  const ACCENT = new THREE.Color('#2f9fd0').convertSRGBToLinear();

  /* ================================================================== build scene */
  function buildScene(teeth) {
    for (const id of E.ORDER) {
      const g = new THREE.Group(); g.matrixAutoUpdate = false; G[id] = g;
      const n = E.NODES[id]; (n.parent ? G[n.parent] : scene).add(g);
      pivotIdx[id] = 0;
    }
    for (const id of Object.keys(PIECES)) {
      const P = PIECES[id], n = E.NODES[id];
      const col = n.kind === 'tooth' ? TOOTH_COL[n.arch] : (COLORS[id] || '#e9e1cf');
      const mat = new THREE.MeshStandardMaterial({color: new THREE.Color(col).convertSRGBToLinear(), roughness: n.kind === 'tooth' ? 0.36 : 0.62,
        metalness: 0, emissive: new THREE.Color(0x000000)});
      mat.userData.base = col; MAT[id] = mat;
      const m = new THREE.Mesh(P.geom, mat); m.userData.id = id; MESH[id] = m; G[id].add(m);
    }
    locked.add('cranium');
    // explode vectors (parent frame, mm)
    Object.assign(EXV, {cranium: [0, 0, 0], spine: [0, -22, -38], hyoid: [0, -34, 18], maxilla: [0, -16, 26], maxilla_R: [-13, -2, 2], maxilla_L: [13, -2, 2],
      mandible: [0, -46, 30], ramus_R: [-18, 2, -6], ramus_L: [18, 2, -6], mandible_body: [0, -8, 12], chin: [0, -15, 18]});
    for (const t of teeth) {
      const P = PIECES[t]; const ax = new THREE.Vector3(P.tip[0] - P.apex[0], P.tip[1] - P.apex[1], P.tip[2] - P.apex[2]).normalize();
      const rad = new THREE.Vector3(P.centroid[0], 0, P.centroid[2] + 14); if (rad.lengthSq() < 1e-6) rad.set(0, 0, 1); rad.normalize();
      const v = ax.multiplyScalar(13).add(rad.multiplyScalar(7)); EXV[t] = [v.x, v.y, v.z];
    }
    buildPickScene();
    buildOverlays();
  }

  /* ---------- display matrices ---------- */
  const _m = new THREE.Matrix4();
  function updateDisplay() {
    for (const id of E.ORDER) {
      const g = G[id], v = EXV[id] || [0, 0, 0];
      g.matrix.copy(pose[id]);
      if (explode > 0) { _m.makeTranslation(v[0] * explode, v[1] * explode, v[2] * explode); g.matrix.premultiply(_m); }
      g.matrixWorldNeedsUpdate = true;
    }
    scene.updateMatrixWorld();
  }
  function markPose() { displayDirty = metricsDirty = occDirty = inspectorDirty = true; }

  /* ================================================================== GPU picking */
  const pickScene = new THREE.Scene(), pickMeshes = [], pickIds = [];
  const pickTarget = new THREE.WebGLRenderTarget(1, 1);
  const pickBuf = new Uint8Array(4);
  function buildPickScene() {
    Object.keys(MESH).forEach((id, i) => {
      const c = i + 1; const mat = new THREE.MeshBasicMaterial({color: new THREE.Color((c & 255) / 255, ((c >> 8) & 255) / 255, 0)});
      const pm = new THREE.Mesh(MESH[id].geometry, mat); pm.matrixAutoUpdate = false; pickScene.add(pm); pickMeshes.push(pm); pickIds.push(id);
    });
  }
  function pickAt(x, y) {
    const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return null;
    scene.updateMatrixWorld();
    pickMeshes.forEach((pm, i) => {
      const id = pickIds[i], m = MESH[id];
      pm.visible = !hidden.has(id) && !(ghost && id === 'cranium');
      pm.matrix.copy(m.matrixWorld); pm.matrixWorldNeedsUpdate = true;
    });
    camera.setViewOffset(w, h, Math.round(x), Math.round(y), 1, 1);
    const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
    renderer.setRenderTarget(pickTarget); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(pickScene, camera);
    renderer.readRenderTargetPixels(pickTarget, 0, 0, 1, 1, pickBuf);
    renderer.setRenderTarget(null); renderer.setClearColor(cc, ca); camera.clearViewOffset();
    const c = pickBuf[0] + pickBuf[1] * 256;
    return c > 0 ? pickIds[c - 1] || null : null;
  }

  /* ================================================================== overlays: landmarks, ceph lines, occlusion dots */
  const LM_SHOW = ['N', 'S', 'A', 'ANS', 'PNS', 'B', 'Pog', 'Me', 'U1tip', 'L1tip', 'CoR', 'GoR', 'GoL', 'CoL'];
  const LM_LABEL = {N: 'N', S: 'S', A: 'A', ANS: 'ANS', PNS: 'PNS', B: 'B', Pog: 'Pog', Me: 'Me', U1tip: 'U1', L1tip: 'L1', CoR: 'Co', GoR: 'Go'};
  let lmPoints, lines = {}, occPoints, ghost = false, showLm = true, showOcc = true;
  const labelEls = {};
  function buildOverlays() {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LM_SHOW.length * 3), 3));
    lmPoints = new THREE.Points(g, new THREE.PointsMaterial({color: 0xffc94d, size: 7, sizeAttenuation: false, depthTest: false, transparent: true}));
    lmPoints.renderOrder = 10; lmPoints.frustumCulled = false; scene.add(lmPoints);
    const mk = (name, color) => { const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const l = new THREE.Line(lg, new THREE.LineBasicMaterial({color, depthTest: false, transparent: true, opacity: 0.85})); l.renderOrder = 9; l.frustumCulled = false; scene.add(l); lines[name] = l; };
    mk('SN', 0xffd166); mk('FH', 0x8fd3f4); mk('Nperp', 0x8fd3f4); mk('MP', 0xffd166); mk('NA', 0x9be3b5); mk('NB', 0x9be3b5);
    for (const k of Object.keys(LM_LABEL)) { const el = document.createElement('div'); el.className = 'lml'; el.textContent = LM_LABEL[k]; $('#labels').appendChild(el); labelEls[k] = el; }
    const og = new THREE.BufferGeometry();
    og.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4000 * 3), 3));
    og.setAttribute('color', new THREE.BufferAttribute(new Float32Array(4000 * 3), 3));
    og.setDrawRange(0, 0);
    occPoints = new THREE.Points(og, new THREE.PointsMaterial({size: 4.5, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true}));
    occPoints.renderOrder = 11; occPoints.frustumCulled = false; scene.add(occPoints);
  }
  const _p = new THREE.Vector3();
  function lmDisplay(name) {
    const mem = E.MEMBER[name], h = E.LM0[name];
    if (Array.isArray(mem)) { const a = _p.set(...h).applyMatrix4(G[mem[0]].matrixWorld).clone(); const b = _p.set(...h).applyMatrix4(G[mem[1]].matrixWorld); return a.add(b).multiplyScalar(0.5); }
    return _p.set(...h).applyMatrix4(G[mem].matrixWorld).clone();
  }
  function setLine(name, a, b) { const p = lines[name].geometry.attributes.position; p.setXYZ(0, a.x, a.y, a.z); p.setXYZ(1, b.x, b.y, b.z); p.needsUpdate = true; }
  function updateOverlays() {
    const vis = showLm;
    lmPoints.visible = vis; for (const l of Object.values(lines)) l.visible = vis;
    if (!vis) { for (const el of Object.values(labelEls)) el.style.display = 'none'; return; }
    const P = {}; const pa = lmPoints.geometry.attributes.position;
    LM_SHOW.forEach((k, i) => { P[k] = lmDisplay(k); pa.setXYZ(i, P[k].x, P[k].y, P[k].z); }); pa.needsUpdate = true;
    const ext = (a, b, l1, l2) => { const d = b.clone().sub(a).normalize(); return [a.clone().addScaledVector(d, -l1), b.clone().addScaledVector(d, l2)]; };
    setLine('SN', ...ext(P.S, P.N, 8, 14));
    const po = lmDisplay('PoR').add(lmDisplay('PoL')).multiplyScalar(0.5), or = lmDisplay('OrR').add(lmDisplay('OrL')).multiplyScalar(0.5);
    po.x = 0; or.x = 0; setLine('FH', ...ext(po, or, 6, 28));
    setLine('Nperp', new THREE.Vector3(0, 12, 0), new THREE.Vector3(0, -128, 0));
    const go = P.GoR.clone().add(P.GoL).multiplyScalar(0.5), me = lmDisplay('MeT'); go.x = me.x;
    setLine('MP', ...ext(go, me, 6, 10));
    setLine('NA', ...ext(P.N, P.A, 0, 8)); setLine('NB', ...ext(P.N, P.B, 0, 8));
    // labels
    const w = canvas.clientWidth, h = canvas.clientHeight;
    for (const k of Object.keys(labelEls)) {
      const v = P[k].clone().project(camera), el = labelEls[k];
      if (v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1) { el.style.display = 'none'; continue; }
      el.style.display = ''; el.style.left = ((v.x + 1) / 2 * w) + 'px'; el.style.top = ((1 - v.y) / 2 * h) + 'px';
    }
  }

  /* ================================================================== occlusion
     Every tooth gets a solid signed-distance grid in its own (home) frame: the mesh surface is rasterised into 0.5 mm voxels,
     the outside is flood-filled from the border, and a 3-D chamfer transform gives the distance to the surface inside and out.
     Crown samples of one arch are moved into each nearby opposing tooth's frame and looked up there, so a sample buried
     deep inside an opposing crown reports its true depth (the old nearest-sample probe could not see past 2 mm). */
  const OCC = {upper: [], lower: []}, GRID = {};
  const VOX = 0.5, GPAD = 1.5, FAR = 99;
  function chamfer(dist, nx, ny, nz) {
    // two-pass 26-neighbour chamfer distance (mm); interior voxels use precomputed index offsets, the 1-voxel shell checks bounds
    const back = [], fwd = [];
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy && !dz) continue;
      const w = [dx, dy, dz, (dz * ny + dy) * nx + dx, VOX * Math.hypot(dx, dy, dz)];
      if (dz < 0 || (dz === 0 && (dy < 0 || (dy === 0 && dx < 0)))) back.push(w); else fwd.push(w);
    }
    const mk = L => ({dx: Int8Array.from(L, w => w[0]), dy: Int8Array.from(L, w => w[1]), dz: Int8Array.from(L, w => w[2]), off: Int32Array.from(L, w => w[3]), w: Float32Array.from(L, w => w[4]), n: L.length});
    const B = mk(back), F = mk(fwd);
    const relax = (K, x, y, z, i) => {
      let d = dist[i]; if (d === 0) return;
      if (x > 0 && y > 0 && z > 0 && x < nx - 1 && y < ny - 1 && z < nz - 1) {
        for (let k = 0; k < K.n; k++) { const v = dist[i + K.off[k]] + K.w[k]; if (v < d) d = v; }
      } else {
        for (let k = 0; k < K.n; k++) {
          const X = x + K.dx[k], Y = y + K.dy[k], Z = z + K.dz[k]; if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
          const v = dist[i + K.off[k]] + K.w[k]; if (v < d) d = v;
        }
      }
      dist[i] = d;
    };
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) relax(B, x, y, z, (z * ny + y) * nx + x);
    for (let z = nz - 1; z >= 0; z--) for (let y = ny - 1; y >= 0; y--) for (let x = nx - 1; x >= 0; x--) relax(F, x, y, z, (z * ny + y) * nx + x);
  }
  function buildGrid(geom) {
    geom.computeBoundingBox(); const bb = geom.boundingBox;
    const o = [bb.min.x - GPAD, bb.min.y - GPAD, bb.min.z - GPAD];
    const nx = Math.ceil((bb.max.x - bb.min.x + 2 * GPAD) / VOX) + 1, ny = Math.ceil((bb.max.y - bb.min.y + 2 * GPAD) / VOX) + 1, nz = Math.ceil((bb.max.z - bb.min.z + 2 * GPAD) / VOX) + 1;
    const N = nx * ny * nz, solid = new Uint8Array(N), pos = geom.attributes.position.array, idx = geom.index.array;
    const mark = (x, y, z) => { solid[(Math.floor((z - o[2]) / VOX) * ny + Math.floor((y - o[1]) / VOX)) * nx + Math.floor((x - o[0]) / VOX)] = 1; };
    for (let t = 0; t < idx.length; t += 3) {
      const a = 3 * idx[t], b = 3 * idx[t + 1], c = 3 * idx[t + 2];
      const L = Math.max(Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]), Math.hypot(pos[b] - pos[c], pos[b + 1] - pos[c + 1], pos[b + 2] - pos[c + 2]),
        Math.hypot(pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]));
      const n = Math.max(1, Math.ceil(L / (VOX * 0.45)));
      for (let u = 0; u <= n; u++) for (let v = 0; v <= n - u; v++) {
        const w = n - u - v;
        mark((pos[a] * u + pos[b] * v + pos[c] * w) / n, (pos[a + 1] * u + pos[b + 1] * v + pos[c + 1] * w) / n, (pos[a + 2] * u + pos[b + 2] * v + pos[c + 2] * w) / n);
      }
    }
    // flood the outside (6-connected) from every border voxel; everything not reached is tooth
    const out = new Uint8Array(N), q = new Int32Array(N); let qh = 0, qt = 0;
    const seed = i => { if (!solid[i] && !out[i]) { out[i] = 1; q[qt++] = i; } };
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) seed((z * ny + y) * nx + x);
    const sxy = nx * ny;
    while (qh < qt) {
      const i = q[qh++], x = i % nx, y = ((i - x) / nx) % ny, z = Math.floor(i / sxy);
      if (x > 0) seed(i - 1); if (x < nx - 1) seed(i + 1); if (y > 0) seed(i - nx); if (y < ny - 1) seed(i + nx); if (z > 0) seed(i - sxy); if (z < nz - 1) seed(i + sxy);
    }
    const din = new Float32Array(N), dout = new Float32Array(N);
    for (let i = 0; i < N; i++) { din[i] = out[i] ? 0 : FAR; dout[i] = out[i] ? FAR : 0; }
    chamfer(din, nx, ny, nz); chamfer(dout, nx, ny, nz);
    const sd = new Float32Array(N);   // signed distance to the surface, mm (- = inside the tooth)
    for (let i = 0; i < N; i++) sd[i] = out[i] ? dout[i] - VOX / 2 : -(din[i] - VOX / 2);
    const c = new THREE.Vector3(); bb.getCenter(c);
    return {o, nx, ny, nz, sd, c: c.toArray(), r: bb.getSize(new THREE.Vector3()).length() / 2 + GPAD};
  }
  function prepOcclusion(teeth) {
    for (const t of teeth) {
      const P = PIECES[t], g = MESH[t].geometry, pos = g.attributes.position.array, n = pos.length / 3;
      GRID[t] = buildGrid(g);
      const u = [P.apex[0] - P.tip[0], P.apex[1] - P.tip[1], P.apex[2] - P.tip[2]], L = Math.hypot(...u); u[0] /= L; u[1] /= L; u[2] /= L;
      const crown = [];
      for (let i = 0; i < n; i++) { const s = (pos[3 * i] - P.tip[0]) * u[0] + (pos[3 * i + 1] - P.tip[1]) * u[1] + (pos[3 * i + 2] - P.tip[2]) * u[2]; if (s < 6.5) crown.push(i); }
      const stride = Math.max(1, Math.ceil(crown.length / 520)); const idx = crown.filter((_, k) => k % stride === 0);
      const lp = new Float32Array(idx.length * 3);
      idx.forEach((i, k) => { for (let j = 0; j < 3; j++) lp[3 * k + j] = pos[3 * i + j]; });
      OCC[E.NODES[t].arch].push({id: t, lp, n: idx.length});
    }
  }
  function worldPts(set, W) {
    let total = 0; for (const s of set) total += s.n;
    const P = new Float32Array(total * 3); let o = 0; const v = new THREE.Vector3();
    for (const s of set) {
      const M = W[s.id];
      for (let k = 0; k < s.n; k++) { v.set(s.lp[3 * k], s.lp[3 * k + 1], s.lp[3 * k + 2]).applyMatrix4(M); P[o++] = v.x; P[o++] = v.y; P[o++] = v.z; }
    }
    return {P, n: total};
  }
  const OCC_CONTACT = 0.35;   // |signed distance| within this = touching (the crowns were segmented in occlusion)
  const OCC_NEAR = 0.5;       // outside but within this of the opposing surface = contact dot
  // signed distance of each sample of A to the nearest opposing tooth in `opp` (looked up in that tooth's own grid)
  function probe(A, opp, W, out) {
    const T = opp.map(s => { const G = GRID[s.id], M = W[s.id]; const c = new THREE.Vector3(...G.c).applyMatrix4(M);
      return {G, e: new THREE.Matrix4().copy(M).invert().elements, cx: c.x, cy: c.y, cz: c.z, r2: G.r * G.r}; });
    const pens = [];
    for (let i = 0; i < A.n; i++) {
      const x = A.P[3 * i], y = A.P[3 * i + 1], z = A.P[3 * i + 2]; let best = FAR;
      for (const t of T) {
        const dx = x - t.cx, dy = y - t.cy, dz = z - t.cz; if (dx * dx + dy * dy + dz * dz > t.r2) continue;
        const e = t.e, G = t.G;
        const lx = e[0] * x + e[4] * y + e[8] * z + e[12], ly = e[1] * x + e[5] * y + e[9] * z + e[13], lz = e[2] * x + e[6] * y + e[10] * z + e[14];
        const gx = Math.floor((lx - G.o[0]) / VOX), gy = Math.floor((ly - G.o[1]) / VOX), gz = Math.floor((lz - G.o[2]) / VOX);
        if (gx < 0 || gy < 0 || gz < 0 || gx >= G.nx || gy >= G.ny || gz >= G.nz) continue;
        const d = G.sd[(gz * G.ny + gy) * G.nx + gx]; if (d < best) best = d;
      }
      if (best < -OCC_CONTACT) { pens.push(-best); out.push(x, y, z, 1); }
      else if (best < OCC_NEAR) out.push(x, y, z, 0);
    }
    pens.sort((a, b) => b - a);
    const maxPen = pens.length > 3 ? pens[3] : (pens.length ? pens[pens.length - 1] : 0);   // robust: 4th deepest sample
    return {maxPen, nPen: pens.length, n: A.n};
  }
  // red ("teeth collide") rule shared by the warning and the missions: deeper than 2 mm, or more than 10 % of the crown samples inside
  const OCC_RED_MM = 2.0, OCC_RED_FRAC = 0.10;
  function computeOcclusion() {
    const W = E.worlds(pose);
    const up = OCC.upper.filter(s => !hidden.has(s.id)), lo = OCC.lower.filter(s => !hidden.has(s.id));
    const U = worldPts(up, W), L = worldPts(lo, W);
    const out = [];
    const a = probe(L, up, W, out), b = probe(U, lo, W, out);
    let nC = 0; for (let i = 3; i < out.length; i += 4) if (!out[i]) nC++;
    const total = Math.max(1, a.n + b.n), pen = a.nPen + b.nPen, maxPen = Math.max(a.maxPen, b.maxPen);
    occ = {maxPen, pen, contacts: nC, samples: total, penFrac: pen / total, red: maxPen > OCC_RED_MM || pen / total > OCC_RED_FRAC};
    const pa = occPoints.geometry.attributes.position, ca = occPoints.geometry.attributes.color; let k = 0;
    for (let i = 0; i < out.length && k < 4000; i += 4) {
      pa.setXYZ(k, out[i], out[i + 1], out[i + 2]);
      if (out[i + 3]) ca.setXYZ(k, 1.0, 0.25, 0.2); else ca.setXYZ(k, 0.35, 0.9, 0.5);
      k++;
    }
    occPoints.geometry.setDrawRange(0, k); pa.needsUpdate = true; ca.needsUpdate = true;
    updateWarnings();
  }

  /* ================================================================== selection, routing, highlight */
  function routeOf(pid) {
    if (!pid || !groupMode) return pid;
    const n = E.NODES[pid];
    if (pid === 'maxilla_R' || pid === 'maxilla_L' || (n.kind === 'tooth' && n.arch === 'upper')) return 'maxilla';
    if (pid === 'mandible_body' || (n.kind === 'tooth' && n.arch === 'lower')) return 'mandible_body';
    if (pid === 'chin') return chinDetached ? 'chin' : 'mandible_body';
    if (pid === 'ramus_R' || pid === 'ramus_L') return 'mandible';
    return pid;
  }
  function descPieces(id) { const out = []; const rec = n => { if (MESH[n]) out.push(n); for (const c of E.NODES[n].children) rec(c); }; rec(id); return out; }
  function movable(id) { return id && !E.NODES[id].fixed && !locked.has(id); }
  function refreshHighlight() {
    const sel = new Set(selected ? descPieces(selected) : []);
    const hov = new Set(hoverPiece ? descPieces(routeOf(hoverPiece)) : []);
    for (const id of Object.keys(MAT)) {
      const m = MAT[id];
      if (sel.has(id)) m.emissive.copy(ACCENT).multiplyScalar(0.32);
      else if (hov.has(id)) m.emissive.copy(ACCENT).multiplyScalar(0.16);
      else m.emissive.setRGB(0, 0, 0);
    }
  }
  function select(id, opts) {
    selected = id || null; refreshHighlight(); renderPieceSel(); renderInspector(); updateStatus();
    if (id && opts && opts.showMove) showLeft('tab-move');
  }
  function updateStatus() {
    const s = $('#status');
    if (!selected) { s.textContent = dragMode === 'orbit' ? 'Orbit mode: drag to turn the view' : dragMode === 'rotate' ? 'Rotate mode: click a piece to select it, drag it to rotate it about its pivot' : 'Click a piece to select it, drag it to move it (Shift-drag rotates)'; return; }
    const n = E.NODES[selected];
    const how = !movable(selected) ? (n.fixed ? 'fixed reference' : 'locked') : dragMode === 'rotate' ? 'drag rotates' : dragMode === 'orbit' ? 'orbit mode' : 'drag moves, Shift-drag rotates';
    s.textContent = n.short + ' · ' + how + ' · pivot: ' + n.pivots[pivotIdx[selected] || 0].name;
  }

  /* ================================================================== undo / redo */
  const undoStack = [], redoStack = [];
  let lastPushT = 0;
  function snapshot() { const p = {}; for (const id of E.ORDER) p[id] = pose[id].toArray(); return {pose: p, builder: deep(builder), chinDetached, handDirty, planPose: planPose ? Object.fromEntries(E.ORDER.map(id => [id, planPose[id].toArray()])) : null}; }
  function poseFromArrays(o) { const P = E.newPose(); for (const id of E.ORDER) if (o[id]) P[id].fromArray(o[id]); return P; }
  function pushUndo(snap) { undoStack.push(snap || snapshot()); if (undoStack.length > 150) undoStack.shift(); redoStack.length = 0; lastPushT = performance.now(); syncUndo(); }
  function syncUndo() { $('#btnUndo').disabled = !undoStack.length; $('#btnRedo').disabled = !redoStack.length; }
  function restore(s) {
    builder = s.builder; chinDetached = s.chinDetached; handDirty = !!s.handDirty; planPose = s.planPose ? poseFromArrays(s.planPose) : null;
    animatePoseTo(poseFromArrays(s.pose), 260); renderBuilder(); renderInspector();
  }
  function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); syncUndo(); toast('Undone'); }
  function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); syncUndo(); toast('Redone'); }
  $('#btnUndo').addEventListener('click', undo); $('#btnRedo').addEventListener('click', redo);

  function setPoseNow(target) {
    for (let i = tweens.length - 1; i >= 0; i--) if (tweens[i].tag === 'pose') tweens.splice(i, 1);
    for (const id of E.ORDER) pose[id].copy(target[id]); markPose();
  }
  function animatePoseTo(target, dur) {
    if (document.hidden) { setPoseNow(target); return; }   // hidden tabs throttle animation frames: jump straight to the end
    const from = E.clonePose(pose);
    tween(dur == null ? 750 : dur, e => { E.lerpPose(from, target, e, pose); markPose(); }, () => { for (const id of E.ORDER) pose[id].copy(target[id]); markPose(); }, 'pose');
  }
  let handDirty = false;   // set by drags, inspector edits, keys and piece resets; cleared when a plan is applied
  function handMoved() { return handDirty; }

  /* ================================================================== plan application */
  function applyPlan(opts) {
    opts = opts || {};
    let r;
    try { r = E.simulate(builder.plan, builder.extras); } catch (e) { toast('Plan not possible: ' + e.message, 5000); return null; }
    const hadHand = handMoved();
    if (!opts.noUndo) pushUndo(opts.snap);
    planPose = E.clonePose(r.pose); handDirty = false;
    if (opts.instant || document.hidden) setPoseNow(r.pose); else animatePoseTo(r.pose, opts.dur);
    lastReport = r.report;
    const msgs = [];
    if (opts.msg) msgs.push(opts.msg);
    if (opts.bssoReport && r.report.mode === 'bsso') {
      const M = E.measure(r.state), rot = r.report.mand_rot;
      msgs.push('Net from the scan: B ' + sgn(M.B_AP_change) + ' mm, bony Pog ' + sgn(M.PogT_AP_change) + ' mm (+ = forward). Seating on the upper teeth rotated the tooth-bearing mandible ' +
        fmt(Math.abs(rot)) + '° ' + (rot < 0 ? 'counter-clockwise (closing the bite)' : 'clockwise (opening)') + ', so B and Pog do not move by the slider amount.');
    }
    if (r.report.flags.length) msgs.push(r.report.flags[0]);
    if (r.report.notes.length) msgs.push(r.report.notes[0]);
    if (hadHand && !opts.quiet) msgs.push('Hand moves were replaced (Undo brings them back).');
    if (msgs.length) toast(msgs.join(' '), opts.bssoReport ? 10000 : 5200);
    renderBuilder();
    if (!opts.instant) revealStage();
    return r;
  }
  // phones and narrow windows stack the panels under the 3-D view: bring the view back on screen so the move can be seen
  function revealStage() {
    if (!matchMedia('(max-width:900px)').matches) return;
    const st = $('#stage'), r = st.getBoundingClientRect();
    if (r.top < -40 || r.bottom > innerHeight + 40) st.scrollIntoView({behavior: (reduceMotion || document.hidden) ? 'auto' : 'smooth', block: 'start'});
  }
  let lastReport = null;

  /* ================================================================== pieces panel */
  function renderPieces() {
    const T = id => E.NODES[id];
    const sw = id => { const c = MESH[id] ? MAT[id].userData.base : (id === 'maxilla' ? COLORS.maxilla_R : '#eab296'); return '<span class="sw" style="background:' + c + '"></span>'; };
    const row = (id, label, cls) => '<div class="prow ' + (cls || '') + '" data-id="' + id + '"><button type="button" class="nm" data-act="sel" aria-label="Select ' + esc(T(id).label) + '">' + sw(id) + esc(label) + '</button>' +
      '<button type="button" class="ib" data-act="eye" aria-pressed="true" aria-label="Show or hide ' + esc(T(id).short) + '">eye</button>' +
      (T(id).fixed ? '<span class="ib sub" style="margin:0">fixed</span>' : '<button type="button" class="ib" data-act="lock" aria-pressed="false" aria-label="Lock ' + esc(T(id).short) + '">lock</button>') + '</div>';
    const teethGrid = (arch, ids) => '<div class="teethgrid" role="group" aria-label="' + arch + ' teeth">' + ids.map(t => '<button type="button" data-tooth="' + t + '" aria-label="Select ' + esc(T(t).label) + '">' + T(t).fdi + '</button>').join('') + '</div>';
    const up = E.ORDER.filter(i => T(i).kind === 'tooth' && T(i).arch === 'upper'), lo = E.ORDER.filter(i => T(i).kind === 'tooth' && T(i).arch === 'lower');
    const sortQ = (ids, q1, q2) => ids.filter(i => Math.floor(T(i).fdi / 10) === q1).sort((a, b) => T(b).fdi - T(a).fdi).concat(ids.filter(i => Math.floor(T(i).fdi / 10) === q2).sort((a, b) => T(a).fdi - T(b).fdi));
    $('#pieceList').innerHTML =
      '<div class="pgroup">' + row('cranium', 'Cranium') + row('spine', 'Cervical spine', 'indent') + row('hyoid', 'Hyoid', 'indent') + '</div>' +
      '<div class="pgroup">' + row('maxilla', 'Le Fort I segment') + row('maxilla_R', 'Maxilla, right half', 'indent') + row('maxilla_L', 'Maxilla, left half', 'indent') +
      '<div class="prow indent"><span class="sub" style="margin:0">Upper teeth (right ← → left)</span><button type="button" class="ib" data-arch="upper" aria-label="Show or hide all upper teeth">eye</button></div>' + teethGrid('Upper', sortQ(up, 1, 2)) + '</div>' +
      '<div class="pgroup">' + row('mandible', 'Whole mandible') + row('ramus_R', 'Ramus, right', 'indent') + row('ramus_L', 'Ramus, left', 'indent') +
      row('mandible_body', 'Mandible body (BSSO)', 'indent') + row('chin', 'Chin (genioplasty)', 'indent') +
      '<div class="prow indent"><span class="sub" style="margin:0">Lower teeth (right ← → left)</span><button type="button" class="ib" data-arch="lower" aria-label="Show or hide all lower teeth">eye</button></div>' + teethGrid('Lower', sortQ(lo, 4, 3)) + '</div>' +
      '<p class="fine">In <b>operation groups</b> mode a click on a maxilla half or an upper tooth grabs the whole Le Fort I segment, a lower tooth or the chin grabs the BSSO segment, a ramus grabs the whole mandible. Switch groups off to move single pieces or teeth (relative to their jaw).</p>';
    renderPieceSel();
  }
  function renderPieceSel() {
    for (const r of $$('#pieceList .prow[data-id]')) {
      const id = r.dataset.id; r.classList.toggle('sel', id === selected);
      const pcs = descPieces(id); const vis = pcs.some(p => !hidden.has(p));
      const eye = $('[data-act=eye]', r); eye.setAttribute('aria-pressed', vis); eye.textContent = vis ? 'eye' : 'hidden';
      const lk = $('[data-act=lock]', r); if (lk) { lk.setAttribute('aria-pressed', locked.has(id)); lk.textContent = locked.has(id) ? 'locked' : 'lock'; }
    }
    for (const b of $$('#pieceList [data-tooth]')) { b.classList.toggle('sel', b.dataset.tooth === selected); b.classList.toggle('hid', hidden.has(b.dataset.tooth)); b.setAttribute('aria-pressed', b.dataset.tooth === selected); }
  }
  $('#pieceList').addEventListener('click', e => {
    const tb = e.target.closest('[data-tooth]');
    if (tb) { select(tb.dataset.tooth); return; }
    const ab = e.target.closest('[data-arch]');
    if (ab) { const ids = E.ORDER.filter(i => E.NODES[i].kind === 'tooth' && E.NODES[i].arch === ab.dataset.arch); const anyVis = ids.some(i => !hidden.has(i));
      ids.forEach(i => { if (anyVis) hidden.add(i); else hidden.delete(i); MESH[i].visible = !hidden.has(i); }); occDirty = true; renderPieceSel(); return; }
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const id = b.closest('[data-id]').dataset.id;
    if (b.dataset.act === 'sel') select(id);
    else if (b.dataset.act === 'eye') { const pcs = descPieces(id); const anyVis = pcs.some(p => !hidden.has(p)); pcs.forEach(p => { if (anyVis) hidden.add(p); else hidden.delete(p); MESH[p].visible = !hidden.has(p); }); occDirty = true; renderPieceSel(); }
    else if (b.dataset.act === 'lock') { if (locked.has(id)) locked.delete(id); else locked.add(id); renderPieceSel(); renderInspector(); updateStatus(); }
  });

  /* ================================================================== inspector */
  const PRM = [['t', 0, 'Lateral', 'mm', '+ = toward the patient\'s left', 30], ['t', 1, 'Vertical', 'mm', '+ = up', 30], ['t', 2, 'Front-back', 'mm', '+ = forward (anterior)', 30],
    ['r', 0, 'Pitch', '°', '+ = clockwise seen from the patient\'s right: front goes down, chin down and back', 45], ['r', 1, 'Roll', '°', '+ = patient\'s left side up', 45],
    ['r', 2, 'Yaw', '°', '+ = front swings toward the patient\'s left', 45]];
  let inspEditing = false;
  function curPivot(id) { return E.NODES[id].pivots[pivotIdx[id] || 0].p; }
  function renderInspector() {
    const box = $('#inspector');
    if (!selected) { box.innerHTML = '<p class="sub">Select a piece in the 3-D view or in the Pieces list. Groups (Le Fort I segment, whole mandible) can be selected in the list.</p>'; return; }
    const n = E.NODES[selected], can = movable(selected);
    const kind = n.kind === 'group' ? 'Rigid group: everything below it in the Pieces list moves with it.' : n.kind === 'tooth' ? 'Tooth: moves relative to its jaw (orthodontic movement).' :
      selected === 'mandible_body' ? 'BSSO distal segment: carries the lower teeth and the chin; the rami stay.' : selected === 'chin' ? 'Genioplasty segment: moves relative to the mandible body.' :
      n.fixed ? 'Fixed reference: the Frankfort frame and S, N are defined on it.' : 'Rigid piece.';
    let h = '<div class="insp"><h3>' + esc(n.label) + '</h3><div class="kind">' + kind + '</div>';
    h += '<label class="hint" for="pivotSel">Pivot for rotations and for the numbers below</label><select id="pivotSel">' + n.pivots.map((p, i) => '<option value="' + i + '"' + (i === (pivotIdx[selected] || 0) ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select>';
    h += '<p class="hint" style="margin:0 0 4px">Movement of the pivot point and rotation about it, relative to ' + (n.parent ? esc(E.NODES[n.parent].short.toLowerCase()) : 'the skull') + ' (GL frame, mm and degrees).</p>';
    PRM.forEach(([k, i, lab, unit, tip, lim], j) => {
      const step = k === 't' ? 0.1 : 0.1;
      h += '<div class="prm"><label for="pr' + j + '" title="' + esc(tip) + '">' + lab + ' (' + unit + ')</label>' +
        '<input type="range" id="pr' + j + '" data-j="' + j + '" min="' + -lim + '" max="' + lim + '" step="' + step + '" aria-describedby="pd' + j + '"' + (can ? '' : ' disabled') + '>' +
        '<input type="number" id="pn' + j + '" data-j="' + j + '" min="' + -lim + '" max="' + lim + '" step="' + (k === 't' ? 0.5 : 1) + '" aria-label="' + lab + ' value in ' + (unit === '°' ? 'degrees' : 'millimetres') + '"' + (can ? '' : ' disabled') + '>' +
        '<span id="pd' + j + '" class="vh">' + esc(tip) + '</span></div>';
    });
    h += '<p class="hint">Pitch: + = clockwise (patient facing right), as in the simulator. Keyboard on the 3-D view: arrows move, Shift+arrows rotate, PgUp/PgDn lateral.</p><div class="row">';
    h += '<button type="button" id="btnPieceReset"' + (can ? '' : ' disabled') + '>Reset this piece</button>';
    if (!n.fixed) h += '<button type="button" id="btnPieceLock" aria-pressed="' + locked.has(selected) + '">' + (locked.has(selected) ? 'Unlock' : 'Lock') + '</button>';
    if (selected === 'chin' || selected === 'mandible_body') h += '<button type="button" id="btnChin" aria-pressed="' + chinDetached + '" title="In operation-groups mode the chin moves with the BSSO segment unless it is detached">' + (chinDetached ? 'Chin detached (genioplasty)' : 'Detach chin from BSSO group') + '</button>';
    if (n.parent) h += '<button type="button" id="btnParent">Select ' + esc(E.NODES[n.parent].short) + '</button>';
    h += '</div>';
    if (n.kind === 'tooth') { const P = PIECES[selected]; h += '<p class="fine">Length ' + fmt(P.length_mm) + ' mm (segmented; apices can be 1 to 2 mm short). Mesh volume ' + Math.round(P.volume_mesh_mm3) + ' mm³ is about ' + fmt(P.volume_mesh_mm3 / P.typical_volume_mm3) + '× a textbook tooth because of the CBCT partial-volume rim: do not teach tooth volumes from it.</p>'; }
    h += '</div>';
    box.innerHTML = h; inspectorDirty = true; updateInspectorValues(true);
  }
  function updateInspectorValues(force) {
    if (!selected || (!force && !inspectorDirty)) return; inspectorDirty = false;
    const prm = E.decompose(pose[selected], curPivot(selected)); const vals = prm.t.concat(prm.r);
    for (let j = 0; j < 6; j++) {
      const r = $('#pr' + j), nb = $('#pn' + j); if (!r) return;
      if (document.activeElement !== nb) nb.value = (+vals[j].toFixed(1)).toString();
      if (!(inspEditing && document.activeElement === r)) r.value = vals[j];
    }
  }
  function inspectorInput(e) {
    const j = +e.target.dataset.j; if (isNaN(j) || !selected || !movable(selected)) return;
    if (!inspEditing) { pushUndo(); inspEditing = true; }
    handDirty = true;
    const prm = E.decompose(pose[selected], curPivot(selected)); const vals = prm.t.concat(prm.r);
    const lim = PRM[j][5]; let v = parseFloat(e.target.value); if (!isFinite(v)) return;
    if (Math.abs(v) > lim) { v = clamp(v, -lim, lim); if (e.type === 'change') { e.target.value = v; toast(PRM[j][2] + ' is limited to ±' + lim + ' ' + PRM[j][3] + '.'); } }
    vals[j] = v;
    pose[selected].copy(E.compose({t: vals.slice(0, 3), r: vals.slice(3)}, curPivot(selected)));
    markPose(); if (e.target.type === 'number') $('#pr' + j).value = v; else $('#pn' + j).value = (+v.toFixed(1)).toString();
  }
  $('#inspector').addEventListener('input', e => { if (e.target.dataset.j != null) inspectorInput(e); });
  $('#inspector').addEventListener('change', e => { if (e.target.dataset.j != null) { inspectorInput(e); inspEditing = false; } else if (e.target.id === 'pivotSel') { pivotIdx[selected] = +e.target.value; inspectorDirty = true; updateInspectorValues(true); updateStatus(); } });
  $('#inspector').addEventListener('click', e => {
    const id = e.target.id;
    if (id === 'btnPieceReset') { pushUndo(); handDirty = true; const T = E.clonePose(pose); T[selected] = new THREE.Matrix4(); animatePoseTo(T, 450); }
    else if (id === 'btnPieceLock') { if (locked.has(selected)) locked.delete(selected); else locked.add(selected); renderInspector(); renderPieceSel(); updateStatus(); }
    else if (id === 'btnChin') { chinDetached = !chinDetached; renderInspector(); toast(chinDetached ? 'Chin detached: in groups mode it now moves on its own (genioplasty).' : 'Chin re-attached to the BSSO group.'); }
    else if (id === 'btnParent') select(E.NODES[selected].parent);
  });

  /* ================================================================== readout */
  const READ = [
    {sec: 'Sagittal jaw relation'},
    {k: 'SNA', lab: 'SNA', u: '°', n: 82, sd: 2, src: 'Steiner', def: 'Angle S–N–A: maxilla to cranial base'},
    {k: 'SNB', lab: 'SNB', u: '°', n: 80, sd: 2, src: 'Steiner', def: 'Angle S–N–B: mandible to cranial base'},
    {k: 'ANB', lab: 'ANB', u: '°', n: 2, sd: 2, src: 'Steiner', def: 'SNA − SNB; negative = Class III'},
    {k: 'A_to_Nperp', lab: 'A to N-perp', u: 'mm', n: 1.0, sd: 2.5, src: 'McNamara 1.1 ± 2.7 ÷ 1.08', def: 'FH-horizontal distance of A point from the vertical through nasion, + = in front'},
    {k: 'Pog_to_Nperp', lab: 'Pog to N-perp', u: 'mm', n: -0.3, sd: 3.5, src: 'McNamara −0.3 ± 3.8 ÷ 1.08', def: 'FH-horizontal distance of bony pogonion from the N vertical'},
    {sec: 'Teeth'},
    {k: 'overjet', lab: 'Overjet', u: 'mm', n: 3.2, sd: 0.6, src: 'atlas male norm', def: 'U1 edge ahead of L1 edge, FH-horizontal; negative = reverse overjet'},
    {k: 'overbite', lab: 'Overbite', u: 'mm', n: 3.2, sd: 0.7, src: 'atlas male norm', def: 'L1 edge above U1 edge, FH-vertical; negative = open bite'},
    {k: 'U1_FH', lab: 'U1–FH', u: '°', n: 111, sd: 6, src: 'atlas norm', def: 'Upper incisor long axis (tip→apex) to Frankfort horizontal'},
    {k: 'IMPA', lab: 'IMPA', u: '°', n: 90, sd: 5, src: 'Tweed 90 (SD conventional)', def: 'Lower incisor long axis to the mandibular plane Go–Me (true plane, before genioplasty)'},
    {sec: 'Vertical'},
    {k: 'FMA', lab: 'FMA', u: '°', n: 21.3, sd: 3.9, src: 'McNamara', def: 'Frankfort to mandibular plane Go–Me (true plane)'},
    {k: 'N_Me', lab: 'N–Me', u: 'mm', n: 112.5, sd: 7.5, src: 'Jarabak (unscaled)', def: 'Total anterior face height, sagittal projection'},
    {k: 'ANS_Me', lab: 'ANS–Me', u: 'mm', n: 69.1, sd: 4.6, src: 'McNamara 74.6 ± 5 ÷ 1.08', def: 'Lower anterior face height, sagittal projection'},
    {sec: 'Transverse'},
    {k: 'basal_width_change_JJ', lab: 'Basal width change (J–J)', u: 'mm', def: 'Change of the distance between the jugale points carried by the two maxilla halves'},
    {k: 'intermolar_width_change', lab: 'Intermolar change', u: 'mm', def: 'Change of the distance between the upper first-molar contact points'},
    {k: 'Penn_differential_Mx_minus_Md', lab: 'Penn Mx − Md', u: 'mm', n: 5, sd: 2.5, src: 'Penn: maxilla ≥ 5 mm wider', def: '59.0 mm (given) + J–J change, minus the mandibular basal width 64.5 mm'},
    {sec: 'Mandible front-back (airway check)'},
    {k: 'B_AP_change', lab: 'B point', u: 'mm', airway: true, def: 'Forward (+) or back (−) change of B point from the start'},
    {k: 'PogT_AP_change', lab: 'Pog (bony, before genio)', u: 'mm', airway: true, def: 'Change of bony pogonion carried by the mandible body, i.e. before any genioplasty; the airway test uses the worse of B and this'},
    {k: 'Pog_AP_change', lab: 'Pog (with chin move)', u: 'mm', def: 'Change of pogonion including any genioplasty'},
  ];
  function chipOf(r, v) {
    if (r.airway) return v < -2 ? 'bad' : v < -0.05 ? 'warn' : 'ok';
    if (r.n == null) return '';
    const z = Math.abs((v - r.n) / r.sd); return z <= 1 ? 'ok' : z <= 2 ? 'warn' : 'bad';
  }
  const chipText = {ok: 'within 1 SD', warn: '1 to 2 SD out', bad: 'more than 2 SD out', '': ''};
  function renderReadout() {
    $('#readoutBody').innerHTML = READ.map(r => r.sec ? '<tr class="sec"><td colspan="5">' + r.sec + '</td></tr>' :
      '<tr data-k="' + r.k + '"><td class="nm" title="' + esc(r.def) + '">' + r.lab + '<small>' + esc(r.def) + '</small></td><td class="num v"></td><td class="num d"></td><td class="num">' +
      (r.n != null ? fmt(r.n) + (r.sd ? ' ± ' + fmt(r.sd) : '') : r.airway ? '≥ −2.0' : '') + '</td><td><span class="chip" role="img"></span></td></tr>').join('');
  }
  function updateReadout() {
    if (!metrics) return;
    for (const r of READ) {
      if (r.sec) continue; const tr = $('#readoutBody tr[data-k="' + r.k + '"]'); if (!tr) continue;
      const v = metrics[r.k], b = baseMetrics[r.k];
      $('.v', tr).textContent = (r.airway || /change/.test(r.k) ? sgn(v) : fmt(v));
      $('.d', tr).textContent = (r.airway || /change/.test(r.k)) ? '' : sgn(v - b);
      if (r.k === 'basal_width_change_JJ' || r.k === 'Penn_differential_Mx_minus_Md') {
        const sk = +builder.plan.expansion.skeletal_mm || 0, vMode = builder.extras.expansion_pattern === 'V' && sk > 0;
        const note = vMode ? r.def + '. V hinge: sim.py (parallel model) counts ' + sgn(sk) + ' mm of basal width here; the hinge gives ' + sgn(metrics.basal_width_change_JJ) + ' mm at J.' : r.def;
        const sm = $('small', tr); if (sm.textContent !== note) { sm.textContent = note; tr.classList.toggle('vnote', vMode); }
      }
      const c = chipOf(r, v), ch = $('.chip', tr); ch.className = 'chip ' + c; ch.setAttribute('aria-label', chipText[c] || 'no norm'); ch.title = (r.src ? r.src + ': ' : '') + (chipText[c] || 'no norm');
    }
  }
  /* why the mandible is back: rotation about the condyles (sim.py: "clockwise rotation of X deg") or a distal-segment move */
  function setbackMechanism() {
    const v = new THREE.Vector3(0, 0, 1).transformDirection(E.worldOf(pose, 'mandible_body'));
    const rotCW = Math.atan2(-v.y, v.z) / DEG;
    const bd = E.decompose(pose.mandible_body, E.LM0.L1tip);
    const bodyMoved = Math.hypot(...bd.t) > 0.05 || Math.hypot(...bd.r) > 0.05;
    if (!bodyMoved && rotCW > 0.3) return {rotation: true, rotCW, text: 'by clockwise rotation of ' + fmt(rotCW) + '° about the condyles'};
    const rw = Math.abs(rotCW) < 0.05 ? 'no rotation' : 'rotation ' + fmt(Math.abs(rotCW)) + '° ' + (rotCW < 0 ? 'counter-clockwise' : 'clockwise');
    if (!bodyMoved) return {rotation: false, rotCW, text: 'by moving the whole mandible (' + rw + ')'};
    const l1 = new E.State(pose).p3('L1tip')[2] - E.LM0.L1tip[2];
    return {rotation: false, rotCW, text: 'by the distal-segment move (L1 edge front-back ' + sgn(l1) + ' mm, ' + rw + ')'};
  }
  function updateWarnings() {
    if (!metrics) return;
    const W = [];
    if (explode > 0.01) W.push({c: 'warn', h: 'Exploded view', t: 'Exploded view: the readout and the bite checks use the seated positions.'});
    const pct = Math.round(100 * (occ.penFrac || 0));
    if (occ.red) W.push({c: 'bad', h: 'Teeth collide ' + fmt(occ.maxPen) + ' mm', t: 'Teeth collide: overlapping by ' + fmt(occ.maxPen) + ' mm (' + occ.pen + ' crown samples, ' + pct + ' %, inside the opposing teeth; red above 2 mm or 10 %). Real teeth cannot pass through each other, so the jaw would be propped open on these cusps. The plan seats the jaws on single landmark contacts; arches that do not fit (too narrow, cusp on cusp) show up here. Look from Below, then expand, move a jaw, or seat the bite differently.'});
    else if (occ.maxPen > 1.0) W.push({c: 'warn', h: 'Teeth overlap ' + fmt(occ.maxPen) + ' mm', t: 'Teeth overlapping by ' + fmt(occ.maxPen) + ' mm (' + occ.pen + ' crown samples, ' + pct + ' %). More than cusps settling into each other: check the bite before going on (it turns red above 2 mm or 10 % of the samples).'});
    else if (occ.maxPen > 0.6) W.push({c: 'warn', h: 'Cusp interference ' + fmt(occ.maxPen) + ' mm', t: 'Cusp interference: teeth overlapping by ' + fmt(occ.maxPen) + ' mm (' + occ.pen + ' crown samples). The plan seats the jaws on single contact points; cusp-level fit comes from arch coordination (orthodontics), which is not simulated.'});
    else if (occ.contacts > 8) W.push({c: 'ok', h: 'Teeth in contact', t: 'Teeth in contact (' + occ.contacts + ' touching samples' + (occ.maxPen > OCC_CONTACT ? ', deepest ' + fmt(occ.maxPen) + ' mm' : '') + ').'});
    else W.push({c: 'warn', h: 'Teeth apart', t: 'Teeth apart: no upper-lower crown contact.'});
    const worst = Math.min(metrics.B_AP_change, metrics.PogT_AP_change), at = metrics.B_AP_change <= metrics.PogT_AP_change ? 'B' : 'Pog';
    if (worst < -0.05) {
      const mech = setbackMechanism();
      if (worst < -2) W.push({c: 'bad', h: 'Airway: ' + fmt(-worst) + ' mm back at ' + at + (mech.rotation ? ' (' + fmt(mech.rotCW) + '° clockwise rotation)' : ''), t: 'Airway: the mandible has moved back ' + fmt(-worst) + ' mm at ' + at + ' ' + mech.text + '. Limit 2 mm: this airway is already narrow, about 70 mm² at its minimum.' + (mech.rotation ? ' This is the planned, held jaw position, not mouth opening.' : '')});
      else W.push({c: 'warn', h: 'Mandible ' + fmt(-worst) + ' mm back', t: 'Mandible ' + fmt(-worst) + ' mm back at ' + at + ' ' + mech.text + '. Inside the 2 mm limit, but every millimetre back narrows the airway.'});
    }
    $('#warnBox').innerHTML = W.map(w => '<div class="w ' + w.c + '">' + esc(w.t) + '</div>').join('');
    $('#hudWarn').innerHTML = W.slice(0, 3).map(w => '<div class="chipw ' + w.c + '">' + esc(w.h) + '</div>').join('');
  }

  /* ================================================================== presets & plan builder */
  const PRESETS = [
    {id: 'expand', title: 'Bone-borne expansion', desc: 'The two maxilla halves and their teeth open in a V about a hinge high on each side (above the key ridge, near the orbital floor). Choose "parallel" for the simulator\'s model (pure widening).',
      ctl: {lab: 'at the molars', min: 0, max: 14, step: 0.5, def: 10, u: 'mm'}, sel: {lab: 'pattern', opts: [['V', 'V (hinged)'], ['parallel', 'parallel']], def: 'V'},
      apply: (b, v, s) => { b.plan.expansion.skeletal_mm = v; b.extras.expansion_pattern = s; }},
    {id: 'lfadv', title: 'Le Fort I advance', desc: 'Moves the maxilla, with its teeth, forward. The amount is measured at the upper incisor edge, as in the simulator.',
      ctl: {lab: 'advance', min: 0, max: 10, step: 0.5, def: 5, u: 'mm'}, apply: (b, v) => { b.plan.maxilla.adv_mm = v; }},
    {id: 'lfdown', title: 'Le Fort I downgraft', desc: 'Lowers the maxilla front and back. The lower teeth get in the way, so the mandible is propped open about the condyles.',
      ctl: {lab: 'down', min: 0, max: 6, step: 0.5, def: 3, u: 'mm'}, apply: (b, v) => { b.plan.maxilla.ant_vertical_mm = v; b.plan.maxilla.post_vertical_mm = v; if (b.plan.mandible.mode === 'autorotate') b.plan.mandible.mode = 'none'; }},
    {id: 'lfimp', title: 'Le Fort I impaction', desc: 'Raises the maxilla; the mandible autorotates closed (counter-clockwise) until the first tooth contact.',
      ctl: {lab: 'up', min: 0, max: 6, step: 0.5, def: 3, u: 'mm'}, apply: (b, v) => { b.plan.maxilla.ant_vertical_mm = -v; b.plan.maxilla.post_vertical_mm = -v; if (b.plan.mandible.mode === 'none') b.plan.mandible.mode = 'autorotate'; }},
    {id: 'bssoadv', title: 'BSSO advance', desc: 'Moves the tooth-bearing mandible (with the chin) forward, measured at the lower incisor edge, and seats it on the upper teeth; the rami stay. Seating at the 2 mm target overbite also rotates the segment, so B and Pog move by a different amount than the slider (the toast reports the net change).',
      ctl: {lab: 'advance at the lower incisor edge', min: 0, max: 10, step: 0.5, def: 5, u: 'mm'}, apply: (b, v) => { b.plan.mandible.mode = 'bsso'; b.plan.mandible.distal_ap_mm = v; }},
    {id: 'bssoback', title: 'BSSO setback', desc: 'Moves the tooth-bearing mandible back, measured at the lower incisor edge, and seats it on the upper teeth. Seating also rotates the mandible counter-clockwise to close this open bite to the 2 mm target overbite, so B and Pog move back much less than the slider, and Pog can even move forward (3 mm here: B about 0.8 mm back, Pog about 1 mm forward). The airway check (at most 2 mm back at B or Pog) trips from about 5 mm. The toast reports the net B and Pog change and the seat rotation.',
      ctl: {lab: 'setback at the lower incisor edge', min: 0, max: 10, step: 0.5, def: 5, u: 'mm'}, apply: (b, v) => { b.plan.mandible.mode = 'bsso'; b.plan.mandible.distal_ap_mm = -v; }},
    {id: 'genadv', title: 'Genioplasty advance', desc: 'Slides the chin segment forward. B point does not move; the true mandibular plane (FMA, IMPA) does not change.',
      ctl: {lab: 'advance', min: -6, max: 10, step: 0.5, def: 5, u: 'mm'}, apply: (b, v) => { b.plan.genioplasty.ap_mm = v; }},
    {id: 'genlen', title: 'Genioplasty lengthening', desc: 'Moves the chin down (a graft fills the gap): longer lower face, N–Me and ANS–Me go up.',
      ctl: {lab: 'down', min: -4, max: 8, step: 0.5, def: 4, u: 'mm'}, apply: (b, v) => { b.plan.genioplasty.vertical_mm = v; }},
    {id: 'auto', title: 'Mandibular autorotation', desc: 'Turns the whole mandible about the condylar hinge axis. + opens (clockwise: chin down and back), − closes.',
      ctl: {lab: 'hinge', min: -6, max: 12, step: 0.5, def: 3, u: '°'}, apply: (b, v) => { b.extras.hinge_deg = v; }},
    {id: 'u1', title: 'Upper incisors: upright or procline', desc: 'Rotates the four upper incisors to a target U1–FH (norm 111°, now 129°), edge height held. Uprighting removes the dental compensation of the Class III.',
      ctl: {lab: 'U1–FH', min: 95, max: 140, step: 0.5, def: 111, u: '°'}, sel: {lab: 'about', opts: [['cres', 'centre of resistance'], ['apex', 'apex']], def: 'cres'},
      apply: (b, v, s) => { const d = b.plan.decompensation; d.u1_fh_target_deg = v; d.u1_centre = s; d.u1_edge_vertical = 'hold'; d.u1_fh_target_is = 'final'; }},
    {id: 'l1', title: 'Lower incisors: upright or procline', desc: 'Rotates the four lower incisors to a target IMPA (now 91°), edge height held.',
      ctl: {lab: 'IMPA', min: 78, max: 108, step: 0.5, def: 95, u: '°'}, sel: {lab: 'about', opts: [['cres', 'centre of resistance'], ['apex', 'apex']], def: 'cres'},
      apply: (b, v, s) => { const d = b.plan.decompensation; d.l1_impa_target_deg = v; d.l1_centre = s; d.l1_edge_vertical = 'hold'; }},
    {id: 'ext', title: 'Incisor intrusion / extrusion', desc: 'Moves the four upper incisors along the vertical: + extrudes (edge down), − intrudes. Changes the overbite directly.',
      ctl: {lab: 'upper', min: -3, max: 4, step: 0.5, def: 1.5, u: 'mm'}, sel: {lab: 'arch', opts: [['upper', 'upper incisors'], ['lower', 'lower incisors (+ = up)']], def: 'upper'},
      apply: (b, v, s) => { if (s === 'lower') b.plan.decompensation.l1_extrusion_mm = v; else b.plan.decompensation.u1_extrusion_mm = v; }},
  ];
  function renderPresets() {
    let h = '<div class="preset featured"><h3>Load the agreed plan</h3><p>Expansion 10 mm, incisor decompensation, Le Fort I 6 mm forward / 2.5 mm down in front / 1 mm up at the back, BSSO seated by the occlusion, 4.5 mm genioplasty lengthening. The readout should then match the simulator\'s final numbers.</p><div class="ctl"><button type="button" class="primary" id="btnAgreed">Load agreed plan</button><button type="button" id="btnBaseline">Back to the scan (zero plan)</button></div></div>';
    for (const p of PRESETS) {
      h += '<div class="preset" data-p="' + p.id + '"><h3>' + esc(p.title) + '</h3><p>' + esc(p.desc) + '</p><div class="ctl">';
      if (p.ctl) h += '<label class="vh" for="ps_' + p.id + '">' + esc(p.title + ' ' + p.ctl.lab) + '</label><input type="range" id="ps_' + p.id + '" min="' + p.ctl.min + '" max="' + p.ctl.max + '" step="' + p.ctl.step + '" value="' + p.ctl.def + '"><output for="ps_' + p.id + '" id="po_' + p.id + '">' + p.ctl.lab + ' ' + p.ctl.def + ' ' + p.ctl.u + '</output>';
      if (p.sel) h += '<label class="vh" for="pq_' + p.id + '">' + esc(p.sel.lab) + '</label><select id="pq_' + p.id + '">' + p.sel.opts.map(o => '<option value="' + o[0] + '"' + (o[0] === p.sel.def ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select>';
      h += '<button type="button" data-apply="' + p.id + '" aria-label="Apply ' + esc(p.title) + '">Apply</button></div></div>';
    }
    $('#presets').innerHTML = h;
  }
  $('#presets').addEventListener('input', e => { const m = /^ps_(.*)$/.exec(e.target.id); if (m) { const p = PRESETS.find(x => x.id === m[1]); $('#po_' + p.id).textContent = p.ctl.lab + ' ' + e.target.value + ' ' + p.ctl.u; } });
  $('#presets').addEventListener('click', e => {
    if (e.target.id === 'btnAgreed') { loadAgreed(); return; }
    if (e.target.id === 'btnBaseline') { const snap = snapshot(); builder = {plan: deep(E.DEFAULT_PLAN), extras: deep(E.DEFAULT_EXTRAS)}; if (!applyPlan({msg: 'Back to the scan.', snap})) builder = snap.builder; return; }
    const id = e.target.dataset.apply; if (!id) return;
    const p = PRESETS.find(x => x.id === id); const v = p.ctl ? +$('#ps_' + id).value : 0, s = p.sel ? $('#pq_' + id).value : null;
    const snap = snapshot(); p.apply(builder, v, s);
    if (!applyPlan({msg: p.title + ' applied.', snap, bssoReport: id === 'bssoadv' || id === 'bssoback'})) { builder = deep(snap.builder); renderBuilder(); }
    if (activeMission) missionState.used.add(id);
  });
  function loadAgreed(opts) {
    opts = opts || {};
    const snap = snapshot();
    const ap = deep(D.agreed_plan); delete ap.name; delete ap.notes;
    builder = {plan: deep(E.DEFAULT_PLAN), extras: deep(E.DEFAULT_EXTRAS)};
    for (const [k, v] of Object.entries(ap)) if (builder.plan[k]) Object.assign(builder.plan[k], v);
    builder.extras.expansion_pattern = 'parallel';
    let msg = 'Agreed plan loaded (simulator model: parallel expansion).';
    if (activeMission && missionState && !missionState.done && !opts.quiet) {
      if (!missionState.solutionViewed) msg += ' Mission note: this is a worked solution, so this mission\'s score is now capped at ' + SOLUTION_CAP + '.';
      missionState.solutionViewed = true; renderMissions();
    }
    const r = applyPlan({msg, snap, instant: opts.instant});
    if (r) { pendingSimCheck = true; } else builder = snap.builder;
    return r;
  }
  const SOLUTION_CAP = 50;
  let pendingSimCheck = false;

  const BF = [
    ['Expansion'], ['expansion', 'skeletal_mm', 'Skeletal width gain at the molars (mm)', 'n'], ['extras', 'expansion_pattern', 'Pattern', ['V', 'parallel']],
    ['expansion', 'drop_mm', 'Maxilla drops, side effect (mm)', 'n'], ['expansion', 'forward_mm', 'Maxilla drifts forward (mm)', 'n'],
    ['Decompensation (orthodontics)'], ['decompensation', 'u1_fh_target_deg', 'U1–FH target (°, blank = leave)', 'nn'], ['decompensation', 'u1_fh_target_is', 'U1 target is', ['final', 'presurgical']],
    ['decompensation', 'u1_centre', 'U1 rotation centre', ['cres', 'apex']], ['decompensation', 'u1_edge_vertical', 'U1 edge height', ['hold', 'free']],
    ['decompensation', 'u1_extrusion_mm', 'U1 extrusion (mm, + = edge down)', 'n'], ['decompensation', 'l1_impa_target_deg', 'IMPA target (°, blank = leave)', 'nn'],
    ['decompensation', 'l1_centre', 'L1 rotation centre', ['cres', 'apex']], ['decompensation', 'l1_edge_vertical', 'L1 edge height', ['hold', 'free']],
    ['decompensation', 'l1_extrusion_mm', 'L1 extrusion (mm, + = edge up)', 'n'],
    ['Maxilla (Le Fort I)'], ['maxilla', 'adv_mm', 'Advance at the U1 edge (mm)', 'n'], ['maxilla', 'ant_vertical_mm', 'Front vertical at the U1 edge (mm, + = down)', 'n'],
    ['maxilla', 'post_vertical_mm', 'Back vertical at PNS (mm, + = down)', 'n'],
    ['Mandible'], ['mandible', 'mode', 'Mode', ['none', 'autorotate', 'bsso']], ['mandible', 'distal_ap_mm', 'BSSO front-back at the L1 edge (mm, blank = solve)', 'nn'],
    ['mandible', 'distal_pitch_deg', 'Extra distal pitch (°, + = clockwise)', 'n'], ['targets', 'overjet_mm', 'Target overjet (mm)', 'n'], ['targets', 'overbite_mm', 'Target overbite (mm)', 'n'],
    ['extras', 'hinge_deg', 'Extra hinge of the whole mandible (°, + opens)', 'n'],
    ['Genioplasty'], ['genioplasty', 'ap_mm', 'Advance (mm)', 'n'], ['genioplasty', 'vertical_mm', 'Lengthen (mm, + = down)', 'n'],
  ];
  function renderBuilder() {
    let h = '<p class="fine">Same fields and conventions as the simulator\'s plan JSON (README of sim.py). The two "extras" (pattern, extra hinge) are sandbox additions. Changing a field re-runs the plan.</p>';
    BF.forEach((f, i) => {
      if (f.length === 1) { h += '<div class="bsec">' + f[0] + '</div>'; return; }
      const [sec, key, lab, typ] = f; const src = sec === 'extras' ? builder.extras : builder.plan[sec]; const v = src[key];
      h += '<div class="bf"><label for="bf' + i + '">' + esc(lab) + '</label>';
      if (Array.isArray(typ)) h += '<select id="bf' + i + '" data-i="' + i + '">' + typ.map(o => '<option' + (o === v ? ' selected' : '') + '>' + o + '</option>').join('') + '</select>';
      else h += '<input id="bf' + i + '" data-i="' + i + '" type="number" step="0.5" value="' + (v == null ? '' : v) + '"' + (typ === 'nn' ? ' placeholder="blank"' : '') + '>';
      h += '</div>';
    });
    h += '<div class="row" style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap"><button type="button" id="btnBuilderApply" class="primary">Apply plan</button></div>';
    $('#builder').innerHTML = h;
  }
  $('#builder').addEventListener('change', e => {
    const i = e.target.dataset.i; if (i == null) return; const [sec, key, , typ] = BF[+i];
    const snap = snapshot();   // before the builder changes, so Undo restores plan and pose together
    const src = sec === 'extras' ? builder.extras : builder.plan[sec];
    if (Array.isArray(typ)) src[key] = e.target.value;
    else { const s = e.target.value.trim(); src[key] = s === '' ? (typ === 'nn' ? null : 0) : +s; }
    if (!applyPlan({snap})) { builder = deep(snap.builder); renderBuilder(); }
  });
  $('#builder').addEventListener('click', e => { if (e.target.id === 'btnBuilderApply') applyPlan(); });

  /* ================================================================== missions */
  const MISSIONS = window.MISSIONS || [];
  let activeMission = null, missionState = null;
  function ctx() { return {m: metrics, base: baseMetrics, occ, plan: builder.plan, extras: builder.extras, report: lastReport, explode}; }
  // goals are judged on the values the readout shows (one decimal), so "1.0 mm" never fails a "1 to 3 mm" goal
  const r1 = x => (typeof x === 'number' && isFinite(x)) ? +x.toFixed(1) : x;
  const round1 = o => { const q = {}; for (const k in o) q[k] = r1(o[k]); return q; };
  function goalCtx() { const c = ctx(); c.m = round1(metrics); c.base = baseMetrics ? round1(baseMetrics) : baseMetrics; return c; }
  function renderMissions() {
    const box = $('#missions');
    if (!activeMission) {
      box.innerHTML = '<p class="sub">Guided cases built on this skull. Goals are checked live from the readout. Hints cost 10 points each.</p>' +
        MISSIONS.map(m => { const best = store.get('best.' + m.id, null); return '<div class="mcard"><h3>' + esc(m.title) + '<span class="lvl">' + esc(m.level) + '</span></h3><p>' + esc(m.teaser) + '</p><div class="mrow"><button type="button" data-start="' + m.id + '" aria-label="Start mission: ' + esc(m.title) + '">Start</button>' +
          (best != null ? '<span class="sub" style="margin:4px 0 0">Best ' + best + ' / 100 <span class="stars" aria-label="' + stars(best) + ' stars">' + '★'.repeat(stars(best)) + '</span></span>' : '') + '</div></div>'; }).join('') +
        '<div class="mcard"><h3>Free play<span class="lvl">sandbox</span></h3><p>No goals: take the skull apart, try every preset, drag teeth around.</p><div class="mrow"><button type="button" id="btnFree">Free play</button></div></div>';
      $('#hudMission').hidden = true; return;
    }
    const m = activeMission, st = missionState;
    let h = '<div class="mact"><h3 style="font-family:IBM Plex Sans,sans-serif;font-size:.95rem">' + esc(m.title) + '</h3><p style="font-size:.82rem;margin:4px 0">' + m.brief + '</p>';
    h += '<ul class="goals" id="goalList">' + m.goals.map((g, i) => '<li data-g="' + i + '"><span class="mk" aria-hidden="true"></span><span>' + esc(g.text) + '</span><span class="gv"></span></li>').join('') + '</ul>';
    if (st.solutionViewed && !st.done) h += '<p class="fine" style="margin:4px 0"><b>Worked solution viewed</b> ("Load agreed plan"): this run scores at most ' + SOLUTION_CAP + '. Restart to play for full marks.</p>';
    if (st.hints.length) h += '<ol class="hints">' + st.hints.map(i => '<li>' + m.hints[i] + '</li>').join('') + '</ol>';
    if (!st.done) {
      h += '<div class="mrow">' + (st.hints.length < m.hints.length ? '<button type="button" id="btnHint">Hint (−10)</button>' : '') + '<button type="button" id="btnRestart">Restart</button><button type="button" id="btnQuit">Leave mission</button></div>';
      if (st.stage === 'quiz') h += quizHtml(m);
    } else {
      h += '<div class="explain"><div class="score">Score ' + st.score + ' / 100' + (st.solutionViewed ? ' <span class="sub">(worked solution viewed, capped at ' + SOLUTION_CAP + ')</span>' : '') + ' <span class="stars">' + '★'.repeat(stars(st.score)) + '</span></div>' + m.explain + '</div>' +
        '<div class="mrow"><button type="button" id="btnRestart">Play again</button><button type="button" id="btnQuit">Back to missions</button></div>';
    }
    h += '</div>'; box.innerHTML = h; updateMissionGoals(true);
  }
  function shuffled(n) { const a = [...Array(n).keys()]; for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  function quizHtml(m) {
    const q = m.quiz, st = missionState;
    if (!st.qorder || st.qorder.length !== q.options.length) st.qorder = shuffled(q.options.length);   // answer position is not predictable
    return '<form class="quiz" id="quizForm"><fieldset><legend>' + esc(q.q) + '</legend>' + st.qorder.map(i => '<label><input type="radio" name="qz" value="' + i + '"> <span>' + esc(q.options[i]) + '</span></label>').join('') +
      '</fieldset><div class="mrow"><button type="submit" class="primary">Check answer</button><span id="quizMsg" class="sub" aria-live="polite"></span></div></form>';
  }
  const stars = s => s >= 90 ? 3 : s >= 70 ? 2 : 1;
  function startMission(id) {
    const m = MISSIONS.find(x => x.id === id); if (!m) return;
    const snap = snapshot();
    activeMission = m; missionState = {hints: [], wrong: 0, done: false, stage: 'goals', okSince: 0, used: new Set(), solutionViewed: false, qorder: null};
    builder = {plan: deep(E.DEFAULT_PLAN), extras: deep(E.DEFAULT_EXTRAS)};
    if (m.start) { for (const [k, v] of Object.entries(m.start.plan || {})) Object.assign(builder.plan[k], v); Object.assign(builder.extras, m.start.extras || {}); }
    if (exploded) setExplode(false);
    applyPlan({msg: 'Mission: ' + m.title, quiet: true, snap});
    renderMissions(); showRight('tab-missions');
    $('#hudMission').hidden = false;
    if (m.view) setView(m.view);
  }
  function finishMission() {
    const st = missionState; st.done = true;
    st.score = Math.max(10, 100 - 10 * st.hints.length - 10 * st.wrong);
    if (st.solutionViewed) st.score = Math.min(st.score, SOLUTION_CAP);
    const best = store.get('best.' + activeMission.id, 0); if (st.score > best) store.set('best.' + activeMission.id, st.score);
    renderMissions(); toast('Mission complete: ' + st.score + ' / 100', 4000);
  }
  function updateMissionGoals(force) {
    if (!activeMission || !metrics) return;
    const m = activeMission, st = missionState, c = goalCtx();
    const res = m.goals.map(g => { try { return !!g.test(c); } catch (e) { return false; } });
    for (const li of $$('#goalList li')) { const i = +li.dataset.g; li.classList.toggle('ok', res[i]); $('.gv', li).textContent = m.goals[i].val ? m.goals[i].val(c) : ''; li.setAttribute('aria-label', m.goals[i].text + (res[i] ? ', done' : ', not yet')); }
    const hud = $('#hudMission');
    hud.innerHTML = '<div class="ht">' + esc(m.title) + (st.done ? ' · done' : '') + '</div><ul>' + m.goals.map((g, i) => '<li class="' + (res[i] ? 'ok' : '') + '">' + esc(g.short || g.text) + '</li>').join('') + '</ul>';
    if (st.done || st.stage === 'quiz') return;
    const all = res.every(Boolean) && !animating() && explode < 0.01;
    const now = performance.now();
    if (all) { if (!st.okSince) st.okSince = now; else if (now - st.okSince > 500) { if (m.quiz) { st.stage = 'quiz'; renderMissions(); toast('All goals met. One question to finish.'); } else finishMission(); } }
    else st.okSince = 0;
  }
  $('#missions').addEventListener('click', e => {
    const s = e.target.closest('[data-start]'); if (s) { startMission(s.dataset.start); return; }
    if (e.target.id === 'btnFree') { activeMission = null; renderMissions(); toast('Free play: no goals. Try Explode!'); return; }
    if (e.target.id === 'btnHint') { const st = missionState; if (st.hints.length < activeMission.hints.length) st.hints.push(st.hints.length); renderMissions(); return; }
    if (e.target.id === 'btnRestart') { startMission(activeMission.id); return; }
    if (e.target.id === 'btnQuit') { activeMission = null; renderMissions(); return; }
  });
  $('#missions').addEventListener('submit', e => {
    e.preventDefault(); const f = e.target; const v = f.querySelector('input[name=qz]:checked'); const msg = $('#quizMsg');
    if (!v) { msg.textContent = 'Pick an answer first.'; return; }
    if (+v.value === activeMission.quiz.answer) finishMission();
    else { missionState.wrong++; msg.textContent = 'Not quite (−10). ' + (activeMission.quiz.nudge || 'Look at the readout again.'); }
  });

  /* ================================================================== explode / re-seat / modes */
  function setExplode(on) {
    exploded = on; const from = explode, to = on ? 1 : 0;
    tween(1000, e => { explode = from + (to - from) * e; displayDirty = true; occPoints.visible = false; }, () => { explode = to; displayDirty = true; updateWarnings(); }, 'explode');
    const b = $('#btnExplode'); b.setAttribute('aria-pressed', on); b.textContent = on ? 'Collapse' : 'Explode';
  }
  $('#btnExplode').addEventListener('click', () => setExplode(!exploded));
  $('#btnReseat').addEventListener('click', () => {
    pushUndo(); if (exploded) setExplode(false);
    builder = {plan: deep(E.DEFAULT_PLAN), extras: deep(E.DEFAULT_EXTRAS)}; planPose = E.newPose(); handDirty = false;
    animatePoseTo(E.newPose(), 900); renderBuilder(); toast('Every piece re-seated at its anatomical home.');
  });
  function setDragMode(m) { dragMode = m; for (const b of $$('.toolbar [data-mode]')) b.setAttribute('aria-pressed', b.dataset.mode === m); updateStatus(); }
  $$('.toolbar [data-mode]').forEach(b => b.addEventListener('click', () => setDragMode(b.dataset.mode)));
  function setGroupMode(on) {
    groupMode = on; const b = $('#btnGroups'); b.setAttribute('aria-pressed', on); b.textContent = on ? 'Operation groups' : 'Single pieces';
    if (selected && MESH[selected]) select(routeOf(selected)); toast(on ? 'Operation groups: maxilla halves and upper teeth move as a Le Fort I segment, lower teeth and chin with the BSSO segment.' : 'Single pieces: each tooth, half and segment moves on its own.');
  }
  $('#btnGroups').addEventListener('click', () => setGroupMode(!groupMode));
  $('#chkLm').addEventListener('change', e => { showLm = e.target.checked; displayDirty = true; });
  $('#chkOcc').addEventListener('change', e => { showOcc = e.target.checked; });
  $('#chkGhost').addEventListener('change', e => {
    ghost = e.target.checked; const m = MAT.cranium; m.transparent = ghost; m.opacity = ghost ? 0.18 : 1; m.depthWrite = !ghost; m.needsUpdate = true;
    MESH.cranium.renderOrder = ghost ? 5 : 0;
  });

  /* ================================================================== export / import / about */
  function exportJSON() {
    const r = E.normalisePlan(builder.plan).P; delete r.adjuncts;
    const pieces = {};
    for (const id of E.ORDER) {
      if (E.poseIsHome(pose, id)) continue;
      const pv = E.NODES[id].pivots[pivotIdx[id] || 0]; const d = E.decompose(pose[id], pv.p);
      pieces[id] = {relative_to: E.NODES[id].parent || 'skull', pivot: pv.name, pivot_gl_mm: pv.p.map(x => +(+x).toFixed(2)),
        translate_mm: {lateral: +d.t[0].toFixed(2), vertical: +d.t[1].toFixed(2), anterior: +d.t[2].toFixed(2)},
        rotate_deg: {pitch_cw: +d.r[0].toFixed(2), roll_left_up: +d.r[1].toFixed(2), yaw_to_left: +d.r[2].toFixed(2)},
        matrix_local: pose[id].toArray().map(x => +x.toFixed(5))};
    }
    const keys = READ.filter(x => x.k).map(x => x.k); const ro = {}; for (const k of keys) ro[k] = +(+metrics[k]).toFixed(2);
    return JSON.stringify({format: 'skull-surgery-sandbox plan', version: '1.0',
      frame: 'GL mm: x = patient left, y = up (Frankfort normal), z = anterior; origin nasion. pitch_cw + = clockwise with the patient facing right (chin down and back).',
      sim_plan: r, sandbox_extras: builder.extras, hand_moves_on_top_of_plan: handMoved(), piece_transforms: pieces, readout: ro,
      checks: {teeth_overlap_mm: +occ.maxPen.toFixed(2), airway_worst_B_or_Pog_mm: +Math.min(metrics.B_AP_change, metrics.PogT_AP_change).toFixed(2)},
      note: 'sim_plan runs unchanged in simulator/sim.py (adjuncts and soft tissue are not modelled here). piece_transforms is the exact sandbox state, plan plus hand moves.'}, null, 1);
  }
  $('#btnExport').addEventListener('click', () => { $('#exportText').value = exportJSON(); $('#copyMsg').textContent = ''; $('#dlgExport').showModal(); });
  $('#btnCopy').addEventListener('click', async () => {
    const ta = $('#exportText'); ta.focus(); ta.select();
    let ok = false; try { await navigator.clipboard.writeText(ta.value); ok = true; } catch (e) { try { ok = document.execCommand('copy'); } catch (e2) { ok = false; } }
    $('#copyMsg').textContent = ok ? 'Copied.' : 'Select the text and copy it with Ctrl/Cmd+C.';
  });
  /* plan input: a sandbox export ({sim_plan, sandbox_extras, ...}) or a plain sim.py plan. Unknown sections or fields are refused,
     as sim.py refuses them (ValueError), so a typo such as "adv_mn" is reported instead of silently dropped. */
  const EXPORT_KEYS = ['format', 'version', 'frame', 'sim_plan', 'sandbox_extras', 'hand_moves_on_top_of_plan', 'piece_transforms', 'readout', 'checks', 'note'];
  const PLAN_META = ['name', 'notes', 'label', 'ratios'];
  function parsePlanInput(o) {
    const errs = [];
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {errs: ['the JSON must be an object']};
    const wrapped = 'sim_plan' in o;
    if (wrapped) for (const k of Object.keys(o)) if (!EXPORT_KEYS.includes(k)) errs.push('unknown top-level key "' + k + '"');
    const sp = wrapped ? o.sim_plan : o, ex = wrapped ? (o.sandbox_extras || {}) : (o.sandbox_extras || {});
    if (!sp || typeof sp !== 'object') return {errs: errs.concat('sim_plan must be an object')};
    const nb = {plan: deep(E.DEFAULT_PLAN), extras: deep(E.DEFAULT_EXTRAS)};
    for (const [k, v] of Object.entries(sp)) {
      if (PLAN_META.includes(k) || (!wrapped && k === 'sandbox_extras')) continue;
      if (!(k in E.DEFAULT_PLAN)) { errs.push('unknown section "' + k + '"'); continue; }
      if (!v || typeof v !== 'object' || Array.isArray(v)) { errs.push('section "' + k + '" must be an object'); continue; }
      for (const [kk, vv] of Object.entries(v)) {
        if (!(kk in E.DEFAULT_PLAN[k])) { errs.push('unknown field ' + k + '.' + kk); continue; }
        const d = E.DEFAULT_PLAN[k][kk];
        if (typeof d === 'number' && typeof vv !== 'number') { errs.push(k + '.' + kk + ' must be a number'); continue; }
        if (typeof d === 'string' && typeof vv !== 'string') { errs.push(k + '.' + kk + ' must be a string'); continue; }
        nb.plan[k][kk] = vv;
      }
    }
    for (const [k, v] of Object.entries(ex)) {
      if (!(k in E.DEFAULT_EXTRAS)) { errs.push('unknown sandbox_extras field "' + k + '"'); continue; }
      if (k === 'expansion_pattern' && !['V', 'parallel'].includes(v)) { errs.push('sandbox_extras.expansion_pattern must be "V" or "parallel"'); continue; }
      if (k === 'hinge_deg' && typeof v !== 'number') { errs.push('sandbox_extras.hinge_deg must be a number'); continue; }
      nb.extras[k] = v;
    }
    return {errs, builder: nb, hand: wrapped && o.hand_moves_on_top_of_plan && o.piece_transforms ? o.piece_transforms : null};
  }
  function importPlan(o, opts) {
    opts = opts || {};
    const r0 = parsePlanInput(o); if (r0.errs.length) return {ok: false, errors: r0.errs};
    const snap = snapshot(); builder = r0.builder;
    const r = applyPlan({msg: opts.msg || 'Plan imported.', snap, instant: opts.instant, quiet: opts.quiet});
    if (!r) { builder = snap.builder; renderBuilder(); return {ok: false, errors: ['the plan could not be applied (see the message)']}; }
    if (r0.hand) {
      const T = E.clonePose(r.pose); for (const [id, v] of Object.entries(r0.hand)) if (T[id] && v && Array.isArray(v.matrix_local) && v.matrix_local.length === 16) T[id].fromArray(v.matrix_local);
      if (opts.instant) setPoseNow(T); else animatePoseTo(T, 750); handDirty = true;
    }
    return {ok: true, report: r.report};
  }
  $('#btnImport').addEventListener('click', () => {
    let o; try { o = JSON.parse($('#exportText').value); } catch (e) { $('#copyMsg').textContent = 'That is not valid JSON.'; return; }
    const res = importPlan(o);
    if (!res.ok) { $('#copyMsg').textContent = 'Not imported: ' + res.errors.slice(0, 6).join('; ') + (res.errors.length > 6 ? '; and ' + (res.errors.length - 6) + ' more' : '') + '.'; return; }
    $('#dlgExport').close();
  });
  function renderAbout() {
    const sc = lastSimCheck;
    $('#aboutBody').innerHTML =
      '<p>A game-style sandbox for dental and surgical students, built from <b>one consented, de-identified head CBCT</b> (adult male, 22 years; no name, dates or record numbers are in any file). The subject agreed to open release for teaching.</p>' +
      '<h3>What it is, and is not</h3><ul><li><b>Bone surfaces and teeth only.</b> No skin, lips, muscles, nerves, vessels, cartilage, discs or airway soft tissue are modelled. Soft-tissue outcomes are out of scope.</li>' +
      '<li><b>Not for clinical planning.</b> It is a geometric teaching model. Osteotomies are idealised cuts; collisions are approximate; nothing here is a surgical prescription.</li>' +
      '<li>The landmarks are a provisional, log-replayed reconstruction of the original measurement (see the simulator README); the numbers teach geometry, not this person\'s treatment.</li></ul>' +
      '<h3>How the numbers are made</h3><ul><li>Each landmark rides on the piece it belongs to (A, ANS and PNS on the mean of the two maxilla halves). The readout projects them onto the midsagittal plane in the Frankfort frame and uses exactly the definitions of the project\'s movement simulator (sim.py).</li>' +
      '<li>Presets and "Load agreed plan" run a JavaScript port of the simulator\'s hard-tissue steps (decompensation, Le Fort I pitch about the incisor edge, mandible propping, autorotation and BSSO seating on the occlusion, genioplasty).</li>' +
      '<li>Simulator agreement test on this page: ' + (sc ? sc.cases + ' reference plans × ' + sc.metrics + ' metrics, largest difference ' + sc.worst.toFixed(3) + ' (' + esc(sc.worstAt) + ')' : 'not run yet') + '.</li>' +
      '<li>The V-shaped expansion hinge (high on each side, near the orbital floor above the key ridge) is a modelling assumption. The simulator itself models expansion as a parallel widening; the agreed plan uses that.</li>' +
      '<li>Occlusion: each tooth is voxelised once at load (0.5 mm grid, flood-filled solid, signed distance to its surface). About 520 crown samples per tooth are moved into each nearby opposing tooth\'s frame and looked up there, so the true overlap depth is known. Green dots are contacts, red dots are crown samples inside an opposing tooth. Amber above 0.6 mm, red ("Teeth collide") above 2 mm or when more than 10 % of the samples are inside. The scan was taken in occlusion, so the start position already shows contacts.</li></ul>' +
      '<h3>Segmentation limits</h3><ul><li>28 teeth (11–17, 21–27, 31–37, 41–47; no third molars), each one connected crown + root.</li>' +
      '<li>Apices can be 1–2 mm short; small remnants of cortical bone remain at the distal root of 36 and buccally at 46/47.</li>' +
      '<li>Tooth volumes are 1.4–2.1× textbook values (CBCT partial-volume rim): do not teach tooth volumes from them.</li>' +
      '<li>The analysis L1 apex sits on the neighbouring incisor (4.4 mm from the 31 apex); it is kept so the readout reproduces the simulator.</li>' +
      '<li>Condyle-to-fossa clearance is about 1 mm in the meshes (measured joint space about 2 mm). The lingula is estimated, not detected. The cranium is decimated to 100 000 triangles.</li></ul>' +
      '<h3>Controls</h3><ul><li>Drag empty space: orbit. Right-drag or Ctrl-drag or two fingers: pan. Wheel or pinch: zoom.</li><li>Drag a piece: move it in the screen plane. Shift-drag (or Rotate mode): rotate about its pivot.</li>' +
      '<li>Keys on the 3-D view: arrows move the selection (Up/Down vertical, Left/Right front-back), PgUp/PgDn lateral; with Shift they rotate. Alt = fine steps. E explode, G groups, M/R/O drag mode, H hide, L lock, Esc deselect, Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo, 1–5 camera views.</li></ul>' +
      '<h3>Debug API (read-only)</h3><p>For tests and checkers, <code>window.SANDBOX</code> offers <code>metrics()</code>, <code>landmarks()</code> (each as <code>{lat, ant, sup}</code> in mm, the sim.py order, origin nasion; bilateral names such as Co, Go, J and UMol are averaged), <code>plan()</code>, <code>occlusion()</code>, <code>loadAgreed()</code> and <code>applyPlan(plan, {instant: true})</code>, which takes a sim.py plan or an export from this page, refuses unknown fields as sim.py does, and skips the animation. It does not change anything else on the page.</p>' +
      '<h3>Licence</h3><p>Code: MIT. Data (meshes, landmarks): CC BY 4.0. Built with three.js r128.</p>';
  }
  $('#btnAbout').addEventListener('click', () => { renderAbout(); $('#dlgAbout').showModal(); });

  /* ================================================================== pointer interaction */
  const pointers = new Map(); let drag = null, hoverXY = null, hoverQueued = false;
  const ray = new THREE.Raycaster();
  function local(e) { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function ndc(x, y) { return new THREE.Vector2(x / canvas.clientWidth * 2 - 1, -(y / canvas.clientHeight) * 2 + 1); }
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  const kbRing = () => { let v = false; try { v = canvas.matches(':focus-visible'); } catch (e) { v = false; } stage.classList.toggle('kbfocus', v); };
  canvas.addEventListener('focus', kbRing); canvas.addEventListener('blur', () => stage.classList.remove('kbfocus'));
  canvas.addEventListener('pointerdown', e => {
    if (!pose) return;
    canvas.focus({preventScroll: true});
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const [x, y] = local(e); pointers.set(e.pointerId, {x, y});
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      drag = {kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, started: true}; return;
    }
    if (pointers.size > 2) return;
    const hit = pickAt(x, y), route = hit ? routeOf(hit) : null;
    let kind = 'orbit';
    if (e.button === 2 || e.button === 1 || (e.button === 0 && (e.ctrlKey || e.metaKey))) kind = 'pan';
    else if (route && dragMode !== 'orbit' && movable(route) && explode < 0.01) kind = (dragMode === 'rotate' || e.shiftKey || e.altKey) ? 'rotate' : 'move';
    drag = {kind, id: route, hit, x0: x, y0: y, lx: x, ly: y, started: false};
  });
  canvas.addEventListener('pointermove', e => {
    const [x, y] = local(e);
    if (!drag) { hoverXY = [x, y]; hoverQueued = true; return; }
    const pt = pointers.get(e.pointerId); if (pt) { pt.x = x; pt.y = y; }
    if (drag.kind === 'pinch') {
      if (pointers.size < 2) return; const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      if (drag.d > 0) orbit.zoom(drag.d / Math.max(d, 1)); orbit.pan(cx - drag.cx, cy - drag.cy);
      drag.d = d; drag.cx = cx; drag.cy = cy; return;
    }
    if (!drag.started) {
      if (Math.hypot(x - drag.x0, y - drag.y0) < 4) return;
      drag.started = true; canvas.classList.add('dragging');
      if (drag.kind === 'move' || drag.kind === 'rotate') beginPieceDrag(drag);
    }
    const dx = x - drag.lx, dy = y - drag.ly; drag.lx = x; drag.ly = y;
    if (drag.kind === 'orbit' || drag.kind === 'pan') userMovedCam = true;
    if (drag.kind === 'orbit') orbit.rotate(dx, dy);
    else if (drag.kind === 'pan') orbit.pan(dx, dy);
    else if (drag.kind === 'move') pieceMove(x, y);
    else if (drag.kind === 'rotate') pieceRotate(x, y);
  });
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (!drag) return;
    if (drag.kind === 'pinch') { if (pointers.size === 0) drag = null; return; }
    if (!drag.started && e.type === 'pointerup') {
      const r = drag.hit ? routeOf(drag.hit) : null;
      if (r) select(r); else select(null);
    }
    if (drag.started && (drag.kind === 'move' || drag.kind === 'rotate')) { handDirty = true; metricsDirty = occDirty = true; if (activeMission) missionState.used.add('hand'); }
    drag = null; canvas.classList.remove('dragging');
  }
  canvas.addEventListener('pointerup', endPointer); canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => { if (!drag) { hoverXY = null; hoverQueued = true; } });
  canvas.addEventListener('wheel', e => { e.preventDefault(); userMovedCam = true; orbit.zoom(Math.exp(clamp(e.deltaY, -200, 200) * 0.0012)); }, {passive: false});

  function beginPieceDrag(d) {
    pushUndo(); if (selected !== d.id) select(d.id);
    const id = d.id, n = E.NODES[id];
    d.W0 = E.worldOf(pose, id); d.L0 = pose[id].clone();
    d.PW = n.parent ? E.worldOf(pose, n.parent) : new THREE.Matrix4(); d.PWi = d.PW.clone().invert();
    d.PR = new THREE.Matrix4().extractRotation(d.PW); d.PRi = d.PR.clone().transpose();
    const pv = new THREE.Vector3(...curPivot(id)).applyMatrix4(d.W0); d.P = pv;
    const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
    d.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir, pv);
    ray.setFromCamera(ndc(d.x0, d.y0), camera); d.h0 = new THREE.Vector3(); if (!ray.ray.intersectPlane(d.plane, d.h0)) d.h0.copy(pv);
    d.up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize(); d.right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  }
  function pieceMove(x, y) {
    const d = drag; ray.setFromCamera(ndc(x, y), camera); const h = new THREE.Vector3();
    if (!ray.ray.intersectPlane(d.plane, h)) return;
    const w = h.sub(d.h0).applyMatrix4(d.PRi);
    pose[d.id].copy(new THREE.Matrix4().makeTranslation(w.x, w.y, w.z).multiply(d.L0)); markPose();
  }
  function pieceRotate(x, y) {
    const d = drag; const ax = (x - d.x0) * 0.45 * DEG, ay = (y - d.y0) * 0.45 * DEG;
    const Q = new THREE.Matrix4().makeRotationAxis(d.up, ax).multiply(new THREE.Matrix4().makeRotationAxis(d.right, ay));
    const T = new THREE.Matrix4().makeTranslation(d.P.x, d.P.y, d.P.z).multiply(Q).multiply(new THREE.Matrix4().makeTranslation(-d.P.x, -d.P.y, -d.P.z));
    pose[d.id].copy(d.PWi.clone().multiply(T).multiply(d.W0)); markPose();
  }
  function doHover() {
    hoverQueued = false; if (drag) return;
    const id = hoverXY ? pickAt(hoverXY[0], hoverXY[1]) : null;
    if (id !== hoverPiece) { hoverPiece = id; refreshHighlight(); }
    canvas.classList.toggle('over', !!id && dragMode !== 'orbit' && movable(routeOf(id)));
    canvas.title = id ? E.NODES[routeOf(id)].short + (routeOf(id) !== id ? ' (via ' + E.NODES[id].short + ')' : '') : '';
  }

  /* ================================================================== keyboard */
  function nudge(kind, idx, amt) {
    if (!selected || !movable(selected)) { toast(selected ? 'This piece is ' + (E.NODES[selected].fixed ? 'the fixed reference.' : 'locked.') : 'Select a piece first.'); return; }
    if (performance.now() - lastPushT > 900) pushUndo(); else lastPushT = performance.now();
    handDirty = true; const p = E.decompose(pose[selected], curPivot(selected)); const lim = kind === 't' ? 30 : 45; p[kind][idx] = clamp(p[kind][idx] + amt, -lim, lim);
    pose[selected].copy(E.compose(p, curPivot(selected))); markPose();
  }
  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase(); const inField = tag === 'input' || tag === 'textarea' || tag === 'select';
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) { if (inField && tag !== 'input') return; e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
    if (inField || mod || $('dialog[open]')) return;
    const onCanvas = document.activeElement === canvas;
    const step = e.altKey ? 0.1 : 0.5, rstep = e.altKey ? 0.2 : 1;
    if (onCanvas && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(e.key)) {
      e.preventDefault();
      const s = e.shiftKey;
      if (e.key === 'ArrowUp') nudge(s ? 'r' : 't', s ? 0 : 1, s ? -rstep : step);
      if (e.key === 'ArrowDown') nudge(s ? 'r' : 't', s ? 0 : 1, s ? rstep : -step);
      if (e.key === 'ArrowRight') nudge(s ? 'r' : 't', s ? 2 : 2, s ? rstep : step);
      if (e.key === 'ArrowLeft') nudge(s ? 'r' : 't', s ? 2 : 2, s ? -rstep : -step);
      if (e.key === 'PageUp') nudge(s ? 'r' : 't', s ? 1 : 0, s ? rstep : step);
      if (e.key === 'PageDown') nudge(s ? 'r' : 't', s ? 1 : 0, s ? -rstep : -step);
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 'e') setExplode(!exploded);
    else if (k === 'g') setGroupMode(!groupMode);
    else if (k === 'm') setDragMode('move'); else if (k === 'r') setDragMode('rotate'); else if (k === 'o') setDragMode('orbit');
    else if (k === 'escape') select(null);
    else if (k === 'h' && selected) { const pcs = descPieces(selected); const anyVis = pcs.some(p => !hidden.has(p)); pcs.forEach(p => { if (anyVis) hidden.add(p); else hidden.delete(p); MESH[p].visible = !hidden.has(p); }); occDirty = true; renderPieceSel(); }
    else if (k === 'l' && selected && !E.NODES[selected].fixed) { if (locked.has(selected)) locked.delete(selected); else locked.add(selected); renderPieceSel(); renderInspector(); updateStatus(); }
    else if ('12345'.includes(k) && onCanvas) setView(['front', 'right', 'left', 'below', 'home'][+k - 1]);
  });

  /* ================================================================== resize + loop */
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    if (!userMovedCam) orbit.radius = VIEWS.home.radius * fitK();
  }
  if (window.ResizeObserver) new ResizeObserver(resize).observe(stage); else window.addEventListener('resize', resize);
  let fpsN = 0, fpsT = performance.now(), fps = 60, lastOcc = 0;
  let lastFrame = 0;
  function tick(now, render) {
    stepTweens(now);
    orbit.update();
    if (displayDirty) { updateDisplay(); displayDirty = false; }
    if (metricsDirty) {
      const S = new E.State(pose); metrics = E.measure(S); metricsDirty = false;
      updateReadout(); updateInspectorValues(); updateWarnings(); updateMissionGoals();
      if (pendingSimCheck && !animating()) { pendingSimCheck = false; agreedCheck(); }
    } else if (activeMission && missionState && missionState.okSince) updateMissionGoals();
    if (occDirty && now - lastOcc > (animating() ? 220 : 60)) { computeOcclusion(); lastOcc = now; occDirty = animating() ? true : false; updateMissionGoals(); }
    if (!render) return;
    occPoints.visible = showOcc && explode < 0.01;
    if (hoverQueued) doHover();
    renderer.render(scene, camera);
    updateOverlays();
  }
  function loop(now) {
    requestAnimationFrame(loop);
    lastFrame = performance.now();
    tick(now, true);
    fpsN++; if (now - fpsT > 1000) { fps = fpsN * 1000 / (now - fpsT); fpsN = 0; fpsT = now; window.__sandboxFps = fps; }
  }
  // background tabs pause animation frames: keep the readout, the bite check and the mission goals current with a slow logic tick
  setInterval(() => { const t = performance.now(); if (pose && t - lastFrame > 400) tick(t, false); }, 500);
  function agreedCheck() {
    const keys = D.hard_keys.filter(k => k in metrics); let worst = 0, at = '';
    for (const k of keys) { const d = Math.abs(metrics[k] - D.sim_final[k]); if (d > worst) { worst = d; at = k; } }
    $('#simCheck').innerHTML = 'Agreed plan vs the simulator\'s final_metrics.json: ' + keys.length + ' hard-tissue metrics, largest difference <b>' + worst.toFixed(3) + '</b> (' + esc(at) + ').';
    window.__agreedCheck = {keys: keys.length, worst, at};
  }

  /* ================================================================== start */
  async function start() {
    try {
      let done = 0; const total = FILES.reduce((a, b) => a + b.mb, 0);
      for (const F of FILES) { setProgress(0.04 + 0.7 * done / total, 'Downloading ' + F.label + ' (' + F.mb.toFixed(1) + ' MB)…'); await loadScript(F.f); done += F.mb; }
      PIECES = window.PIECES; const ids = Object.keys(PIECES);
      for (let i = 0; i < ids.length; i++) {
        const P = PIECES[ids[i]]; setProgress(0.74 + 0.16 * i / ids.length, 'Decoding ' + P.label + '…');
        P.geom = geomOf(P); if (i % 2 === 1) await nextFrame();
      }
      setProgress(0.9, 'Building the scene…'); await nextFrame();
      const teeth = E.buildGraph(PIECES);
      pose = E.newPose(); planPose = E.newPose();
      buildScene(teeth);
      const t0 = performance.now();
      for (let i = 0; i < teeth.length; i += 4) {
        setProgress(0.91 + 0.08 * i / teeth.length, 'Building tooth collision grids (' + i + ' / ' + teeth.length + ')…'); await nextFrame();
        prepOcclusion(teeth.slice(i, i + 4));
      }
      window.__gridMs = performance.now() - t0;
      baseMetrics = E.measure(new E.State(E.newPose()));
      renderPieces(); renderReadout(); renderPresets(); renderBuilder(); renderMissions(); renderInspector(); updateStatus();
      resize(); markPose();
      setProgress(1, 'Ready'); $('#loader').classList.add('done'); $('#loader').setAttribute('aria-hidden', 'true');
      requestAnimationFrame(loop);
      setTimeout(() => {
        lastSimCheck = E.selftest(); window.__selftest = lastSimCheck;
        $('#simCheck').innerHTML = 'Simulator agreement (run on load): ' + lastSimCheck.cases + ' reference plans × ' + lastSimCheck.metrics + ' metrics, largest difference ' + lastSimCheck.worst.toFixed(3) + '. At zero movement the readout equals the simulator baseline.';
      }, 300);
      window.__sandbox = {E, get pose() { return pose; }, get metrics() { return metrics; }, get occ() { return occ; }, get builder() { return builder; }, applyPlan, startMission, select, setExplode, pickAt, setView, loadAgreed,
        setBuilder(b) { builder = b; }, get busy() { return animating() || tweens.length > 0; }, computeOcclusion, routeOf, get mission() { return missionState; }};
      /* Read-only debug / test API (documented in About). Landmarks are in sim.py order {lat, ant, sup} (mm, origin nasion,
         lat + = patient left, ant + = forward, sup + = up in the Frankfort frame); bilateral names (Co, Go, J, UMol, ...) are averaged. */
      // bring readout, warnings, occlusion and mission goals up to date now (the API must not wait for a throttled animation frame)
      const refreshNow = () => { updateDisplay(); metrics = E.measure(new E.State(pose)); metricsDirty = false; updateReadout(); updateInspectorValues(true); computeOcclusion(); occDirty = false; updateMissionGoals(); };
      const lmNames = Object.keys(E.LM0).concat(Object.keys(E.BILATERAL));
      window.SANDBOX = Object.freeze({
        version: '1.1',
        metrics() { return Object.assign({}, E.measure(new E.State(E.clonePose(pose)))); },
        landmarks() { const S = new E.State(E.clonePose(pose)), o = {}; for (const k of lmNames) { const v = S.p3(k); o[k] = {lat: +v[0].toFixed(3), ant: +v[2].toFixed(3), sup: +v[1].toFixed(3)}; } return o; },
        plan() { const P = E.normalisePlan(builder.plan).P; delete P.adjuncts; return {sim_plan: P, sandbox_extras: deep(builder.extras), hand_moves_on_top_of_plan: handMoved()}; },
        applyPlan(plan, opts) { opts = Object.assign({instant: true}, opts || {}); const r = importPlan(deep(plan), {instant: opts.instant, quiet: true, msg: 'Plan applied (API).'});
          if (r.ok && opts.instant) refreshNow(); return r.ok ? {ok: true, metrics: this.metrics(), report: r.report} : r; },
        loadAgreed(opts) { opts = Object.assign({instant: true}, opts || {}); const r = loadAgreed({instant: opts.instant, quiet: true}); if (r && opts.instant) refreshNow(); return r ? {ok: true, metrics: this.metrics()} : {ok: false}; },
        occlusion() { computeOcclusion(); return Object.assign({}, occ); },
        get busy() { return animating(); },
      });
    } catch (err) {
      setProgress(0, 'Loading failed: ' + err.message + '. The pieces_*.js files must sit next to index.html.');
      console.warn(err);
    }
  }
  start();
})();
