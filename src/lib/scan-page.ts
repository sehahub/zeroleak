// Walks a page's operator list to find content that is present in the file
// but not readable on screen: text painted over, text drawn invisibly,
// and text placed outside the visible page area.
import { area, IDENTITY, intersect, mul, transformBox, unionCoverage } from './geometry.ts';
import type { Box, Matrix } from './geometry.ts';

export type TextRun = {
  box: Box; text: string; invisible: boolean; order: number;
  /** The clip in force when this run was painted. Text clipped down to
   *  nothing is as absent from the page as text pushed off the edge. */
  clip: Box;
};
export type Cover = { box: Box; color: string; order: number; kind: 'fill' | 'image' };

export type PageScan = {
  covered: { text: string; color: string; box: Box }[];
  invisible: string[];
  offPage: string[];
  runs: number;
  /** Invisible text lying over a picture: an OCR layer doing its job, rather
   *  than a paragraph somebody hid. */
  ocr: string[];
};

/** Only Normal compositing actually hides what is beneath. Highlighter pens
 *  use Multiply, which leaves the text readable. */
function isOpaqueBlend(bm: string): boolean {
  return bm === 'Normal' || bm === 'Compatible' || bm === '';
}

// Paint operators that lay down an opaque fill.
const FILL_OPS = new Set([22, 23, 24, 25, 26, 27]);
// Coordinates consumed by each path-construction opcode in pdf.js's packed array.
const DRAW_ARITY: Record<number, number> = { 0: 2, 1: 2, 2: 6, 3: 4, 4: 0 };

type GState = {
  ctm: Matrix; fill: string; alpha: number; blend: string; clip: Box;
  fontSize: number; leading: number; charSpacing: number; wordSpacing: number; hScale: number;
  render: number;
};

function cloneState(s: GState): GState { return { ...s }; }

function toMatrix(v: unknown): Matrix {
  const a = v as ArrayLike<number>;
  return [a[0], a[1], a[2], a[3], a[4], a[5]];
}

const rgbHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

function normalizeColor(args: unknown[]): string {
  if (typeof args[0] === 'string') return args[0];
  const n = args.filter((a) => typeof a === 'number') as number[];
  if (n.length === 1) { const v = n[0] * 255; return rgbHex(v, v, v); }
  if (n.length === 3) return rgbHex(n[0] * 255, n[1] * 255, n[2] * 255);
  if (n.length === 4) {
    const c = n[0], m = n[1], y = n[2], k = n[3];
    return rgbHex(255 * (1 - Math.min(1, c + k)), 255 * (1 - Math.min(1, m + k)), 255 * (1 - Math.min(1, y + k)));
  }
  return '#000000';
}

/** pdf.js hands us either one packed coordinate array or a list of them. */
function extractRectsFromArg(arg: unknown): Box[] | null {
  const a = arg as ArrayLike<unknown>;
  if (!a || typeof a.length !== 'number') return null;
  if (a.length > 0 && typeof a[0] !== 'number') {
    const all: Box[] = [];
    for (let i = 0; i < a.length; i++) {
      // pdf.js emits [paintOp, [null], null] when a paint operator arrives with
      // no path built. Reaching for .length on that threw, and the per-page
      // catch turned one malformed operator into a whole page nobody looked at.
      const entry = a[i];
      if (!entry) continue;
      const part = extractRects(entry as ArrayLike<number>);
      if (!part) return null;
      all.push(...part);
    }
    return all.length ? all : null;
  }
  return extractRects(arg as ArrayLike<number>);
}

/** Splits pdf.js's packed path data into axis-aligned rectangles. Returns null
 *  when the path is anything more complex, so ordinary artwork is never
 *  mistaken for a redaction box. */
function extractRects(coords: ArrayLike<number>): Box[] | null {
  const subpaths: [number, number][][] = [];
  let cur: [number, number][] | null = null;
  let i = 0;
  while (i < coords.length) {
    const op = coords[i];
    const arity = DRAW_ARITY[op];
    if (arity === undefined) return null;
    if (op === 2 || op === 3) return null; // curves: not a rectangle
    i += 1;
    if (op === 0) { cur = [[coords[i], coords[i + 1]]]; subpaths.push(cur); }
    else if (op === 1) { if (!cur) return null; cur.push([coords[i], coords[i + 1]]); }
    i += arity;
  }
  const rects: Box[] = [];
  for (const pts of subpaths) {
    const closed = pts.length === 5 && pts[0][0] === pts[4][0] && pts[0][1] === pts[4][1];
    const p = closed ? pts.slice(0, 4) : pts;
    if (p.length !== 4) continue;
    const xs = new Set(p.map((q) => Math.round(q[0] * 100)));
    const ys = new Set(p.map((q) => Math.round(q[1] * 100)));
    if (xs.size !== 2 || ys.size !== 2) continue; // not axis-aligned
    const X = p.map((q) => q[0]);
    const Y = p.map((q) => q[1]);
    rects.push({ x0: Math.min(...X), y0: Math.min(...Y), x1: Math.max(...X), y1: Math.max(...Y) });
  }
  return rects.length ? rects : null;
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim();

/** Runs of punctuation carry no information and are usually an artefact of a
 *  font whose character mapping could not be resolved. Reporting them as
 *  hidden text is a false alarm. */
const hasSubstance = (t: string) => /[\p{L}\p{N}]/u.test(t);

/** True when the same text is painted somewhere on this page where a reader can
 *  actually see it. Diagram labels and button captions are routinely drawn more
 *  than once, and a run whose words are legible elsewhere is hiding nothing.
 *
 *  Only filled shapes count against the other instance. Pictures sit on top of
 *  composition text all the time in figures — treating them as concealment made
 *  every label in a chart look redacted. */
function drawnInTheOpen(run: TextRun, runs: TextRun[], covers: Cover[]): boolean {
  const key = norm(run.text);
  if (!key) return true;
  const fills = covers.filter((c) => c.kind === 'fill');
  for (const other of runs) {
    if (other === run || other.invisible || norm(other.text) !== key) continue;
    if (clippedAway(other)) continue;
    const over = fills.filter((c) => c.order > other.order && unionCoverage(other.box, [c.box]) > 0.02);
    if (!over.length) return true;
    if (unionCoverage(other.box, over.map((c) => c.box)) < 0.85) return true;
  }
  return false;
}

/** Whether the clip in force reduced this run to nothing worth seeing. */
function clippedAway(run: TextRun): boolean {
  const whole = area(run.box);
  if (whole <= 0) return false;
  return area(intersect(run.box, run.clip)) / whole < 0.15;
}

export function scanOperatorList(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
  view: number[],
  OPS: Record<string, number>,
): PageScan {
  const runs: TextRun[] = [];
  const covers: Cover[] = [];
  const pageArea = Math.max(0, view[2] - view[0]) * Math.max(0, view[3] - view[1]);
  let s: GState = {
    ctm: IDENTITY, fill: '#000000', alpha: 1, blend: 'Normal',
    clip: { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 },
    fontSize: 0, leading: 0, charSpacing: 0, wordSpacing: 0, hScale: 1, render: 0,
  };
  const stack: GState[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let pendingClip = false;
  const images: Box[] = [];
  const annotDepth: number[] = [];
  const formDepth: number[] = [];

  const newline = (tx: number, ty: number) => { tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm; };

  type Glyph = { width?: number; unicode?: string; isSpace?: boolean; vmetric?: number[] };

  const emitText = (glyphs: unknown[], order: number) => {
    // Japanese and Chinese set vertically as well as horizontally. pdf.js gives
    // a glyph vertical metrics only in that mode, which is how the direction is
    // known here without reaching for the font object.
    const first = glyphs.find((g) => typeof g === 'object' && g !== null) as Glyph | undefined;
    const vertical = Array.isArray(first?.vmetric);
    let advance = 0;
    let originX = 0;
    let text = '';

    for (const g of glyphs) {
      if (typeof g === 'number') {
        // A kerning adjustment moves along the writing direction, whichever it is.
        advance -= (g / 1000) * s.fontSize * (vertical ? 1 : s.hScale);
        continue;
      }
      const gl = g as Glyph;
      if (vertical) {
        const vm = gl.vmetric ?? [-1000, 500, 880];
        originX = (vm[1] ?? 500) / 1000 * s.fontSize;
        advance += (vm[0] ?? -1000) / 1000 * s.fontSize - s.charSpacing;
      } else {
        const w = ((gl.width ?? 0) / 1000) * s.fontSize;
        advance += (w + s.charSpacing + (gl.isSpace ? s.wordSpacing : 0)) * s.hScale;
      }
      text += gl.unicode ?? '';
    }

    if (text.trim()) {
      const trm = mul(tm, s.ctm);
      // Vertical runs grow downward from the start point and are one glyph wide,
      // centred on the baseline; horizontal ones grow to the right.
      const local = vertical
        ? { x0: -originX, y0: advance, x1: -originX + s.fontSize, y1: 0 }
        : { x0: 0, y0: -0.16 * s.fontSize, x1: advance, y1: 0.78 * s.fontSize };
      // Rendering mode 3 is the documented way to draw nothing. Painting with a
      // transparent fill has the same effect on screen and left the text just
      // as copyable, so it belongs in the same bucket.
      const unpainted = s.render === 3 || s.render === 7 || s.alpha < 0.05;
      runs.push({ box: transformBox(trm, local), text, invisible: unpainted, order, clip: s.clip });
    }
    tm = vertical
      ? mul([1, 0, 0, 1, 0, advance], tm)
      : mul([1, 0, 0, 1, advance, 0], tm);
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = (argsArray[i] ?? []) as unknown[];
    switch (fn) {
      case OPS.save: stack.push(cloneState(s)); s = cloneState(s); break;
      case OPS.restore: if (stack.length) s = stack.pop() as GState; break;
      case OPS.transform: s.ctm = mul(toMatrix(args), s.ctm); break;
      case OPS.setFillRGBColor:
      case OPS.setFillGray:
      case OPS.setFillCMYKColor:
        s.fill = normalizeColor(args); break;
      case OPS.setGState: {
        const pairs = (args[0] as [string, unknown][]) ?? [];
        for (const pair of pairs) {
          if (pair[0] === 'ca' && typeof pair[1] === 'number') s.alpha = pair[1];
          if (pair[0] === 'BM') s.blend = String(pair[1] ?? 'Normal');
        }
        break;
      }
      case OPS.beginText: tm = IDENTITY; tlm = IDENTITY; break;
      case OPS.setTextMatrix: tm = toMatrix(args.length >= 6 ? args : args[0]); tlm = tm; break;
      case OPS.setFont: s.fontSize = Math.abs(Number(args[1]) || 0); break;
      case OPS.setLeading: s.leading = Number(args[0]) || 0; break;
      case OPS.setLeadingMoveText:
        s.leading = -(Number(args[1]) || 0);
        newline(Number(args[0]) || 0, Number(args[1]) || 0); break;
      case OPS.moveText: newline(Number(args[0]) || 0, Number(args[1]) || 0); break;
      case OPS.nextLine: newline(0, -s.leading); break;
      case OPS.setCharSpacing: s.charSpacing = Number(args[0]) || 0; break;
      case OPS.setWordSpacing: s.wordSpacing = Number(args[0]) || 0; break;
      case OPS.setHScale: s.hScale = (Number(args[0]) || 100) / 100; break;
      case OPS.setTextRenderingMode: s.render = Number(args[0]) || 0; break;
      case OPS.showText: emitText((args[0] as unknown[]) ?? [], i); break;
      case OPS.nextLineShowText: newline(0, -s.leading); emitText((args[0] as unknown[]) ?? [], i); break;
      case OPS.nextLineSetSpacingShowText:
        s.wordSpacing = Number(args[0]) || 0;
        s.charSpacing = Number(args[1]) || 0;
        newline(0, -s.leading);
        emitText((args[2] as unknown[]) ?? [], i); break;
      case OPS.clip: case OPS.eoClip: pendingClip = true; break;
      // pdf.js hands an annotation's placement to the renderer through
      // beginAnnotation rather than as a transform operator. Skipping it puts
      // every annotation's contents at the page origin.
      case OPS.beginAnnotation: {
        stack.push(cloneState(s));
        annotDepth.push(stack.length);
        s = cloneState(s);
        const rect = args[1] as ArrayLike<number> | undefined;
        if (rect && rect.length >= 4) {
          s.clip = intersect(s.clip, transformBox(s.ctm, {
            x0: Math.min(rect[0], rect[2]), y0: Math.min(rect[1], rect[3]),
            x1: Math.max(rect[0], rect[2]), y1: Math.max(rect[1], rect[3]),
          }));
        }
        if (args[2]) s.ctm = mul(toMatrix(args[2]), s.ctm);
        if (args[3]) s.ctm = mul(toMatrix(args[3]), s.ctm);
        break;
      }
      // A form XObject is a nested content stream with its own placement. pdf.js
      // inlines it and passes the matrix and bounding box here rather than as
      // ordinary operators, so skipping this measured every form's contents at
      // the page origin — a black box over text that lives in a form matched
      // nothing at all. The renderer also brackets it in an implicit save and
      // restore, without which the form's graphics state leaks onto the page.
      case OPS.paintFormXObjectBegin: {
        stack.push(cloneState(s));
        formDepth.push(stack.length);
        s = cloneState(s);
        if (args[0]) s.ctm = mul(toMatrix(args[0]), s.ctm);
        const bbox = args[1] as ArrayLike<number> | undefined;
        if (bbox && bbox.length >= 4) {
          s.clip = intersect(s.clip, transformBox(s.ctm, {
            x0: Math.min(bbox[0], bbox[2]), y0: Math.min(bbox[1], bbox[3]),
            x1: Math.max(bbox[0], bbox[2]), y1: Math.max(bbox[1], bbox[3]),
          }));
        }
        break;
      }
      case OPS.paintFormXObjectEnd: {
        const depth = formDepth.pop();
        if (depth != null) {
          while (stack.length > depth) stack.pop();
          const saved = stack.pop();
          if (saved) s = saved;
        }
        break;
      }
      case OPS.endAnnotation: {
        const depth = annotDepth.pop();
        if (depth != null) {
          while (stack.length > depth) stack.pop();
          const saved = stack.pop();
          if (saved) s = saved;
        }
        break;
      }
      case OPS.constructPath: {
        const paint = Number(args[0]);
        // A path that is establishing a clip narrows everything drawn after it.
        // Without this, a hairline border painted as a page-sized rectangle
        // clipped to a sliver reads as a box covering the whole page.
        if (pendingClip) {
          pendingClip = false;
          const mm = args[2] as ArrayLike<number> | undefined;
          if (mm && mm.length >= 4) {
            const bbox = transformBox(s.ctm, { x0: mm[0], y0: mm[1], x1: mm[2], y1: mm[3] });
            s.clip = intersect(s.clip, bbox);
          }
        }
        if (!FILL_OPS.has(paint) || s.alpha < 0.85 || !isOpaqueBlend(s.blend)) break;
        const rects = extractRectsFromArg(args[1]);
        if (!rects) break;
        for (const r of rects) {
          const box = intersect(transformBox(s.ctm, r), s.clip);
          if (area(box) <= 0) continue;
          covers.push({ box, color: s.fill, order: i, kind: 'fill' });
        }
        break;
      }
      // A black bar is as often a one-pixel image mask stretched over the text
      // as it is a filled rectangle, and only the rectangle was being seen.
      case OPS.paintImageMaskXObject:
      case OPS.paintSolidColorImageMask:
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject: {
        if (s.alpha < 0.85 || !isOpaqueBlend(s.blend)) break;
        const box = intersect(transformBox(s.ctm, { x0: 0, y0: 0, x1: 1, y1: 1 }), s.clip);
        if (area(box) <= 0) break;
        images.push(box);
        // A picture spanning most of the page is a scan or a background, not a
        // redaction patch. Treating it as a cover would flag every scanned page.
        if (pageArea > 0 && area(box) > 0.6 * pageArea) break;
        covers.push({ box, color: 'image', order: i, kind: 'image' });
        break;
      }
      default: break;
    }
  }

  const imageArea = images.reduce((a, b) => a + area(b), 0);
  const pageIsPicture = pageArea > 0 && imageArea > 0.5 * pageArea;

  const vx0 = view[0], vy0 = view[1], vx1 = view[2], vy1 = view[3];
  const covered: PageScan['covered'] = [];
  const invisible: string[] = [];
  const ocr: string[] = [];
  const offPage: string[] = [];

  for (const r of runs) {
    if (!hasSubstance(r.text)) continue;

    // Clipped down to nothing: on the page this is indistinguishable from text
    // moved off the edge, which is already reported. Unless the same words are
    // legible elsewhere — laying out a figure clips stray copies of a label all
    // the time, and none of that is concealment.
    if (clippedAway(r)) {
      if (!drawnInTheOpen(r, runs, covers)) offPage.push(r.text);
      continue;
    }
    if (r.invisible) {
      // Text drawn invisibly over a picture is the searchable layer of a scan.
      // A page built from many image tiles counts as a picture too, since the
      // recognised text runs across the seams between them.
      const overImage = images.length > 0 && unionCoverage(r.box, images) >= 0.5;
      (overImage || pageIsPicture ? ocr : invisible).push(r.text);
      continue;
    }
    const outside = r.box.x1 < vx0 || r.box.x0 > vx1 || r.box.y1 < vy0 || r.box.y0 > vy1;
    if (outside) { offPage.push(r.text); continue; }
    const over = covers.filter((c) => c.order > r.order && unionCoverage(r.box, [c.box]) > 0.02);
    if (!over.length) continue;
    if (unionCoverage(r.box, over.map((c) => c.box)) < 0.85) continue;
    // Diagram labels and button captions are routinely drawn once behind a
    // shape and again on top of it. A run whose exact text is also painted in
    // the open on the same page is hiding nothing.
    if (drawnInTheOpen(r, runs, covers)) continue;
    covered.push({ text: r.text, color: over[0].color, box: r.box });
  }
  // A page whose text is almost entirely invisible does not contain a hidden
  // paragraph — its text layer is a machine-generated overlay on artwork, which
  // is how scans, maps and CAD exports are made searchable. Someone hiding a
  // paragraph leaves a handful of invisible runs among many visible ones.
  // Only a page that is actually a picture gets this treatment. Without that
  // condition the rule read "the more paragraphs you hide, the less serious it
  // is", and splitting a hidden block into ten runs was a way to turn a
  // critical finding into an informational one on a page with no artwork at all.
  const visibleCount = runs.filter((r) => !r.invisible && hasSubstance(r.text)).length;
  const invisibleCount = invisible.length + ocr.length;
  const machineLayer = images.length > 0 || pageIsPicture;
  if (machineLayer && invisibleCount >= 10 && invisibleCount > 3 * visibleCount) {
    ocr.push(...invisible);
    invisible.length = 0;
  }

  return { covered, invisible, ocr, offPage, runs: runs.length };
}
