'use strict';

/* 裁剪交接单打印页：
 *   batch.html?job=ID            打印该方案全部交接单（按卷与确认顺序）
 *   batch.html?job=ID&batch=BID  只打印指定一张
 *   追加 &auto=1 渲染完成后自动唤起打印。
 * 内容全部来自服务端快照（cut_batches/cut_batch_items），页面只读展示。
 */

const qs = new URLSearchParams(location.search);
const jobId = Number(qs.get('job'));
const batchId = qs.get('batch') ? Number(qs.get('batch')) : null;
const autoPrint = qs.get('auto') === '1';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function fetchJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

/** 画裁片轮廓缩略图（归一化顶点 + 方向；180° 在外接矩形内翻转） */
function drawThumb(canvas, piece) {
  const size = 64;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const verts = piece.vertices.map(([x, y]) =>
    piece.rotation === 180 ? [piece.bw - x, piece.bh - y] : [x, y]
  );
  const s = Math.min((size - 8) / Math.max(piece.bw, 1), (size - 8) / Math.max(piece.bh, 1));
  const ox = (size - piece.bw * s) / 2;
  const oy = (size - piece.bh * s) / 2;
  ctx.beginPath();
  verts.forEach(([x, y], i) => {
    const px = ox + x * s;
    const py = oy + y * s;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fillStyle = '#e3f2fd';
  ctx.fill();
  ctx.strokeStyle = '#1565c0';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function sheetHtml(job, b) {
  const rows = b.pieces
    .map(
      (p, i) =>
        `<tr>
          <td>${i + 1}</td>
          <td>${p.placementId}</td>
          <td>${esc(p.name)}#${p.seq}</td>
          <td>第${p.revision}版</td>
          <td class="shape"><canvas class="thumb" data-idx="${i}"></canvas></td>
          <td>${p.bw}×${p.bh}</td>
          <td>(${p.x}, ${p.y})</td>
          <td>${p.rotation}°</td>
        </tr>`
    )
    .join('');
  return `
  <div class="sheet">
    <h1>裁 剪 交 接 单</h1>
    <div class="sub">本单为切线确认时刻的不可改快照；此后纸样改版、重新排样不影响本单内容。</div>
    <div class="meta">
      <div><span class="k">交接单号</span><span class="v">#${b.id}（本卷第 ${b.seq} 单）</span></div>
      <div><span class="k">方案</span><span class="v">#${job.id} ${esc(job.name)}</span></div>
      <div><span class="k">卷号</span><span class="v">${esc(b.rollLabel)}（rollId=${b.rollId}）</span></div>
      <div><span class="k">切线区间</span><span class="v">${b.previousCutLine} → ${b.cutLine} mm（本段 ${b.cutLine - b.previousCutLine}mm）</span></div>
      <div><span class="k">确认时间</span><span class="v">${esc(b.createdAt)}</span></div>
      <div><span class="k">本次新裁件</span><span class="v">${b.pieceCount} 件</span></div>
    </div>
    <table>
      <thead>
        <tr><th>#</th><th>裁片ID</th><th>名称·件号</th><th>纸样版次</th><th>轮廓</th><th>外接(mm)</th><th>卷内坐标(x,y)</th><th>方向</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="sign">
      <div>裁剪经办：</div>
      <div>车间接收：</div>
      <div>日期：</div>
    </div>
    <div class="note">坐标单位为毫米（mm），原点在卷头左下角；方向 0°/180° 为相对纸样的旋转。裁片 ID 与件号对应系统内排样记录。</div>
  </div>`;
}

function legacyHtml(legacyCutPieces) {
  if (!legacyCutPieces || legacyCutPieces.length === 0) return '';
  const rows = legacyCutPieces
    .map(
      (p, i) =>
        `<tr><td>${i + 1}</td><td>${p.placementId}</td><td>${esc(p.name)}#${p.seq}</td>` +
        `<td>${esc(p.rollLabel || '')}</td><td>第${p.revision}版</td><td>(${p.x}, ${p.y})</td><td>${p.rotation}°</td></tr>`
    )
    .join('');
  return `
  <div class="legacy">
    <h2>无批次历史的已裁件（系统升级前已裁，缺少逐次切线边界，不推造交接单）</h2>
    <table>
      <thead><tr><th>#</th><th>裁片ID</th><th>名称·件号</th><th>卷号</th><th>纸样版次</th><th>卷内坐标(x,y)</th><th>方向</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

(async function init() {
  const root = document.getElementById('root');
  try {
    if (!Number.isInteger(jobId)) throw new Error('缺少方案参数：batch.html?job=方案ID[&batch=交接单号]');
    let job;
    let batches;
    let legacy = [];
    if (batchId != null) {
      const data = await fetchJson(`/api/jobs/${jobId}/cut-batches/${batchId}`);
      job = data.job;
      batches = [data.batch];
    } else {
      const data = await fetchJson(`/api/jobs/${jobId}/cut-batches`);
      job = data.job;
      batches = data.batches;
      legacy = data.legacyCutPieces || [];
    }
    if (batches.length === 0 && legacy.length === 0) {
      root.innerHTML = '<div class="sheet">该方案尚无裁剪交接单（确认切线后自动生成）。</div>';
      return;
    }
    root.innerHTML = batches.map((b) => sheetHtml(job, b)).join('') + legacyHtml(legacy);
    // 渲染轮廓缩略图
    const sheets = root.querySelectorAll('.sheet');
    sheets.forEach((sheetEl, si) => {
      const b = batches[si];
      if (!b) return;
      sheetEl.querySelectorAll('canvas.thumb').forEach((cv) => {
        drawThumb(cv, b.pieces[Number(cv.dataset.idx)]);
      });
    });
    document.title = batchId != null ? `裁剪交接单 #${batchId}` : `裁剪交接单（方案 #${jobId}）`;
    if (autoPrint) window.print();
  } catch (err) {
    root.innerHTML = `<div class="err">${esc(err.message)}</div>`;
  }
})();

document.getElementById('btnPrint').onclick = () => window.print();
