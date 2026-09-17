/**
 * Export a signature canvas as a PNG of the signature, not of the pad.
 *
 * A signing pad fills the screen, so a name written across the middle of it
 * is a small mark on a very large, mostly empty image. Placed anywhere with
 * a set height — a form's signature line, say — that image scales by its own
 * aspect ratio and the writing shrinks to a few pixels. Cropping to the ink
 * first makes the exported image the signature's own shape, so it fills
 * whatever it is put in.
 *
 * Returns null when nothing was drawn, which is what an untouched pad should
 * count as rather than a blank image nobody can tell from a real one.
 */
export function trimmedSignature(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext('2d');
  if (!ctx || canvas.width === 0 || canvas.height === 0) return null;

  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let top = canvas.height;
  let left = canvas.width;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      // The alpha channel alone: the ink is opaque, the pad is not.
      if (data[(y * canvas.width + x) * 4 + 3] === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (right < 0) return null;

  // A little air around the writing, so it does not sit flush against the
  // edge of its own image.
  const pad = Math.round(Math.max(canvas.width, canvas.height) * 0.01) + 2;
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  right = Math.min(canvas.width - 1, right + pad);
  bottom = Math.min(canvas.height - 1, bottom + pad);

  const out = document.createElement('canvas');
  out.width = right - left + 1;
  out.height = bottom - top + 1;
  const outCtx = out.getContext('2d');
  if (!outCtx) return null;
  outCtx.drawImage(
    canvas,
    left,
    top,
    out.width,
    out.height,
    0,
    0,
    out.width,
    out.height
  );
  return out.toDataURL('image/png');
}
