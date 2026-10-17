/* Skull Surgery Sandbox - missions.js (MIT licence)
   Guided cases. Each goal is tested live against ctx = {m: metrics, base: start metrics, occ: {maxPen, contacts, pen}, plan, extras}.
   Metric keys are the sim.py names (see engine.js measure()). */
(function () {
  'use strict';
  const f1 = x => (x == null || !isFinite(x)) ? '–' : (Math.abs(x) < 0.05 ? 0 : x).toFixed(1).replace('-', '−');
  const s1 = x => (x == null || !isFinite(x)) ? '–' : (x > 0.04 ? '+' : '') + f1(x);
  const back = c => Math.min(c.m.B_AP_change, c.m.PogT_AP_change);
  // same red rule as the "Teeth collide" warning (app.js computeOcclusion): deeper than 2 mm or more than 10 % of the crown samples inside
  const noOverlap = {text: 'No gross tooth collision (overlap ≤ 2 mm, under 10 % of crown samples inside)', short: 'no collision', test: c => !c.occ.red, val: c => f1(c.occ.maxPen) + ' mm'};

  window.MISSIONS = [
    {
      id: 'class3', level: 'core · 3 to 6 moves', view: 'right',
      title: 'Correct the Class III, spare the airway',
      teaser: 'ANB is −6.3°, the incisors are edge to edge. Fix the bite without pushing the mandible back more than 2 mm.',
      brief: 'This skull is a skeletal Class III: the maxilla is behind (SNA 79°) and the mandible ahead (SNB 86°). The airway is narrow, so the mandible may move back <b>at most 2 mm</b> at B point or pogonion. Reach a normal jaw relation and a working bite.',
      goals: [
        {text: 'ANB between 0° and 4°', short: 'ANB 0–4°', test: c => c.m.ANB >= 0 && c.m.ANB <= 4, val: c => f1(c.m.ANB) + '°'},
        {text: 'Overjet 2 to 4 mm', short: 'overjet 2–4', test: c => c.m.overjet >= 2 && c.m.overjet <= 4, val: c => f1(c.m.overjet) + ' mm'},
        {text: 'Overbite 1 to 3 mm', short: 'overbite 1–3', test: c => c.m.overbite >= 1 && c.m.overbite <= 3, val: c => f1(c.m.overbite) + ' mm'},
        {text: 'B and bony Pog no more than 2 mm back', short: 'setback ≤ 2', test: c => back(c) >= -2, val: c => s1(back(c)) + ' mm'},
        noOverlap,
      ],
      hints: [
        'ANB = SNA − SNB. Raising SNA (Le Fort I advance) closes the gap without pushing the mandible back. But try a Le Fort I advance alone first: the overbite stays negative.',
        '<b>Decompensate first.</b> The upper incisors lean 18° forward to hide the Class III. Use "Upper incisors: upright or procline" (target about 113°). Then Le Fort I advance about 6 mm and, in "All plan fields", Mandible mode <i>bsso</i> with the front-back field blank: the lower teeth are seated at the target overjet and overbite.',
        '"Teeth collide"? Look from <b>Below</b>: the maxilla is 5.5 mm narrower than the mandible, and advancing it brings its narrow back end over the wide lower molars, so the cusps land on each other. Apply <b>Bone-borne expansion</b> 10 mm with the <i>parallel</i> pattern first (the V pattern also drops the front of the maxilla about 2 mm, which swings the chin back), then redo the jaws.',
        'Seating the BSSO at a 2 mm overbite rotates the mandible counter-clockwise, which raises SNB. Pitch the maxilla clockwise instead (front down 2.5 mm, back up 1 mm), and procline the lower incisors to IMPA 95°. "Load agreed plan" is one complete answer, but viewing it caps the score at 50.',
      ],
      explain: '<p><b>Why it works.</b> In a Class III with a narrow airway the correction comes from the maxilla: every millimetre of Le Fort I advance raises SNA and overjet, while a BSSO only has to seat the lower teeth onto the new upper arch. Setting the mandible back would also close ANB, but it pushes the tongue base toward the airway, so it is capped at 2 mm here.</p><p>Note how the Le Fort I pitch matters: the advance is prescribed at the incisor edge, so a clockwise pitch moves A point further forward than the edge.</p><p><b>Width before length.</b> The maxilla here is 5.5 mm narrower than the mandible. Advancing it without expansion seats the incisors but lands the upper molar cusps on the lower ones (the occlusion check turns red). That is why the agreed plan starts with a 10 mm expansion.</p>',
    },
    {
      id: 'expand', level: 'core · 1 move + question', view: 'front',
      title: 'Expand the maxilla 10 mm and watch the bite',
      teaser: 'The maxilla is 5.5 mm narrower than the mandible. Open it 10 mm at the molars with a bone-borne expander.',
      brief: 'Penn analysis wants the maxilla 5 mm <i>wider</i> than the mandible; here it is 5.5 mm narrower. Use <b>Bone-borne expansion</b> (V pattern) to gain 10 mm between the upper first molars, then look at the front view, the J–J and intermolar rows and the bite.',
      goals: [
        {text: 'Intermolar width +9.5 to +10.5 mm', short: 'molars +10', test: c => c.m.intermolar_width_change >= 9.5 && c.m.intermolar_width_change <= 10.5, val: c => s1(c.m.intermolar_width_change) + ' mm'},
        {text: 'Expanded with the V (hinged) pattern', short: 'V pattern', test: c => c.extras.expansion_pattern === 'V' && c.plan.expansion.skeletal_mm > 0, val: c => c.extras.expansion_pattern},
        {text: 'Compare: basal (J–J) gain is less than the molar gain', short: 'J–J < molars', test: c => c.m.basal_width_change_JJ < c.m.intermolar_width_change - 1, val: c => s1(c.m.basal_width_change_JJ) + ' mm'},
      ],
      hints: [
        'Presets &amp; plan → <b>Bone-borne expansion</b>: keep the slider at 10 mm and the pattern at V, then Apply.',
        'Use the <b>Front</b> camera view. Each half turns about a hinge high on its side, so the teeth swing out more than the bone higher up.',
      ],
      quiz: {
        q: 'With the V pattern the molars gained 10 mm but the basal bone (J–J) gained much less, and the midline of the maxilla came down. What does that mean for the bite?',
        options: [
          'Nothing changes: expansion is purely sideways.',
          'Each half tips like a door: the palate and the front of the maxilla come down, the upper incisors drop onto the lower ones and prop the mandible slightly open (clockwise), so the face gets longer.',
          'The mandible moves forward because the maxilla is wider.',
          'The maxilla moves up, so the overbite deepens.',
        ],
        answer: 1,
        nudge: 'Check the readout: what happened to the overbite, FMA and N–Me?',
      },
      explain: '<p><b>The V.</b> A hinge high on each side turns each maxilla half like a door: the further a point is below the hinge, the more it moves sideways. Here the molars gain 10 mm but the basal bone at J only about 5 mm, and the front of the maxilla (PNS, A, the incisors) comes down about 2 mm.</p><p>The lowered upper incisors now overlap the lower ones (overbite goes from −0.6 to about +0.5 mm) and touch them, so the mandible is propped open a little about the condyles: clockwise, FMA and N–Me go up. In a real patient the teeth also tip buccally on their own, which drops the palatal cusps further. That is why expansion comes before the jaw surgery, and why the agreed plan budgets a 1 mm "drop" side effect. The simulator itself models expansion as a parallel widening.</p>',
    },
    {
      id: 'openbite', level: 'intermediate · 2 to 4 moves', view: 'right',
      title: 'Close the anterior open bite',
      teaser: 'Someone downgrafted the back of the maxilla 3 mm. The molars now prop the jaw open. Close the bite.',
      brief: 'Starting point: the posterior maxilla was lowered 3 mm (a Le Fort I with <i>post_vertical</i> +3). The upper molars hit first, the mandible hinges open, and the incisors no longer meet: an <b>anterior open bite</b>. Close it without moving the mandible back.',
      start: {plan: {maxilla: {post_vertical_mm: 3}}},
      goals: [
        {text: 'Overbite 1 to 3 mm', short: 'overbite 1–3', test: c => c.m.overbite >= 1 && c.m.overbite <= 3, val: c => f1(c.m.overbite) + ' mm'},
        {text: 'Overjet at least +1 mm', short: 'overjet ≥ 1', test: c => c.m.overjet >= 1, val: c => f1(c.m.overjet) + ' mm'},
        {text: 'Back of the maxilla not lower than in the scan (PNS within 0.5 mm)', short: 'PNS not down', test: c => c.m.PNS_vertical_change >= -0.5, val: c => s1(c.m.PNS_vertical_change) + ' mm'},
        {text: 'B and bony Pog no more than 2 mm back', short: 'setback ≤ 2', test: c => back(c) >= -2, val: c => s1(back(c)) + ' mm'},
        noOverlap,
      ],
      hints: [
        'An open bite caused by the back teeth is closed by taking the back of the maxilla <b>up</b>, not by pulling the front down. In "All plan fields" make <i>Back vertical at PNS</i> negative (impaction).',
        'Set Mandible mode to <b>autorotate</b>: the mandible then closes counter-clockwise about the condyles until the first tooth contact, which also brings the chin forward.',
        'Autorotating forward reduces the overjet. Give it back with about 3 mm of <b>Le Fort I advance</b>. Autorotation stops when the premolars touch, so finish the overbite with 1 to 1.5 mm of <b>upper incisor extrusion</b> (Incisor intrusion / extrusion preset).',
      ],
      explain: '<p><b>Posterior impaction + autorotation</b> is the classic skeletal open-bite fix: lifting the back of the maxilla lets the mandible swing closed about the condyles, shortening the face and closing the bite in front. Because the chin comes forward on that arc, the overjet shrinks, so a Class III face usually needs some maxillary advance as well.</p>',
    },
    {
      id: 'incisors', level: 'core · 1 move + question', view: 'right',
      title: 'Upright the flared incisors and explain the reverse overjet',
      teaser: 'U1–FH is 129°: the upper incisors lean forward to hide the Class III. Upright them to normal.',
      brief: 'In a Class III the upper incisors often <b>procline</b> and the lower ones retrocline, so the teeth meet even though the jaws do not. Here U1–FH is 129° (norm 111 ± 6). Upright the upper incisors to the normal range and watch the overjet.',
      goals: [
        {text: 'U1–FH between 108° and 114°', short: 'U1–FH 108–114', test: c => c.m.U1_FH >= 108 && c.m.U1_FH <= 114, val: c => f1(c.m.U1_FH) + '°'},
        {text: 'Jaws untouched (no Le Fort I, BSSO or genioplasty)', short: 'jaws untouched', test: c => !c.plan.maxilla.adv_mm && !c.plan.maxilla.ant_vertical_mm && !c.plan.maxilla.post_vertical_mm && c.plan.mandible.mode === 'none' && !c.plan.genioplasty.ap_mm && !c.plan.genioplasty.vertical_mm, val: () => ''},
      ],
      hints: [
        'Presets &amp; plan → <b>Upper incisors: upright or procline</b>, target 111°, Apply.',
        'You can also do it by hand: turn off Operation groups, select tooth 11 and change its Pitch. The preset is more exact because it holds the edge height.',
      ],
      quiz: {
        q: 'After uprighting, the overjet went from about +0.6 mm to a clearly negative value. Why?',
        options: [
          'The upright incisors are shorter.',
          'Uprighting removed the dental compensation: the incisors now show the true skeletal Class III, so the lower teeth sit in front. Surgery then corrects the jaws.',
          'The mandible moved forward during the uprighting.',
          'It is a rounding error of the readout.',
        ],
        answer: 1,
        nudge: 'Did the mandible move? Look at SNB and B point in the readout.',
      },
      explain: '<p><b>Decompensation.</b> Before orthognathic surgery the orthodontist removes the dental camouflage: the upper incisors are uprighted, the lower ones proclined. The reverse overjet gets <i>worse</i> on purpose, because it now shows the real jaw discrepancy, and the surgeon can move the jaws by the full amount. Uprighting by about 18° about the centre of resistance moves the incisal edge back several millimetres, which needs arch space (extractions or distalisation; not simulated).</p>',
    },
    {
      id: 'shortface', level: 'advanced · 2 to 4 moves', view: 'right',
      title: 'Lengthen the short face without swinging the chin back',
      teaser: 'N–Me is 107.8 mm with a flat mandibular plane. Make the face longer, but keep the chin from rotating back.',
      brief: 'This face is short (N–Me 107.8 mm, FMA 14.5°). Opening the mandible would lengthen it, but every degree of clockwise rotation also swings B point and pogonion <b>back</b>, toward the airway. Reach N–Me ≥ 114 mm with the mandible no more than 2 mm back and a working bite.',
      goals: [
        {text: 'N–Me at least 114 mm', short: 'N–Me ≥ 114', test: c => c.m.N_Me >= 114, val: c => f1(c.m.N_Me) + ' mm'},
        {text: 'B and bony Pog no more than 2 mm back', short: 'setback ≤ 2', test: c => back(c) >= -2, val: c => s1(back(c)) + ' mm'},
        {text: 'Overbite at least 0 mm (no open bite)', short: 'overbite ≥ 0', test: c => c.m.overbite >= 0, val: c => f1(c.m.overbite) + ' mm'},
        noOverlap,
      ],
      hints: [
        'Try <b>Mandibular autorotation</b> +5° first and watch the airway warning: that is the trap.',
        'A <b>genioplasty lengthening</b> adds height below B point without rotating the mandible. The chin segment moves straight down.',
        'About 6.5 mm of genioplasty lengthening reaches 114 mm. The bite is edge to edge (overbite −0.6 mm): close it with 1 mm of upper incisor extrusion. The agreed plan, with its downgraft, BSSO and 4.5 mm graft, also passes.',
      ],
      explain: '<p><b>Vertical without rotation.</b> Face height can come from three places: the maxilla (downgraft), the mandible (clockwise rotation) and the chin (lengthening genioplasty). Rotation is the cheapest but carries the chin back and down. A graft genioplasty and a seated BSSO add height while B point and pogonion keep their front-back position, which protects the airway.</p>',
    },
  ];
})();
