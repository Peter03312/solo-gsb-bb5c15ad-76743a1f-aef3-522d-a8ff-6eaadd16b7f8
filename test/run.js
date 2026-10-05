'use strict';

const assert = require('assert');
const geom = require('../src/geom');
const { optimize, optimizeRolls, buildMask, Grid } = require('../src/nest');
const { validateJobInput } = require('../src/validate');

let passed = 0;
const queue = [];
function test(name, fn) {
  queue.push({ name, fn });
}

async function runAll() {
  for (const t of queue) {
    try {
      await t.fn();
      passed++;
      console.log('  ✓ ' + t.name);
    } catch (e) {
      console.error('  ✗ ' + t.name);
      console.error('    ' + (e && e.message ? e.message : e));
      process.exitCode = 1;
    }
  }
}

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

/** 排样结果不变量校验：边界、两两不重叠、不压瑕疵、锁定件不动 */
function verifyLayout({ W, L, defects, locked, result, typesByKey }) {
  const absOf = (pl) => {
    const t = typesByKey.get(pl.key);
    return geom.toAbsolute(t.verts, pl.rotation, t.w, t.h, pl.x, pl.y);
  };
  const polys = result.placements.map((pl) => ({ pl, abs: absOf(pl) }));
  for (const { pl, abs } of polys) {
    for (const [x, y] of abs) {
      assert(x >= 0 && x <= W && y >= 0 && y <= L, `裁片 ${pl.key} 顶点 (${x},${y}) 超出布幅`);
    }
    for (const d of defects) {
      assert(
        !geom.polygonsInteriorOverlap(abs, geom.rectPoly(d.x, d.y, d.w, d.h)),
        `裁片 ${pl.key} 与瑕疵区 (${d.x},${d.y},${d.w},${d.h}) 重叠`
      );
    }
  }
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      assert(
        !geom.polygonsInteriorOverlap(polys[i].abs, polys[j].abs),
        `裁片 ${polys[i].pl.key} 与 ${polys[j].pl.key} 内部重叠`
      );
    }
  }
  for (const lp of locked) {
    const got = result.placements.find((p) => p.key === lp.key);
    assert(got, '锁定件丢失');
    assert(got.x === lp.x && got.y === lp.y && got.rotation === lp.rot, '锁定件位置被改变');
  }
}

// ---------------- 几何：轮廓校验 ----------------
console.log('几何：轮廓校验');
test('合法矩形通过', () => {
  assert.strictEqual(geom.validatePolygon(rect(0, 0, 10, 10)), null);
});
test('凹多边形（L 形）通过', () => {
  assert.strictEqual(
    geom.validatePolygon([[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]]),
    null
  );
});
test('自交（蝴蝶结）被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [10, 10], [10, 0], [0, 10]]));
});
test('零面积被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [5, 5], [10, 10]]));
});
test('重复相邻顶点被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [10, 0], [10, 0], [0, 10]]));
});
test('非整数坐标被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [10.5, 0], [0, 10]]));
});
test('顶点数不足被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [10, 0]]));
});

// ---------------- 几何：内部重叠（边界接触允许） ----------------
console.log('几何：内部重叠判定');
test('边接触的矩形不重叠', () => {
  assert(!geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(10, 0, 10, 10)));
});
test('部分共边（T 型接触）不重叠', () => {
  assert(!geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(3, 10, 4, 8)));
});
test('角点接触不重叠', () => {
  assert(!geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(10, 10, 5, 5)));
});
test('正面积重叠被检出', () => {
  assert(geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(9, 0, 10, 10)));
});
test('完全重合被检出', () => {
  assert(geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(0, 0, 10, 10)));
});
test('包含关系被检出', () => {
  assert(geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(2, 2, 3, 3)));
});
test('内接菱形（顶点全在对方边界上）被检出', () => {
  const diamond = [[5, 0], [10, 5], [5, 10], [0, 5]];
  assert(geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), diamond));
});
test('旋转 180° 后与原向不重叠（相邻放置）', () => {
  const tri = [[0, 0], [40, 0], [0, 30]];
  const a = geom.toAbsolute(tri, 0, 40, 30, 0, 0);
  const b = geom.toAbsolute(tri, 180, 40, 30, 40, 0);
  assert(!geom.polygonsInteriorOverlap(a, b));
});
test('旋转 180° 互补拼接（共斜边）不重叠', () => {
  const tri = [[0, 0], [40, 0], [0, 30]];
  const a = geom.toAbsolute(tri, 0, 40, 30, 0, 0);
  const b = geom.toAbsolute(tri, 180, 40, 30, 0, 0); // 与 a 恰好拼满同一矩形，仅共斜边
  assert(!geom.polygonsInteriorOverlap(a, b));
});
test('旋转 180° 错位放置重叠被检出', () => {
  const tri = [[0, 0], [40, 0], [0, 30]];
  const a = geom.toAbsolute(tri, 0, 40, 30, 0, 0);
  const b = geom.toAbsolute(tri, 180, 40, 30, -10, 0);
  assert(geom.polygonsInteriorOverlap(a, b));
});

// ---------------- 排样 ----------------
console.log('排样优化器');
test('矩形排样：全部排入且无重叠，占用长度正确', () => {
  const W = 1000, L = 2000;
  const defects = [{ x: 0, y: 0, w: 100, h: 100 }];
  const mk = (key) => ({
    key, maskKey: 'r', verts: rect(0, 0, 500, 500), allowRotate: false, w: 500, h: 500, area: 250000,
  });
  const pieces = [mk('a'), mk('b'), mk('c'), mk('d')];
  const result = optimize({ W, L, defects, locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 0, '应全部排入');
  assert.strictEqual(result.placements.length, 4);
  assert(result.usedLength <= 1100, `占用长度 ${result.usedLength} 应 ≤ 1100`);
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  verifyLayout({ W, L, defects, locked: [], result, typesByKey });
});

test('超出布幅宽度的裁片列入未排入', () => {
  const result = optimize({
    W: 1000, L: 2000, defects: [], locked: [],
    pieces: [{ key: 'big', maskKey: 'b', verts: rect(0, 0, 1200, 100), allowRotate: true, w: 1200, h: 100, area: 120000 }],
  });
  assert.strictEqual(result.unplaced.length, 1);
  assert(/超出布幅/.test(result.unplaced[0].reason));
});

test('长度不足时列入未排入', () => {
  const pieces = [];
  for (let i = 0; i < 5; i++) {
    pieces.push({ key: 'p' + i, maskKey: 'r', verts: rect(0, 0, 500, 500), allowRotate: false, w: 500, h: 500, area: 250000 });
  }
  const result = optimize({ W: 1000, L: 1000, defects: [], locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 1, '应恰有 1 件放不下');
  assert.strictEqual(result.placements.length, 4);
});

test('锁定件保持固定，其余绕开', () => {
  const locked = [{ key: 'L1', verts: rect(0, 0, 500, 500), rot: 0, x: 250, y: 100, w: 500, h: 500 }];
  const pieces = [];
  for (let i = 0; i < 3; i++) {
    pieces.push({ key: 'p' + i, maskKey: 'r', verts: rect(0, 0, 500, 500), allowRotate: false, w: 500, h: 500, area: 250000 });
  }
  const result = optimize({ W: 1000, L: 2000, defects: [], locked, pieces });
  assert.strictEqual(result.unplaced.length, 0);
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  typesByKey.set('L1', { verts: rect(0, 0, 500, 500), w: 500, h: 500 });
  verifyLayout({ W: 1000, L: 2000, defects: [], locked, result, typesByKey });
});

test('禁旋转件保持 0°，可旋转件角度合法', () => {
  const lshape = [[0, 0], [300, 0], [300, 100], [100, 100], [100, 300], [0, 300]];
  const pieces = [
    { key: 'a', maskKey: 'L', verts: lshape, allowRotate: true, w: 300, h: 300, area: 50000 },
    { key: 'b', maskKey: 'L', verts: lshape, allowRotate: false, w: 300, h: 300, area: 50000 },
    { key: 'c', maskKey: 'L', verts: lshape, allowRotate: false, w: 300, h: 300, area: 50000 },
  ];
  const result = optimize({ W: 400, L: 2000, defects: [], locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 0);
  for (const pl of result.placements) {
    if (pl.key === 'a') assert(pl.rotation === 0 || pl.rotation === 180);
    else assert.strictEqual(pl.rotation, 0, '禁旋转件不得旋转');
  }
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  verifyLayout({ W: 400, L: 2000, defects: [], locked: [], result, typesByKey });
});

test('随机矩形压力测试（不变量）', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const W = 1600, L = 6000;
  const defects = [
    { x: 700, y: 800, w: 150, h: 200 },
    { x: 200, y: 3000, w: 300, h: 120 },
  ];
  const pieces = [];
  for (let i = 0; i < 30; i++) {
    const w = 100 + Math.floor(rnd() * 400);
    const h = 100 + Math.floor(rnd() * 500);
    pieces.push({
      key: 'r' + i, maskKey: 'r' + i, verts: rect(0, 0, w, h),
      allowRotate: rnd() < 0.5, w, h, area: w * h,
    });
  }
  const result = optimize({ W, L, defects, locked: [], pieces });
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  verifyLayout({ W, L, defects, locked: [], result, typesByKey });
  assert(result.usedLength <= L);
  console.log(`    （随机测试：排入 ${result.placements.length}/30，占用长度 ${result.usedLength}mm）`);
});

test('随机多边形（含凹形/三角）压力测试（不变量）', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const W = 1600, L = 8000;
  const shapes = [
    [[0, 0], [300, 0], [300, 100], [100, 100], [100, 300], [0, 300]], // L 形
    [[0, 0], [400, 0], [0, 300]],                                     // 三角形
    [[0, 0], [250, 0], [250, 150], [125, 220], [0, 150]],             // 五边形
  ];
  const pieces = [];
  for (let i = 0; i < 24; i++) {
    const verts = shapes[i % shapes.length];
    const w = Math.max(...verts.map((v) => v[0]));
    const h = Math.max(...verts.map((v) => v[1]));
    pieces.push({
      key: 's' + i, maskKey: 's' + (i % shapes.length), verts,
      allowRotate: rnd() < 0.5, w, h, area: Math.abs(geom.area2(verts)) / 2,
    });
  }
  const result = optimize({ W, L, defects: [], locked: [], pieces });
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  verifyLayout({ W, L, defects: [], locked: [], result, typesByKey });
  console.log(`    （随机测试：排入 ${result.placements.length}/24，占用长度 ${result.usedLength}mm）`);
});

// ---------------- 多卷排样：不变量校验 ----------------

console.log('栅格列区间（边接触可分别删除）');

test('边对边接触的两件掩码：区间不融合，删除一件后状态精确还原', () => {
  const W = 200, L = 1000;
  const grid = new Grid(W, L);
  const rectMask = (w, h) => buildMask(rect(0, 0, w, h), w, h);
  const mA = rectMask(100, 100);
  const mB = rectMask(100, 100);
  // A 放 (0,0)，B 放 (0,100)：在 x=0..99 列上两件边对边接触
  grid.markMask(mA, 0, 0, 1);
  grid.markMask(mB, 0, 100, 1);
  // 列 0 应有两段独立区间
  assert.deepStrictEqual(grid.colInts[0], [[0, 100], [100, 200]]);
  assert.strictEqual(grid.hmax[0], 200);
  // 删除 A：只应剩 B 的区间，且栅格数据一致
  grid.markMask(mA, 0, 0, 0);
  assert.deepStrictEqual(grid.colInts[0], [[100, 200]], '区间不应被错误融合导致残留');
  assert.strictEqual(grid.hmax[0], 200);
  // A 的原区域现已空，可重新放入同一位置（columnLift 应给出 y=0 可行）
  const y = grid.columnLift(mA, 0, 0);
  assert.strictEqual(y, 0, '删除后边接触件下方应可重新落位');
});

console.log('多卷排样优化器');
function verifyMultiLayout({ rolls, locked, result, typesByKey }) {
  const placed = result.placements;
  for (const pl of placed) {
    const rl = rolls[pl.rollIndex];
    assert(rl, `裁片 ${pl.key} 卷下标越界`);
    const t = typesByKey.get(pl.key);
    const abs = geom.toAbsolute(t.verts, pl.rotation, t.w, t.h, pl.x, pl.y);
    for (const [x, y] of abs) {
      assert(x >= 0 && x <= rl.W && y >= 0 && y <= rl.L, `裁片 ${pl.key} 顶点 (${x},${y}) 超出卷 ${pl.rollIndex}`);
    }
    for (const d of rl.defects || []) {
      assert(
        !geom.polygonsInteriorOverlap(abs, geom.rectPoly(d.x, d.y, d.w, d.h)),
        `裁片 ${pl.key} 与卷${pl.rollIndex}瑕疵重叠`
      );
    }
  }
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      if (placed[i].rollIndex !== placed[j].rollIndex) continue; // 不同卷互不干涉
      const ta = typesByKey.get(placed[i].key);
      const tb = typesByKey.get(placed[j].key);
      const a = geom.toAbsolute(ta.verts, placed[i].rotation, ta.w, ta.h, placed[i].x, placed[i].y);
      const b = geom.toAbsolute(tb.verts, placed[j].rotation, tb.w, tb.h, placed[j].x, placed[j].y);
      assert(!geom.polygonsInteriorOverlap(a, b), `同卷裁片 ${placed[i].key} 与 ${placed[j].key} 内部重叠`);
    }
  }
  for (const lp of locked) {
    const got = placed.find((p) => p.key === lp.key);
    assert(got, '锁定件丢失');
    assert(
      got.rollIndex === lp.rollIndex && got.x === lp.x && got.y === lp.y && got.rotation === lp.rot,
      `锁定件 ${lp.key} 的卷号或位置被改变`
    );
  }
  // rollUsedLengths 与 usedLength 一致
  assert.strictEqual(
    result.usedLength,
    result.rollUsedLengths.reduce((a, b) => a + b, 0),
    'usedLength 应为各卷之和'
  );
}

console.log('多卷排样优化器');

test('两卷都容得下全部件时只启用一卷（省卷）', () => {
  const pieces = [];
  for (let i = 0; i < 4; i++) {
    pieces.push({ key: 'p' + i, maskKey: 'r', verts: rect(0, 0, 400, 400), allowRotate: false, w: 400, h: 400, area: 160000 });
  }
  const result = optimizeRolls({
    rolls: [
      { label: 'R1', W: 1000, L: 5000, defects: [] },
      { label: 'R2', W: 1000, L: 5000, defects: [] },
    ],
    locked: [],
    pieces,
  });
  assert.strictEqual(result.unplaced.length, 0);
  const opened = result.rollUsedLengths.filter((l) => l > 0).length;
  assert.strictEqual(opened, 1, '应只启用 1 卷');
  verifyMultiLayout({ rolls: [{ W: 1000, L: 5000 }, { W: 1000, L: 5000 }], locked: [], result, typesByKey: new Map(pieces.map((p) => [p.key, p])) });
});

test('一卷装不下时自动启用第二卷，全部排入', () => {
  const pieces = [];
  for (let i = 0; i < 6; i++) {
    pieces.push({ key: 'p' + i, maskKey: 'r', verts: rect(0, 0, 450, 450), allowRotate: false, w: 450, h: 450, area: 202500 });
  }
  const rolls = [
    { label: 'R1', W: 1000, L: 1000, defects: [] }, // 每卷最多 4 件
    { label: 'R2', W: 1000, L: 1000, defects: [] },
  ];
  const result = optimizeRolls({ rolls, locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 0, '6 件应全部排入两卷');
  assert.strictEqual(result.rollUsedLengths.filter((l) => l > 0).length, 2, '两卷都应启用');
  verifyMultiLayout({ rolls, locked: [], result, typesByKey: new Map(pieces.map((p) => [p.key, p])) });
});

test('必用卷约束：必用件只在指定卷；省卷优先时其余件向已开卷集中', () => {
  // 1 件必用卷2；3 件普通件。1000 宽卷每行 2 件 400，卷2 长度 5000 足够全部放入
  // → 最少启用卷数为 1 时不可行（必用件强制开卷2，普通件全部去卷2仍只需1卷）→
  // 实际：必用件开卷2，普通件若全去卷2则总只开 1 卷（卷2），这是省卷最优，允许。
  const pieces = [
    { key: 'a', maskKey: 'r', verts: rect(0, 0, 400, 400), allowRotate: false, w: 400, h: 400, area: 160000, requiredIndex: 1 },
    { key: 'b', maskKey: 'r', verts: rect(0, 0, 400, 400), allowRotate: false, w: 400, h: 400, area: 160000 },
  ];
  const rolls = [
    { label: 'R1', W: 1000, L: 5000, defects: [] },
    { label: 'R2', W: 1000, L: 5000, defects: [] },
  ];
  const result = optimizeRolls({ rolls, locked: [], pieces });
  const pa = result.placements.find((p) => p.key === 'a');
  assert.strictEqual(pa.rollIndex, 1, '必用卷件必须在卷2');
  assert.strictEqual(result.rollUsedLengths.filter((l) => l > 0).length, 1, '最少卷数=1（卷2）');
  verifyMultiLayout({ rolls, locked: [], result, typesByKey: new Map(pieces.map((p) => [p.key, p])) });
});

test('必用卷约束 + 容量：必用卷装不下全部时才开第二卷，且必用件绝不去别的卷', () => {
  // 卷2很短（只能放 1 行 2 件 400），必用件 a 在卷2；再放 3 件普通件
  const pieces = [
    { key: 'a', maskKey: 'r', verts: rect(0, 0, 400, 400), allowRotate: false, w: 400, h: 400, area: 160000, requiredIndex: 1 },
    ...[0, 1, 2].map((i) => ({ key: 'b' + i, maskKey: 'r', verts: rect(0, 0, 400, 400), allowRotate: false, w: 400, h: 400, area: 160000 })),
  ];
  const rolls = [
    { label: 'R1', W: 1000, L: 5000, defects: [] },
    { label: 'R2', W: 1000, L: 500, defects: [] },
  ];
  const result = optimizeRolls({ rolls, locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 0, result.unplaced.map((u) => u.reason).join('；'));
  assert.strictEqual(result.placements.find((p) => p.key === 'a').rollIndex, 1);
  assert.strictEqual(result.rollUsedLengths.filter((l) => l > 0).length, 2, '容量迫使开第二卷');
  verifyMultiLayout({ rolls, locked: [], result, typesByKey: new Map(pieces.map((p) => [p.key, p])) });
});

test('必用卷长度不足：该件未排，其余件照常排入（部分方案，不牺牲可排件）', () => {
  const pieces = [
    { key: 'big', maskKey: 'r', verts: rect(0, 0, 400, 800), allowRotate: false, w: 400, h: 800, area: 320000, requiredIndex: 0 },
    { key: 'ok', maskKey: 'r2', verts: rect(0, 0, 200, 200), allowRotate: false, w: 200, h: 200, area: 40000 },
  ];
  const rolls = [
    { label: '短卷', W: 1000, L: 500, defects: [] },
    { label: '长卷', W: 1000, L: 5000, defects: [] },
  ];
  const result = optimizeRolls({ rolls, locked: [], pieces });
  assert.strictEqual(result.placements.length, 1, '只排入 1 件');
  assert.strictEqual(result.unplaced.length, 1);
  assert.strictEqual(result.unplaced[0].key, 'big');
  assert(/必用卷/.test(result.unplaced[0].reason), '原因应指明必用卷');
});

test('各卷瑕疵独立：卷1瑕疵不影响卷2排样', () => {
  const pieces = [{ key: 'a', maskKey: 'r', verts: rect(0, 0, 200, 200), allowRotate: false, w: 200, h: 200, area: 40000, requiredIndex: 1 }];
  const rolls = [
    { label: 'R1', W: 1000, L: 1000, defects: [{ x: 0, y: 0, w: 1000, h: 1000 }] }, // 卷1全瑕疵
    { label: 'R2', W: 1000, L: 1000, defects: [] },
  ];
  const result = optimizeRolls({ rolls, locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 0, '卷2干净，应排入');
  assert.strictEqual(result.placements[0].rollIndex, 1);
  verifyMultiLayout({ rolls, locked: [], result, typesByKey: new Map(pieces.map((p) => [p.key, p])) });
});

test('跨卷压实可腾空整卷', () => {
  // 锁定：卷1放一件占着卷1；解锁件都很小。再给一件必用卷1以外的件→
  // 这里直接构造：锁定件在卷1，4 个 450x450 件可被重排。1000 宽卷每排2件。
  const pieces = [];
  for (let i = 0; i < 4; i++) {
    pieces.push({ key: 'p' + i, maskKey: 'r', verts: rect(0, 0, 450, 450), allowRotate: false, w: 450, h: 450, area: 202500 });
  }
  const locked = [{ key: 'L1', rollIndex: 0, verts: rect(0, 0, 100, 100), rot: 0, x: 0, y: 0, w: 100, h: 100 }];
  const rolls = [
    { label: 'R1', W: 1000, L: 2000, defects: [] },
    { label: 'R2', W: 1000, L: 2000, defects: [] },
  ];
  // L1 在卷1 → 卷1必然启用；4 件 450x450 与 100x100 锁定件同卷可容纳（首行仍可放2件450）
  const result = optimizeRolls({ rolls, locked, pieces });
  assert.strictEqual(result.unplaced.length, 0);
  // 卷1已被锁定件启用，最优是 4 件全放卷1，卷2不启用
  assert.strictEqual(result.rollUsedLengths[1], 0, '卷2应可被腾空');
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  typesByKey.set('L1', { verts: rect(0, 0, 100, 100), w: 100, h: 100 });
  verifyMultiLayout({ rolls, locked, result, typesByKey });
});

test('空卷宽度不同：宽件能排入更宽的空卷（不因按代表卷漏排）', () => {
  // 卷1窄（放不下 1200 宽件），卷2宽且空无瑕疵；空卷代表不能只取卷1
  const pieces = [
    { key: 'wide', maskKey: 'r', verts: rect(0, 0, 1200, 300), allowRotate: false, w: 1200, h: 300, area: 360000 },
    { key: 'small', maskKey: 'r2', verts: rect(0, 0, 100, 100), allowRotate: false, w: 100, h: 100, area: 10000 },
  ];
  const rolls = [
    { label: '窄', W: 900, L: 3000, defects: [] },
    { label: '宽', W: 1600, L: 3000, defects: [] },
  ];
  const result = optimizeRolls({ rolls, locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 0, '两件都应排入（宽件去宽卷）');
  const w = result.placements.find((p) => p.key === 'wide');
  assert.strictEqual(w.rollIndex, 1, '宽件应在宽卷');
  verifyMultiLayout({ rolls, locked: [], result, typesByKey: new Map(pieces.map((p) => [p.key, p])) });
});

test('多卷锁定件：跨卷位置与卷号都保持固定', () => {
  const locked = [
    { key: 'L1', rollIndex: 0, verts: rect(0, 0, 300, 300), rot: 0, x: 0, y: 0, w: 300, h: 300 },
    { key: 'L2', rollIndex: 1, verts: rect(0, 0, 300, 300), rot: 0, x: 700, y: 700, w: 300, h: 300 },
  ];
  const pieces = [{ key: 'p', maskKey: 'r', verts: rect(0, 0, 200, 200), allowRotate: false, w: 200, h: 200, area: 40000 }];
  const rolls = [
    { label: 'R1', W: 1000, L: 2000, defects: [] },
    { label: 'R2', W: 1000, L: 2000, defects: [] },
  ];
  const result = optimizeRolls({ rolls, locked, pieces });
  verifyMultiLayout({ rolls, locked, result, typesByKey: new Map([...pieces.map((p) => [p.key, p]), ...locked.map((l) => [l.key, { verts: l.verts, w: l.w, h: l.h }])]) });
  const l1 = result.placements.find((p) => p.key === 'L1');
  const l2 = result.placements.find((p) => p.key === 'L2');
  assert(l1.rollIndex === 0 && l1.x === 0 && l1.y === 0);
  assert(l2.rollIndex === 1 && l2.x === 700 && l2.y === 700);
});

// ---------------- 创建输入校验：多卷与必用卷 ----------------

console.log('多卷输入校验');

test('多卷形式通过：rolls + 按序号/卷号指定必用卷', () => {
  const r1 = validateJobInput({
    rolls: [
      { label: 'A', width: 1000, length: 2000, defects: [] },
      { label: 'B', width: 1200, length: 3000 },
    ],
    pieces: [
      { name: 'p1', vertices: [[0, 0], [10, 0], [10, 10], [0, 10]], quantity: 1, requiredRoll: 2 },
      { name: 'p2', vertices: [[0, 0], [10, 0], [10, 10], [0, 10]], quantity: 1, requiredRoll: 'B' },
    ],
  });
  assert.strictEqual(r1.errors.length, 0, r1.errors.join('；'));
  assert.strictEqual(r1.value.pieces[0].requiredRollIndex, 1);
  assert.strictEqual(r1.value.pieces[1].requiredRollIndex, 1);
});

test('旧单卷形式继续通过并归一为一卷', () => {
  const r = validateJobInput({
    fabricWidth: 1500, fabricLength: 5000,
    defects: [{ x: 0, y: 0, w: 10, h: 10 }],
    pieces: [{ name: 'q', vertices: [[0, 0], [100, 0], [100, 100], [0, 100]], quantity: 2 }],
  });
  assert.strictEqual(r.errors.length, 0, r.errors.join('；'));
  assert.strictEqual(r.value.rolls.length, 1);
  assert.strictEqual(r.value.rolls[0].width, 1500);
  assert.strictEqual(r.value.rolls[0].defects.length, 1);
});

test('必用卷序号越界被拒绝', () => {
  const r = validateJobInput({
    rolls: [{ width: 1000, length: 1000 }],
    pieces: [{ name: 'p', vertices: [[0, 0], [10, 0], [10, 10], [0, 10]], quantity: 1, requiredRoll: 3 }],
  });
  assert(r.errors.some((e) => /必用卷序号 3 无效/.test(e)));
});

test('不存在的卷号文本被拒绝并列出已登记卷号', () => {
  const r = validateJobInput({
    rolls: [{ label: '甲', width: 1000, length: 1000 }],
    pieces: [{ name: 'p', vertices: [[0, 0], [10, 0], [10, 10], [0, 10]], quantity: 1, requiredRoll: '乙' }],
  });
  assert(r.errors.some((e) => /卷号「乙」不存在/.test(e) && /甲/.test(e)));
});

test('宽度超过必用卷被拒绝（即便其他卷容得下）', () => {
  const r = validateJobInput({
    rolls: [{ label: '窄', width: 100, length: 1000 }, { label: '宽', width: 1000, length: 1000 }],
    pieces: [{ name: 'p', vertices: [[0, 0], [500, 0], [500, 500], [0, 500]], quantity: 1, requiredRoll: 1 }],
  });
  assert(r.errors.some((e) => /超过必用卷「窄」布幅/.test(e)), r.errors.join('；'));
});

test('重复卷号被拒绝', () => {
  const r = validateJobInput({
    rolls: [{ label: 'R', width: 1000, length: 1000 }, { label: 'R', width: 1000, length: 1000 }],
    pieces: [{ name: 'p', vertices: [[0, 0], [10, 0], [10, 10], [0, 10]], quantity: 1 }],
  });
  assert(r.errors.some((e) => /卷号「R」重复/.test(e)));
});

test('瑕疵超出所属卷范围被拒绝', () => {
  const r = validateJobInput({
    rolls: [{ label: 'R', width: 500, length: 500, defects: [{ x: 400, y: 0, w: 200, h: 10 }] }],
    pieces: [{ name: 'p', vertices: [[0, 0], [10, 0], [10, 10], [0, 10]], quantity: 1 }],
  });
  assert(r.errors.some((e) => /超出该卷范围/.test(e)));
});

test('多卷中某卷容得下即可（不因首卷窄而误拒）', () => {
  const r = validateJobInput({
    rolls: [{ label: '窄', width: 100, length: 1000 }, { label: '宽', width: 1000, length: 1000 }],
    pieces: [{ name: 'p', vertices: [[0, 0], [500, 0], [500, 500], [0, 500]], quantity: 1 }],
  });
  assert.strictEqual(r.errors.length, 0, r.errors.join('；'));
});

// ---------------- HTTP API（多卷端到端） ----------------

console.log('HTTP API（多卷）');

async function withServer(fn) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const http = require('http');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nesting-test-'));
  process.env.DATA_DIR = dir;
  process.env.PORT = '0';
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((res) => server.once('listening', res));
  const port = server.address().port;
  const call = (method, urlPath, body) =>
    new Promise((resolve) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request(
        { port, host: '127.0.0.1', method, path: urlPath, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {} },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null }));
        }
      );
      if (payload) req.write(payload);
      req.end();
    });
  try {
    await fn(call);
  } finally {
    await new Promise((res) => server.close(res));
    fs.rmSync(dir, { recursive: true, force: true });
    delete require.cache[require.resolve('../src/server')];
    delete require.cache[require.resolve('../src/db')];
  }
}

test('API：多卷创建→优化→锁定重优化→旧字段兼容', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      name: 'api多卷',
      rolls: [
        { label: 'A卷', width: 1000, length: 2000, defects: [{ x: 0, y: 0, w: 300, h: 300 }] },
        { label: 'B卷', width: 1200, length: 3000 },
      ],
      pieces: [
        { name: '大片', vertices: [[0, 0], [500, 0], [500, 800], [0, 800]], quantity: 2, allowRotate: true },
        { name: '袖片', vertices: [[0, 0], [300, 0], [300, 400], [0, 400]], quantity: 1, requiredRoll: 2 },
      ],
    });
    assert.strictEqual(cr.status, 201, JSON.stringify(cr.data));
    const jobId = cr.data.job.id;
    assert.strictEqual(cr.data.job.rollCount, 2);
    assert(Array.isArray(cr.data.rolls) && cr.data.rolls.length === 2);
    const A = cr.data.rolls[0].id;
    const B = cr.data.rolls[1].id;

    // 列表接口带 rollCount
    const list = await call('GET', '/api/jobs');
    const row = list.data.find((j) => j.id === jobId);
    assert.strictEqual(row.rollCount, 2);
    assert.strictEqual(row.fabricWidth, 1000); // 旧字段=首卷宽度

    // 优化
    const op = await call('POST', `/api/jobs/${jobId}/optimize`);
    assert.strictEqual(op.status, 200);
    assert.strictEqual(op.data.unplaced.length, 0);
    assert(op.data.placements.every((p) => typeof p.rollId === 'number'), '每件都带 rollId');
    const xiu = op.data.placements.find((p) => p.name === '袖片');
    assert.strictEqual(xiu.rollId, B, '袖片必用B卷');

    // 锁定大片#1 在其当前位置，重优化后位置/卷不变
    const dp = op.data.placements.find((p) => p.name === '大片' && p.seq === 1);
    const lk = await call('POST', `/api/jobs/${jobId}/placements/${dp.id}/lock`, { locked: true });
    assert.strictEqual(lk.status, 200);
    const op2 = await call('POST', `/api/jobs/${jobId}/optimize`);
    const dp2 = op2.data.placements.find((p) => p.id === dp.id);
    assert(dp2.locked && dp2.rollId === dp.rollId && dp2.x === dp.x && dp2.y === dp.y, '锁定件不动');

    // 锁定件移动 409
    const lm = await call('POST', `/api/jobs/${jobId}/placements/${dp.id}/move`, { rollId: dp.rollId, x: 5, y: 5, rotation: 0 });
    assert.strictEqual(lm.status, 409);

    // 必用卷跨卷移动 409 且指出对象
    const mv = await call('POST', `/api/jobs/${jobId}/placements/${xiu.id}/move`, { rollId: A, x: 0, y: 0, rotation: 0 });
    assert.strictEqual(mv.status, 409);
    assert(/必用卷/.test(mv.data.error) && mv.data.conflicts.length >= 1);

    // 无效目标卷 400
    const bad = await call('POST', `/api/jobs/${jobId}/placements/${xiu.id}/move`, { rollId: 99999, x: 0, y: 0, rotation: 0 });
    assert.strictEqual(bad.status, 400);

    // require-roll：改必用卷为 A（500<=1000 合法）
    const rr = await call('POST', `/api/jobs/${jobId}/placements/${xiu.id}/require-roll`, { rollId: A });
    assert.strictEqual(rr.status, 200);
    assert.strictEqual(rr.data.placements.find((p) => p.id === xiu.id).requiredRollId, A);
    // 必用卷太窄 400（用一个新宽件场景：袖片 300 宽，这里构造窄卷 via 新方案）
  })
);

test('API：必用卷放不下时优化为部分方案，未排件带原因且响应保留卷字段', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: '短卷', width: 500, length: 500 }],
      pieces: [{ name: '块', vertices: [[0, 0], [500, 0], [500, 400], [0, 400]], quantity: 2 }],
    });
    const jobId = cr.data.job.id;
    const op = await call('POST', `/api/jobs/${jobId}/optimize`);
    assert.strictEqual(op.data.job.status, 'partial');
    assert.strictEqual(op.data.unplaced.length, 1);
    assert(op.data.unplaced[0].reason && op.data.unplaced[0].reason.length > 0);
    assert(Array.isArray(op.data.rolls));
  })
);

test('API：旧单卷数据与旧调用方式兼容（无 rolls、move 不带 rollId）', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      name: '旧', fabricWidth: 1500, fabricLength: 5000,
      defects: [{ x: 1, y: 2, w: 10, h: 10 }],
      pieces: [{ name: 'q', vertices: [[0, 0], [100, 0], [100, 100], [0, 100]], quantity: 2 }],
    });
    assert.strictEqual(cr.status, 201, JSON.stringify(cr.data));
    assert.strictEqual(cr.data.rolls[0].label, '默认卷');
    assert.strictEqual(cr.data.defects.length, 1, '旧 defects 字段仍返回首卷瑕疵');
    const jobId = cr.data.job.id;
    const op = await call('POST', `/api/jobs/${jobId}/optimize`);
    assert.strictEqual(op.data.unplaced.length, 0);
    const pid = op.data.placements[0].id;
    const mv = await call('POST', `/api/jobs/${jobId}/placements/${pid}/move`, { x: 200, y: 200, rotation: 0 });
    assert.strictEqual(mv.status, 200, JSON.stringify(mv.data));
    assert.strictEqual(mv.data.placements.find((p) => p.id === pid).x, 200);
  })
);

// ---------------- 裁剪进度（按卷逐段，不可回退） ----------------

console.log('裁剪进度 API');

test('API：切线校验——非整数/非正/超卷长/穿过裁片/无效卷均拒绝且方案不变', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: 'A', width: 1000, length: 5000 }, { label: 'B', width: 1000, length: 4000 }],
      pieces: [{ name: '块', vertices: rect(0, 0, 500, 500), quantity: 4 }],
    });
    const jobId = cr.data.job.id;
    const A = cr.data.rolls[0].id;
    const B = cr.data.rolls[1].id;
    const op = await call('POST', `/api/jobs/${jobId}/optimize`);
    assert.strictEqual(op.data.unplaced.length, 0);
    // 500x500 在 1000 宽卷每行两件：件集中在其中一卷
    const usedRollId = op.data.placements[0].rollId;
    const usedRoll = cr.data.rolls.find((r) => r.id === usedRollId);

    assert.strictEqual((await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: usedRollId, cutLine: 400.5 })).status, 400);
    assert.strictEqual((await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: usedRollId, cutLine: '300' })).status, 400);
    let r = await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: usedRollId, cutLine: 0 });
    assert.strictEqual(r.status, 409);
    r = await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: usedRollId, cutLine: usedRoll.length + 1 });
    assert.strictEqual(r.status, 409);
    assert(new RegExp(`超出卷「${usedRoll.label}」可用长度`).test(r.data.error));
    r = await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: 99999, cutLine: 500 });
    assert.strictEqual(r.status, 400);
    // 多卷省略 rollId → 400
    r = await call('POST', `/api/jobs/${jobId}/cuts`, { cutLine: 500 });
    assert.strictEqual(r.status, 400);

    // 切线 300 穿过该卷 y0~500 的件
    r = await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: usedRollId, cutLine: 300 });
    assert.strictEqual(r.status, 409);
    assert(/穿过/.test(r.data.error));
    assert(r.data.conflicts.length >= 1);

    // 全部被拒后方案无任何裁剪进度
    const q = await call('GET', `/api/jobs/${jobId}/cuts`);
    assert(q.data.cuts.every((c) => c.cutLine === 0 && c.cutCount === 0));
  })
);

test('API：确认切线后返回切线与各件已裁状态；无新增件/回退/重复均拒绝', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: 'A', width: 1000, length: 4000 }],
      pieces: [{ name: '块', vertices: rect(0, 0, 500, 500), quantity: 3 }],
    });
    const jobId = cr.data.job.id;
    const A = cr.data.rolls[0].id;
    const op = await call('POST', `/api/jobs/${jobId}/optimize`);
    // 布局：两件在 y0~500，一件在 y500~1000
    const first = op.data.placements.filter((p) => p.y === 0).map((p) => p.id).sort((a, b) => a - b);
    assert.strictEqual(first.length, 2);

    // 单卷可省略 rollId
    let r = await call('POST', `/api/jobs/${jobId}/cuts`, { cutLine: 500 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.cut.cutLine, 500);
    assert.deepStrictEqual(r.data.cut.newCutPieceIds, first);
    assert.strictEqual(r.data.rolls[0].cutLine, 500);
    assert.strictEqual(r.data.rolls[0].cutCount, 2);
    for (const p of r.data.placements) {
      assert.strictEqual(p.cut, first.includes(p.id));
    }

    // 查询接口
    const q = await call('GET', `/api/jobs/${jobId}/cuts`);
    assert.strictEqual(q.data.cuts.length, 1);
    assert.strictEqual(q.data.cuts[0].cutLine, 500);
    assert.strictEqual(q.data.cuts[0].cutPieces.length, 2);
    assert(q.data.cuts[0].cutPieces.every((p) => p.y < 500));

    // 相同切线/回退 → 409
    assert.strictEqual((await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 500 })).status, 409);
    assert.strictEqual((await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 499 })).status, 409);

    // 切线 700 穿过第三件（y500~1000）→ 409 且进度不变
    r = await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 700 });
    assert.strictEqual(r.status, 409);
    assert(/穿过/.test(r.data.error));

    // 推进到 1000：第三件新增已裁
    r = await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 1000 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.cut.newCutCount, 1);
    assert.strictEqual(r.data.rolls[0].cutCount, 3);

    // 再往前切但无新增件 → 409
    r = await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 1200 });
    assert.strictEqual(r.status, 409);
    assert(/没有新增已裁件/.test(r.data.error));
  })
);

test('API：已裁件卷号/位置/方向/必用卷不可改，不能移回未排区或解锁', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: 'A', width: 1000, length: 4000 }, { label: 'B', width: 1000, length: 4000 }],
      pieces: [{ name: '块', vertices: rect(0, 0, 300, 300), quantity: 2 }],
    });
    const jobId = cr.data.job.id;
    const A = cr.data.rolls[0].id;
    const B = cr.data.rolls[1].id;
    await call('POST', `/api/jobs/${jobId}/optimize`);
    const cut = await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 300 });
    const cutPiece = cut.data.placements.find((p) => p.cut);
    assert(cutPiece, '应至少有一件已裁');

    let r = await call('POST', `/api/jobs/${jobId}/placements/${cutPiece.id}/move`, { rollId: A, x: 10, y: 10, rotation: 0 });
    assert.strictEqual(r.status, 409);
    r = await call('POST', `/api/jobs/${jobId}/placements/${cutPiece.id}/move`, { rollId: B, x: 0, y: 0, rotation: 0 });
    assert.strictEqual(r.status, 409);
    assert.strictEqual((await call('POST', `/api/jobs/${jobId}/placements/${cutPiece.id}/unplace`)).status, 409);
    assert.strictEqual((await call('POST', `/api/jobs/${jobId}/placements/${cutPiece.id}/lock`, { locked: true })).status, 409);
    assert.strictEqual((await call('POST', `/api/jobs/${jobId}/placements/${cutPiece.id}/lock`, { locked: false })).status, 409);
    r = await call('POST', `/api/jobs/${jobId}/placements/${cutPiece.id}/require-roll`, { rollId: B });
    assert.strictEqual(r.status, 409);

    // 方案状态确认：已裁件仍在原位原卷
    const st = await call('GET', `/api/jobs/${jobId}`);
    const p = st.data.placements.find((x) => x.id === cutPiece.id);
    assert(p.placed && p.cut && p.rollId === A);
    assert.strictEqual(p.x, cutPiece.x);
    assert.strictEqual(p.y, cutPiece.y);
  })
);

test('API：手动移动/跨卷调整不得把未裁件放入已裁段；边接触切线允许', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: 'A', width: 1000, length: 4000 }, { label: 'B', width: 1000, length: 4000 }],
      pieces: [{ name: '块', vertices: rect(0, 0, 500, 300), quantity: 4 }],
    });
    const jobId = cr.data.job.id;
    const A = cr.data.rolls[0].id;
    const B = cr.data.rolls[1].id;
    const op = await call('POST', `/api/jobs/${jobId}/optimize`);
    // 全部排在 A：y0 两件、y300 两件。切 300 裁下前两件
    await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 300 });
    const unc = op.data.placements.find((p) => p.y === 300);

    // 进入已裁段内部 → 409
    let r = await call('POST', `/api/jobs/${jobId}/placements/${unc.id}/move`, { rollId: A, x: 0, y: 0, rotation: 0 });
    assert.strictEqual(r.status, 409);
    assert(/已裁段/.test(r.data.error));

    // 边接触切线 y=300 → 200
    r = await call('POST', `/api/jobs/${jobId}/placements/${unc.id}/move`, { rollId: A, x: 0, y: 300, rotation: 0 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));

    // 跨卷到未裁剪的 B 卷 → 200
    r = await call('POST', `/api/jobs/${jobId}/placements/${unc.id}/move`, { rollId: B, x: 0, y: 0, rotation: 0 });
    assert.strictEqual(r.status, 200);
  })
);

test('API：优化只重排未裁件——已裁件固定，未裁件在本卷必位于切线之后', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: 'A', width: 1000, length: 4000 }, { label: 'B', width: 1000, length: 4000 }],
      pieces: [{ name: '块', vertices: rect(0, 0, 500, 300), quantity: 6 }],
    });
    const jobId = cr.data.job.id;
    const A = cr.data.rolls[0].id;
    const B = cr.data.rolls[1].id;
    let op = await call('POST', `/api/jobs/${jobId}/optimize`);
    assert.strictEqual(op.data.unplaced.length, 0);
    // 切线 300 裁下 A 卷 y0 行的两件（若优化器全集中到一卷）
    const cut = await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 300 });
    if (cut.status !== 200) {
      // 布局可能与预期不同：确保至少有一件在 A 卷 y0 行再裁剪——用返回成功的最小可行切线
      assert.fail('前置布局异常：A 卷切线 300 未能裁下任何件');
    }
    const cutIds = new Set(cut.data.cut.newCutPieceIds);
    const before = new Map(cut.data.placements.filter((p) => cutIds.has(p.id)).map((p) => [p.id, p]));

    op = await call('POST', `/api/jobs/${jobId}/optimize`);
    assert.strictEqual(op.data.unplaced.length, 0, op.data.unplaced.map((u) => u.reason).join('；'));
    for (const p of op.data.placements) {
      if (cutIds.has(p.id)) {
        const b = before.get(p.id);
        assert(p.cut && p.rollId === b.rollId && p.x === b.x && p.y === b.y && p.rotation === b.rotation, '已裁件必须保持原位原卷原方向');
      } else if (p.placed && p.rollId === A) {
        assert(p.y >= 300, `未裁件在 A 卷必须位于切线之后（y=${p.y}）`);
      }
    }
  })
);

test('API：切线后剩余长度容不下裁片时设置必用卷被拒绝', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: '短卷', width: 1000, length: 600 }, { label: '长卷', width: 1000, length: 5000 }],
      pieces: [
        { name: '垫底', vertices: rect(0, 0, 500, 400), quantity: 1 },
        { name: '活动', vertices: rect(0, 0, 500, 300), quantity: 1 },
      ],
    });
    const jobId = cr.data.job.id;
    const short = cr.data.rolls[0].id;
    const long = cr.data.rolls[1].id;
    const op = await call('POST', `/api/jobs/${jobId}/optimize`);
    const filler = op.data.placements.find((p) => p.name === '垫底');
    const mover = op.data.placements.find((p) => p.name === '活动');
    // 垫底件放短卷 y0，活动件放长卷，再裁短卷 400
    assert.strictEqual((await call('POST', `/api/jobs/${jobId}/placements/${filler.id}/move`, { rollId: short, x: 0, y: 0, rotation: 0 })).status, 200);
    assert.strictEqual((await call('POST', `/api/jobs/${jobId}/placements/${mover.id}/move`, { rollId: long, x: 0, y: 0, rotation: 0 })).status, 200);
    assert.strictEqual((await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: short, cutLine: 400 })).status, 200);
    // 活动件（500x300）必用短卷：切线后仅剩 200mm → 400
    const r = await call('POST', `/api/jobs/${jobId}/placements/${mover.id}/require-roll`, { rollId: short });
    assert.strictEqual(r.status, 400);
    assert(/切线后剩余长度/.test(r.data.error));
  })
);

test('API：裁剪进度在 GET 详情与旧字段中同时可用且不破坏原字段', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      name: '旧', fabricWidth: 1200, fabricLength: 3000,
      defects: [{ x: 0, y: 0, w: 10, h: 10 }],
      pieces: [{ name: 'q', vertices: rect(0, 0, 200, 200), quantity: 2 }],
    });
    const jobId = cr.data.job.id;
    await call('POST', `/api/jobs/${jobId}/optimize`);
    const cut = await call('POST', `/api/jobs/${jobId}/cuts`, { cutLine: 200 });
    assert.strictEqual(cut.status, 200);
    // 旧字段仍在
    assert.strictEqual(cut.data.job.fabricWidth, 1200);
    assert.strictEqual(cut.data.defects.length, 1);
    assert.strictEqual(typeof cut.data.placements[0].x, 'number');
    // 新字段
    assert.strictEqual(cut.data.rolls[0].cutLine, 200);
    assert.strictEqual(cut.data.cuts[0].cutLine, 200);
    assert(cut.data.placements.some((p) => p.cut === true));
  })
);

// ---------------- 改版纸样（按型号修订） ----------------

console.log('改版纸样 API');

test('API：改版——新轮廓非法/件数非正整数 400 且方案不变', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: 'A', width: 1000, length: 5000 }],
      pieces: [{ name: '块', vertices: rect(0, 0, 400, 400), quantity: 2 }],
    });
    const jobId = cr.data.job.id;
    const tid = cr.data.pieceTypes[0].id;
    let r = await call('POST', `/api/jobs/${jobId}/piece-types/${tid}/revisions`, {
      vertices: [[0, 0], [10, 10], [10, 0], [0, 10]], quantity: 2, // 自交
    });
    assert.strictEqual(r.status, 400);
    assert(/自相交/.test(r.data.details.join()));
    r = await call('POST', `/api/jobs/${jobId}/piece-types/${tid}/revisions`, {
      vertices: rect(0, 0, 300, 300), quantity: 0,
    });
    assert.strictEqual(r.status, 400);
    assert(/正整数/.test(r.data.details.join()));
    // 不存在型号 404
    r = await call('POST', `/api/jobs/${jobId}/piece-types/99999/revisions`, {
      vertices: rect(0, 0, 300, 300), quantity: 1,
    });
    assert.strictEqual(r.status, 404);
    // 原方案仍为第 1 版
    const q = await call('GET', `/api/jobs/${jobId}`);
    assert.strictEqual(q.data.pieceTypes[0].currentRev, 1);
    assert(q.data.placements.every((p) => p.revision === 1 && p.bw === 400));
  })
);

test('API：改版——已裁件定格旧轮廓旧位置，未裁件用新轮廓并按 id 升序退回失效件', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: 'A', width: 1000, length: 5000 }],
      pieces: [{ name: '块', vertices: rect(0, 0, 400, 400), quantity: 4 }],
    });
    const jobId = cr.data.job.id;
    const tid = cr.data.pieceTypes[0].id;
    const rid = cr.data.rolls[0].id;
    await call('POST', `/api/jobs/${jobId}/optimize`);
    // 布局 y=0 两件、y=400 两件；切线 400 裁下前两件
    const cut = await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: rid, cutLine: 400 });
    assert.strictEqual(cut.status, 200);
    const cutIds = new Set(cut.data.cut.newCutPieceIds);

    // 改版 400→500 见方
    const rv = await call('POST', `/api/jobs/${jobId}/piece-types/${tid}/revisions`, {
      vertices: rect(0, 0, 500, 500), quantity: 4, allowRotate: true,
    });
    assert.strictEqual(rv.status, 200, JSON.stringify(rv.data));
    assert.strictEqual(rv.data.revision.revision, 2);
    assert.deepStrictEqual(rv.data.revision.cutPieceIdsKept.sort(), [...cutIds].sort());
    for (const p of rv.data.placements) {
      if (cutIds.has(p.id)) {
        assert(p.cut && p.revision === 1 && p.bw === 400, '已裁件保留第 1 版轮廓');
      } else {
        assert.strictEqual(p.revision, 2, '未裁件改用第 2 版');
        assert.strictEqual(p.bw, 500);
      }
    }
    // y=400 的两件原位 (0,400)/(400,400) 在 500 宽下互相重叠：id 小者退回，大者保留
    const unc = rv.data.placements.filter((p) => !cutIds.has(p.id)).sort((a, b) => a.id - b.id);
    assert.strictEqual(unc[0].placed, false);
    assert(/改版/.test(unc[0].reason) && /冲突/.test(unc[0].reason));
    assert.strictEqual(unc[1].placed, true);
    // 型号携带全部版次
    assert.deepStrictEqual(rv.data.pieceTypes[0].revisions.map((r) => r.rev), [1, 2]);
    // 卷占用按新轮廓重算（保留件 y=400+500=900），且仍包含切线前占用
    const roll = rv.data.rolls.find((r) => r.id === rid);
    assert.strictEqual(roll.usedLength, 900);
    assert.strictEqual(rv.data.job.status, 'partial');
  })
);

test('API：改版——缩减先删未排件，再按 id 降序删未锁定已排件，绝不删已裁/锁定件', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: 'A', width: 1000, length: 5000 }],
      pieces: [{ name: '块', vertices: rect(0, 0, 400, 400), quantity: 4 }],
    });
    const jobId = cr.data.job.id;
    const tid = cr.data.pieceTypes[0].id;
    const rid = cr.data.rolls[0].id;
    await call('POST', `/api/jobs/${jobId}/optimize`);
    const all = (await call('GET', `/api/jobs/${jobId}`)).data.placements.sort((a, b) => a.id - b.id);
    // 裁下 id 最小的两件；把第三件移回未排区
    const [a, b, c, d] = all;
    await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: rid, cutLine: 400 });
    assert.strictEqual((await call('POST', `/api/jobs/${jobId}/placements/${c.id}/unplace`)).status, 200);
    // 4→2：已裁 2 件受保护，未排件 c 先删，已排未锁定 d 再删；留下恰为已裁两件
    const rv = await call('POST', `/api/jobs/${jobId}/piece-types/${tid}/revisions`, {
      vertices: rect(0, 0, 300, 300), quantity: 2,
    });
    assert.strictEqual(rv.status, 200, JSON.stringify(rv.data));
    const left = rv.data.placements.map((p) => p.id).sort((x, y) => x - y);
    assert.deepStrictEqual(left, [a.id, b.id].sort());
    assert.deepStrictEqual(rv.data.revision.deletedPieceIds.sort(), [c.id, d.id].sort());
  })
);

test('API：改版——目标件数少于已裁+锁定数 400；锁定件原位不满足新轮廓整次 409 且不变', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: 'A', width: 1000, length: 5000 }],
      pieces: [{ name: '块', vertices: rect(0, 0, 400, 400), quantity: 4 }],
    });
    const jobId = cr.data.job.id;
    const tid = cr.data.pieceTypes[0].id;
    const rid = cr.data.rolls[0].id;
    await call('POST', `/api/jobs/${jobId}/optimize`);
    // 4 件 400 见方：y=0 两件、y=400 两件。切线 400 裁下第一行；锁第二行右侧件于 (400,400)
    await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: rid, cutLine: 400 });
    const st = await call('GET', `/api/jobs/${jobId}`);
    const lockedPiece = st.data.placements.find((p) => !p.cut && p.x === 400 && p.y === 400);
    assert(lockedPiece, '应有一件未裁件位于 (400,400)');
    await call('POST', `/api/jobs/${jobId}/placements/${lockedPiece.id}/lock`, { locked: true });
    // 缩到 1：已裁 2 + 未裁锁定 1 = 3 不可删
    let r = await call('POST', `/api/jobs/${jobId}/piece-types/${tid}/revisions`, {
      vertices: rect(0, 0, 300, 300), quantity: 1,
    });
    assert.strictEqual(r.status, 400);
    assert(/不可删除件数/.test(r.data.error));
    // 新轮廓 700 宽，锁定件在 x=400 → 400+700>1000 越布边（但 700 宽本身放得进 1000 卷）：整次拒绝
    r = await call('POST', `/api/jobs/${jobId}/piece-types/${tid}/revisions`, {
      vertices: rect(0, 0, 700, 400), quantity: 4,
    });
    assert.strictEqual(r.status, 409, JSON.stringify(r.data));
    assert(/锁定/.test(r.data.error));
    assert(r.data.conflicts.some((s) => new RegExp(lockedPiece.name + '#').test(s) && /布边/.test(s)));
    // 原方案不变
    const q = await call('GET', `/api/jobs/${jobId}`);
    const p = q.data.placements.find((x) => x.id === lockedPiece.id);
    assert(p.placed && p.locked && p.x === 400 && p.revision === 1);
    assert.strictEqual(q.data.pieceTypes[0].currentRev, 1);
  })
);

test('API：改版——扩增件进入未排区、件号接最大号之后、无必用卷；原必用卷约束保留', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: 'A', width: 1000, length: 5000 }, { label: 'B', width: 800, length: 5000 }],
      pieces: [{ name: '袖', vertices: rect(0, 0, 300, 300), quantity: 2, requiredRoll: 2 }],
    });
    const jobId = cr.data.job.id;
    const tid = cr.data.pieceTypes[0].id;
    const B = cr.data.rolls[1].id;
    await call('POST', `/api/jobs/${jobId}/optimize`);
    const rv = await call('POST', `/api/jobs/${jobId}/piece-types/${tid}/revisions`, {
      vertices: rect(0, 0, 250, 250), quantity: 4, allowRotate: true,
    });
    assert.strictEqual(rv.status, 200, JSON.stringify(rv.data));
    assert.strictEqual(rv.data.revision.addedCount, 2);
    const news = rv.data.placements.filter((p) => p.seq >= 3).sort((a, b) => a.seq - b.seq);
    assert.deepStrictEqual(news.map((p) => p.seq), [3, 4]);
    assert(news.every((p) => !p.placed && p.requiredRollId === null && p.revision === 2));
    // 原两件必用卷约束不变
    assert(rv.data.placements.filter((p) => p.seq <= 2).every((p) => p.requiredRollId === B));
  })
);

test('API：改版——任一剩余卷容不下新外接尺寸或必用卷容不下时 400 且方案不变', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [
        { label: '宽', width: 1600, length: 5000 },
        { label: '窄', width: 600, length: 5000 },
      ],
      pieces: [{ name: '袖', vertices: rect(0, 0, 300, 300), quantity: 1, requiredRoll: 2 }],
    });
    const jobId = cr.data.job.id;
    const tid = cr.data.pieceTypes[0].id;
    // 700 宽：宽卷容得下，但必用窄卷容不下 → 拒绝
    let r = await call('POST', `/api/jobs/${jobId}/piece-types/${tid}/revisions`, {
      vertices: rect(0, 0, 700, 300), quantity: 1,
    });
    assert.strictEqual(r.status, 400);
    assert(/必用卷/.test(r.data.error));
    // 2000 宽：所有卷都放不下 → 拒绝
    r = await call('POST', `/api/jobs/${jobId}/piece-types/${tid}/revisions`, {
      vertices: rect(0, 0, 2000, 300), quantity: 1,
    });
    assert.strictEqual(r.status, 400);
    assert(/任何一卷/.test(r.data.error));
    const q = await call('GET', `/api/jobs/${jobId}`);
    assert.strictEqual(q.data.pieceTypes[0].currentRev, 1);
  })
);

test('API：改版后再次修订针对当前纸样；锁定件原位合法时保留；优化后旧版已裁件仍固定', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: 'A', width: 1000, length: 6000 }],
      pieces: [{ name: '块', vertices: rect(0, 0, 400, 400), quantity: 3, allowRotate: true }],
    });
    const jobId = cr.data.job.id;
    const tid = cr.data.pieceTypes[0].id;
    const rid = cr.data.rolls[0].id;
    await call('POST', `/api/jobs/${jobId}/optimize`);
    await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: rid, cutLine: 400 }); // 裁下前两件
    // 第一次改版为 300×300
    let rv = await call('POST', `/api/jobs/${jobId}/piece-types/${tid}/revisions`, {
      vertices: rect(0, 0, 300, 300), quantity: 3, allowRotate: false,
    });
    assert.strictEqual(rv.status, 200);
    assert.strictEqual(rv.data.pieceTypes[0].currentRev, 2);
    // 再次修订针对当前版 → 第 3 版
    rv = await call('POST', `/api/jobs/${jobId}/piece-types/${tid}/revisions`, {
      vertices: rect(0, 0, 250, 250), quantity: 3, allowRotate: true,
    });
    assert.strictEqual(rv.status, 200);
    assert.strictEqual(rv.data.pieceTypes[0].currentRev, 3);
    assert.deepStrictEqual(rv.data.pieceTypes[0].revisions.map((x) => x.rev), [1, 2, 3]);
    assert(rv.data.placements.some((p) => p.cut && p.revision === 1), '已裁件始终第 1 版');
    assert(rv.data.placements.some((p) => !p.cut && p.revision === 3), '未裁件到第 3 版');
    // 优化后已裁旧版件保持原位原卷，全部未裁件可排齐
    const op = await call('POST', `/api/jobs/${jobId}/optimize`);
    assert.strictEqual(op.status, 200);
    const cutPieces = op.data.placements.filter((p) => p.cut);
    assert(cutPieces.every((p) => p.bw === 400 && p.rollId === rid && p.y < 400));
  })
);

test('API：改版——锁定件与新轮廓、瑕疵/切线冲突的整次拒绝；退回件原因注明冲突对象', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: 'A', width: 1000, length: 5000, defects: [{ x: 0, y: 900, w: 300, h: 100 }] }],
      pieces: [{ name: '块', vertices: rect(0, 0, 400, 400), quantity: 2 }],
    });
    const jobId = cr.data.job.id;
    const tid = cr.data.pieceTypes[0].id;
    await call('POST', `/api/jobs/${jobId}/optimize`);
    const all = (await call('GET', `/api/jobs/${jobId}`)).data.placements.sort((a, b) => a.id - b.id);
    // 把第一件锁到 (0,900)（瑕疵在 y900~1000 的 (0,0)-(300,100) 区，400 见方原位与瑕疵重叠）
    // 先令瑕疵不影响 400 轮廓：瑕疵 (0,900,300x100) 与 (0,900) 的 400x400 重叠，故手动移动会被拒；
    // 改为把锁定件放到不与旧轮廓冲突的 (0,500)，新轮廓改成高 450 → 与瑕疵 y900 重叠。
    await call('POST', `/api/jobs/${jobId}/placements/${all[0].id}/move`, { rollId: cr.data.rolls[0].id, x: 0, y: 500, rotation: 0 });
    await call('POST', `/api/jobs/${jobId}/placements/${all[0].id}/lock`, { locked: true });
    const r = await call('POST', `/api/jobs/${jobId}/piece-types/${tid}/revisions`, {
      vertices: rect(0, 0, 400, 450), quantity: 2, // (0,500)+450=950，伸入瑕疵区
    });
    assert.strictEqual(r.status, 409, JSON.stringify(r.data));
    assert(/锁定裁片/.test(r.data.error));
    assert(r.data.conflicts.some((s) => /瑕疵/.test(s)));
    const q = await call('GET', `/api/jobs/${jobId}`);
    const p = q.data.placements.find((x) => x.id === all[0].id);
    assert(p.locked && p.y === 500 && p.revision === 1);
  })
);

// ---------------- 裁剪交接单（不可改快照，按卷与确认顺序） ----------------

console.log('裁剪交接单 API');

test('API：确认切线生成交接单——前后切线、卷号、新裁件 ID/件号/版次/轮廓/坐标/方向齐全', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: 'A', width: 1000, length: 4000 }, { label: 'B', width: 1000, length: 4000 }],
      pieces: [{ name: '块', vertices: rect(0, 0, 500, 500), quantity: 3, allowRotate: true }],
    });
    const jobId = cr.data.job.id;
    const A = cr.data.rolls[0].id;
    await call('POST', `/api/jobs/${jobId}/optimize`);
    // 布局：y0 两件、y500 一件（同一卷）
    const cut = await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 500 });
    assert.strictEqual(cut.status, 200, JSON.stringify(cut.data));
    assert(cut.data.cut.batchId >= 1, '响应应带交接单号');
    assert.strictEqual(cut.data.cut.batchSeq, 1);

    const list = await call('GET', `/api/jobs/${jobId}/cut-batches`);
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.data.batches.length, 1);
    const b = list.data.batches[0];
    assert.strictEqual(b.id, cut.data.cut.batchId);
    assert.strictEqual(b.rollId, A);
    assert.strictEqual(b.rollLabel, 'A');
    assert.strictEqual(b.seq, 1);
    assert.strictEqual(b.previousCutLine, 0);
    assert.strictEqual(b.cutLine, 500);
    assert.strictEqual(b.pieceCount, 2);
    assert.deepStrictEqual(
      b.pieces.map((p) => p.placementId).sort((x, y) => x - y),
      [...cut.data.cut.newCutPieceIds].sort((x, y) => x - y)
    );
    for (const p of b.pieces) {
      assert.strictEqual(p.name, '块');
      assert.strictEqual(p.revision, 1);
      assert.deepStrictEqual(p.vertices, rect(0, 0, 500, 500));
      assert.strictEqual(p.bw, 500);
      assert.strictEqual(p.bh, 500);
      assert(Number.isInteger(p.x) && Number.isInteger(p.y));
      assert(p.rotation === 0 || p.rotation === 180);
      assert(Number.isInteger(p.seq) && p.seq >= 1);
    }
    assert.strictEqual(list.data.legacyCutPieces.length, 0);

    // 单张详情接口返回同一内容
    const one = await call('GET', `/api/jobs/${jobId}/cut-batches/${b.id}`);
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.data.batch.id, b.id);
    assert.strictEqual(one.data.batch.pieces.length, 2);
    // 不存在的交接单 404
    assert.strictEqual((await call('GET', `/api/jobs/${jobId}/cut-batches/99999`)).status, 404);
  })
);

test('API：多次确认按卷与确认顺序生成连续单号，切线区间链式衔接', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: 'A', width: 1000, length: 6000 }, { label: 'B', width: 1000, length: 6000 }],
      pieces: [{ name: '块', vertices: rect(0, 0, 500, 500), quantity: 6 }],
    });
    const jobId = cr.data.job.id;
    const A = cr.data.rolls[0].id;
    const B = cr.data.rolls[1].id;
    const op = await call('POST', `/api/jobs/${jobId}/optimize`);
    assert.strictEqual(op.data.unplaced.length, 0);
    // 找出各卷上的已排件，逐卷推进两次切线
    const rollOf = new Map(op.data.placements.map((p) => [p.id, p.rollId]));
    const usedRolls = [...new Set(op.data.placements.map((p) => p.rollId))];
    for (const rid of usedRolls) {
      const ys = op.data.placements.filter((p) => p.rollId === rid).map((p) => p.y);
      const lines = [...new Set(ys)].sort((a, b) => a - b).map((y) => y + 500);
      for (const line of lines) {
        const r = await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: rid, cutLine: line });
        assert.strictEqual(r.status, 200, `卷 ${rid} 切线 ${line}: ` + JSON.stringify(r.data));
      }
    }
    const list = await call('GET', `/api/jobs/${jobId}/cut-batches`);
    // 按卷分组、卷内按确认顺序；每卷 seq 从 1 连续递增，区间链式衔接
    const byRoll = new Map();
    for (const b of list.data.batches) {
      if (!byRoll.has(b.rollId)) byRoll.set(b.rollId, []);
      byRoll.get(b.rollId).push(b);
    }
    for (const [rid, arr] of byRoll) {
      let prev = 0;
      arr.forEach((b, i) => {
        assert.strictEqual(b.seq, i + 1, '单号应连续递增');
        assert.strictEqual(b.previousCutLine, prev, '本单前切线应等于上一单切线');
        prev = b.cutLine;
      });
      const roll = (await call('GET', `/api/jobs/${jobId}`)).data.rolls.find((r) => r.id === rid);
      assert.strictEqual(roll.cutLine, prev, '卷切线应等于最后一单切线');
    }
    // rollId 过滤
    const filtered = await call('GET', `/api/jobs/${jobId}/cut-batches?rollId=${A}`);
    assert(filtered.data.batches.every((b) => b.rollId === A));
    // 无效 rollId 400
    assert.strictEqual((await call('GET', `/api/jobs/${jobId}/cut-batches?rollId=99999`)).status, 400);
    assert(rollOf.size > 0 && byRoll.size >= 1);
    assert(B !== A);
  })
);

test('API：切线确认失败不产生交接单，方案保持原状态', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: 'A', width: 1000, length: 4000 }],
      pieces: [{ name: '块', vertices: rect(0, 0, 500, 500), quantity: 2 }],
    });
    const jobId = cr.data.job.id;
    const A = cr.data.rolls[0].id;
    await call('POST', `/api/jobs/${jobId}/optimize`);
    // 穿过裁片 / 无新增件 / 非整数 等各类失败
    assert.strictEqual((await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 300 })).status, 409);
    assert.strictEqual((await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 400.5 })).status, 400);
    assert.strictEqual((await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 0 })).status, 409);
    let list = await call('GET', `/api/jobs/${jobId}/cut-batches`);
    assert.strictEqual(list.data.batches.length, 0, '失败的确认不得产生交接单');
    // 成功一次后再次失败也不新增
    assert.strictEqual((await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 500 })).status, 200);
    assert.strictEqual((await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 500 })).status, 409);
    assert.strictEqual((await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 700 })).status, 409); // 无新增件
    list = await call('GET', `/api/jobs/${jobId}/cut-batches`);
    assert.strictEqual(list.data.batches.length, 1);
    assert.strictEqual(list.data.batches[0].cutLine, 500);
  })
);

test('API：同卷并发确认不产生重复或倒序交接单', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: 'A', width: 1000, length: 6000 }],
      pieces: [{ name: '块', vertices: rect(0, 0, 500, 500), quantity: 3 }],
    });
    const jobId = cr.data.job.id;
    const A = cr.data.rolls[0].id;
    await call('POST', `/api/jobs/${jobId}/optimize`);

    // 1) 两个完全相同的切线并发：恰一个成功，只产生一张交接单
    const [r1, r2] = await Promise.all([
      call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 500 }),
      call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 500 }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepStrictEqual(statuses, [200, 409], `并发相同切线应恰一个成功：${statuses}`);
    let list = await call('GET', `/api/jobs/${jobId}/cut-batches`);
    assert.strictEqual(list.data.batches.length, 1, '不得产生重复交接单');
    assert.strictEqual(list.data.batches[0].seq, 1);
    assert.strictEqual(list.data.batches[0].cutLine, 500);

    // 2) 两个不同切线并发：无论到达顺序，单号与切线区间链式衔接、不倒序
    const [r3, r4] = await Promise.all([
      call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 1500 }),
      call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 1000 }),
    ]);
    assert([r3.status, r4.status].includes(200));
    list = await call('GET', `/api/jobs/${jobId}/cut-batches`);
    const arr = list.data.batches;
    let prev = 0;
    arr.forEach((b, i) => {
      assert.strictEqual(b.seq, i + 1, '单号连续无重复');
      assert.strictEqual(b.previousCutLine, prev, '切线区间链式衔接（不倒序）');
      assert(b.cutLine > b.previousCutLine, '切线严格前进');
      prev = b.cutLine;
    });
    const st = await call('GET', `/api/jobs/${jobId}`);
    assert.strictEqual(st.data.rolls[0].cutLine, prev, '卷切线等于最后一单');
    // 交接单覆盖的裁片与已裁件一致（无遗漏、无重复）
    const batchedIds = arr.flatMap((b) => b.pieces.map((p) => p.placementId));
    assert.strictEqual(new Set(batchedIds).size, batchedIds.length, '裁片不得重复出现在多张交接单');
    const cutIds = st.data.placements.filter((p) => p.cut).map((p) => p.id);
    assert.deepStrictEqual(batchedIds.slice().sort((a, b) => a - b), cutIds.slice().sort((a, b) => a - b));
  })
);

test('API：纸样改版与重新排样不改写旧交接单；新交接单定格新版', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: 'A', width: 1000, length: 6000 }],
      pieces: [{ name: '块', vertices: rect(0, 0, 400, 400), quantity: 4, allowRotate: true }],
    });
    const jobId = cr.data.job.id;
    const tid = cr.data.pieceTypes[0].id;
    const A = cr.data.rolls[0].id;
    await call('POST', `/api/jobs/${jobId}/optimize`);
    // 切线 400 裁下 y0 两件 → 交接单 #1（第 1 版 400×400 快照）
    const cut1 = await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: 400 });
    assert.strictEqual(cut1.status, 200);
    const batchId1 = cut1.data.cut.batchId;

    // 改版 400→500 并重新优化
    const rv = await call('POST', `/api/jobs/${jobId}/piece-types/${tid}/revisions`, {
      vertices: rect(0, 0, 500, 500), quantity: 4, allowRotate: true,
    });
    assert.strictEqual(rv.status, 200);
    await call('POST', `/api/jobs/${jobId}/optimize`);

    // 旧交接单保持第 1 版快照：轮廓、版次、坐标、方向均不改写
    const one = await call('GET', `/api/jobs/${jobId}/cut-batches/${batchId1}`);
    assert.strictEqual(one.status, 200);
    for (const p of one.data.batch.pieces) {
      assert.strictEqual(p.revision, 1, '旧交接单版次不得被改写');
      assert.deepStrictEqual(p.vertices, rect(0, 0, 400, 400), '旧交接单轮廓不得被改写');
      assert.strictEqual(p.bw, 400);
      assert(p.y + 400 <= 400, '旧交接单坐标保持裁剪时位置');
    }
    assert.strictEqual(one.data.batch.cutLine, 400);

    // 把剩余两件排好后再次确认 → 新交接单定格第 2 版轮廓
    const op = await call('POST', `/api/jobs/${jobId}/optimize`);
    const uncut = op.data.placements.filter((p) => !p.cut && p.placed);
    assert(uncut.length >= 1, '应有未裁已排件');
    const line = Math.max(...uncut.map((p) => p.y + p.bh));
    const cut2 = await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: A, cutLine: line });
    assert.strictEqual(cut2.status, 200, JSON.stringify(cut2.data));
    assert.strictEqual(cut2.data.cut.batchSeq, 2);
    const two = await call('GET', `/api/jobs/${jobId}/cut-batches/${cut2.data.cut.batchId}`);
    assert(two.data.batch.pieces.every((p) => p.revision === 2 && p.bw === 500), '新交接单应定格第 2 版');
    // 旧单仍未被改写
    const again = await call('GET', `/api/jobs/${jobId}/cut-batches/${batchId1}`);
    assert(again.data.batch.pieces.every((p) => p.revision === 1 && p.bw === 400));
  })
);

test('API：升级前已裁件标识为无批次历史，不推造交接单', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: 'A', width: 1000, length: 4000 }],
      pieces: [{ name: '块', vertices: rect(0, 0, 500, 500), quantity: 3 }],
    });
    const jobId = cr.data.job.id;
    await call('POST', `/api/jobs/${jobId}/optimize`);
    // 模拟升级前数据：直接置已裁标记与切线，但没有任何交接单记录
    const db = require('../src/db');
    const st = await call('GET', `/api/jobs/${jobId}`);
    const placed = st.data.placements.filter((p) => p.placed);
    const legacyIds = placed.slice(0, 2).map((p) => p.id);
    for (const pid of legacyIds) db.prepare('UPDATE placements SET cut = 1 WHERE id = ?').run(pid);
    db.prepare('UPDATE rolls SET cut_line = 500 WHERE id = ?').run(st.data.rolls[0].id);

    const list = await call('GET', `/api/jobs/${jobId}/cut-batches`);
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.data.batches.length, 0, '不得为旧数据推造交接单');
    assert.strictEqual(list.data.legacyCutPieces.length, 2);
    assert.deepStrictEqual(
      list.data.legacyCutPieces.map((p) => p.placementId).sort((a, b) => a - b),
      legacyIds.slice().sort((a, b) => a - b)
    );
    for (const p of list.data.legacyCutPieces) {
      assert.strictEqual(p.batchHistory, false);
      assert.strictEqual(p.rollLabel, 'A');
      assert.strictEqual(p.revision, 1);
    }
    // 既有裁剪进度查询继续有效
    const cuts = await call('GET', `/api/jobs/${jobId}/cuts`);
    assert.strictEqual(cuts.data.cuts[0].cutCount, 2);
    // 后续正常确认仍生成真实交接单，且与无批次历史件区分
    const line = Math.max(...st.data.placements.filter((p) => p.placed).map((p) => p.y + p.bh));
    const cut = await call('POST', `/api/jobs/${jobId}/cuts`, { rollId: st.data.rolls[0].id, cutLine: line });
    assert.strictEqual(cut.status, 200, JSON.stringify(cut.data));
    const list2 = await call('GET', `/api/jobs/${jobId}/cut-batches`);
    assert.strictEqual(list2.data.batches.length, 1);
    assert.strictEqual(list2.data.batches[0].previousCutLine, 500, '新单前切线接当前进度');
    assert.strictEqual(list2.data.legacyCutPieces.length, 2, '无批次历史件保持标识');
  })
);

test('API：删除方案级联删除其交接单', () =>
  withServer(async (call) => {
    const cr = await call('POST', '/api/jobs', {
      rolls: [{ label: 'A', width: 1000, length: 4000 }],
      pieces: [{ name: '块', vertices: rect(0, 0, 500, 500), quantity: 1 }],
    });
    const jobId = cr.data.job.id;
    await call('POST', `/api/jobs/${jobId}/optimize`);
    assert.strictEqual((await call('POST', `/api/jobs/${jobId}/cuts`, { cutLine: 500 })).status, 200);
    const db = require('../src/db');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM cut_batches WHERE job_id = ?').get(jobId).n, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM cut_batch_items WHERE job_id = ?').get(jobId).n, 1);
    assert.strictEqual((await call('DELETE', `/api/jobs/${jobId}`)).status, 204);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM cut_batches WHERE job_id = ?').get(jobId).n, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM cut_batch_items WHERE job_id = ?').get(jobId).n, 0);
  })
);

runAll().then(() => {
  console.log(`\n${passed} 项测试${process.exitCode ? '，存在失败' : '全部通过'}。`);
});