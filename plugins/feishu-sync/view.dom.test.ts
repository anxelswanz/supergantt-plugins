// @vitest-environment jsdom
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { onload } from "./main.js";

/**
 * 「浏览我的多维表格」弹窗：树从我的知识库读，点 ▤ 展开，点 ▦ 选中，
 * 只有一张数据表时直接定为目标表。lark-cli 用假数据代替。
 */

const nodes = (list: object[]) => JSON.stringify({ ok: true, data: { nodes: list } });
const LARK: Record<string, string> = {
  root: nodes([
    { node_token: "n1", obj_token: "d1", obj_type: "docx", has_child: true, space_id: "s", title: "IEUB2404058 Philips" },
    { node_token: "n2", obj_token: "bas2", obj_type: "bitable", has_child: false, space_id: "s", title: "project management" },
  ]),
  n1: nodes([
    { node_token: "n3", obj_token: "d3", obj_type: "docx", has_child: false, space_id: "s", title: "Hamburg Work Progress" },
    { node_token: "n4", obj_token: "bas4", obj_type: "bitable", has_child: false, space_id: "s", title: "Philips Hamburg - Issue List" },
  ]),
  tables: JSON.stringify({ ok: true, data: { items: [{ table_id: "tbl1", name: "Issues" }] } }),
  search: JSON.stringify({
    ok: true,
    data: {
      results: [
        {
          title_highlighted: "Philips <h>Hamburg</h> - Issue List",
          result_meta: { doc_types: "BITABLE", token: "n4", url: "https://x.feishu.cn/wiki/n4?visible_space_id=s" },
        },
      ],
    },
  }),
  nodeGet: JSON.stringify({ ok: true, data: { node_token: "n4", obj_type: "bitable", obj_token: "bas4" } }),
};

function setup() {
  const files = new Map<string, string>();
  const calls: string[][] = [];
  let View: React.ComponentType = () => null;
  const api = {
    react: React,
    dir: "/tmp/feishu-sync",
    log: () => {},
    data: {
      project: () => ({ id: 1, name: "P" }),
      people: { list: () => [] },
      items: { list: () => [], subscribe: () => () => {} },
    },
    itemActions: { register: () => ({ dispose() {} }) },
    itemBadges: { register: () => ({ dispose() {} }), refresh: () => {} },
    views: { register: (_: unknown, c: React.ComponentType) => (View = c) },
    storage: {
      read: async (n: string) => files.get(n) ?? null,
      write: async (n: string, c: string) => void files.set(n, c),
    },
    proc: {
      which: async (p: string) => `/bin/${p}`,
      exec: async (_p: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "auth")
          return { code: 0, stdout: JSON.stringify({ identities: { user: { status: "ready", userName: "Ansel Zhong" } } }), stderr: "" };
        if (args.includes("+table-list")) return { code: 0, stdout: LARK.tables, stderr: "" };
        if (args.includes("+search")) return { code: 0, stdout: LARK.search, stderr: "" };
        if (args.includes("+node-get")) return { code: 0, stdout: LARK.nodeGet, stderr: "" };
        const parent = args[args.indexOf("--parent-node-token") + 1];
        return { code: 0, stdout: args.includes("--parent-node-token") ? LARK[parent] : LARK.root, stderr: "" };
      },
    },
  };
  onload(api);
  return { View: () => React.createElement(View), files, calls };
}

afterEach(cleanup);

describe("浏览我的多维表格", () => {
  it("树形展开、点多维表格、单表自动选中", async () => {
    const { View, files } = setup();
    render(React.createElement(View));

    fireEvent.click(screen.getByText("浏览我的多维表格"));
    await screen.findByText("我的知识库");
    await screen.findByText("project management");

    fireEvent.click(screen.getByText("IEUB2404058 Philips"));
    const issue = await screen.findByText("Philips Hamburg - Issue List");
    // 连线：Philips 不是最后一个，它的子节点前面有一道竖线
    expect(issue.parentElement!.textContent).toMatch(/^│ └ /);

    await act(async () => fireEvent.click(issue));
    await waitFor(() => expect(JSON.parse(files.get("config.json") ?? "{}").target).toMatchObject({
      baseToken: "bas4",
      tableId: "tbl1",
      baseName: "Philips Hamburg - Issue List",
    }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("弹窗里的搜索：限定在我的知识库，选中后解析知识库链接", async () => {
    const { View, files, calls } = setup();
    render(React.createElement(View));
    fireEvent.click(screen.getByText("浏览我的多维表格"));
    await screen.findByText("project management");

    fireEvent.change(screen.getByPlaceholderText(/在我的知识库里搜索/), { target: { value: "Hamburg" } });
    const hit = await screen.findByText("Philips Hamburg - Issue List", {}, { timeout: 2000 });
    const search = calls.find((a) => a.includes("+search"))!;
    expect(search[search.indexOf("--space-ids") + 1]).toBe("s");

    await act(async () => fireEvent.click(hit));
    await waitFor(() =>
      expect(JSON.parse(files.get("config.json") ?? "{}").target).toMatchObject({ baseToken: "bas4", tableId: "tbl1" }),
    );
    // 知识库节点要用完整链接去解析
    expect(calls.find((a) => a.includes("+node-get"))).toContain("https://x.feishu.cn/wiki/n4?visible_space_id=s");
  });

  it("填写规则：先选文档再写规则；不展示内置规则", async () => {
    const { View, files } = setup();
    render(React.createElement(View));
    fireEvent.click(screen.getByText("填写规则"));
    expect(screen.queryByText("内置规则")).toBeNull();

    fireEvent.click(screen.getByText("＋ 为文档新建填写规则"));
    const pm = await screen.findByText("project management");
    await act(async () => fireEvent.click(pm));
    const box = await screen.findByPlaceholderText(/写给 Agent 的填写要求/);
    fireEvent.change(box, { target: { value: "status 只用 Open / Closed" } });
    await act(async () => fireEvent.blur(box));

    await waitFor(() => {
      const c = JSON.parse(files.get("config.json") ?? "{}");
      expect(c.tableRules["bas2:tbl1"]).toBe("status 只用 Open / Closed");
      expect(c.ruleDocs["bas2:tbl1"]).toMatchObject({ baseName: "project management", tableName: "Issues" });
      // 写规则不改同步目标
      expect(c.target ?? null).toBeNull();
    });
  });

  it("使用说明：准备 + 两种方式，示例提示词带上当前目标表，检测登录状态", async () => {
    const { View, files } = setup();
    files.set(
      "config.json",
      JSON.stringify({ target: { baseToken: "bas4", tableId: "tbl1", baseName: "Philips Hamburg - Issue List", tableName: "Issues" } }),
    );
    render(React.createElement(View));
    fireEvent.click(screen.getByText("使用说明"));

    expect(screen.getByText("准备（两种方式都需要，只做一次）")).toBeTruthy();
    expect(screen.getByText("npx skills add larksuite/cli -g -y")).toBeTruthy();
    expect(screen.getByText(/方式一：在这个页面里同步/)).toBeTruthy();
    expect(screen.getByText(/方式二：在 Claude Code 里自己操作/)).toBeTruthy();
    await screen.findByText("当前登录：Ansel Zhong");
    await waitFor(() =>
      expect(
        screen.getByText(/用 gantt-feishu 把飞书同步队列里待同步的事项写到 「Philips Hamburg - Issue List \/ Issues」（--target bas4:tbl1）$/),
      ).toBeTruthy(),
    );
  });
});
