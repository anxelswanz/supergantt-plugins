// @vitest-environment jsdom
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { onload } from "./main.js";

/**
 * 日报视图：日期段、时间预设、类型勾选（默认全选、全选就全展示）、
 * Markdown 预览。设置存进假的 settings。
 */

const pad = (n: number) => String(n).padStart(2, "0");
/** 测试数据跟「今天」走：视图默认是今天，写死日期过几天就全落选了 */
function isoDaysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const TODAY = isoDaysAgo(0);
const OLD = isoDaysAgo(3);
const OLD_MD = OLD.slice(5);
const TODAY_MD = TODAY.slice(5);

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
  day: TODAY,
  closed: false,
  resolution: null,
  riskLevel: null,
  ...over,
});

const TASKS = [
  { id: 1, parentId: null, name: "COMBINED COMMISSIONING", startDay: 0, endDay: 0, progress: 0.4, priority: 3, personId: 1, milestone: false, collapsed: false, openBlockers: 0 },
  { id: 2, parentId: 1, name: "robot install", startDay: 0, endDay: 0, progress: 0.2, priority: 3, personId: null, milestone: false, collapsed: false, openBlockers: 0 },
];

const ITEMS = [
  item({ title: "夹具尺寸不对" }),
  item({ title: "电机可能延期", kind: "risk", source: "risk", riskLevel: 0, kindLabel: "风险" }),
  item({ title: "一条代办", kind: "todo", kindLabel: "待办" }),
  item({ title: "早先的问题", day: OLD }),
];

function setup() {
  const store = new Map<string, string>();
  let View: React.ComponentType = () => null;
  /**
   * 事项的「库」。list() 每次返回一个新数组（宿主的 itemSnapshot 就是这样）。
   * 测试从外面往 items 里塞东西，模拟数据在别处变了、内存里那份还是旧的。
   */
  const items = [...ITEMS];
  const reloads: number[] = [];
  const api = {
    react: React,
    dir: "/tmp/daily-report",
    log: () => {},
    settings: {
      // 和宿主一样：注册设置项时把 def 落进存储，没改过就读到默认值
      field: (f: { key: string; def?: unknown }) => {
        if (!store.has(f.key) && f.def !== undefined) store.set(f.key, String(f.def));
        return { dispose() {} };
      },
      get: (k: string) => store.get(k) ?? null,
      getBool: (k: string) => store.get(k) === "true",
      set: (k: string, v: string) => store.set(k, v),
    },
    data: {
      items: {
        list: () => [...items],
        reload: async () => {
          reloads.push(Date.now());
        },
        subscribe: () => () => {},
      },
      tasks: { list: () => TASKS, subscribe: () => () => {} },
      people: { list: () => [{ id: 1, name: "张三" }] },
    },
    util: {
      toDay: (iso: string) =>
        Math.round((new Date(`${TODAY}T00:00:00`).getTime() - new Date(`${iso}T00:00:00`).getTime()) / 864e5),
      toISODate: (n: number) => `+${n}天`,
    },
    views: {
      register: (_d: unknown, v: React.ComponentType) => {
        View = v;
        return { dispose() {} };
      },
    },
  };
  onload(api as never);
  return { View, store, items, reloads };
}

const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;

afterEach(cleanup);

describe("日报视图", () => {
  it("默认今天：只有今天记的，按类型分段", () => {
    const { View } = setup();
    render(React.createElement(View));
    const text = textarea().value;
    expect(text).toContain("## 问题");
    expect(text).toContain("1. 夹具尺寸不对");
    expect(text).toContain("## 待办");
    expect(text).not.toContain("早先的问题");
  });

  it("In Progress 跟类型一样默认勾上，父任务下挂子任务", () => {
    const { View } = setup();
    render(React.createElement(View));
    const text = textarea().value;
    expect(text).toContain("## In Progress");
    expect(text).toContain("1. COMBINED COMMISSIONING（进度 40%，负责人：张三");
    expect(text).toContain("   1. robot install（进度 20%，计划 ");
  });

  it("切到「近 7 天」把区间里的都带上，每条标日期", () => {
    const { View } = setup();
    render(React.createElement(View));
    fireEvent.click(screen.getByText("近 7 天"));
    const text = textarea().value;
    expect(text).toContain(`早先的问题（${OLD_MD}）`);
    expect(text).toContain(`夹具尺寸不对（${TODAY_MD}）`);
  });

  it("类型默认全选（不存任何排除）；取消一类后只出剩下的，并记进设置", () => {
    const { View, store } = setup();
    render(React.createElement(View));
    expect(store.get("excludedKinds")).toBeUndefined();

    fireEvent.click(screen.getByText("待办 1"));
    expect(textarea().value).not.toContain("## 待办");
    expect(textarea().value).toContain("## 风险");
    expect(store.get("excludedKinds")).toBe('["todo"]');

    // 全选按钮：有取消的就一键全选回来
    fireEvent.click(screen.getByText("全选"));
    expect(store.get("excludedKinds")).toBe("[]");
    expect(textarea().value).toContain("## 待办");
  });

  it("点「全选」时若有全部勾上，则变成全不选", () => {
    const { View } = setup();
    render(React.createElement(View));
    fireEvent.click(screen.getByText("全选"));
    expect(textarea().value).not.toContain("## 问题");
    expect(textarea().value).toContain("> 这段时间没有记录");
  });

  it("预览：标题渲染成 h1，原始文本不再出现在 textarea 里", () => {
    const { View } = setup();
    const { container } = render(React.createElement(View));
    fireEvent.click(screen.getByText("预览"));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(container.querySelector(".dr-md h1")?.textContent).toMatch(/^日报 /);
    fireEvent.click(screen.getByText("编辑"));
    expect(textarea().value).toContain("# 日报");
  });
});
