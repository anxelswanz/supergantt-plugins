import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../../sdk/manifest";
// 插件是纯 JS 单文件（宿主从 Blob URL 加载，不能 import），这里直接测它导出的纯函数
import { buildReport } from "./main.js";

/**
 * 日报的生成规则。钉死的是格式（问题 / 风险两段，各自 1. 2. 3. 编号）
 * 和取数范围（只取那一天的；打开 carryOver 才带上之前没关的）。
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
  item({ title: "一条代办", kind: "todo" }),
];

describe("buildReport", () => {
  it("问题、风险两段，各自从 1 开始编号；未关闭在前、急的在前", () => {
    expect(buildReport(ITEMS, "2026-10-07")).toBe(
      [
        "日报 2026-10-07",
        "",
        "问题",
        "1. 供应商没回邮件（任务：电机安装，负责人：张三）",
        "2. 夹具尺寸不对",
        "3. 图纸版本混乱 —— 已解决：统一用 V3",
        "",
        "风险",
        "1. 电机可能延期（高风险）",
      ].join("\n"),
    );
  });

  it("某一类没有时写「1. 无」，不让那一段消失", () => {
    const text = buildReport([item({ title: "只有问题" })], "2026-10-07");
    expect(text).toContain("风险\n1. 无");
  });

  it("关掉 withTask 只留一句话", () => {
    expect(buildReport(ITEMS, "2026-10-07", { withTask: false })).toContain(
      "1. 供应商没回邮件\n",
    );
  });

  it("carryOver：之前记的、还没关的也算进来，并标上记录日期", () => {
    expect(buildReport(ITEMS, "2026-10-07")).not.toContain("昨天的问题");
    expect(buildReport(ITEMS, "2026-10-07", { carryOver: true })).toContain(
      "昨天的问题（10-06 记录）",
    );
  });

  it("标题可以改", () => {
    expect(buildReport([], "2026-10-07", { title: "产线日报" }).split("\n")[0]).toBe(
      "产线日报 2026-10-07",
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
