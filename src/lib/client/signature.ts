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

/**
 * A full-screen pad to sign on, with Clear and "Use this signature".
 *
 * Built fresh on each call rather than kept in the page: a form that is
 * never signed should not ship a modal nobody opens. Resolves to the
 * signature as a cropped PNG, or to null if it was cancelled or left blank.
 */
export function openSignaturePad(title: string): Promise<string | null> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:70;background:#fff;display:flex;flex-direction:column;';

    const barStyle =
      'display:flex;justify-content:space-between;align-items:center;' +
      'padding:10px 14px;font:600 14px system-ui,sans-serif;border-bottom:1px solid #ddd;';
    const buttonStyle =
      'font:inherit;padding:4px 10px;border:1px solid #999;background:#eee;cursor:pointer;';

    const bar = document.createElement('div');
    bar.style.cssText = barStyle;
    const heading = document.createElement('span');
    heading.textContent = title;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.style.cssText = buttonStyle;
    bar.append(heading, cancel);

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'flex:1;touch-action:none;cursor:crosshair;';

    const bottomBar = document.createElement('div');
    bottomBar.style.cssText = barStyle;
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Clear';
    clear.style.cssText = buttonStyle;
    const done = document.createElement('button');
    done.type = 'button';
    done.textContent = 'Use this signature';
    done.style.cssText =
      'font:inherit;font-weight:700;padding:4px 10px;border:1px solid #333;background:#cdeedb;cursor:pointer;';
    bottomBar.append(clear, done);

    overlay.append(bar, canvas, bottomBar);
    document.body.appendChild(overlay);

    const ctx = canvas.getContext('2d');
    const size = () => {
      if (!ctx) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#1a1a2e';
    };
    // Measured after layout, not on the tick the overlay was inserted on — a
    // just-inserted element can still report a zero size, which would leave
    // the canvas with no drawing surface.
    requestAnimationFrame(size);

    let drawing = false;
    let last: { x: number; y: number } | null = null;
    const pointFrom = (e: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      return { x: e.clientX - box.left, y: e.clientY - box.top };
    };
    canvas.addEventListener('pointerdown', e => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      drawing = true;
      last = pointFrom(e);
    });
    canvas.addEventListener('pointermove', e => {
      if (!drawing || !last || !ctx) return;
      const point = pointFrom(e);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
      last = point;
    });
    const stop = () => {
      drawing = false;
      last = null;
    };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    canvas.addEventListener('pointerleave', stop);

    const finish = (result: string | null) => {
      overlay.remove();
      resolve(result);
    };
    cancel.addEventListener('click', () => finish(null));
    clear.addEventListener('click', () => {
      if (!ctx) return;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    });
    done.addEventListener('click', () => finish(trimmedSignature(canvas)));
  });
}
