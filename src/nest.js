'use strict';

const { rotate180 } = require('./geom');

/**
 * 排样优化器（整数毫米）。
 *
 * 方法：1mm 占用栅格 + 左下（bottom-left）启发式 + 压实局部搜索。
 * 栅格占用判定为保守判定：格子被占用 当且仅当 多边形内部与格子内部有正面积交集。
 * 因此“两件裁片无共同占用格” ⇒ 精确几何上内部也必不重叠（安全）；
 * 反之栅格可能在斜边附近留出约 1mm 的空隙（保守，属正常排样余量）。
 * 手动移动与冲突校验使用 geom 模块的精确判定，边界接触完全允许。
 *
 * 多卷目标（optimizeRolls，字典序）：
 *   排入件数最多 → 启用卷数最少 → 各卷占用长度之和最小 → 接触周长最大 → x/卷序号/角度平局裁决。
 * 单卷 optimize 是 optimizeRolls 的兼容封装。
 */

class Grid {
  constructor(W, L) {
    this.W = W;
    this.L = L;
    this.rows = 0; // 已分配行数（按需增长，避免一次性分配整卷长度）
    this.data = new Uint8Array(0); // 0=空闲 1=占用
    this.hmax = new Int32Array(W); // 每列最高占用行（半开，即最后区间末端；0=该列全空）
    this.colInts = Array.from({ length: W }, () => []); // 每列有序占用区间（半开 [a,b)）
  }

  ensureRows(r) {
    if (r <= this.rows) return;
    let nr = this.rows === 0 ? 1024 : this.rows * 2;
    if (nr < r) nr = r;
    if (nr > this.L) nr = this.L;
    const nd = new Uint8Array(this.W * nr);
    nd.set(this.data);
    this.data = nd;
    this.rows = nr;
  }

  fillRect(x, y, w, h) {
    this.ensureRows(y + h);
    for (let yy = y; yy < y + h; yy++) {
      this.data.fill(1, yy * this.W + x, yy * this.W + x + w);
    }
    for (let xx = x; xx < x + w; xx++) this.addInterval(xx, y, y + h);
  }

  /**
   * 列 gx 加入占用区间（半开 [a,b)）；互不重叠的区间保持独立，不合并相邻区间
   * （不同裁片可边对边接触：[0,100) 与 [100,200) 必须可分别删除，故不得融合）。
   * 完全相同的区间不重复插入（重叠瑕疵等永久障碍）；区间按起点有序。
   */
  addInterval(gx, a, b) {
    const list = this.colInts[gx];
    let i = 0;
    while (i < list.length && list[i][0] < a) i++;
    if (i < list.length && list[i][0] === a && list[i][1] === b) {
      if (b > this.hmax[gx]) this.hmax[gx] = b;
      return;
    }
    list.splice(i, 0, [a, b]);
    if (b > this.hmax[gx]) this.hmax[gx] = b; // 区间按起点有序，取最大末端
  }

  /** 删除由 addInterval 加入的完全相同区间（裁片栅格互不重叠，按值唯一匹配） */
  removeInterval(gx, a, b) {
    const list = this.colInts[gx];
    for (let i = 0; i < list.length; i++) {
      if (list[i][0] === a && list[i][1] === b) { list.splice(i, 1); break; }
    }
    // 剩余区间可能因重叠瑕疵而嵌套，末端不随起点单调；直接取最大末端
    let top = 0;
    for (const seg of list) if (seg[1] > top) top = seg[1];
    this.hmax[gx] = top;
  }

  /**
   * 掩码（纵向每列覆盖 [colBot,colTop]）放于 px、下沿为 y 时，求保证纵向不冲突的最小 y。
   * 对每个掩码占用列 gx，其占用行区间为 [y+bot, y+top]；用该列有序占用区间做一次性
   * 平移检查：若与某区间 [a,b) 相交，则该列要求下沿 >= b - bot。遍历区间（随 y 抬升
   * 最多常数次重试）即可利用列内空洞得到精确最低 y，复杂度约 O(掩码列数 × 每列段数)。
   */
  columnLift(mask, px, y0) {
    let y = y0;
    for (let guard = 0; guard < 4096; guard++) {
      let need = y;
      for (let mx = 0; mx < mask.w; mx++) {
        const bot = mask.colBot[mx];
        if (bot < 0) continue;
        const list = this.colInts[px + mx];
        const lo = y + bot;
        const hi = y + mask.colTop[mx] + 1; // 半开
        for (let k = 0; k < list.length; k++) {
          const seg = list[k];
          if (seg[1] <= lo) continue;  // 区间在下方
          if (seg[0] >= hi) break;    // 已排序列表：后面都在上方
          // 相交：需把该掩码列抬过此占用段
          const req = seg[1] - bot;
          if (req > need) need = req;
          break; // 与最低相交段处理即可；抬升后外层重试更高段
        }
      }
      if (need <= y) return y;
      y = need;
    }
    return y;
  }

  /**
   * 掩码放于 (px,py) 时，返回最低冲突描述 { r, gx, row }（r=掩码内行, gx=绝对列, row=绝对行）；
   * 无冲突返回 null。调用前需 ensureRows。
   */
  testMask(mask, px, py) {
    const W = this.W;
    const data = this.data;
    for (let r = 0; r < mask.h; r++) {
      const runs = mask.rows[r];
      if (runs.length === 0) continue;
      const base = (py + r) * W + px;
      for (let k = 0; k < runs.length; k++) {
        const a = runs[k][0];
        const b = runs[k][1];
        for (let x = a; x <= b; x++) {
          if (data[base + x] !== 0) return { r, gx: px + x, row: py + r };
        }
      }
    }
    return null;
  }

  /**
   * 将掩码区域写为 val（1=占用，0=清除；各裁片栅格互不相交，清除安全）。
   * 同步维护位栅格与每列占用区间（colInts）。
   */
  markMask(mask, px, py, val) {
    for (let r = 0; r < mask.h; r++) {
      const base = (py + r) * this.W + px;
      const runs = mask.rows[r];
      for (let k = 0; k < runs.length; k++) {
        this.data.fill(val, base + runs[k][0], base + runs[k][1] + 1);
      }
    }
    for (let mx = 0; mx < mask.w; mx++) {
      if (mask.colBot[mx] < 0) continue;
      const gx = px + mx;
      for (const [sa, sb] of mask.colSegs[mx]) {
        if (val === 1) this.addInterval(gx, py + sa, py + sb);
        else this.removeInterval(gx, py + sa, py + sb);
      }
    }
  }

  /**
   * 接触周长评分：掩码占用格边界与已占用格/布幅边界相邻的边数（越大越紧凑）。
   * 水平接触按掩码每列段只查段首/段末相邻格，竖直接触按每行段查两端相邻格，
   * 复杂度约 O(掩码周长)，语义与逐格版本完全一致。
   */
  contactScore(mask, px, py) {
    const W = this.W;
    const L = this.L;
    const data = this.data;
    let score = 0;

    // ---- 水平接触（上、下）：同列段内部相邻格必同为掩码占用，只有段两端可能接触外部 ----
    for (let mx = 0; mx < mask.w; mx++) {
      const segs = mask.colSegs[mx];
      if (!segs.length) continue;
      const gx = px + mx;
      for (const [sa, sb] of segs) {
        const top = py + sa;         // 段首行
        const bottom = py + sb - 1; // 段末行
        if (top === 0) score++;
        else if (this.data[(top - 1) * W + gx] !== 0) score++;
        if (bottom + 1 >= L) score++;
        else if (bottom + 1 < this.rows && this.data[(bottom + 1) * W + gx] !== 0) score++;
      }
    }

    // ---- 竖直接触（左、右）：每行段内部相邻格同为掩码占用，只有左右两端接触外部 ----
    for (let r = 0; r < mask.h; r++) {
      const gy = py + r;
      const rowBase = gy * W;
      const runs = mask.rows[r];
      for (let k = 0; k < runs.length; k++) {
        const a = runs[k][0];
        const b = runs[k][1];
        const lx = px + a;
        const rx = px + b;
        if (lx === 0 || data[rowBase + lx - 1] !== 0) score++;
        if (rx === W - 1 || data[rowBase + rx + 1] !== 0) score++;
      }
    }
    return score;
  }
}

/** 边穿过的开放格子标记（细长多边形可能不覆盖任何格子中心，需补充） */
function markEdgeCells(occ, w, h, a, b) {
  const ts = [0, 1];
  if (b[0] !== a[0]) {
    const lo = Math.min(a[0], b[0]);
    const hi = Math.max(a[0], b[0]);
    for (let k = lo + 1; k <= hi - 1; k++) ts.push((k - a[0]) / (b[0] - a[0]));
  }
  if (b[1] !== a[1]) {
    const lo = Math.min(a[1], b[1]);
    const hi = Math.max(a[1], b[1]);
    for (let k = lo + 1; k <= hi - 1; k++) ts.push((k - a[1]) / (b[1] - a[1]));
  }
  ts.sort((p, q) => p - q);
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i];
    const t1 = ts[i + 1];
    if (t1 - t0 < 1e-12) continue;
    const tm = (t0 + t1) / 2;
    const mx = a[0] + tm * (b[0] - a[0]);
    const my = a[1] + tm * (b[1] - a[1]);
    const fx = Math.floor(mx);
    const fy = Math.floor(my);
    // 仅当边严格穿过格子内部（非沿格线）时标记
    if (mx !== fx && my !== fy && fx >= 0 && fy >= 0 && fx < w && fy < h) {
      occ[fy * w + fx] = 1;
    }
  }
}

/**
 * 由归一化多边形构建栅格掩码：{ w, h, rows: [[[x0,x1],...], ...] }。
 * 占用语义：多边形内部与格子内部有正面积交集（边界接触不算）。
 */
function buildMask(pts, w, h) {
  const occ = new Uint8Array(w * h);
  const n = pts.length;
  // 1) 扫描线填充：采样点为格子中心 (x+0.5, y+0.5)，中心落在闭多边形上即占用。
  //    中心为半整数坐标，永远不会与整数顶点/水平边重合，无退化情形。
  for (let y = 0; y < h; y++) {
    const cy = y + 0.5;
    const xs = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      if ((a[1] < cy) !== (b[1] < cy)) {
        xs.push(a[0] + ((cy - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    }
    if (xs.length === 0) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const lo = Math.max(0, Math.ceil(xs[k] - 0.5));
      const hi = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      if (hi >= lo) occ.fill(1, y * w + lo, y * w + hi + 1);
    }
  }
  // 2) 边穿过的格子（覆盖细长突出部分）
  for (let i = 0; i < n; i++) {
    markEdgeCells(occ, w, h, pts[i], pts[(i + 1) % n]);
  }
  // 3) 压缩为行区间，并记录每列最低/最高占用掩码行（供精确跳跃与高度快判用）
  const rows = [];
  const colTop = new Int32Array(w).fill(-1);
  const colBot = new Int32Array(w).fill(-1);
  for (let y = 0; y < h; y++) {
    const runs = [];
    let x = 0;
    while (x < w) {
      if (occ[y * w + x]) {
        let x2 = x;
        while (x2 < w && occ[y * w + x2]) x2++;
        runs.push([x, x2 - 1]);
        for (let xx = x; xx < x2; xx++) {
          if (y > colTop[xx]) colTop[xx] = y;
          if (colBot[xx] < 0) colBot[xx] = y;
        }
        x = x2;
      } else {
        x++;
      }
    }
    rows.push(runs);
  }
  return { w, h, rows, colTop, colBot, colSegs: buildColumnSegments(occ, w, h) };
}

/** 由占用数组构建每列连续占用段（半开 [a,b)，局部坐标），供按列增删区间使用 */
function buildColumnSegments(occ, w, h) {
  const segs = new Array(w);
  for (let x = 0; x < w; x++) {
    const list = [];
    let start = -1;
    for (let y = 0; y < h; y++) {
      const on = occ[y * w + x] === 1;
      if (on && start < 0) start = y;
      if ((!on || y === h - 1) && start >= 0) {
        list.push([start, on ? y + 1 : y]);
        start = -1;
      }
    }
    segs[x] = list;
  }
  return segs;
}

/**
 * 高度快判（精确的充分条件，绝不误判）：掩码在列 mx 的最低占用行为 colBot[mx]，
 * 栅格列 px+mx 的最高占用行为 hmax-1。只要 y + colBot[mx] >= hmax，
 * 掩码在该列的占用格全落在已占用区上方，必然不冲突；全部列成立 ⇒ 整放置免冲突。
 * 不成立时（可能为凹形嵌入）回退精确栅格判定。
 */
function fastFree(grid, mask, px, py) {
  const hmax = grid.hmax;
  for (let mx = 0; mx < mask.w; mx++) {
    const bot = mask.colBot[mx];
    if (bot >= 0 && py + bot < hmax[px + mx]) return false;
  }
  return true;
}

/**
 * 在单个候选 x 上求掩码最低可行 y（不含接触评分）；越界返回 null。
 * 先用 columnLift 沿各占用列一次性（固定点）抬到不冲突，利用列内空洞；
 * 再用精确栅格 testMask 做最终确认（高度/列段法对跨列凹边是保守的）。
 */
function lowestFeasible(grid, mask, px, L) {
  if (px < 0 || px + mask.w > grid.W) return null;
  let y = 0;
  for (let guard = 0; guard < 100000; guard++) {
    grid.ensureRows(Math.min(y + mask.h, L));
    if (y + mask.h > L) return null;
    y = grid.columnLift(mask, px, y);
    if (y + mask.h > L) return null;
    grid.ensureRows(y + mask.h);
    if (fastFree(grid, mask, px, y) || !grid.testMask(mask, px, y)) return y;
    y += 1; // 跨列凹边残留冲突时保守下移一行再求
  }
  return null;
}

/**
 * 在候选 x 列上为掩码寻找最优位置（单卷，占用长度小 → 接触周长大 → x 小）。
 * 先在所有候选列上廉价地求最低可行 y，再仅对「占用长度最小」的并列列计算接触周长
 * （contactScore 为 O(掩码面积)，只在并列时才值得计算）。
 */
function findPosition(grid, mask, candidateXs, L) {
  let minTop = Infinity;
  let ties = []; // {x, y, top}
  for (const px0 of candidateXs) {
    const px = px0;
    const y = lowestFeasible(grid, mask, px, L);
    if (y == null) continue;
    const top = y + mask.h;
    if (top < minTop) {
      minTop = top;
      ties = [{ x: px, y, top }];
    } else if (top === minTop) {
      ties.push({ x: px, y, top });
    }
  }
  if (ties.length === 0) return null;
  let best = null;
  for (const c of ties) {
    const contact = grid.contactScore(mask, c.x, c.y);
    if (!best || contact > best.contact || (contact === best.contact && c.x < best.x)) {
      best = { x: c.x, y: c.y, top: c.top, contact };
    }
  }
  return best;
}

/** 字典序比较 */
function tupleLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/**
 * 多卷排样：在同一方案的若干卷布上排入裁片。
 *
 * 优化目标（字典序，前一个不劣化才考虑后一个）：
 *   1. 排入裁片数最多（绝不为减少用卷放弃任何可排入的件）
 *   2. 启用卷数最少
 *   3. 各卷实际占用长度之和最小
 *   4. 接触周长最大 → x 最小 → 卷序号小 → 0° 优先（平局裁决，仅用于稳定结果）
 *
 * @param {object} input
 *   rolls  [{label?, W, L, defects:[{x,y,w,h}]}]，数组顺序即卷序号
 *   locked [{key, rollIndex, verts, rot, x, y, w, h}] 锁定裁片（固定在其卷上）
 *   pieces [{key, maskKey, verts, allowRotate, w, h, area, requiredIndex}]
 *           requiredIndex 为必用卷下标（0 起），null/undefined 表示不限卷
 * @returns {{placements: Array, unplaced: Array, usedLength: number, rollUsedLengths: number[]}}
 */
function optimizeRolls({ rolls, locked, pieces }) {
  const R = rolls.length;
  const maskCache = new Map();

  function getMask(maskKey, rot, verts, w, h) {
    const ck = maskKey + ':' + rot;
    let m = maskCache.get(ck);
    if (!m) {
      m = buildMask(rot === 180 ? rotate180(verts, w, h) : verts, w, h);
      maskCache.set(ck, m);
    }
    return m;
  }

  // 每卷的栅格、候选 x 用障碍矩形、已放记录、当前占用长度
  const hasDefect = rolls.map((rl) => Array.isArray(rl.defects) && rl.defects.length > 0);
  const state = rolls.map((rl) => {
    const grid = new Grid(rl.W, rl.L);
    const rects = [];
    for (const d of rl.defects || []) {
      grid.fillRect(d.x, d.y, d.w, d.h);
      rects.push({ x: d.x, w: d.w });
    }
    return { W: rl.W, L: rl.L, grid, rects, recs: [], top: 0 };
  });

  const placements = [];
  const unplaced = [];
  const movables = []; // 可重排记录引用（可跨卷）
  // 全局聚合计数（随 put/lift/settle/restore 增量维护），供 O(1) 元组评估
  const agg = { opened: 0, sumTop: 0 };

  function recTopOf(s) {
    let t = 0;
    for (const rec of s.recs) {
      const v = rec.y + rec.h;
      if (v > t) t = v;
    }
    return t;
  }

  /** 向某卷加入一条记录前/后更新聚合计数（传入加入后的卷顶） */
  function aggOnAdd(s, newTop) {
    if (s.recs.length === 0) agg.opened++;
    agg.sumTop += newTop - s.top;
  }
  function aggOnRemove(s, newTop) {
    if (s.recs.length === 0) agg.opened--;
    agg.sumTop += newTop - s.top;
  }

  // 锁定件：按原卷、原位、原方向写入（视同固定障碍）
  for (const lp of locked || []) {
    const s = state[lp.rollIndex];
    const mask = getMask('L' + lp.key, lp.rot, lp.verts, lp.w, lp.h);
    s.grid.ensureRows(lp.y + lp.h);
    s.grid.markMask(mask, lp.x, lp.y, 1);
    s.rects.push({ x: lp.x, w: lp.w });
    const rec = {
      key: lp.key, rollIndex: lp.rollIndex, x: lp.x, y: lp.y, rotation: lp.rot,
      w: lp.w, h: lp.h, locked: true,
    };
    s.recs.push(rec);
    const nt = recTopOf(s);
    aggOnAdd(s, nt);
    s.top = nt;
    placements.push(rec);
  }

  function candidatesFor(s, maskW) {
    const set = new Set([0, s.W - maskW]);
    for (const r of s.rects) {
      set.add(r.x + r.w); // 左缘对齐障碍物右缘
      set.add(r.x - maskW); // 右缘对齐障碍物左缘
    }
    return [...set].sort((a, b) => a - b);
  }

  /**
   * 求裁片当前（其他件已占状态下）需评估的卷下标集合。
   * 必用卷只看其卷；否则：有已排件的卷、空但有瑕疵的卷都需单独评估；
   * 对于【空且无瑕疵】的卷，其栅格几何只取决于该卷 (W,L)——同一 (W,L) 的卷候选位置
   * 完全相同，故每个 (W,L) 组只取下标最小的一卷代表（平局裁决中它也最优），
   * 宽度/长度不同的空卷分别取代表，避免漏排。
   */
  function rollIndicesFor(p) {
    if (p.requiredIndex != null) return [p.requiredIndex];
    const idxs = [];
    const blankByDims = new Map(); // "WxL" -> 最小卷下标
    for (let ri = 0; ri < R; ri++) {
      const s = state[ri];
      if (s.recs.length > 0 || hasDefect[ri]) {
        idxs.push(ri);
      } else {
        const key = s.W + 'x' + s.L;
        if (!blankByDims.has(key)) blankByDims.set(key, ri);
      }
    }
    for (const ri of blankByDims.values()) idxs.push(ri);
    return idxs;
  }

  function bestAcross(p) {
    const masks = [{ rot: 0, mask: getMask(p.maskKey, 0, p.verts, p.w, p.h) }];
    if (p.allowRotate) {
      masks.push({ rot: 180, mask: getMask(p.maskKey, 180, p.verts, p.w, p.h) });
    }
    let best = null;
    for (const ri of rollIndicesFor(p)) {
      const s = state[ri];
      const willOpen = s.recs.length === 0 ? 1 : 0;
      for (const m of masks) {
        if (m.mask.w > s.W) continue;
        const pos = findPosition(s.grid, m.mask, candidatesFor(s, m.mask.w), s.L);
        if (!pos) continue;
        const addedTop = Math.max(s.top, pos.top) - s.top;
        const tuple = [
          agg.opened + willOpen,
          agg.sumTop + addedTop,
          -pos.contact,
          pos.x,
          ri,
          m.rot,
        ];
        if (!best || tupleLess(tuple, best.tuple)) {
          best = {
            rollIndex: ri, x: pos.x, y: pos.y, top: pos.top,
            contact: pos.contact, rot: m.rot, mask: m.mask, tuple,
          };
        }
      }
    }
    return best;
  }

  function putDown(p, cand) {
    const s = state[cand.rollIndex];
    s.grid.markMask(cand.mask, cand.x, cand.y, 1);
    const rect = { x: cand.x, w: p.w };
    s.rects.push(rect);
    const rec = {
      key: p.key, rollIndex: cand.rollIndex, x: cand.x, y: cand.y, rotation: cand.rot,
      w: p.w, h: p.h, locked: false,
      _p: p, _mask: cand.mask, _rect: rect,
    };
    s.recs.push(rec);
    aggOnAdd(s, cand.top);
    s.top = Math.max(s.top, cand.top);
    placements.push(rec);
    movables.push(rec);
    return rec;
  }

  function lift(rec) {
    const s = state[rec.rollIndex];
    s.grid.markMask(rec._mask, rec.x, rec.y, 0);
    s.rects.splice(s.rects.indexOf(rec._rect), 1);
    s.recs.splice(s.recs.indexOf(rec), 1);
    const nt = recTopOf(s);
    aggOnRemove(s, nt);
    s.top = nt;
  }

  /** 按候选落位（可能与原卷不同） */
  function settle(rec, cand) {
    const s = state[cand.rollIndex];
    s.grid.markMask(cand.mask, cand.x, cand.y, 1);
    const rect = { x: cand.x, w: rec.w };
    s.rects.push(rect);
    rec.rollIndex = cand.rollIndex;
    rec.x = cand.x;
    rec.y = cand.y;
    rec.rotation = cand.rot;
    rec._mask = cand.mask;
    rec._rect = rect;
    s.recs.push(rec);
    const nt = Math.max(s.top, cand.top);
    aggOnAdd(s, nt);
    s.top = nt;
  }

  /** 放回原卷原位 */
  function restore(rec) {
    const s = state[rec.rollIndex];
    s.grid.markMask(rec._mask, rec.x, rec.y, 1);
    s.rects.push(rec._rect);
    s.recs.push(rec);
    const nt = Math.max(s.top, rec.y + rec.h);
    aggOnAdd(s, nt);
    s.top = nt;
  }

  // 初始放置：必用卷件优先（提前打开必用卷不会增加最终卷数），组内面积降序
  const sorted = [...pieces].sort((a, b) => {
    const ra = a.requiredIndex == null ? 1 : 0;
    const rb = b.requiredIndex == null ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return b.area - a.area;
  });
  const maxW = Math.max(...state.map((s) => s.W));
  const deferred = [];
  for (const p of sorted) {
    if (p.requiredIndex == null && p.w > maxW) {
      unplaced.push({
        key: p.key,
        reason:
          R === 1
            ? `裁片外接宽度 ${p.w}mm 超出布幅 ${state[0].W}mm`
            : `裁片外接宽度 ${p.w}mm 超出所有卷布幅（最宽 ${maxW}mm）`,
      });
      continue;
    }
    const best = bestAcross(p);
    if (!best) {
      deferred.push(p);
      continue;
    }
    putDown(p, best);
  }

  // 压实（含跨卷迁移，可腾空整卷）：逐件取出重评，全局元组严格更优才接受
  for (let round = 0; round < 3; round++) {
    let improved = false;
    for (const rec of [...movables]) {
      lift(rec);
      const best = bestAcross(rec._p);
      if (!best) {
        restore(rec); // 理论上不会发生（原位必然可行）
        continue;
      }
      // 当前原卷原位也按同一元组评估（rec 已 lift，agg 为不含它的状态）
      const s0 = state[rec.rollIndex];
      const curContact = s0.grid.contactScore(rec._mask, rec.x, rec.y);
      const curWillOpen = s0.recs.length === 0 ? 1 : 0;
      const curAddedTop = Math.max(s0.top, rec.y + rec.h) - s0.top;
      const curTuple = [
        agg.opened + curWillOpen,
        agg.sumTop + curAddedTop,
        -curContact,
        rec.x,
        rec.rollIndex,
        rec.rotation,
      ];
      if (tupleLess(best.tuple, curTuple)) {
        settle(rec, best);
        improved = true;
      } else {
        restore(rec);
      }
    }
    if (!improved) break;
  }

  // 重试此前放不下的件（压实后可能出现空位；非必用卷件可转投其他卷）
  for (const p of deferred) {
    const best = bestAcross(p);
    if (best) {
      putDown(p, best);
    } else if (p.requiredIndex != null) {
      const rl = rolls[p.requiredIndex];
      unplaced.push({
        key: p.key,
        reason: `必用卷「${rl.label || '第' + (p.requiredIndex + 1) + '卷'}」可用长度 ${rl.L}mm 内找不到可行位置（避开瑕疵/已排件后空间不足）`,
      });
    } else {
      unplaced.push({
        key: p.key,
        reason:
          R === 1
            ? `可用长度 ${state[0].L}mm 内找不到可行位置`
            : `全部 ${R} 卷的可用长度内均找不到可行位置（避开瑕疵/已排件后空间不足）`,
      });
    }
  }

  const rollUsedLengths = state.map((s) => s.top);
  const usedLength = rollUsedLengths.reduce((a, b) => a + b, 0);
  return {
    placements: placements.map((p) => ({
      key: p.key,
      rollIndex: p.rollIndex,
      x: p.x,
      y: p.y,
      rotation: p.rotation,
      h: p.h,
    })),
    unplaced,
    usedLength,
    rollUsedLengths,
  };
}

/**
 * 执行单卷排样（旧接口，行为与旧版一致）。
 * @param {object} input
 *   W, L            布幅宽度 / 可用长度（mm）
 *   defects         [{x,y,w,h}] 瑕疵区（始终固定）
 *   locked          [{key, verts, rot, x, y, w, h}] 锁定裁片（始终固定，verts 为归一化顶点）
 *   pieces          [{key, maskKey, verts, allowRotate, w, h, area}] 待排裁片
 * @returns { placements: [{key,x,y,rotation,h}], unplaced: [{key,reason}], usedLength }
 */
function optimize({ W, L, defects, locked, pieces }) {
  const res = optimizeRolls({
    rolls: [{ W, L, defects: defects || [] }],
    locked: (locked || []).map((lp) => ({ ...lp, rollIndex: 0 })),
    pieces: pieces || [],
  });
  return {
    placements: res.placements.map((p) => ({
      key: p.key, x: p.x, y: p.y, rotation: p.rotation, h: p.h,
    })),
    unplaced: res.unplaced,
    usedLength: res.usedLength,
  };
}

module.exports = { optimize, optimizeRolls, buildMask, Grid };
