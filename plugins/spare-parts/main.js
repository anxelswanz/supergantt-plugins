/**
 * 备件清单：按项目一份台账 —— 搜索 / 多字段筛选、使用扣减、盘点校准、库存变更日志、导入发货单。
 *
 * 单文件、不能 import（宿主按 Blob URL 加载）。上半部分是领域层：数据形状和所有会动库存的
 * 动作，纯函数、单独测（main.test.ts）；下半部分是视图，只收集输入，规则一律调上面的函数。
 *
 * 数据（一个项目一份，存在插件目录 data/inventory-<项目 id>.json）：
 *   { version, rev, meta, parts: Part[], logs: Log[], entities: Entity[], imports: Import[] }
 * 设计见 docs/spare-parts-design.md。
 */

/* ================================================================== */
/* 领域层                                                              */
/* ================================================================== */


export const DATA_VERSION = 1;

/** 核心列。AI 只能往 fields 里加自定义列，不能改这几列 */
export const CORE_FIELDS = ["seq", "name", "sku", "spec", "category", "unit", "qty", "note"];

export const EMPTY_DATA = () => ({
  version: DATA_VERSION,
  rev: 0,
  meta: { createdAt: null, updatedAt: null },
  parts: [],
  logs: [],
  entities: [],
  imports: [],
});

const nowIso = () => new Date().toISOString();
const uid = (p) =>
  `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/* ------------------------------------------------------------------ */
/* 读写的防线                                                          */
/* ------------------------------------------------------------------ */

/**
 * 从存储里读回一份。坏的、旧版本的都落成空数据 —— 读不出来时让用户从备份恢复，
 * 比让视图拿到半个对象然后一路报错好。
 */
export function parseData(raw) {
  if (!raw) return EMPTY_DATA();
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return EMPTY_DATA();
  }
  const d = { ...EMPTY_DATA(), ...v };
  for (const k of ["parts", "logs", "entities", "imports"]) if (!Array.isArray(d[k])) d[k] = [];
  return d;
}

/** 下一个序号：不复用已归档 / 已删除的号，日志里的序号才永远指向同一个东西 */
export function nextSeq(data) {
  const fromParts = data.parts.reduce((m, p) => Math.max(m, p.seq ?? 0), 0);
  // 已删除的条目还留在 parts 里（见 applyDelete），这里再兜一层：日志里出现过的号也不算空
  const fromLogs = data.logs.reduce((m, l) => Math.max(m, l.seq ?? 0), 0);
  return Math.max(fromParts, fromLogs, data.meta?.lastSeq ?? 0) + 1;
}

/* ------------------------------------------------------------------ */
/* 不变量                                                              */
/* ------------------------------------------------------------------ */

/**
 * 库存和日志必须能互相对上。每次写回前跑一遍，对不上就拒绝写入 ——
 * 静默写坏比报错难查得多。
 */
export function checkInvariants(data) {
  const problems = [];
  const lastAfter = new Map();
  const ordered = [...data.logs].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const l of ordered) {
    if (l.type === "restore") continue;
    if (typeof l.qty === "number" && typeof l.before === "number" && l.after !== l.before + l.qty) {
      problems.push(`${l.id}：${l.before} ${l.qty >= 0 ? "+" : ""}${l.qty} ≠ ${l.after}`);
    }
    lastAfter.set(l.partId, l.after);
  }
  for (const p of data.parts) {
    if (p.deleted) continue;
    if (!Number.isInteger(p.qty) || p.qty < 0) {
      problems.push(`「${p.name}」库存是 ${p.qty}，不能是负数`);
    }
    const last = lastAfter.get(p.id);
    if (last != null && last !== p.qty) {
      problems.push(`「${p.name}」库存 ${p.qty}，但最后一条日志是 ${last}`);
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */

function pushLog(data, part, { type, qty, entityId, personId, by, note, at, importId, raw, confidence }) {
  const before = part.qty;
  const after = before + qty;
  const entity = entityId ? data.entities.find((e) => e.id === entityId) ?? null : null;
  const log = {
    id: uid("l"),
    partId: part.id,
    seq: part.seq,
    type,
    qty,
    before,
    after,
    entityId: entity ? entity.id : null,
    entityName: entity ? entity.name : "",
    personId: personId ?? null,
    by,
    note: note?.trim() || "",
    at: at ?? nowIso(),
    importId: importId ?? null,
    raw: raw ?? null,
    confidence: confidence ?? null,
  };
  data.logs.push(log);
  part.qty = after;
  part.updatedAt = log.at;
  part.updatedBy = by;
  return log;
}

/* ------------------------------------------------------------------ */
/* 动作。都返回新的一份 data（不原地改），出错抛 Error（消息直接给人看） */
/* ------------------------------------------------------------------ */

const clone = (d) => JSON.parse(JSON.stringify(d));
const positiveInt = (n, what = "数量") => {
  const v = Number(n);
  if (!Number.isInteger(v) || v <= 0) throw new Error(`${what}要是正整数`);
  return v;
};

/** 新建条目。初始库存可以是 0（先建后入库） */
export function applyCreate(state, input, ctx = {}) {
  const data = clone(state);
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("名称不能为空");
  const initialQty = Number(input.qty ?? 0);
  if (!Number.isInteger(initialQty) || initialQty < 0) throw new Error("初始库存要是 ≥ 0 的整数");
  const sku = String(input.sku ?? "").trim();
  if (sku && data.parts.some((p) => !p.archived && !p.deleted && p.sku && p.sku.toLowerCase() === sku.toLowerCase())) {
    throw new Error(`SKU「${sku}」已经存在`);
  }
  const at = ctx.at ?? nowIso();
  const part = {
    id: uid("p"),
    seq: nextSeq(data),
    name,
    sku,
    spec: String(input.spec ?? "").trim(),
    category: String(input.category ?? "").trim(),
    location: String(input.location ?? "").trim(),
    unit: String(input.unit ?? "").trim() || "个",
    qty: 0,
    minQty: Number.isInteger(input.minQty) ? input.minQty : null,
    note: String(input.note ?? "").trim(),
    fields: Array.isArray(input.fields) ? input.fields.filter((f) => f?.label) : [],
    archived: false,
    deleted: false,
    createdAt: at,
    createdBy: ctx.by ?? "",
    updatedAt: at,
    updatedBy: ctx.by ?? "",
  };
  data.parts.push(part);
  data.meta.lastSeq = Math.max(data.meta.lastSeq ?? 0, part.seq);
  if (initialQty > 0) {
    pushLog(data, part, {
      type: input.importId ? "import" : "create",
      qty: initialQty,
      by: ctx.by ?? "",
      note: input.importId ? `导入：${input.sourceFile ?? ""}` : "",
      at,
      importId: input.importId,
      raw: input.raw,
      confidence: input.confidence,
    });
  }
  data.meta.updatedAt = at;
  data.rev += 1;
  return data;
}

/**
 * 一整批入库（发货单导入、`gantt spare push` 的收件箱）：SKU 命中就入库，没命中就新建。
 * 每条日志都带批次 id，`revertImport` 能整批冲回去。没有一条有名字时原样返回。
 *
 * batch: { id?, source, items: [{ name, sku, spec, category, location, unit, qty, fields, confidence }] }
 */
export function applyBatch(state, batch, ctx = {}) {
  const items = (batch?.items ?? []).filter((i) => String(i?.name ?? "").trim());
  if (!items.length) return state;
  const importId = batch.id || uid("imp");
  const source = String(batch.source ?? "").trim();
  const at = ctx.at ?? nowIso();
  let next = clone(state);
  next.imports = [
    ...next.imports,
    { id: importId, at, by: ctx.by ?? "", source: source || "导入", count: items.length },
  ];
  for (const r of items) {
    const qty = Math.max(0, Math.round(Number(r.qty) || 0));
    const sku = String(r.sku ?? "").trim().toLowerCase();
    const hit = sku ? next.parts.find((p) => !p.archived && !p.deleted && p.sku && p.sku.toLowerCase() === sku) : null;
    if (hit) {
      if (qty === 0) continue;
      const part = next.parts.find((p) => p.id === hit.id);
      pushLog(next, part, {
        type: "import",
        qty,
        note: `导入：${source}`,
        by: ctx.by ?? "",
        at,
        importId,
        raw: r,
        confidence: r.confidence,
      });
      next.rev += 1;
    } else {
      next = applyCreate(
        next,
        {
          name: r.name,
          sku: r.sku,
          spec: r.spec,
          category: r.category,
          location: r.location,
          unit: r.unit,
          qty,
          fields: r.fields,
          raw: r,
          confidence: r.confidence ?? null,
          importId,
          sourceFile: source,
        },
        { by: ctx.by, at },
      );
    }
  }
  return next;
}

/**
 * 删除条目：有库存就先清零（写一条 delete 日志），然后标成已删除。
 *
 * 不把它从 parts 里拿掉：日志全都靠 partId + 序号指向它，拿掉之后历史就读不懂了；
 * 「序号不复用」也靠它占着号（见 nextSeq）。界面上看不到，日志里显示「已删除」。
 */
export function applyDelete(state, partId, ctx = {}) {
  const data = clone(state);
  const part = data.parts.find((p) => p.id === partId);
  if (!part) throw new Error("找不到这个备件");
  if (part.deleted) return data;
  const at = ctx.at ?? nowIso();
  if (part.qty > 0) {
    pushLog(data, part, { type: "delete", qty: -part.qty, note: "删除条目，库存清零", by: ctx.by ?? "", at });
  }
  part.deleted = true;
  part.deletedAt = at;
  part.deletedBy = ctx.by ?? "";
  part.updatedAt = at;
  part.updatedBy = ctx.by ?? "";
  data.meta.lastSeq = Math.max(data.meta.lastSeq ?? 0, part.seq);
  data.rev += 1;
  return data;
}

/** 把删掉的条目找回来：只是又能看见、能操作；库存是 0，要用「入库」加回来 */
export function applyRestore(state, partId, ctx = {}) {
  const data = clone(state);
  const part = data.parts.find((p) => p.id === partId);
  if (!part) throw new Error("找不到这个备件");
  part.deleted = false;
  part.deletedAt = null;
  part.deletedBy = null;
  part.updatedAt = ctx.at ?? nowIso();
  part.updatedBy = ctx.by ?? part.updatedBy;
  data.rev += 1;
  return data;
}

/** 改条目属性（不动库存） */
export function applyUpdate(state, partId, patch, ctx = {}) {
  const data = clone(state);
  const part = data.parts.find((p) => p.id === partId);
  if (!part) throw new Error("找不到这个备件");
  const allowed = ["name", "sku", "spec", "category", "location", "unit", "note", "photo", "minQty", "archived", "fields"];
  for (const k of allowed) {
    if (k in patch) part[k] = patch[k];
  }
  if (!part.name.trim()) throw new Error("名称不能为空");
  part.updatedAt = ctx.at ?? nowIso();
  part.updatedBy = ctx.by ?? part.updatedBy;
  data.rev += 1;
  return data;
}

/** 使用：扣库存，必须跟一台设备（Entity） */
export function applyUse(state, { partId, qty, entityId, personId, note }, ctx = {}) {
  const data = clone(state);
  const part = data.parts.find((p) => p.id === partId);
  if (!part) throw new Error("找不到这个备件");
  if (part.deleted) throw new Error("这个备件已经删除，先恢复再用");
  if (part.archived) throw new Error("这个备件已经归档，先恢复再用");
  const n = positiveInt(qty);
  if (!entityId) throw new Error("要选一台设备（Entity）");
  if (!data.entities.some((e) => e.id === entityId)) throw new Error("这台设备不存在，先在弹窗里新建");
  if (n > part.qty) throw new Error(`库存不够：当前只有 ${part.qty} ${part.unit}`);
  pushLog(data, part, {
    type: "use",
    qty: -n,
    entityId,
    personId,
    note,
    by: ctx.by ?? "",
    at: ctx.at,
  });
  data.rev += 1;
  return data;
}

/** 入库：补货、归还都走这里 */
export function applyReceive(state, { partId, qty, note }, ctx = {}) {
  const data = clone(state);
  const part = data.parts.find((p) => p.id === partId);
  if (!part) throw new Error("找不到这个备件");
  pushLog(data, part, { type: "receive", qty: positiveInt(qty), note, by: ctx.by ?? "", at: ctx.at });
  data.rev += 1;
  return data;
}

/** 手动调整：必须写原因，日志里看不到理由的加减等于没有 */
export function applyAdjust(state, { partId, delta, note }, ctx = {}) {
  const data = clone(state);
  const part = data.parts.find((p) => p.id === partId);
  if (!part) throw new Error("找不到这个备件");
  const d = Number(delta);
  if (!Number.isInteger(d) || d === 0) throw new Error("调整数要是非零整数");
  if (!note?.trim()) throw new Error("调整必须写原因");
  if (part.qty + d < 0) throw new Error("不能扣成负数");
  pushLog(data, part, { type: "adjust", qty: d, note, by: ctx.by ?? "", at: ctx.at });
  data.rev += 1;
  return data;
}

/**
 * 盘点：实盘数为准，库存直接改成实盘数（盘盈盘亏都一次性纠正）。
 * 没填的行（countedQty 为 null / 空）不动 —— 「没盘」不等于「盘了是 0」。
 */
export function applyCheck(state, { lines, note, scope }, ctx = {}) {
  const data = clone(state);
  const at = ctx.at ?? nowIso();
  const checkId = uid("c");
  const touched = [];
  for (const line of lines ?? []) {
    if (line.countedQty == null || line.countedQty === "") continue;
    const counted = Number(line.countedQty);
    if (!Number.isInteger(counted) || counted < 0) throw new Error("实盘数要是 ≥ 0 的整数");
    const part = data.parts.find((p) => p.id === line.partId);
    if (!part) continue;
    // 以「提交这一刻」的系统库存为准：盘点期间发生的使用不算进盘亏
    const delta = counted - part.qty;
    if (delta === 0) {
      touched.push({ partId: part.id, seq: part.seq, name: part.name, systemQty: part.qty, countedQty: counted, delta: 0, logId: null });
      continue;
    }
    const log = pushLog(data, part, { type: "check", qty: delta, note, by: ctx.by ?? "", at });
    log.checkId = checkId;
    touched.push({ partId: part.id, seq: part.seq, name: part.name, systemQty: log.before, countedQty: counted, delta, logId: log.id });
  }
  if (!touched.length) throw new Error("没有任何一条填了实盘数");
  const changed = touched.filter((t) => t.delta !== 0);
  const session = {
    id: checkId,
    at,
    by: ctx.by ?? "",
    note: note ?? "",
    scope: scope ?? { kind: "all" },
    lines: touched,
    summary: {
      gain: changed.filter((t) => t.delta > 0).length,
      loss: changed.filter((t) => t.delta < 0).length,
      gainQty: changed.reduce((n, t) => n + Math.max(0, t.delta), 0),
      lossQty: changed.reduce((n, t) => n + Math.max(0, -t.delta), 0),
    },
  };
  data.meta.checks = [...(data.meta.checks ?? []), session];
  data.meta.updatedAt = at;
  data.rev += 1;
  return data;
}

/* ------------------------------------------------------------------ */
/* 设备（Entity）                                                      */
/* ------------------------------------------------------------------ */

export function applyEntityCreate(state, { name, kind, note }, ctx = {}) {
  const data = clone(state);
  const n = String(name ?? "").trim();
  if (!n) throw new Error("设备名不能为空");
  const existing = data.entities.find((e) => !e.archived && e.name.toLowerCase() === n.toLowerCase());
  if (existing) return { data: state, entity: existing };
  const entity = {
    id: uid("e"),
    name: n,
    kind: String(kind ?? "").trim(),
    note: String(note ?? "").trim(),
    archived: false,
    createdAt: ctx.at ?? nowIso(),
  };
  data.entities.push(entity);
  data.rev += 1;
  return { data, entity };
}

/** 撤销一整批 AI 导入：写反向调整，不删原日志 */
export function revertImport(state, importId, ctx = {}) {
  const data = clone(state);
  const applied = data.logs.filter((l) => l.importId === importId && !l.revertedBy);
  if (!applied.length) throw new Error("这一批没有可撤销的记录");
  const at = ctx.at ?? nowIso();
  // 先把会扣成负数的挑出来：宁可整批不动，也不要冲掉一半、留下一个对不上的台账
  const running = new Map(data.parts.map((p) => [p.id, p.qty]));
  for (const log of applied) {
    const left = (running.get(log.partId) ?? 0) - log.qty;
    if (left < 0) {
      const part = data.parts.find((p) => p.id === log.partId);
      throw new Error(
        `「${part?.name ?? log.partId}」已经被用掉一部分，撤销这一批会扣成负数。先补入库，或只撤销其中的条目`,
      );
    }
    running.set(log.partId, left);
  }
  for (const log of applied) {
    const part = data.parts.find((p) => p.id === log.partId);
    if (!part) continue;
    const back = pushLog(data, part, {
      type: "adjust",
      qty: -log.qty,
      note: `撤销导入（${log.seq}）`,
      by: ctx.by ?? "",
      at,
    });
    log.revertedBy = back.id;
  }
  const imp = data.imports.find((i) => i.id === importId);
  if (imp) imp.revertedAt = at;
  data.rev += 1;
  return data;
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

/** 大小写无关包含匹配；空词永远命中 */
const hit = (text, q) => !q || String(text ?? "").toLowerCase().includes(q);

export const EMPTY_FILTER = {
  q: "",
  categories: [],
  units: [],
  status: null, // "low" | "zero" | "ok" | "archived" | null
  entities: [],
  people: [],
  lastUsed: null, // "never" | "7d" | "30d" | null
  archived: false,
  /** 已删除的条目默认不出现在清单里，在「导入 / 已删除」页能看到、能恢复 */
  deleted: false,
};

/** 列表用的投影：条目 + 从日志里派生出来的「最近使用」，不单独存字段 */
export function decorate(data) {
  const lastUse = new Map();
  const useCount = new Map();
  for (const l of data.logs) {
    if (l.type !== "use") continue;
    const prev = lastUse.get(l.partId);
    if (!prev || l.at > prev) lastUse.set(l.partId, l.at);
    useCount.set(l.partId, (useCount.get(l.partId) ?? 0) + 1);
  }
  const entityName = new Map(data.entities.map((e) => [e.id, e.name]));
  return data.parts.map((p) => ({
    ...p,
    lastUsedAt: lastUse.get(p.id) ?? null,
    useCount: useCount.get(p.id) ?? 0,
    low: p.minQty != null && p.qty <= p.minQty,
    entityNames: [...new Set(data.logs.filter((l) => l.partId === p.id && l.entityId).map((l) => entityName.get(l.entityId) ?? l.entityName))],
  }));
}

const daysAgo = (iso, days, now) => iso != null && now - Date.parse(iso) <= days * 864e5;

export function filterParts(rows, filter, now = Date.now()) {
  const f = { ...EMPTY_FILTER, ...filter };
  const q = f.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (Boolean(r.deleted) !== Boolean(f.deleted)) return false;
    if (!f.archived && r.archived) return false;
    if (!hit(r.name, q) && !hit(r.sku, q) && !hit(r.spec, q) && !hit(r.note, q) && !hit(r.category, q) && !hit(r.location, q)) {
      return false;
    }
    if (f.categories.length && !f.categories.includes(r.category)) return false;
    if (f.units.length && !f.units.includes(r.unit)) return false;
    if (f.status === "low" && !r.low) return false;
    if (f.status === "zero" && r.qty !== 0) return false;
    if (f.status === "ok" && (r.low || r.qty === 0 || r.archived)) return false;
    if (f.entities.length && !f.entities.some((id) => r.entityNames.includes(id))) return false;
    if (f.lastUsed === "never" && r.lastUsedAt) return false;
    if (f.lastUsed === "7d" && !daysAgo(r.lastUsedAt, 7, now)) return false;
    if (f.lastUsed === "30d" && !daysAgo(r.lastUsedAt, 30, now)) return false;
    return true;
  });
}

/** 库存不足置顶，其余按序号 */
export const sortParts = (rows) =>
  [...rows].sort((a, b) => Number(b.low) - Number(a.low) || a.seq - b.seq);

/** 日志筛选。personId / type / 日期区间 / 设备 / 备件 */
export function filterLogs(logs, filter = {}) {
  const { entityId, partId, types = [], from, to, by } = filter;
  return logs
    .filter((l) => {
      if (entityId && l.entityId !== entityId) return false;
      if (partId && l.partId !== partId) return false;
      if (types.length && !types.includes(l.type)) return false;
      if (by && l.by !== by) return false;
      if (from && l.at.slice(0, 10) < from) return false;
      if (to && l.at.slice(0, 10) > to) return false;
      return true;
    })
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export const LOG_TYPES = [
  { key: "create", label: "新建" },
  { key: "import", label: "导入" },
  { key: "use", label: "使用" },
  { key: "receive", label: "入库" },
  { key: "check", label: "盘点" },
  { key: "adjust", label: "调整" },
  { key: "delete", label: "删除" },
];

export const logTypeLabel = (t) => LOG_TYPES.find((x) => x.key === t)?.label ?? t;

const Model = { parseData, applyBatch, applyDelete, applyRestore, checkInvariants, sortParts, filterParts, decorate, applyEntityCreate, applyUse, applyReceive, applyCreate, applyUpdate, applyCheck, applyAdjust, filterLogs, revertImport };

/* ================================================================== */
/* 飞书同步：纯逻辑（接口调用在视图里，这里只决定「写什么」）              */
/* ================================================================== */

/** 飞书多维表格的字段类型编号（bitable v1） */
export const FT = { text: 1, number: 2, select: 3, date: 5, link: 18 };

/** 两种表的列。order 决定建表时的顺序：第一个必须是文本（飞书拿它当索引列） */
export const PARTS_FIELDS = [
  { name: "名称", type: FT.text },
  { name: "序号", type: FT.number },
  { name: "SKU", type: FT.text },
  { name: "规格", type: FT.text },
  { name: "分类", type: FT.select },
  { name: "位置", type: FT.text },
  { name: "库存", type: FT.number },
  { name: "安全库存", type: FT.number },
  { name: "单位", type: FT.text },
  { name: "状态", type: FT.select },
  { name: "gantt_part_id", type: FT.text },
];

export const LOGS_FIELDS = [
  { name: "说明", type: FT.text },
  { name: "类型", type: FT.select },
  { name: "日期", type: FT.date },
  { name: "备件", type: FT.link },
  { name: "设备", type: FT.text },
  { name: "数量", type: FT.number },
  { name: "库存变化", type: FT.text },
  { name: "领用人", type: FT.text },
  { name: "操作人", type: FT.text },
  { name: "备注", type: FT.text },
  { name: "gantt_log_id", type: FT.text },
];

/** 状态列：自己算「是否不足」，不依赖 decorate —— 同步拿的是原始台账 */
const STATUS_LABEL = (p) =>
  p.deleted
    ? "已删除"
    : p.archived
      ? "已归档"
      : p.qty === 0
        ? "没库存"
        : p.minQty != null && p.qty <= p.minQty
          ? "库存不足"
          : "正常";

/** 备件表的一行（不含飞书 record_id —— 那个由同步状态记） */
export function partsRow(p) {
  return {
    fields: {
      名称: p.name || "（未命名）",
      序号: p.seq,
      SKU: p.sku || "",
      规格: p.spec || "",
      分类: p.category || "",
      位置: p.location || "",
      库存: p.qty,
      安全库存: p.minQty ?? null,
      单位: p.unit || "",
      状态: STATUS_LABEL(p),
      gantt_part_id: p.id,
    },
    // 自定义列（每张表列名不同，建表时按出现过的标签加列）
    extra: p.fields?.length ? Object.fromEntries(p.fields.map((f) => [f.label, f.value ?? ""])) : {},
  };
}

/**
 * 日志表的一行。备件列是**关联记录**：值为飞书那边的 record_id。
 * 找不到对应记录（备件还没同步）时整条先不同步 —— 没有关联的日志行没有意义，
 * 下一次同步（备件行建好之后）再写。
 */
export function logsRow(l, part, partRecordId, personName) {
  return {
    fields: {
      说明: `${l.seq ?? ""} ${part?.name ?? "（已删除的备件）"}`.trim(),
      类型: LOG_TYPES.find((t) => t.key === l.type)?.label ?? l.type,
      日期: Date.parse(l.at) || null,
      // 写记录时关联字段传 record_id 数组（batch_create 的请求体就是这么写的；
      // 读回来才是 { link_record_ids, text_arr } 那种包装，别混）
      备件: partRecordId ? [partRecordId] : null,
      设备: l.entityName || "",
      数量: l.qty,
      库存变化: `${l.before} → ${l.after}`,
      领用人: personName ?? "",
      操作人: l.by || "",
      备注: l.note || "",
      gantt_log_id: l.id,
    },
  };
}

/**
 * 算出这一轮要写什么。纯函数：不碰网络、不碰存储。
 *
 * state = { parts: { partId: recordId }, logs: { logId: recordId }, lastSyncAt }
 * - 备件：已经有 recordId 的更新；没影响到的（序号/名称/库存都没变）不动；新的新建。
 * - 日志：只追加没写过的；备件行还没有 recordId 的跳过。
 *
 * 返回 { parts: {create, update}, logs: {create, skippedPendingPart} }
 */
export function planSync(data, state, { full = false } = {}) {
  const partsCreate = [];
  const partsUpdate = [];
  for (const p of data.parts) {
    const row = partsRow(p);
    const rec = state.parts?.[p.id];
    if (!rec) {
      // 带上 partId：批量写完要按返回顺序认领 record_id，行本身不携带 id
      partsCreate.push({ partId: p.id, row });
    } else if (full || rec.fingerprint !== JSON.stringify(row.fields)) {
      partsUpdate.push({ partId: p.id, recordId: rec.recordId, row });
    }
  }

  const logsCreate = [];
  const skipped = [];
  for (const l of data.logs) {
    if (state.logs?.[l.id]) continue;
    const rec = state.parts?.[l.partId];
    if (!rec) {
      skipped.push(l.id);
      continue;
    }
    const part = data.parts.find((p) => p.id === l.partId);
    logsCreate.push({ log: l, row: logsRow(l, part, rec.recordId) });
  }

  return { partsCreate, partsUpdate, logsCreate, skippedLogs: skipped };
}

/** 写完之后把它存进同步状态：飞书的 record_id 和用来判断「有没有变」的指纹 */
export function rememberParts(state, createdIds, updatedRows) {
  const next = { ...state, parts: { ...(state.parts ?? {}) } };
  createdIds.forEach(({ partId, recordId, row }) => {
    next.parts[partId] = { recordId, fingerprint: JSON.stringify(row.fields) };
  });
  for (const { partId, recordId, row } of updatedRows) {
    next.parts[partId] = { recordId, fingerprint: JSON.stringify(row.fields) };
  }
  return next;
}

export function rememberLogs(state, pairs) {
  const next = { ...state, logs: { ...(state.logs ?? {}) } };
  for (const { logId, recordId } of pairs) next.logs[logId] = recordId;
  next.lastSyncAt = new Date().toISOString();
  return next;
}


const emptyFilter = () => ({
  q: "",
  categories: [],
  units: [],
  status: null,
  entities: [],
  lastUsed: null,
  archived: false,
});

const STATUS_OPTIONS = [
  { value: null, label: "全部状态" },
  { value: "low", label: "库存不足" },
  { value: "zero", label: "没库存" },
  { value: "ok", label: "正常" },
];

const LAST_USED_OPTIONS = [
  { value: null, label: "不限使用时间" },
  { value: "never", label: "从未使用" },
  { value: "30d", label: "30 天内用过" },
  { value: "7d", label: "7 天内用过" },
];

const TYPE_LABEL = { create: "新建", import: "导入", use: "使用", receive: "入库", check: "盘点", adjust: "调整", delete: "删除" };

const fmtTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fmtDay = (iso) => (iso ? iso.slice(0, 10) : "");

/** 一份台账的存储键：跟着项目走，一个项目一份 */
const storeName = (projectId) => `inventory-${projectId}.json`;

export function onload(api) {
  const React = api.react;
  const h = React.createElement;
  const { useEffect, useMemo, useRef, useState } = React;

  /** 每个会改数据的动作都带上「谁改的」—— 当前登录账号，宿主 1.7 起才有，旧宿主落成空 */
  const who = () => ({ by: api.data.account?.()?.name ?? "" });

  /* ---------------- 台账读写 ---------------- */

  /** 当前项目 + 内存里的那份台账。所有修改都经 save()，串行写回 */
  function useLedger() {
    const [project, setProject] = useState(() => api.data.project());
    const [data, setDataState] = useState(null);
    const [error, setError] = useState(null);
    const queue = useRef(Promise.resolve());
    // 串行写回时要拿「上一次写完」的那份，不能拿闭包里渲染时的旧值
    const latest = useRef(null);
    const setData = (d) => {
      latest.current = d;
      setDataState(d);
    };

    // 切项目就换台账；项目列表页时这里没有项目，视图会显示提示
    useEffect(() => {
      const p = api.data.project();
      setProject(p);
      setData(null);
      setError(null);
      if (!p) return;
      let live = true;
      void api.storage
        .read(storeName(p.id))
        .then((raw) => live && setData(Model.parseData(raw)))
        .catch((e) => live && setError(String(e)));
      return () => {
        live = false;
      };
    }, [project?.id]);

    /** 下一个状态：fn 拿旧数据算新的，算完校验不变量再写回 */
    const save = (fn) =>
      new Promise((resolve, reject) => {
        queue.current = queue.current
          .then(async () => {
            const next = fn(latest.current);
            const problems = Model.checkInvariants(next);
            if (problems.length) throw new Error(`数据对不上，没有写入：${problems[0]}`);
            await api.storage.write(storeName(project.id), JSON.stringify(next));
            setData(next);
            resolve(next);
          })
          .catch((e) => {
            setError(String(e));
            reject(e);
          });
      });

    /**
     * 收件箱：应用开着时 `gantt spare push` 写不进台账（会被我们下一次写回盖掉），
     * 它把批次放进 `inbox-<项目>.json`，这里轮询取走、按 SKILL 的规则入库，再清空收件箱。
     * 入库走同一条 save，不变量校验照常。
     */
    const drainInbox = () =>
      withInbox(project?.id, async (read, write) => {
        const raw = await read();
        let box;
        try {
          box = raw ? JSON.parse(raw) : null;
        } catch {
          box = null;
        }
        const batches = Array.isArray(box?.batches) ? box.batches : [];
        if (!batches.length) return;
        let applied = 0;
        try {
          await save((d) => {
            let next = d;
            for (const b of batches) {
              next = Model.applyBatch(next, b, who());
              applied += 1;
            }
            return next;
          });
        } catch (e) {
          // 写库失败就留着收件箱，下一轮再试；不把坏批次丢掉
          api.log("收件箱写入失败，下一轮重试：", String(e));
          return;
        }
        await write(JSON.stringify({ batches: [] }));
        setError(null);
        api.log(`收件箱：入库 ${applied} 批`);
      });

    // 视图开着时每 5 秒看一眼收件箱；切到别的项目 / 卸载就停
    useEffect(() => {
      if (!project) return;
      // 不看文档，视图就停在旧数据上：同一项目又在另一个窗口改了，或者收件箱进了新批次
      const timer = setInterval(() => {
        void drainInbox();
        void api.data.items.reload?.().catch(() => {});
      }, 5000);
      void drainInbox();
      return () => clearInterval(timer);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [project?.id]);

    return { project, data, error, setError, save, reload: () => {
      const p = api.data.project();
      if (!p) return Promise.resolve();
      return api.storage.read(storeName(p.id)).then((raw) => setData(Model.parseData(raw)));
    } };
  }

  /**
   * 收件箱的读写。宿主的 storage 只给「插件目录 / data/」下的文件名，
   * 收件箱前缀 `inbox-` 和宿主给 CLI 用的命名一致（gantt-core/src/spare.rs）。
   */
  const withInbox = (projectId, fn) => {
    if (projectId == null) return Promise.resolve();
    const name = `inbox-${projectId}.json`;
    return fn(
      () => api.storage.read(name),
      (content) => api.storage.write(name, content),
    ).catch((e) => api.log("收件箱读写失败：", String(e)));
  };

  /* ---------------- 小部件 ---------------- */

  const Btn = ({ children, onClick, kind, disabled, title, small }) =>
    h(
      "button",
      {
        onClick,
        disabled,
        title,
        className: `sp-btn${kind ? ` sp-btn-${kind}` : ""}${small ? " sp-btn-s" : ""}`,
      },
      children,
    );

  const Chip = ({ on, children, onClick, title }) =>
    h("button", { onClick, title, className: `sp-chip${on ? " sp-chip-on" : ""}` }, children);

  const Field = ({ label, children, hint }) =>
    h(
      "label",
      { className: "sp-field" },
      h("span", { className: "sp-field-label" }, label),
      children,
      hint && h("span", { className: "sp-hint" }, hint),
    );

  /** 简易弹窗：背板点击关闭，Esc 关闭。内容自己画 */
  function Dialog({ title, onClose, children, footer, wide }) {
    useEffect(() => {
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      };
      window.addEventListener("keydown", onKey, true);
      return () => window.removeEventListener("keydown", onKey, true);
    }, [onClose]);
    return h(
      "div",
      { className: "sp-overlay", onPointerDown: onClose },
      h(
        "div",
        {
          className: `sp-dialog${wide ? " sp-wide" : ""}`,
          onPointerDown: (e) => e.stopPropagation(),
        },
        h("div", { className: "sp-dialog-head" }, h("span", null, title), h("button", { className: "sp-x", onClick: onClose }, "✕")),
        h("div", { className: "sp-dialog-body" }, children),
        footer && h("div", { className: "sp-dialog-foot" }, footer),
      ),
    );
  }

  /** 多选下拉：值是一个数组。用原生 select 做不了多选时的样式一致性，这里摊成一排 chip */
  function ChipGroup({ options, value, onChange }) {
    return h(
      "div",
      { className: "sp-chips" },
      options.map((o) =>
        h(
          Chip,
          {
            key: String(o.value),
            on: value.includes(o.value),
            onClick: () =>
              onChange(value.includes(o.value) ? value.filter((v) => v !== o.value) : [...value, o.value]),
          },
          o.label,
        ),
      ),
    );
  }

  /* ---------------- 台账视图 ---------------- */

  function Ledger() {
    const { project, data, error, setError, save, reload } = useLedger();
    const [tab, setTab] = useState("parts");
    const [filter, setFilter] = useState(emptyFilter);
    const [dialog, setDialog] = useState(null);
    const me = api.data.account?.()?.name ?? "";

    /** 大弹窗改的东西统一走这里：算新数据 → 写回 → 关窗 */
    const commit = async (fn, close = true) => {
      try {
        await save(fn);
        if (close) setDialog(null);
        return true;
      } catch (e) {
        // 失败就把原因留在界面上：关掉弹窗，用户就不知道刚才为什么没生效
        setError(String(e.message ?? e));
        return false;
      }
    };

    if (!project) {
      return h("div", { className: "sp-root sp-empty" }, "备件跟着项目走 —— 先打开一个项目。");
    }
    if (!data) return h("div", { className: "sp-root sp-empty" }, "读取中…");

    const rows = Model.sortParts(Model.filterParts(Model.decorate(data), filter));
    const categories = [...new Set(data.parts.map((p) => p.category).filter(Boolean))].sort();
    const units = [...new Set(data.parts.map((p) => p.unit).filter(Boolean))].sort();
    const lowCount = Model.decorate(data).filter((p) => !p.archived && p.low).length;

    return h(
      "div",
      { className: "sp-root" },
      h(
        "div",
        { className: "sp-bar" },
        h("span", { className: "sp-title" }, "备件"),
        h("span", { className: "sp-dim" }, project.name),
        h("div", { className: "sp-tabs" },
          h(Chip, { on: tab === "parts", onClick: () => setTab("parts") }, `清单 ${data.parts.filter((p) => !p.archived).length}`),
          h(Chip, { on: tab === "logs", onClick: () => setTab("logs") }, "日志"),
          h(Chip, { on: tab === "imports", onClick: () => setTab("imports") }, `导入 ${data.imports.filter((i) => !i.revertedAt).length}`),
          h(Chip, { on: tab === "feishu", onClick: () => setTab("feishu") }, "飞书"),
        ),
        h("span", { className: "sp-push" }),
        h(Btn, { kind: "primary", onClick: () => setDialog({ kind: "edit" }) }, "＋ 新增"),
        h(Btn, { onClick: () => setDialog({ kind: "check" }) }, "盘点"),
        h(Btn, { onClick: () => setDialog({ kind: "import" }) }, "从发货单导入"),
      ),

      error &&
        h(
          "div",
          { className: "sp-error" },
          error,
          h("button", { onClick: () => setError(null), className: "sp-x" }, "✕"),
        ),

      tab === "parts" &&
        h(
          React.Fragment,
          null,
          h(
            "div",
            { className: "sp-filters" },
            h("input", {
              className: "sp-search",
              placeholder: "⌕ 名称 / SKU / 规格 / 分类 / 备注",
              value: filter.q,
              onChange: (e) => setFilter({ ...filter, q: e.target.value }),
            }),
            h(
              "select",
              {
                className: "sp-select",
                value: filter.status ?? "",
                onChange: (e) => setFilter({ ...filter, status: e.target.value || null }),
              },
              STATUS_OPTIONS.map((o) => h("option", { key: String(o.value), value: o.value ?? "" }, o.label)),
            ),
            h(
              "select",
              {
                className: "sp-select",
                value: filter.lastUsed ?? "",
                onChange: (e) => setFilter({ ...filter, lastUsed: e.target.value || null }),
              },
              LAST_USED_OPTIONS.map((o) => h("option", { key: String(o.value), value: o.value ?? "" }, o.label)),
            ),
            categories.length > 0 &&
              h(
                "select",
                {
                  className: "sp-select",
                  value: filter.categories[0] ?? "",
                  onChange: (e) => setFilter({ ...filter, categories: e.target.value ? [e.target.value] : [] }),
                },
                h("option", { value: "" }, "全部分类"),
                categories.map((c) => h("option", { key: c, value: c }, c)),
              ),
            units.length > 1 &&
              h(
                "select",
                {
                  className: "sp-select",
                  value: filter.units[0] ?? "",
                  onChange: (e) => setFilter({ ...filter, units: e.target.value ? [e.target.value] : [] }),
                },
                h("option", { value: "" }, "全部单位"),
                units.map((u) => h("option", { key: u, value: u }, u)),
              ),
            h(
              Chip,
              {
                on: filter.archived,
                onClick: () => setFilter({ ...filter, archived: !filter.archived }),
                title: "归档的条目不出现在默认清单里，但日志和筛选里还在",
              },
              "含已归档",
            ),
            data.parts.some((p) => p.deleted) &&
              h(
                Chip,
                {
                  on: filter.deleted,
                  onClick: () => setFilter({ ...filter, deleted: !filter.deleted }),
                  title: "看删掉的条目，能把它们恢复",
                },
                `已删除 ${data.parts.filter((p) => p.deleted).length}`,
              ),
          ),
          h(
            "div",
            { className: "sp-note" },
            `${rows.length} 条`,
            lowCount > 0 && h("span", { className: "sp-low-text" }, ` · ${lowCount} 条库存不足`),
            data.meta.checks?.length
              ? ` · 最近一次盘点 ${fmtDay(data.meta.checks[data.meta.checks.length - 1].at)}`
              : "",
          ),
          h(
            "div",
            { className: "sp-table" },
            h(
              "div",
              { className: "sp-th" },
              h("span", { className: "sp-c-seq" }, "序号"),
              h("span", { className: "sp-c-name" }, "名称"),
              h("span", { className: "sp-c-sku" }, "SKU"),
              h("span", { className: "sp-c-spec" }, "规格"),
              h("span", { className: "sp-c-cat" }, "分类"),
              h("span", { className: "sp-c-qty" }, "库存"),
              h("span", { className: "sp-c-used" }, "最近使用"),
              h("span", { className: "sp-c-act" }, ""),
            ),
            rows.length === 0 &&
              h(
                "div",
                { className: "sp-emptyrow" },
                filter.deleted
                  ? "没有删除的条目"
                  : filter.q || filter.status || filter.categories.length
                    ? "没有符合条件的备件"
                    : "还没有备件 —— 点右上「新增」，或用「从发货单导入」",
              ),
            rows.map((r) =>
              h(
                "div",
                { key: r.id, className: `sp-tr${r.archived ? " sp-archived" : ""}${r.low ? " sp-rowlow" : ""}${r.deleted ? " sp-deleted" : ""}` },
                h("span", { className: "sp-c-seq sp-mono" }, r.seq),
                h(
                  "span",
                  { className: "sp-c-name", title: r.note || undefined },
                  r.name,
                  r.low && h("span", { className: "sp-tag sp-tag-low" }, "不足"),
                  r.archived && h("span", { className: "sp-tag" }, "已归档"),
                  r.deleted && h("span", { className: "sp-tag sp-tag-del" }, "已删除"),
                ),
                h("span", { className: "sp-c-sku sp-mono" }, r.sku || "—"),
                h("span", { className: "sp-c-spec sp-dim" }, r.spec || "—"),
                h(
                  "span",
                  { className: "sp-c-cat", title: r.location ? `位置：${r.location}` : undefined },
                  r.category || "—",
                  r.location && h("span", { className: "sp-dim" }, ` · ${r.location}`),
                ),
                h(
                  "span",
                  { className: "sp-c-qty sp-mono" },
                  r.qty,
                  h("span", { className: "sp-dim" }, ` ${r.unit}`),
                ),
                h("span", { className: "sp-c-used sp-dim" }, r.lastUsedAt ? `${fmtDay(r.lastUsedAt)}（${r.useCount}）` : "从未使用"),
                h(
                  "span",
                  { className: "sp-c-act" },
                  r.deleted
                    ? h(Btn, { small: true, onClick: () => setDialog({ kind: "restore", part: r }) }, "恢复")
                    : h(
                        React.Fragment,
                        null,
                        !r.archived && h(Btn, { small: true, onClick: () => setDialog({ kind: "use", part: r }) }, "使用"),
                        h(Btn, { small: true, onClick: () => setDialog({ kind: "receive", part: r }) }, "入库"),
                        h(Btn, { small: true, onClick: () => setDialog({ kind: "edit", part: r }) }, "编辑"),
                      ),
                  h(Btn, { small: true, onClick: () => setDialog({ kind: "history", part: r }) }, "…"),
                ),
              ),
            ),
          ),
        ),

      tab === "logs" && h(Logs, { data, me }),
      tab === "imports" &&
        h(ImportHistory, { data, h, onClose: () => setTab("parts"), commit }),

      tab === "feishu" && h(FeishuPane, { data, me, reload }),

      dialog?.kind === "use" && h(UseDialog, { part: dialog.part, data, api, me, React, h, onClose: () => setDialog(null), commit }),
      dialog?.kind === "receive" && h(ReceiveDialog, { part: dialog.part, api, React, h, onClose: () => setDialog(null), commit }),
      dialog?.kind === "edit" && h(EditDialog, { part: dialog.part, data, React, h, onClose: () => setDialog(null), commit }),
      dialog?.kind === "check" && h(CheckDialog, { data, React, h, me, onClose: () => setDialog(null), commit, initialFilter: filter }),
      dialog?.kind === "history" && h(HistoryDialog, { part: dialog.part, data, React, h, onClose: () => setDialog(null) }),
      dialog?.kind === "restore" &&
        h(
          Dialog,
          {
            title: `恢复「${dialog.part.seq} ${dialog.part.name}」`,
            onClose: () => setDialog(null),
            footer: [
              h(Btn, { key: "c", onClick: () => setDialog(null) }, "取消"),
              h(
                Btn,
                {
                  key: "ok",
                  kind: "primary",
                  onClick: () => void commit((d) => Model.applyRestore(d, dialog.part.id, who())),
                },
                "恢复",
              ),
            ],
          },
          h(
            "div",
            { className: "sp-hint" },
            "恢复之后条目重新出现在清单里，但库存是 0 —— 之前的库存已经在删除时清零了，需要用「入库」加回来。",
          ),
        ),
      dialog?.kind === "import" && h(ImportDialog, { data, api, React, h, me, onClose: () => setDialog(null), commit }),
    );
  }

  /* ---------------- 使用 ---------------- */

  function UseDialog({ part, data, api, me, React, h, onClose, commit }) {
    const [qty, setQty] = useState(1);
    const [entityId, setEntityId] = useState(() => data.entities.find((e) => !e.archived)?.id ?? null);
    const [newEntity, setNewEntity] = useState("");
    const [personId, setPersonId] = useState(null);
    const [note, setNote] = useState("");
    const people = api.data.people.list();

    // 新建设备和扣库存在同一次写入里：要么都成，要么都不成
    const submit = () =>
      commit((d) => {
        let target = entityId;
        let next = d;
        if (!target && newEntity.trim()) {
          const created = Model.applyEntityCreate(d, { name: newEntity }, who());
          next = created.data;
          target = created.entity.id;
        }
        return Model.applyUse(next, { partId: part.id, qty, entityId: target, personId, note }, who());
      });

    return h(
      Dialog,
      {
        title: `使用 · ${part.name}（当前 ${part.qty} ${part.unit}）`,
        onClose,
        footer: [
          h(Btn, { key: "c", onClick: onClose }, "取消"),
          h(Btn, { key: "ok", kind: "primary", onClick: () => void submit() }, "确认使用"),
        ],
      },
      h(Field, { label: "数量" }, h("input", { type: "number", min: 1, className: "sp-input", value: qty, onChange: (e) => setQty(e.target.value) })),
      h(
        Field,
        { label: "用在哪台设备（必填）", hint: "选不到就写个新名字，会当场建一个" },
        h(
          "select",
          { className: "sp-input", value: entityId ?? "", onChange: (e) => setEntityId(e.target.value || null) },
          h("option", { value: "" }, "未选择"),
          data.entities.filter((e) => !e.archived).map((e) => h("option", { key: e.id, value: e.id }, e.name)),
        ),
        !entityId &&
          h("input", {
            className: "sp-input sp-mt",
            placeholder: "或者新建设备，如 Robot1",
            value: newEntity,
            onChange: (e) => setNewEntity(e.target.value),
          }),
      ),
      h(
        Field,
        { label: "领用人" },
        h(
          "select",
          { className: "sp-input", value: personId ?? "", onChange: (e) => setPersonId(e.target.value ? Number(e.target.value) : null) },
          h("option", { value: "" }, "未指定"),
          people.map((p) => h("option", { key: p.id, value: p.id }, p.name)),
        ),
      ),
      h(Field, { label: "备注" }, h("input", { className: "sp-input", value: note, onChange: (e) => setNote(e.target.value) })),
      h("div", { className: "sp-hint" }, Number(qty) > part.qty ? `库存只有 ${part.qty}，不能扣成负数` : `使用后剩余 ${part.qty - (Number(qty) || 0)}`),
    );
  }

  /* ---------------- 入库 ---------------- */

  function ReceiveDialog({ part, React, h, onClose, commit }) {
    const [qty, setQty] = useState(1);
    const [note, setNote] = useState("");
    return h(
      Dialog,
      {
        title: `入库 · ${part.name}（当前 ${part.qty} ${part.unit}）`,
        onClose,
        footer: [
          h(Btn, { key: "c", onClick: onClose }, "取消"),
          h(Btn, { key: "ok", kind: "primary", onClick: () => void commit((d) => Model.applyReceive(d, { partId: part.id, qty, note }, who())) }, "确认入库"),
        ],
      },
      h(Field, { label: "数量" }, h("input", { type: "number", min: 1, className: "sp-input", value: qty, onChange: (e) => setQty(e.target.value) })),
      h(Field, { label: "备注" }, h("input", { className: "sp-input", value: note, onChange: (e) => setNote(e.target.value) })),
    );
  }

  /* ---------------- 新建 / 编辑 ---------------- */

  const emptyDraft = { name: "", sku: "", spec: "", category: "", location: "", unit: "个", qty: 0, minQty: "", note: "" };

  function EditDialog({ part, data, React, h, onClose, commit }) {
    const [draft, setDraft] = useState(() => ({
      ...emptyDraft,
      ...(part
        ? { name: part.name, sku: part.sku, spec: part.spec, category: part.category, location: part.location ?? "", unit: part.unit, qty: part.qty, minQty: part.minQty ?? "", note: part.note }
        : {}),
    }));
    const set = (k) => (e) => setDraft({ ...draft, [k]: e.target.value });
    const isNew = !part;

    return h(
      Dialog,
      {
        title: isNew ? "新增备件" : `编辑 · ${part.name}`,
        onClose,
        footer: [
          part &&
            h(Btn, { key: "arch", onClick: () => void commit((d) => Model.applyUpdate(d, part.id, { archived: !part.archived }, who())) }, part.archived ? "取消归档" : "归档"),
          part &&
            h(
              Btn,
              {
                key: "del",
                kind: "danger",
                onClick: () => {
                  const ok = window.confirm(
                    `删除「${part.name}」？\n\n库存 ${part.qty} ${part.unit} 会清零并记一条日志。` +
                      "条目不会真的消失，在「已删除」里能找回来（库存不会跟着回来）。",
                  );
                  if (ok) void commit((d) => Model.applyDelete(d, part.id, who()));
                },
              },
              "删除",
            ),
          h("span", { key: "sp", className: "sp-push" }),
          h(Btn, { key: "c", onClick: onClose }, "取消"),
          h(
            Btn,
            {
              key: "ok",
              kind: "primary",
              onClick: () =>
                void commit((d) =>
                  isNew
                    ? Model.applyCreate(d, { ...draft, qty: Number(draft.qty) || 0, minQty: draft.minQty === "" ? null : Number(draft.minQty) }, who())
                    : Model.applyUpdate(d, part.id, {
                        ...draft,
                        minQty: draft.minQty === "" ? null : Number(draft.minQty),
                        qty: undefined,
                      }, who()),
                ),
            },
            isNew ? "创建" : "保存",
          ),
        ],
      },
      h(Field, { label: "名称" }, h("input", { className: "sp-input", value: draft.name, onChange: set("name"), autoFocus: true })),
      h(Field, { label: "SKU / 物料号" }, h("input", { className: "sp-input", onChange: set("sku"), value: draft.sku })),
      h(Field, { label: "规格" }, h("input", { className: "sp-input", value: draft.spec, onChange: set("spec") })),
      h(Field, { label: "分类" }, h("input", { className: "sp-input", value: draft.category, onChange: set("category") })),
      h(Field, { label: "位置" }, h("input", { className: "sp-input", value: draft.location, onChange: set("location") })),
      h(Field, { label: "单位" }, h("input", { className: "sp-input", value: draft.unit, onChange: set("unit") })),
      isNew &&
        h(Field, { label: "初始库存", hint: "会写一条「新建」日志" }, h("input", { type: "number", min: 0, className: "sp-input", value: draft.qty, onChange: set("qty") })),
      h(Field, { label: "安全库存", hint: "库存 ≤ 这个数时标「不足」" }, h("input", { type: "number", min: 0, className: "sp-input", value: draft.minQty, onChange: set("minQty") })),
      h(Field, { label: "备注" }, h("input", { className: "sp-input", value: draft.note, onChange: set("note") })),
      !isNew && h("div", { className: "sp-hint" }, "库存不在这里改：加减库存走「入库」「使用」「盘点」，每条都会留日志。"),
      part?.fields?.length > 0 &&
        h(
          "div",
          { className: "sp-custom" },
          h("div", { className: "sp-field-label" }, "自定义列（来自发货单）"),
          part.fields.map((f, i) =>
            h(
              "div",
              { key: i, className: "sp-custom-row" },
              h("input", {
                className: "sp-input",
                value: f.label,
                title: "列名可以改",
                onChange: (e) =>
                  void commit(
                    (d) =>
                      Model.applyUpdate(d, part.id, {
                        fields: part.fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                      }, who()),
                    false,
                  ),
              }),
              h("span", { className: "sp-dim sp-flex" }, f.value),
            ),
          ),
        ),
    );
  }

  /* ---------------- 盘点 ---------------- */

  function CheckDialog({ data, React, h, me, onClose, commit }) {
    const rows = Model.sortParts(Model.filterParts(Model.decorate(data), { ...emptyFilter() }));
    const [counts, setCounts] = useState({});
    const [note, setNote] = useState("");
    const filled = rows.filter((r) => counts[r.id] != null && counts[r.id] !== "");
    const diffs = filled.map((r) => ({ r, d: Number(counts[r.id]) - r.qty }));
    const gain = diffs.filter((x) => x.d > 0).length;
    const loss = diffs.filter((x) => x.d < 0).length;

    return h(
      Dialog,
      {
        title: "盘点",
        wide: true,
        onClose,
        footer: [
          h("span", { key: "sum", className: "sp-dim" }, `已填 ${filled.length} / ${rows.length} 条 · 盘盈 ${gain} · 盘亏 ${loss}`),
          h("span", { key: "sp", className: "sp-push" }),
          h(Btn, { key: "c", onClick: onClose }, "取消"),
          h(
            Btn,
            {
              key: "ok",
              kind: "primary",
              disabled: filled.length === 0,
              onClick: () =>
                void commit((d) =>
                  Model.applyCheck(d, {
                    lines: filled.map((r) => ({ partId: r.id, countedQty: Number(counts[r.id]) })),
                    note,
                    scope: { kind: "all" },
                  }, who()),
                ),
            },
            "确认盘点",
          ),
        ],
      },
      h("div", { className: "sp-hint" }, "只填实盘数，系统库存只读。确认后库存直接改成实盘数；没填的行不动。"),
      h(
        "div",
        { className: "sp-check-table" },
        h(
          "div",
          { className: "sp-th" },
          h("span", { className: "sp-c-seq" }, "序号"),
          h("span", { className: "sp-c-name" }, "名称"),
          h("span", { className: "sp-c-qty" }, "系统"),
          h("span", { className: "sp-c-qty" }, "实盘"),
          h("span", { className: "sp-c-qty" }, "盈亏"),
        ),
        rows.map((r) => {
          const c = counts[r.id];
          const d = c == null || c === "" ? null : Number(c) - r.qty;
          return h(
            "div",
            { key: r.id, className: "sp-tr" },
            h("span", { className: "sp-c-seq sp-mono" }, r.seq),
            h("span", { className: "sp-c-name" }, r.name),
            h("span", { className: "sp-c-qty sp-mono sp-dim" }, r.qty),
            h("span", { className: "sp-c-qty" },
              h("input", {
                type: "number",
                min: 0,
                className: "sp-input sp-qty",
                value: c ?? "",
                placeholder: String(r.qty),
                onChange: (e) => setCounts({ ...counts, [r.id]: e.target.value }),
              }),
            ),
            h("span", { className: `sp-c-qty sp-mono ${d > 0 ? "sp-gain" : d < 0 ? "sp-loss" : ""}` }, d == null ? "" : d > 0 ? `+${d}` : String(d)),
          );
        }),
      ),
      h(Field, { label: "盘点说明" }, h("input", { className: "sp-input", value: note, onChange: (e) => setNote(e.target.value) })),
    );
  }

  /* ---------------- 单条历史 ---------------- */

  function HistoryDialog({ part, data, React, h, onClose }) {
    const logs = Model.filterLogs(data.logs, { partId: part.id });
    return h(
      Dialog,
      { title: `变更记录 · ${part.seq} ${part.name}`, wide: true, onClose },
      logs.length === 0
        ? h("div", { className: "sp-hint" }, "还没有记录")
        : logs.map((l) =>
            h(
              "div",
              { key: l.id, className: "sp-logrow" },
              h("span", { className: "sp-log-type" }, TYPE_LABEL[l.type] ?? l.type),
              h("span", { className: "sp-mono" }, `${l.before} → ${l.after}（${l.qty >= 0 ? "+" : ""}${l.qty}）`),
              h("span", { className: "sp-dim" }, l.entityName || "—"),
              h("span", { className: "sp-dim" }, l.by || ""),
              h("span", { className: "sp-dim sp-mono" }, fmtTime(l.at)),
              l.note && h("span", { className: "sp-log-note" }, l.note),
            ),
          ),
    );
  }

  /* ---------------- 日志页 ---------------- */

  function Logs({ data, me }) {
    const [filter, setFilter] = useState({ entityId: "", partId: "", types: [], from: "", to: "" });
    const logs = Model.filterLogs(data.logs, { ...filter, entityId: filter.entityId || undefined, partId: filter.partId || undefined });
    const partName = new Map(data.parts.map((p) => [p.id, p.deleted ? `${p.seq} ${p.name}（已删除）` : `${p.seq} ${p.name}`]));
    const personName = new Map(api.data.people.list().map((p) => [p.id, p.name]));
    return h(
      "div",
      { className: "sp-logs" },
      h(
        "div",
        { className: "sp-filters" },
        h(
          "select",
          { className: "sp-select", value: filter.partId, onChange: (e) => setFilter({ ...filter, partId: e.target.value }) },
          h("option", { value: "" }, "全部备件"),
          data.parts.map((p) => h("option", { key: p.id, value: p.id }, `${p.seq} ${p.name}`)),
        ),
        h(
          "select",
          { className: "sp-select", value: filter.entityId, onChange: (e) => setFilter({ ...filter, entityId: e.target.value }) },
          h("option", { value: "" }, "全部设备"),
          data.entities.map((e) => h("option", { key: e.id, value: e.id }, e.name)),
        ),
        h(
          "select",
          {
            className: "sp-select",
            value: filter.types[0] ?? "",
            onChange: (e) => setFilter({ ...filter, types: e.target.value ? [e.target.value] : [] }),
          },
          h("option", { value: "" }, "全部类型"),
          Object.entries(TYPE_LABEL).map(([k, v]) => h("option", { key: k, value: k }, v)),
        ),
        h("input", { type: "date", className: "sp-select", value: filter.from, onChange: (e) => setFilter({ ...filter, from: e.target.value }) }),
        h("span", { className: "sp-dim" }, "至"),
        h("input", { type: "date", className: "sp-select", value: filter.to, onChange: (e) => setFilter({ ...filter, to: e.target.value }) }),
        h("span", { className: "sp-push" }),
        h(Btn, { small: true, onClick: () => void exportLogs(data, logs, personName) }, "导出"),
      ),
      h(
        "div",
        { className: "sp-table" },
        h(
          "div",
          { className: "sp-th" },
          h("span", { className: "sp-l-type" }, "类型"),
          h("span", { className: "sp-l-part" }, "备件"),
          h("span", { className: "sp-l-entity" }, "设备"),
          h("span", { className: "sp-l-qty" }, "数量"),
          h("span", { className: "sp-l-change" }, "库存变化"),
          h("span", { className: "sp-l-who" }, "领用人 / 操作人"),
          h("span", { className: "sp-l-at" }, "时间"),
        ),
        logs.length === 0 && h("div", { className: "sp-emptyrow" }, "没有符合条件的记录"),
        logs.map((l) =>
          h(
            "div",
            { key: l.id, className: "sp-tr" },
            h("span", { className: "sp-l-type" }, TYPE_LABEL[l.type] ?? l.type),
            h("span", { className: "sp-l-part" }, partName.get(l.partId) ?? "（已删除）"),
            h("span", { className: "sp-l-entity sp-dim" }, l.entityName || "—"),
            h("span", { className: `sp-l-qty sp-mono ${l.qty < 0 ? "sp-loss" : "sp-gain"}` }, `${l.qty >= 0 ? "+" : ""}${l.qty}`),
            h("span", { className: "sp-l-change sp-mono sp-dim" }, `${l.before} → ${l.after}`),
            h(
              "span",
              { className: "sp-l-who sp-dim" },
              [personName.get(l.personId), l.by].filter(Boolean).join(" / ") || "—",
            ),
            h("span", { className: "sp-l-at sp-mono sp-dim" }, fmtTime(l.at)),
          ),
        ),
      ),
    );
  }

  /** 当前筛选结果导出成 Markdown 表格（.md 或 Word），给周报和飞书粘贴用 */
  function exportLogs(data, logs, personName) {
    const partName = new Map(data.parts.map((p) => [p.id, `${p.seq} ${p.name}`]));
    const cell = (s) => String(s ?? "").split("|").join("\\|").split("\n").join(" ");
    const rows = logs.map((l) =>
      [
        fmtTime(l.at),
        l.entityName || "—",
        partName.get(l.partId) ?? "（已删除）",
        TYPE_LABEL[l.type] ?? l.type,
        `${l.qty >= 0 ? "+" : ""}${l.qty}`,
        `${l.before} → ${l.after}`,
        personName.get(l.personId) ?? "",
        l.by,
        l.note,
      ].map(cell).join(" | "),
    );
    const md = [
      `# 库存变更日志 · ${api.data.project()?.name ?? ""}`,
      "",
      "| 时间 | 设备 | 备件 | 类型 | 数量 | 库存变化 | 领用人 | 操作人 | 备注 |",
      "|---|---|---|---|---|---|---|---|---|",
      ...rows.map((r) => `| ${r} |`),
    ].join("\n");
    return api.export.document({ markdown: md, title: "库存变更日志", format: "md", fileName: "库存变更日志" }).catch(() => {});
  }

  /* ---------------- 飞书同步 ---------------- */

  const feishuStore = (projectId) => `feishu-${projectId}.json`;
  const emptyFeishu = () => ({
    baseToken: "",
    partsTableId: "",
    logsTableId: "",
    parts: {},
    logs: {},
    lastSyncAt: null,
  });

  /** lark-cli 的 JSON 信封：成功 `{ok:true,data}`，失败 `{ok:false,error}` */
  const parseLarkJson = (text) => {
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      const raw = String(text ?? "").trim();
      return { ok: false, error: raw.slice(0, 300) || "lark-cli 没有输出" };
    }
    if (j && j.ok === false) {
      const e = j.error ?? {};
      return { ok: false, error: [e.message, e.hint].filter(Boolean).join("\n") || "lark-cli 报错" };
    }
    return { ok: true, data: j?.data ?? j };
  };

  /** 裸调一条 OpenAPI。用 `lark-cli api` 而不是 base 子命令：建表 / 批量写记录的参数以官方接口为准 */
  const lark = async (method, path, { data, params } = {}) => {
    const args = ["api", method, path, "--as", "user"];
    if (params) args.push("--params", JSON.stringify(params));
    if (data) args.push("--data", JSON.stringify(data));
    const r = await api.proc.exec("lark-cli", args);
    const out = parseLarkJson(r.stdout || r.stderr);
    if (!out.ok) throw new Error(out.error);
    return out.data;
  };

  /** `/base/xxx` 或 `/wiki/xxx` 链接 → base token；wiki 要再解析一层 */
  const baseTokenOf = async (link) => {
    const s = String(link ?? "").trim();
    const base = /\/base\/([A-Za-z0-9]+)/.exec(s);
    if (base) return base[1];
    const wiki = /\/wiki\/([A-Za-z0-9]+)/.exec(s);
    if (wiki) {
      const d = await lark("GET", `/open-apis/wiki/v2/spaces/get_node`, {
        params: { token: wiki[1], obj_type: "wiki" },
      });
      const node = d?.node ?? d;
      if (node?.obj_type !== "bitable") throw new Error(`这个知识库节点是 ${node?.obj_type ?? "未知类型"}，不是多维表格`);
      return node.obj_token;
    }
    if (/^[A-Za-z0-9]{20,}$/.test(s)) return s;
    throw new Error("看不懂这个链接：贴多维表格的地址，形如 https://xxx.feishu.cn/base/<token>");
  };

  const listFeishuTables = async (baseToken) => {
    const d = await lark("GET", `/open-apis/bitable/v1/apps/${baseToken}/tables`, { params: { page_size: 100 } });
    return (d?.items ?? []).map((t) => ({ id: t.table_id, name: t.name }));
  };

  const tableFields = (defs, linkTableId) =>
    defs.map((f) =>
      f.type === FT.link
        ? { field_name: f.name, type: FT.link, property: { table_id: linkTableId } }
        : { field_name: f.name, type: f.type },
    );

  /** 在用户给的 Base 里建两张表：备件表、库存变更日志表（日志表的「备件」是关联到备件表） */
  const createFeishuTables = async (baseToken) => {
    const parts = await lark("POST", `/open-apis/bitable/v1/apps/${baseToken}/tables`, {
      data: { table: { name: "备件清单", default_view_name: "表格", fields: tableFields(PARTS_FIELDS) } },
    });
    const partsTableId = parts?.table_id;
    if (!partsTableId) throw new Error("建备件表没有返回 table_id");
    const logs = await lark("POST", `/open-apis/bitable/v1/apps/${baseToken}/tables`, {
      data: {
        table: { name: "库存变更日志", default_view_name: "表格", fields: tableFields(LOGS_FIELDS, partsTableId) },
      },
    });
    return { partsTableId, logsTableId: logs?.table_id ?? "" };
  };

  /**
   * 拿已有表里的 gantt_part_id / gantt_log_id 重建映射。
   * 不这么做的话，关联一张已经有数据的表会再建一遍同样的行。
   */
  const adoptFeishuTable = async (baseToken, tableId, idField) => {
    const map = {};
    let pageToken;
    for (let i = 0; i < 200; i++) {
      const d = await lark("GET", `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records`, {
        params: pageToken ? { page_size: 500, page_token: pageToken } : { page_size: 500 },
      });
      for (const rec of d?.items ?? []) {
        const raw = rec?.fields?.[idField];
        // 文本单元格读回来是 [{text}] 数组
        const id = Array.isArray(raw) ? raw.map((x) => x?.text ?? "").join("") : raw;
        if (id) map[String(id)] = rec.record_id;
      }
      if (!d?.has_more || !d.page_token) break;
      pageToken = d.page_token;
    }
    return map;
  };

  /**
   * 批量写记录。**按字节切块**：lark-cli 在 Windows 上可能是 .cmd，
   * 走 cmd.exe 时命令行只有 8K 左右，一次塞几百条会直接失败。
   */
  const chunksByBytes = (items, toBody, limit = 6000) => {
    const out = [];
    let cur = [];
    let size = 0;
    for (const it of items) {
      const n = JSON.stringify(toBody([it])).length;
      if (cur.length && size + n > limit) {
        out.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(it);
      size += n;
    }
    if (cur.length) out.push(cur);
    return out;
  };

  const batchCreate = async (baseToken, tableId, rows) => {
    const ids = [];
    for (const chunk of chunksByBytes(rows, (xs) => ({ records: xs.map((r) => ({ fields: r.fields })) }))) {
      const d = await lark("POST", `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records/batch_create`, {
        data: { records: chunk.map((r) => ({ fields: r.fields })) },
      });
      const got = (d?.records ?? []).map((r) => r.record_id ?? r.id);
      // 返回顺序与请求一致；万一条数对不上就按位置尽量对，剩下的留给下一轮（不会重复写：下一轮还是按 gantt id 判重）
      chunk.forEach((r, i) => ids.push({ row: r, recordId: got[i] ?? null }));
    }
    return ids;
  };

  const batchUpdate = async (baseToken, tableId, pairs) => {
    for (const chunk of chunksByBytes(pairs, (xs) => ({ records: xs.map((p) => ({ record_id: p.recordId, fields: p.row.fields })) }))) {
      await lark("POST", `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records/batch_update`, {
        data: { records: chunk.map((p) => ({ record_id: p.recordId, fields: p.row.fields })) },
      });
    }
  };

  function FeishuPane({ data, me, reload }) {
    const project = api.data.project();
    const [state, setState] = useState(null);
    const [link, setLink] = useState("");
    const [tables, setTables] = useState(null);
    const [busy, setBusy] = useState(false);
    const [log, setLog] = useState([]);
    const [err, setErr] = useState(null);
    const name = project ? feishuStore(project.id) : null;

    useEffect(() => {
      let live = true;
      if (!name) return;
      void api.storage
        .read(name)
        .then((raw) => {
          if (!live) return;
          try {
            setState({ ...emptyFeishu(), ...(raw ? JSON.parse(raw) : {}) });
          } catch {
            setState(emptyFeishu());
          }
        })
        .catch(() => live && setState(emptyFeishu()));
      return () => {
        live = false;
      };
    }, [name]);

    const saveState = async (next) => {
      setState(next);
      if (name) await api.storage.write(name, JSON.stringify(next));
    };

    const note = (m) => setLog((l) => [...l.slice(-60), m]);

    const resolve = async () => {
      setBusy(true);
      setErr(null);
      setLog([]);
      try {
        const baseToken = await baseTokenOf(link);
        const list = await listFeishuTables(baseToken);
        setTables(list);
        note(`这个多维表格里有 ${list.length} 张表`);
      } catch (e) {
        setErr(String(e.message ?? e));
      } finally {
        setBusy(false);
      }
    };

    const provision = async () => {
      setBusy(true);
      setErr(null);
      try {
        const baseToken = await baseTokenOf(link);
        note("正在建两张表…");
        const made = await createFeishuTables(baseToken);
        await saveState({ ...emptyFeishu(), baseToken, ...made });
        note("建好了：备件清单、库存变更日志（后者用关联字段指向备件）");
      } catch (e) {
        setErr(String(e.message ?? e));
      } finally {
        setBusy(false);
      }
    };

    const adopt = async (partsTableId, logsTableId) => {
      setBusy(true);
      setErr(null);
      try {
        const baseToken = await baseTokenOf(link);
        note("正在读已有表里的记录…");
        const parts = await adoptFeishuTable(baseToken, partsTableId, "gantt_part_id");
        const logs = logsTableId ? await adoptFeishuTable(baseToken, logsTableId, "gantt_log_id") : {};
        const next = { ...emptyFeishu(), baseToken, partsTableId, logsTableId: logsTableId ?? "" };
        for (const [partId, recordId] of Object.entries(parts)) next.parts[partId] = { recordId, fingerprint: "" };
        for (const [logId, recordId] of Object.entries(logs)) next.logs[logId] = recordId;
        await saveState(next);
        note(`认出了 ${Object.keys(parts).length} 条备件、${Object.keys(logs).length} 条日志；之后的同步会更新它们，不再重复建`);
      } catch (e) {
        setErr(String(e.message ?? e));
      } finally {
        setBusy(false);
      }
    };

    const sync = async () => {
      if (!state?.partsTableId) return;
      setBusy(true);
      setErr(null);
      setLog([]);
      try {
        let st = { ...state };
        const { baseToken, partsTableId, logsTableId } = st;

        note("备件：比对中…");
        const plan = planSync(data, st, { full: false });
        // 1) 新建备件行
        if (plan.partsCreate.length) {
          const made = await batchCreate(
            baseToken,
            partsTableId,
            plan.partsCreate.map((x) => x.row),
          );
          // batchCreate 按请求顺序返回；第 i 条就是 plan.partsCreate[i] 那一行
          const pairs = made
            .map((m, i) => (m.recordId ? { partId: plan.partsCreate[i].partId, recordId: m.recordId, row: plan.partsCreate[i].row } : null))
            .filter(Boolean);
          st = rememberParts(st, pairs, []);
          note(`备件：新建 ${pairs.length} 行`);
        }
        // 2) 更新有变化的备件行
        if (plan.partsUpdate.length) {
          await batchUpdate(baseToken, partsTableId, plan.partsUpdate);
          st = rememberParts(
            st,
            [],
            plan.partsUpdate.map((u) => ({ partId: u.partId, recordId: u.recordId, row: u.row })),
          );
          note(`备件：更新 ${plan.partsUpdate.length} 行`);
        }

        // 3) 日志：备件行有了 record_id 之后才算得出来
        if (logsTableId) {
          const { logsCreate, skippedLogs } = planSync(data, st, {});
          if (logsCreate.length) {
            const rows = logsCreate.map((x) => x.row);
            const made = await batchCreate(baseToken, logsTableId, rows);
            const pairs = made
              .map((m, i) => (m.recordId ? { logId: logsCreate[i].log.id, recordId: m.recordId } : null))
              .filter(Boolean);
            st = rememberLogs(st, pairs);
            note(`日志：新建 ${pairs.length} 条`);
          }
          if (skippedLogs.length) note(`日志：${skippedLogs.length} 条等备件行建好后再传`);
        }

        st.lastSyncAt = new Date().toISOString();
        await saveState(st);
        note("同步完成");
      } catch (e) {
        setErr(String(e.message ?? e));
      } finally {
        setBusy(false);
      }
    };

    if (!state) return h("div", { className: "sp-hint" }, "读取中…");

    const ready = state.partsTableId;

    return h(
      "div",
      { className: "sp-feishu" },
      h(
        "p",
        { className: "sp-hint" },
        "把这份备件同步到飞书多维表格：备件表按序号/SKU 匹配更新，日志表只追加，不删除你那边已有的行。只推不拉 —— 飞书里改了不会回写到本地。",
      ),

      !ready &&
        h(
          React.Fragment,
          null,
          h(Field, { label: "多维表格链接", hint: "贴 /base/… 或 /wiki/… 的地址，必须对它有编辑权限" },
            h("input", { className: "sp-input", value: link, onChange: (e) => setLink(e.target.value), placeholder: "https://xxx.feishu.cn/base/…" }),
          ),
          h(
            "div",
            { className: "sp-row" },
            h(Btn, { onClick: () => void resolve(), disabled: busy || !link.trim() }, busy ? "查询中…" : "查看里面的表"),
            h(Btn, { kind: "primary", onClick: () => void provision(), disabled: busy || !link.trim() }, "自动建两张表"),
          ),
          tables &&
            h(
              "div",
              { className: "sp-tables" },
              h("div", { className: "sp-field-label" }, "或者关联已有的表"),
              h(
                "p",
                { className: "sp-hint" },
                "表里要有 gantt_part_id / gantt_log_id 这两列（隐藏列也行），否则认不出哪些行是这个插件写的。",
              ),
              tables.map((t) =>
                h(
                  "div",
                  { key: t.id, className: "sp-tablerow" },
                  h("span", { className: "sp-flex" }, t.name),
                  h("span", { className: "sp-dim sp-mono" }, t.id),
                  h(Btn, { small: true, disabled: busy, onClick: () => void adopt(t.id, "") }, "用作备件表"),
                ),
              ),
            ),
        ),

      ready &&
        h(
          React.Fragment,
          null,
          h(
            "div",
            { className: "sp-fs-summary" },
            h("div", null, h("span", { className: "sp-field-label" }, "备件表"), h("span", { className: "sp-mono sp-dim" }, ` ${state.partsTableId}`)),
            h("div", null, h("span", { className: "sp-field-label" }, "日志表"), h("span", { className: "sp-mono sp-dim" }, ` ${state.logsTableId || "（没设）"}`)),
            h("div", { className: "sp-dim" }, state.lastSyncAt ? `上次同步 ${fmtTime(state.lastSyncAt)}` : "还没同步过"),
          ),
          h(
            "div",
            { className: "sp-row" },
            h(Btn, { kind: "primary", onClick: () => void sync(), disabled: busy }, busy ? "同步中…" : "同步"),
            h(Btn, { onClick: () => void saveState({ ...emptyFeishu() }), disabled: busy }, "重新设置"),
          ),
          h("p", { className: "sp-hint" }, "新建的行不会重复：按 gantt_part_id / gantt_log_id 认出已经写过的那一行。"),
        ),

      err && h("div", { className: "sp-error" }, err),
      log.length > 0 && h("div", { className: "sp-fs-log" }, log.map((m, i) => h("div", { key: i }, m))),
    );
  }

  /* ---------------- 从发货单导入 ---------------- */

  /**
   * 识别入口：用户把发货单的文字粘贴进来（拍照识别的 Skill 见 skill/）。
   * 结构化输出交给宿主 ai.ask + JSON Schema，AI 只加自定义列，不改核心列。
   */
  /* ---------------- 导入批次（撤销 / 核对） ---------------- */

  /**
   * AI 直接写入、没有确认环节，所以「后悔药」必须显眼：
   * 每批导入一条，能整批撤销（写反向调整，不删原日志）。
   */
  function ImportHistory({ data, h, onClose, commit }) {
    const imp = data.imports.slice().reverse();
    return h(
      Dialog,
      { title: "导入批次", onClose },
      imp.length === 0 && h("div", { className: "sp-hint" }, "还没有导入过发货单"),
      imp.map((i) => {
        const n = data.logs.filter((l) => l.importId === i.id && !l.revertedBy).length;
        return h(
          "div",
          { key: i.id, className: "sp-implog" },
          h("div", { className: "sp-implog-head" },
            h("span", null, i.source || i.id),
            h("span", { className: "sp-dim sp-mono" }, fmtTime(i.at)),
            i.revertedAt
              ? h("span", { className: "sp-dim" }, "已撤销")
              : h("span", { className: "sp-dim" }, `${i.count} 条 · 可回退 ${n}`),
          ),
          !i.revertedAt &&
            n > 0 &&
            h(
              Btn,
              {
                small: true,
                onClick: () => {
                  if (!window.confirm(`撤销「${i.source || i.id}」这一整批？会写反向调整日志，原记录保留。`)) return;
                  void commit((d) => Model.revertImport(d, i.id), false);
                },
              },
              "整批撤销",
            ),
          h(
            "details",
            { className: "sp-implog-rows" },
            h("summary", { className: "sp-dim" }, "看这批的每一行"),
            data.logs
              .filter((l) => l.importId === i.id)
              .map((l) =>
                h("div", { key: l.id, className: "sp-implog-row" },
                  h("span", { className: "sp-mono" }, `#${l.seq}`),
                  h("span", { className: "sp-flex" }, l.raw?.name || ""),
                  h("span", { className: "sp-mono" }, `${l.qty >= 0 ? "+" : ""}${l.qty}`),
                  l.confidence != null && h("span", { className: "sp-dim" }, `${Math.round(l.confidence * 100)}%`),
                  l.revertedBy && h("span", { className: "sp-dim" }, "已冲销"),
                ),
              ),
          ),
        );
      }),
    );
  }

  function ImportDialog({ data, api, React, h, me, onClose, commit }) {
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [rows, setRows] = useState(null);
    const [msg, setMsg] = useState(null);
    const [source, setSource] = useState("");

    const parse = async () => {
      setBusy(true);
      setMsg(null);
      try {
        const run = await api.ai.ask(IMPORT_PROMPT(text), { schema: IMPORT_SCHEMA });
        const r = await run.done;
        if (!r.ok) throw new Error(r.error);
        const out = r.structured ?? JSON.parse(r.text);
        if (!out || !Array.isArray(out.items) || out.items.length === 0) {
          throw new Error("没从这段内容里识别出备件");
        }
        setRows(out.items.map((i) => ({ ...i, include: true })));
        setSource(out.source || "");
      } catch (e) {
        setMsg(String(e.message ?? e));
      } finally {
        setBusy(false);
      }
    };

    const doImport = async () => {
      const picked = rows.filter((r) => r.include && r.name?.trim());
      if (!picked.length) return;
      await commit((d) => Model.applyBatch(d, { source: source || "粘贴文本", items: picked }, who()));
    };

    return h(
      Dialog,
      {
        title: "从发货单导入",
        wide: true,
        onClose,
        footer: [
          rows && h("span", { key: "n", className: "sp-dim" }, `选中 ${rows.filter((r) => r.include).length} / ${rows.length}`),
          h("span", { key: "sp", className: "sp-push" }),
          h(Btn, { key: "c", onClick: onClose }, "取消"),
          !rows && h(Btn, { key: "p", kind: "primary", disabled: busy || !text.trim(), onClick: () => void parse() }, busy ? "识别中…" : "识别"),
          rows && h(Btn, { key: "ok", kind: "primary", onClick: () => void doImport() }, "导入"),
        ],
      },
      !rows &&
        h(
          React.Fragment,
          null,
          h(Field, {
            label: "把发货单上的内容贴进来",
            hint: "表格、文字都行。AI 会按核心列拆好，单上没有的列放进自定义列。",
          }, h("textarea", { className: "sp-input sp-textarea", value: text, onChange: (e) => setText(e.target.value), placeholder: "商品名称\t型号\t数量\n伺服电机\tSM-400W\t20\n…" })),
          msg && h("div", { className: "sp-error" }, msg),
        ),
      rows &&
        h(
          "div",
          { className: "sp-table" },
          h(
            "div",
            { className: "sp-th" },
            h("span", { className: "sp-c-check" }, ""),
            h("span", { className: "sp-c-name" }, "名称"),
            h("span", { className: "sp-c-sku" }, "SKU"),
            h("span", { className: "sp-c-spec" }, "规格"),
            h("span", { className: "sp-c-qty" }, "数量"),
          ),
          rows.map((r, i) =>
            h(
              "div",
              { key: i, className: "sp-tr" },
              h("span", { className: "sp-c-check" }, h("input", { type: "checkbox", checked: r.include, onChange: (e) => setRows(rows.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x))) })),
              h("span", { className: "sp-c-name" }, h("input", { className: "sp-input", value: r.name ?? "", onChange: (e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x))) })),
              h("span", { className: "sp-c-sku sp-mono" }, r.sku || "—"),
              h("span", { className: "sp-c-spec sp-dim" }, r.spec || "—"),
              h("span", { className: "sp-c-qty" }, h("input", { type: "number", min: 0, className: "sp-input sp-qty", value: r.qty ?? 1, onChange: (e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x))) })),
            ),
          ),
          msg && h("div", { className: "sp-error" }, msg),
        ),
    );
  }

  api.views.register(
    { type: "spare-parts.view", label: "备件", hint: "备件库存、使用与盘点 —— 每次变动都留日志" },
    Ledger,
  );
}

/* ------------------------------------------------------------------ */
/* AI 识别契约                                                         */
/* ------------------------------------------------------------------ */

const IMPORT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    source: { type: "string", description: "这张单子的单号或来源，没有就留空" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          sku: { type: "string" },
          spec: { type: "string" },
          category: { type: "string" },
          unit: { type: "string" },
          qty: { type: "integer", minimum: 0 },
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: { label: { type: "string" }, value: { type: "string" } },
              required: ["label", "value"],
            },
          },
          confidence: { type: "number" },
        },
        required: ["name", "qty"],
      },
    },
  },
  required: ["items"],
});

const IMPORT_PROMPT = (text) => `你在解析一张备件发货单 / 装箱单，把内容整理成结构化条目。

规则：
1. 一行单据就是一条；同一货号出现多行时合并成一条，数量相加。
2. 数量必须是单上写的数字，不要猜；单价、金额这类单上有的信息放进 fields。
3. 单上明确印着型号 / 物料号才填 sku，否则留空字符串。
4. 看不清的字段留空，不要编造。
5. confidence 表示这条整体可信度（0–1），有猜测的 ≤ 0.5。

单据内容：
"""
${text}
"""`;
