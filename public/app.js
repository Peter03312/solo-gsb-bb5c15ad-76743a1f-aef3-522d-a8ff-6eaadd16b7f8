'use strict';

/* ================= 状态与工具 ================= */

const $ = (id) => document.getElementById(id);
const cv = $('cv');
const ctx = cv.getContext('2d');
const PAD = 36; // 画布留白 px

let state = null;          // 当前方案完整状态（GET /api/jobs/:id 返回）
let scale = 0.25;          // px / mm
let selectedId = null;     // 选中的 placement id
let currentRollId = null;  // 画布当前查看的卷 id
let drag = null;           // 拖拽状态
let rollCards = [];        // 新建表单：布卷卡片
let pieceRows = [];        // 新建表单：裁片卡片
let cutInputRollId = null; // 切线输入框当前对应的卷（切换卷时重置建议值）

const PALETTE = [
  '#f4a261', '#2a9d8f', '#e9c46a', '#8ab17d', '#577590',
  '#9d4edd', '#ef476f', '#118ab2', '#06d6a0', '#ffb703',
  '#6d597a', '#43aa8b',
];

function typeColor(pieceTypeId) {
  const idx = state ? state.pieceTypes.findIndex((t) => t.id === pieceTypeId) : 0;
  return PALETTE[((idx % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

/** 取某件裁片【实际使用版次】的纸样（已裁件可能定格在旧版，与型号当前版不同） */
function revisionOf(p) {
  const t = state.pieceTypes.find((tt) => tt.id === p.pieceTypeId);
  if (!t) return null;
  return (t.revisions || []).find((r) => r.id === p.pieceRevisionId) ||
    (t.revisions || []).find((r) => r.rev === p.revision) ||
    t; // 旧数据兜底
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.data = data;
    throw err;
  }
  return data;
}

function showMsg(text, isError) {
  const el = $('msg');
  el.textContent = text;
  el.className = isError ? 'error' : 'info';
  if (!text) el.className = '';
}

function showApiError(err, prefix) {
  let text = (prefix ? prefix + '：' : '') + err.message;
  if (err.data && Array.isArray(err.data.details) && err.data.details.length) {
    text += '\n' + err.data.details.map((d) => '· ' + d).join('\n');
  }
  if (err.data && Array.isArray(err.data.conflicts) && err.data.conflicts.length) {
    text += '\n冲突对象：' + err.data.conflicts.join('、');
  }
  showMsg(text, true);
}

/* ================= 方案列表 ================= */

async function refreshJobList(selectId) {
  const jobs = await api('GET', '/api/jobs');
  const sel = $('jobSelect');
  sel.innerHTML = '<option value="">（请选择方案）</option>';
  for (const j of jobs) {
    const opt = document.createElement('option');
    opt.value = j.id;
    opt.textContent = `#${j.id} ${j.name}（${j.rollCount || 1}卷，${j.pieceCount}件）`;
    sel.appendChild(opt);
  }
  if (selectId) sel.value = String(selectId);
}

async function openJob(id) {
  state = await api('GET', `/api/jobs/${id}`);
  selectedId = null;
  cutInputRollId = null;
  if (!state.rolls.some((r) => r.id === currentRollId)) {
    currentRollId = state.rolls.length ? state.rolls[0].id : null;
  }
  showMsg('', false);
  fitScale();
  renderAll();
}

function currentRoll() {
  return state ? state.rolls.find((r) => r.id === currentRollId) || state.rolls[0] : null;
}

function defectsOf(rollId) {
  const entry = state.defectsByRoll.find((d) => d.rollId === rollId);
  return entry ? entry.defects : [];
}

/* ================= 渲染 ================= */

function fitScale() {
  if (!state) return;
  const r = currentRoll();
  if (!r) return;
  const wrap = $('canvasWrap');
  const s = (wrap.clientWidth - PAD * 2 - 20) / r.width;
  scale = Math.min(s, 30000 / r.length, 4);
  scale = Math.max(scale, 0.005);
}

function renderAll() {
  renderToolbar();
  renderRollTabs();
  renderCutBar();
  renderCutPanel();
  renderUnplaced();
  renderSelPanel();
  renderRevPanel();
  setupCanvas();
  draw();
}

function renderToolbar() {
  const btn = $('btnOptimize');
  const badge = $('statusBadge');
  const used = $('usedLen');
  if (!state) {
    btn.disabled = true;
    badge.textContent = '未加载方案';
    badge.className = 'badge';
    used.textContent = '';
    return;
  }
  btn.disabled = false;
  const st = state.job.status;
  const nUn = state.unplaced.length;
  if (st === 'complete') {
    badge.textContent = '完整方案 ✓（全部裁片已排入）';
    badge.className = 'badge complete';
  } else if (st === 'partial') {
    badge.textContent = `部分方案（${nUn} 件未排入，非完成方案）`;
    badge.className = 'badge partial';
  } else {
    badge.textContent = '草稿（尚未优化）';
    badge.className = 'badge draft';
  }
  const nUsed = state.rolls.filter((r) => r.used).length;
  used.textContent = `启用 ${nUsed}/${state.rolls.length} 卷；总占用 ${state.job.usedLength} mm`;
}

function renderRollTabs() {
  const el = $('rollTabs');
  el.innerHTML = '';
  if (!state || state.rolls.length <= 1) return; // 单卷（含旧数据）不显示卷切换
  for (const r of state.rolls) {
    const tab = document.createElement('button');
    tab.className = 'rolltab' + (r.id === currentRollId ? ' active' : '');
    tab.innerHTML =
      `${r.seq}. ${r.label} <span class="dim">${r.width}×${r.length}mm</span>` +
      (r.cutLine > 0
        ? `<span class="ulen">✂切线 ${r.cutLine}mm · 已裁 ${r.cutCount} 件</span>`
        : r.used
          ? `<span class="ulen">占用 ${r.usedLength}mm</span>`
          : '<span class="idle">未启用</span>');
    tab.onclick = () => {
      currentRollId = r.id;
      fitScale();
      renderAll();
    };
    el.appendChild(tab);
  }
}

/* ================= 裁剪进度 ================= */

function renderCutBar() {
  const bar = $('cutBar');
  if (!state) { bar.className = ''; return; }
  bar.className = 'show';
  const r = currentRoll();
  if (!r) return;
  const info = $('cutInfo');
  if (r.cutLine > 0) {
    info.textContent = `卷「${r.label}」：切线 ${r.cutLine}/${r.length}mm，已裁 ${r.cutCount} 件，剩余 ${r.length - r.cutLine}mm`;
  } else {
    info.textContent = `卷「${r.label}」尚未裁剪（卷长 ${r.length}mm）`;
  }
  const input = $('cutLineInput');
  if (cutInputRollId !== r.id) {
    cutInputRollId = r.id;
    input.dataset.userEdit = '';
  }
  if (input.dataset.userEdit !== '1') {
    // 默认建议值：当前所有未裁已排件的末端（即“裁到本卷未裁占用末尾”）
    let suggest = 0;
    for (const p of state.placements) {
      if (p.placed && p.rollId === r.id && !p.cut) suggest = Math.max(suggest, p.y + p.bh);
    }
    if (suggest <= r.cutLine) suggest = Math.min(r.cutLine + 1, r.length);
    input.value = suggest;
    input.min = String(r.cutLine + 1);
    input.max = String(r.length);
  }
}

function renderCutPanel() {
  const el = $('cutPanel');
  if (!state) { el.className = ''; el.innerHTML = ''; return; }
  const cutRolls = (state.cuts || []).filter((c) => c.cutLine > 0);
  if (cutRolls.length === 0) {
    el.className = '';
    el.innerHTML = '';
    return;
  }
  el.className = 'show';
  el.innerHTML = '<b>✂ 已裁布段（不可回退）：</b>';
  for (const c of cutRolls) {
    const row = document.createElement('div');
    row.className = 'cut-roll';
    const pieces = c.cutPieces
      .map((p) => `<span class="cchip${p.id === selectedId ? ' sel' : ''}" data-pid="${p.id}" title="(x=${p.x}, y=${p.y}, ${p.rotation}°)">${p.name}#${p.seq}</span>`)
      .join('');
    row.innerHTML =
      `<b>卷「${c.label}」</b>：切线 <span class="cut-now">${c.cutLine}mm</span> / 卷长 ${c.length}mm，已裁 ${c.cutCount} 件：` +
      (pieces ? pieces : '<span class="cut-none">无</span>');
    el.appendChild(row);
  }
  el.querySelectorAll('.cchip').forEach((chip) => {
    chip.onclick = () => {
      selectedId = Number(chip.dataset.pid);
      renderAll();
    };
  });
}

function renderUnplaced() {
  const el = $('unplacedPanel');
  if (!state || state.unplaced.length === 0) {
    el.className = '';
    el.innerHTML = '';
    return;
  }
  el.className = 'show';
  el.innerHTML = `<b>未排入裁片（${state.unplaced.length} 件）：</b>`;
  for (const u of state.unplaced) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (u.id === selectedId ? ' sel' : '');
    const req = u.rollId ? state.rolls.find((r) => r.id === u.rollId) : null;
    chip.textContent = `${u.name}#${u.seq}${req ? '（必用:' + req.label + '）' : ''}`;
    chip.title = u.reason || '未排入';
    chip.onclick = () => {
      selectedId = u.id;
      renderAll();
    };
    el.appendChild(chip);
  }
  const tip = document.createElement('div');
  tip.className = 'hint';
  tip.textContent = '点击裁片可在左侧选目标卷并输入坐标手动排入，或调整卷/锁定件后重新优化。';
  el.appendChild(tip);
}

function findPlacement(id) {
  return state ? state.placements.find((p) => p.id === id) : null;
}

function rollSelectOptions(select, selectedId, includeAny) {
  select.innerHTML = '';
  if (includeAny) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '不限卷（自动选择）';
    select.appendChild(o);
  }
  for (const r of state.rolls) {
    const o = document.createElement('option');
    o.value = r.id;
    o.textContent = `${r.seq}. ${r.label}（${r.width}×${r.length}mm${r.used ? '，占用' + r.usedLength + 'mm' : ''}）`;
    select.appendChild(o);
  }
  select.value = selectedId == null ? '' : String(selectedId);
}

function renderSelPanel() {
  const panel = $('selPanel');
  const p = findPlacement(selectedId);
  if (!p) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  const roll = p.rollId ? state.rolls.find((r) => r.id === p.rollId) : null;
  const reqRoll = p.requiredRollId ? state.rolls.find((r) => r.id === p.requiredRollId) : null;
  const t = state.pieceTypes.find((tt) => tt.id === p.pieceTypeId);
  const rev = revisionOf(p);
  $('selInfo').innerHTML =
    `<b>${p.name}#${p.seq}</b>　外接 ${p.bw}×${p.bh}mm（纸样第${p.revision}版${p.revision !== t.currentRev ? '，型号当前为第' + t.currentRev + '版' : ''}）　` +
    (p.placed
      ? `卷「${roll.label}」卷内 (${p.x}, ${p.y}) ${p.rotation}°`
      : '<span style="color:#ef6c00">未排入</span>' + (p.reason ? `（${p.reason}）` : '')) +
    (p.cut ? '　<span style="color:#6a1b9a;font-weight:600">✂已裁（不可再改）</span>' : '') +
    (!p.cut && p.locked ? '　🔒已锁定' : '') +
    (reqRoll ? `　必用卷：${reqRoll.label}` : '');
  // 目标卷（默认当前所在卷；未排件默认必用卷或当前查看卷）
  const targetRollId = p.rollId || p.requiredRollId || currentRollId;
  rollSelectOptions($('selRoll'), targetRollId, false);
  $('selX').value = p.placed ? p.x : 0;
  $('selY').value = p.placed ? p.y : 0;
  $('selRot').value = String(p.rotation);
  $('selRot').querySelector('option[value="180"]').disabled = !p.allowRotate;
  // 必用卷选择器
  rollSelectOptions($('selReqRoll'), p.requiredRollId, true);
  $('selLocked').checked = p.locked;
  $('selLocked').disabled = !p.placed || p.cut;
  // 已裁件：卷号/位置/方向/必用卷均不可再改
  ['selRoll', 'selX', 'selY', 'selRot', 'selReqRoll', 'btnApplyMove', 'btnUnplace'].forEach((id) => {
    $(id).disabled = !!p.cut;
  });
}

/* ================= 改版纸样 ================= */

function renderRevPanel() {
  const panel = $('revPanel');
  if (!state) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const sel = $('revType');
  const keep = sel.value;
  sel.innerHTML = '';
  for (const t of state.pieceTypes) {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = `${t.name}（当前第${t.currentRev}版，${t.quantity}件，${t.bw}×${t.bh}mm）`;
    sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  renderRevInfo();
}

function currentRevType() {
  return state.pieceTypes.find((t) => t.id === Number($('revType').value));
}

function renderRevInfo() {
  const t = currentRevType();
  if (!t) { $('revInfo').textContent = ''; return; }
  const ps = state.placements.filter((p) => p.pieceTypeId === t.id);
  const cut = ps.filter((p) => p.cut).length;
  const locked = ps.filter((p) => !p.cut && p.locked).length;
  const placed = ps.filter((p) => !p.cut && p.placed).length;
  const pool = ps.filter((p) => !p.cut && !p.placed).length;
  const revs = [...new Set(ps.map((p) => p.revision))].sort((a, b) => a - b);
  $('revInfo').innerHTML =
    `共 ${ps.length} 件：已裁 ${cut}（保留旧版）、锁定 ${locked}、已排 ${placed}、未排 ${pool}。` +
    `现存件版次：${revs.join('、') || '-'}。目标件数少于 ${cut + locked} 件会被拒绝。`;
}

$('revType').onchange = () => renderRevInfo();

$('btnLoadCurrent').onclick = () => {
  const t = currentRevType();
  if (!t) return;
  $('revVerts').value = t.vertices.map(([x, y]) => `${x},${y}`).join('\n');
  $('revQty').value = t.quantity;
  $('revRotate').checked = t.allowRotate;
};

$('btnRevise').onclick = async () => {
  if (!state) return;
  const t = currentRevType();
  if (!t) return;
  let vertices;
  try {
    vertices = parseVertices($('revVerts').value);
  } catch (err) {
    showMsg('新轮廓顶点解析失败：' + err.message, true);
    return;
  }
  const quantity = Number($('revQty').value);
  if (!window.confirm(
    `确认对型号「${t.name}」提交改版纸样？\n` +
    `目标总件数 ${quantity}；已裁件与裁剪清单不变，锁定件须在原位满足新轮廓，否则整次拒绝。`
  )) return;
  try {
    const resp = await api('POST', `/api/jobs/${state.job.id}/piece-types/${t.id}/revisions`, {
      vertices,
      quantity,
      allowRotate: $('revRotate').checked,
    });
    const rv = resp.revision;
    state = resp;
    delete state.revision;
    showMsg(
      `「${rv.name}」已更新到第 ${rv.revision} 版：删除 ${rv.deletedPieceIds.length} 件、` +
      `新增 ${rv.addedCount} 件（未排区）、${rv.bouncedPieceIds.length} 件原位失效退回未排区、` +
      `${rv.cutPieceIdsKept.length} 件已裁件保留旧轮廓。`,
      rv.bouncedPieceIds.length > 0
    );
    renderAll();
  } catch (err) {
    showApiError(err, '改版被拒绝，原方案不变');
  }
};

/* ================= 画布 ================= */
function setupCanvas() {
  if (!state) {
    cv.width = 10;
    cv.height = 10;
    return;
  }
  const r = currentRoll();
  const cssW = r.width * scale + PAD * 2;
  const cssH = r.length * scale + PAD * 2;
  const dpr = window.devicePixelRatio || 1;
  cv.style.width = cssW + 'px';
  cv.style.height = cssH + 'px';
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function mmX(x) { return PAD + x * scale; }
function mmY(y) { return PAD + y * scale; }

function draw() {
  if (!state) return;
  const r = currentRoll();
  const W = r.width;
  const L = r.length;
  const cssW = W * scale + PAD * 2;
  const cssH = L * scale + PAD * 2;
  ctx.clearRect(0, 0, cssW, cssH);

  // 布幅底
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(mmX(0), mmY(0), W * scale, L * scale);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(mmX(0), mmY(0), W * scale, L * scale);

  // 卷名标注
  ctx.fillStyle = '#777';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`卷 ${r.seq}：${r.label}（${W}×${L}mm）`, mmX(0), mmY(0) - 10);

  // 网格与标尺
  const step = scale * 100 >= 8 ? 100 : scale * 500 >= 8 ? 500 : 1000;
  ctx.strokeStyle = '#eee';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = step; x < W; x += step) { ctx.moveTo(mmX(x), mmY(0)); ctx.lineTo(mmX(x), mmY(L)); }
  for (let y = step; y < L; y += step) { ctx.moveTo(mmX(0), mmY(y)); ctx.lineTo(mmX(W), mmY(y)); }
  ctx.stroke();
  if (scale * 500 >= 24) {
    ctx.fillStyle = '#999';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    for (let y = 0; y <= L; y += 500) ctx.fillText(String(y), mmX(0) - 4, mmY(y) + 3);
    ctx.textAlign = 'left';
    for (let x = 0; x <= W; x += 500) ctx.fillText(String(x), mmX(x) + 2, mmY(0) - 4);
  }

  // 已裁段阴影（[0,cutLine) 全幅），最先绘制以衬托瑕疵与裁片
  if (r.cutLine > 0) {
    ctx.fillStyle = 'rgba(142,36,170,0.14)';
    ctx.fillRect(mmX(0), mmY(0), W * scale, r.cutLine * scale);
    ctx.strokeStyle = 'rgba(106,27,154,0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    const cutStep = 200;
    for (let x = cutStep; x < W; x += cutStep) {
      ctx.beginPath();
      ctx.moveTo(mmX(x), mmY(0));
      ctx.lineTo(mmX(x), mmY(Math.min(r.cutLine, L)));
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // 当前卷瑕疵区
  for (const d of defectsOf(r.id)) {
    ctx.fillStyle = 'rgba(229,57,53,0.30)';
    ctx.fillRect(mmX(d.x), mmY(d.y), d.w * scale, d.h * scale);
    ctx.strokeStyle = '#c62828';
    ctx.lineWidth = 1;
    ctx.strokeRect(mmX(d.x), mmY(d.y), d.w * scale, d.h * scale);
    if (d.w * scale > 34 && d.h * scale > 12) {
      ctx.fillStyle = '#b71c1c';
      ctx.font = '10px sans-serif';
      ctx.fillText('瑕疵', mmX(d.x) + 3, mmY(d.y) + 11);
    }
  }

  // 当前卷裁片
  for (const p of state.placements) {
    if (!p.placed || p.rollId !== r.id) continue;
    const isDrag = drag && drag.pid === p.id && drag.moved;
    const px = isDrag ? drag.curX : p.x;
    const py = isDrag ? drag.curY : p.y;
    const t = revisionOf(p);
    const vs = t.vertices.map(([x, y]) =>
      p.rotation === 180 ? [px + t.bw - x, py + t.bh - y] : [px + x, py + y]
    );
    ctx.beginPath();
    vs.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(mmX(x), mmY(y)) : ctx.lineTo(mmX(x), mmY(y))));
    ctx.closePath();
    ctx.fillStyle = typeColor(p.pieceTypeId) + (isDrag ? '99' : p.cut ? '99' : 'cc');
    ctx.fill();
    ctx.lineWidth = p.id === selectedId ? 2.5 : 1;
    ctx.strokeStyle = p.id === selectedId ? '#0d47a1' : p.cut ? '#6a1b9a' : '#444';
    if (isDrag) ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    const cx = vs.reduce((s, v) => s + v[0], 0) / vs.length;
    const cy = vs.reduce((s, v) => s + v[1], 0) / vs.length;
    if (p.bw * scale > 44 && p.bh * scale > 13) {
      ctx.fillStyle = '#1a1a1a';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${p.name}#${p.seq}${p.rotation === 180 ? ' ⟲180°' : ''}${p.cut ? ' ✂' : ''}${p.revision !== state.pieceTypes.find((tt) => tt.id === p.pieceTypeId).currentRev ? ' v' + p.revision : ''}`, mmX(cx), mmY(cy) + 4);
      ctx.textAlign = 'left';
    }
    if (p.locked && !p.cut) {
      ctx.font = '11px sans-serif';
      ctx.fillText('🔒', mmX(cx) - 6, mmY(cy) - 6);
    }
  }

  // 当前卷裁切线（不可回退）：紫色实线 + ✂ 标注
  if (r.cutLine > 0) {
    ctx.strokeStyle = '#6a1b9a';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(mmX(0), mmY(r.cutLine));
    ctx.lineTo(mmX(W), mmY(r.cutLine));
    ctx.stroke();
    ctx.fillStyle = '#6a1b9a';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(`✂ 切线 ${r.cutLine}mm（前已裁）`, mmX(4), mmY(r.cutLine) + 15);
  }

  // 当前卷实际占用长度线
  if (r.usedLength > 0) {
    ctx.strokeStyle = '#2e7d32';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 4]);
    ctx.beginPath();
    ctx.moveTo(mmX(0), mmY(r.usedLength));
    ctx.lineTo(mmX(W), mmY(r.usedLength));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#2e7d32';
    ctx.font = '11px sans-serif';
    ctx.fillText(`本卷占用 ${r.usedLength}mm`, mmX(4), mmY(r.usedLength) - 4);
  }
}

/* ================= 画布交互（卷内拖拽） ================= */

function toMm(e) {
  const r = cv.getBoundingClientRect();
  return [(e.clientX - r.left - PAD) / scale, (e.clientY - r.top - PAD) / scale];
}

function pointInPoly(px, py, vs) {
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const [xi, yi] = vs[i];
    const [xj, yj] = vs[j];
    if (yi > py !== yj > py && px < xi + ((py - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
  }
  return inside;
}

function absVertsOf(p) {
  const t = revisionOf(p);
  return t.vertices.map(([x, y]) =>
    p.rotation === 180 ? [p.x + t.bw - x, p.y + t.bh - y] : [p.x + x, p.y + y]
  );
}

cv.addEventListener('mousedown', (e) => {
  if (!state || e.button !== 0) return;
  const r = currentRoll();
  const [mx, my] = toMm(e);
  const placed = state.placements.filter((p) => p.placed && p.rollId === r.id);
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i];
    const t = revisionOf(p);
    if (mx < p.x || mx > p.x + t.bw || my < p.y || my > p.y + t.bh) continue;
    if (!pointInPoly(mx, my, absVertsOf(p))) continue;
    selectedId = p.id;
    if (p.cut) {
      // 已裁件：可选中查看，但不可拖拽
      renderSelPanel();
      draw();
      return;
    }
    drag = {
      pid: p.id,
      locked: p.locked,
      startX: e.clientX,
      startY: e.clientY,
      grabDX: mx - p.x,
      grabDY: my - p.y,
      curX: p.x,
      curY: p.y,
      moved: false,
    };
    renderSelPanel();
    draw();
    return;
  }
  selectedId = null;
  renderSelPanel();
  draw();
});

window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 3) return;
  if (drag.locked) return;
  drag.moved = true;
  const [mx, my] = toMm(e);
  drag.curX = Math.round(mx - drag.grabDX);
  drag.curY = Math.round(my - drag.grabDY);
  draw();
});

window.addEventListener('mouseup', async () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (!d.moved) { draw(); return; }
  if (d.locked) {
    showMsg('该裁片已锁定，请先在左侧面板解锁再移动。', true);
    draw();
    return;
  }
  const p = findPlacement(d.pid);
  try {
    state = await api('POST', `/api/jobs/${state.job.id}/placements/${d.pid}/move`, {
      rollId: p.rollId, // 拖拽为卷内移动；跨卷请在左侧面板选目标卷
      x: d.curX, y: d.curY, rotation: p.rotation,
    });
    showMsg('移动成功。', false);
    renderAll();
  } catch (err) {
    showApiError(err, '移动被拒绝，已保留原方案');
    renderAll();
  }
});

/* ================= 工具栏与面板事件 ================= */

$('btnOptimize').onclick = async () => {
  if (!state) return;
  showMsg('正在优化排样……', false);
  try {
    state = await api('POST', `/api/jobs/${state.job.id}/optimize`);
    const n = state.unplaced.length;
    const nUsed = state.rolls.filter((r) => r.used).length;
    showMsg(
      n === 0
        ? `优化完成：全部裁片已排入，启用 ${nUsed}/${state.rolls.length} 卷，总占用长度 ${state.job.usedLength}mm。`
        : `优化结束：${n} 件无法排入（见下方列表），当前为部分方案，启用 ${nUsed} 卷，总占用 ${state.job.usedLength}mm。`,
      n !== 0
    );
    renderAll();
  } catch (err) {
    showApiError(err, '优化失败');
    renderAll();
  }
};

$('btnZoomIn').onclick = () => {
  const r = currentRoll();
  scale = Math.min(scale * 1.25, 4, r ? 30000 / r.length : 1);
  setupCanvas(); draw();
};
$('btnZoomOut').onclick = () => { scale = Math.max(scale / 1.25, 0.005); setupCanvas(); draw(); };

$('cutLineInput').addEventListener('input', () => {
  $('cutLineInput').dataset.userEdit = '1';
});

$('btnConfirmCut').onclick = async () => {
  if (!state) return;
  const r = currentRoll();
  if (!r) return;
  const line = Number($('cutLineInput').value);
  if (!Number.isInteger(line)) {
    showMsg('切线必须为整数毫米。', true);
    return;
  }
  if (!window.confirm(
    `确认在卷「${r.label}」的 ${line}mm 处裁剪？\n` +
    `裁剪不可回退：切线之前已排的未裁件将全部标记为已裁，此后其卷号、位置、方向与必用卷均不可修改。`
  )) return;
  try {
    const resp = await api('POST', `/api/jobs/${state.job.id}/cuts`, { rollId: r.id, cutLine: line });
    const n = resp.cut ? resp.cut.newCutCount : 0;
    state = resp;
    delete state.cut;
    showMsg(`已确认卷「${r.label}」切线 ${line}mm：本次新增 ${n} 件已裁，后续优化只会重排切线之后的未裁件。`, false);
    $('cutLineInput').dataset.userEdit = '';
    cutInputRollId = null;
    renderAll();
  } catch (err) {
    showApiError(err, '裁剪确认被拒绝，原方案不变');
    renderAll();
  }
};

$('btnApplyMove').onclick = async () => {
  const p = findPlacement(selectedId);
  if (!p) return;
  try {
    state = await api('POST', `/api/jobs/${state.job.id}/placements/${p.id}/move`, {
      rollId: Number($('selRoll').value),
      x: Number($('selX').value),
      y: Number($('selY').value),
      rotation: Number($('selRot').value),
    });
    showMsg('位置已应用。', false);
    renderAll();
  } catch (err) {
    showApiError(err, '操作被拒绝，已保留原方案');
    renderAll();
  }
};

$('selReqRoll').onchange = async () => {
  const p = findPlacement(selectedId);
  if (!p) return;
  const v = $('selReqRoll').value;
  try {
    state = await api('POST', `/api/jobs/${state.job.id}/placements/${p.id}/require-roll`, {
      rollId: v === '' ? null : Number(v),
    });
    showMsg(v === '' ? '已取消必用卷约束。' : '必用卷已设置（重新优化后生效）。', false);
    renderAll();
  } catch (err) {
    showApiError(err, '必用卷设置被拒绝');
    renderAll();
  }
};

$('selLocked').onchange = async () => {
  const p = findPlacement(selectedId);
  if (!p) return;
  try {
    state = await api('POST', `/api/jobs/${state.job.id}/placements/${p.id}/lock`, {
      locked: $('selLocked').checked,
    });
    showMsg($('selLocked').checked ? '已锁定（优化时保持固定）。' : '已解锁。', false);
    renderAll();
  } catch (err) {
    showApiError(err, '锁定操作失败');
    renderAll();
  }
};

$('btnUnplace').onclick = async () => {
  const p = findPlacement(selectedId);
  if (!p || !p.placed) return;
  try {
    state = await api('POST', `/api/jobs/${state.job.id}/placements/${p.id}/unplace`);
    showMsg(`裁片「${p.name}#${p.seq}」已移回未排区。`, false);
    renderAll();
  } catch (err) {
    showApiError(err, '操作失败');
    renderAll();
  }
};

$('jobSelect').onchange = () => {
  const id = $('jobSelect').value;
  if (id) openJob(id).catch((err) => showApiError(err, '打开方案失败'));
};

$('btnDeleteJob').onclick = async () => {
  const id = $('jobSelect').value;
  if (!id) return;
  if (!window.confirm('确定删除该方案？此操作不可恢复。')) return;
  await api('DELETE', `/api/jobs/${id}`);
  state = null;
  selectedId = null;
  currentRollId = null;
  await refreshJobList();
  renderAll();
  setupCanvas();
  showMsg('方案已删除。', false);
};

/* ================= 新建方案表单 ================= */

function refreshPieceRollOptions() {
  for (const card of pieceRows) {
    const sel = card.reqSel;
    const cur = sel.value;
    sel.innerHTML = '<option value="">不限卷</option>';
    rollCards.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = String(i + 1);
      o.textContent = `${i + 1}. ${c.labelInput.value || '卷' + (i + 1)}`;
      sel.appendChild(o);
    });
    sel.value = cur;
  }
}

function addDefectRow(container, d) {
  const row = document.createElement('div');
  row.className = 'defect-row';
  row.innerHTML =
    '<span class="lbl">x</span><input type="number" step="1">' +
    '<span class="lbl">y</span><input type="number" step="1">' +
    '<span class="lbl">宽</span><input type="number" step="1">' +
    '<span class="lbl">高</span><input type="number" step="1">' +
    '<button class="mini">删</button>';
  const inputs = row.querySelectorAll('input');
  const data = d || { x: 0, y: 0, w: 100, h: 100 };
  inputs[0].value = data.x; inputs[1].value = data.y;
  inputs[2].value = data.w; inputs[3].value = data.h;
  row.querySelector('button').onclick = () => row.remove();
  container.appendChild(row);
  return { el: row, inputs };
}

function addRollCard(roll) {
  const card = document.createElement('div');
  card.className = 'roll-card';
  card.innerHTML =
    '<div class="roll-head">' +
    '<input type="text" class="roll-label" placeholder="卷号，如：A卷">' +
    '<button class="mini btn-del-roll">删卷</button>' +
    '</div>' +
    '<div class="roll-dims">' +
    '<label>宽 <input type="number" class="roll-w" min="1" step="1"></label>' +
    '<label>长 <input type="number" class="roll-l" min="1" step="1"></label>' +
    '<button class="mini btn-add-defect">＋瑕疵</button>' +
    '</div>' +
    '<div class="roll-defects"></div>';
  $('rollList').appendChild(card);
  const rec = {
    el: card,
    labelInput: card.querySelector('.roll-label'),
    wInput: card.querySelector('.roll-w'),
    lInput: card.querySelector('.roll-l'),
    defectBox: card.querySelector('.roll-defects'),
    defectRows: [],
  };
  const addDefect = (d) => rec.defectRows.push(addDefectRow(rec.defectBox, d));
  card.querySelector('.btn-add-defect').onclick = () => addDefect();
  if (roll) {
    rec.labelInput.value = roll.label || '';
    rec.wInput.value = roll.width;
    rec.lInput.value = roll.length;
    (roll.defects || []).forEach(addDefect);
  } else {
    rec.wInput.value = 1600;
    rec.lInput.value = 5000;
    addDefect();
  }
  card.querySelector('.btn-del-roll').onclick = () => {
    const idx = rollCards.indexOf(rec);
    rollCards.splice(idx, 1);
    card.remove();
    // 删除中间卷会改变序号映射：>idx 的必用选择前移一位，等于 idx 的回到“不限卷”
    for (const pc of pieceRows) {
      const v = pc.reqSel.value;
      refreshPieceRollOptions();
      if (v === String(idx + 1)) pc.reqSel.value = '';
      else if (v !== '' && Number(v) > idx + 1) pc.reqSel.value = String(Number(v) - 1);
    }
    refreshPieceRollOptions();
  };
  rec.labelInput.addEventListener('input', refreshPieceRollOptions);
  rollCards.push(rec);
  refreshPieceRollOptions();
  return rec;
}

function addPieceCard(p) {
  const card = document.createElement('div');
  card.className = 'piece-card';
  card.innerHTML =
    '<input type="text" placeholder="裁片名称，如：前片">' +
    '<textarea placeholder="顶点坐标，每行一个：x,y（整数mm）&#10;0,0&#10;600,0&#10;600,900&#10;0,900"></textarea>' +
    '<div class="sub">' +
    '<label>件数 <input type="number" min="1" step="1" value="1"></label>' +
    '<label><input type="checkbox"> 允许旋转180°</label>' +
    '<button class="mini">删</button>' +
    '</div>' +
    '<label class="reqrow">必用卷 <select class="reqroll"><option value="">不限卷</option></select></label>';
  const nameInput = card.querySelector('input[type=text]');
  const ta = card.querySelector('textarea');
  const qty = card.querySelector('input[type=number]');
  const rot = card.querySelector('input[type=checkbox]');
  const reqSel = card.querySelector('select.reqroll');
  if (p) {
    nameInput.value = p.name;
    ta.value = p.verts;
    qty.value = p.qty;
    rot.checked = p.rot;
  }
  card.querySelector('button').onclick = () => {
    pieceRows = pieceRows.filter((r) => r.el !== card);
    card.remove();
  };
  $('pieceList').appendChild(card);
  pieceRows.push({ el: card, nameInput, ta, qty, rot, reqSel });
  refreshPieceRollOptions();
  if (p && p.requiredRoll) reqSel.value = String(p.requiredRoll);
}

function parseVertices(text) {
  const pts = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    const parts = s.split(/[,\s，、]+/).filter(Boolean);
    if (parts.length !== 2) throw new Error(`顶点第 ${i + 1} 行格式错误：${s}`);
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new Error(`顶点第 ${i + 1} 行坐标必须为整数：${s}`);
    }
    pts.push([x, y]);
  }
  return pts;
}

$('btnAddRoll').onclick = () => addRollCard();
$('btnAddPiece').onclick = () => addPieceCard();

$('btnSample').onclick = () => {
  $('fName').value = '示例多卷方案';
  rollCards.forEach((c) => c.el.remove()); rollCards = [];
  pieceRows.forEach((r) => r.el.remove()); pieceRows = [];
  addRollCard({ label: 'A卷', width: 1600, length: 5000, defects: [{ x: 1150, y: 300, w: 200, h: 250 }] });
  addRollCard({ label: 'B卷', width: 1500, length: 4000, defects: [] });
  addPieceCard({ name: '前片', verts: '0,0\n620,0\n620,950\n0,950', qty: 2, rot: true });
  addPieceCard({ name: '袖片', verts: '0,0\n360,0\n360,560\n180,460\n0,560', qty: 2, rot: true, requiredRoll: 2 });
  addPieceCard({ name: '领片', verts: '0,0\n320,0\n160,130', qty: 3, rot: false });
};

$('btnCreate').onclick = async () => {
  if (rollCards.length === 0) {
    showMsg('请至少登记一卷布（点「＋添加卷」）。', true);
    return;
  }
  let pieces;
  try {
    pieces = pieceRows.map((r, i) => ({
      name: r.nameInput.value.trim() || `裁片${i + 1}`,
      vertices: parseVertices(r.ta.value),
      quantity: Number(r.qty.value),
      allowRotate: r.rot.checked,
      requiredRoll: r.reqSel.value === '' ? undefined : Number(r.reqSel.value),
    }));
  } catch (err) {
    showMsg('裁片顶点解析失败：' + err.message, true);
    return;
  }
  const body = {
    name: $('fName').value.trim(),
    rolls: rollCards.map((c, i) => ({
      label: c.labelInput.value.trim() || `卷${i + 1}`,
      width: Number(c.wInput.value),
      length: Number(c.lInput.value),
      defects: c.defectRows.map((r) => ({
        x: Number(r.inputs[0].value), y: Number(r.inputs[1].value),
        w: Number(r.inputs[2].value), h: Number(r.inputs[3].value),
      })),
    })),
    pieces,
  };
  try {
    state = await api('POST', '/api/jobs', body);
    selectedId = null;
    currentRollId = state.rolls[0].id;
    await refreshJobList(state.job.id);
    fitScale();
    renderAll();
    showMsg(`方案 #${state.job.id} 创建成功（${state.rolls.length} 卷），请点击「优化排样」。`, false);
  } catch (err) {
    showApiError(err, '创建失败');
  }
};

/* ================= 启动 ================= */

(async function init() {
  addRollCard();
  addPieceCard();
  await refreshJobList();
})();
