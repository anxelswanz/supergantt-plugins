// @vitest-environment jsdom
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onload, onunload } from "./main.js";

/**
 * 从事项建一棵树 → 在画布上用键盘拆两层 → 标确认 / 排除 → 右栏推出结论。
 * 宿主 api 用假的：事项一条、存储在内存里。
 */

const ITEM = {
  key: "note:3",
  source: "note",
  title: "夹具尺寸不对",
  kind: "issue",
  kindLabel: "问题",
  priority: 1,
  personId: null,
  personName: null,
  taskId: null,
  taskName: null,
  day: "2026-10-20",
  closed: false,
  resolution: null,
  riskLevel: null,
  closedDay: null,
  noteId: 3,
};

const setup = () => setupWith(new Map<string, string>());

function setupWith(files: Map<string, string>) {
  let View: React.ComponentType = () => null;
  const actions: { label: (i: unknown) => string | null; run: (i: unknown) => void }[] = [];
  const badges: { render: (i: unknown) => { text: string } | null }[] = [];
  const setActiveView = vi.fn();
  const api = {
    react: React,
    log: () => {},
    data: {
      project: () => ({ id: 1, name: "P" }),
      items: { list: () => [ITEM], subscribe: () => () => {} },
    },
    act: { setActiveView },
    itemActions: { register: (a: (typeof actions)[number]) => (actions.push(a), { dispose() {} }) },
    itemBadges: { register: (b: (typeof badges)[number]) => (badges.push(b), { dispose() {} }), refresh: () => {} },
    views: { register: (_: unknown, c: React.ComponentType) => (View = c) },
    storage: {
      read: async (n: string) => files.get(n) ?? null,
      write: async (n: string, c: string) => void files.set(n, c),
    },
  };
  onload(api);
  return { View, files, action: actions[0], badge: badges[0], setActiveView };
}

afterEach(cleanup);

/** 在画布上按一个键 */
const key = (k: string, opts = {}) =>
  fireEvent.keyDown(screen.getByLabelText("故障树画布"), { key: k, ...opts });

/** 新建的节点会直接进入编辑：打字、回车提交 */
async function type(text: string) {
  const box = document.querySelector(".ft-node-edit") as HTMLTextAreaElement;
  expect(box).toBeTruthy();
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
  await act(async () => {
    box.blur();
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("故障树", () => {
  it("从事项建树、键盘拆分、标记验证，推出因果链", async () => {
    const { View, files, action, badge, setActiveView } = setup();
    await act(async () => {});

    expect(action.label(ITEM)).toBe("建故障树分析");
    await act(async () => action.run(ITEM));
    expect(setActiveView).toHaveBeenCalledWith("fault-tree.view");
    expect(action.label(ITEM)).toBe("打开故障树分析");
    expect(badge.render(ITEM)?.text).toBe("故障树");

    render(React.createElement(View));
    expect(screen.getAllByText("夹具尺寸不对").length).toBeGreaterThan(0);
    expect(screen.getByText(/还没开始拆/)).toBeTruthy();

    // 顶事件已选中：Tab 拆出第一个原因，回车再加一个同级
    key("Tab");
    await type("图纸错");
    key("Enter");
    await type("加工偏差");

    expect(screen.getAllByText("图纸错").length).toBeGreaterThan(0);
    expect(screen.getByText(/还有 2 个/)).toBeTruthy();

    // 选中「图纸错」，标成已确认 → 或门推到顶
    fireEvent.click(document.querySelector('[data-node="n2"]')!);
    fireEvent.click(screen.getByRole("radio", { name: "已确认" }));
    expect(screen.getByText(/因果链成立/)).toBeTruthy();
    expect(document.querySelector('[data-node="n1"]')!.className).toContain("ft-hot");

    // 撤销 → 回到待验证
    key("z", { metaKey: true });
    expect(screen.getByText(/还有 2 个/)).toBeTruthy();

    // 落盘（防抖之后）
    await waitFor(() => expect(files.get("trees.json")).toContain("加工偏差"), { timeout: 2000 });
  });

  it("没有树时给出从事项出发的指引", async () => {
    const { View } = setup();
    await act(async () => {});
    render(React.createElement(View));
    expect(screen.getByText(/建故障树分析/)).toBeTruthy();
    fireEvent.click(screen.getByText("直接新建一棵"));
    expect(screen.getByLabelText("故障树画布")).toBeTruthy();
  });

  it("列表里能看到全部树；标签上的红叉删树", async () => {
    const { View, action } = setup();
    await act(async () => {});
    await act(async () => action.run(ITEM));
    render(React.createElement(View));
    fireEvent.click(screen.getByText("＋ 新建"));

    fireEvent.click(screen.getByRole("button", { name: /列表/ }));
    const list = screen.getByRole("dialog", { name: "故障树列表" });
    expect(list.querySelectorAll(".ft-list-row").length).toBe(2);
    fireEvent.change(screen.getByLabelText("按任务筛选"), { target: { value: "none" } });
    expect(list.querySelectorAll(".ft-list-row").length).toBe(2);
    fireEvent.change(screen.getByLabelText("起始日期"), { target: { value: "2099-01-01" } });
    expect(screen.getByText("没有符合条件的故障树")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "删除「夹具尺寸不对」" }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.queryByRole("tab", { name: /夹具尺寸不对/ })).toBeNull();
    confirm.mockRestore();
  });

  it("卸载前没落盘的改动立刻写掉，重新加载读回同一份", async () => {
    const { View, files, action } = setup();
    await act(async () => {});
    await act(async () => action.run(ITEM));
    render(React.createElement(View));
    key("Tab");
    await type("图纸错");

    // 防抖还没到就卸载
    onunload();
    await new Promise((r) => setTimeout(r, 20));
    expect(files.get("trees.json")).toContain("图纸错");
    cleanup();

    // 同一份存储，重新 onload：树还在
    const again = setupWith(files);
    await act(async () => {});
    render(React.createElement(again.View));
    expect(screen.getAllByText("图纸错").length).toBeGreaterThan(0);
  });

  it("画布上加对策：绿色对策卡，不改变推导；改角色", async () => {
    const { View, action } = setup();
    await act(async () => {});
    await act(async () => action.run(ITEM));
    render(React.createElement(View));
    key("Tab");
    await type("图纸错");

    // 选中「图纸错」，工具条上点「＋ 对策」
    fireEvent.click(document.querySelector('[data-node="n2"]')!);
    fireEvent.click(screen.getByRole("button", { name: "＋ 对策" }));
    await type("发图前复核");
    const card = document.querySelector('[data-node="n3"]')!;
    expect(card.className).toContain("ft-node-action");
    expect(card.textContent).toContain("根本对策");
    // 对策不算待验证
    expect(screen.getByText(/还有 1 个待验证/)).toBeTruthy();
    expect(screen.getByText(/0\/1/)).toBeTruthy();

    // 确认「图纸错」→ 根因角标
    fireEvent.click(document.querySelector('[data-node="n2"]')!);
    fireEvent.click(screen.getByRole("radio", { name: "已确认" }));
    expect(document.querySelector('[data-node="n2"]')!.textContent).toContain("根因");

    // 把「图纸错」改成现象
    fireEvent.click(screen.getByRole("radio", { name: "现象" }));
    expect(document.querySelector('[data-node="n2"]')!.className).toContain("ft-node-phen");
  });
});
