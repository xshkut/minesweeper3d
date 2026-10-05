#!/usr/bin/env python3
"""Original, procedurally generated art for Minesweeper 3D.

Everything this script writes is generated from the constants below and a fixed
RNG seed: no third-party image, model or texture is read, sampled or derived
from.  Re-running it reproduces byte-identical files.

The art this replaces was sampled from the internet and carried no licence, so
it had to go: the board skin, the six environment faces and the mine mesh in
``packages/web/public/`` are all authored here instead.

    python3 tools/assets/generate_assets.py --out <dir>     # write the art
    python3 tools/assets/generate_assets.py --check         # self checks
    python3 tools/assets/generate_assets.py --list-variants # environment options

Careful: ``--out packages/web/public`` writes straight into the client's asset
directory.  That is the intended way to refresh the art, and it is also the
only thing in that directory the client does not need to be rebuilt for.

Outputs
-------
final layout (``--out``)

    textures/board.jpg                    covered-cell skin
    cubemap/{posx,negx,posy,negy,posz,negz}.jpg   Environment background
    mines/mine.obj  mines/mine.png        revealed mine (mesh + albedo atlas)
    previews/equirect.jpg                 review aid, not loaded by the client

The environment has several interchangeable originals - a twilight sky or a
soft daylight studio, for instance.  ``--list-variants`` prints them and
``--variant`` picks one; each is a pure function of its name and the master
seed, so the one that ships is always reproducible.  The shipped one is
:data:`DEFAULT_SKY`; the client has no opinion about it.

compatibility layout (``--compat``, preview only)

    the exact paths/formats the original client asked for, so this art can be
    dropped into an already-built ``dist/`` without touching any code.

Requires numpy and Pillow (``pip install numpy pillow``).
"""

from __future__ import annotations

import argparse
import hashlib
import math
from pathlib import Path

import numpy as np
from PIL import Image

# --------------------------------------------------------------------------
# Deterministic randomness
# --------------------------------------------------------------------------

SEED = 20261005


def rng_for(tag: str) -> np.random.Generator:
    """A generator seeded from the fixed master seed and a piece name."""
    digest = hashlib.sha256(f"{SEED}:{tag}".encode()).digest()
    return np.random.default_rng(int.from_bytes(digest[:8], "little"))


# --------------------------------------------------------------------------
# Small numeric helpers
# --------------------------------------------------------------------------


def smoothstep(x: np.ndarray | float, edge0: float = 0.0, edge1: float = 1.0) -> np.ndarray:
    """Hermite ramp from 0 at ``edge0`` to 1 at ``edge1``."""
    t = np.clip((np.asarray(x, dtype=np.float64) - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def value_noise(shape: tuple[int, int], cells_y: int, cells_x: int, rng: np.random.Generator) -> np.ndarray:
    """Smooth bilinear value noise in ``[0, 1]`` on a ``cells_y x cells_x`` lattice."""
    height, width = shape
    lattice = rng.random((cells_y + 1, cells_x + 1))

    y = np.linspace(0.0, cells_y, height, endpoint=False)
    x = np.linspace(0.0, cells_x, width, endpoint=False)
    y0 = np.floor(y).astype(int)
    x0 = np.floor(x).astype(int)
    fy = smoothstep(y - y0)[:, None]
    fx = smoothstep(x - x0)[None, :]
    y1 = np.minimum(y0 + 1, cells_y)
    x1 = np.minimum(x0 + 1, cells_x)

    top = lattice[np.ix_(y0, x0)] + (lattice[np.ix_(y0, x1)] - lattice[np.ix_(y0, x0)]) * fx
    bottom = lattice[np.ix_(y1, x0)] + (lattice[np.ix_(y1, x1)] - lattice[np.ix_(y1, x0)]) * fx
    return top + (bottom - top) * fy


def fbm(shape: tuple[int, int], cells: int, rng: np.random.Generator, octaves: int = 4, gain: float = 0.5) -> np.ndarray:
    """Fractal sum of :func:`value_noise`, normalised to ``[0, 1]``."""
    total = np.zeros(shape)
    norm = 0.0
    amplitude = 1.0
    scale = float(cells)
    for _ in range(octaves):
        total += amplitude * value_noise(shape, max(1, int(scale)), max(1, int(scale)), rng)
        norm += amplitude
        amplitude *= gain
        scale *= 2.0
    return total / norm


def value_noise_at(x: np.ndarray, y: np.ndarray, cells: int, rng: np.random.Generator) -> np.ndarray:
    """Smooth value noise sampled at arbitrary coordinates.

    The lattice wraps, so the field is tileable and has no boundary of its own -
    which is what the cloud deck needs when it is projected onto the sky.
    """
    lattice = rng.random((cells, cells))
    gx = x * cells
    gy = y * cells
    x0 = np.floor(gx).astype(int)
    y0 = np.floor(gy).astype(int)
    fx = smoothstep(gx - x0)
    fy = smoothstep(gy - y0)
    x0m = x0 % cells
    y0m = y0 % cells
    x1m = (x0 + 1) % cells
    y1m = (y0 + 1) % cells
    top = lattice[y0m, x0m] + (lattice[y0m, x1m] - lattice[y0m, x0m]) * fx
    bottom = lattice[y1m, x0m] + (lattice[y1m, x1m] - lattice[y1m, x0m]) * fx
    return top + (bottom - top) * fy


def fbm_at(x: np.ndarray, y: np.ndarray, cells: int, rng: np.random.Generator, octaves: int = 5) -> np.ndarray:
    """Fractal sum of :func:`value_noise_at`, normalised to ``[0, 1]``."""
    total = np.zeros_like(x)
    norm = 0.0
    amplitude = 1.0
    scale = float(cells)
    for _ in range(octaves):
        total += amplitude * value_noise_at(x, y, max(2, int(scale)), rng)
        norm += amplitude
        amplitude *= 0.5
        scale *= 2.0
    return total / norm


def normalise(vector: np.ndarray) -> np.ndarray:
    return vector / np.linalg.norm(vector)


def save_jpeg(image: Image.Image, path: Path, quality: int = 92) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="JPEG", quality=quality, subsampling=0, optimize=True)


def save_png(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True)


def to_image(rgb: np.ndarray) -> Image.Image:
    """Clamps a float RGB array in ``[0, 1]`` into an 8-bit image with dithering.

    The dither is scaled by the local brightness: a quarter of a step is plenty
    to break up a bright gradient, while in the dark half it would only speckle
    flat areas once JPEG has had its way with them.
    """
    luminance = rgb.mean(axis=-1, keepdims=True)
    amplitude = (0.15 / 255.0) + (0.70 / 255.0) * np.clip(luminance * 1.6, 0.0, 1.0)
    noise = (np.random.default_rng(7).random(rgb.shape[:2])[..., None] - 0.5) * amplitude
    data = np.clip(rgb + noise, 0.0, 1.0)
    return Image.fromarray((data * 255.0 + 0.5).astype(np.uint8), mode="RGB")


# --------------------------------------------------------------------------
# 1. Covered cells: an original moulded composite block
# --------------------------------------------------------------------------

BOARD_TEXTURE_SIZE = 512
FRAME_WIDTH = 0.145  # raised rim, in texture units
FRAME_BEVEL = 0.028
BOLT_RADIUS = 0.037
BOLT_INSET = 0.072
LIGHT = normalise(np.array([-0.45, -0.72, 0.53]))  # from the upper left


def build_board_texture(size: int = BOARD_TEXTURE_SIZE) -> Image.Image:
    """One cube face: a brushed-steel block with a raised rim, bolts and a lid seam."""
    rng = rng_for("board")
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    u = (xx + 0.5) / size
    v = (yy + 0.5) / size

    # --- height field ------------------------------------------------------
    edge_distance = np.minimum(np.minimum(u, 1.0 - u), np.minimum(v, 1.0 - v))
    rim = smoothstep(FRAME_WIDTH - edge_distance, 0.0, FRAME_BEVEL)
    height = 0.8 * rim

    # Lid seam: a shallow groove running parallel to the rim inside the recess.
    height -= 0.30 * np.exp(-(((edge_distance - (FRAME_WIDTH + 0.035)) / 0.010) ** 2))

    # Corner bolts.
    for cx in (BOLT_INSET, 1.0 - BOLT_INSET):
        for cy in (BOLT_INSET, 1.0 - BOLT_INSET):
            radius = np.hypot(u - cx, v - cy) / BOLT_RADIUS
            height += 0.78 * np.sqrt(np.clip(1.0 - radius**2, 0.0, 1.0))
            # Countersunk rim around each bolt.
            height -= 0.26 * np.exp(-(((radius - 1.05) / 0.30) ** 2))

    # Shallow boss in the middle of the panel: barely there, just enough to
    # break the flat area up.  The lighting below works in units of the whole
    # face, so a "gentle dome" has to be a tiny number here.
    height += 0.0025 * smoothstep(np.hypot(u - 0.5, v - 0.5), 0.34, 0.16)

    # Fine surface relief so the flat areas are not perfectly flat.
    height += 0.0011 * (fbm((size, size), 24, rng, 3) - 0.5)

    # --- shading -----------------------------------------------------------
    dh_dv, dh_du = np.gradient(height)
    slope = size
    nx = -dh_du * slope
    ny = -dh_dv * slope
    nz = np.full_like(nx, 1.0)
    inv = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz)
    lambert = np.clip((nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) * inv, 0.0, 1.0)

    # Ambient occlusion: the recess sits in its own shadow.
    occlusion = 1.0 - 0.38 * (1.0 - rim)
    tone = (0.34 + 0.88 * lambert) * occlusion

    # --- material ----------------------------------------------------------
    # Cool, mid-bright steel.  The scene multiplies this by a near-white tint
    # (BOARD_COLORS.covered), so the albedo here is what the player sees.
    base = np.array([0.700, 0.722, 0.760])
    brushed = value_noise((size, size), 260, 5, rng)
    grain = value_noise((size, size), 320, 320, rng)
    mottle = fbm((size, size), 7, rng, 4)
    texture = 0.94 + 0.10 * (brushed - 0.5) + 0.045 * (grain - 0.5) + 0.08 * (mottle - 0.5)

    rgb = base[None, None, :] * (tone * texture)[..., None]

    # Cool shadows against neutral highlights: the signature of brushed steel.
    relief = np.clip(tone / max(float(tone.max()), 1e-6), 0.0, 1.0)
    shadow = 1.0 - smoothstep(relief, 0.15, 0.80)
    rgb *= np.array([0.84, 0.92, 1.12]) * shadow[..., None] + np.array([1.02, 1.00, 0.97]) * (
        1.0 - shadow
    )[..., None]

    # Crisp dark rim at the very edge of the face so neighbouring cubes stay
    # readable as separate blocks when they touch.
    rgb *= (0.38 + 0.62 * smoothstep(edge_distance, 0.0, 0.013))[..., None]
    # Very slight top-to-bottom falloff.
    rgb *= (1.0 - 0.06 * (v - 0.5))[..., None]

    return to_image(rgb)


# --------------------------------------------------------------------------
# 2. Surroundings: the world behind the board, generated face by face
# --------------------------------------------------------------------------

CUBEMAP_SIZE = 1024
FACES = ("posx", "negx", "posy", "negy", "posz", "negz")

# Default camera direction, from the camera rig.  Every "screen space" trick
# below (key light, vignette, contact shadow) is really a function of direction,
# measured as an angle away from where the player actually looks.
VIEW = normalise(np.array([0.0, 0.62, 0.79]))


def cone(direction: np.ndarray, axis: np.ndarray, radius: float) -> np.ndarray:
    """Soft circular blob of angular ``radius`` (radians) around ``axis``."""
    angle = np.arccos(np.clip(np.einsum("...i,i->...", direction, axis), -1.0, 1.0))
    return np.exp(-((angle / radius) ** 2))


def vignette(direction: np.ndarray, strength: float = 0.28, radius: float = 0.70) -> np.ndarray:
    """Darkening towards the edge of the default view, as a direction field.

    A cube map has no screen, so this is the honest approximation: the falloff
    is centred on :data:`VIEW` and driven by the angle away from it.
    """
    angle = np.arccos(np.clip(np.einsum("...i,i->...", direction, VIEW), -1.0, 1.0))
    return 1.0 - strength * smoothstep(angle, radius * 0.55, radius * 1.75)


def studio_environment(
    direction: np.ndarray,
    size: int,
    rng: np.random.Generator,
    *,
    variant: str,
    zenith: np.ndarray,
    horizon: np.ndarray,
    floor: np.ndarray,
    key: np.ndarray,
    key_tint: np.ndarray,
    key_radius: float,
    key_strength: float,
    shadow: float,
) -> np.ndarray:
    """A soft daylight studio: one gradient sweep, a key light, a soft floor.

    There is no sun, no horizon line and no cloud deck - just the sweep of a
    seamless backdrop, which keeps the eye on the board.
    """
    up = direction[..., 1]

    # --- the sweep: bright overhead, settling as it comes down ---------------
    height = smoothstep(up, -1.0, 1.0)
    colour = horizon + (zenith - horizon) * height[..., None]

    # A slight brightening just above eye level reads as the curve of a
    # cyclorama rather than a flat painted wall.
    colour = colour + (horizon * 0.16) * (cone(direction, VIEW, 0.55) * height)[..., None]

    # --- floor ---------------------------------------------------------------
    # Two stops down from the sweep, only visible below the board, so the board
    # has something to stand on instead of floating in a white void.  The upper
    # end of the ramp sits a little below the horizon: "level with the board" is
    # where a backdrop's curve usually is.
    down = smoothstep(-up, -0.16, 0.42)
    colour = colour * (1.0 - down)[..., None] + floor * down[..., None]

    # --- very fine grain so the smooth gradient cannot band ------------------
    grain = value_noise((size, size), 96, 96, rng_for(f"grain:{variant}"))
    colour = colour * (0.995 + 0.010 * grain)[..., None]

    # --- key light -----------------------------------------------------------
    colour = colour + key_tint * (key_strength * cone(direction, key, key_radius))[..., None]

    # --- soft contact shadow under the board ---------------------------------
    # Cheap fake occlusion: darken the floor directly below the board, which is
    # what tells the eye the board is resting in a room rather than floating.
    if shadow > 0.0:
        pool = cone(direction, normalise(VIEW - np.array([0.0, 0.34, 0.0])), 0.30)
        colour = colour * (1.0 - shadow * pool * down)[..., None]

    return colour * vignette(direction)[..., None]


def cyclorama_environment(direction: np.ndarray, size: int, rng: np.random.Generator) -> np.ndarray:
    """A seamless cyclorama: neutral, cool and almost shadowless."""
    return studio_environment(
        direction,
        size,
        rng,
        variant="cyclorama",
        zenith=np.array([0.930, 0.943, 0.966]),
        horizon=np.array([0.585, 0.606, 0.643]),
        floor=np.array([0.320, 0.336, 0.372]),
        key=normalise(np.array([-0.52, 0.74, 0.42])),
        key_tint=np.array([0.055, 0.055, 0.050]),
        key_radius=0.80,
        key_strength=0.50,
        shadow=0.34,
    )


def glow_environment(direction: np.ndarray, size: int, rng: np.random.Generator) -> np.ndarray:
    """A darker take: a glow behind the board fading into deep neutral."""
    return studio_environment(
        direction,
        size,
        rng,
        variant="glow",
        zenith=np.array([0.084, 0.090, 0.108]),
        horizon=np.array([0.135, 0.140, 0.164]),
        floor=np.array([0.058, 0.061, 0.075]),
        key=normalise(np.array([-0.30, 0.30, 0.90])),
        key_tint=np.array([0.46, 0.435, 0.400]),
        key_radius=0.70,
        key_strength=1.60,
        shadow=0.30,
    )

SUN = normalise(np.array([0.62, 0.26, 0.74]))  # direction towards the sun
ZENITH = np.array([0.036, 0.052, 0.115])
HORIZON_SKY = np.array([0.235, 0.180, 0.235])
HORIZON_GLOW = np.array([1.00, 0.46, 0.20])
GROUND_DARK = np.array([0.028, 0.030, 0.042])
HAZE = np.array([0.30, 0.22, 0.26])
GROUND_PLANE = 420.0  # world units below the eye; only sets the grid perspective
GRID_CELL = 140.0


def face_directions(face: str, size: int) -> np.ndarray:
    """Unit view direction of every texel of one cube face.

    Follows the OpenGL cube map convention three.js uses.  ``CubeTexture`` sets
    ``flipY = false``, so the first image row is ``t = 0`` and the ``+v`` axis of
    the table points *up* in the picture.
    """
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    u = 2.0 * (xx + 0.5) / size - 1.0
    v = 2.0 * (yy + 0.5) / size - 1.0
    ones = np.ones_like(u)
    if face == "posx":
        d = np.stack([ones, -v, -u], axis=-1)
    elif face == "negx":
        d = np.stack([-ones, -v, u], axis=-1)
    elif face == "posy":
        d = np.stack([u, ones, v], axis=-1)
    elif face == "negy":
        d = np.stack([u, -ones, -v], axis=-1)
    elif face == "posz":
        d = np.stack([u, -v, ones], axis=-1)
    elif face == "negz":
        d = np.stack([-u, -v, -ones], axis=-1)
    else:  # pragma: no cover - guarded by the caller
        raise ValueError(f"unknown cube face {face!r}")
    return d / np.linalg.norm(d, axis=-1, keepdims=True)


def dir_to_face_uv(direction: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Inverse of :func:`face_directions`: direction -> (face index, u, v).

    Accepts any leading shape (``(h, w, 3)`` or ``(n, 3)``).  The face index
    addresses :data:`FACES`; ``u`` and ``v`` are in ``[0, 1]`` with ``v = 0`` on
    the first image row.
    """
    shape = direction.shape[:-1]
    flat = direction.reshape(-1, 3)
    absolute = np.abs(flat)
    axis = np.argmax(absolute, axis=-1)
    safe = np.maximum(absolute.max(axis=-1), 1e-12)
    unit = flat / safe[:, None]
    x, y, z = unit[:, 0], unit[:, 1], unit[:, 2]
    positive = np.take_along_axis(flat, axis[:, None], axis=-1)[:, 0] > 0.0

    # s/t of the cube map table, per major axis and sign.
    su = np.where(
        axis == 0,
        np.where(positive, -z, z),
        np.where(axis == 1, x, np.where(positive, x, -x)),
    )
    sv = np.where(axis == 1, np.where(positive, z, -z), -y)

    face = axis * 2 + np.where(positive, 0, 1)
    return (
        face.reshape(shape),
        ((su + 1.0) * 0.5).reshape(shape),
        ((sv + 1.0) * 0.5).reshape(shape),
    )


def environment(direction: np.ndarray, size: int, rng: np.random.Generator) -> np.ndarray:
    """The twilight sky: a sun, a cloud deck and a faint grid on the ground."""
    up = direction[..., 1]
    sun_angle = np.clip(np.einsum("...i,i->...", direction, SUN), -1.0, 1.0)

    # --- sky ---------------------------------------------------------------
    height = np.clip(up, 0.0, 1.0) ** 0.55
    sky = ZENITH + (HORIZON_SKY - ZENITH) * (1.0 - height)[..., None]

    # Clouds: a noise plane projected onto the dome, so they compress towards
    # the horizon the way real cloud decks do.  The noise lattice wraps, so the
    # deck has no edge of its own.
    cloud_plane = np.stack(
        [direction[..., 0], direction[..., 2]], axis=-1
    ) / (np.clip(up, 0.06, None) + 0.17)[..., None]
    cloud_field = fbm_at(cloud_plane[..., 0] * 0.55, cloud_plane[..., 1] * 0.55, 5, rng, 5)
    cover = smoothstep(cloud_field, 0.52, 0.70) * smoothstep(up, 0.015, 0.22)
    lit = (0.55 + 0.45 * smoothstep(sun_angle, -0.1, 0.9))[..., None]
    cloud_colour = np.array([0.52, 0.40, 0.44]) * lit
    sky = sky * (1.0 - 0.85 * cover)[..., None] + cloud_colour * (0.85 * cover)[..., None]

    # Sun: a soft halo plus a tight disc.
    halo = np.exp(-(1.0 - sun_angle) * 9.0) * np.clip(up + 0.25, 0.0, None)
    disc = smoothstep(sun_angle, 0.99965, 0.99995)
    sky = sky + HORIZON_GLOW * (halo * 0.85)[..., None] + np.array([1.0, 0.92, 0.78]) * disc[..., None]

    # --- ground ------------------------------------------------------------
    distance = GROUND_PLANE / np.clip(-up, 1e-6, None)
    hit_x = direction[..., 0] * distance
    hit_z = direction[..., 2] * distance
    line_x = np.abs((hit_x / GRID_CELL + 0.5) % 1.0 - 0.5) * GRID_CELL
    line_z = np.abs((hit_z / GRID_CELL + 0.5) % 1.0 - 0.5) * GRID_CELL
    nearest = np.minimum(line_x, line_z)
    footprint = distance * (2.0 / size) * 1.35
    grid = (1.0 - smoothstep(nearest, 0.0, footprint)) * np.exp(-distance / 1700.0)

    ground = GROUND_DARK + np.array([0.10, 0.11, 0.15]) * grid[..., None]
    # Warm sheen where the sun grazes the ground, and a lift towards the horizon.
    ground += HORIZON_GLOW * (
        0.16 * np.exp(-(1.0 - sun_angle) * 5.0) * np.exp(-(-up) * 9.0)
    )[..., None]
    ground += np.array([0.06, 0.05, 0.08]) * np.exp(-(-up) * 18.0)[..., None]

    colour = np.where((up >= 0.0)[..., None], sky, ground)

    # --- haze right at the horizon ----------------------------------------
    haze = np.exp(-((up / 0.045) ** 2))
    warm = 0.5 + 0.5 * smoothstep(sun_angle, -0.2, 1.0)
    haze_colour = HAZE * (0.6 + 0.7 * warm)[..., None]
    colour = colour * (1.0 - 0.55 * haze)[..., None] + haze_colour * (0.55 * haze)[..., None]

    return colour


#: Every surrounding world this script can draw: name -> (painter, has stars).
SKY_VARIANTS: dict[str, tuple[object, bool]] = {
    "dusk": (environment, True),
    "cyclorama": (cyclorama_environment, False),
    "glow": (glow_environment, False),
}

#: What is installed unless ``--variant`` says otherwise.  The client has no
#: preference: this is the art direction decision, made once, here.
DEFAULT_SKY = "cyclorama"


def add_stars(colour: np.ndarray, direction: np.ndarray, size: int, rng: np.random.Generator) -> np.ndarray:
    """Splats stars as angular gaussians, so they survive face boundaries."""
    out = colour
    count = 1400
    # Uniform points on the sphere, kept to the sky.
    vectors = rng.normal(size=(count, 3))
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    keep = vectors[:, 1] > 0.04
    vectors = vectors[keep]
    brightness = 0.35 + 0.65 * rng.random(len(vectors)) ** 2.4

    face, u, v = dir_to_face_uv(vectors)
    px = u * size
    py = v * size
    margin = 10

    for index in range(len(vectors)):
        # The star is painted on whichever faces its glow reaches.
        for candidate in range(6):
            if face[index] != candidate:
                continue
            x0 = int(math.floor(px[index] - margin))
            x1 = int(math.ceil(px[index] + margin))
            y0 = int(math.floor(py[index] - margin))
            y1 = int(math.ceil(py[index] + margin))
            if x1 < 0 or y1 < 0 or x0 >= size or y0 >= size:
                continue
            cx0, cy0 = max(0, x0), max(0, y0)
            cx1, cy1 = min(size, x1), min(size, y1)
            if cx1 <= cx0 or cy1 <= cy0:
                continue
            patch = direction[cy0:cy1, cx0:cx1]
            angle = np.arccos(np.clip(np.einsum("...i,i->...", patch, vectors[index]), -1.0, 1.0))
            core = np.exp(-((angle / 0.0016) ** 2))
            halo = np.exp(-((angle / 0.0042) ** 2)) * 0.22
            sparkle = (core + halo) * brightness[index]
            fade = smoothstep(vectors[index][1], 0.04, 0.30)
            out[cy0:cy1, cx0:cx1] += (sparkle * fade)[..., None] * np.array([0.92, 0.94, 1.0])
    return out


def build_cubemap(size: int = CUBEMAP_SIZE, variant: str = DEFAULT_SKY) -> dict[str, Image.Image]:
    """The six environment faces; the colour is a function of direction only.

    ``variant`` picks which surroundings to draw - see :data:`SKY_VARIANTS`.
    Each variant is fully determined by its name, so any of them can be
    regenerated byte for byte.
    """
    if variant not in SKY_VARIANTS:
        raise ValueError(f"unknown sky variant {variant!r}; known: {', '.join(SKY_VARIANTS)}")
    draw, stars = SKY_VARIANTS[variant]
    rng = rng_for(f"cubemap:{variant}")
    faces: dict[str, Image.Image] = {}
    for face in FACES:
        direction = face_directions(face, size)
        colour = draw(direction, size, rng)
        if stars:
            colour = add_stars(colour, direction, size, rng_for(f"stars:{variant}:{face}"))
        faces[face] = to_image(colour)
    return faces


def check_cubemap(size: int = 64, tolerance: float = 1.5) -> float:
    """Round-trips directions through the inverse mapping and checks the seams.

    Returns the worst error in texels.  A value below ``tolerance`` means the
    six faces agree about where every direction sits, so the environment has no
    visible seam.
    """
    worst = 0.0
    for face in FACES:
        direction = face_directions(face, size)
        major, u, v = dir_to_face_uv(direction)
        for candidate in range(6):
            selection = major == candidate
            if not selection.any():
                continue
            # Compare the direction stored in this texel with the one the
            # neighbouring face stores for the same round-tripped coordinate.
            px = np.clip(np.round(u[selection] * size - 0.5), 0, size - 1).astype(int)
            py = np.clip(np.round(v[selection] * size - 0.5), 0, size - 1).astype(int)
            recovered = face_directions(FACES[candidate], size)[py, px]
            error = np.linalg.norm(recovered - direction[selection], axis=-1) * size
            worst = max(worst, float(error.max()))
    return worst


def equirect_preview(faces: dict[str, Image.Image], width: int = 1024, height: int = 512) -> Image.Image:
    """Re-projects the generated faces into an equirectangular image.

    Purely a review aid: sampling the *written* face images shows whether they
    stitch into one continuous environment.
    """
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float64)
    longitude = (xx + 0.5) / width * 2.0 * math.pi
    latitude = (0.5 - (yy + 0.5) / height) * math.pi
    direction = np.stack(
        [
            np.cos(latitude) * np.cos(longitude),
            np.sin(latitude),
            np.cos(latitude) * np.sin(longitude),
        ],
        axis=-1,
    )
    major, u, v = dir_to_face_uv(direction)
    out = np.zeros((height, width, 3))
    for index, face in enumerate(FACES):
        data = np.asarray(faces[face], dtype=np.float64) / 255.0
        size = data.shape[0]
        selection = major == index
        px = np.clip((u * size).astype(int), 0, size - 1)
        py = np.clip((v * size).astype(int), 0, size - 1)
        out[selection] = data[py[selection], px[selection]]
    return Image.fromarray((out * 255.0 + 0.5).astype(np.uint8), mode="RGB")


# --------------------------------------------------------------------------
# 3. The mine: an original spiked ball, mesh and albedo
# --------------------------------------------------------------------------

MINE_TEXTURE_SIZE = 512
MINE_LON = 32
MINE_LAT = 20
MINE_BODY_V0 = 0.16  # texture v where the ball's skin starts (south pole)
MINE_SPIKE_V = (0.030, 0.105)
MINE_SPIKE_RADIUS = 0.20
MINE_SPIKE_BASE = 0.94
MINE_SPIKE_TIP = 1.22
MINE_SPIKE_SIDES = 8
MINE_SPIKE_DIRECTIONS = [
    (1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1),
    (1, 1, 1), (1, 1, -1), (1, -1, 1), (1, -1, -1),
    (-1, 1, 1), (-1, 1, -1), (-1, -1, 1), (-1, -1, -1),
]


def build_mine_texture(size: int = MINE_TEXTURE_SIZE) -> Image.Image:
    """Albedo atlas: the ball's skin on top, a dark swatch for the spikes below."""
    rng = rng_for("mine")
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    u = (xx + 0.5) / size
    v = (yy + 0.5) / size

    # Skin: a light neutral steel with rows of plating and a hazard band.
    skin = np.full((size, size), 0.90)
    skin += 0.05 * (fbm((size, size), 9, rng, 4) - 0.5)
    skin += 0.02 * (value_noise((size, size), 200, 200, rng) - 0.5)

    # Latitude of each row inside the ball's part of the atlas.
    body_v = np.clip((v - MINE_BODY_V0) / (1.0 - MINE_BODY_V0), 0.0, 1.0)
    theta = (1.0 - body_v) * math.pi  # 0 at the north pole

    # Plate seams.
    for seam in (0.30, 0.62, 1.34, 2.36, 2.72):
        skin -= 0.34 * np.exp(-(((theta - seam) / 0.035) ** 2))
    # The equatorial hazard band: a dark stripe crossed by crisp ribs.
    band = np.exp(-(((theta - math.pi / 2) / 0.20) ** 2))
    ribs = smoothstep(0.5 + 0.5 * np.cos(u * 2.0 * math.pi * 24.0), 0.40, 0.72)
    skin = skin * (1.0 - 0.46 * band) + 0.20 * band * ribs
    # A darker cap around the north pole reads as a hatch.
    skin -= 0.20 * smoothstep(theta, 0.55, 0.30) * (1.0 - 0.6 * ribs)

    # Rivets on a brick grid, clear of the band.
    column = np.floor(u * 10.0)
    rivet_u = (u * 10.0) % 1.0
    rivet_v = (body_v * 8.0 + 0.5 * (column % 2.0)) % 1.0
    rivet = (1.0 - smoothstep(np.hypot(rivet_u - 0.5, rivet_v - 0.5), 0.05, 0.13)) * (1.0 - band)
    skin -= 0.34 * rivet

    rgb = np.repeat(np.clip(skin, 0.0, 1.0)[..., None], 3, axis=2)

    # Spike swatch: near-black, so the silhouette stays dark under the tint.
    spike_top = int((1.0 - MINE_SPIKE_V[1]) * size)
    spike_bottom = int((1.0 - MINE_SPIKE_V[0]) * size)
    swatch = 0.20 + 0.06 * (1.0 - np.linspace(0.0, 1.0, spike_bottom - spike_top))[:, None]
    rgb[spike_top:spike_bottom, :, :] = swatch[..., None]
    rgb[spike_bottom:, :, :] = 0.20  # unused margin, kept dark for safety

    return to_image(rgb)


class ObjBuilder:
    """Collects vertices and triangles, then emits a wavefront OBJ string."""

    def __init__(self) -> None:
        self.positions: list[tuple[float, float, float]] = []
        self.uvs: list[tuple[float, float]] = []
        self.normals: list[tuple[float, float, float]] = []
        self.faces: list[tuple[tuple[int, int, int], ...]] = []

    def vertex(self, position, uv, normal) -> int:
        self.positions.append(tuple(float(value) for value in position))
        self.uvs.append(tuple(float(value) for value in uv))
        self.normals.append(tuple(float(value) for value in normal))
        return len(self.positions)

    def triangle(self, a: int, b: int, c: int) -> None:
        indices = (a, b, c)
        # Keep every face wound counter-clockwise as seen from outside: the mine
        # is star shaped around the origin, so an outward normal always points
        # away from the centre.
        pa, pb, pc = (np.array(self.positions[i - 1]) for i in indices)
        normal = np.cross(pb - pa, pc - pa)
        centroid = (pa + pb + pc) / 3.0
        if float(np.dot(normal, centroid)) < 0.0:
            indices = (a, c, b)
        self.faces.append(tuple(indices))

    def render(self) -> str:
        lines = [
            "# Minesweeper 3D - generated mine (tools/assets/generate.py)",
            "# Original geometry, released with the game; no third-party model data.",
            f"# vertices: {len(self.positions)}  triangles: {len(self.faces)}",
            "o mine",
        ]
        lines += [f"v {p[0]:.4f} {p[1]:.4f} {p[2]:.4f}" for p in self.positions]
        lines += [f"vt {t[0]:.4f} {t[1]:.4f}" for t in self.uvs]
        lines += [f"vn {n[0]:.4f} {n[1]:.4f} {n[2]:.4f}" for n in self.normals]
        lines += ["s 1"]
        lines += ["f " + " ".join(f"{i}/{i}/{i}" for i in face) for face in self.faces]
        return "\n".join(lines) + "\n"


def build_mine_obj() -> str:
    """A spiked ball: an equirect-mapped sphere plus axis and corner spikes."""
    builder = ObjBuilder()

    # --- ball --------------------------------------------------------------
    grid: list[list[int]] = []
    for j in range(MINE_LAT + 1):
        theta = math.pi * j / MINE_LAT
        row: list[int] = []
        for i in range(MINE_LON + 1):
            phi = 2.0 * math.pi * i / MINE_LON
            direction = np.array(
                [math.sin(theta) * math.cos(phi), math.cos(theta), math.sin(theta) * math.sin(phi)]
            )
            uv = (
                i / MINE_LON,
                MINE_BODY_V0 + (1.0 - MINE_BODY_V0) * (1.0 - theta / math.pi),
            )
            row.append(builder.vertex(direction, uv, direction))
        grid.append(row)

    for j in range(MINE_LAT):
        for i in range(MINE_LON):
            a, b = grid[j][i], grid[j][i + 1]
            c, d = grid[j + 1][i + 1], grid[j + 1][i]
            if j == 0:  # north pole: one triangle
                builder.triangle(a, d, c)
            elif j == MINE_LAT - 1:  # south pole
                builder.triangle(a, d, b)
            else:
                builder.triangle(a, d, c)
                builder.triangle(a, c, b)

    # --- spikes ------------------------------------------------------------
    for raw in MINE_SPIKE_DIRECTIONS:
        axis = normalise(np.array(raw, dtype=np.float64))
        # Any two vectors orthogonal to the axis span the base circle.
        helper = np.array([0.0, 1.0, 0.0]) if abs(axis[1]) < 0.9 else np.array([1.0, 0.0, 0.0])
        side = normalise(np.cross(axis, helper))
        other = np.cross(axis, side)
        apex = axis * MINE_SPIKE_TIP
        base_centre = axis * MINE_SPIKE_BASE
        ring = []
        uv_spike = ((MINE_SPIKE_V[0] + MINE_SPIKE_V[1]) * 0.5, (MINE_SPIKE_V[0] + MINE_SPIKE_V[1]) * 0.5)
        for k in range(MINE_SPIKE_SIDES):
            angle = 2.0 * math.pi * k / MINE_SPIKE_SIDES
            point = base_centre + MINE_SPIKE_RADIUS * (math.cos(angle) * side + math.sin(angle) * other)
            ring.append(point)
        # Flat-shaded sides: three vertices per triangle, apex normal from the
        # average of the two base directions.
        for k in range(MINE_SPIKE_SIDES):
            p0 = ring[k]
            p1 = ring[(k + 1) % MINE_SPIKE_SIDES]
            mid = normalise(((p0 + p1) * 0.5 - base_centre) + axis * 0.55)
            a = builder.vertex(apex, uv_spike, mid)
            b = builder.vertex(p1, uv_spike, mid)
            c = builder.vertex(p0, uv_spike, mid)
            builder.triangle(a, b, c)

    return builder.render()


def check_mine_obj(text: str) -> dict[str, float]:
    """Parses the OBJ again and reports its extents and triangle count."""
    positions: list[tuple[float, float, float]] = []
    triangles = 0
    for line in text.splitlines():
        if line.startswith("v "):
            _, x, y, z = line.split()
            positions.append((float(x), float(y), float(z)))
        elif line.startswith("f "):
            parts = line.split()[1:]
            for index in parts:
                vertex = int(index.split("/")[0])
                if vertex < 1 or vertex > len(positions):
                    raise ValueError(f"face references missing vertex {vertex}")
            triangles += len(parts) - 2
    data = np.array(positions)
    low = data.min(axis=0)
    high = data.max(axis=0)
    return {
        "triangles": float(triangles),
        "vertices": float(len(positions)),
        "extent": float(np.max(high - low)),
        "radius": float(np.max(np.linalg.norm(data, axis=1))),
    }


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def write_final(out: Path, variant: str = DEFAULT_SKY) -> list[Path]:
    """Writes the layout the client will use after the swap."""
    written: list[Path] = []

    board = out / "textures/board.jpg"
    save_jpeg(build_board_texture(), board)
    written.append(board)

    faces = build_cubemap(variant=variant)
    for name, image in faces.items():
        path = out / f"cubemap/{name}.jpg"
        save_jpeg(image, path)
        written.append(path)

    preview = out / "previews/equirect.jpg"
    save_jpeg(equirect_preview(faces), preview, quality=88)
    written.append(preview)

    mine_obj = out / "mines/mine.obj"
    mine_obj.parent.mkdir(parents=True, exist_ok=True)
    mine_obj.write_text(build_mine_obj(), encoding="utf-8")
    written.append(mine_obj)

    mine_png = out / "mines/mine.png"
    save_png(build_mine_texture(), mine_png)
    written.append(mine_png)

    return written


def write_compat(stage: Path, variant: str = DEFAULT_SKY) -> list[Path]:
    """Writes drop-in replacements under the *current* asset paths."""
    written: list[Path] = []

    crate = stage / "textures/crate_1.jpg"
    save_jpeg(build_board_texture(), crate)
    written.append(crate)

    for name, image in build_cubemap(variant=variant).items():
        path = stage / f"cubemap/{name}.jpg"
        save_jpeg(image, path)
        written.append(path)

    obj = stage / "Rollermine/Rollermine.obj"
    obj.parent.mkdir(parents=True, exist_ok=True)
    obj.write_text(build_mine_obj(), encoding="utf-8")
    written.append(obj)

    # The current client asks for a TGA; the preview keeps that exact path.
    tga = stage / "Rollermine/Texture/rollermine_sheet.tga"
    tga.parent.mkdir(parents=True, exist_ok=True)
    build_mine_texture().save(tga, format="TGA")
    written.append(tga)

    return written


def report(paths: list[Path]) -> None:
    for path in paths:
        size = path.stat().st_size
        print(f"  {size / 1024:8.1f} KiB  {path}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, help="write the final asset layout into this directory")
    parser.add_argument("--compat", type=Path, help="write drop-in replacements at the current paths")
    parser.add_argument("--check", action="store_true", help="run the geometry and cubemap self checks")
    parser.add_argument("--only", choices=["board", "cubemap", "mine"], help="generate a single piece")
    parser.add_argument(
        "--variant",
        choices=sorted(SKY_VARIANTS),
        default=DEFAULT_SKY,
        help="which surrounding world to draw (default: %(default)s)",
    )
    parser.add_argument("--list-variants", action="store_true", help="list the surrounding worlds and exit")
    args = parser.parse_args()

    if args.list_variants:
        for name in sorted(SKY_VARIANTS):
            marker = " (default)" if name == DEFAULT_SKY else ""
            print(f"  {name}{marker}")
        return 0

    if args.check or (args.out is None and args.compat is None):
        print("cubemap seam check (worst error in texels at 64px/face):")
        print(f"  {check_cubemap():.4f}  (want < 1.5)")
        stats = check_mine_obj(build_mine_obj())
        print("mine mesh:")
        print(
            f"  {stats['triangles']:.0f} triangles, {stats['vertices']:.0f} vertices, "
            f"extent {stats['extent']:.3f}, radius {stats['radius']:.3f}"
        )

    if args.out is not None:
        print(f"final layout -> {args.out}  (sky: {args.variant})")
        report(write_final(args.out, args.variant))

    if args.compat is not None:
        print(f"compatibility layout -> {args.compat}  (sky: {args.variant})")
        report(write_compat(args.compat, args.variant))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
