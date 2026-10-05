/**
 * Asset locations, resolved against the Vite base URL so the client also works
 * when it is served from a sub-path.
 */

/** The six cubemap faces in the order `CubeTextureLoader` expects them. */
export type CubemapFaces = [string, string, string, string, string, string];

/** Paths below `public/`, relative to the client root. */
export const ASSETS = Object.freeze({
  crateTexture: "textures/board.jpg",
  font: "fonts/optimer_regular.typeface.json",
  mineModel: "mines/mine.obj",
  mineTexture: "mines/mine.png",
  /** Order required by `CubeTextureLoader`: +x, -x, +y, -y, +z, -z. */
  cubemap: [
    "cubemap/posx.jpg",
    "cubemap/negx.jpg",
    "cubemap/posy.jpg",
    "cubemap/negy.jpg",
    "cubemap/posz.jpg",
    "cubemap/negz.jpg",
  ] as CubemapFaces,
});

/** Turns a `public/` relative path into a URL the loaders can fetch. */
export function assetUrl(path: string): string {
  const base = baseUrl();
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return `${prefix}${path.replace(/^\/+/, "")}`;
}

/** The six cubemap face URLs, as a tuple `useLoader` accepts. */
export function cubemapUrls(): CubemapFaces {
  const [posx, negx, posy, negy, posz, negz] = ASSETS.cubemap;
  return [assetUrl(posx), assetUrl(negx), assetUrl(posy), assetUrl(negy), assetUrl(posz), assetUrl(negz)];
}

/** Vite's configured base; `/` when running outside a bundler (tests). */
function baseUrl(): string {
  const env = import.meta.env as { BASE_URL?: string } | undefined;
  return env?.BASE_URL ?? "/";
}
