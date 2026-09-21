/**
 * Shrink a photographed document before it is uploaded.
 *
 * A phone camera produces several megabytes for a page of A4, and every one
 * of them crosses a branch connection twice — once to SharePoint, and again
 * each time somebody opens or prints the document. None of that resolution
 * is readable on the page: what matters is that the text can be read, which
 * a long edge of 2400px carries comfortably for a scanned form.
 *
 * Returns the original file untouched when there is nothing to gain — it is
 * not an image, it is a format the browser cannot decode (HEIC), it is
 * already small, or the re-encode came out no smaller. A compression that
 * makes a file bigger is not one worth keeping.
 */

// Enough to read a form at full zoom, and far less than a modern camera.
const MAX_EDGE = 2400;
// Below this, re-encoding costs quality and saves little.
const SKIP_BELOW_BYTES = 1024 * 1024;
const JPEG_QUALITY = 0.82;

function renamed(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name) + '.jpg';
}

export async function compressImageForUpload(file: File): Promise<File> {
  // HEIC is on the upload allow-list but no browser decodes it to a canvas,
  // so it goes up as it came in.
  if (!file.type.startsWith('image/') || file.type === 'image/heic') {
    return file;
  }
  if (file.size <= SKIP_BELOW_BYTES) return file;
  if (typeof createImageBitmap !== 'function') return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // An image this browser cannot decode is still one SharePoint can hold.
    return file;
  }

  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return file;
    // A scan photographed against a dark desk would otherwise pick up black
    // where the source had transparency.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY)
    );
    if (!blob || blob.size >= file.size) return file;

    return new File([blob], renamed(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
}

/** "5.2 MB", for telling the officer what just happened to their file. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
