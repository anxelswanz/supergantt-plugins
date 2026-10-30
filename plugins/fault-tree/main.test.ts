import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../../sdk/manifest";
import * as M from "./main.js";
// 插件是纯 JS 单文件（宿主从 Blob URL 加载，不能 import），这里直接测它导出的纯函数
import {
  actionStats,
  addChild,
  addSibling,
  cutSetStatus,
  evaluate,
  filterTrees,
  itemRef,
  layoutTree,
  minimalCutSets,
  moveNode,
  newTree,
  nodeDay,
  outline,
  parseStore,
  removeNode,
  roleOf,
  rootCauses,
  updateNode,
} from "./main.js";

const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

type Tree = ReturnType<typeof newTree>;

/** 顶事件「夹具尺寸不对」：或门 → 图纸错（与门：版本旧 + 没复核） / 加工偏差 */
function sample() {
  let t: Tree = newTree({ id: "t1", projectId: 1, label: "夹具尺寸不对", now: "x" });
  const add = (parent: string, label: string) => {
    const r = addChild(t, parent, { label });
    t = r.tree;
    return r.id as string;
  };
  const drawing = add("n1", "图纸错");
  const old = add(drawing, "用了旧版图纸");
  const unchecked = add(drawing, "没人复核");
  t = updateNode(t, drawing, { gate: "and" });
  const machining = add("n1", "加工偏差");
  return { t, drawing, old, unchecked, machining };
}

describe("编辑树", () => {
  it("往基本事件下面加子事件，它就变成中间事件；删空了变回基本事件", () => {
    const { t, machining } = sample();
    const r = addChild(t, machining, { label: "刀具磨损" });
    expect(r.tree.nodes[machining].kind).toBe("intermediate");
    const back = removeNode(r.tree, r.id);
    expect(back.nodes[machining].kind).toBe("basic");
  });

  it("删除带走整枝；顶事件删不掉", () => {
    const { t, drawing, old } = sample();
    const next = removeNode(t, drawing);
    expect(next.nodes[drawing]).toBeUndefined();
    expect(next.nodes[old]).toBeUndefined();
    expect(removeNode(t, "n1")).toBe(t);
  });

  it("同级插在自己后面，左右挪位", () => {
    const { t, drawing, machining } = sample();
    const r = addSibling(t, drawing, { label: "测量错" });
    expect(r.tree.nodes.n1.children).toEqual([drawing, r.id, machining]);
    expect(moveNode(r.tree, machining, -1).nodes.n1.children).toEqual([drawing, machining, r.id]);
  });

  it("有子事件的不能改成叶子，顶事件永远是顶事件", () => {
    const { t, drawing } = sample();
    expect(updateNode(t, drawing, { kind: "basic" }).nodes[drawing].kind).toBe("intermediate");
    expect(updateNode(t, "n1", { kind: "basic" }).nodes.n1.kind).toBe("top");
  });
});

describe("按门推导", () => {
  it("与门：一个输入被排除，整枝就被排除；或门：全部排除才排除", () => {
    let { t, old, machining, drawing } = sample();
    t = updateNode(t, old, { status: "ruled" });
    let ev = evaluate(t);
    expect(ev[drawing]).toBe("ruled");
    expect(ev.n1).toBe("open");
    t = updateNode(t, machining, { status: "ruled" });
    expect(evaluate(t).n1).toBe("ruled");
  });

  it("与门：所有输入都确认才成立，然后顺着或门推到顶", () => {
    let { t, old, unchecked, drawing } = sample();
    t = updateNode(t, old, { status: "confirmed" });
    expect(evaluate(t)[drawing]).toBe("open");
    t = updateNode(t, unchecked, { status: "confirmed" });
    const ev = evaluate(t);
    expect(ev[drawing]).toBe("confirmed");
    expect(ev.n1).toBe("confirmed");
  });
});

describe("最小割集", () => {
  it("或门并、与门拼，按阶数排", () => {
    const { t, old, unchecked, machining } = sample();
    expect(minimalCutSets(t).sets).toEqual([[machining], [old, unchecked]]);
  });

  it("顶事件还没拆就没有割集；割集含已排除的叶子就不成立", () => {
    expect(minimalCutSets(newTree({ id: "t", projectId: 1, now: "x" })).sets).toEqual([]);
    let { t, old, unchecked } = sample();
    t = updateNode(t, old, { status: "ruled" });
    expect(cutSetStatus(t, [old, unchecked])).toBe("ruled");
  });

  it("组合爆炸时截断", () => {
    // 与门下 8 个或门，每个 3 个叶子 → 3^8 = 6561 个割集
    let t: Tree = newTree({ id: "t", projectId: 1, now: "x" });
    const and = addChild(t, "n1", { label: "and" });
    t = and.tree;
    for (let i = 0; i < 8; i++) {
      const g = addChild(t, and.id as string, { label: `g${i}` });
      t = g.tree;
      for (let j = 0; j < 3; j++) t = addChild(t, g.id as string, { label: `${i}.${j}` }).tree;
    }
    t = updateNode(t, and.id as string, { gate: "and" });
    const r = minimalCutSets(t, 50);
    expect(r.truncated).toBe(true);
    expect(r.sets.length).toBeLessThanOrEqual(50);
  });
});

describe("布局", () => {
  it("父节点居中在首尾子节点上方，下一层往下一格", () => {
    const { t, drawing, old, unchecked } = sample();
    const { pos } = layoutTree(t);
    expect(pos[drawing].x).toBe((pos[old].x + pos[unchecked].x) / 2);
    expect(pos[old].y).toBeGreaterThan(pos[drawing].y);
    expect(pos[unchecked].x).toBeGreaterThan(pos[old].x);
  });
});

describe("其他", () => {
  it("大纲：门、符号、验证状态都写出来", () => {
    let { t, old } = sample();
    t = updateNode(t, old, { status: "confirmed" });
    const text = outline(t);
    expect(text.split("\n")[0]).toBe("顶事件：夹具尺寸不对  [或门]");
    expect(text).toContain("├─ 图纸错  [与门]");
    expect(text).toContain("○ 用了旧版图纸（已确认）");
    expect(text).toContain("└─ ○ 加工偏差");
  });

  it("事项按 noteId 认，分拣改类型也还是同一条", () => {
    expect(itemRef({ key: "risk:7", noteId: 3 })).toBe("note:3");
    expect(itemRef({ key: "blocker:2/b1", noteId: null })).toBe("blocker:2/b1");
  });

  it("角色：老数据顶事件当现象、其余当原因", () => {
    const { t, old } = sample();
    expect(roleOf(t.nodes.n1)).toBe("phenomenon");
    expect(roleOf(t.nodes[old])).toBe("cause");
  });

  it("对策挂上去不改结构，也不参与推导和割集", () => {
    const { t: t0, old, unchecked, machining } = sample();
    const before = minimalCutSets(t0).sets;
    // 基本事件挂对策：仍是基本事件
    let r = addChild(t0, old, { label: "发图前复核", role: "action" });
    let t = r.tree;
    const act = r.id as string;
    expect(t.nodes[old].kind).toBe("basic");
    expect(t.nodes[act].actionStatus).toBe("todo");
    // 顶事件下挂临时措施
    r = addChild(t, "n1", { label: "手工修配", role: "action" });
    t = r.tree;
    expect(minimalCutSets(t).sets).toEqual(before);
    // 对策下面不能再挂
    expect(addChild(t, act, { label: "x" }).id).toBeNull();
    // 推导不受对策影响
    t = updateNode(t, old, { status: "confirmed" });
    t = updateNode(t, unchecked, { status: "confirmed" });
    expect(evaluate(t).n1).toBe("confirmed");
    // 删掉原因下唯一的对策，原因结构不变
    expect(removeNode(t, act).nodes[old].kind).toBe("basic");
    // 加工偏差：只挂对策的叶子删光后仍是基本事件
    r = addChild(t, machining, { label: "换刀", role: "action" });
    expect(removeNode(r.tree, r.id as string).nodes[machining].kind).toBe("basic");
  });

  it("改角色：有子原因的、顶事件不能改成对策；改回原因去掉对策字段", () => {
    const { t, drawing, old } = sample();
    expect(updateNode(t, drawing, { role: "action" })).toBe(t);
    expect(updateNode(t, "n1", { role: "action" })).toBe(t);
    let x = updateNode(t, old, { role: "action" });
    expect(x.nodes[old].actionStatus).toBe("todo");
    x = updateNode(x, old, { due: "2026-11-01" });
    x = updateNode(x, old, { role: "cause" });
    expect(x.nodes[old].due).toBeUndefined();
    expect(x.nodes[old].actionStatus).toBeUndefined();
  });

  it("根因：已确认的叶子，且一路到顶都成立", () => {
    const { t: t0, old, unchecked, machining } = sample();
    let t = updateNode(t0, old, { status: "confirmed" });
    t = updateNode(t, machining, { status: "confirmed" });
    // 图纸错是与门，没复核还没确认 → 旧版图纸不在成立的链上
    expect([...rootCauses(t)]).toEqual([machining]);
    t = updateNode(t, unchecked, { status: "confirmed" });
    expect([...rootCauses(t)].sort()).toEqual([machining, old, unchecked].sort());
    t = updateNode(t, machining, { status: "ruled" });
    expect(rootCauses(t).has(machining)).toBe(false);
  });

  it("对策统计：完成数、逾期（做完 / 无效的不算逾期）", () => {
    const { t: t0, old, machining } = sample();
    let t = t0;
    const add = (p: string, over: object) => {
      const r = addChild(t, p, { role: "action", ...over });
      t = r.tree;
    };
    add(old, { actionStatus: "done", due: "2026-10-01" });
    add(old, { actionStatus: "doing", due: "2026-10-01" });
    add(machining, { actionStatus: "ineffective", due: "2026-10-01" });
    add(machining, { due: "2026-12-01" });
    expect(actionStats(t, "2026-10-28")).toEqual({ total: 4, done: 1, overdue: 1 });
    expect(outline(t)).toContain("→ 对策：（未填写）（已完成，截止 2026-10-01）");
  });

  it("事件的时间：有 at 用 at，老数据退回建树那天", () => {
    const t = newTree({ id: "t", projectId: 1, at: "2026-10-20", now: "2026-10-28T08:00:00" });
    expect(nodeDay(t, t.nodes.n1)).toBe("2026-10-20");
    const r = addChild(t, "n1", { label: "x" });
    expect(nodeDay(r.tree, r.tree.nodes[r.id])).toBe("2026-10-28");
  });

  it("列表按建树日期、按关联任务筛，新的在前", () => {
    const mk = (id: string, now: string, ref: string | null) =>
      newTree({ id, projectId: 1, ref, now });
    const trees = [
      mk("a", "2026-09-03T08:00:00", "note:1"),
      mk("b", "2026-10-15T08:00:00", "note:2"),
      mk("c", "2026-10-20T08:00:00", null),
    ];
    const byRef = new Map([
      ["note:1", { taskId: 7 }],
      ["note:2", { taskId: 8 }],
    ]);
    const ids = (f: object) => filterTrees(trees, f, byRef).map((t) => t.id);
    expect(ids({})).toEqual(["c", "b", "a"]);
    expect(ids({ from: "2026-10-01", to: "2026-10-15" })).toEqual(["b"]);
    expect(ids({ task: "7" })).toEqual(["a"]);
    expect(ids({ task: "none" })).toEqual(["c"]);
  });

  it("坏文件当空的", () => {
    expect(parseStore("{oops")).toEqual({ version: 1, trees: [] });
  });

  it("manifest 通过校验，没有警告；入口是自包含的单文件", () => {
    expect(validateManifest(read("./manifest.json"), "fault-tree")).toMatchObject({ ok: true, warnings: [] });
    expect(read("./main.js")).not.toMatch(/\bfrom\s*["']|\bimport\s*\(|\bimport\s+["']/);
  });
});

describe("根因 → 确认解决方案", () => {
  // 顶事件 → 或门 → [图纸旧(基本), 刀具磨损(基本)]
  const base = () => {
    let t = M.newTree({ id: "t", projectId: 1, label: "夹具尺寸不对", now: "2026-10-01T00:00:00Z" });
    t = M.addChild(t, "n1", { label: "图纸旧", at: "2026-10-21" }).tree;
    t = M.addChild(t, "n1", { label: "刀具磨损", at: "2026-10-22" }).tree;
    return t;
  };
  const act = (t: ReturnType<typeof base>, parent: string, label: string, actionStatus = "todo") =>
    M.addChild(t, parent, { label, role: "action", actionStatus }).tree;

  it("根因只认角色是「原因」的；现象下面成立的原因接着往下找，取最深的", () => {
    let t = M.updateNode(base(), "n2", { status: "confirmed" });
    expect([...M.rootCauses(t)]).toEqual(["n2"]);
    // 标成现象：它不是根因了，也没有更深的原因 → 这棵树没有根因
    t = M.updateNode(t, "n2", { role: "phenomenon" });
    expect(M.rootCauses(t).size).toBe(0);
    // 原因 → 原因 → 原因：只有最底下那个
    let d = base();
    d = M.addChild(d, "n2", { label: "版本没发放" }).tree;
    d = M.addChild(d, "n4", { label: "没有发放流程" }).tree;
    d = M.updateNode(d, "n5", { status: "confirmed" });
    expect([...M.rootCauses(d)]).toEqual(["n5"]);
    expect(M.causeChain(d, "n5")).toEqual(["夹具尺寸不对", "图纸旧", "版本没发放", "没有发放流程"]);
    // 最底下是现象：往上找到第一个原因
    d = M.updateNode(d, "n5", { role: "phenomenon" });
    expect([...M.rootCauses(d)]).toEqual(["n4"]);
  });

  it("解决步骤：整棵树按层级缩进，带验证结果和日期，排除的也在、对策不在", () => {
    let t = M.addChild(base(), "n2", { label: "版本没发放", at: "2026-10-23" }).tree;
    t = M.updateNode(t, "n4", { status: "confirmed" });
    t = M.updateNode(t, "n3", { status: "ruled" });
    t = act(t, "n4", "建立发放流程");
    expect(M.stepsOutline(t)).toEqual([
      "1. 图纸旧 — 已确认 · 2026-10-21",
      "   1.1 版本没发放 — 已确认（根因） · 2026-10-23",
      "2. 刀具磨损 — 已排除 · 2026-10-22",
    ]);
  });

  it("方案 = 根因下的有效对策；没有对策写「未制定」", () => {
    let t = M.updateNode(base(), "n2", { status: "confirmed" });
    expect(M.resolutionText(M.buildAnalysis(t))).toMatch(/^解决方案：未制定/);
    t = act(t, "n2", "收回旧图纸");
    t = act(t, "n2", "试过换夹具", "ineffective");
    t = act(t, "n2", "建立发放流程", "doing");
    const a = M.buildAnalysis(t);
    expect(a.solution).toEqual(["收回旧图纸", "建立发放流程"]);
    expect(M.resolutionText(a)).toBe(
      [
        "解决方案：收回旧图纸；建立发放流程",
        "根因：图纸旧",
        "因果链：夹具尺寸不对 → 图纸旧",
        "解决步骤：",
        "1. 图纸旧 — 已确认（根因） · 2026-10-21",
        "2. 刀具磨损 — 待验证 · 2026-10-22",
      ].join("\n"),
    );
  });

  it("确认：待做 / 进行中的对策标已完成，记下原样；撤回全部改回去", () => {
    let t = M.updateNode(base(), "n2", { status: "confirmed" });
    t = act(t, "n2", "收回旧图纸");
    t = act(t, "n2", "建立发放流程", "doing");
    t = act(t, "n2", "试过换夹具", "ineffective");
    const item = { key: "note:3", closed: false, resolution: null };
    const { tree: c } = M.confirmSolution(t, { item, feishu: true, now: "2026-10-30T00:00:00Z" });
    expect(M.actionsUnder(c, "n2").map((a) => a.actionStatus)).toEqual(["done", "done", "ineffective"]);
    expect(c.confirmation).toMatchObject({ item, feishu: true, actionPrev: { n4: "todo", n5: "doing" } });
    expect(M.isStale(c)).toBe(false);

    // 之后又改了树：过时
    const later = act(c, "n2", "再加一条");
    expect(M.isStale(later)).toBe(true);
    // 只改备注不算
    expect(M.isStale(M.updateNode(c, "n2", { note: "证据：图纸编号" }))).toBe(false);

    const w = M.withdrawSolution(c);
    expect(M.actionsUnder(w, "n2").map((a) => a.actionStatus)).toEqual(["todo", "doing", "ineffective"]);
    expect(w).not.toHaveProperty("confirmation");
  });
});
