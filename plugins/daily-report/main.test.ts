import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../../sdk/manifest";
// 插件是纯 JS 单文件（宿主从 Blob URL 加载，不能 import），这里直接测它导出的纯函数
import { buildReport, inProgressTasks, listKinds, renderMarkdown, UNSORTED } from "./main.js";

/**
 * 日报的生成规则。钉死的是格式（Markdown，每类一段，各自 1. 2. 3. 编号）、
 * 取数范围（一天或一段，含两端；打开 carryOver 才带上之前没关的）和类型筛选。
 */

const item = (over: Record<string, unknown>) => ({
  key: String(over.title),
  source: "note",
  kind: "issue",
  kindLabel: "问题",
  priority: 2,
  personId: null,
  personName: null,
  taskId: null,
  taskName: null,
  day: "2026-10-07",
  closed: false,
  resolution: null,
  riskLevel: null,
  ...over,
});

const ITEMS = [
  item({ title: "夹具尺寸不对" }),
  item({ title: "供应商没回邮件", priority: 0, taskName: "电机安装", personName: "张三" }),
  item({ title: "图纸版本混乱", closed: true, resolution: "统一用 V3" }),
  item({ title: "电机可能延期", kind: "risk", source: "risk", riskLevel: 0 }),
  item({ title: "昨天的问题", day: "2026-10-06" }),
  item({ title: "一条代办", kind: "todo", kindLabel: "待办" }),
  item({ title: "自建类型的一条", kind: "custom:qc", kindLabel: "质检" }),
  item({ title: "上周的问题", day: "2026-09-30" }),
  item({ title: "上周关掉的", day: "2026-09-30", closed: true }),
];

describe("buildReport", () => {
  it("Markdown：标题 + 摘要 + 每类一段，各自从 1 开始编号；未关闭在前、急的在前", () => {
    expect(buildReport(ITEMS, "2026-10-07")).toBe(
      [
        "# 日报 2026-10-07",
        "",
        "> 共 6 条：问题 3 · 风险 1 · 待办 1 · 质检 1；其中已关闭 1",
        "",
        "## 问题",
        "",
        "1. 供应商没回邮件（任务：电机安装，负责人：张三）",
        "2. 夹具尺寸不对",
        "3. 图纸版本混乱 —— 已解决：统一用 V3",
        "",
        "## 风险",
        "",
        "1. 电机可能延期（高风险）",
        "",
        "## 待办",
        "",
        "1. 一条代办",
        "",
        "## 质检",
        "",
        "1. 自建类型的一条",
      ].join("\n"),
    );
  });

  it("问题、风险没有时写「无」，不让那一段消失", () => {
    const text = buildReport([item({ title: "只有问题" })], "2026-10-07");
    expect(text).toContain("## 风险\n\n无");
  });

  it("这段时间什么都没有，摘要说清楚", () => {
    expect(buildReport([], "2026-10-07")).toContain("> 这段时间没有记录");
  });

  it("时间段：含两端，每条标上记录日；标题写成区间", () => {
    const text = buildReport(ITEMS, { from: "2026-10-06", to: "2026-10-07" });
    expect(text.split("\n")[0]).toBe("# 日报 2026-10-06 ~ 2026-10-07");
    expect(text).toContain("昨天的问题（10-06）");
    expect(text).toContain("夹具尺寸不对（10-07）");
    expect(text).not.toContain("上周的问题");
  });

  it("from、to 填反了也认", () => {
    expect(buildReport(ITEMS, { from: "2026-10-07", to: "2026-10-06" })).toContain(
      "昨天的问题",
    );
  });

  it("按类型筛：只出勾上的那几段", () => {
    const text = buildReport(ITEMS, "2026-10-07", { kinds: ["risk", "custom:qc"] });
    expect(text).not.toContain("## 问题");
    expect(text).not.toContain("## 待办");
    expect(text).toContain("## 风险");
    expect(text).toContain("## 质检");
    expect(text).toContain("> 共 2 条：风险 1 · 质检 1");
  });

  it("未分拣的事项排最后，单独一段", () => {
    const text = buildReport(
      [item({ title: "还没分拣", kind: null, kindLabel: "未分拣" })],
      "2026-10-07",
    );
    expect(text.trimEnd().endsWith("## 未分拣\n\n1. 还没分拣")).toBe(true);
  });

  it("关掉 withTask 只留一句话", () => {
    expect(buildReport(ITEMS, "2026-10-07", { withTask: false })).toContain(
      "1. 供应商没回邮件\n",
    );
  });

  it("carryOver：开始日之前记的、还没关的也算进来，并标上记录日期", () => {
    expect(buildReport(ITEMS, "2026-10-07")).not.toContain("上周的问题");
    const text = buildReport(ITEMS, "2026-10-07", { carryOver: true });
    expect(text).toContain("昨天的问题（10-06 记录）");
    expect(text).not.toContain("上周关掉的");
  });

  it("标题可以改", () => {
    expect(buildReport([], "2026-10-07", { title: "产线日报" }).split("\n")[0]).toBe(
      "# 产线日报 2026-10-07",
    );
  });
});

describe("In Progress", () => {
  const DID = { name: "COMBINED COMMISSIONING", progress: 0.4, depth: 0, end: "2026-10-20" };
  const NEXT = { name: "robot install", progress: 0, depth: 0, end: "2026-10-25" };

  it("排在最前面，一条一行，带进度和计划完成日", () => {
    const text = buildReport(ITEMS, "2026-10-07", { inProgress: [DID, NEXT] });
    const lines = text.split("\n");
    expect(lines.indexOf("## In Progress")).toBeLessThan(lines.indexOf("## 问题"));
    expect(text).toContain(
      "1. COMBINED COMMISSIONING（进度 40%，计划 10-20 完成）\n2. robot install（进度 0%，计划 10-25 完成）",
    );
  });

  it("没有进行中的任务时写「无」，这一段仍在", () => {
    expect(buildReport(ITEMS, "2026-10-07", { inProgress: [] })).toContain("## In Progress\n\n无");
  });

  it("不传 inProgress 就没有这一段（老用法不变）", () => {
    expect(buildReport(ITEMS, "2026-10-07")).not.toContain("In Progress");
  });

  it("子任务缩进成嵌套列表，每层各自编号", () => {
    const text = buildReport([], "2026-10-07", {
      inProgress: [DID, { name: "子任务", progress: 0.1, depth: 1 }],
    });
    expect(text).toContain("1. COMBINED COMMISSIONING");
    expect(text).toContain("   1. 子任务（进度 10%）");
  });
});

describe("inProgressTasks", () => {
  const task = (over: Record<string, unknown>) =>
    ({
      id: 1,
      parentId: null,
      name: "t",
      startDay: 20000,
      endDay: 20010,
      progress: 0,
      priority: 3,
      personId: null,
      milestone: false,
      collapsed: false,
      openBlockers: 0,
      ...over,
    }) as never;

  const DAY = 20005;
  it("有进度、有阻碍、或计划盖住这一天的都算；做完的、没开始的、里程碑不算", () => {
    const names = inProgressTasks(
      [
        task({ id: 1, name: "有进度", progress: 0.3, startDay: 1, endDay: 2 }),
        task({ id: 2, name: "有阻碍", openBlockers: 1, startDay: 1, endDay: 2 }),
        task({ id: 3, name: "计划内" }),
        task({ id: 4, name: "做完", progress: 1 }),
        task({ id: 5, name: "没开始", startDay: 20006, endDay: 20009 }),
        task({ id: 6, name: "里程碑", milestone: true }),
      ],
      DAY,
    ).map((t) => t.name);
    expect(names).toEqual(["有进度", "有阻碍", "计划内"]);
  });

  it("depth 数的是往上有几层祖先也在进行中", () => {
    const list = inProgressTasks(
      [
        task({ id: 1, name: "父", progress: 0.5 }),
        task({ id: 2, name: "子", parentId: 1, progress: 0.2 }),
        task({ id: 3, name: "孙", parentId: 2, progress: 0.1 }),
        task({ id: 4, name: "父下的另一条", parentId: 1 }),
      ],
      DAY,
    );
    expect(list.map((t) => [t.name, t.depth])).toEqual([
      ["父", 0],
      ["子", 1],
      ["孙", 2],
      ["父下的另一条", 1],
    ]);
  });
});

describe("listKinds", () => {
  it("问题、风险总在；其余按出现列，内置在前、自建按名字、未分拣垫底；count 只数范围内", () => {
    const kinds = listKinds([...ITEMS, item({ title: "x", kind: null, kindLabel: "未分拣" })], {
      from: "2026-10-07",
      to: "2026-10-07",
    });
    expect(kinds.map((k) => [k.key, k.label, k.count])).toEqual([
      ["issue", "问题", 3],
      ["risk", "风险", 1],
      ["todo", "待办", 1],
      ["custom:qc", "质检", 1],
      [UNSORTED, "未分拣", 1],
    ]);
  });
});

describe("renderMarkdown", () => {
  it("标题、引用、有序列表；HTML 一律转义", () => {
    expect(renderMarkdown("# 日报\n\n> 共 1 条\n\n## 问题\n\n1. <b>a</b> **重点**")).toBe(
      "<h1>日报</h1><blockquote>共 1 条</blockquote><h2>问题</h2><ol><li>&lt;b&gt;a&lt;/b&gt; <strong>重点</strong></li></ol>",
    );
  });
});

/** 宿主能不能装上它：manifest 过校验，入口是不 import 任何东西的单文件 */
describe("能被宿主加载", () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

  it("manifest 通过校验，没有警告", () => {
    const r = validateManifest(read("./manifest.json"), "daily-report");
    expect(r).toMatchObject({ ok: true, warnings: [] });
  });

  it("入口没有 import（宿主从 Blob URL 加载，没有模块解析）", () => {
    expect(/\bfrom\s*["']|\bimport\s*\(|\bimport\s+["']/.test(read("./main.js"))).toBe(false);
  });
});
