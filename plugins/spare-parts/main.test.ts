import { describe, expect, it } from "vitest";
// 插件是单文件（宿主从 Blob URL 加载，不能 import），这里直接测它导出的纯函数
import { readFileSync } from "node:fs";
import { validateManifest } from "../../sdk/manifest";
import {
  applyBatch,
  applyAdjust,
  applyReceive,
  applyCheck,
  applyCreate,
  applyEntityCreate,
  applyUpdate,
  applyUse,
  checkInvariants,
  decorate,
  EMPTY_DATA,
  filterLogs,
  filterParts,
  nextSeq,
  parseData,
  revertImport,
  sortParts,
} from "./main.js";

/**
 * 备件的台账规则。钉死的是会静默出错的地方：库存和日志能不能对上、
 * 余额不足能不能扣、盘点时「没填」和「填 0」的区别、序号不复用。
 */

const ctx = { by: "张三", at: "2026-10-30T09:00:00.000Z" };
const later = { by: "李四", at: "2026-10-31T09:00:00.000Z" };

function seed({ qty = 5 } = {}) {
  let d = EMPTY_DATA();
  d = applyCreate(d, { name: "伺服电机", sku: "SM-400W", spec: "400W", category: "电机", qty }, ctx);
  const e = applyEntityCreate(d, { name: "Robot1" }, ctx);
  return { data: e.data, part: e.data.parts[0], entity: e.entity };
}

describe("建条目", () => {
  it("序号从 1 递增，归档后新建也不复用", () => {
    let d = EMPTY_DATA();
    d = applyCreate(d, { name: "A", qty: 1 }, ctx);
    d = applyCreate(d, { name: "B", qty: 0 }, ctx);
    expect(d.parts.map((p) => p.seq)).toEqual([1, 2]);
    d = applyUpdate(d, d.parts[1].id, { archived: true }, ctx);
    d = applyCreate(d, { name: "C", qty: 0 }, ctx);
    expect(d.parts.map((p) => p.seq)).toEqual([1, 2, 3]);
    expect(nextSeq(d)).toBe(4);
    // 初始 0 的不写日志，库存也确实是 0
    expect(d.parts[1].qty).toBe(0);
    expect(d.logs.filter((l) => l.partId === d.parts[1].id)).toHaveLength(0);
  });

  it("SKU 重复（不分大小写）拒绝；同名不同 SKU 可以", () => {
    const { data } = seed();
    expect(() => applyCreate(data, { name: "另一个", sku: "sm-400w", qty: 1 }, ctx)).toThrow("已经存在");
    expect(() => applyCreate(data, { name: "伺服电机", qty: 1 }, ctx)).not.toThrow();
  });

  it("名称空、初始库存为负都拒绝", () => {
    expect(() => applyCreate(EMPTY_DATA(), { name: "  ", qty: 1 }, ctx)).toThrow("名称不能为空");
    expect(() => applyCreate(EMPTY_DATA(), { name: "A", qty: -1 }, ctx)).toThrow("初始库存");
  });
});

describe("使用", () => {
  it("扣库存并留一条日志，带设备、领用人、操作人", () => {
    const { data, part, entity } = seed({ qty: 5 });
    const next = applyUse(data, { partId: part.id, qty: 2, entityId: entity.id, personId: 7, note: "换件" }, ctx);
    expect(next.parts[0].qty).toBe(3);
    expect(next.logs.at(-1)).toMatchObject({
      type: "use", qty: -2, before: 5, after: 3, entityName: "Robot1", personId: 7, by: "张三", note: "换件",
    });
    expect(checkInvariants(next)).toEqual([]);
  });

  it("不能扣成负数", () => {
    const { data, part, entity } = seed({ qty: 2 });
    expect(() => applyUse(data, { partId: part.id, qty: 3, entityId: entity.id }, ctx)).toThrow("库存不够");
  });

  it("必须选设备；数量必须是正整数", () => {
    const { data, part, entity } = seed();
    expect(() => applyUse(data, { partId: part.id, qty: 1 }, ctx)).toThrow("设备");
    expect(() => applyUse(data, { partId: part.id, qty: 1.5, entityId: entity.id }, ctx)).toThrow("正整数");
    expect(() => applyUse(data, { partId: part.id, qty: 0, entityId: entity.id }, ctx)).toThrow("正整数");
  });

  it("归档的备件不能再用", () => {
    const { data, part, entity } = seed();
    const d = applyUpdate(data, part.id, { archived: true }, ctx);
    expect(() => applyUse(d, { partId: part.id, qty: 1, entityId: entity.id }, ctx)).toThrow("归档");
  });

  it("同名的设备不重复建", () => {
    let d = EMPTY_DATA();
    const a = applyEntityCreate(d, { name: "Robot1" }, ctx);
    const b = applyEntityCreate(a.data, { name: "robot1" }, ctx);
    expect(b.entity.id).toBe(a.entity.id);
    expect(b.data.entities).toHaveLength(1);
  });
});

describe("入库与调整", () => {
  it("入库加库存；调整可加可减，都留日志", () => {
    const { data, part } = seed({ qty: 1 });
    let next = applyReceive(data, { partId: part.id, qty: 6, note: "补货" }, ctx);
    next = applyAdjust(next, { partId: part.id, delta: -2, note: "发现两个坏的" }, ctx);
    expect(next.parts[0].qty).toBe(5);
    expect(next.logs.map((l) => [l.type, l.qty])).toEqual([["create", 1], ["receive", 6], ["adjust", -2]]);
    expect(checkInvariants(next)).toEqual([]);
  });

  it("调整必须写原因，且不能扣成负数", () => {
    const { data, part } = seed({ qty: 1 });
    expect(() => applyAdjust(data, { partId: part.id, delta: 1 }, ctx)).toThrow("原因");
    expect(() => applyAdjust(data, { partId: part.id, delta: -2, note: "x" }, ctx)).toThrow("负数");
    expect(() => applyAdjust(data, { partId: part.id, delta: 0, note: "x" }, ctx)).toThrow("非零");
  });
});

describe("盘点", () => {
  it("实盘为准：库存直接改成实盘数，差异写一条日志", () => {
    const { data, part } = seed({ qty: 5 });
    const next = applyCheck(data, { lines: [{ partId: part.id, countedQty: 3 }], note: "月度盘点" }, { by: "王五" });
    expect(next.parts[0].qty).toBe(3);
    const log = next.logs.at(-1);
    expect(log).toMatchObject({ type: "check", qty: -2, before: 5, after: 3, by: "王五" });
    const session = next.meta.checks.at(-1);
    expect(session.id).toBe(log.checkId);
    expect(session.summary).toMatchObject({ gain: 0, loss: 1, lossQty: 2 });
    expect(checkInvariants(next)).toEqual([]);
  });

  it("没填的行不动 —— 「没盘」不是「盘了是 0」", () => {
    const { data, part } = seed({ qty: 5 });
    // 一条都没填 → 拒绝；有别的行填着时，空格子那行不动
    expect(() => applyCheck(data, { lines: [{ partId: part.id, countedQty: "" }] }, ctx)).toThrow();
    const other = applyCreate(data, { name: "另一条", qty: 4 }, ctx);
    const next = applyCheck(other, {
      lines: [{ partId: part.id, countedQty: "" }, { partId: other.parts[1].id, countedQty: 4 }],
    }, ctx);
    expect(next.parts[0].qty).toBe(5);
    expect(next.logs.filter((l) => l.type === "check")).toHaveLength(0);
  });

  it("一条都没填就拒绝，不产生空盘点", () => {
    const { data } = seed();
    expect(() => applyCheck(data, { lines: [{ partId: data.parts[0].id, countedQty: "" }] }, ctx)).toThrow("没有任何一条");
  });

  it("实盘等于系统时不写日志，但批次里留一行 0 差异", () => {
    const { data, part } = seed({ qty: 2 });
    const next = applyCheck(data, { lines: [{ partId: part.id, countedQty: 2 }] }, ctx);
    expect(next.logs.filter((l) => l.type === "check")).toHaveLength(0);
    expect(next.meta.checks.at(-1).lines[0]).toMatchObject({ delta: 0, logId: null });
  });

  it("盘点期间发生的使用不算进盘亏：以提交时的系统数为 before", () => {
    const { data, part, entity } = seed({ qty: 5 });
    const afterUse = applyUse(data, { partId: part.id, qty: 2, entityId: entity.id }, ctx); // 3
    const next = applyCheck(afterUse, { lines: [{ partId: part.id, countedQty: 3 }] }, later);
    expect(next.parts[0].qty).toBe(3);
    expect(next.logs.filter((l) => l.type === "check")).toHaveLength(0);
  });
});

describe("撤销导入", () => {
  it("按批次回退入库，原日志保留并记下被哪条冲掉", () => {
    let d = { ...EMPTY_DATA(), imports: [{ id: "imp1", at: ctx.at, by: "张三", source: "发货单1", count: 1 }] };
    d = applyCreate(d, { name: "A", qty: 10, importId: "imp1", sourceFile: "发货单1" }, ctx);
    expect(d.parts[0].qty).toBe(10);
    const back = revertImport(d, "imp1", later);
    expect(back.parts[0].qty).toBe(0);
    expect(back.logs).toHaveLength(2);
    expect(back.logs[0].revertedBy).toBe(back.logs[1].id);
    expect(back.imports[0].revertedAt).toBe(later.at);
    expect(() => revertImport(back, "imp1", later)).toThrow("没有可撤销");
  });
});

describe("不变量", () => {
  it("日志和库存对不上时能查出来", () => {
    const { data } = seed({ qty: 5 });
    const broken = { ...data, parts: [{ ...data.parts[0], qty: 9 }] };
    expect(checkInvariants(broken).length).toBeGreaterThan(0);
  });

  it("读回来是坏 JSON 时落成空数据，不抛错", () => {
    expect(parseData("{not json")).toEqual(EMPTY_DATA());
    expect(parseData(null)).toEqual(EMPTY_DATA());
  });
});

describe("搜索与筛选", () => {
  function three() {
    let d = EMPTY_DATA();
    d = applyCreate(d, { name: "伺服电机", sku: "SM-400W", category: "电机", qty: 1, minQty: 2 }, ctx);
    d = applyCreate(d, { name: "急停按钮", sku: "ES-22", category: "元件", qty: 12 }, ctx);
    d = applyCreate(d, { name: "线缆", sku: "", category: "耗材", qty: 0 }, ctx);
    const e = applyEntityCreate(d, { name: "Robot1" }, ctx);
    const used = applyUse(e.data, { partId: e.data.parts[0].id, qty: 1, entityId: e.entity.id }, later);
    return decorate(used);
  }

  it("关键字命中名称、SKU、分类，大小写无关；跨字段是「或」", () => {
    const rows = three();
    expect(filterParts(rows, { q: "sm-400" }).map((r) => r.name)).toEqual(["伺服电机"]);
    expect(filterParts(rows, { q: "元件" }).map((r) => r.name)).toEqual(["急停按钮"]);
    // 「电机」只在伺服电机的名称里出现；急停按钮的 SKU ES-22 不含电机
    expect(filterParts(rows, { q: "电机" }).map((r) => r.name)).toEqual(["伺服电机"]);
  });

  it("状态筛：库存不足 / 没库存 / 正常；归档默认不显示", () => {
    const rows = three();
    expect(filterParts(rows, { status: "low" }).map((r) => r.name)).toEqual(["伺服电机"]);
    // 伺服电机用掉了唯一的 1 个，所以它既「不足」又「没库存」
    expect(filterParts(rows, { status: "zero" }).map((r) => r.name)).toEqual(["伺服电机", "线缆"]);
    expect(filterParts(rows, { status: "ok" }).map((r) => r.name)).toEqual(["急停按钮"]);
    const archived = rows.map((r) => (r.name === "线缆" ? { ...r, archived: true } : r));
    expect(filterParts(archived, {}).map((r) => r.name)).toEqual(["伺服电机", "急停按钮"]);
    expect(filterParts(archived, { archived: true }).map((r) => r.name)).toContain("线缆");
  });

  it("最近使用：从未使用 / 30 天内", () => {
    const rows = three();
    const now = Date.parse("2026-11-01T00:00:00Z");
    expect(filterParts(rows, { lastUsed: "never" }, now).map((r) => r.name)).toEqual(["急停按钮", "线缆"]);
    expect(filterParts(rows, { lastUsed: "30d" }, now).map((r) => r.name)).toEqual(["伺服电机"]);
  });

  it("库存不足置顶，其余按序号", () => {
    const rows = three();
    expect(sortParts(rows).map((r) => r.name)).toEqual(["伺服电机", "急停按钮", "线缆"]);
  });

  it("按设备筛：只出在这台设备上用过的", () => {
    const rows = three();
    const robot = rows.filter((r) => r.entityNames.includes("Robot1")).map((r) => r.name);
    expect(robot).toEqual(["伺服电机"]);
  });

  it("日志筛选：设备 / 备件 / 类型 / 日期", () => {
    const data = { logs: [{ id: "1", type: "use", entityId: "e", partId: "p", at: "2026-10-30T09:00:00Z", by: "张三" },
                          { id: "2", type: "check", entityId: null, partId: "q", at: "2026-10-20T09:00:00Z", by: "李四" }] };
    expect(filterLogs(data.logs, { types: ["use"] }).map((l) => l.id)).toEqual(["1"]);
    expect(filterLogs(data.logs, { from: "2026-10-25" }).map((l) => l.id)).toEqual(["1"]);
    expect(filterLogs(data.logs, { entityId: "e" }).map((l) => l.id)).toEqual(["1"]);
    expect(filterLogs(data.logs, { by: "李四" }).map((l) => l.id)).toEqual(["2"]);
    // 新的在前
    expect(filterLogs(data.logs, {}).map((l) => l.id)).toEqual(["1", "2"]);
  });
});

describe("收件箱批次（gantt spare push）", () => {
  const batch = (id: string, items: unknown[], source = "DN-1") => ({ id, at: "2026-11-04T10:00:00Z", by: "张三", source, items });

  it("按 SKU 匹配：命中入库，没命中新建，序号接着排", () => {
    let d = EMPTY_DATA();
    d = applyBatch(d, batch("imp1", [
      { name: "伺服电机", sku: "SM-400W", qty: 20, confidence: 0.9 },
      { name: "急停按钮", sku: "ES-22", qty: 5 },
      { name: "  ", qty: 1 },
    ]), ctx);
    expect(d.parts.map((p) => [p.seq, p.name, p.qty])).toEqual([[1, "伺服电机", 20], [2, "急停按钮", 5]]);
    expect(d.logs.filter((l) => l.type === "import")).toHaveLength(2);
    expect(d.imports[0]).toMatchObject({ id: "imp1", source: "DN-1", by: "张三" });

    d = applyBatch(d, batch("imp2", [{ name: "伺服电机（补）", sku: "sm-400w", qty: 3 }], "DN-2"), later);
    expect(d.parts).toHaveLength(2);
    expect(d.parts[0].qty).toBe(23);
    expect(d.logs.at(-1)).toMatchObject({ type: "import", before: 20, after: 23, importId: "imp2", by: "李四" });
    expect(checkInvariants(d)).toEqual([]);
  });

  it("整批撤销能把这批冲回去，原日志保留", () => {
    let d = applyBatch(EMPTY_DATA(), batch("imp9", [{ name: "A", sku: "a", qty: 4 }]), ctx);
    d = revertImport(d, "imp9", later);
    expect(d.parts[0].qty).toBe(0);
    expect(d.imports[0].revertedAt).toBe(later.at);
  });

  it("一条名称都没有就什么都不写", () => {
    const d = EMPTY_DATA();
    expect(applyBatch(d, batch("imp0", [{ name: "" }]), ctx)).toBe(d);
  });
});

describe("能被宿主加载", () => {
  const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

  it("manifest 通过校验", () => {
    const r = validateManifest(read("./manifest.json"), "spare-parts");
    expect(r).toMatchObject({ ok: true, warnings: [] });
  });

  it("入口没有 import（宿主从 Blob URL 加载，没有模块解析）", () => {
    expect(/\bfrom\s*["']|\bimport\s*\(|\bimport\s+["']/.test(read("./main.js"))).toBe(false);
  });
});
