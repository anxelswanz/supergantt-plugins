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
  const reopen = vi.fn(async () => {});
  const run = vi.fn(async () => ({ queued: true, syncing: true, reason: null }));
  const api = {
    react: React,
    log: () => {},
    data: {
      project: () => ({ id: 1, name: "P" }),
      items: { list: () => [ITEM], subscribe: () => () => {}, close, reopen },
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
  return { View, files, action: actions[0], badge: badges[0], setActiveView, close, reopen, run };
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
    // 成了根因：不自动弹窗，右栏出现「确认解决方案…」
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByRole("button", { name: "确认解决方案…" }).length).toBeGreaterThan(0);
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

  it("列表里能看到全部树；列表里删树要先确认", async () => {
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

    const openList = () => {
      if (!screen.queryByRole("dialog", { name: "故障树列表" })) fireEvent.click(screen.getByRole("button", { name: /列表/ }));
    };
    openList();
    fireEvent.click(screen.getByRole("button", { name: "删除「夹具尺寸不对」" }));
    const ask = screen.getByRole("alertdialog", { name: /删除故障树「夹具尺寸不对」/ });
    // 取消：还在
    fireEvent.click(within(ask).getByRole("button", { name: "取消" }));
    expect(screen.getByRole("tab", { name: /夹具尺寸不对/ })).toBeTruthy();

    openList();
    fireEvent.click(screen.getByRole("button", { name: "删除「夹具尺寸不对」" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除" }));
    expect(screen.queryByRole("tab", { name: /夹具尺寸不对/ })).toBeNull();
  });

  it("标签上的 × 只是收起，树还在，从列表能再打开", async () => {
    const { View, action, files } = setup();
    await act(async () => {});
    await act(async () => action.run(ITEM));
    render(React.createElement(View));

    fireEvent.click(screen.getByRole("button", { name: "关闭「夹具尺寸不对」标签" }));
    expect(screen.queryByRole("tab", { name: /夹具尺寸不对/ })).toBeNull();
    expect(screen.getByText("标签都关掉了")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "打开列表" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "故障树列表" })).getByText("夹具尺寸不对"));
    expect(screen.getByRole("tab", { name: /夹具尺寸不对/ })).toBeTruthy();
    // 收起记在树上，下次打开还是那样
    await waitFor(() => expect(JSON.parse(files.get("trees.json")!).trees).toHaveLength(1), { timeout: 2000 });
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

describe("确认解决方案 → 关闭事项 → 飞书 → 撤回", () => {
  /** 夹具尺寸不对 → 加工依据错 → 图纸版本旧（确认），根因下挂一条对策 */
  async function rooted(feishu: boolean) {
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
    fireEvent.click(screen.getByRole("button", { name: "＋ 对策" }));
    await type("收回旧图纸，按新版重做");
    return env;
  }
  const openDialog = () => {
    // 根因节点工具条和右栏各有一个，点哪个都一样
    fireEvent.click(screen.getAllByRole("button", { name: "确认解决方案…" })[0]);
    return screen.getByRole("dialog", { name: "确认解决方案" });
  };

  it("弹窗里没有输入框：根因、因果链、方案、排查步骤都来自树；确认后关闭事项并交给飞书", async () => {
    const { close, run, files } = await rooted(true);
    const dialog = openDialog();
    expect(within(dialog).queryAllByRole("textbox")).toHaveLength(0);
    expect(within(dialog).getByRole("list", { name: "因果链" }).textContent).toBe("夹具尺寸不对加工依据错图纸版本旧");
    expect(dialog.textContent).toContain("收回旧图纸，按新版重做");
    expect(dialog.textContent).toMatch(/1 条待做 \/ 进行中的对策标为已完成/);
    expect(dialog.querySelector(".ft-sum-steps")!.textContent).toMatch(/1\. 加工依据错 — 已确认 · \d{4}-\d\d-\d\d\n   1\.1 图纸版本旧 — 已确认（根因）/);

    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "确认" })));

    const [k, text] = close.mock.calls[0] as unknown as [string, string];
    expect(k).toBe("note:3");
    expect(text.split("\n").slice(0, 3)).toEqual([
      "解决方案：收回旧图纸，按新版重做",
      "根因：图纸版本旧",
      "因果链：夹具尺寸不对 → 加工依据错 → 图纸版本旧",
    ]);
    expect(run).toHaveBeenCalledWith("feishu-sync.push", expect.objectContaining({ key: "note:3", sync: true }));
    const analysis = (run.mock.calls[0] as unknown as [string, { analysis: Record<string, unknown> }])[1].analysis;
    expect(analysis).toMatchObject({
      problem: "夹具尺寸不对",
      rootCauses: [{ label: "图纸版本旧", chain: ["夹具尺寸不对", "加工依据错", "图纸版本旧"], actions: ["收回旧图纸，按新版重做"] }],
      solution: ["收回旧图纸，按新版重做"],
    });

    expect(screen.getByRole("status").textContent).toMatch(/1 条对策标为已完成.*事项已关闭.*正在后台同步到飞书/);
    expect(document.querySelector('[data-node="n3"] .ft-node-root')!.textContent).toBe("根因 ✓");
    expect(screen.getByText(/解决方案已确认/)).toBeTruthy();
    await waitFor(() => {
      const tree = JSON.parse(files.get("trees.json")!).trees[0];
      expect(tree.nodes.n4.actionStatus).toBe("done");
      expect(tree.confirmation.item).toEqual({ key: "note:3", closed: false, resolution: null });
    }, { timeout: 2000 });
  });

  it("撤回：先确认，再把对策改回去、事项重新打开，飞书只标有变更", async () => {
    const { close, reopen, run } = await rooted(true);
    const dialog = openDialog();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "确认" })));
    run.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "撤回" }));
    const ask = screen.getByRole("alertdialog", { name: "撤回解决方案？" });
    expect(ask.textContent).toMatch(/事项重新打开/);
    await act(async () => fireEvent.click(within(ask).getByRole("button", { name: "撤回" })));

    expect(screen.getByRole("status").textContent).toMatch(/已撤回.*事项已重新打开.*没有自动同步/);
    expect(run).toHaveBeenCalledWith("feishu-sync.push", { key: "note:3", analysis: null, sync: false });
    expect(close).toHaveBeenCalledTimes(1);
    expect(reopen).toHaveBeenCalledWith("note:3");
    expect(screen.getAllByRole("button", { name: "确认解决方案…" }).length).toBeGreaterThan(0);
    expect(document.querySelector('[data-node="n3"] .ft-node-root')!.textContent).toBe("根因");
  });

  it("确认后又加对策：提示过时，按钮变成「重新确认…」", async () => {
    await rooted(false);
    const dialog = openDialog();
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "确认" })));

    fireEvent.click(document.querySelector('[data-node="n3"]')!);
    fireEvent.click(screen.getByRole("button", { name: "＋ 对策" }));
    await type("加一道复核");
    expect(screen.getByText(/确认后树又改过/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新确认…" }));
    expect(screen.getByRole("dialog", { name: "确认解决方案" }).textContent).toContain("加一道复核");
  });

  it("关闭事项失败：错误留在弹窗里", async () => {
    const { close } = await rooted(false);
    close.mockRejectedValueOnce(new Error("这条事项还没分拣"));
    const dialog = openDialog();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "确认" })));
    expect(within(dialog).getByText("这条事项还没分拣")).toBeTruthy();
  });
});
