# CBCT Ceph Atlas

An open, interactive cephalometric atlas built from one adult male head CBCT (Planmeca Viso G7, 0.45 mm isotropic), released by the person scanned.

**Live site:** GitHub Pages for this repository (see the repository's "About" link).

## What is in it

- **Interactive 3D skull** — bone surface (iso-surface at 320 HU) in the Frankfort frame, with 60 clickable landmarks. Click a landmark to list every measurement that uses it; click a measurement to draw it.
- **Diagnosis** — 165 measurements (Steiner, McNamara, Ricketts, Holdaway, Jarabak/Björk, Tweed, Legan–Burstone, Arnett STCA, Farkas, Penn, Andrews GALL) against adult-male norms, with z-scores and notes on each norm's provenance.
- **Movement plan** — a rigid-body surgical simulation (bone-borne maxillary expansion, incisor decompensation, Le Fort I, BSSO seated to the bite, genioplasty, stage-2 implants) with before / planned / after-relapse numbers.
- **Facial height** — a ladder of every height lever, millimetres gained at surgery and retained, and the facial index against several population norms.
- **Expansion** — what 10 mm of maxillary expansion does on its own, and whether expansion (with or without protraction) can replace a Le Fort I.
- **Skull Surgery Sandbox** (`sandbox/`) — a game-like teaching tool. The same skull is split into 37 movable pieces: cranium, spine, hyoid, Le Fort I maxilla halves, BSSO mandible segments, genioplasty chin and 28 FDI-numbered teeth. Drag pieces or apply presets (expansion, decompensation, Le Fort I, BSSO, autorotation, genioplasty) and watch the cephalometric readout, occlusion and airway checks react. Five guided missions for students.

## How it was made

Landmarks were placed independently by two methods per anatomical region and each was adversarially verified on thin slices in three planes. Measurements and the GALL reconciliation were re-derived by independent checkers. Treatment scenarios come from a cephalometric movement simulator whose outputs were re-derived from scratch to within 0.02 mm.

## Limits

- Geometry only. This is not a radiological report; the scan was not read for pathology.
- The treatment sections are simulations for exploration and teaching. They are planning-grade estimates with ratio-based soft tissue and estimated relapse, not a prescription and not medical advice.
- Natural head position was not recorded; position-against-the-forehead numbers are given at 0°, 3.9° and 8° chin-down.

## Privacy

Bone surfaces and measurements only. No name, date of birth, record numbers, DICOM headers or facial photographs are included.

## Files

| File | Contents |
|---|---|
| `index.html` | the page (three.js r128 from cdnjs; everything else inline) |
| `data.js` | landmarks (mm, Frankfort frame, origin nasion) and measurements |
| `plan.js` | simulator outputs for the plan, height and expansion sections |
| `mesh.js` | bone surface mesh (int16 positions × 0.05 mm, uint32 indices, base64) |
| `sandbox/` | the surgery sandbox (`index.html`, `app.js`, `engine.js`, `missions.js`, `data.js`, `pieces_*.js` meshes) |
| `sandbox/pipeline/segment.py` | the CBCT-to-movable-pieces segmentation pipeline (Python; see its README) |

## Licence

Code (page scripts and styles, `sandbox/*.js` app code, `sandbox/pipeline/segment.py`): MIT — see `LICENSE`.
Data (`data.js`, `plan.js`, `mesh.js`, `sandbox/data.js`, `sandbox/pieces_*.js` and the measurements in the pages): CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/ — attribution "CBCT Ceph Atlas".
