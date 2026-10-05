'use strict';

/**
 * 精确平面几何模块。
 * 所有坐标为整数毫米（射线法/边中点等中间点允许 0.5 精度的浮点，运算在 2^53 内精确）。
 * 多边形一律为简单多边形：顶点数组 [[x, y], ...]，顺/逆时针均可，不允许自交。
 * 重叠语义：仅当两个多边形的【内部】发生正面积重叠时判定为冲突；边界接触（共点/共边）允许。
 */

/** 有向叉积 (b-a) x (c-a)，>0 表示 c 在 ab 左侧 */
function orient(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** 2 倍有符号面积 */
function area2(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
}

/** p 是否在线段 ab 上（含端点） */
function onSegment(a, b, p) {
  if (orient(a, b, p) !== 0) return false;
  return (
    Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1])
  );
}

/** 点与多边形位置关系：'inside' | 'boundary' | 'outside' */
function pointLocation(p, pts) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    if (onSegment(pts[i], pts[(i + 1) % n], p)) return 'boundary';
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if ((a[1] > p[1]) !== (b[1] > p[1])) {
      const xint = a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      if (xint > p[0]) inside = !inside;
    }
  }
  return inside ? 'inside' : 'outside';
}

/** 线段是否相交（含触碰） */
function segmentsIntersect(a, b, c, d) {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (
    ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
    ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))
  ) {
    return true;
  }
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}

/** 共线线段是否以正长度重叠（调用前需保证共线） */
function collinearOverlapPositive(a, b, c, d) {
  const dx = Math.abs(b[0] - a[0]);
  const dy = Math.abs(b[1] - a[1]);
  if (dx >= dy) {
    return (
      Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) -
        Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) >
      0
    );
  }
  return (
    Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1])) -
      Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) >
    0
  );
}

/**
 * 校验简单多边形，返回错误信息字符串；合法返回 null。
 */
function validatePolygon(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return '顶点数不足（至少 3 个）';
  if (pts.length > 200) return '顶点数过多（最多 200 个）';
  for (const p of pts) {
    if (!Array.isArray(p) || p.length !== 2 || !Number.isInteger(p[0]) || !Number.isInteger(p[1])) {
      return '顶点坐标必须为整数毫米';
    }
    if (Math.abs(p[0]) > 1e6 || Math.abs(p[1]) > 1e6) return '顶点坐标超出允许范围（±1000000）';
  }
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    if (a[0] === b[0] && a[1] === b[1]) return '存在重复相邻顶点（零长度边）';
  }
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      const c = pts[j];
      const d = pts[(j + 1) % n];
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (adjacent) {
        // 相邻边共享端点属正常；但共线且正长度重叠是退化“尖刺”
        if (orient(a, b, c) === 0 && orient(a, b, d) === 0 && collinearOverlapPositive(a, b, c, d)) {
          return '相邻边共线重叠（退化轮廓）';
        }
        continue;
      }
      if (segmentsIntersect(a, b, c, d)) return '多边形轮廓自相交';
    }
  }
  if (area2(pts) === 0) return '多边形面积为零（退化轮廓）';
  return null;
}

/** 平移归一化：使最小 x、最小 y 均为 0，返回 { pts, w, h }（w/h 为外接矩形尺寸） */
function normalize(pts) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return {
    pts: pts.map(([x, y]) => [x - minX, y - minY]),
    w: maxX - minX,
    h: maxY - minY,
  };
}

/** 旋转 180°（在归一化外接矩形内）：(x,y) -> (w-x, h-y)，结果仍为整数且保持归一化 */
function rotate180(pts, w, h) {
  return pts.map(([x, y]) => [w - x, h - y]);
}

/** 由归一化顶点 + 放置参数得到绝对坐标顶点 */
function toAbsolute(pts, rotation, w, h, tx, ty) {
  if (rotation === 180) return pts.map(([x, y]) => [tx + w - x, ty + h - y]);
  return pts.map(([x, y]) => [tx + x, ty + y]);
}

/** 矩形（瑕疵区）转多边形 */
function rectPoly(x, y, w, h) {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

/**
 * 边细分：把 Q 的顶点中落在 P 边上的点插入 P（保持几何不变），
 * 使后续的顶点/边中点包含性判定在“边界相切”情形下仍然完备。
 */
function subdivideEdges(P, Q) {
  const n = P.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = P[i];
    const b = P[(i + 1) % n];
    out.push(a);
    const inserts = [];
    for (const q of Q) {
      if (orient(a, b, q) === 0) {
        const dot = (q[0] - a[0]) * (q[0] - b[0]) + (q[1] - a[1]) * (q[1] - b[1]);
        if (dot < 0) inserts.push(q); // 严格位于 a、b 之间
      }
    }
    if (inserts.length > 0) {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      inserts.sort(
        (p, q) =>
          (p[0] - a[0]) * dx + (p[1] - a[1]) * dy - ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy)
      );
      out.push(...inserts);
    }
  }
  return out;
}

/**
 * 判断两个简单多边形的【内部】是否存在正面积重叠。
 * 边界接触（共点、共边、T 型接触）返回 false。
 */
function polygonsInteriorOverlap(P0, Q0) {
  const P = subdivideEdges(P0, Q0);
  const Q = subdivideEdges(Q0, P0);
  const sP = Math.sign(area2(P));
  const sQ = Math.sign(area2(Q));
  const n = P.length;
  const m = Q.length;
  for (let i = 0; i < n; i++) {
    const a = P[i];
    const b = P[(i + 1) % n];
    for (let j = 0; j < m; j++) {
      const c = Q[j];
      const d = Q[(j + 1) % m];
      const o1 = orient(a, b, c);
      const o2 = orient(a, b, d);
      const o3 = orient(c, d, a);
      const o4 = orient(c, d, b);
      // 边真正交叉（内部相交）
      if (
        ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
        ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))
      ) {
        return true;
      }
      // 共线且正长度重叠：仅当两者内部位于边的同侧时才重叠
      if (o1 === 0 && o2 === 0 && collinearOverlapPositive(a, b, c, d)) {
        const ln1x = -(b[1] - a[1]);
        const ln1y = b[0] - a[0];
        const ln2x = -(d[1] - c[1]);
        const ln2y = d[0] - c[0];
        if (sP * sQ * (ln1x * ln2x + ln1y * ln2y) > 0) return true;
      }
    }
  }
  // 包含性：顶点或边中点严格位于另一多边形内部
  for (const p of P) if (pointLocation(p, Q) === 'inside') return true;
  for (const q of Q) if (pointLocation(q, P) === 'inside') return true;
  for (let i = 0; i < n; i++) {
    const a = P[i];
    const b = P[(i + 1) % n];
    if (pointLocation([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], Q) === 'inside') return true;
  }
  for (let j = 0; j < m; j++) {
    const c = Q[j];
    const d = Q[(j + 1) % m];
    if (pointLocation([(c[0] + d[0]) / 2, (c[1] + d[1]) / 2], P) === 'inside') return true;
  }
  return false;
}

module.exports = {
  orient,
  area2,
  onSegment,
  pointLocation,
  segmentsIntersect,
  validatePolygon,
  normalize,
  rotate180,
  toAbsolute,
  rectPoly,
  polygonsInteriorOverlap,
};
