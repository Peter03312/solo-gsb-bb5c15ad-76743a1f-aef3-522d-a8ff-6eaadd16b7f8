'use strict';

const geom = require('./geom');

/** 规模限制（小型工作室量级，同时约束栅格内存与计算时间） */
const LIMITS = {
  maxWidth: 5000,          // 单卷布幅最大 5m
  maxLength: 100000,       // 单卷可用长度最大 100m
  maxAreaCells: 150000000, // 单卷栅格上限（约 150MB）
  maxRolls: 50,            // 每方案最多 50 卷
  maxDefectsPerRoll: 100,
  maxDefectsTotal: 500,
  maxPieceTypes: 200,
  maxQuantityPerType: 200,
  maxTotalPieces: 1000,
};

function isInt(v) {
  return Number.isInteger(v);
}

/** 校验一卷：返回错误数组，并在 roll 字段上回填归一化数据 */
function validateRoll(raw, index, errors, totalDefectCount) {
  const label =
    typeof raw.label === 'string' && raw.label.trim()
      ? raw.label.trim().slice(0, 50)
      : `卷${index + 1}`;
  const tag = `${label}（第${index + 1}卷）`;
  const W = raw.width;
  const L = raw.length;
  let ok = true;
  if (!isInt(W) || W < 1 || W > LIMITS.maxWidth) {
    errors.push(`${tag}：布幅宽度必须为 1~${LIMITS.maxWidth} 的整数毫米`);
    ok = false;
  }
  if (!isInt(L) || L < 1 || L > LIMITS.maxLength) {
    errors.push(`${tag}：可用长度必须为 1~${LIMITS.maxLength} 的整数毫米`);
    ok = false;
  }
  if (ok && W * L > LIMITS.maxAreaCells) {
    errors.push(`${tag}：面积 ${W}×${L}mm 超出系统上限（${LIMITS.maxAreaCells} 平方毫米）`);
    ok = false;
  }

  const defects = [];
  const rawDefects = Array.isArray(raw.defects) ? raw.defects : [];
  if (rawDefects.length > LIMITS.maxDefectsPerRoll) {
    errors.push(`${tag}：瑕疵区数量过多（每卷最多 ${LIMITS.maxDefectsPerRoll} 个）`);
  }
  if (totalDefectCount + rawDefects.length > LIMITS.maxDefectsTotal) {
    errors.push(`方案瑕疵区总数过多（最多 ${LIMITS.maxDefectsTotal} 个）`);
  }
  rawDefects.slice(0, LIMITS.maxDefectsPerRoll).forEach((d, i) => {
    const dtag = `${tag} 瑕疵区#${i + 1}`;
    if (!d || !isInt(d.x) || !isInt(d.y) || !isInt(d.w) || !isInt(d.h)) {
      errors.push(`${dtag}：坐标与尺寸必须为整数毫米`);
      return;
    }
    if (d.w < 1 || d.h < 1) {
      errors.push(`${dtag}：宽度与高度必须 ≥ 1mm`);
      return;
    }
    if (ok && (d.x < 0 || d.y < 0 || d.x + d.w > W || d.y + d.h > L)) {
      errors.push(`${dtag}：矩形 (${d.x},${d.y},${d.w}×${d.h}) 超出该卷范围（${W}×${L}mm）`);
      return;
    }
    defects.push({ x: d.x, y: d.y, w: d.w, h: d.h });
  });

  return { label, width: W, length: L, defects };
}

/**
 * 校验创建方案的输入。返回 { errors: [string], value }。
 * 所有错误均指明出错对象；errors 非空时 value 为 null。
 *
 * 两种输入形式：
 *  - 多卷（新）：{ name, rolls: [{label?, width, length, defects?}] }
 *  - 单卷（旧，保持兼容）：{ name, fabricWidth, fabricLength, defects }
 * 裁片型号在两种形式下均为 pieces，可用 requiredRoll 指定必用卷：
 *  - 多卷：必用卷序号（1 起）或卷号文本；单卷：仅允许 1 / '默认卷' / null
 */
function validateJobInput(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return { errors: ['请求体为空或格式不正确'], value: null };
  }

  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : '未命名方案';

  // ---- 卷 ----
  let rolls;
  let multiRoll = false;
  if (body.rolls !== undefined && body.rolls !== null) {
    // 新多卷形式：rolls 必须为非空数组
    if (!Array.isArray(body.rolls) || body.rolls.length < 1) {
      errors.push(Array.isArray(body.rolls) ? '至少需要登记一卷布' : 'rolls 必须为数组');
      multiRoll = true; // 已显式提供 rolls，不再回退旧格式
      rolls = [];
    } else {
      multiRoll = true;
    }
  }
  if (multiRoll) {
    if (Array.isArray(body.rolls) && body.rolls.length > LIMITS.maxRolls) {
      errors.push(`卷数过多（最多 ${LIMITS.maxRolls} 卷）`);
    }
    rolls = [];
    const labels = new Set();
    let defectTotal = 0;
    const rollInputs = Array.isArray(body.rolls) ? body.rolls.slice(0, LIMITS.maxRolls) : [];
    rollInputs.forEach((r, i) => {
      const roll = validateRoll(r || {}, i, errors, defectTotal);
      if (labels.has(roll.label)) {
        errors.push(`卷号「${roll.label}」重复：同一方案内各卷卷号必须唯一`);
      }
      labels.add(roll.label);
      defectTotal += Array.isArray(r && r.defects) ? r.defects.length : 0;
      rolls.push(roll);
    });
  } else {
    // 旧单卷形式（fabricWidth/fabricLength）
    const fake = validateRoll(
      { label: '默认卷', width: body.fabricWidth, length: body.fabricLength, defects: body.defects },
      0,
      errors,
      0
    );
    rolls = [fake];
  }

  // ---- 裁片型号 ----
  const pieces = [];
  const rawPieces = Array.isArray(body.pieces) ? body.pieces : [];
  if (rawPieces.length < 1) errors.push('至少需要一种裁片');
  if (rawPieces.length > LIMITS.maxPieceTypes) {
    errors.push(`裁片型号过多（最多 ${LIMITS.maxPieceTypes} 种）`);
  }
  let totalPieces = 0;
  const resolveRequiredRoll = (pname, val, normW, normH) => {
    // 返回必用卷下标（0 起）；未指定返回 null；非法时记错误并返回 undefined
    if (val === undefined || val === null) return null;
    if (!multiRoll) {
      // 单卷形式：只接受 1
      if (val === 1 || val === '1' || val === '默认卷') return 0;
      errors.push(
        `裁片「${pname}」：必用卷「${val}」无效（单卷方案只有一卷“默认卷”，必用卷应为 1）`
      );
      return undefined;
    }
    let idx;
    if (isInt(val)) {
      idx = val - 1;
    } else if (typeof val === 'string' && val.trim()) {
      idx = rolls.findIndex((r) => r.label === val.trim());
      if (idx < 0) {
        errors.push(
          `裁片「${pname}」：必用卷卷号「${val.trim()}」不存在（已登记卷号：${rolls
            .map((r) => r.label)
            .join('、')}）`
        );
        return undefined;
      }
    } else {
      errors.push(`裁片「${pname}」：必用卷必须是卷序号（1 起）或已登记的卷号文本`);
      return undefined;
    }
    if (!isInt(idx) || idx < 0 || idx >= rolls.length) {
      errors.push(
        `裁片「${pname}」：必用卷序号 ${val} 无效（本方案共 ${rolls.length} 卷，序号 1~${rolls.length}）`
      );
      return undefined;
    }
    const r = rolls[idx];
    if (isInt(r.width) && normW > r.width) {
      errors.push(
        `裁片「${pname}」：外接宽度 ${normW}mm 超过必用卷「${r.label}」布幅 ${r.width}mm，必用卷约束不可能满足，请改卷或取消必用卷`
      );
      return undefined;
    }
    if (isInt(r.length) && normH > r.length) {
      errors.push(
        `裁片「${pname}」：外接长度 ${normH}mm 超过必用卷「${r.label}」可用长度 ${r.length}mm，必用卷约束不可能满足`
      );
      return undefined;
    }
    return idx;
  };

  rawPieces.slice(0, LIMITS.maxPieceTypes).forEach((p, i) => {
    const pname = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 50) : `裁片${i + 1}`;
    const tag = `裁片「${pname}」`;
    let bad = false;

    const err = geom.validatePolygon(p && p.vertices);
    if (err) {
      errors.push(`${tag}：${err}`);
      bad = true;
    }
    if (!p || !isInt(p.quantity) || p.quantity < 1 || p.quantity > LIMITS.maxQuantityPerType) {
      errors.push(`${tag}：件数必须为 1~${LIMITS.maxQuantityPerType} 的整数`);
      bad = true;
    }
    if (bad) return;

    const norm = geom.normalize(p.vertices);
    // 至少有一卷能容下；多卷逐卷检查（宽/长非法的卷跳过）
    const validRolls = rolls.filter((r) => isInt(r.width) && isInt(r.length));
    const fitsAny = validRolls.some((r) => norm.w <= r.width && norm.h <= r.length);
    if (validRolls.length > 0 && !fitsAny) {
      const widest = Math.max(...validRolls.map((r) => r.width));
      errors.push(
        `${tag}：外接尺寸 ${norm.w}×${norm.h}mm 超过所有卷的布幅/长度（最宽卷 ${widest}mm），永远无法排入`
      );
      return;
    }
    const reqIdx = resolveRequiredRoll(pname, p.requiredRoll, norm.w, norm.h);
    if (reqIdx === undefined) return;
    totalPieces += p.quantity;
    pieces.push({
      name: pname,
      vertices: norm.pts,
      quantity: p.quantity,
      allowRotate: p.allowRotate === true,
      bw: norm.w,
      bh: norm.h,
      requiredRollIndex: reqIdx, // null=不限
    });
  });
  if (totalPieces > LIMITS.maxTotalPieces) {
    errors.push(`裁片总件数 ${totalPieces} 超出上限（${LIMITS.maxTotalPieces} 件）`);
  }

  if (errors.length > 0) return { errors, value: null };
  return {
    errors,
    value: {
      name,
      multiRoll,
      rolls: rolls.map((r) => ({ label: r.label, width: r.width, length: r.length, defects: r.defects })),
      pieces,
    },
  };
}

/**
 * 校验改版纸样提交（按型号）。返回 { errors: [string], value }。
 * 只校验与现有方案状态无关的部分（轮廓合法性、件数正整数、布尔旋转）；
 * 卷能否容纳、必用卷可行性等依赖方案状态的检查在路由中完成。
 * body: { vertices, quantity, allowRotate? }
 */
function validateRevisionInput(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return { errors: ['请求体为空或格式不正确'], value: null };
  }
  let norm = null;
  const err = geom.validatePolygon(body.vertices);
  if (err) {
    errors.push(`新轮廓：${err}`);
  } else {
    norm = geom.normalize(body.vertices);
  }
  if (!isInt(body.quantity) || body.quantity < 1 || body.quantity > LIMITS.maxQuantityPerType) {
    errors.push(`目标总件数必须为 1~${LIMITS.maxQuantityPerType} 的正整数`);
  }
  if (errors.length > 0) return { errors, value: null };
  return {
    errors,
    value: {
      vertices: norm.pts,
      quantity: body.quantity,
      allowRotate: body.allowRotate === true,
      bw: norm.w,
      bh: norm.h,
    },
  };
}

module.exports = { validateJobInput, validateRevisionInput, LIMITS };
