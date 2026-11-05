// @vitest-environment jsdom
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { onload } from "./main.js";

/**
 * 备件视图：新增 → 使用 → 盘点 这条主链路，以及「备件跟着项目走」。
 * 数据存进假的 storage，视图每次写完都能读回来。
 */

const files = new Map<string, string>();

function setup({ project = { id: 7, name: "产线改造" } as { id: number; name: string } | null } = {}) {
  files.clear();
  let View: React.ComponentType = () => null;
  const api = {
    react: React,
    dir: "/tmp/spare-parts",
    log: () => {},
    data: {
      project: () => project,
      account: () => ({ id: 1, name: "张三" }),
      people: { list: () => [{ id: 11, name: "李四" }] },
    },
    storage: {
      read: async (n: string) => files.get(n) ?? null,
      write: async (n: string, c: string) => void files.set(n, c),
    },
    export: { document: async () => ({ path: null }) },
    ai: { ask: async () => ({ done: Promise.resolve({ ok: true, text: "{}", structured: { items: [] } }), cancel() {} }) },
    views: {
      register: (_d: unknown, v: React.ComponentType) => {
        View = v;
        return { dispose() {} };
      },
    },
  };
  onload(api as never);
  return View;
}

const row = (name: string) => screen.getByText(name).closest(".sp-tr") as HTMLElement;
const saved = () => JSON.parse(files.get("inventory-7.json")!);

afterEach(cleanup);

describe("备件视图", () => {
  it("没有打开项目时说明备件跟着项目走", () => {
    const View = setup({ project: null });
    render(<View />);
    expect(screen.getByText(/备件跟着项目走/)).toBeTruthy();
  });

  it("新增条目：默认库存写一条「新建」日志", async () => {
    const View = setup();
    render(<View />);
    await act(async () => {});
    fireEvent.click(screen.getByText("＋ 新增"));

    const name = screen.getByLabelText("名称") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "伺服电机" } });
    fireEvent.change(screen.getByLabelText(/初始库存/), { target: { value: "5" } });
    await act(async () => {
      fireEvent.click(screen.getByText("创建"));
    });

    expect(await screen.findByText("伺服电机")).toBeTruthy();
    const d = saved();
    expect(d.parts).toHaveLength(1);
    expect(d.parts[0]).toMatchObject({ name: "伺服电机", qty: 5, seq: 1, createdBy: "张三" });
    expect(d.logs.map((l: { type: string }) => l.type)).toEqual(["create"]);
  });

  it("使用：选设备、填数量后扣库存；库存不足时拒绝并写回 reason", async () => {
    const View = setup();
    render(<View />);
    await act(async () => {});
    fireEvent.click(screen.getByText("＋ 新增"));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "伺服电机" } });
    fireEvent.change(screen.getByLabelText(/初始库存/), { target: { value: "2" } });
    await act(async () => {
      fireEvent.click(screen.getByText("创建"));
    });

    await act(async () => {
      fireEvent.click(screen.getByText("使用"));
    });
    fireEvent.change(screen.getByDisplayValue("1"), { target: { value: "2" } });
    fireEvent.change(screen.getByPlaceholderText(/新建设备/), { target: { value: "Robot1" } });
    // 领用人选李四
    const selects = document.querySelectorAll("select");
    fireEvent.change(selects[selects.length - 1], { target: { value: "11" } });
    await act(async () => {
      fireEvent.click(screen.getByText("确认使用"));
    });

    const d = saved();
    expect(d.parts[0].qty).toBe(0);
    expect(d.entities.map((e: { name: string }) => e.name)).toEqual(["Robot1"]);
    expect(d.logs.at(-1)).toMatchObject({ type: "use", qty: -2, entityName: "Robot1", personId: 11, by: "张三" });
    expect(screen.getByText("伺服电机").closest(".sp-tr")!.textContent).toContain("0");

    // 再要 1 个就没有了
    await act(async () => {
      fireEvent.click(screen.getByText("使用"));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("确认使用"));
    });
    expect(await screen.findByText(/库存不够/)).toBeTruthy();
  });

  it("盘点：填实盘数后库存改成实盘数，日志里是一条 check", async () => {
    const View = setup();
    render(<View />);
    await act(async () => {});
    fireEvent.click(screen.getByText("＋ 新增"));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "急停按钮" } });
    fireEvent.change(screen.getByLabelText(/初始库存/), { target: { value: "10" } });
    await act(async () => {
      fireEvent.click(screen.getByText("创建"));
    });

    await act(async () => {
      fireEvent.click(screen.getByText("盘点"));
    });
    const counted = screen.getByPlaceholderText("10");
    fireEvent.change(counted, { target: { value: "8" } });
    expect(screen.getByText("-2")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("确认盘点"));
    });

    const d = saved();
    expect(d.parts[0].qty).toBe(8);
    expect(d.logs.at(-1)).toMatchObject({ type: "check", qty: -2, before: 10, after: 8 });
    expect(d.meta.checks).toHaveLength(1);
  });

  it("搜索：文件名里找不到的词就把行筛掉", async () => {
    const View = setup();
    render(<View />);
    await act(async () => {});
    for (const n of ["伺服电机", "急停按钮"]) {
      fireEvent.click(screen.getByText("＋ 新增"));
      fireEvent.change(screen.getByLabelText("名称"), { target: { value: n } });
      await act(async () => {
        fireEvent.click(screen.getByText("创建"));
      });
    }
    fireEvent.change(screen.getByPlaceholderText(/名称 \/ SKU/), { target: { value: "急停" } });
    expect(screen.queryByText("伺服电机")).toBeNull();
    expect(screen.getByText("急停按钮")).toBeTruthy();
  });
});
