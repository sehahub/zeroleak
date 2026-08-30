// Minimal 2-D affine helpers. Matrices are [a, b, c, d, e, f] as in PDF.
export type Matrix = [number, number, number, number, number, number];
export type Box = { x0: number; y0: number; x1: number; y1: number };

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Axis-aligned bounding box of a rectangle pushed through a matrix. */
export function transformBox(m: Matrix, b: Box): Box {
  const pts = [
    apply(m, b.x0, b.y0), apply(m, b.x1, b.y0),
    apply(m, b.x1, b.y1), apply(m, b.x0, b.y1),
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

export function area(b: Box): number {
  return Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
}

/** Fraction of `inner` that lies inside `outer`, 0..1. */
export function coverage(inner: Box, outer: Box): number {
  const a = area(inner);
  if (a <= 0) return 0;
  const overlap: Box = {
    x0: Math.max(inner.x0, outer.x0), y0: Math.max(inner.y0, outer.y0),
    x1: Math.min(inner.x1, outer.x1), y1: Math.min(inner.y1, outer.y1),
  };
  return area(overlap) / a;
}

export function unionCoverage(inner: Box, outers: Box[]): number {
  // Approximation: sample the inner box on a grid and count covered cells.
  // Exact union-of-rectangles area is overkill for a heuristic.
  if (outers.length === 1) return coverage(inner, outers[0]);
  const N = 12;
  let hit = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = inner.x0 + ((i + 0.5) / N) * (inner.x1 - inner.x0);
      const y = inner.y0 + ((j + 0.5) / N) * (inner.y1 - inner.y0);
      if (outers.some((o) => x >= o.x0 && x <= o.x1 && y >= o.y0 && y <= o.y1)) hit++;
    }
  }
  return hit / (N * N);
}

/** Intersection of two boxes; may come back empty (x1<x0). */
export function intersect(a: Box, b: Box): Box {
  return {
    x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1),
  };
}
