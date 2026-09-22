// Turning a signed screen into the PDF that gets filed (officer feedback).
//
// There is no server-side PDF renderer here on purpose. The alternative is a
// headless browser in a Vercel function — heavy, and a second place that has
// to agree with what the officer actually saw on screen. This instead
// rasterises the exact DOM the officer signed on, in the browser that
// rendered it, so the filed document and the screen it came from can never
// drift apart.
//
// What that costs: a raster PDF, not a vector one — the same trade a scanned
// paper form always made, and no worse than what "Print → Save as PDF" was
// already producing. Pagination is a straightforward slice of a tall image
// into A4-height pages, not layout-aware; for the one and two-page forms this
// renders, that has never produced a page break through the middle of a row
// in testing, and a break that is not perfect costs nothing a reader can't
// still read.
// html2canvas-pro rather than html2canvas: the base package's colour
// parser predates CSS Color 4 and throws on oklch(), which is how
// Tailwind v4 — and so every page BaseLayout wraps, this one included —
// expresses its palette. The fork is the same API, with that fixed.
import html2canvas from 'html2canvas-pro';
import { jsPDF } from 'jspdf';

const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;

export interface RenderOptions {
  // Raised for a screen with fine print or a signature's own detail; the
  // trade is a larger file for a crisper one.
  scale?: number;
  // Blank border kept around the content on every page, in millimetres —
  // matched to print.astro's own @page margin so the generated PDF reads
  // the same as what "Print → Save as PDF" already produced.
  marginMm?: number;
}

/**
 * Rasterise `element` and lay it out as one or more A4 pages, returning the
 * finished PDF as a Blob ready to upload.
 */
export async function renderElementToPdf(
  element: HTMLElement,
  options: RenderOptions = {}
): Promise<Blob> {
  const scale = options.scale ?? 2;
  const marginMm = options.marginMm ?? 10;
  const contentWidthMm = A4_WIDTH_MM - marginMm * 2;
  const usableHeightMm = A4_HEIGHT_MM - marginMm * 2;

  const canvas = await html2canvas(element, {
    scale,
    useCORS: true,
    backgroundColor: '#ffffff',
    // The officer may have scrolled the page while signing; capturing at a
    // fixed window origin means the image is not accidentally cropped to
    // wherever the viewport happened to be.
    scrollX: 0,
    scrollY: -window.scrollY,
    windowWidth: document.documentElement.scrollWidth,
    windowHeight: document.documentElement.scrollHeight,
  });

  // The element's own pixel width maps to contentWidthMm on the page, which
  // fixes the mm-per-pixel scale for height too — so a page break falls at a
  // consistent distance down the actual content, not the capture's raw
  // pixels.
  const mmPerPixel = contentWidthMm / canvas.width;
  const pageHeightPx = Math.floor(usableHeightMm / mmPerPixel);
  const pageWidthPx = canvas.width;
  const totalHeightPx = canvas.height;
  const pageCount = Math.max(1, Math.ceil(totalHeightPx / pageHeightPx));

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const sliceCanvas = document.createElement('canvas');
  const sliceContext = sliceCanvas.getContext('2d');
  if (!sliceContext) {
    throw new Error('This browser cannot render a PDF (no 2D canvas).');
  }
  sliceCanvas.width = pageWidthPx;

  for (let page = 0; page < pageCount; page += 1) {
    const sliceTop = page * pageHeightPx;
    const sliceHeight = Math.min(pageHeightPx, totalHeightPx - sliceTop);
    sliceCanvas.height = sliceHeight;

    sliceContext.fillStyle = '#ffffff';
    sliceContext.fillRect(0, 0, pageWidthPx, sliceHeight);
    sliceContext.drawImage(
      canvas,
      0,
      sliceTop,
      pageWidthPx,
      sliceHeight,
      0,
      0,
      pageWidthPx,
      sliceHeight
    );

    const imageData = sliceCanvas.toDataURL('image/jpeg', 0.92);
    if (page > 0) pdf.addPage();
    const renderedHeightMm = sliceHeight * mmPerPixel;
    pdf.addImage(
      imageData,
      'JPEG',
      marginMm,
      marginMm,
      contentWidthMm,
      renderedHeightMm,
      undefined,
      'FAST'
    );
  }

  return pdf.output('blob');
}
