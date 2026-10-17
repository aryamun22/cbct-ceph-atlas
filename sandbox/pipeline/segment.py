#!/usr/bin/env python3
# MIT License
#
# Copyright (c) 2026 the skull-surgery-sandbox contributors
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
"""
segment.py -- split one head CBCT into movable bone and tooth pieces
=====================================================================

Part of the open "skull surgery sandbox" for dental / surgical teaching.
Input: one axial CBCT series (DICOM) plus a landmark file (analysis.json, see README).
Output: a folder of per-piece meshes (JS + manifest.json) and a label volume.

Pieces
------
* ``cranium``      everything that is not listed below (zygomas and midface above Le Fort I)
* ``spine``        cervical vertebrae (optional; only if present in the field of view; one component)
* ``hyoid``        hyoid bone (optional; body + greater horns, may be 2-3 components joined by cartilage)
* ``maxilla_R/L``  Le Fort I segment split at the midpalatal plane (teeth excluded)
* ``mandible_body`` tooth-bearing distal segment of a bilateral sagittal split (no teeth, no chin)
* ``ramus_R/L``    proximal BSSO segments (condyle, coronoid, ramus, angle)
* ``chin``         genioplasty segment
* ``tooth_NN``     one piece per tooth, FDI numbered (falls back to groups if seeding fails)

Method (summary; README.md has the details and the known limitations)
1.  HU volume -> Gaussian sigma 0.7 vox.  Bone mask = G > max(320, local soft-tissue level + 170)
    (the local level is a normalised Gaussian average of soft-tissue voxels; CBCT cupping makes
    deep soft tissue near the skull base read 350-500 HU, so a fixed threshold leaks).
2.  Teeth: occlusal plane from landmarks, arch curve from the crown slab, arc-length map;
    one seed per tooth from 2-D cervical cross-sections clustered along the arch; seeds are
    extended down the root by 2-D slice tracking (shape-constrained, capped at ~55 % of the
    typical root length); then a 3-D marker watershed on the distance transform of the dentin
    mask (cortical shell removed and used as bone marker) splits teeth from each other and from
    bone; each tooth is opened (ball r=2) and reconstructed to strip thin cortical sheets, then
    grown by <= 2 voxels into partial-volume voxels.
3.  Bones: marker watershed on -G separates cranium / mandible / spine at the joint spaces.
4.  Osteotomies are geometric: Le Fort I plane (parallel to the occlusal plane, 4.5 mm above the
    highest upper root apex, back to the pterygomaxillary junction), midpalatal plane (through A
    and PNS), genioplasty plane (5 mm below the lower canine apices, between points 5 mm mesial
    of the mental foramina), and a stepped sagittal-split surface (buccal cut behind the second
    molars, horizontal medial cut 4 mm above the occlusal plane, split surface at the mid-thickness
    of the body/ramus, lingual fragment bounded behind the lingula).
5.  Meshes: marching cubes on lightly smoothed masks (1.35 mm grid for bone, 0.45/0.9 mm for
    teeth) in the display ("GL") frame: x = patient left, y = up (FH normal), z = anterior, mm,
    origin nasion; encoded like the atlas mesh (int16 base64 at scale 0.05 + uint32 indices).

Privacy: only geometry and pixel tags are read from the DICOM files (``specific_tags``); no patient
or study identifiers are read, stored or written.

CLI::

    python3 segment.py --dicom-dir DIR --landmarks analysis.json --out OUTDIR [--qa QADIR]

Library::

    import segment
    res = segment.run(dicom_dir, landmarks_json, out_dir, qa_dir=None)
    vol, spacing = segment.load_volume(dicom_dir)
    frame = segment.Frame.from_analysis(json.load(open(landmarks_json)), spacing)
"""
from __future__ import annotations

import argparse
import base64
import glob
import json
import os
import sys
import time
import warnings

import numpy as np
import scipy.ndimage as ndi
from scipy.interpolate import splev, splprep

try:  # scikit-image >= 0.19
    from skimage.measure import marching_cubes
    from skimage.morphology import ball
    from skimage.segmentation import watershed
except ImportError as e:  # pragma: no cover
    raise SystemExit("scikit-image is required: %s" % e)

__version__ = "1.0.0"
# numpy 2.0 + macOS Accelerate emits spurious "encountered in matmul" warnings for finite inputs
warnings.filterwarnings("ignore", message=".*encountered in matmul")
DEBUG = {}   # intermediate arrays of the last run (library use / debugging)

# --------------------------------------------------------------------------------------------
# constants
# --------------------------------------------------------------------------------------------
LABELS = {  # label value -> piece id (teeth use 100 + FDI)
    1: "cranium", 2: "spine", 3: "maxilla_R", 4: "maxilla_L", 5: "mandible_body",
    6: "ramus_R", 7: "ramus_L", 8: "chin", 10: "hyoid",
}
PIECE_LABEL = {v: k for k, v in LABELS.items()}
MANDIBLE_TMP = 9          # temporary label for the whole mandible before the cuts
TOOTH_BASE = 100          # tooth label = 100 + FDI number

PRETTY = {
    "cranium": "Cranium (skull base, vault, zygomas, midface above Le Fort I)",
    "spine": "Cervical spine (C1-C3 in the field of view)",
    "hyoid": "Hyoid bone (body and greater horns)",
    "maxilla_R": "Maxilla, right half (Le Fort I segment)",
    "maxilla_L": "Maxilla, left half (Le Fort I segment)",
    "mandible_body": "Mandible, tooth-bearing segment (BSSO distal)",
    "ramus_R": "Mandibular ramus, right (BSSO proximal)",
    "ramus_L": "Mandibular ramus, left (BSSO proximal)",
    "chin": "Chin (genioplasty segment)",
}
TOOTH_NAMES = {1: "central incisor", 2: "lateral incisor", 3: "canine", 4: "first premolar",
               5: "second premolar", 6: "first molar", 7: "second molar", 8: "third molar"}
QUADRANT = {1: "upper right", 2: "upper left", 3: "lower left", 4: "lower right"}
# typical root lengths (mm) used only to cap the root-tracking markers and for plausibility flags
ROOT_LEN = {"upper": [13.0, 13.0, 17.0, 14.0, 14.0, 12.5, 12.5, 11.0],
            "lower": [12.5, 14.0, 16.0, 14.0, 14.5, 14.0, 13.0, 11.0]}
TOOTH_VOL_RANGE = {1: (150, 1100), 2: (150, 1000), 3: (300, 1500), 4: (250, 1300),
                   5: (250, 1300), 6: (600, 2600), 7: (500, 2500), 8: (300, 2200)}
SOFT_TISSUE_EXTRA = {"Prn", "Sn", "Ls", "Sto", "Li", "Si", "Cm", "Cm_neck", "Cm_arc",
                     "AlarR", "AlarL", "AlareR", "AlareL", "Superion", "FFA"}
GROUP_COLORS = {"cranium": "#d9d2c3", "spine": "#b9b4aa", "maxilla_R": "#e7a977",
                "maxilla_L": "#e8c36f", "mandible_body": "#86b6d8", "ramus_R": "#9bc79a",
                "ramus_L": "#c4a3d6", "chin": "#e58f8f", "hyoid": "#cfc6a8"}


def log(*a):
    print("[segment %s]" % time.strftime("%H:%M:%S"), *a, flush=True)


# --------------------------------------------------------------------------------------------
# I/O
# --------------------------------------------------------------------------------------------
DICOM_TAGS = ["ImagePositionPatient", "PixelSpacing", "RescaleIntercept", "RescaleSlope", "Rows",
              "Columns", "SamplesPerPixel", "PhotometricInterpretation", "BitsAllocated",
              "BitsStored", "HighBit", "PixelRepresentation", "PixelData"]


def load_volume(dicom_dir):
    """Read an axial DICOM series -> (HU volume int16 [z,y,x], voxel size mm (x,y,z)).

    Only geometry and pixel tags are parsed (no identifiers).  Slices are sorted by
    ImagePositionPatient[2], index 0 = most inferior."""
    import pydicom
    files = sorted(glob.glob(os.path.join(dicom_dir, "*.dcm")))
    if not files:
        raise FileNotFoundError("no .dcm files in %s" % dicom_dir)
    sl = []
    for f in files:
        ds = pydicom.dcmread(f, specific_tags=DICOM_TAGS)
        z = float(ds.ImagePositionPatient[2])
        arr = ds.pixel_array.astype(np.float32) * float(getattr(ds, "RescaleSlope", 1.0)) \
            + float(getattr(ds, "RescaleIntercept", 0.0))
        sl.append((z, arr, [float(v) for v in ds.PixelSpacing]))
    sl.sort(key=lambda s: s[0])
    vol = np.stack([s[1] for s in sl]).clip(-1024, 32000).astype(np.int16)
    dz = float(np.median(np.diff([s[0] for s in sl]))) if len(sl) > 1 else sl[0][2][0]
    spacing = (sl[0][2][1], sl[0][2][0], dz)   # PixelSpacing = (row, col) = (y, x)
    return vol, spacing


class Frame:
    """Landmark frame of analysis.json.  scanner mm = voxel index * voxel size, (x,y,z) order;
    +x patient left, +y posterior, +z superior.  Anatomical frame: lat (patient left), ant, sup
    (FH normal), origin N.  GL display frame = (lat, sup, ant)."""

    def __init__(self, lat, ant, sup, origin_mm, voxel_mm):
        self.lat = np.asarray(lat, float)
        self.ant = np.asarray(ant, float)
        self.sup = np.asarray(sup, float)
        self.origin = np.asarray(origin_mm, float)
        self.vox = float(voxel_mm)
        self.R = np.stack([self.lat, self.sup, self.ant])      # rows: GL axes in scanner coords

    @classmethod
    def from_analysis(cls, analysis, spacing=None):
        f = analysis["frame"]
        vox = float(f.get("voxel_mm", spacing[0] if spacing else 0.45))
        n = analysis["landmarks"]["N"]
        origin = np.asarray(n.get("scanner_mm") or np.asarray(n["scanner_voxel"]) * vox, float)
        return cls(f["lateral_axis_scanner"], f["anterior_axis_scanner"], f["FH_normal_scanner"],
                   origin, vox)

    # voxel index arrays are (x,y,z) order here
    def vox_to_mm(self, v):
        return np.asarray(v, float) * self.vox

    def mm_to_gl(self, p):
        return (np.asarray(p, float) - self.origin) @ self.R.T

    def vox_to_gl(self, v):
        return self.mm_to_gl(self.vox_to_mm(v))

    def vox_to_anat(self, v):
        """-> array [..., 3] = (lat, ant, sup) mm"""
        d = self.vox_to_mm(v) - self.origin
        return np.stack([d @ self.lat, d @ self.ant, d @ self.sup], -1)

    def gl_dir(self, d_scanner):
        return self.R @ np.asarray(d_scanner, float)


def load_landmarks(path):
    a = json.load(open(path))
    lm = {}
    for k, v in a["landmarks"].items():
        if isinstance(v, dict) and v.get("scanner_voxel") is not None:
            lm[k] = np.asarray(v["scanner_voxel"], float)
    return a, lm


def is_soft_tissue(name):
    return name.endswith("'") or name in SOFT_TISSUE_EXTRA


# --------------------------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------------------------
S26 = np.ones((3, 3, 3), bool)
S8 = np.ones((3, 3), bool)


def largest_cc(mask, structure=S26):
    cc, n = ndi.label(mask, structure)
    if n <= 1:
        return mask.copy()
    sz = np.bincount(cc.ravel())
    sz[0] = 0
    return cc == np.argmax(sz)


def fill_small_holes_2d(D, max_area=150):
    """Fill 2-D (axial) holes up to max_area voxels: root canals and pulp, not marrow."""
    out = D.copy()
    for k in range(D.shape[0]):
        h = ndi.binary_fill_holes(D[k]) & ~D[k]
        if h.any():
            cc, n = ndi.label(h)
            a = np.bincount(cc.ravel())
            small = np.nonzero(a <= max_area)[0]
            small = small[small > 0]
            if len(small):
                out[k] |= np.isin(cc, small)
    return out


def bbox(mask, pad=0, shape=None):
    sl = ndi.find_objects(mask.astype(np.uint8))[0]
    shape = shape or mask.shape
    return tuple(slice(max(s.start - pad, 0), min(s.stop + pad, shape[i])) for i, s in enumerate(sl))


def grid_xyz(box):
    z0, z1, y0, y1, x0, x1 = box
    return np.meshgrid(np.arange(z0, z1), np.arange(y0, y1), np.arange(x0, x1), indexing="ij",
                       sparse=True)


# --------------------------------------------------------------------------------------------
# 1. bone mask
# --------------------------------------------------------------------------------------------
def bone_mask(G, vox_mm=0.45, base=320.0, margin=170.0, sigma_mm=4.0):
    """Adaptive bone threshold: max(base, local soft-tissue level + margin)."""
    w = ((G > -250) & (G < 450)).astype(np.float32)
    s = sigma_mm / vox_mm
    num = ndi.gaussian_filter(G * w, s)
    den = ndi.gaussian_filter(w, s)
    bg = num / np.maximum(den, 1e-3)
    del num, den, w
    thr = np.maximum(base, bg + margin)
    B = G > thr
    del thr
    # head envelope: drop objects outside the soft tissue (ear rods, earrings, chin rest)
    H = G > -450
    H = np.stack([ndi.binary_fill_holes(h) for h in H])
    H = largest_cc(H, None)
    Hin = ndi.binary_erosion(H, iterations=int(round(3.0 / vox_mm)))
    cc, n = ndi.label(B, S26)
    sz = np.bincount(cc.ravel())
    inside = np.bincount(cc.ravel(), weights=Hin.ravel().astype(np.float32), minlength=n + 1)
    keep = (sz >= 64) & (inside >= 0.5 * sz)
    keep[0] = False
    B = keep[cc]
    dropped = int(((~keep[1:]) & (sz[1:] >= 64)).sum())
    return B, H, dropped


def augment_condyles(G, B, lm, frame, radius_mm=13.0, thr=270.0, peel_hu=450.0):
    """The condylar heads of this scan are cancellous with a thin cortex (300-500 HU) and the
    surrounding muscle reads 250-450 HU, so the adaptive bone threshold loses them.  Inside a
    sphere around each condylion: threshold a sigma-1 smoothed volume at `thr`, open (ball r=2) to
    cut muscle strands, keep the part connected to the condylar neck, fill holes, add to B; finally
    peel one voxel off the added surface where HU < peel_hu (keeps the ~2 mm joint space).
    Returns (voxels added, voxels peeled)."""
    v = frame.vox
    added = peeled = 0
    for side in ("R", "L"):
        co, go = lm["Co" + side], lm["Go" + side]
        c = co - np.array([0, 0, 3.0 / v])
        r = int(np.ceil(radius_mm / v))
        z0, y0, x0 = [int(max(np.floor(c[i] - r), 0)) for i in (2, 1, 0)]
        z1, y1, x1 = int(min(c[2] + r + 1, G.shape[0])), int(min(c[1] + r + 1, G.shape[1])), int(min(c[0] + r + 1, G.shape[2]))
        g = ndi.gaussian_filter(np.asarray(G[z0:z1, y0:y1, x0:x1], np.float32), 1.0 / 0.7)
        Z, Y, X = grid_xyz((z0, z1, y0, y1, x0, x1))
        sph = ((X - c[0]) ** 2 + (Y - c[1]) ** 2 + (Z - c[2]) ** 2) <= r * r
        m = (g > thr) & sph
        m = ndi.binary_opening(m, ball(2))
        neck = np.asarray(B[z0:z1, y0:y1, x0:x1]) & sph & (Z < co[2] - 8.0 / v)
        cc, n = ndi.label(m, S26)
        ids = np.unique(cc[neck & (cc > 0)])
        if len(ids) == 0:
            continue
        # the component reaching the condylion region from the neck
        sel = np.isin(cc, ids) & ((Z < co[2] + 2.5 / v))
        sel = np.stack([ndi.binary_fill_holes(s_) for s_ in sel])
        sub = B[z0:z1, y0:y1, x0:x1]
        aug = sel & ~sub
        sub |= sel
        # the low threshold slightly inflates the head (partial volume of the joint space): peel one
        # voxel off the augmented surface where the voxel itself is below `peel_hu`
        gG = np.asarray(G[z0:z1, y0:y1, x0:x1])
        surf = aug & ~ndi.binary_erosion(sub, iterations=1, border_value=1)
        peel = surf & (gG < peel_hu)
        sub[peel] = False
        added += int((aug & ~peel).sum())
        peeled += int(peel.sum())
    return added, peeled


# --------------------------------------------------------------------------------------------
# 2. dental geometry
# --------------------------------------------------------------------------------------------
class Dental:
    """Occlusal plane, arch curve and arc-length maps for the dental box."""

    def __init__(self, G, lm, frame, crown_thr=1800.0):
        v = frame.vox
        inc = (lm["U1tip"] + lm["L1tip"]) / 2.0
        pts = np.array([lm[k] for k in ("MolR", "MolL", "PmR", "PmL") if k in lm] + [inc])
        A = np.c_[np.ones(len(pts)), pts[:, 0], pts[:, 1]]
        self.occ = np.linalg.lstsq(A, pts[:, 2], rcond=None)[0]   # z = a + b x + c y (voxels)
        self.occ_pts = pts
        # dental box (voxels)
        xs = [lm[k][0] for k in ("GoR", "GoL", "MolR", "MolL")]
        z0 = int(max(lm["Me"][2] - 4, 0))
        z1 = int(min(max(lm["ANS"][2], lm["PNS"][2]) + 45 / v, G.shape[0]))
        y0 = int(max(min(lm["U1tip"][1], lm["L1tip"][1], lm["Pog"][1]) - 20 / v, 0))
        y1 = int(min(max(lm["MolR"][1], lm["MolL"][1]) + 50 / v, G.shape[1]))
        x0 = int(max(min(xs) - 5 / v, 0))
        x1 = int(min(max(xs) + 5 / v, G.shape[2]))
        self.box = (z0, z1, y0, y1, x0, x1)
        self.g = np.asarray(G[z0:z1, y0:y1, x0:x1], np.float32)
        Z, Y, X = grid_xyz(self.box)
        self.dz = ((Z - (self.occ[0] + self.occ[1] * X + self.occ[2] * Y)) * v).astype(np.float32)
        # arch curve from the crown slab (both arches)
        crown = (self.g > crown_thr) & (np.abs(self.dz) < 6.0)
        P = crown.sum(0).astype(float)
        mol = (lm["MolR"] + lm["MolL"]) / 2.0
        cx = mol[0]
        cy = (inc[1] + mol[1]) / 2.0 + 15.0
        Y2, X2 = np.mgrid[y0:y1, x0:x1]
        th = np.degrees(np.arctan2(X2 - cx, -(Y2 - cy)))
        r = np.hypot(X2 - cx, Y2 - cy)
        rmax = 1.7 * np.hypot(inc[0] - cx, inc[1] - cy)
        ths, rs = [], []
        for a in np.arange(-160, 160, 2.0):
            m = (th >= a) & (th < a + 2) & (P > 0) & (r < rmax)
            if P[m].sum() > 60:
                rs.append((r[m] * P[m]).sum() / P[m].sum())
                ths.append(a + 1)
        ths = np.array(ths)
        rs = ndi.median_filter(np.array(rs), 5)
        px = cx + rs * np.sin(np.radians(ths))
        py = cy - rs * np.cos(np.radians(ths))
        tck, _ = splprep([px, py], s=len(px) * 4)
        ax, ay = splev(np.linspace(0, 1, 2000), tck)
        s = np.r_[0, np.cumsum(np.hypot(np.diff(ax), np.diff(ay)))] * v
        # s = 0 at the anatomical midline (lat = 0) on the anterior part of the arch
        zc = float(self.occ[0] + self.occ[1] * cx + self.occ[2] * inc[1])
        latc = frame.vox_to_anat(np.c_[ax, ay, np.full_like(ax, zc)])[:, 0]
        front = ay < cy
        imid = np.argmin(np.where(front, np.abs(latc), 1e9))
        s = s - s[imid]
        if ax[0] > ax[-1]:   # make s increase toward patient left (+x)
            ax, ay, s = ax[::-1], ay[::-1], -s[::-1]
        self.ax, self.ay, self.s = ax, ay, s
        R = np.zeros((y1 - y0, x1 - x0), bool)
        S = np.zeros(R.shape, np.float32)
        iy = np.clip(np.round(ay - y0).astype(int), 0, R.shape[0] - 1)
        ix = np.clip(np.round(ax - x0).astype(int), 0, R.shape[1] - 1)
        R[iy, ix] = True
        S[iy, ix] = s
        d, ind = ndi.distance_transform_edt(~R, return_indices=True)
        self.darch = (d * v).astype(np.float32)
        self.sarch = S[ind[0], ind[1]]
        self.frame = frame

    def tangent_at(self, x, y):
        q = int(np.argmin((self.ax - x) ** 2 + (self.ay - y) ** 2))
        q0, q1 = max(q - 6, 0), min(q + 6, len(self.ax) - 1)
        t = np.array([self.ax[q1] - self.ax[q0], self.ay[q1] - self.ay[q0]])
        return t / (np.linalg.norm(t) + 1e-9), q

    def s_of(self, x, y):
        """arc length of the nearest arch point for voxel coords (any shape)."""
        z0, z1, y0, y1, x0, x1 = self.box
        iy = np.clip(np.round(np.asarray(y) - y0).astype(int), 0, self.sarch.shape[0] - 1)
        ix = np.clip(np.round(np.asarray(x) - x0).astype(int), 0, self.sarch.shape[1] - 1)
        return self.sarch[iy, ix]


def remove_occlusal_streaks(B, dent, frame, half_band_mm=5.0, keep_height=7, end_margin_mm=1.0):
    """Enamel produces bright horizontal streaks along the occlusal plane that reach bone
    threshold in the cheeks and tongue.  Inside |dz| < half_band_mm of the occlusal plane:
    delete bone-mask voxels near the arch (darch < 12 mm and level with the dentition, not distal to
    the last molars: only teeth live there) and keep elsewhere only structures at least `keep_height`
    voxels tall (vertical opening: ramus, coronoid, retromolar bone)."""
    v = frame.vox
    a, b, c = dent.occ
    zlo = int(max(np.floor(min(a + b * x + c * y for x in (0, B.shape[2]) for y in (0, B.shape[1])) - half_band_mm / v - 2), 0))
    zhi = int(min(np.ceil(max(a + b * x + c * y for x in (0, B.shape[2]) for y in (0, B.shape[1])) + half_band_mm / v + 2), B.shape[0]))
    Z, Y, X = np.meshgrid(np.arange(zlo, zhi), np.arange(B.shape[1]), np.arange(B.shape[2]), indexing="ij", sparse=True)
    band = np.abs((Z - (a + b * X + c * Y)) * v) < half_band_mm
    slab = B[zlo:zhi]
    se = np.zeros((keep_height, 1, 1), bool)
    se[:, 0, 0] = True
    opened = ndi.binary_opening(slab, se)
    new = np.where(band, opened, slab)
    z0, z1, y0, y1, x0, x1 = dent.box
    near = np.zeros(B.shape[1:], bool)
    # only alongside the dentition: points whose nearest arch point is one of the arch ends (distal to
    # the last molars: retromolar triangle, anterior ramus, external oblique ridge) keep their bone
    s_lo, s_hi = float(dent.s.min()) + end_margin_mm, float(dent.s.max()) - end_margin_mm
    near[y0:y1, x0:x1] = (dent.darch < 12.0) & (dent.sarch > s_lo) & (dent.sarch < s_hi)
    new &= ~(band & near[None])
    removed = int(slab.sum() - new.sum())
    B[zlo:zhi] = new
    return removed


# --------------------------------------------------------------------------------------------
# 3. teeth
# --------------------------------------------------------------------------------------------
def _seed_clusters(dent, zr, td, gap=1.6, merge=3.5):
    g, z0 = dent.g, dent.box[0]
    vals = []
    for z in zr:
        k = z - z0
        if k < 0 or k >= g.shape[0]:
            continue
        m = ndi.binary_fill_holes((g[k] > td) & (dent.darch < 6))
        cc, n = ndi.label(m)
        a = np.bincount(cc.ravel())
        for i in range(1, n + 1):
            if 12 <= a[i] <= 700:
                ys, xs = np.nonzero(cc == i)
                sv = dent.sarch[ys, xs]
                if sv.max() - sv.min() < 11:
                    vals.append(float(np.median(sv)))
    if not vals:
        return np.array([]), []
    vals = np.sort(vals)
    groups = [[vals[0]]]
    for v in vals[1:]:
        if v - groups[-1][-1] > gap:
            groups.append([v])
        else:
            groups[-1].append(v)
    groups = [gp for gp in groups if len(gp) >= 2]
    cs = [[float(np.mean(gp)), len(gp)] for gp in groups]
    merged = [cs[0]] if cs else []
    for c, nn in cs[1:]:
        # molar roots form separate clusters below the furcation: merge within 7 mm when |s| > 35 mm
        close = merge if min(abs(c), abs(merged[-1][0])) < 35 else 7.0
        if c - merged[-1][0] < close:
            pc, pn = merged[-1]
            merged[-1] = [(pc * pn + c * nn) / (pn + nn), pn + nn]
        else:
            merged.append([c, nn])
    return np.array([m[0] for m in merged]), [m[1] for m in merged]


def _track_step(prev, D2, g2=None, root=True):
    """one 2-D tracking step (see module doc).  prev, return: int label images.
    Elevation = -intensity (roots are split at the dark gaps between them) when g2 is given,
    else -distance transform."""
    if not prev.any():
        return np.zeros_like(prev)
    E2 = g2 if g2 is not None else ndi.distance_transform_edt(D2)
    mk = np.zeros(prev.shape, np.int32)
    ids = np.unique(prev[prev > 0])
    for i in ids:
        p = prev == i
        e = ndi.binary_erosion(p, S8) if root else p
        if not (e & D2).any():
            e = p
        mk[e & D2] = i
    BONE = 1 << 20
    if root:
        dprev = ndi.distance_transform_edt(prev == 0)
        mk[D2 & (dprev > 2) & (mk == 0)] = BONE
    ws = watershed(-E2, mk, mask=D2)
    new = np.zeros_like(prev)
    for i in ids:
        p = prev == i
        c = (ws == i) & ndi.binary_dilation(p, S8)
        c = ndi.binary_fill_holes(c)
        if root and c.sum() > 1.12 * p.sum() + 3 + max(0, 25 - p.sum()):
            c = ndi.binary_dilation(ndi.binary_erosion(p, S8), S8) & D2
        cc, n = ndi.label(c, S8)
        if n:
            a = np.bincount(cc.ravel())
            a[0] = 0
            c = np.isin(cc, np.nonzero(a >= 3)[0])
        new[c & (new == 0)] = i
    return new


def segment_teeth(G, B, lm, frame, dent, td=1350.0, shell_post=4, shell_ant=2, log_fn=log):
    """Returns (labels in the dental box: 0 / tooth index 1..n, teeth info list, diagnostics)."""
    v = frame.vox
    g = dent.g
    z0, z1, y0, y1, x0, x1 = dent.box
    dz = dent.dz
    S3 = np.broadcast_to(dent.sarch[None], g.shape)
    D3 = np.broadcast_to(dent.darch[None], g.shape)
    # z of the occlusal plane at the middle of the arch
    xm = (lm["MolR"][0] + lm["MolL"][0]) / 2
    ym = (lm["MolR"][1] + lm["U1tip"][1]) / 2
    zocc = dent.occ[0] + dent.occ[1] * xm + dent.occ[2] * ym
    diag = {"occlusal_plane_z_at_arch_centre": float(zocc)}
    arches = {
        "lower": dict(zr=range(int(round(zocc - 9.0 / v)), int(round(zocc - 4.8 / v)) + 1),
                      band=(-6.5, -2.5), dirn=-1),
        "upper": dict(zr=range(int(round(zocc + 4.8 / v)), int(round(zocc + 12.5 / v)) + 1),
                      band=(2.5, 7.0), dirn=+1),
    }
    seeds = np.zeros(g.shape, np.int32)
    teeth = []
    for arch, P in arches.items():
        c, cnt = _seed_clusters(dent, P["zr"], td)
        diag["clusters_" + arch] = [round(float(x), 2) for x in c]
        diag["cluster_support_" + arch] = cnt
        log_fn("teeth: %s arch clusters (arc mm) %s" % (arch, np.round(c, 1).tolist()))
        if len(c) == 0:
            continue
        # FDI: right side s < 0 (patient right = -x), count outward from the midline gap
        right = [i for i in range(len(c)) if c[i] < 0]
        left = [i for i in range(len(c)) if c[i] >= 0]
        qR, qL = (1, 2) if arch == "upper" else (4, 3)
        fdi = {}
        for order, i in enumerate(sorted(right, key=lambda i: -c[i])):
            fdi[i] = qR * 10 + order + 1
        for order, i in enumerate(sorted(left, key=lambda i: c[i])):
            fdi[i] = qL * 10 + order + 1
        edges = np.r_[c[0] - 6, (c[1:] + c[:-1]) / 2, c[-1] + 6]
        for i, sc in enumerate(c):
            lo, hi = edges[i] + 1.0, edges[i + 1] - 1.0
            m = (g > td) & (D3 < 6) & (dz > P["band"][0]) & (dz < P["band"][1]) & (S3 > lo) & (S3 < hi)
            m = ndi.binary_erosion(m)
            if not m.any():
                log_fn("teeth: no seed for cluster %.1f (%s)" % (sc, arch))
                continue
            m = largest_cc(m)
            lab = len(teeth) + 1
            seeds[m] = lab
            teeth.append(dict(index=lab, arch=arch, s=float(sc), fdi=int(fdi[i]),
                              lo=float(edges[i]), hi=float(edges[i + 1])))
    # ---- root markers by 2-D slice tracking (capped)
    markers = seeds.copy()
    Df = fill_small_holes_2d(g > td)
    for arch, P in arches.items():
        tl = [t for t in teeth if t["arch"] == arch]
        if not tl:
            continue
        dirn = P["dirn"]
        ids = [t["index"] for t in tl]
        cap = {t["index"]: 0.55 * ROOT_LEN[arch][min(t["fdi"] % 10, 8) - 1] for t in tl}
        zs = {}
        for t in tl:
            zz = np.nonzero((seeds == t["index"]).any((1, 2)))[0]
            zs[t["index"]] = (zz.min(), zz.max())
        # start slice: apical edge of the seed band at the arch centre; full cross-sections there,
        # partitioned by the arc-length intervals of the clusters
        kstart = int(round(zocc + (P["band"][0] if dirn < 0 else P["band"][1]) / v)) - z0
        prev = np.zeros(g.shape[1:], np.int32)
        for t in tl:
            sec = Df[kstart] & (dent.darch < 7) & (dent.sarch > t["lo"] + 0.3) & (dent.sarch < t["hi"] - 0.3)
            if sec.any():
                sec = largest_cc(sec, S8)
                prev[sec & (prev == 0)] = t["index"]
                zs[t["index"]] = (kstart, kstart)
        k = kstart + dirn
        while 0 <= k < g.shape[0] and prev.any():
            new = _track_step(prev, Df[k], g[k], root=True)
            for i in ids:
                kk = zs[i][0] if dirn < 0 else zs[i][1]
                if abs(k - kk) * v > cap[i]:
                    new[new == i] = 0
            markers[k][(new > 0) & (markers[k] == 0)] = new[(new > 0) & (markers[k] == 0)]
            prev = new
            k += dirn
    # 2-D erosion of tracked markers (keep the seed core)
    er = np.zeros_like(markers)
    for k in range(markers.shape[0]):
        if markers[k].any():
            for i in np.unique(markers[k][markers[k] > 0]):
                e = ndi.binary_erosion(markers[k] == i, S8)
                er[k][e] = i
    markers = np.where(seeds > 0, seeds, er)
    # ---- cortical shell (bone marker), EDT watershed
    pad = 10
    zb0, yb0, xb0 = max(z0 - pad, 0), max(y0 - pad, 0), max(x0 - pad, 0)
    Fb = np.asarray(B[zb0:z1 + pad, yb0:y1 + pad, xb0:x1 + pad])
    F = np.stack([ndi.binary_fill_holes(s) for s in Fb])
    dep = ndi.distance_transform_edt(F)[z0 - zb0:z0 - zb0 + g.shape[0],
                                       y0 - yb0:y0 - yb0 + g.shape[1],
                                       x0 - xb0:x0 - xb0 + g.shape[2]]
    shd = np.where(np.abs(S3) > 15, shell_post, shell_ant)
    near_mk = ndi.binary_dilation(markers > 0, iterations=1)
    shell = Df & (dep <= shd) & (np.abs(dz) > 8) & ~near_mk
    Dm = Df & ~shell
    E = ndi.distance_transform_edt(Dm).astype(np.float32)
    BONE = 10000
    # pass 1: per-tooth markers vs bone on the distance transform (contacts = necks)
    mk = np.where(Dm, markers, 0).astype(np.int32)
    bm = (Df & ((dz < -30) | (dz > 30) | ((D3 > 10) & (np.abs(S3) > 28)))) | shell
    mk[bm & (mk == 0)] = BONE
    L1 = watershed(-E, mk, mask=Df)
    L1[L1 == BONE] = 0
    # pass 2 (per arch): re-split the roots on intensity (dark PDL / inter-radicular gaps), which
    # resolves the competition of thin adjacent roots that the distance transform cannot;
    # crowns (|dz| < 6 mm) keep their pass-1 labels as markers.
    lab = np.zeros_like(L1)
    for arch in ("upper", "lower"):
        ids = [t["index"] for t in teeth if t["arch"] == arch]
        region = np.isin(L1, ids)
        if not region.any():
            continue
        mk2 = np.where(region & (markers > 0) & np.isin(markers, ids), markers, 0)
        crown = region & (np.abs(dz) < 6.0)
        mk2[crown] = L1[crown]
        la = watershed(-g, mk2.astype(np.int32), mask=region)
        lab[region] = la[region]
    DEBUG.update(seeds=seeds, markers=markers, ws=lab.copy(), shell=shell)
    # ---- per-tooth cleanup: opening r=2 + reconstruction (strips thin cortical sheets)
    out = np.zeros(g.shape, np.int16)
    b2 = ball(2)
    for t in teeth:
        i = t["index"]
        m = lab == i
        if not m.any():
            continue
        sl = bbox(m, 4)
        mm = m[sl]
        core = ndi.binary_opening(mm, b2)
        cc, n = ndi.label(core, S26)
        if n:
            a = np.bincount(cc.ravel(), weights=(markers[sl] == i).ravel().astype(float))
            a[0] = -1
            core = cc == int(np.argmax(a))
        else:
            core = mm
        for _ in range(3):
            core = ndi.binary_dilation(core) & mm
        o = out[sl]
        o[core] = i
    # ---- halo: grow <= 2 voxels into partial-volume voxels (not into labelled bone dentin)
    bone_dentin = Df & (out == 0)
    Bbox = np.asarray(B[z0:z1, y0:y1, x0:x1])
    crown_zone = (dz > -9.0) & (dz < 10.0)
    free = ((g > 900) | (crown_zone & Bbox & (g > 450))) & ~bone_dentin
    cur = out.copy()
    for _ in range(2):
        d = ndi.grey_dilation(cur, size=(3, 3, 3))
        add = (cur == 0) & free & (d > 0)
        cur[add] = d[add]
    out = cur
    for t in teeth:
        m = out == t["index"]
        if m.any():
            sl = bbox(m, 1)
            f = ndi.binary_fill_holes(m[sl]) & (out[sl] == 0)
            o = out[sl]
            o[f] = t["index"]
            # keep the largest 26-connected component
            mm = out[sl] == t["index"]
            lc = largest_cc(mm)
            o[mm & ~lc] = 0
    diag["shell_voxels"] = int(shell.sum())
    return out, teeth, diag


def _track_root_core(mm, dz, upper, start_mm=8.0, grow=1.05):
    """2-D tracking of a tooth label toward its apex (axial slices).  Starting at the cervical level
    (|dz| = start_mm from the occlusal plane) each slice may only keep label voxels within one voxel
    of the previous slice's core, and the cross-section may not grow by more than `grow` (roots
    taper).  Thin strips that join the root laterally further down (cortical plates) are left out."""
    nz = mm.shape[0]
    med = np.array([np.median(dz[k][mm[k]]) if mm[k].any() else np.nan for k in range(nz)])
    ks = [k for k in range(nz) if not np.isnan(med[k])]
    out = np.zeros_like(mm)
    if upper:
        st = [k for k in ks if med[k] >= start_mm]
        if not st:
            return mm.copy()
        k0 = st[0]
        seq, crown = range(k0 + 1, nz), [k for k in ks if k < k0]
    else:
        st = [k for k in ks if med[k] <= -start_mm]
        if not st:
            return mm.copy()
        k0 = st[-1]
        seq, crown = range(k0 - 1, -1, -1), [k for k in ks if k > k0]
    for k in crown:
        out[k] = mm[k]
    prev = mm[k0].copy()
    out[k0] = prev
    for k in seq:
        C = mm[k]
        if not C.any() or not prev.any():
            break
        cand = C & ndi.binary_dilation(prev, S8)
        if cand.sum() > prev.sum() * grow + 4:
            cand = C & prev
        if not cand.any():
            break
        out[k] = cand
        prev = cand
    return out


def refine_teeth(tlab, teeth, dent, Bbox, markers, crown_mm=7.0, root_zone_mm=10.0, surf_vox=2.0,
                 enclose_hu=1200.0, max_loss=0.25, max_short_mm=4.5, track_start_mm=8.0, track_grow=1.05,
                 log_fn=log):
    """Second, per-tooth pass that separates each tooth from the bone around it (in place on tlab,
    dental-box coordinates).

    The first pass (``segment_teeth``) splits teeth from each other well, but where a root lies
    against the cortical plate its label can run along the plate (thin 'fins', worst at the lower
    molars, premolars and canines).  Here every tooth is re-segmented against its own neighbourhood
    with a marker watershed on -intensity, so the boundary follows the dark PDL / lamina-dura line:
      * tooth marker = the first-pass root markers and the crown (|dz| < crown_mm), restricted to
        the 2-D tracked root core (``_track_root_core``) and eroded by 2 voxels;
      * bone marker  = bone voxels within 3 voxels of the tooth, plus tooth-labelled voxels on the
        outer jaw surface (depth <= surf_vox inside the filled jaw outline) in the root zone
        (|dz| > root_zone_mm) of the lower teeth and upper molars: there a root never forms the outer
        surface of the jaw;
      * the result is the component connected to the crown.
    A tooth that would lose more than max_loss of its voxels or max_short_mm of height keeps its
    first-pass label (safety net).  Finally voxels enclosed by the tooth (3-D hole fill after a 1-voxel closing) that are >= enclose_hu
    are given to the tooth (dentin that the first pass labelled as bone), and stray pieces are dropped.
    Returns per-tooth diagnostics (voxels removed / added)."""
    g, dz = dent.g, dent.dz
    F = np.stack([ndi.binary_fill_holes(sl_) for sl_ in (Bbox | (tlab > 0))])
    dep = ndi.distance_transform_edt(F).astype(np.float32)
    del F
    b2 = ball(2)
    diag = {}
    for t in teeth:
        i = t["index"]
        m = tlab == i
        if not m.any():
            continue
        sl = bbox(m, 5)
        mm = m[sl]
        Ls = tlab[sl]
        dzs = dz[sl]
        core = _track_root_core(mm, dzs, t["arch"] == "upper", start_mm=track_start_mm, grow=track_grow)
        # molar roots are wide and their fins thick: erode their core more before it becomes a marker
        se = ball(3) if t["fdi"] % 10 >= 6 else b2
        mk_t = ndi.binary_erosion(core, se) | (ndi.binary_erosion(mm, iterations=1) & (np.abs(dzs) < crown_mm))
        zone = np.abs(dzs) > root_zone_mm
        # outer-surface rule only where the jaw has a real cortical plate over the roots: the lower arch
        # and the upper molars (upper incisor / canine / premolar roots often form the labial surface
        # themselves: thin or missing plate over the canine eminence)
        use_surf = t["arch"] == "lower" or t["fdi"] % 10 >= 6
        surf = mm & zone & (dep[sl] <= surf_vox) if use_surf else np.zeros_like(mm)
        mk_t &= ~ndi.binary_dilation(surf, iterations=2)
        if not mk_t.any():
            continue
        mk_t = largest_cc(mk_t)
        # in the crown zone only the tooth's own voxels take part (no bone there to compete with)
        region = ndi.binary_dilation(mm, iterations=3) & (Bbox[sl] | mm) & ((Ls == 0) | (Ls == i)) & \
            (mm | (np.abs(dzs) >= crown_mm))
        # the root canal opens at the apex, so it is not a 3-D hole of the label; close it per axial
        # slice so that canal voxels in the bone mask never become bone markers inside the root
        mmf = np.stack([ndi.binary_fill_holes(k_) for k_ in mm])
        region |= mmf
        mk = np.zeros(mm.shape, np.int32)
        mk[region & ~mmf] = 2
        mk[surf] = 2
        mk[mk_t] = 1
        ws = watershed(-g[sl], mk, mask=region)
        new = largest_cc(ws == 1)
        # dentin enclosed by the tooth but labelled bone by the first pass (pulp-shaped islands)
        cl = ndi.binary_closing(new, iterations=1)
        enc = ndi.binary_fill_holes(cl) & ~new & (g[sl] >= enclose_hu) & region
        new |= enc
        # safety net: a tooth may lose its cortical fins but not a large part of itself
        n0, n1 = int(mm.sum()), int(new.sum())
        zr0 = np.ptp(np.nonzero(mm.any((1, 2)))[0])
        zr1 = np.ptp(np.nonzero(new.any((1, 2)))[0]) if n1 else 0
        if n1 < (1.0 - max_loss) * n0 or (zr0 - zr1) * dent.frame.vox > max_short_mm:
            log_fn("teeth refine: %d would lose %.0f %% / %.1f mm of height - kept the first-pass label"
                   % (t["fdi"], 100 * (1 - n1 / max(n0, 1)), (zr0 - zr1) * dent.frame.vox))
            diag[t["fdi"]] = dict(removed_vox=0, added_vox=0, enclosed_dentin_vox=0, reverted=True)
            continue
        rem = mm & ~new
        add = new & ~mm
        Ls[rem] = 0
        Ls[add & (Ls == 0)] = i
        diag[t["fdi"]] = dict(removed_vox=int(rem.sum()), added_vox=int(add.sum()), enclosed_dentin_vox=int(enc.sum()))
    tot_r = sum(d["removed_vox"] for d in diag.values())
    tot_a = sum(d["added_vox"] for d in diag.values())
    log_fn("teeth refine: %d voxels returned to bone (%.0f mm3), %d added" % (tot_r, tot_r * 0.091125, tot_a))
    return diag


def absorb_enclosed_dentin(lab, G, tooth_ids, bone_ids, hu=1200.0, close_iter=2):
    """final safety net after all labels are merged: bone-labelled voxels >= hu enclosed by a tooth
    (3-D fill after closing) are relabelled to that tooth.  Furcation bone is < hu and stays."""
    moved = {}
    for lid in tooth_ids:
        m = lab == lid
        if not m.any():
            continue
        sl = bbox(m, close_iter + 2)
        mm = m[sl]
        enc = ndi.binary_fill_holes(ndi.binary_closing(mm, iterations=close_iter)) & ~mm
        sub = lab[sl]
        sel = enc & np.isin(sub, bone_ids) & (np.asarray(G[sl]) >= hu)
        if sel.any():
            sub[sel] = lid
            moved[int(lid - TOOTH_BASE)] = int(sel.sum())
    return moved


def tooth_stats(mask_vox_xyz, frame, arch, fdi):
    """long axis, length, tip/apex, approximate centre of resistance.  mask_vox_xyz: (n,3) x,y,z"""
    P = frame.vox_to_gl(mask_vox_xyz)
    c = P.mean(0)
    u, s, vt = np.linalg.svd(P - c, full_matrices=False)
    ax = vt[0]
    # orient the axis from apex to crown: upper teeth crown is down (-y GL), lower up
    if (arch == "upper" and ax[1] > 0) or (arch == "lower" and ax[1] < 0):
        ax = -ax
    t = (P - c) @ ax
    tip = c + ax * np.percentile(t, 99.7)
    apex = c + ax * np.percentile(t, 0.3)
    length = float(np.percentile(t, 99.7) - np.percentile(t, 0.3))
    cres = apex + 0.40 * (tip - apex)
    return dict(centroid=c, axis=ax, tip=tip, apex=apex, length=length, cres=cres,
                elong=float(s[0] / max(s[1], 1e-6)))


# --------------------------------------------------------------------------------------------
# 4. bones: cranium / mandible / spine
# --------------------------------------------------------------------------------------------
def separate_bones(G, B, teeth_full, lm, frame):
    """marker watershed on -G within the bone mask (teeth removed)."""
    v = frame.vox
    Bt = B & (teeth_full == 0)
    zz, yy, xx = np.nonzero(Bt.any((1, 2)))[0], np.nonzero(Bt.any((0, 2)))[0], np.nonzero(Bt.any((0, 1)))[0]
    box = (zz.min(), zz.max() + 1, yy.min(), yy.max() + 1, xx.min(), xx.max() + 1)
    z0, z1, y0, y1, x0, x1 = box
    b = Bt[z0:z1, y0:y1, x0:x1]
    g = np.asarray(G[z0:z1, y0:y1, x0:x1])
    Z, Y, X = grid_xyz(box)

    def ballm(p, r_mm):
        r = r_mm / v
        return ((X - p[0]) ** 2 + (Y - p[1]) ** 2 + (Z - p[2]) ** 2) <= r * r

    mk = np.zeros(g.shape, np.int32)
    # cranium: vault above S + a ball around N
    mk[b & ((Z > lm["S"][2] + 25 / v) | ballm(lm["N"], 12))] = 1
    mand = ballm(lm["Me"], 11) | ballm(lm["Pog"], 8) | ballm(lm["GoR"], 7) | ballm(lm["GoL"], 7)
    for sd in ("R", "L"):     # condylar necks (75 % of the way from gonion to condylion)
        mand |= ballm(lm["Go" + sd] + 0.75 * (lm["Co" + sd] - lm["Go" + sd]), 3)
        # inside the condylar head: 4 mm below condylion (the low-density head otherwise floods
        # from the fossa side)
        mand |= ballm(lm["Co" + sd] - np.array([0, 0, 4.0 / v]), 3.5)
    mk[b & mand] = MANDIBLE_TMP
    Ba = lm["Ba"]
    spine = (Z < Ba[2] - 16 / v) & (Y > Ba[1] - 14 / v) & (np.abs(X - Ba[0]) < 14 / v)
    mk[b & spine & (mk == 0)] = 2
    ws = watershed(-g, mk, mask=b)
    out = np.zeros(B.shape, np.uint8)
    out[z0:z1, y0:y1, x0:x1] = ws.astype(np.uint8)
    return out


def separate_joint_gaps(lab, G, a_ids, b_ids, thr=700.0, iters=2):
    """remove low-density voxels where label groups a and b touch (joint spaces)."""
    A = np.isin(lab, a_ids)
    Bm = np.isin(lab, b_ids)
    removed = 0
    for _ in range(iters):
        ca = A & ndi.binary_dilation(Bm, S26)
        cb = Bm & ndi.binary_dilation(A, S26)
        rm = (ca | cb) & (G < thr)
        if not rm.any():
            break
        lab[rm] = 0
        A &= ~rm
        Bm &= ~rm
        removed += int(rm.sum())
    # anything still touching: assign the contact layer of B-group to background
    ca = A & ndi.binary_dilation(Bm, S26)
    return removed, int(ca.sum())


def _component_table(mask, G, structure=S26, min_size=1):
    """connected components -> (cc, list of dict(k, size, median_hu, com_zyx, slices))"""
    cc, n = ndi.label(mask, structure)
    if n == 0:
        return cc, []
    sz = np.bincount(cc.ravel(), minlength=n + 1)
    objs = ndi.find_objects(cc)
    rows = []
    for k in range(1, n + 1):
        if sz[k] < min_size:
            continue
        o = objs[k - 1]
        cm = cc[o] == k
        vals = np.asarray(G[o])[cm]
        pts = np.argwhere(cm) + [s_.start for s_ in o]
        rows.append(dict(k=k, size=int(sz[k]), median_hu=float(np.median(vals)), com_zyx=pts.mean(0), slices=o))
    return cc, rows


def hyoid_test(com_zyx, lm, frame):
    """is a bone fragment centred at com_zyx where the hyoid lives?  below menton, in front of the
    cervical vertebral bodies (basion + 30 mm anterior), behind the chin, within 30 mm of the midline."""
    an = frame.vox_to_anat(np.asarray(com_zyx, float)[::-1])
    me = frame.vox_to_anat(lm["Me"])
    ba = frame.vox_to_anat(lm["Ba"])
    return bool(an[2] < me[2] - 3.0 and ba[1] + 30.0 < an[1] < me[1] - 8.0 and abs(an[0]) < 30.0)


def assign_residual_islands(lab, B, teeth_full, G, lm, frame, dent, near_mm=3.0, min_hu=550.0,
                            min_size=30, hyoid_min_hu=380.0, log_fn=log):
    """Bone-mask components that received no label from the marker watershed (no marker inside:
    pieces cut off by the occlusal-streak removal, thin bridges lost to the threshold, the hyoid).
      * median HU < min_hu or size < min_size: dropped (dense soft tissue, streaks, speckle);
      * in the hyoid region (``hyoid_test``) with median >= hyoid_min_hu: hyoid;
      * otherwise: the bone label with the most voxels within near_mm, preferring the mandible below
        the occlusal plane and the cranium above it; islands with no bone within near_mm are dropped.
    Returns a summary dict."""
    v = frame.vox
    resid = B & (lab == 0) & (teeth_full == 0)
    cc, rows = _component_table(resid, G)
    r = int(np.ceil(near_mm / v))
    cand_ids = [PIECE_LABEL["cranium"], MANDIBLE_TMP, PIECE_LABEL["spine"]]
    summ = dict(dropped_low_hu=0, dropped_small=0, dropped_isolated=0, hyoid=0, assigned={})
    big_unassigned = []
    for row in rows:
        k, sz = row["k"], row["size"]
        o = row["slices"]
        if sz < min_size:
            summ["dropped_small"] += sz
            continue
        # the hyoid is thin cortex around marrow and sits at the bottom edge of the field of view:
        # its median is only ~430-450 HU after smoothing, so it gets its own, lower density limit
        if hyoid_test(row["com_zyx"], lm, frame) and row["median_hu"] >= hyoid_min_hu and sz >= 200:
            lab[o][cc[o] == k] = PIECE_LABEL["hyoid"]
            summ["hyoid"] += sz
            continue
        if row["median_hu"] < min_hu:
            summ["dropped_low_hu"] += sz
            if sz > 400:
                big_unassigned.append(("low HU", row))
            continue
        cz, cy, cx = row["com_zyx"]
        oo = tuple(slice(max(s_.start - r, 0), s_.stop + r) for s_ in o)
        comp = cc[oo] == k
        ring = ndi.binary_dilation(comp, iterations=r) & ~comp
        nb = lab[oo][ring]
        counts = {j: int((nb == j).sum()) for j in cand_ids}
        if max(counts.values()) == 0:
            summ["dropped_isolated"] += sz
            if sz > 400:
                big_unassigned.append(("isolated", row))
            continue
        zocc = dent.occ[0] + dent.occ[1] * cx + dent.occ[2] * cy
        pref = MANDIBLE_TMP if cz < zocc else PIECE_LABEL["cranium"]
        j = pref if counts[pref] > 0 else max(counts, key=counts.get)
        lab[oo][comp] = j
        name = "mandible" if j == MANDIBLE_TMP else LABELS[j]
        summ["assigned"][name] = summ["assigned"].get(name, 0) + sz
    summ["largest_unassigned"] = [dict(reason=w, voxels=row["size"], median_hu=round(row["median_hu"]),
                                       gl=frame.vox_to_gl(row["com_zyx"][::-1]).round(1).tolist())
                                  for w, row in sorted(big_unassigned, key=lambda x: -x[1]["size"])[:8]]
    log_fn("residual islands: %s" % {k_: v_ for k_, v_ in summ.items() if k_ != "largest_unassigned"})
    return summ


def finalize_spine_hyoid(lab, G, lm, frame, log_fn=log):
    """spine = its largest component only; other spine components in the hyoid region join the
    hyoid, the rest are dropped.  Returns (spine components, hyoid components, moved voxels)."""
    sp, hy = PIECE_LABEL["spine"], PIECE_LABEL["hyoid"]
    m = lab == sp
    moved = dropped = 0
    if m.any():
        cc, rows = _component_table(m, G)
        if len(rows) > 1:
            main = max(rows, key=lambda r_: r_["size"])
            for row in rows:
                if row is main:
                    continue
                o = row["slices"]
                sel = cc[o] == row["k"]
                if hyoid_test(row["com_zyx"], lm, frame):
                    lab[o][sel] = hy
                    moved += row["size"]
                else:
                    lab[o][sel] = 0
                    dropped += row["size"]
    # hyoid: drop specks (< 200 voxels)
    h = lab == hy
    if h.any():
        cc, rows = _component_table(h, G)
        for row in rows:
            if row["size"] < 200:
                lab[row["slices"]][cc[row["slices"]] == row["k"]] = 0
    ns = ndi.label(lab == sp, S26)[1]
    nh = ndi.label(lab == hy, S26)[1]
    log_fn("spine: %d component(s); hyoid: %d component(s); %d voxels moved spine->hyoid, %d dropped" % (ns, nh, moved, dropped))
    return ns, nh, moved


def fill_condyle_gaps(lab, B, teeth_full, lm, frame, radius_mm=11.0, clear_vox=3, iters=4):
    """bone-mask voxels of the condylar head left unlabelled by the joint-gap step (medial / lateral
    poles) join the mandible when they touch it and are at least clear_vox voxels from the cranium."""
    v = frame.vox
    added = 0
    for side in ("R", "L"):
        co = lm["Co" + side]
        r = int(np.ceil(radius_mm / v))
        z0, y0, x0 = [int(max(np.floor(co[i] - r), 0)) for i in (2, 1, 0)]
        z1, y1, x1 = int(min(co[2] + r + 1, lab.shape[0])), int(min(co[1] + r + 1, lab.shape[1])), int(min(co[0] + r + 1, lab.shape[2]))
        sub = lab[z0:z1, y0:y1, x0:x1]
        Z, Y, X = grid_xyz((z0, z1, y0, y1, x0, x1))
        sph = ((X - co[0]) ** 2 + (Y - co[1]) ** 2 + (Z - co[2]) ** 2) <= r * r
        free = sph & np.asarray(B[z0:z1, y0:y1, x0:x1]) & (sub == 0) & (teeth_full[z0:z1, y0:y1, x0:x1] == 0)
        free &= ~ndi.binary_dilation(sub == PIECE_LABEL["cranium"], iterations=clear_vox)
        for _ in range(iters):
            add = free & ndi.binary_dilation(sub == MANDIBLE_TMP, S26)
            if not add.any():
                break
            sub[add] = MANDIBLE_TMP
            free &= ~add
            added += int(add.sum())
    return added


def trim_joint_faces(lab, G, lm, frame, radius_mm=12.0, min_mm=1.5, max_hu=650.0):
    """TMJ: the condylar heads of this scan are low-density and the label still reaches into the
    partial-volume layer of the ~2 mm joint space.  Inside a sphere around each condylion, mandible
    voxels closer than min_mm (voxel centres) to the cranium label and below max_hu are unlabelled,
    so the meshes keep a visible joint space (about 1 mm surface to surface)."""
    v = frame.vox
    removed = 0
    for side in ("R", "L"):
        co = lm["Co" + side]
        r = int(np.ceil(radius_mm / v))
        z0, y0, x0 = [int(max(np.floor(co[i] - r), 0)) for i in (2, 1, 0)]
        z1, y1, x1 = int(min(co[2] + r + 1, lab.shape[0])), int(min(co[1] + r + 1, lab.shape[1])), int(min(co[0] + r + 1, lab.shape[2]))
        sub = lab[z0:z1, y0:y1, x0:x1]
        Z, Y, X = grid_xyz((z0, z1, y0, y1, x0, x1))
        sph = ((X - co[0]) ** 2 + (Y - co[1]) ** 2 + (Z - co[2]) ** 2) <= r * r
        d = ndi.distance_transform_edt(sub != PIECE_LABEL["cranium"]) * v
        rm = sph & (sub == MANDIBLE_TMP) & (d < min_mm) & (np.asarray(G[z0:z1, y0:y1, x0:x1]) < max_hu)
        sub[rm] = 0
        removed += int(rm.sum())
    return removed


def clean_thin_slivers(lab, ids, neighbours, G=None, open_r=1):
    """thickness filter: parts of a piece that do not survive an opening (ball open_r) and are not
    within one voxel of the opened main body are given to the neighbouring piece with the most
    contact (interleaved strips left by stepped cuts).  Pieces with no neighbour contact stay."""
    moved = 0
    se = ball(open_r)
    for lid in ids:
        m = lab == lid
        if not m.any():
            continue
        sl = bbox(m, 2)
        mm = m[sl]
        o = ndi.binary_opening(mm, se)
        if not o.any():
            continue
        main = ndi.binary_dilation(largest_cc(o), S26) & mm
        rest = mm & ~main
        if not rest.any():
            continue
        cc, n = ndi.label(rest, S26)
        sub = lab[sl]
        objs = ndi.find_objects(cc)
        for k in range(1, n + 1):
            oo = tuple(slice(max(s_.start - 1, 0), s_.stop + 1) for s_ in objs[k - 1])
            comp = cc[oo] == k
            ring = ndi.binary_dilation(comp, S26) & ~comp
            nb = sub[oo][ring]
            counts = [(int((nb == j).sum()), j) for j in neighbours if j != lid]
            if not counts:
                continue
            cnt, j = max(counts)
            own = int((nb == lid).sum())
            if cnt > 0 and cnt >= 0.5 * own:
                sub[oo][comp] = j
                moved += int(comp.sum())
    return moved


def clean_crown_specks(lab, G, dent, ids, max_hu=550.0, band_mm=6.0):
    """dense soft-tissue specks (cheek, gingiva; 400-550 HU) attached to the jaw pieces by thin
    bridges next to the crowns: after a 1-voxel opening, components other than the main body whose
    median HU < max_hu and that lie within band_mm of the occlusal plane are removed."""
    z0, z1, y0, y1, x0, x1 = dent.box
    removed = 0
    for lid in ids:
        sub = lab[z0:z1, y0:y1, x0:x1]
        m = sub == lid
        if not m.any():
            continue
        o = ndi.binary_opening(m, ball(1))
        main = ndi.binary_dilation(largest_cc(o), S26) & m
        rest = m & ~main
        cc, rows = _component_table(rest, dent.g)
        for row in rows:
            oo = row["slices"]
            comp = cc[oo] == row["k"]
            if row["median_hu"] < max_hu and np.median(np.abs(dent.dz[oo][comp])) < band_mm:
                sub[oo][comp] = 0
                removed += row["size"]
        # pieces that are now floating near the crowns with low density
        cc, rows = _component_table(sub == lid, dent.g)
        if len(rows) > 1:
            big = max(r_["size"] for r_ in rows)
            for row in rows:
                if row["size"] < big and row["size"] < 3000:
                    oo = row["slices"]
                    comp = cc[oo] == row["k"]
                    if row["median_hu"] < max_hu and np.median(np.abs(dent.dz[oo][comp])) < band_mm:
                        sub[oo][comp] = 0
                        removed += row["size"]
    return removed


def joint_clearance(lab, lm, frame, mov_ids, fixed_ids, radius_mm=20.0):
    """minimum centre-to-centre distance (mm) between voxels of mov_ids and fixed_ids within radius_mm
    of each condylion"""
    v = frame.vox
    out = {}
    for side in ("R", "L"):
        co = lm["Co" + side]
        r = int(np.ceil(radius_mm / v))
        z0, y0, x0 = [int(max(np.floor(co[i] - r), 0)) for i in (2, 1, 0)]
        sub = lab[z0:int(co[2] + r + 1), y0:int(co[1] + r + 1), x0:int(co[0] + r + 1)]
        fx = np.isin(sub, fixed_ids)
        mv = np.isin(sub, mov_ids)
        if not fx.any() or not mv.any():
            out[side] = None
            continue
        d = ndi.distance_transform_edt(~fx)
        out[side] = round(float(d[mv].min() * v), 2)
    return out


# --------------------------------------------------------------------------------------------
# 5. osteotomies# --------------------------------------------------------------------------------------------
# 5. osteotomies
# --------------------------------------------------------------------------------------------
def plane_from_point_normal(p_gl, n_gl):
    n = np.asarray(n_gl, float)
    n = n / np.linalg.norm(n)
    return dict(point=[round(float(x), 3) for x in p_gl], normal=[round(float(x), 5) for x in n])


def occlusal_slope(frame, dent):
    """sagittal slope of the occlusal plane in the anatomical frame: sup = a + b*ant (+ c*lat)."""
    an = frame.vox_to_anat(dent.occ_pts)
    A = np.c_[np.ones(len(an)), an[:, 1], an[:, 0]]
    coef = np.linalg.lstsq(A, an[:, 2], rcond=None)[0]
    return coef   # a, b (per mm ant), c (per mm lat)


def find_mental_foramen(G, lab, frame, dent, side, s_from, s_to, sup_lo, sup_hi, log_fn=log):
    """Search the buccal cortex of the mandible for the darkest gap (foramen).
    Returns (voxel xyz, score) or (None, None)."""
    v = frame.vox
    sgn = -1 if side == "R" else 1
    best = None
    rows = []
    sv = np.arange(min(s_from, s_to), max(s_from, s_to), 0.45)
    z0 = dent.box[0]
    for s in sv:
        q = int(np.argmin(np.abs(dent.s - s)))
        x, y = dent.ax[q], dent.ay[q]
        t, _ = dent.tangent_at(x, y)
        nrm = np.array([t[1], -t[0]])   # normal in (x,y)
        # buccal = away from the arch centre (outward); arch centre approx = mean of curve
        cen = np.array([dent.ax.mean(), dent.ay.mean()])
        if np.dot(nrm, np.array([x, y]) - cen) < 0:
            nrm = -nrm
        for zi in range(int(sup_lo), int(sup_hi)):
            tt = np.arange(-12, 16, 0.5) / v
            px = x + nrm[0] * tt
            py = y + nrm[1] * tt
            pz = np.full_like(px, zi)
            prof = ndi.map_coordinates(G, [pz, py, px], order=1)
            labp = ndi.map_coordinates(lab, [pz, py, px], order=0)
            inb = np.nonzero((prof > 600) & np.isin(labp, [MANDIBLE_TMP]))[0]
            if len(inb) == 0:
                continue
            o = inb.max()
            cort = prof[max(o - 5, 0):o + 1].max()
            rows.append((s, zi, cort, px[o], py[o]))
    if not rows:
        return None, None
    R = np.array(rows)
    # grid & smooth the cortex map
    ss = np.unique(R[:, 0])
    zs = np.unique(R[:, 1])
    M = np.full((len(zs), len(ss)), np.nan)
    PX = np.zeros_like(M)
    PY = np.zeros_like(M)
    for s, zi, c, px, py in rows:
        i, j = np.searchsorted(zs, zi), np.searchsorted(ss, s)
        M[i, j], PX[i, j], PY[i, j] = c, px, py
    med = np.nanmedian(M)
    Mf = np.where(np.isnan(M), med, M)
    Ms = ndi.gaussian_filter(Mf, 1.0)
    i, j = np.unravel_index(np.argmin(Ms), Ms.shape)
    score = float(Ms[i, j] / med)
    return np.array([PX[i, j], PY[i, j], zs[i]]), score


def apply_cuts(lab, G, lm, frame, dent, teeth, teeth_full, log_fn=log):
    """cranium -> cranium + maxilla_R/L; mandible -> body + rami + chin.  Returns plane info."""
    v = frame.vox
    info = {}
    a_occ, b_occ, c_occ = occlusal_slope(frame, dent)
    info["occlusal_plane_anat"] = dict(sup_at_N_mm=float(a_occ), slope_per_mm_ant=float(b_occ),
                                       slope_per_mm_lat=float(c_occ))
    # tooth apices (in "occlusal-parallel height" h = sup - b*ant)
    apex_h = {}
    for t in teeth:
        idx = np.argwhere(teeth_full == TOOTH_BASE + t["fdi"])
        if len(idx) == 0:
            continue
        an = frame.vox_to_anat(idx[:, ::-1])
        h = an[:, 2] - b_occ * an[:, 1]
        apex_h[t["fdi"]] = float(np.percentile(h, 99.5) if t["arch"] == "upper" else np.percentile(h, 0.5))
    # ---------------- Le Fort I
    up = [apex_h[f] for f in apex_h if f // 10 in (1, 2)]
    h_lf = max(up) + 4.5
    iof = [frame.vox_to_anat(lm[k]) for k in ("IOFR", "IOFL") if k in lm]
    iof_h = min(p[2] - b_occ * p[1] for p in iof) if iof else None
    if iof_h is not None and h_lf > iof_h - 5.0:
        log_fn("Le Fort I: lowered from %.1f to IOF-5 mm" % h_lf)
        h_lf = iof_h - 5.0
    pns = frame.vox_to_anat(lm["PNS"])
    ant_ptm = pns[1] - 2.0
    info["lefort"] = dict(height_mm=float(h_lf), highest_upper_apex_mm=float(max(up)),
                          IOF_height_mm=float(iof_h) if iof_h is not None else None,
                          posterior_limit_ant_mm=float(ant_ptm))
    idx = np.argwhere(lab == PIECE_LABEL["cranium"])
    an = frame.vox_to_anat(idx[:, ::-1]).astype(np.float32)
    below = (an[:, 2] < h_lf + b_occ * an[:, 1]) & (an[:, 1] > ant_ptm) & \
            (an[:, 2] > h_lf + b_occ * an[:, 1] - 45.0) & (np.abs(an[:, 0]) < 45.0)
    # midpalatal plane through A and PNS
    A_ = frame.vox_to_anat(lm["A"])
    fA = lambda ant: A_[0] + (pns[0] - A_[0]) * (ant - A_[1]) / (pns[1] - A_[1])
    right = an[:, 0] < fA(an[:, 1])
    sel = idx[below]
    lab[sel[:, 0], sel[:, 1], sel[:, 2]] = np.where(right[below], PIECE_LABEL["maxilla_R"],
                                                  PIECE_LABEL["maxilla_L"])
    info["midline"] = dict(lat_at_A_mm=float(A_[0]), lat_at_PNS_mm=float(pns[0]))
    # islands of each maxilla half (below the cut but not connected to the main block: septum /
    # vomer, buttress and alveolar fragments separated by thin bone) stay with the half on their side
    # of the midline; islands of dense soft tissue or streak (median < 500 HU) and specks are dropped
    info["maxilla_islands"] = {}
    for name in ("maxilla_R", "maxilla_L"):
        m = lab == PIECE_LABEL[name]
        if m.any():
            sl = bbox(m, 1)
            cc, rows = _component_table(m[sl], np.asarray(G[sl]))
            big = max(r_["size"] for r_ in rows)
            kept = dropped = 0
            o = lab[sl]
            for row in rows:
                if row["size"] == big:
                    continue
                if row["median_hu"] < 500 or row["size"] < 50:
                    o[row["slices"]][cc[row["slices"]] == row["k"]] = 0
                    dropped += row["size"]
                else:
                    kept += row["size"]
            info["maxilla_islands"][name] = dict(kept_vox=kept, dropped_vox=dropped)
    # ---------------- mandible
    idx = np.argwhere(lab == MANDIBLE_TMP)
    an = frame.vox_to_anat(idx[:, ::-1]).astype(np.float32)
    s_m = dent.s_of(idx[:, 2], idx[:, 1])
    out_lab = np.full(len(idx), PIECE_LABEL["mandible_body"], np.uint8)
    # genioplasty
    can = [apex_h[f] for f in (33, 43) if f in apex_h]
    if not can:
        can = [min(apex_h[f] for f in apex_h if f // 10 in (3, 4))]
    me = frame.vox_to_anat(lm["Me"])
    h_g = min(can) - 5.0
    if h_g < me[2] - b_occ * me[1] + 8.0:
        h_g = me[2] - b_occ * me[1] + 8.0
    # mental foramina
    mf = {}
    tdict = {t["fdi"]: t for t in teeth}
    for side, q in (("R", 4), ("L", 3)):
        s_c = tdict.get(q * 10 + 3, {}).get("s")
        s_m1 = tdict.get(q * 10 + 6, {}).get("s")
        pm = [tdict[f]["s"] for f in (q * 10 + 4, q * 10 + 5) if f in tdict]
        if s_c is None or s_m1 is None:
            continue
        zc_apex = []
        for f in (q * 10 + 4, q * 10 + 5):
            ii = np.argwhere(teeth_full == TOOTH_BASE + f)
            if len(ii):
                zc_apex.append(np.percentile(ii[:, 0], 1))
        z_apex = min(zc_apex) if zc_apex else lm["Me"][2] + 20 / v
        z_lo = lm["Me"][2] + 6 / v
        z_hi = z_apex + 3 / v
        p, score = find_mental_foramen(G, lab, frame, dent, side, s_c, s_m1, z_lo, z_hi, log_fn)
        method = "detected (buccal cortex minimum)"
        if p is None or score > 0.8:
            sm = float(np.mean(pm)) if pm else (s_c + s_m1) / 2
            q_ = int(np.argmin(np.abs(dent.s - sm)))
            p = np.array([dent.ax[q_], dent.ay[q_], (z_lo + z_apex) / 2])
            method = "fallback (between premolars, mid-body)"
            score = None
        mf[side] = dict(voxel=p, s=float(dent.s_of(p[0], p[1])), score=score, method=method)
        log_fn("mental foramen %s: %s s=%.1f score=%s" % (side, method, mf[side]["s"], score))
    sR = mf.get("R", {}).get("s", -22.0) + 5.0
    sL = mf.get("L", {}).get("s", 22.0) - 5.0
    chin = (an[:, 2] < h_g + b_occ * an[:, 1]) & (s_m > sR) & (s_m < sL)
    out_lab[chin] = PIECE_LABEL["chin"]
    info["genioplasty"] = dict(height_mm=float(h_g), lowest_canine_apex_mm=float(min(can)),
                               s_limits_mm=[float(sR), float(sL)],
                               mental_foramina={k: dict(gl=frame.vox_to_gl(d["voxel"]).round(2).tolist(),
                                                        method=d["method"], arc_mm=round(d["s"], 1))
                                                for k, d in mf.items()})
    # BSSO, per side
    h_med = a_occ + 4.0      # medial horizontal cut: 4 mm above the occlusal plane
    bsso = {}
    for side, q, sgn in (("R", 4, -1), ("L", 3, 1)):
        m7 = TOOTH_BASE + q * 10 + 7
        ii = np.argwhere(teeth_full == m7)
        if len(ii) == 0:
            ii = np.argwhere(teeth_full == TOOTH_BASE + q * 10 + 6)
        # distal surface of the last molar along the arch tangent (at the end of the arch)
        end = 0 if sgn < 0 else -1
        ex, ey = dent.ax[end], dent.ay[end]
        t, _ = dent.tangent_at(ex, ey)
        tpost = t * (1 if sgn > 0 else -1)          # pointing distally
        proj = (ii[:, 2] - ex) * tpost[0] + (ii[:, 1] - ey) * tpost[1]
        p_cut = np.array([ex, ey]) + tpost * (np.percentile(proj, 99.5) + 2.0 / v)
        sidem = (an[:, 0] < 0) if sgn < 0 else (an[:, 0] >= 0)
        post = ((idx[:, 2] - p_cut[0]) * tpost[0] + (idx[:, 1] - p_cut[1]) * tpost[1]) > 0
        h = an[:, 2] - b_occ * an[:, 1]
        above = h > h_med
        # ramus borders at the medial-cut height -> lingula; inferior-border point ahead of Go
        band = sidem & post & (np.abs(h - h_med) < 2.0)
        if band.sum() < 50:
            band = sidem & post
        ant_front = np.percentile(an[band, 1], 98)
        ant_back = np.percentile(an[band, 1], 2)
        ling_ant = ant_back + 0.5 * (ant_front - ant_back)
        go = frame.vox_to_anat(lm["GoR" if sgn < 0 else "GoL"])
        p_inf = np.array([go[1] + 12.0, go[2] - b_occ * go[1]])       # (ant, h)
        p_sup = np.array([ling_ant, h_med])
        d = p_sup - p_inf
        nline = np.array([d[1], -d[0]])          # normal in (ant, h); choose: posterior side positive
        if np.dot(nline, np.array([-1.0, 0.0])) < 0:
            nline = -nline
        behind_ling = ((an[:, 1] - p_inf[0]) * nline[0] + (h - p_inf[1]) * nline[1]) > 0
        # split surface: mid-lateral position per (y,z) column, side & posterior region only
        reg = sidem & post & ~above & ~behind_ling
        buccal = np.zeros(len(idx), bool)
        if reg.any():
            sub = idx[reg]
            yz = (sub[:, 1] - sub[:, 1].min(), sub[:, 0] - sub[:, 0].min())
            shp = (yz[0].max() + 1, yz[1].max() + 1)
            xmin = np.full(shp, 1e9)
            xmax = np.full(shp, -1e9)
            np.minimum.at(xmin, yz, sub[:, 2])
            np.maximum.at(xmax, yz, sub[:, 2])
            valid = xmax > -1e8
            mid = np.where(valid, (xmin + xmax) / 2, 0)
            w = valid.astype(float)
            mids = ndi.gaussian_filter(mid * w, 3) / np.maximum(ndi.gaussian_filter(w, 3), 1e-6)
            midv = mids[yz]
            buccal_r = (sub[:, 2] < midv) if sgn < 0 else (sub[:, 2] > midv)
            buccal[np.nonzero(reg)[0]] = buccal_r
        # above the medial cut the whole ramus/coronoid is proximal (the mandibular alveolus never
        # reaches this height), even where the inclined anterior border projects ahead of the buccal cut
        prox = sidem & (above | (post & (behind_ling | buccal)))
        out_lab[prox & ~chin] = PIECE_LABEL["ramus_" + side]
        bsso[side] = dict(buccal_cut_point_gl=frame.vox_to_gl([p_cut[0], p_cut[1],
                                                               dent.occ[0] + dent.occ[1] * p_cut[0] + dent.occ[2] * p_cut[1]]).round(2).tolist(),
                          buccal_cut_normal_gl=frame.gl_dir([tpost[0], tpost[1], 0]).round(4).tolist(),
                          medial_cut_height_mm=float(h_med),
                          lingula_est_ant_mm=float(ling_ant),
                          lingual_limit_line_ant_h_mm=[p_inf.round(2).tolist(), p_sup.round(2).tolist()])
    info["bsso"] = bsso
    lab[idx[:, 0], idx[:, 1], idx[:, 2]] = out_lab
    # clean islands of the mandibular pieces (reassign to the neighbour with the largest contact)
    for name in ("chin", "ramus_R", "ramus_L", "mandible_body"):
        reassign_islands(lab, PIECE_LABEL[name],
                         [PIECE_LABEL[n] for n in ("chin", "ramus_R", "ramus_L", "mandible_body") if n != name])
    # cranium fragments below the Le Fort I cut and in front of the pterygomaxillary limit would hang
    # in the mouth when the maxilla moves: give them to the maxilla half on their side (or drop them
    # if they are soft tissue).  The main cranium component is never touched.
    cr = lab == PIECE_LABEL["cranium"]
    cc, rows = _component_table(cr, G, min_size=20)
    moved_cr = dropped_cr = 0
    if rows:
        main = max(rows, key=lambda r_: r_["size"])
        for row in rows:
            if row is main:
                continue
            o = row["slices"]
            sel = cc[o] == row["k"]
            pts = np.argwhere(sel) + [s_.start for s_ in o]
            anr = frame.vox_to_anat(pts[:, ::-1])
            blw = (anr[:, 2] < h_lf + b_occ * anr[:, 1]) & (anr[:, 1] > ant_ptm) & (np.abs(anr[:, 0]) < 45.0)
            if blw.mean() < 0.5:
                continue
            if row["median_hu"] < 500:
                lab[o][sel] = 0
                dropped_cr += row["size"]
            else:
                rgt = anr[:, 0].mean() < fA(anr[:, 1].mean())
                lab[o][sel] = PIECE_LABEL["maxilla_R" if rgt else "maxilla_L"]
                moved_cr += row["size"]
    info["cranium_fragments_below_lefort"] = dict(moved_to_maxilla_vox=moved_cr, dropped_vox=dropped_cr)
    log_fn("cranium fragments below Le Fort I: %d voxels to the maxilla, %d dropped" % (moved_cr, dropped_cr))
    info["lefort_plane_gl"] = None
    return info, b_occ


def reassign_islands(lab, lid, neighbours, min_frac=0.03, min_abs=1500):
    m = lab == lid
    if not m.any():
        return 0
    sl = bbox(m, 2)
    mm = m[sl]
    sub = lab[sl]
    cc, n = ndi.label(mm, S26)
    if n <= 1:
        return 0
    sz = np.bincount(cc.ravel())
    sz[0] = 0
    big = sz.max()
    moved = 0
    objs = ndi.find_objects(cc)
    for k in range(1, n + 1):
        if sz[k] >= max(min_frac * big, min_abs):
            continue
        o = objs[k - 1]
        o = tuple(slice(max(s.start - 1, 0), s.stop + 1) for s in o)
        comp = cc[o] == k
        ring = ndi.binary_dilation(comp, S26) & ~comp
        nb = sub[o][ring]
        counts = [(int((nb == j).sum()), j) for j in neighbours]
        cnt, j = max(counts)
        if cnt > 0:
            sub[o][comp] = j
        else:
            if sz[k] < 300:
                sub[o][comp] = 0
            else:
                continue
        moved += int(sz[k])
    return moved


# --------------------------------------------------------------------------------------------
# 6. meshing and encoding
# --------------------------------------------------------------------------------------------
def mask_to_mesh(mask_full_sub, offset_zyx, factor, frame, sigma=1.0):
    """mask (cropped bool, z,y,x) -> (verts GL (n,3) float32, faces (m,3) int32)."""
    m = mask_full_sub.astype(np.float32)
    pad = 2 * factor
    m = np.pad(m, pad)
    f = ndi.gaussian_filter(m, sigma)
    if factor > 1:
        sh = [(s // factor) * factor for s in f.shape]
        f = f[:sh[0], :sh[1], :sh[2]]
        f = f.reshape(sh[0] // factor, factor, sh[1] // factor, factor, sh[2] // factor, factor).mean((1, 3, 5))
    if f.max() < 0.5:
        return np.zeros((0, 3), np.float32), np.zeros((0, 3), np.int32)
    verts, faces, _, _ = marching_cubes(f, 0.5, allow_degenerate=False)
    zyx = verts * factor + (factor - 1) / 2.0 - pad + np.asarray(offset_zyx, float)
    xyz = zyx[:, ::-1]
    gl = frame.vox_to_gl(xyz).astype(np.float32)
    faces = faces.astype(np.int32)
    if len(faces) and mesh_signed_volume(gl, faces) < 0:     # keep counter-clockwise = outward
        faces = faces[:, [0, 2, 1]]
    return gl, faces


def mesh_signed_volume(v, f):
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


def encode_mesh(v, f, scale=0.05):
    q = np.round(v / scale)
    if np.abs(q).max() > 32767:
        raise ValueError("mesh coordinates exceed int16 range at scale %.3f" % scale)
    pos = base64.b64encode(q.astype("<i2").tobytes()).decode("ascii")
    idx = base64.b64encode(f.astype("<u4").ravel().tobytes()).decode("ascii")
    return dict(nv=int(len(v)), ni=int(f.size), scale=scale, pos=pos, idx=idx)


# --------------------------------------------------------------------------------------------
# 7. QA renders
# --------------------------------------------------------------------------------------------
QA_COLORS = {"cranium": "#ffd54f", "spine": "#26c6da", "maxilla_R": "#ff7043", "maxilla_L": "#d81b60",
             "mandible_body": "#1e88e5", "ramus_R": "#43a047", "ramus_L": "#8e24aa", "chin": "#f06292",
             "hyoid": "#00897b"}


def qa_colormap():
    import matplotlib.colors as mcolors
    return {lid: mcolors.to_rgb(QA_COLORS[name]) for name, lid in PIECE_LABEL.items()}


def label_rgb(labslice, cols):
    import colorsys
    rgb = np.zeros(labslice.shape + (3,), np.float32)
    for lid in np.unique(labslice):
        if lid == 0:
            continue
        if lid in cols:
            c = cols[lid]
        else:   # teeth: alternate two light tints along the arch so neighbours differ
            f = int(lid) - TOOTH_BASE
            q, n = f // 10, f % 10
            c = colorsys.hsv_to_rgb((0.33 if q in (1, 3) else 0.5) + 0.06 * (n % 2), 0.35 + 0.35 * (n % 2), 1.0)
        rgb[labslice == lid] = c
    return rgb


def render_slices(G, lab, out_png, axis, positions, title, crop=None, ncol=4, annotate=True):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    cols = qa_colormap()
    n = len(positions)
    nrow = int(np.ceil(n / ncol))
    fig, axs = plt.subplots(nrow, ncol, figsize=(ncol * 5.2, nrow * 5.2))
    axs = np.atleast_1d(axs).ravel()
    for a, p in zip(axs, positions):
        if axis == "axial":
            img, l = G[p], lab[p]
            ttl = "axial z=%d (anterior down, patient L right)" % p
        elif axis == "coronal":
            img, l = G[:, p, :], lab[:, p, :]
            ttl = "coronal y=%d (patient L right)" % p
        else:
            img, l = G[:, :, p], lab[:, :, p]
            ttl = "sagittal x=%d (anterior left)" % p
        if crop is not None:
            (r0, r1), (c0, c1) = crop
            img, l = img[r0:r1, c0:c1], l[r0:r1, c0:c1]
            ext = (c0, c1, r0, r1)
        else:
            ext = (0, img.shape[1], 0, img.shape[0])
        a.imshow(np.clip((np.asarray(img, np.float32) + 200) / 2200, 0, 1), cmap="gray",
                 origin="lower", extent=ext, interpolation="nearest")
        rgb = label_rgb(np.asarray(l), cols)
        alpha = (np.asarray(l) > 0).astype(np.float32) * 0.5
        a.imshow(np.dstack([rgb, alpha]), origin="lower", extent=ext, interpolation="nearest")
        if annotate:
            for lid in np.unique(l):
                if lid >= TOOTH_BASE:
                    yy, xx = np.nonzero(np.asarray(l) == lid)
                    if len(yy) > 20:
                        a.text(ext[0] + xx.mean(), ext[2] + yy.mean(), str(lid - TOOTH_BASE),
                               color="k", fontsize=7, ha="center", va="center",
                               bbox=dict(boxstyle="round,pad=0.1", fc="w", alpha=0.6, lw=0))
        a.set_title(ttl, fontsize=9)
        a.set_xticks([])
        a.set_yticks([])
    for a in axs[n:]:
        a.axis("off")
    fig.suptitle(title, fontsize=12)
    plt.tight_layout()
    plt.savefig(out_png, dpi=75)
    plt.close(fig)


def render_tooth_gallery(G, lab, teeth_info, dent, out_png, frame, arch=None):
    """two sections per tooth through its centroid: mesio-distal (along the arch) and bucco-lingual,
    both vertical.  Red = this tooth, yellow = other teeth.  Bone window."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    ids = sorted([t for t in teeth_info if arch is None or t["arch"] == arch], key=lambda t: t["fdi"])
    if not ids:
        return
    ncol = 8
    nrow = int(np.ceil(len(ids) / ncol)) * 2
    fig, axs = plt.subplots(nrow, ncol, figsize=(ncol * 3.3, nrow * 4.6))
    axs = np.atleast_2d(axs)
    for a in axs.ravel():
        a.axis("off")
    for j, t in enumerate(ids):
        lid = TOOTH_BASE + t["fdi"]
        c = np.array(t["centroid_vox_zyx"])
        tan, _ = dent.tangent_at(c[2], c[1])
        tdir = np.array([0, tan[1], tan[0]])
        ndir = np.array([0, -tan[0], tan[1]])
        up = np.array([1.0, 0, 0])
        U, V = np.meshgrid(np.arange(-26, 27), np.arange(-40, 41))
        for k, (h, nm) in enumerate(((tdir, "MD"), (ndir, "BL"))):
            P = c[:, None, None] + h[:, None, None] * U + up[:, None, None] * V
            img = ndi.map_coordinates(G, P, order=1)
            ll = ndi.map_coordinates(lab, P, order=0)
            a = axs[(j // ncol) * 2 + k, j % ncol]
            a.imshow(img, cmap="gray", vmin=0, vmax=2800, origin="lower", interpolation="nearest")
            a.contour(ll == lid, [0.5], colors="r", linewidths=1.0)
            other = (ll >= TOOTH_BASE) & (ll != lid)
            if other.any():
                a.contour(other, [0.5], colors="y", linewidths=0.6)
            a.set_title("%d %s  %.0f mm3  L %.1f mm" % (t["fdi"], nm, t["volume_mm3"], t["length_mm"]), fontsize=8)
    fig.suptitle("teeth %s: MD = mesio-distal section, BL = bucco-lingual section (red = tooth, yellow = neighbours)"
                 % (arch or ""), fontsize=11)
    plt.tight_layout()
    plt.savefig(out_png, dpi=62)
    plt.close(fig)


def render_tooth_sections(G, lab, teeth_info, out_png, arch):
    """per tooth: five sections perpendicular to its long axis from the apex toward the crown, and two
    long-axis sections.  Red = this tooth, yellow = other teeth, cyan = bone labels.  Used to check that
    roots do not carry cortical plates ('fins') and stop at the apex."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    ids = sorted([t for t in teeth_info if t["arch"] == arch], key=lambda t: t["fdi"])
    if not ids:
        return
    fig, axs = plt.subplots(len(ids), 7, figsize=(7 * 2.3, len(ids) * 2.5))
    axs = np.atleast_2d(axs)
    A = np.arange(-22, 23)
    for r, t in enumerate(ids):
        lid = t["label"]
        m = lab == lid
        sl = bbox(m, 0)
        idx = np.argwhere(m[sl]) + [s_.start for s_ in sl]
        c = idx.mean(0)
        _, _, vt = np.linalg.svd((idx - c)[::3], full_matrices=False)
        ax = vt[0] if vt[0][0] > 0 else -vt[0]          # z-up along the tooth
        e1 = np.cross(ax, [0, 0, 1.0])
        e1 /= np.linalg.norm(e1)
        e2 = np.cross(ax, e1)
        tt_ = (idx - c) @ ax
        qs = [99, 93, 85, 72, 50] if arch == "upper" else [1, 7, 15, 28, 50]
        for k, q in enumerate(qs):
            tv = np.percentile(tt_, q)
            P = c[:, None, None] + ax[:, None, None] * tv + e1[:, None, None] * A[None, :] + e2[:, None, None] * A[:, None]
            img = ndi.map_coordinates(G, P, order=1)
            ll = ndi.map_coordinates(lab, P, order=0)
            a = axs[r, k]
            a.imshow(img, cmap="gray", vmin=0, vmax=2800, origin="lower", interpolation="nearest")
            for msk, col, lw in (((ll > 0) & (ll < TOOTH_BASE), "c", 0.5), ((ll >= TOOTH_BASE) & (ll != lid), "y", 0.6), (ll == lid, "r", 0.9)):
                if msk.any():
                    a.contour(msk, [0.5], colors=col, linewidths=lw)
            a.set_title("%d  %.1f mm from centre" % (t["fdi"], tv * 0.45), fontsize=7)
            a.axis("off")
        U, V = np.meshgrid(A, np.arange(-40, 41))
        for k, h in enumerate((e1, e2)):
            P = c[:, None, None] + h[:, None, None] * U + ax[:, None, None] * V
            img = ndi.map_coordinates(G, P, order=1)
            ll = ndi.map_coordinates(lab, P, order=0)
            a = axs[r, 5 + k]
            a.imshow(img, cmap="gray", vmin=0, vmax=2800, origin="lower", interpolation="nearest")
            for msk, col, lw in (((ll > 0) & (ll < TOOTH_BASE), "c", 0.5), ((ll >= TOOTH_BASE) & (ll != lid), "y", 0.6), (ll == lid, "r", 0.9)):
                if msk.any():
                    a.contour(msk, [0.5], colors=col, linewidths=lw)
            a.set_title("%d long axis %s  L %.1f" % (t["fdi"], "A" if k == 0 else "B", t["length_mm"]), fontsize=7)
            a.axis("off")
    fig.suptitle("teeth %s: sections across the root (apex -> crown) and along the long axis; red = tooth, yellow = other teeth, cyan = bone" % arch, fontsize=10)
    plt.tight_layout()
    plt.savefig(out_png, dpi=60)
    plt.close(fig)


def render_exploded(meshes, out_png, explode=0.6, views=(("front (patient right on the left)", 0), ("left lateral", -90), ("right anterior oblique", 40)), title=""):
    """software point-splat render of the meshes (GL frame), pieces pushed outward from the
    global centroid.  meshes: list of (id, verts, faces, rgb)."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    allc = np.concatenate([m[1] for m in meshes]).mean(0)
    fig, axs = plt.subplots(1, len(views), figsize=(7 * len(views), 8))
    for a, (vname, yaw) in zip(np.atleast_1d(axs), views):
        W, H, px = 760, 900, 0.36
        zbuf = np.full((H, W), -1e9, np.float32)
        img = np.ones((H, W, 3), np.float32)
        th = np.radians(yaw)
        Ry = np.array([[np.cos(th), 0, np.sin(th)], [0, 1, 0], [-np.sin(th), 0, np.cos(th)]])
        light = np.array([0.3, 0.5, 1.0])
        light /= np.linalg.norm(light)
        for pid, vv, ff, rgb in meshes:
            c = vv.mean(0)
            off = (c - allc) * explode
            if pid.startswith("tooth"):
                off = off * 1.6
            p = (vv + off) @ Ry.T
            # vertex normals
            n = np.zeros_like(vv)
            fn = np.cross(vv[ff[:, 1]] - vv[ff[:, 0]], vv[ff[:, 2]] - vv[ff[:, 0]])
            for k in range(3):
                np.add.at(n, ff[:, k], fn)
            n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-9
            n = n @ Ry.T
            # splat triangle centroids + vertices for density
            pts = np.concatenate([p, p[ff].mean(1)])
            nn = np.concatenate([n, n[ff].mean(1)])
            nn /= np.linalg.norm(nn, axis=1, keepdims=True) + 1e-9
            sh = np.clip(nn @ light, 0, 1) * 0.75 + 0.25
            col = np.asarray(rgb)[None] * sh[:, None]
            cr = allc @ Ry.T
            u = np.round((pts[:, 0] - cr[0]) / px + W / 2).astype(int)
            vq = np.round(-(pts[:, 1] - cr[1]) / px + H / 2).astype(int)
            d = pts[:, 2]
            for du in (0, 1):
                for dv in (0, 1):
                    uu, vv2 = u + du, vq + dv
                    ok = (uu >= 0) & (uu < W) & (vv2 >= 0) & (vv2 < H)
                    uu, vv2, dd, cc = uu[ok], vv2[ok], d[ok], col[ok]
                    order = np.argsort(dd)
                    uu, vv2, dd, cc = uu[order], vv2[order], dd[order], cc[order]
                    lin = vv2 * W + uu
                    # last write wins = nearest (largest z toward viewer)
                    zf = zbuf.ravel()
                    upd = dd > zf[lin]
                    zf[lin[upd]] = dd[upd]
                    img.reshape(-1, 3)[lin[upd]] = cc[upd]
        a.imshow(img)
        a.set_title(vname, fontsize=11)
        a.axis("off")
    fig.suptitle(title, fontsize=12)
    plt.tight_layout()
    plt.savefig(out_png, dpi=70)
    plt.close(fig)


# --------------------------------------------------------------------------------------------
# 8. driver
# --------------------------------------------------------------------------------------------
# rough whole-tooth volumes (mm3, crown + root + pulp) of adult permanent teeth, micro-CT literature
# order of magnitude (+-25 %); used only to state how far the CBCT labels are from anatomy
TYPICAL_TOOTH_VOL = {"upper": [550, 400, 700, 550, 500, 1050, 900, 750],
                     "lower": [260, 300, 550, 450, 480, 1000, 900, 750]}


def head_mask(G, vox_mm, inset_mm=3.0):
    """explicit, reproducible head mask for coverage numbers: voxels > -450 HU, holes filled per axial
    slice, largest component, eroded by inset_mm (removes the skin surface and the ear rods outside)."""
    H = G > -450
    H = np.stack([ndi.binary_fill_holes(h) for h in H])
    H = largest_cc(H, None)
    return ndi.binary_erosion(H, iterations=int(round(inset_mm / vox_mm)))


def _decimate(v, f, target):
    """quadric decimation with pyfqmr if installed; returns (v, f, method)"""
    if len(f) <= target:
        return v, f, "none"
    try:
        import pyfqmr
    except ImportError:
        return v, f, "none (pyfqmr not installed)"
    s_ = pyfqmr.Simplify()
    s_.setMesh(v.astype(np.float64), f.astype(np.int32))
    s_.simplify_mesh(target_count=int(target), aggressiveness=7, preserve_border=True, verbose=0)
    v2, f2, _ = s_.getMesh()
    return v2.astype(np.float32), f2.astype(np.int32), "pyfqmr quadric decimation"


def _save_stage(path, **arrs):
    np.savez_compressed(path, **arrs)


def run(dicom_dir, landmarks_json, out_dir, qa_dir=None, cache_dir=None, teeth_mode="auto",
        tooth_factor=1, bone_factor=3, cranium_max_tris=100000, reuse_stage=False, sim_dir=None,
        log_fn=log):
    """Full pipeline.  cache_dir: store the smoothed volume (G.npy), the bone-mask/teeth stage
    (stage_teeth.npz, reused when reuse_stage=True) and the final label volume (labels.npy).
    sim_dir: folder of sim.py for the baseline readout check (optional)."""
    t_start = time.time()
    os.makedirs(out_dir, exist_ok=True)
    if qa_dir:
        os.makedirs(qa_dir, exist_ok=True)
    analysis, lm = load_landmarks(landmarks_json)
    # ---- volume
    vol = None
    if cache_dir and os.path.exists(os.path.join(cache_dir, "G.npy")):
        G = np.load(os.path.join(cache_dir, "G.npy"))
        spacing = tuple(json.load(open(os.path.join(cache_dir, "spacing.json"))))
        log_fn("loaded cached smoothed volume", G.shape)
    else:
        vol, spacing = load_volume(dicom_dir)
        log_fn("volume", vol.shape, "spacing", spacing)
        G = ndi.gaussian_filter(vol.astype(np.float32), 0.7)
        if cache_dir:
            os.makedirs(cache_dir, exist_ok=True)
            np.save(os.path.join(cache_dir, "G.npy"), G)
            json.dump(list(spacing), open(os.path.join(cache_dir, "spacing.json"), "w"))
    if not np.allclose(spacing, spacing[0], atol=1e-3):
        log_fn("WARNING: anisotropic voxels", spacing, "- the pipeline assumes isotropic voxels")
    frame = Frame.from_analysis(analysis, spacing)
    v = frame.vox
    vox_mm3 = v ** 3
    # ---- stage 1: bone mask + teeth (cacheable)
    stage = os.path.join(cache_dir, "stage_teeth.npz") if cache_dir else None
    dent = Dental(G, lm, frame)
    if reuse_stage and stage and os.path.exists(stage):
        z = np.load(stage)
        B = np.unpackbits(z["B"])[:G.size].reshape(G.shape).astype(bool)
        tlab, markers = z["tlab"].astype(np.int32), z["markers"].astype(np.int32)
        meta = json.loads(str(z["meta"]))
        teeth, tdiag, sdiag = meta["teeth"], meta["tdiag"], meta["sdiag"]
        log_fn("reused bone mask + teeth stage from", stage)
    else:
        B, _, dropped = bone_mask(G, v)
        added, peeled = augment_condyles(G, B, lm, frame)
        log_fn("bone mask: %d voxels, %d external objects dropped, %d condylar voxels added, %d peeled"
               % (B.sum(), dropped, added, peeled))
        nstreak = remove_occlusal_streaks(B, dent, frame)
        log_fn("occlusal streak artefacts removed from the bone mask: %d voxels" % nstreak)
        tlab, teeth, tdiag = segment_teeth(G, B, lm, frame, dent, log_fn=log_fn)
        markers = DEBUG["markers"].astype(np.int32)
        sdiag = dict(external_objects_dropped=int(dropped), condyle_voxels_added=int(added),
                     condyle_voxels_peeled=int(peeled), occlusal_streak_voxels_removed=int(nstreak))
        if stage:
            _save_stage(stage, B=np.packbits(B.ravel()), tlab=tlab.astype(np.int16), markers=markers.astype(np.int16),
                        meta=json.dumps(dict(teeth=teeth, tdiag=tdiag, sdiag=sdiag)))
    z0, z1, y0, y1, x0, x1 = dent.box
    # ---- stage 2: teeth against bone (second pass)
    rdiag = refine_teeth(tlab, teeth, dent, np.asarray(B[z0:z1, y0:y1, x0:x1]), markers, log_fn=log_fn)
    teeth_full = np.zeros(G.shape, np.uint8)
    sub = teeth_full[z0:z1, y0:y1, x0:x1]
    for t in teeth:
        sub[tlab == t["index"]] = TOOTH_BASE + t["fdi"]
    log_fn("teeth: %d labelled" % len(teeth))
    # ---- stage 3: cranium / mandible / spine
    lab = separate_bones(G, B, teeth_full, lm, frame).astype(np.uint8)
    resid = assign_residual_islands(lab, B, teeth_full, G, lm, frame, dent, log_fn=log_fn)
    lab[(teeth_full > 0)] = 0
    tdil = ndi.binary_dilation(teeth_full > 0, S26, iterations=2)
    for lid in (PIECE_LABEL["cranium"], MANDIBLE_TMP, PIECE_LABEL["spine"]):
        m = lab == lid
        cc, n = ndi.label(m, S26)
        if n > 1:
            sz = np.bincount(cc.ravel())
            sz[0] = 0
            small = np.nonzero((sz > 0) & (sz < 300))[0]
            touch = np.bincount(cc.ravel(), weights=tdil.ravel().astype(np.float32), minlength=n + 1)
            drop = np.zeros(n + 1, bool)
            drop[small] = touch[small] > 0      # crown-rim crumbs
            lab[drop[cc]] = 0
    del tdil
    # partial-volume rims of the crowns (300-600 HU shell in soft tissue) picked up by the bone labels
    subl = lab[z0:z1, y0:y1, x0:x1]
    near_t = ndi.binary_dilation(teeth_full[z0:z1, y0:y1, x0:x1] > 0, S26, iterations=2)
    rim = (subl > 0) & near_t & (((dent.g < 600) & (np.abs(dent.dz) < 12.0)) |
                                 ((dent.g < 900) & (np.abs(dent.dz) < 6.0)))
    subl[rim] = 0
    log_fn("crown rims removed from bone labels: %d voxels" % int(rim.sum()))
    # ---- joint gaps (TMJ, atlanto-occipital) and the condylar poles
    rm1, left1 = separate_joint_gaps(lab, G, [MANDIBLE_TMP], [PIECE_LABEL["cranium"], PIECE_LABEL["spine"]], thr=950.0)
    rm2, left2 = separate_joint_gaps(lab, G, [PIECE_LABEL["spine"]], [PIECE_LABEL["cranium"]], thr=950.0)
    log_fn("joint gaps: removed %d / %d voxels, still touching %d / %d" % (rm1, rm2, left1, left2))
    ncond = fill_condyle_gaps(lab, B, teeth_full, lm, frame)
    log_fn("condylar pole voxels returned to the mandible: %d" % ncond)
    ntrim = trim_joint_faces(lab, G, lm, frame)
    log_fn("TMJ contact faces trimmed: %d voxels" % ntrim)
    nsp, nhy, _ = finalize_spine_hyoid(lab, G, lm, frame, log_fn=log_fn)
    # ---- stage 4: osteotomies
    for t in teeth:
        t["name"] = TOOTH_NAMES.get(t["fdi"] % 10, "tooth")
    cut_info, b_occ = apply_cuts(lab, G, lm, frame, dent, teeth, teeth_full, log_fn)
    mand_ids = [PIECE_LABEL[n] for n in ("mandible_body", "ramus_R", "ramus_L", "chin")]
    nsl = clean_thin_slivers(lab, [PIECE_LABEL["ramus_R"], PIECE_LABEL["ramus_L"], PIECE_LABEL["chin"],
                                   PIECE_LABEL["mandible_body"]], mand_ids)
    log_fn("thin slivers reassigned between mandible pieces: %d voxels" % nsl)
    nsp_ = clean_crown_specks(lab, G, dent, [PIECE_LABEL["maxilla_R"], PIECE_LABEL["maxilla_L"], PIECE_LABEL["mandible_body"]])
    log_fn("soft-tissue specks next to the crowns removed: %d voxels" % nsp_)
    # tiny disconnected cranium fragments (thin ethmoid / turbinate shards, noise) are dropped
    for lid in (PIECE_LABEL["cranium"],):
        m = lab == lid
        cc, n = ndi.label(m, S26)
        if n > 1:
            sz = np.bincount(cc.ravel())
            sz[0] = 0
            drop = (sz < 500) & (sz > 0)
            lab[drop[cc]] = 0
            log_fn("dropped %d small fragments (%d voxels) of %s" % (int(drop.sum()), int(sz[drop].sum()), LABELS[lid]))
    # merge teeth, then the enclosed-dentin safety net
    lab[teeth_full > 0] = teeth_full[teeth_full > 0]
    tooth_ids = [TOOTH_BASE + t["fdi"] for t in teeth]
    bone_ids = list(PIECE_LABEL.values())
    enc = absorb_enclosed_dentin(lab, G, tooth_ids, bone_ids)
    log_fn("enclosed dentin relabelled to teeth (safety net): %s" % enc)
    del teeth_full
    if cache_dir:
        np.save(os.path.join(cache_dir, "labels.npy"), lab)
    # ---- teeth statistics
    teeth_info = []
    for t in teeth:
        lid = TOOTH_BASE + t["fdi"]
        m = lab == lid
        if not m.any():
            continue
        sl = bbox(m, 2)
        mm = m[sl]
        idx = np.argwhere(mm) + [s_.start for s_ in sl]
        st = tooth_stats(idx[:, ::-1], frame, t["arch"], t["fdi"])
        ncomp = ndi.label(mm, S26)[1]
        vmm = len(idx) * vox_mm3
        dense = ndi.binary_fill_holes(mm & (np.asarray(G[sl]) >= 1000.0))
        dense = largest_cc(dense) if dense.any() else dense
        vden = float(dense.sum() * vox_mm3)
        ref = TYPICAL_TOOTH_VOL[t["arch"]][min(t["fdi"] % 10, 8) - 1]
        # enclosed bone check (should be 0 after absorb_enclosed_dentin)
        encl = ndi.binary_fill_holes(ndi.binary_closing(mm, iterations=2)) & ~mm
        enc_bone = int((encl & np.isin(lab[sl], bone_ids) & (np.asarray(G[sl]) >= 1200)).sum())
        lo, hi = TOOTH_VOL_RANGE.get(t["fdi"] % 10, (100, 3000))
        flags = []
        if not lo <= vmm <= hi:
            flags.append("volume %.0f mm3 outside %d-%d" % (vmm, lo, hi))
        if not 14.0 <= st["length"] <= 30.0:
            flags.append("length %.1f mm outside 14-30" % st["length"])
        if ncomp != 1:
            flags.append("%d components" % ncomp)
        teeth_info.append(dict(fdi=t["fdi"], name="%s %s" % (QUADRANT[t["fdi"] // 10], TOOTH_NAMES[t["fdi"] % 10]),
                               arch=t["arch"], label=lid, voxels=int(len(idx)), volume_mm3=round(vmm, 1),
                               volume_dense1000_mm3=round(vden, 1), typical_volume_mm3=ref,
                               label_over_typical=round(vmm / ref, 2), dense_over_typical=round(vden / ref, 2),
                               length_mm=round(st["length"], 1), components=int(ncomp),
                               enclosed_dense_bone_vox=enc_bone, refine=rdiag.get(t["fdi"], {}),
                               axis_gl=st["axis"].round(4).tolist(), tip_gl=st["tip"].round(2).tolist(),
                               apex_gl=st["apex"].round(2).tolist(), cres_gl=st["cres"].round(2).tolist(),
                               centroid_gl=st["centroid"].round(2).tolist(),
                               centroid_vox_zyx=idx.mean(0).round(2).tolist(),
                               arc_mm=round(t["s"], 1), flags=flags))
    # ---- QA numbers
    Hin = head_mask(G, v)
    lab_any = lab > 0
    cov = {}
    for thr in (400, 600, 800):
        hm = (G > thr) & Hin
        cov["%d_HU" % thr] = dict(voxels=int(hm.sum()), assigned_fraction=round(float((lab_any & hm).sum() / max(hm.sum(), 1)), 4))
    if vol is not None:     # the same numbers on the unsmoothed HU volume (only when read from DICOM)
        cov["raw_HU"] = {}
        for thr in (400, 600, 800):
            hm = (vol > thr) & Hin
            cov["raw_HU"]["%d_HU" % thr] = dict(voxels=int(hm.sum()), assigned_fraction=round(float((lab_any & hm).sum() / max(hm.sum(), 1)), 4))
        del vol
    skull400 = (G > 400) & B
    cov_mask = round(float((lab_any & skull400).sum() / max(skull400.sum(), 1)), 4)
    del Hin, skull400, lab_any
    up_teeth = [TOOTH_BASE + t["fdi"] for t in teeth if t["arch"] == "upper"]
    lo_teeth = [TOOTH_BASE + t["fdi"] for t in teeth if t["arch"] == "lower"]
    cran_ids = [PIECE_LABEL[n] for n in ("cranium", "maxilla_R", "maxilla_L", "spine", "hyoid")]
    M_all = np.isin(lab, mand_ids + lo_teeth)
    C_all = np.isin(lab, cran_ids + up_teeth)
    contact_mc = int((M_all & ndi.binary_dilation(C_all, S26)).sum())
    contact_bones = int((np.isin(lab, mand_ids) & ndi.binary_dilation(np.isin(lab, cran_ids), S26)).sum())
    contact_occl = int((np.isin(lab, lo_teeth) & ndi.binary_dilation(np.isin(lab, up_teeth), S26)).sum())
    del M_all, C_all
    clear = dict(condylar_head_within_6mm_of_Co=joint_clearance(lab, lm, frame, [PIECE_LABEL["ramus_R"], PIECE_LABEL["ramus_L"]],
                                                                [PIECE_LABEL["cranium"]], radius_mm=6.0),
                 ramus_within_20mm_of_Co=joint_clearance(lab, lm, frame, [PIECE_LABEL["ramus_R"], PIECE_LABEL["ramus_L"]],
                                                         [PIECE_LABEL["cranium"]], radius_mm=20.0))
    # cranium components below the Le Fort I cut (should be none)
    lf_h, lf_ant = cut_info["lefort"]["height_mm"], cut_info["lefort"]["posterior_limit_ant_mm"]
    cc, rows = _component_table(lab == PIECE_LABEL["cranium"], G, min_size=1)
    cr_below = []
    if rows:
        main = max(rows, key=lambda r_: r_["size"])
        for row in rows:
            if row is main:
                continue
            an = frame.vox_to_anat(row["com_zyx"][::-1])
            if an[2] < lf_h + b_occ * an[1] and an[1] > lf_ant and abs(an[0]) < 45:
                cr_below.append(dict(voxels=row["size"], gl=frame.vox_to_gl(row["com_zyx"][::-1]).round(1).tolist()))
    piece_components = {}
    for name, lid in PIECE_LABEL.items():
        if (lab == lid).any():
            piece_components[name] = int(ndi.label(lab == lid, S26)[1])
    qa = dict(
        coverage=dict(
            head_mask="G(sigma 0.7 vox) > -450 HU, holes filled per axial slice, largest component, eroded 3 mm (segment.head_mask)",
            by_threshold=cov, assigned_fraction_of_bone_mask_over_400HU=cov_mask,
            note="the unassigned share at 400 HU is mostly CBCT cupping (deep soft tissue at 400-550 HU near the skull base), "
                 "occlusal streaks and enamel partial-volume rims in soft tissue, not bone; see residual_islands.largest_unassigned"),
        residual_islands=resid, overlap_voxels=0, overlap_note="single label volume: a voxel can only carry one label",
        contact_voxels_lower_vs_upper_all=contact_mc, contact_voxels_mandible_bones_vs_cranial_bones=contact_bones,
        contact_voxels_lower_vs_upper_teeth=contact_occl,
        condyle_to_cranium_min_distance_mm=clear,
        collision_tolerance_note="voxel-centre distances between the ramus and cranium labels (a mesh surface gap is about 0.45 mm "
                                 "less). The measured joint space is about 2 mm; the labels keep less because of partial volume, so "
                                 "use about 1 mm of mesh clearance as the contact tolerance in collision tests",
        cranium_components_below_lefort=cr_below, piece_components=piece_components,
        spine_components=nsp, hyoid_components=nhy,
        teeth_enclosed_dense_bone_voxels={t["fdi"]: t["enclosed_dense_bone_vox"] for t in teeth_info if t["enclosed_dense_bone_vox"]},
        stage=sdiag)
    log_fn("QA:", json.dumps({k: qa[k] for k in ("coverage", "condyle_to_cranium_min_distance_mm", "cranium_components_below_lefort", "piece_components")}))
    # ---- landmarks
    lpts, lmem = assign_landmarks(lab, lm, frame)
    landmarks_gl = {k: frame.vox_to_gl(p).round(3).tolist() for k, p in lpts.items()}
    sets_ok = check_landmark_sets(lmem)
    qa["landmark_sets"] = sets_ok
    if sim_dir:
        qa["readout_vs_sim_baseline"] = readout_check(landmarks_gl, sim_dir, landmarks_json)
        log_fn("readout check:", {k: v_ for k, v_ in qa["readout_vs_sim_baseline"].items() if k != "key_metrics"})
    piece_lms = {}
    shared = {}
    for k, d in lmem.items():
        pc = d.get("piece")
        if isinstance(pc, list):
            for q in pc:
                shared.setdefault(q, []).append(k)
        elif pc:
            piece_lms.setdefault(pc, []).append(k)
    # ---- meshes
    meshes_out = {}
    render_list = []
    co_mid = (lm["CoR"] + lm["CoL"]) / 2
    pivots = {
        "cranium": (frame.vox_to_gl(lm["N"]), "nasion (frame origin; fixed reference)"),
        "spine": (frame.vox_to_gl(lm["Ba"]), "basion (atlanto-occipital joint)"),
        "maxilla_R": (frame.vox_to_gl(lm["PNS"]), "posterior nasal spine (Le Fort I pitch / impaction)"),
        "maxilla_L": (frame.vox_to_gl(lm["PNS"]), "posterior nasal spine (Le Fort I pitch / impaction)"),
        "mandible_body": (frame.vox_to_gl(co_mid), "midpoint of the condylar hinge axis CoR-CoL"),
        "ramus_R": (frame.vox_to_gl(lm["CoR"]), "right condylion (proximal segment rotates about the condyle)"),
        "ramus_L": (frame.vox_to_gl(lm["CoL"]), "left condylion"),
    }
    for name, lid in PIECE_LABEL.items():
        m = lab == lid
        if not m.any():
            log_fn("piece %s empty" % name)
            continue
        sl = bbox(m, 0)
        vv, ff = mask_to_mesh(m[sl], [s_.start for s_ in sl], bone_factor, frame, sigma=1.0)
        tris_full = len(ff)
        dec = "none"
        if name == "cranium" and cranium_max_tris:
            vv, ff, dec = _decimate(vv, ff, cranium_max_tris)
        idx = np.argwhere(m)
        cen = frame.vox_to_gl(idx.mean(0)[::-1])
        if name == "chin":
            an_c = frame.vox_to_anat(idx[:, ::-1])
            hgt = an_c[:, 2] - b_occ * an_c[:, 1]
            top = idx[hgt > cut_info["genioplasty"]["height_mm"] - 1.5]
            pv = (frame.vox_to_gl(top.mean(0)[::-1]) if len(top) else cen, "centre of the genioplasty osteotomy surface")
        elif name == "hyoid":
            pv = (cen, "centroid (the hyoid floats; it is not attached to any bone)")
        else:
            pv = pivots.get(name, (cen, "centroid"))
        meshes_out[name] = dict(id=name, label=PRETTY[name], group="bone", color=GROUP_COLORS[name],
                                voxels=int(m.sum()), volume_mm3=round(float(m.sum() * vox_mm3), 1),
                                components=piece_components.get(name),
                                centroid=cen.round(2).tolist(), pivot=np.asarray(pv[0]).round(2).tolist(),
                                pivot_note=pv[1], landmarks=sorted(piece_lms.get(name, [])),
                                shared_landmarks=sorted(shared.get(name, [])),
                                triangles=int(len(ff)), triangles_before_decimation=tris_full, decimation=dec,
                                signed_volume_mm3=round(mesh_signed_volume(vv, ff), 1),
                                mesh=encode_mesh(vv, ff))
        if not meshes_out[name]["shared_landmarks"]:
            meshes_out[name].pop("shared_landmarks")
        else:
            meshes_out[name]["shared_landmarks_note"] = "move with the mean of the maxilla_R and maxilla_L transforms"
        render_list.append((name, vv, ff, matplotlib_rgb(QA_COLORS[name] if name != "cranium" else GROUP_COLORS[name])))
        log_fn("mesh %-14s %8d vox %7d tris (%s)" % (name, m.sum(), len(ff), dec))
    import colorsys
    for ti in teeth_info:
        lid = ti["label"]
        m = lab == lid
        sl = bbox(m, 0)
        vv, ff = mask_to_mesh(m[sl], [s_.start for s_ in sl], tooth_factor, frame, sigma=0.8)
        pid = "tooth_%d" % ti["fdi"]
        q, n = ti["fdi"] // 10, ti["fdi"] % 10
        col = "#%02x%02x%02x" % tuple(int(255 * c) for c in colorsys.hsv_to_rgb(0.11, 0.08 + 0.03 * n, 0.97 - 0.01 * n))
        mvol = mesh_signed_volume(vv, ff)
        ti["volume_mesh_mm3"] = round(mvol, 1)
        meshes_out[pid] = dict(id=pid, label="Tooth %d (%s)" % (ti["fdi"], ti["name"]), group="teeth_" + ti["arch"],
                               color=col, fdi=ti["fdi"], voxels=ti["voxels"], volume_mm3=ti["volume_mm3"],
                               volume_mesh_mm3=round(mvol, 1), volume_dense1000_mm3=ti["volume_dense1000_mm3"],
                               typical_volume_mm3=ti["typical_volume_mm3"], components=ti["components"],
                               centroid=ti["centroid_gl"], pivot=ti["cres_gl"],
                               pivot_note="approximate centre of resistance (40 % of tooth length from the apex, on the long axis)",
                               long_axis=ti["axis_gl"], tip=ti["tip_gl"], apex=ti["apex_gl"], length_mm=ti["length_mm"],
                               landmarks=sorted(piece_lms.get(pid, [])), triangles=int(len(ff)),
                               signed_volume_mm3=round(mvol, 1), flags=ti["flags"], mesh=encode_mesh(vv, ff))
        hue = ((q - 1) * 0.25 + n * 0.03) % 1.0
        render_list.append((pid, vv, ff, colorsys.hsv_to_rgb(hue, 0.55, 0.95)))
    # ---- write JS bundles
    groups = {"pieces_cranium.js": [k for k in ("cranium", "spine", "hyoid") if k in meshes_out],
              "pieces_jaws.js": [k for k in meshes_out if meshes_out[k]["group"] == "bone" and k not in ("cranium", "spine", "hyoid")],
              "pieces_teeth_upper.js": [k for k in meshes_out if meshes_out[k]["group"] == "teeth_upper"],
              "pieces_teeth_lower.js": [k for k in meshes_out if meshes_out[k]["group"] == "teeth_lower"]}
    files = {}
    for fname, ids in groups.items():
        path = os.path.join(out_dir, fname)
        with open(path, "w") as fh:
            fh.write("/* skull-surgery-sandbox pieces (%s) - generated by segment.py %s, MIT licence.\n"
                     "   mesh: pos = base64 Int16Array of GL xyz / scale (x = patient left, y = up, z = anterior,"
                     " mm, origin nasion); idx = base64 Uint32Array triangle indices */\n" % (fname, __version__))
            fh.write("window.PIECES=window.PIECES||{};\n")
            for k in ids:
                d = dict(meshes_out[k])
                mesh = d.pop("mesh")
                d.update(mesh)
                fh.write("window.PIECES[%s]=%s;\n" % (json.dumps(k), json.dumps(d, separators=(",", ":"))))
        files[fname] = dict(bytes=os.path.getsize(path), pieces=ids)
        for k in ids:
            meshes_out[k]["file"] = fname
        log_fn("wrote %s (%.2f MB)" % (fname, os.path.getsize(path) / 1e6))
    total_bytes = sum(f_["bytes"] for f_ in files.values())
    # ---- manifest
    hinge = dict(R=frame.vox_to_gl(lm["CoR"]).round(2).tolist(), L=frame.vox_to_gl(lm["CoL"]).round(2).tolist())
    hv = np.array(hinge["L"]) - np.array(hinge["R"])
    hinge["axis_unit"] = (hv / np.linalg.norm(hv)).round(5).tolist()
    hinge["note"] = "condylar hinge axis through right and left condylion (CoR -> CoL)"
    sup_gl = np.array([0, 1.0, 0])
    a_occ, b_occ_, c_occ = occlusal_slope(frame, dent)
    nLF = np.array([0.0, 1.0, -b_occ_])     # plane sup - b*ant = h  ->  GL normal (lat, sup, ant) = (0, 1, -b)
    lf = cut_info["lefort"]["height_mm"]
    gp = cut_info["genioplasty"]["height_mm"]
    A_ = frame.vox_to_anat(lm["A"])
    pns = frame.vox_to_anat(lm["PNS"])
    mid_dir_gl = np.array([pns[0] - A_[0], 0.0, pns[1] - A_[1]])
    mid_n = np.cross(mid_dir_gl, sup_gl)
    mid_n /= np.linalg.norm(mid_n)
    if mid_n[0] < 0:
        mid_n = -mid_n
    planes = dict(
        lefort_I=dict(plane_from_point_normal([0.0, lf, 0.0], nLF), **{k: v_ for k, v_ in cut_info["lefort"].items()},
                      note="maxilla = below this plane and anterior to the pterygomaxillary limit (ant > posterior_limit_ant_mm); plane parallel to the occlusal plane (sagittal slope), level laterally"),
        genioplasty=dict(plane_from_point_normal([0.0, gp, 0.0], nLF), **cut_info["genioplasty"],
                         note="chin = mandible below this plane and between the arc-length limits (5 mm mesial of the mental foramina)"),
        midline=dict(plane_from_point_normal([A_[0], 0.0, A_[1]], mid_n), note="midpalatal split plane through A and PNS, perpendicular to FH"),
        occlusal=dict(plane_from_point_normal([0.0, a_occ, 0.0], np.array([-c_occ, 1.0, -b_occ_])),
                      note="least-squares occlusal plane through MolR/L, PmR/L and the incisor contact"),
    )
    n_up = sum(t["arch"] == "upper" for t in teeth_info)
    n_lo = sum(t["arch"] == "lower" for t in teeth_info)
    lab_ratio = [t["label_over_typical"] for t in teeth_info]
    den_ratio = [t["dense_over_typical"] for t in teeth_info]
    teeth_status = ("%d teeth segmented individually (%d upper: 11-17, 21-27; %d lower: 31-37, 41-47; no third molars in the scan). "
                    "Each tooth is one connected component (crown + root). Label volumes are %.1f-%.1fx (median %.1fx) rough "
                    "whole-tooth reference volumes; the >=1000 HU core is %.1f-%.1fx (median %.1fx). The excess is the partial-volume "
                    "rim (the label boundary sits near 750 HU so the surface is closed) plus residual root/bone ambiguity at the apices; "
                    "%d teeth carry plausibility flags." % (len(teeth_info), n_up, n_lo, min(lab_ratio), max(lab_ratio), np.median(lab_ratio),
                                                           min(den_ratio), max(den_ratio), np.median(den_ratio),
                                                           sum(1 for t in teeth_info if t["flags"])))
    manifest = dict(
        format="skull-surgery-sandbox pieces", version=__version__, generator="segment.py",
        licence="MIT (code); data released with the subject's consent for open teaching use",
        subject="adult male, 22 y, single head CBCT (no identifiers)",
        frame=dict(name="GL", axes="x = patient left, y = superior (FH normal), z = anterior; mm; origin = nasion",
                   from_scanner="GL = R (p_mm - N_mm), rows of R = lateral, FH-normal, anterior axes (scanner x,y,z); p_mm = voxel*%.2f" % v,
                   to_simulator="sim.py anat_mm = (lat, ant, sup) = (GL x, GL z, GL y)",
                   R=frame.R.round(6).tolist(), N_scanner_mm=frame.origin.round(3).tolist(), voxel_mm=v),
        mesh_encoding=dict(pos="base64 little-endian Int16Array, xyz interleaved, multiply by scale (0.05) for mm",
                           idx="base64 little-endian Uint32Array, 3 per triangle, counter-clockwise outward"),
        files=files, total_payload_bytes=total_bytes,
        pieces=[{k: v_ for k, v_ in meshes_out[k].items() if k != "mesh"} | {"file": meshes_out[k]["file"]}
                for k in meshes_out],
        teeth=dict(status=teeth_status, method="per-tooth (FDI) marker watershed + per-tooth intensity re-split against bone; see README",
                   typical_volume_note="typical_volume_mm3 = rough adult whole-tooth volumes (crown + root + pulp, micro-CT literature order of magnitude, +-25 %)",
                   list=teeth_info, diagnostics=tdiag),
        hinge_axis=hinge, planes=planes, bsso=cut_info["bsso"],
        maxilla_islands=cut_info.get("maxilla_islands"),
        cranium_fragments_below_lefort=cut_info.get("cranium_fragments_below_lefort"),
        landmarks_gl=landmarks_gl,
        landmark_membership={k: d["piece"] for k, d in sorted(lmem.items())},
        landmark_rules={k: d for k, d in sorted(lmem.items())},
        landmark_notes=dict(
            U1="U1tip/U1apex/U1FA/U1lab are carried rigidly by %s (sim.py SEG_U1)" % lmem.get("U1tip", {}).get("piece"),
            L1=("L1tip/L1apex/L1lab are carried rigidly by %s (sim.py SEG_L1). analysis.json's L1apex lies %.1f mm from that tooth's "
                "segmented apex (it was placed on the neighbouring incisor's apex); it is kept at its analysis.json position so the "
                "sagittal readouts reproduce the simulator, and moves with %s." % (
                    lmem.get("L1tip", {}).get("piece"),
                    float(np.linalg.norm(np.array(landmarks_gl["L1apex"]) - np.array(
                        next((t["apex_gl"] for t in teeth_info if "tooth_%d" % t["fdi"] == lmem.get("L1tip", {}).get("piece")), landmarks_gl["L1apex"])))),
                    lmem.get("L1tip", {}).get("piece"))),
            occlusal="MolR/MolL/PmR/PmL are single contact points; use UMol*/UPm* (upper teeth) and LMol*/LPm* (lower teeth) as sim.py does",
            midline="A, ANS, PNS sit on the midpalatal split: membership is the list [maxilla_R, maxilla_L]; move them with the mean of the two transforms",
            genioplasty="Pog, Gn, Me ride on the chin; MeT/GnT are copies that stay on mandible_body (true mandibular plane)"),
        qa=qa, runtime_s=round(time.time() - t_start, 1),
    )
    for p in manifest["pieces"]:
        p.pop("mesh", None)
    json.dump(manifest, open(os.path.join(out_dir, "manifest.json"), "w"), indent=1)
    # ---- QA renders
    renders = []
    if qa_dir:
        renders = qa_renders(G, lab, lm, frame, dent, teeth_info, render_list, qa_dir)
    log_fn("done in %.0f s" % (time.time() - t_start))
    return dict(manifest=manifest, labels=lab, renders=renders, frame=frame, dent=dent)


def matplotlib_rgb(hexcol):
    h = hexcol.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


# landmarks that sit on a joint or contact surface: restrict the owner to the anatomical bone
LANDMARK_PREFER = {
    "CoR": ("ramus_R",), "CoL": ("ramus_L",), "ArR": ("ramus_R",), "ArL": ("ramus_L",),
    "GoR": ("ramus_R",), "GoL": ("ramus_L",), "AgR": ("ramus_R", "mandible_body"),
    "AgL": ("ramus_L", "mandible_body"), "B": ("mandible_body", "chin"), "Pog": ("chin", "mandible_body"),
    "Gn": ("chin", "mandible_body"), "Me": ("chin", "mandible_body"),
    "JR": ("maxilla_R",), "JL": ("maxilla_L",),
}
# landmark sets that describe ONE tooth and must move rigidly with it (same sets as sim.py SEG_U1 /
# SEG_L1): owner = the tooth that carries the anchor point (tip), among the candidates
RIGID_TOOTH_SETS = {
    "U1": dict(members=("U1tip", "U1apex", "U1FA", "U1lab"), anchor="U1tip", candidates=(11, 21)),
    "L1": dict(members=("L1tip", "L1apex", "L1lab"), anchor="L1tip", candidates=(31, 41)),
}
# single occlusal-contact points of analysis.json, duplicated into an upper and a lower copy exactly
# like sim.load_landmarks (UMol*/UPm* ride on the maxilla, LMol*/LPm* on the mandible)
OCCLUSAL_COPIES = {
    "MolR": (("UMolR", (16, 17, 15)), ("LMolR", (46, 47, 45))),
    "MolL": (("UMolL", (26, 27, 25)), ("LMolL", (36, 37, 35))),
    "PmR": (("UPmR", (15, 14)), ("LPmR", (45, 44))),
    "PmL": (("UPmL", (25, 24)), ("LPmL", (35, 34))),
}
# true (pre-genioplasty) menton / gnathion: copies that stay on the tooth-bearing segment (sim.py MeT/GnT)
BODY_COPIES = {"MeT": "Me", "GnT": "Gn"}
# midline points on the midpalatal split: they follow the MEAN of the two maxilla-half transforms
MIDLINE_MAXILLA = ("A", "ANS", "PNS")
# sim.py segment sets, used to check that the pieces carry the same groups
SIM_SEGMENTS = {
    "SEG_U1": ["U1tip", "U1apex", "U1FA", "U1lab"],
    "SEG_L1": ["L1tip", "L1apex", "L1lab"],
    "SEG_MAX": ["A", "ANS", "PNS", "JR", "JL", "UMolR", "UMolL", "UPmR", "UPmL", "U1tip", "U1apex", "U1FA", "U1lab"],
    "SEG_MAND_DISTAL": ["B", "Pog", "Gn", "Me", "MeT", "GnT", "LMolR", "LMolL", "LPmR", "LPmL", "L1tip", "L1apex", "L1lab"],
    "SEG_MAND_PROX": ["GoR", "GoL", "ArR", "ArL", "AgR", "AgL"],
    "SEG_GENIO": ["Pog", "Gn", "Me"],
}


def _piece_name(lid):
    if lid >= TOOTH_BASE:
        return "tooth_%d" % (lid - TOOTH_BASE)
    return LABELS.get(int(lid))


def _nearest_label_dist(lab, p, lid, frame, r_mm=12.0):
    """distance (mm) from voxel point p (x,y,z) to the nearest voxel of label lid (inf if none within r_mm)"""
    r = int(np.ceil(r_mm / frame.vox))
    x, y, z = np.round(p).astype(int)
    z0, y0, x0 = max(z - r, 0), max(y - r, 0), max(x - r, 0)
    sub = lab[z0:z + r + 1, y0:y + r + 1, x0:x + r + 1] == lid
    if not sub.any():
        return np.inf
    idx = np.argwhere(sub) + [z0, y0, x0]
    return float(np.min(np.linalg.norm(idx - np.array([p[2], p[1], p[0]]), axis=1)) * frame.vox)


def assign_landmarks(lab, lm, frame, max_mm=3.0):
    """Landmark -> piece binding.

    * soft-tissue points: no piece;
    * U1 / L1 sets (RIGID_TOOTH_SETS): every member goes to the tooth that carries the tip, so the
      incisor axis is carried rigidly by one tooth (anatomy, not nearest voxel);
    * MolR/L, PmR/L (single occlusal contacts) are replaced by upper and lower copies bound to the
      nearest upper / lower posterior tooth (OCCLUSAL_COPIES); the originals are not movable;
    * MeT / GnT: copies of Me / Gn on the tooth-bearing mandible (true mandibular plane);
    * A, ANS, PNS: shared by maxilla_R and maxilla_L (follow the mean of the two transforms);
    * everything else: the nearest labelled voxel within max_mm, restricted to LANDMARK_PREFER.
    Returns (points, membership): points[name] = voxel xyz (including the copies);
    membership[name] = piece id, list of piece ids (shared) or None, with a rule string."""
    pts = {k: np.asarray(v_, float) for k, v_ in lm.items() if not k.endswith("_mid")}
    mem = {}
    present = set(int(x) for x in np.unique(lab[lab >= TOOTH_BASE]) - TOOTH_BASE) if (lab >= TOOTH_BASE).any() else set()
    r = int(np.ceil(max_mm / frame.vox)) + 1
    for name, p in sorted(pts.items()):
        if is_soft_tissue(name):
            mem[name] = dict(piece=None, rule="soft tissue (follows no bone piece)")
            continue
        x, y, z = np.round(p).astype(int)
        z0, y0, x0 = max(z - r, 0), max(y - r, 0), max(x - r, 0)
        sub = lab[z0:z + r + 1, y0:y + r + 1, x0:x + r + 1]
        ok = sub > 0
        if name in LANDMARK_PREFER:
            pref = [PIECE_LABEL[n] for n in LANDMARK_PREFER[name]]
            if np.isin(sub, pref).any():
                ok = np.isin(sub, pref)
        idx = np.argwhere(ok)
        if len(idx) == 0:
            mem[name] = dict(piece=None, rule="no bone within %.0f mm" % max_mm)
            continue
        d = np.linalg.norm((idx + [z0, y0, x0]) - np.array([p[2], p[1], p[0]]), axis=1) * frame.vox
        j = int(np.argmin(d))
        if d[j] > max_mm:
            mem[name] = dict(piece=None, rule="no bone within %.0f mm" % max_mm)
            continue
        mem[name] = dict(piece=_piece_name(int(sub[tuple(idx[j])])), rule="nearest labelled voxel",
                         dist_mm=round(float(d[j]), 2))
    # rigid tooth sets
    for sname, spec in RIGID_TOOTH_SETS.items():
        cands = [f for f in spec["candidates"] if f in present]
        if not cands or spec["anchor"] not in pts:
            continue
        dd = {f: _nearest_label_dist(lab, pts[spec["anchor"]], TOOTH_BASE + f, frame) for f in cands}
        f = min(dd, key=dd.get)
        for k in spec["members"]:
            if k in pts:
                mem[k] = dict(piece="tooth_%d" % f, rule="rigid %s set: carried by the tooth that holds %s" % (sname, spec["anchor"]),
                              dist_mm=round(_nearest_label_dist(lab, pts[k], TOOTH_BASE + f, frame), 2))
    # occlusal contact copies
    for src, copies in OCCLUSAL_COPIES.items():
        if src not in pts:
            continue
        mem[src] = dict(piece=None, rule="single occlusal contact; use the upper/lower copies %s" % ", ".join(c[0] for c in copies))
        for cname, cands in copies:
            cc_ = [f for f in cands if f in present]
            pts[cname] = pts[src].copy()
            if not cc_:
                mem[cname] = dict(piece=None, rule="copy of %s; no candidate tooth" % src)
                continue
            dd = {f: _nearest_label_dist(lab, pts[src], TOOTH_BASE + f, frame) for f in cc_}
            f = min(dd, key=dd.get)
            mem[cname] = dict(piece="tooth_%d" % f, rule="copy of %s (as sim.load_landmarks), carried by the nearest %s tooth"
                              % (src, "upper" if cname.startswith("U") else "lower"), dist_mm=round(dd[f], 2))
    for cname, src in BODY_COPIES.items():
        if src in pts:
            pts[cname] = pts[src].copy()
            mem[cname] = dict(piece="mandible_body", rule="copy of %s that stays on the tooth-bearing segment (true mandibular plane, sim.py %s)" % (src, cname))
    for k in MIDLINE_MAXILLA:
        if k in pts:
            mem[k] = dict(piece=["maxilla_R", "maxilla_L"], rule="midline: maxilla_R+maxilla_L (mean of the two half transforms)")
    return pts, mem


def check_landmark_sets(mem):
    """every sim.py segment set must be carried by pieces of the matching group; rigid tooth sets by one piece."""
    def owners(names):
        out = []
        for n in names:
            pc = mem.get(n, {}).get("piece")
            out.extend(pc if isinstance(pc, list) else [pc])
        return out
    up = lambda o: o in ("maxilla_R", "maxilla_L") or (isinstance(o, str) and o.startswith("tooth_") and int(o[6]) in (1, 2))
    lo = lambda o: o in ("mandible_body", "chin") or (isinstance(o, str) and o.startswith("tooth_") and int(o[6]) in (3, 4))
    res = {}
    res["SEG_U1_single_owner"] = len(set(owners(SIM_SEGMENTS["SEG_U1"]))) == 1
    res["SEG_L1_single_owner"] = len(set(owners(SIM_SEGMENTS["SEG_L1"]))) == 1
    res["SEG_MAX_on_maxilla_or_upper_teeth"] = all(up(o) for o in owners(SIM_SEGMENTS["SEG_MAX"]))
    res["SEG_MAND_DISTAL_on_body_chin_or_lower_teeth"] = all(lo(o) for o in owners(SIM_SEGMENTS["SEG_MAND_DISTAL"]))
    res["SEG_MAND_PROX_on_rami"] = all(o in ("ramus_R", "ramus_L") for o in owners(SIM_SEGMENTS["SEG_MAND_PROX"]))
    res["SEG_GENIO_on_chin"] = all(o == "chin" for o in owners(SIM_SEGMENTS["SEG_GENIO"]))
    res["owners"] = {k: sorted(set(map(str, owners(v_)))) for k, v_ in SIM_SEGMENTS.items()}
    res["all_ok"] = all(v_ for k, v_ in res.items() if k not in ("owners",))
    return res


def readout_check(landmarks_gl, sim_dir, analysis_json=None):
    """Rebuild the simulator's landmark dict from the manifest's GL points (lat = x, sup = y, ant = z)
    and compare sim.measure() with sim.py's own baseline.  Returns dict(max_abs_diff, rows) or an error."""
    try:
        sys.path.insert(0, sim_dir)
        import importlib
        sim = importlib.import_module("sim")
    except Exception as e:  # pragma: no cover
        return dict(error="cannot import sim.py from %s: %s" % (sim_dir, e))
    try:
        ref = sim.measure(sim.State(sim.load_landmarks(analysis_json)))["metrics"]
        X = {k: np.array([p[0], p[2], p[1]], float) for k, p in landmarks_gl.items()}
        got = sim.measure(sim.State(X))["metrics"]
    except Exception as e:  # pragma: no cover
        return dict(error="readout failed: %s" % e)
    keys = [k for k in ("SNA", "SNB", "ANB", "U1_SN", "U1_PP", "U1_FH", "IMPA", "FMA", "FMIA", "interincisal",
                        "overjet", "overbite", "occlusal_plane_to_FH", "functional_OP_to_FH", "palatal_plane_to_FH",
                        "Wits_incisor_molar_OP", "N_Me", "ANS_Me", "Co_Gn", "posterior_occlusal_gap",
                        "premolar_occlusal_gap", "molar_AP_offset_UMol_minus_LMol") if k in ref]
    rows = {k: dict(sim=round(float(ref[k]), 3), sandbox=round(float(got[k]), 3)) for k in keys}
    diffs = [abs(float(got[k]) - float(ref[k])) for k in ref if isinstance(ref[k], (int, float)) and k in got
             and isinstance(got[k], (int, float)) and np.isfinite(ref[k])]
    return dict(metrics_compared=len(diffs), max_abs_diff=round(float(max(diffs)), 6), key_metrics=rows)


def qa_renders(G, lab, lm, frame, dent, teeth_info, render_list, qa_dir):
    out = []
    zN = int(lm["N"][2])
    zs = list(range(int(lm["Me"][2]) + 6, int(lm["N"][2]) + 60, 14))
    p = os.path.join(qa_dir, "axial_overview.png")
    render_slices(G, lab, p, "axial", zs[:24], "axial label overlay (bone window)", ncol=6)
    out.append(p)
    z0, z1, y0, y1, x0, x1 = dent.box
    zs = list(range(z0 + 10, z1 - 10, 6))[:24]
    p = os.path.join(qa_dir, "axial_dental.png")
    render_slices(G, lab, p, "axial", zs, "axial, dental region", crop=((y0, y1), (x0, x1)), ncol=6)
    out.append(p)
    ys = list(range(int(lm["U1tip"][1]) - 5, int(lm["Ba"][1]) + 30, 12))[:24]
    p = os.path.join(qa_dir, "coronal_overview.png")
    render_slices(G, lab, p, "coronal", ys, "coronal label overlay", ncol=6)
    out.append(p)
    xs = [int(lm["CoR"][0]), int(lm["GoR"][0]) + 10, int(lm["MolR"][0]), int(lm["PmR"][0]),
          int((lm["MolR"][0] + 2 * lm["N"][0]) / 3), int(lm["N"][0]), int(lm["A"][0]) + 6,
          int((lm["MolL"][0] + 2 * lm["N"][0]) / 3), int(lm["PmL"][0]), int(lm["MolL"][0]),
          int(lm["GoL"][0]) - 10, int(lm["CoL"][0])]
    p = os.path.join(qa_dir, "sagittal_overview.png")
    zc0 = max(int(lm["Me"][2]) - 40, 0)
    zc1 = min(int(lm["N"][2]) + 40, G.shape[0])
    yc0 = max(int(lm["Prn"][1]) - 20 if "Prn" in lm else int(lm["N"][1]) - 60, 0)
    yc1 = min(int(lm["Ba"][1]) + 100, G.shape[1])
    render_slices(G, lab, p, "sagittal", xs, "sagittal label overlay (anterior to the left)",
                  crop=((zc0, zc1), (yc0, yc1)), ncol=4)
    out.append(p)
    # TMJ close-ups
    for side in ("R", "L"):
        co = lm["Co" + side]
        p = os.path.join(qa_dir, "tmj_%s.png" % side)
        cz, cy, cx = int(co[2]), int(co[1]), int(co[0])
        render_slices(G, lab, p, "coronal", [cy - 6, cy, cy + 6, cy + 12], "TMJ %s (coronal)" % side,
                      crop=((cz - 50, cz + 30), (cx - 50, cx + 50)), ncol=4, annotate=False)
        out.append(p)
    for arch in ("upper", "lower"):
        p = os.path.join(qa_dir, "teeth_gallery_%s.png" % arch)
        render_tooth_gallery(G, lab, teeth_info, dent, p, frame, arch)
        out.append(p)
    for arch in ("upper", "lower"):
        p = os.path.join(qa_dir, "teeth_root_sections_%s.png" % arch)
        render_tooth_sections(G, lab, teeth_info, p, arch)
        out.append(p)
    # retromolar / BSSO region (sagittal through the second molars) and the hyoid (axial)
    zc0 = max(int(lm["Me"][2]) - 20, 0)
    xs = [int(round(lm["MolR"][0] + f * (lm["GoR"][0] - lm["MolR"][0]))) for f in (0.0, 0.5, 0.8)] + \
         [int(round(lm["MolL"][0] + f * (lm["GoL"][0] - lm["MolL"][0]))) for f in (0.0, 0.5, 0.8)]
    p = os.path.join(qa_dir, "bsso_region_sagittal.png")
    render_slices(G, lab, p, "sagittal", xs, "retromolar / sagittal-split region through the molars, mid-body/ramus and ramus (anterior to the left)",
                  crop=((zc0, min(int(lm["CoR"][2]) + 15, G.shape[0])), (int(lm["U1tip"][1]) + 20, int(lm["Ba"][1]) + 10)), ncol=3)
    out.append(p)
    hy = np.argwhere(lab == PIECE_LABEL["hyoid"]) if (lab == PIECE_LABEL["hyoid"]).any() else None
    if hy is not None:
        z_lo, z_hi = hy[:, 0].min(), hy[:, 0].max()
        zs = np.linspace(z_lo, z_hi, 8).astype(int).tolist()
        cy, cx = hy[:, 1].mean(), hy[:, 2].mean()
        p = os.path.join(qa_dir, "hyoid_axial.png")
        render_slices(G, lab, p, "axial", zs, "hyoid (teal) and cervical spine (cyan), axial",
                      crop=((int(cy) - 90, int(cy) + 130), (int(cx) - 110, int(cx) + 110)), ncol=4, annotate=False)
        out.append(p)
    p = os.path.join(qa_dir, "exploded_3d.png")
    render_exploded(render_list, p, explode=0.55, title="exploded view (pieces pushed outward from the common centroid)")
    out.append(p)
    p = os.path.join(qa_dir, "assembled_3d.png")
    render_exploded(render_list, p, explode=0.0, title="assembled view")
    out.append(p)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dicom-dir", required=True)
    ap.add_argument("--landmarks", required=True, help="analysis.json with landmarks + frame")
    ap.add_argument("--out", required=True, help="output folder for pieces (JS + manifest.json)")
    ap.add_argument("--qa", default=None, help="folder for QA renders (default: OUT/../qa)")
    ap.add_argument("--cache", default=None, help="optional folder for intermediate arrays")
    ap.add_argument("--tooth-grid", type=int, default=1, choices=(1, 2), help="tooth mesh grid factor (1 = 0.45 mm)")
    ap.add_argument("--bone-grid", type=int, default=3, choices=(2, 3, 4), help="bone mesh grid factor (3 = 1.35 mm)")
    ap.add_argument("--cranium-tris", type=int, default=100000,
                    help="decimate the cranium mesh to this many triangles (needs pyfqmr; 0 = keep full resolution)")
    ap.add_argument("--reuse-stage", action="store_true",
                    help="reuse the bone-mask + first-pass teeth stage saved in --cache (faster reruns)")
    ap.add_argument("--sim", default=None,
                    help="folder containing sim.py: check that the manifest landmarks reproduce the simulator baseline")
    a = ap.parse_args(argv)
    qa = a.qa or os.path.join(os.path.dirname(os.path.abspath(a.out)), "qa")
    run(a.dicom_dir, a.landmarks, a.out, qa_dir=qa, cache_dir=a.cache, tooth_factor=a.tooth_grid,
        bone_factor=a.bone_grid, cranium_max_tris=a.cranium_tris, reuse_stage=a.reuse_stage, sim_dir=a.sim)


if __name__ == "__main__":
    main()
