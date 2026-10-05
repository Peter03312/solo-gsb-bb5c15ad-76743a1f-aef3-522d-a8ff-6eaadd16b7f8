'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'nesting.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  fabric_width  INTEGER NOT NULL,   -- 兼容旧字段：等于首卷宽度（单卷方案即布幅宽度）
  fabric_length INTEGER NOT NULL,   -- 兼容旧字段：等于首卷长度（单卷方案即可用长度）
  status        TEXT NOT NULL DEFAULT 'draft',   -- draft | partial | complete
  used_length   INTEGER NOT NULL DEFAULT 0,      -- 各卷实际占用长度之和
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rolls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,    -- 卷序号（1..N）
  label       TEXT NOT NULL,       -- 卷号/卷名
  width       INTEGER NOT NULL,    -- 该卷布幅宽度 mm
  length      INTEGER NOT NULL,    -- 该卷可用长度 mm
  used        INTEGER NOT NULL DEFAULT 0,        -- 是否有裁片排入（启用）
  used_length INTEGER NOT NULL DEFAULT 0,        -- 该卷实际占用长度
  cut_line    INTEGER NOT NULL DEFAULT 0         -- 本卷裁剪切线（mm）：[0,cut_line) 段已裁，不可回退；只增不减
);

CREATE TABLE IF NOT EXISTS defects (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  roll_id INTEGER REFERENCES rolls(id) ON DELETE CASCADE, -- 所属卷（旧数据迁移为首卷）
  x INTEGER NOT NULL, y INTEGER NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS piece_types (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  vertices     TEXT NOT NULL,              -- JSON，【当前版】归一化顶点 [[x,y],...]（历史版见 piece_revisions）
  quantity     INTEGER NOT NULL,
  allow_rotate INTEGER NOT NULL DEFAULT 0, -- 【当前版】是否允许旋转 180°
  bw INTEGER NOT NULL, bh INTEGER NOT NULL, -- 【当前版】外接矩形尺寸
  current_rev  INTEGER NOT NULL DEFAULT 1  -- 当前版次（最新 revision 的 rev）
);

CREATE TABLE IF NOT EXISTS piece_revisions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  piece_type_id  INTEGER NOT NULL REFERENCES piece_types(id) ON DELETE CASCADE,
  rev            INTEGER NOT NULL,          -- 版次（该型号从 1 起，单调递增）
  vertices       TEXT NOT NULL,             -- 该版归一化顶点 [[x,y],...]
  allow_rotate   INTEGER NOT NULL,          -- 该版是否允许旋转 180°
  bw INTEGER NOT NULL, bh INTEGER NOT NULL, -- 该版外接矩形尺寸
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS placements (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  piece_type_id    INTEGER NOT NULL REFERENCES piece_types(id) ON DELETE CASCADE,
  roll_id          INTEGER REFERENCES rolls(id) ON DELETE CASCADE, -- 所在卷（未排入为 NULL）
  required_roll_id INTEGER REFERENCES rolls(id) ON DELETE SET NULL, -- 必用卷约束（NULL=不限）
  piece_revision_id INTEGER REFERENCES piece_revisions(id) ON DELETE CASCADE, -- 本件实际使用的纸样版本（已裁件定格在裁剪时的旧版）
  seq              INTEGER NOT NULL,       -- 该型号的第几件（1..；缩减后可能留空号，扩增件接最大号之后）
  x INTEGER, y INTEGER,                    -- 卷内放置位置（未排入为 NULL）
  rotation INTEGER NOT NULL DEFAULT 0,     -- 0 | 180
  placed   INTEGER NOT NULL DEFAULT 0,
  locked   INTEGER NOT NULL DEFAULT 0,
  cut      INTEGER NOT NULL DEFAULT 0,           -- 已裁标记（已随切线前布段裁下）：卷号/位置/方向/必用卷均不可再改
  cut_batch_id INTEGER REFERENCES cut_batches(id) ON DELETE SET NULL, -- 本件所属裁剪交接单（NULL=升级前已裁，无批次历史）
  unplaced_reason TEXT                         -- 未排入原因
);

-- 裁剪交接单：每次确认切线且确有新裁件时，与裁剪进度在同一事务内原子写入，此后不可改。
-- 后续纸样改版、重新排样、再次裁剪均不改写已有交接单。
CREATE TABLE IF NOT EXISTS cut_batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  roll_id       INTEGER NOT NULL REFERENCES rolls(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,        -- 该卷内确认顺序（1 起，严格递增；同卷并发由事务内重校验+本唯一约束兜底）
  prev_cut_line INTEGER NOT NULL,        -- 本次确认前的切线位置（mm）
  cut_line      INTEGER NOT NULL,        -- 本次确认的切线位置（mm）
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (roll_id, seq)
);

-- 交接单裁件明细：全部字段为确认时刻快照（不依赖 placements/piece_revisions 现状），
-- 因此改版、缩减、重新排样后交接单内容保持定格。
CREATE TABLE IF NOT EXISTS cut_batch_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id       INTEGER NOT NULL REFERENCES cut_batches(id) ON DELETE CASCADE,
  placement_id   INTEGER NOT NULL,       -- 本次新裁件 ID（快照，非外键：交接单永久定格）
  name           TEXT NOT NULL,          -- 件名快照
  seq            INTEGER NOT NULL,       -- 件号快照
  revision       INTEGER NOT NULL,       -- 纸样版次号快照
  piece_revision_id INTEGER NOT NULL,    -- 纸样版次记录 id 快照
  vertices       TEXT NOT NULL,          -- 轮廓快照（该版归一化顶点 JSON）
  bw INTEGER NOT NULL, bh INTEGER NOT NULL, -- 外接尺寸快照
  x INTEGER NOT NULL, y INTEGER NOT NULL,   -- 卷内坐标快照
  rotation       INTEGER NOT NULL        -- 方向快照（0 | 180）
);
`);

// 索引放在列迁移之后创建（旧库的 defects/placements 此时可能还没有 roll_id 列）
function ensureIndices() {
  db.exec(`
CREATE INDEX IF NOT EXISTS idx_rolls_job       ON rolls(job_id);
CREATE INDEX IF NOT EXISTS idx_defects_job     ON defects(job_id);
CREATE INDEX IF NOT EXISTS idx_defects_roll    ON defects(roll_id);
CREATE INDEX IF NOT EXISTS idx_types_job       ON piece_types(job_id);
CREATE INDEX IF NOT EXISTS idx_revs_type       ON piece_revisions(piece_type_id);
CREATE INDEX IF NOT EXISTS idx_placements_job  ON placements(job_id);
CREATE INDEX IF NOT EXISTS idx_placements_roll ON placements(roll_id);
CREATE INDEX IF NOT EXISTS idx_cut_batches_job  ON cut_batches(job_id);
CREATE INDEX IF NOT EXISTS idx_cut_batches_roll ON cut_batches(roll_id);
CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON cut_batch_items(batch_id);
`);
}

// ---------- 旧库结构迁移 ----------

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

if (!hasColumn('defects', 'roll_id')) {
  db.exec('ALTER TABLE defects ADD COLUMN roll_id INTEGER');
}
if (!hasColumn('placements', 'roll_id')) {
  db.exec('ALTER TABLE placements ADD COLUMN roll_id INTEGER');
}
if (!hasColumn('placements', 'required_roll_id')) {
  db.exec('ALTER TABLE placements ADD COLUMN required_roll_id INTEGER');
}
if (!hasColumn('placements', 'unplaced_reason')) {
  db.exec('ALTER TABLE placements ADD COLUMN unplaced_reason TEXT');
}
if (!hasColumn('placements', 'cut')) {
  db.exec('ALTER TABLE placements ADD COLUMN cut INTEGER NOT NULL DEFAULT 0');
}
if (!hasColumn('rolls', 'cut_line')) {
  db.exec('ALTER TABLE rolls ADD COLUMN cut_line INTEGER NOT NULL DEFAULT 0');
}
if (!hasColumn('piece_types', 'current_rev')) {
  db.exec('ALTER TABLE piece_types ADD COLUMN current_rev INTEGER NOT NULL DEFAULT 1');
}
if (!hasColumn('placements', 'piece_revision_id')) {
  db.exec('ALTER TABLE placements ADD COLUMN piece_revision_id INTEGER');
}
if (!hasColumn('placements', 'cut_batch_id')) {
  // 升级前已裁的件（cut=1）该列保持 NULL：缺少逐次切线边界，标识为「无批次历史」，不推造交接单
  db.exec('ALTER TABLE placements ADD COLUMN cut_batch_id INTEGER');
}

// 旧库迁移：为每个已有型号补一条“第 1 版”纸样，并把全部已存在件挂到该版
db.transaction(() => {
  const types = db.prepare('SELECT id, vertices, allow_rotate, bw, bh FROM piece_types').all();
  const insRev = db.prepare(
    'INSERT INTO piece_revisions (job_id, piece_type_id, rev, vertices, allow_rotate, bw, bh) VALUES (?, ?, 1, ?, ?, ?, ?)'
  );
  const link = db.prepare('UPDATE placements SET piece_revision_id = ? WHERE piece_type_id = ? AND piece_revision_id IS NULL');
  for (const t of types) {
    const jobId = db.prepare('SELECT job_id FROM piece_types WHERE id = ?').get(t.id).job_id;
    const info = insRev.run(jobId, t.id, t.vertices, t.allow_rotate, t.bw, t.bh);
    link.run(info.lastInsertRowid, t.id);
  }
})();

// 旧单卷方案：为每个无卷记录的方案补一卷「默认卷」，并把瑕疵与裁片挂到该卷
db.transaction(() => {
  const legacyJobs = db
    .prepare(
      `SELECT j.id, j.fabric_width, j.fabric_length FROM jobs j
       WHERE NOT EXISTS (SELECT 1 FROM rolls r WHERE r.job_id = j.id)`
    )
    .all();
  const insRoll = db.prepare(
    'INSERT INTO rolls (job_id, seq, label, width, length) VALUES (?, 1, ?, ?, ?)'
  );
  for (const j of legacyJobs) {
    const info = insRoll.run(j.id, '默认卷', j.fabric_width, j.fabric_length);
    db.prepare('UPDATE defects SET roll_id = ? WHERE job_id = ? AND roll_id IS NULL').run(
      info.lastInsertRowid,
      j.id
    );
    db.prepare('UPDATE placements SET roll_id = ? WHERE job_id = ? AND roll_id IS NULL').run(
      info.lastInsertRowid,
      j.id
    );
  }
})();

ensureIndices();

module.exports = db;
