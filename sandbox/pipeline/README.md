# segment.py — CBCT → movable skull pieces

Part of the open **skull surgery sandbox** (teaching tool for dental and surgical students).
`segment.py` turns one head CBCT plus a landmark file into separately movable bone and tooth
meshes for a browser game/simulator: cranium, Le Fort I maxilla halves, BSSO mandible segments,
genioplasty chin, cervical spine, hyoid, and one piece per tooth (FDI numbered).

Licence: MIT (header of `segment.py`). The source scan is an adult male; the subject
consented to open release. The pipeline reads **only geometry and pixel tags** from the DICOM
files (`pydicom.dcmread(..., specific_tags=[...])`), so no names, dates or record numbers are read or written.

## Usage

```
python3 segment.py --dicom-dir DIR --landmarks analysis.json --out OUTDIR \
                   [--qa QADIR] [--cache CACHEDIR] [--reuse-stage] [--sim SIMDIR] \
                   [--tooth-grid 1|2] [--bone-grid 2|3|4] [--cranium-tris N]
```

* `--qa` defaults to `OUTDIR/../qa`. `--cache` stores the smoothed volume (`G.npy`), the bone-mask +
  first-pass teeth stage (`stage_teeth.npz`; reused with `--reuse-stage`) and the final label volume
  (`labels.npy`, uint8, see the label table below) so reruns skip the slow steps.
* `--sim` points at the folder holding `sim.py` (the cephalometric simulator). The pipeline then rebuilds
  the simulator's landmark dictionary from the manifest and checks that every baseline metric is reproduced
  (`manifest.qa.readout_vs_sim_baseline`).
* `--cranium-tris` (default 100 000) decimates the cranium mesh with `pyfqmr` (quadric decimation;
  `pip install --user pyfqmr`). Without pyfqmr the full-resolution mesh is written. The cranium is a fixed
  reference, so the jaws and teeth keep full resolution.
* Runtime about 3 min on a laptop (445 × 668 × 668 voxels), peak RAM about 8 GB.
* Requirements: Python ≥ 3.9, numpy, scipy, scikit-image ≥ 0.19, pydicom, matplotlib (QA only), pyfqmr (optional).

As a library:

```python
import segment
res = segment.run(dicom_dir, "analysis.json", "pieces/", qa_dir="qa/")
res["manifest"], res["labels"]            # manifest dict, uint8 label volume [z, y, x]
vol, spacing = segment.load_volume(dicom_dir)
frame = segment.Frame.from_analysis(json.load(open("analysis.json")))
frame.vox_to_gl([x, y, z])                # scanner voxel -> display frame (mm)
```

Each stage is its own function: `bone_mask`, `augment_condyles`, `Dental`, `remove_occlusal_streaks`,
`segment_teeth`, `refine_teeth`, `separate_bones`, `assign_residual_islands`, `separate_joint_gaps`,
`fill_condyle_gaps`, `trim_joint_faces`, `finalize_spine_hyoid`, `apply_cuts`, `clean_thin_slivers`,
`clean_crown_specks`, `absorb_enclosed_dentin`, `mask_to_mesh`, `encode_mesh`, `assign_landmarks`,
`check_landmark_sets`, `readout_check`, `head_mask` and the `render_*` QA helpers. `segment.DEBUG` holds the tooth seeds, markers
and raw watershed from the last run.

## Inputs

* **DICOM**: axial series, isotropic voxels. Slices are sorted by `ImagePositionPatient[2]` and
  scaled with RescaleSlope/Intercept to HU. Volume `vol[z, y, x]`; scanner axes +x = patient left,
  +y = posterior, +z = superior. Scanner mm = voxel index × voxel size.
* **analysis.json**: `landmarks[name].scanner_voxel = [x, y, z]` and
  `frame.{lateral_axis_scanner, anterior_axis_scanner, FH_normal_scanner}`. The origin is N.
  Landmarks used: N S Ba A ANS PNS U1tip L1tip MolR/L PmR/L GoR/L CoR/L IOFR/L Me Pog.

## Output (`OUTDIR`)

| file | content |
|---|---|
| `manifest.json` | pieces, files, pivots, landmark coordinates (`landmarks_gl`), membership and binding rules, teeth (FDI, axis, tip, apex, length, volumes, flags), hinge axis, cut planes, BSSO geometry, QA numbers |
| `pieces_cranium.js` | `cranium`, `spine`, `hyoid` |
| `pieces_jaws.js` | `maxilla_R`, `maxilla_L`, `mandible_body`, `ramus_R`, `ramus_L`, `chin` |
| `pieces_teeth_upper.js` / `pieces_teeth_lower.js` | `tooth_11` … `tooth_27`, `tooth_31` … `tooth_47` |

Each JS file does `window.PIECES[id] = {id, label, group, color, nv, ni, scale, pos, idx, centroid,
pivot, pivot_note, landmarks, triangles, ...}`. The mesh encoding is the same as the atlas
`window.MESH`: `pos` is a base64 little-endian `Int16Array` of interleaved GL xyz divided by `scale`
(0.05 mm), and `idx` is a base64 `Uint32Array` of triangle indices, counter-clockwise and outward-facing (the
signed volume of every piece is checked to be positive). Teeth also carry `fdi`, `long_axis`, `tip`, `apex`
and `length_mm`.

**Display frame (GL)**: x = patient left, y = superior (FH normal), z = anterior, in mm, origin N:
`GL = R · (p_mm − N_mm)`, where the rows of R are the lateral, FH-normal and anterior axes (stored in the manifest).

Label volume values: 1 cranium, 2 spine, 3 maxilla_R, 4 maxilla_L, 5 mandible_body, 6 ramus_R,
7 ramus_L, 8 chin, 10 hyoid, 100 + FDI = tooth.

**Converting to the simulator frame**: `sim.py` uses `anat_mm = (lat, ant, sup) = (GL x, GL z, GL y)`.

## Method

1. **Bone mask.** Gaussian σ = 0.7 voxel. Threshold = max(320 HU, local soft-tissue level + 170 HU).
   The local level is a normalised Gaussian (σ 4 mm) average of voxels between −250 and 450 HU. CBCT
   cupping makes deep soft tissue near the skull base read 350–500 HU, so a fixed 300 HU threshold
   leaks into muscle. Components outside the skin envelope (eroded 3 mm) are dropped, which removes the ear rods
   and earrings.
2. **Condyles.** The condylar heads in this scan are cancellous (300–500 HU) with almost no cortex, so the
   pipeline re-thresholds them inside a 13 mm sphere around each condylion (σ 1 voxel, 270 HU), opens the result with a
   ball of r = 2 to cut muscle strands, keeps the part connected to the condylar neck and fills holes. One voxel is then
   peeled off the added surface wherever it is below 450 HU, because the low threshold inflates the head into the joint space.
3. **Dental geometry.** The occlusal plane is a least-squares fit through MolR/L, PmR/L and the incisor contact.
   The arch curve is a spline through the crown slab (>1800 HU, ±6 mm). The arc length s is 0 at the midline and
   negative on the patient's right.
4. **Occlusal streaks.** Enamel produces bright horizontal streaks in the occlusal plane. Within ±5 mm of
   that plane, bone voxels within 12 mm of the arch and level with the dentition are deleted (only teeth live
   there). Points whose nearest arch point is an arch end (distal to the last molars: retromolar triangle,
   anterior ramus, external oblique ridge) are not deleted; there, and elsewhere in the band, only
   structures at least 3 mm tall are kept (vertical opening). The previous version also deleted the
   retromolar bone, which left holes exactly where the sagittal split is taught.
5. **Teeth** (`segment_teeth`):
   * Seeds: 2-D cervical cross-sections (dentin > 1350 HU, small holes filled) are taken on every slice of a
     band 5–9 mm (lower) or 5–12.5 mm (upper) from the occlusal plane. Their arc positions are clustered,
     which gives one cluster per tooth. Molar root clusters within 7 mm are merged. FDI numbers are assigned
     by counting outward from the midline on each side. The 3-D seed of each tooth is the eroded crown band
     (dz 2.5–7 mm) inside its arc interval.
   * Root markers: 2-D slice tracking toward the apex. In each slice, a watershed on −intensity runs between
     each tooth's eroded previous cross-section and bone markers (dentin > 2 voxels away). Growth is limited
     to one voxel per slice, the area may not increase by more than about 12 %, and tracking stops at 55 % of
     the typical root length for that tooth type.
   * Pass 1: a 3-D watershed on the distance transform of the dentin mask, which has its cortical shell
     removed (1.8 mm in posterior regions, 0.9 mm in anterior ones). The bone markers are the shell, the
     basal bone more than 30 mm from the occlusal plane and the bone far from the arch. Contacts behave as necks.
   * Pass 2, per arch: the roots are re-split on −intensity, so thin adjacent roots are separated at the dark
     PDL/interdental gap. The crowns keep their pass-1 labels.
   * Clean-up: each tooth is opened with a ball of r = 2 and reconstructed (removes thin cortical sheets).
     Its largest component is kept. It is then grown by up to 2 voxels into partial-volume voxels (and is not allowed to grow into bone dentin), and holes are filled.
   * **Second pass against bone** (`refine_teeth`). Where a root lies against the cortical plate, the first
     pass let the label run along the plate (cortical "fins", worst at 36, 46, 44, 45, 43, 13, 17). Each tooth
     is re-segmented against its own neighbourhood with a marker watershed on −intensity, so the boundary
     follows the dark PDL / lamina-dura line:
     - tooth marker: the tooth label tracked slice by slice from the cervical level toward the apex (each
       slice may keep only voxels within one voxel of the previous slice's core, and the cross-section may
       not grow by more than 5 %, so plates that join the root laterally are left out), eroded by a ball of
       r = 2 (r = 3 for molars), plus the crown;
     - bone marker: bone voxels within 3 voxels of the tooth (the root canal, which opens at the apex, is
       closed per slice first so it never becomes a bone marker), plus, for the lower teeth and upper molars,
       tooth voxels on the outer jaw surface in the root zone (a root never forms the outer surface there);
     - dentin ≥ 1200 HU enclosed by the tooth (3-D fill after a 1-voxel closing) is given to the tooth;
     - safety net: a tooth that would lose more than 25 % of its voxels or 4.5 mm of height keeps its
       first-pass label (none did in this run).
     The removed fins (about 2.2 cm³ in total) go back to the surrounding bone. After all labels are merged,
     `absorb_enclosed_dentin` relabels any remaining bone voxels ≥ 1200 HU enclosed by a tooth (after a
     2-voxel closing) to that tooth; furcation bone is below 1200 HU and stays bone.
6. **Cranium / mandible / spine / hyoid.** A marker watershed on −G runs inside the bone mask with the teeth removed.
   The markers are the vault above S plus a ball around N (cranium); Me, Pog, Go, the condylar necks and the
   condylar heads (mandible); and the region below and behind Ba (spine).
   * **Residual islands** (bone-mask components with no marker, `assign_residual_islands`): islands in the
     hyoid region (below Me, more than 30 mm in front of Ba, behind the chin, within 30 mm of the midline)
     with median ≥ 380 HU become the **hyoid** (its thin cortex reads only 430–450 HU after smoothing).
     Other islands with median < 550 HU (dense soft tissue, streaks, cartilage) or < 30 voxels are dropped.
     The rest go to the bone label with the most voxels within 3 mm, preferring the mandible below the
     occlusal plane and the cranium above it; islands with no bone within 3 mm are dropped.
   * Crown partial-volume rims are removed from the bone labels. Joint spaces are opened by deleting voxels
     below 950 HU wherever the mandible touches the cranium or spine, or the spine touches the cranium (2 passes).
   * **Condyles** (`fill_condyle_gaps`, `trim_joint_faces`): unlabelled bone-mask voxels of the condylar head
     that touch the mandible and are at least 3 voxels from the cranium rejoin the mandible (the medial pole
     lost voxels before). Then mandible voxels closer than 1.5 mm to the cranium label and below 650 HU are
     unlabelled, so the joint keeps a visible space.
   * The spine keeps only its largest component (`finalize_spine_hyoid`); other spine components in the
     hyoid region join the hyoid, and the rest are dropped. Disconnected cranium fragments under 500 voxels
     are dropped.
7. **Osteotomies** (`apply_cuts`). All heights are measured parallel to the occlusal plane (h = sup − b·ant):
   * **Le Fort I**: the plane sits 4.5 mm above the highest upper root apex (99.5th percentile of the tooth
     voxels). It is kept at least 5 mm below the infraorbital foramina, runs back to the pterygomaxillary limit
     (ant > PNS − 2 mm), and is level laterally. The maxilla is the cranium below that plane, split by the
     midpalatal plane through A and PNS. Islands of each half that are not connected to its main block stay
     with that half (they are below the cut on that side); islands with median < 500 HU or < 50 voxels are
     dropped. Any cranium component (other than the main one) whose voxels lie mostly below the plane and in
     front of the pterygomaxillary limit is moved to the maxilla half on its side, or dropped if it is soft
     tissue. The QA checks that no such cranium fragment is left (`qa.cranium_components_below_lefort`).
   * **Genioplasty**: the plane is 5 mm below the lower canine apices (at least 8 mm above Me). The chin is the
     mandible below the plane, between arc positions 5 mm mesial of the mental foramina. The foramina are
     detected as the darkest gap in the buccal cortex between the canine and the first molar, with a fallback
     between the premolars if no gap is found.
   * **BSSO** (stepped, interlocking): a vertical buccal cut 2 mm distal to the second molar, perpendicular to
     the arch; a horizontal medial cut 4 mm above the occlusal plane; a split surface at the mid-thickness of
     the body and ramus (smoothed per y–z column); and a lingual limit line from just behind the estimated
     lingula (mid-ramus at the cut height) to 12 mm in front of gonion. The proximal segment (ramus) is
     everything above the medial cut, plus everything distal to the buccal cut that is either behind the
     lingual line or buccal of the split surface. The distal segment (mandible_body) is the rest, without
     the chin.
   * **Clean-up after the cuts**: `clean_thin_slivers` opens the rami, chin and body (ball r = 1); strips
     that do not survive and are not attached to the opened main body go to the neighbouring mandible piece
     with the most contact (the interleaved strips of the stepped cut near 37/47). `clean_crown_specks`
     removes dense soft-tissue specks (median < 550 HU, within 6 mm of the occlusal plane) that hung on the
     maxilla halves and mandible next to the crowns.
8. **Meshes.** Marching cubes on the Gaussian-smoothed binary mask (σ 1 voxel), block-averaged ×3 for bone
   (1.35 mm grid). Teeth use σ 0.8 voxel at the native 0.45 mm grid. The cranium is decimated to 100 000
   triangles (pyfqmr), which brings the whole payload to about 9.5 MB.
9. **Landmarks** (`assign_landmarks`). The manifest carries every analysis.json landmark in the GL frame
   (`landmarks_gl`), its owner (`landmark_membership`) and the rule used (`landmark_rules`). Binding follows
   the anatomy and the simulator's segments (`sim.py` SEG_*), not just the nearest voxel:
   * **U1 set** (U1tip, U1apex, U1FA, U1lab) → the tooth that carries U1tip (tooth_11); **L1 set** (L1tip,
     L1apex, L1lab) → the tooth that carries L1tip (tooth_31). The analysis.json L1apex was placed on the apex
     of 41 (lat −2.3 mm), about 4 mm from the 31 apex. It is kept at its analysis.json position, so the
     sagittal readouts match the simulator exactly, and is carried rigidly by tooth_31.
   * **Occlusal contacts**: MolR/L and PmR/L are single contact points. As in `sim.load_landmarks`, they are
     duplicated into UMolR/L and UPmR/L, bound to the nearest upper molar / premolar, and LMolR/L and LPmR/L,
     bound to the nearest lower one. The originals are not movable (membership `null`).
   * **Midline** A, ANS and PNS lie on the midpalatal split. Their membership is the list
     `["maxilla_R", "maxilla_L"]`: move them with the mean of the two half transforms (they appear under
     `shared_landmarks` of both halves).
   * **Chin**: Pog, Gn and Me ride on `chin`. MeT and GnT (true menton / gnathion, as in `sim.py`) are copies
     on `mandible_body`, for the true mandibular plane after a genioplasty.
   * Co, Ar, Go and Ag go to the rami; JR/JL to the maxilla halves; B to mandible_body; everything else to
     the nearest labelled voxel within 3 mm. Soft-tissue points (names ending in `'`, plus Prn, Sn, Ls, Sto,
     Li, Si, Cm, Alar/Alare, Superion and FFA) have no piece.
   * `check_landmark_sets` verifies that each SEG_U1 / SEG_L1 set has one owner, that SEG_MAX sits on the
     maxilla or upper teeth, SEG_MAND_DISTAL on the body, chin or lower teeth, SEG_MAND_PROX on the rami and
     SEG_GENIO on the chin (`qa.landmark_sets`). With `--sim`, `readout_check` rebuilds the simulator's
     landmark dictionary from `landmarks_gl` and compares all 84 baseline metrics with `sim.py`'s own baseline
     (`qa.readout_vs_sim_baseline`; the only differences come from rounding the coordinates to 0.001 mm).

### Pivots (suggested)

| piece | pivot |
|---|---|
| cranium | N (fixed reference) |
| spine | Ba |
| hyoid | centroid (free-floating) |
| maxilla_R / maxilla_L | PNS (Le Fort I pitch / impaction) |
| mandible_body | midpoint of the condylar hinge axis CoR–CoL (autorotation) |
| ramus_R / ramus_L | CoR / CoL |
| chin | centre of the genioplasty osteotomy surface |
| teeth | approximate centre of resistance: on the long axis (PCA), 40 % of the tooth length from the apex |

## QA (`QADIR`)

Renders: axial, coronal and sagittal label overlays in a bone window (overview and dental); coronal
close-ups of each TMJ; two tooth galleries (mesio-distal and bucco-lingual sections; red = tooth, yellow =
neighbours); **root sections** for every tooth (`teeth_root_sections_upper/lower.png`: five sections across
the root from the apex toward the crown plus two long-axis sections; red = tooth, yellow = other teeth,
cyan = bone), which is where cortical fins would show; the retromolar / sagittal-split region
(`bsso_region_sagittal.png`); the hyoid (`hyoid_axial.png`); and point-splat renders of the assembled and
exploded meshes.

Numbers (`manifest.qa`), this scan:

| check | result |
|---|---|
| overlap between pieces | 0 (one label volume) |
| coverage, head mask (`head_mask`: > −450 HU, filled per slice, largest component, eroded 3 mm), smoothed volume | 97.6 % of voxels > 400 HU, 99.6 % > 600 HU, 99.9 % > 800 HU |
| same on the raw HU volume | 93.6 % > 400 HU, 99.5 % > 600 HU, 99.9 % > 800 HU |
| largest unassigned clusters | all soft tissue / cartilage (median 360–440 HU: nasal and septal cartilage, base of tongue, cheek); one 46 mm³ isolated fragment (median 573 HU) behind the right ramus, possibly the styloid tip |
| cranium fragments below the Le Fort I cut | none (cranium = main block + 2 small fragments above the cut) |
| spine / hyoid components | 1 / 2 (hyoid body + left greater horn, separated by the synchondrosis gap) |
| mandible bones touching cranial bones | 0 voxels |
| lower teeth touching upper teeth | about 1 560 voxel faces: the teeth are in occlusion (edge-to-edge incisors); treat as contact |
| condyle to cranium (voxel centres) | 1.1 mm (R) / 1.6 mm (L) at the condylar head; 0.9 mm elsewhere on the ramus (one voxel each, medial to the neck) |
| teeth with enclosed bone ≥ 1200 HU | 0 |
| landmark sets (`check_landmark_sets`) | all consistent: SEG_U1 → tooth_11, SEG_L1 → tooth_31 |
| readout vs `sim.py` baseline | 84 metrics, max difference 0.01 (coordinate rounding) |

The unassigned share at 400 HU is mostly not bone: CBCT cupping makes deep soft tissue read 400–550 HU
near the skull base, and the raw volume also has occlusal streaks and enamel partial-volume rims in soft
tissue. At 600 HU and above, coverage is over 99 %.

## Known limitations

* **Tooth/bone boundary.** After the second pass, the cortical fins of the first version are gone or
  reduced to small remnants (36 lost about 350 mm³ of fin and is now 20.3 mm long instead of 25.4 mm; 46 is
  20.8 mm; 44 and 45 lost their buccal flanges). A short tail along the lingual cortex remains at the 36
  distal root, and a small buccal remnant at 46/47 (see `teeth_root_sections_lower.png`). Apices can be
  1–2 mm short (the U1 apex landmark lies about 2 mm beyond the segmented 11 apex).
* **Tooth volumes are too large, and this is stated honestly in the manifest.** The label volumes are
  1.4–2.1× (median 1.7×) rough textbook whole-tooth volumes; the ≥ 1000 HU core is 1.2–1.9× (median 1.6×).
  Interior HU is dentin-like, so the excess is mostly the partial-volume rim (the label boundary sits near
  750 HU so that the surface closes) and CBCT blur, not bone. Each tooth carries `volume_mm3` (voxels),
  `volume_mesh_mm3` and `volume_dense1000_mm3` with `typical_volume_mm3`. Do not teach tooth volumes from
  these numbers.
* **TMJ clearance.** The measured joint space is about 2 mm. The labels keep 1.1–1.6 mm between voxel
  centres at the condylar heads (about 0.7–1.1 mm between mesh surfaces) because of partial volume. Use
  about 1 mm as the collision tolerance at the TMJ.
* The hyoid is two pieces (body with the right horn, and the left greater horn). Move them together.
* The CBCT field of view cuts the posterior vault and the lower cervical spine (C3), so the cranium and
  spine meshes have flat cut faces. The cranium mesh is decimated to 100 000 triangles.
* Thin bone (orbital floor, lamina papyracea, ethmoid, sinus walls, parts of the vomer and septum) is partly
  missing at this threshold. Small fragments are dropped, and low-density islands below the Le Fort cut
  (septal cartilage, under 500 HU) are dropped rather than given to the maxilla.
* The osteotomies are geometric approximations for teaching. They are not a surgical plan. The lingula is
  estimated, not detected.
* Third molars: none were found in the crown band. A tooth with no crown in that band (impacted or
  unerupted) would not be seeded.
