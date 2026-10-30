// @vitest-environment jsdom
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const setup = (opts?: SetupOpts) => setupWith(new Map<string, string>(), opts);

interface SetupOpts {
  /** 飞书插件在不在（commands.has("feishu-sync.push")） */
  feishu?: boolean;
}

function setupWith(files: Map<string, string>, { feishu = false }: SetupOpts = {}) {
  let View: React.ComponentType = () => null;
  const actions: { label: (i: unknown) => string | null; run: (i: unknown) => void }[] = [];
  const badges: { render: (i: unknown) => { text: string } | null }[] = [];
  const setActiveView = vi.fn();
  const close = vi.fn(async () => {});
  const run = vi.fn(async () => ({ queued: true, syncing: true, reason: null }));
  const api = {
    react: React,
    log: () => {},
    data: {
      project: () => ({ id: 1, name: "P" }),
      items: { list: () => [ITEM], subscribe: () => () => {}, close },
    },
    commands: { register: () => ({ dispose() {} }), has: (id: string) => feishu && id === "feishu-sync.push", run },
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
  return { View, files, action: actions[0], badge: badges[0], setActiveView, close, run };
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
    // 它因此成了根因：弹出「确认根因」，先不写
    expect(screen.getByRole("dialog", { name: "确认根因并解决" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "稍后再说" }));
    expect(screen.queryByRole("dialog")).toBeNull();
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

describe("确认根因 → 解决 → 关闭事项 → 飞书", () => {
  async function confirmRoot(feishu: boolean) {
    const env = setup({ feishu });
    await act(async () => {});
    await act(async () => env.action.run(ITEM));
    render(React.createElement(env.View));
    key("Tab");
    await type("加工依据错");
    key("Tab");
    await type("图纸版本旧");
    fireEvent.click(document.querySelector('[data-node="n3"]')!);
    fireEvent.click(screen.getByRole("radio", { name: "已确认" }));
    return { ...env, dialog: screen.getByRole("dialog", { name: "确认根因并解决" }) };
  }

  it("写步骤和方案：步骤挂成已完成的对策，事项关闭并写结论，交给飞书同步", async () => {
    const { dialog, close, run, files } = await confirmRoot(true);

    // 因果链：顶事件 → 中间 → 根因
    expect(within(dialog).getByRole("list", { name: "因果链" }).textContent).toBe("夹具尺寸不对加工依据错图纸版本旧");

    const steps = () => within(dialog).getAllByPlaceholderText(/第一步|下一步/) as HTMLInputElement[];
    fireEvent.change(steps()[0], { target: { value: "收回旧图纸" } });
    fireEvent.keyDown(steps()[0], { key: "Enter" });
    expect(steps()).toHaveLength(2);
    fireEvent.change(steps()[1], { target: { value: "按新版重做夹具" } });
    fireEvent.change(within(dialog).getByPlaceholderText(/例如/), { target: { value: "建立图纸版本发放流程" } });

    // 两个勾默认都开着
    const boxes = within(dialog).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, true]);

    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "确认并解决" })));

    expect(close).toHaveBeenCalledTimes(1);
    const [key_, text] = close.mock.calls[0] as unknown as [string, string];
    expect(key_).toBe("note:3");
    expect(text).toBe(
      [
        "解决方案：建立图纸版本发放流程",
        "根因：图纸版本旧",
        "因果链：夹具尺寸不对 → 加工依据错 → 图纸版本旧",
        "解决步骤：",
        "1. 收回旧图纸",
        "2. 按新版重做夹具",
      ].join("\n"),
    );

    expect(run).toHaveBeenCalledWith("feishu-sync.push", {
      key: "note:3",
      sync: true,
      analysis: {
        source: "fault-tree",
        problem: "夹具尺寸不对",
        rootCauses: [{ label: "图纸版本旧", chain: ["夹具尺寸不对", "加工依据错", "图纸版本旧"] }],
        steps: ["收回旧图纸", "按新版重做夹具"],
        solution: "建立图纸版本发放流程",
      },
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/事项已关闭.*正在后台同步到飞书/);
    // 树上：根因下两个已完成的对策，根因打勾
    expect(document.querySelector('[data-node="n3"] .ft-node-root')!.textContent).toBe("根因 ✓");
    await waitFor(() => {
      const tree = JSON.parse(files.get("trees.json")!).trees[0];
      const acts = tree.nodes.n3.children.map((c: string) => tree.nodes[c]);
      expect(acts.map((a: { label: string; actionStatus: string }) => [a.label, a.actionStatus])).toEqual([
        ["收回旧图纸", "done"],
        ["按新版重做夹具", "done"],
      ]);
      expect(tree.solution).toBe("建立图纸版本发放流程");
    }, { timeout: 2000 });
  });

  it("没有飞书插件时不出现同步选项；再打开时带出已写的步骤", async () => {
    const { dialog, run } = await confirmRoot(false);
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.change(within(dialog).getByPlaceholderText("第一步做了什么"), { target: { value: "收回旧图纸" } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "确认并解决" })));
    expect(run).not.toHaveBeenCalled();

    // 根因节点上的按钮再打开：步骤还在
    fireEvent.click(document.querySelector('[data-node="n3"]')!);
    fireEvent.click(screen.getByRole("button", { name: "解决方案…" }));
    const again = screen.getByRole("dialog", { name: "确认根因并解决" });
    expect((within(again).getAllByRole("textbox")[0] as HTMLInputElement).value).toBe("收回旧图纸");
  });

  it("关闭事项失败：错误留在弹窗里", async () => {
    const { dialog, close } = await confirmRoot(false);
    close.mockRejectedValueOnce(new Error("这条事项还没分拣"));
    fireEvent.change(within(dialog).getByPlaceholderText("第一步做了什么"), { target: { value: "x" } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "确认并解决" })));
    expect(within(dialog).getByText("这条事项还没分拣")).toBeTruthy();
  });
});
