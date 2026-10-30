import * as React from "react";
import { describe, expect, it } from "vitest";
import { buildSyncPrompt, emptyQueue, addEntry, setAnalysis } from "./main.js";
import { onload } from "./main.js";

/**
 * 给别的插件调用的 feishu-sync.push：故障树确认根因后，把问题和根因分析交过来，
 * 加入队列、附上 analysis，已经选过目标表就立即后台同步。
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
  day: "2026-10-07",
  closed: true,
  resolution: "根因：图纸版本旧",
  riskLevel: null,
  closedDay: "2026-10-30",
  noteId: 3,
};

const ANALYSIS = {
  source: "fault-tree",
  problem: "夹具尺寸不对",
  rootCauses: [{ label: "图纸版本旧", chain: ["夹具尺寸不对", "加工依据错", "图纸版本旧"] }],
  steps: ["收回旧图纸", "按新版重做夹具"],
  solution: "建立图纸版本发放流程",
};

describe("setAnalysis", () => {
  it("附上、替换、拿掉；不在队列里的不动", () => {
    const q = addEntry(emptyQueue(), ITEM, { id: 1, name: "P" }, "t");
    const withA = setAnalysis(q, "note:3", ANALYSIS);
    expect(withA.entries[0].analysis).toEqual(ANALYSIS);
    expect(setAnalysis(withA, "note:3", null).entries[0]).not.toHaveProperty("analysis");
    expect(setAnalysis(q, "note:9", ANALYSIS)).toBe(q);
  });
});

it("同步提示词提到根因分析的拆分规则", () => {
  const p = buildSyncPrompt({ target: { baseToken: "b", tableId: "t" }, keys: ["note:3"] });
  expect(p).toMatch(/analysis/);
  expect(p).toMatch(/根因分析/);
});

function setup({ target = { baseToken: "bas", tableId: "tbl" } as object | null, claude = true } = {}) {
  const files = new Map<string, string>();
  if (target) files.set("config.json", JSON.stringify({ target }));
  const commands = new Map<string, { run: (...a: unknown[]) => unknown }>();
  const spawns: { program: string; stdin: string }[] = [];
  const api = {
    react: React,
    dir: "/tmp/feishu-sync",
    log: () => {},
    data: {
      project: () => ({ id: 1, name: "P" }),
      people: { list: () => [] },
      items: { list: () => [ITEM], subscribe: () => () => {} },
    },
    commands: {
      register: (c: { id: string; run: (...a: unknown[]) => unknown }) => {
        commands.set(c.id, c);
        return { dispose() {} };
      },
      has: () => false,
      run: async () => null,
    },
    itemActions: { register: () => ({ dispose() {} }) },
    itemBadges: { register: () => ({ dispose() {} }), refresh: () => {} },
    views: { register: () => ({ dispose() {} }) },
    storage: {
      read: async (n: string) => files.get(n) ?? null,
      write: async (n: string, c: string) => void files.set(n, c),
    },
    proc: {
      which: async (p: string) => (p === "claude" && !claude ? null : `/bin/${p}`),
      exec: async () => ({ code: 0, stdout: "{}", stderr: "" }),
      spawn: async (program: string, _args: string[], opts: { stdin: string }) => {
        spawns.push({ program, stdin: opts.stdin });
        return { done: Promise.resolve({ code: 0 }), kill() {} };
      },
    },
  };
  onload(api);
  // 等 onload 里的 reloadFromDisk 读完配置
  const push = async (arg: unknown) => {
    await new Promise((r) => setTimeout(r, 0));
    return commands.get("feishu-sync.push")!.run(arg);
  };
  return { push, files, spawns };
}

describe("feishu-sync.push", () => {
  it("加入队列、附上 analysis，并立即后台同步这一条", async () => {
    const { push, files, spawns } = setup();
    const r = await push({ key: "note:3", analysis: ANALYSIS });
    expect(r).toEqual({ queued: true, syncing: true, reason: null });

    const q = JSON.parse(files.get("queue.json")!);
    expect(q.entries).toHaveLength(1);
    expect(q.entries[0].item).toMatchObject({ closed: true, resolution: "根因：图纸版本旧" });
    expect(q.entries[0].analysis).toMatchObject({ ...ANALYSIS, updatedAt: expect.any(String) });

    await new Promise((r) => setTimeout(r, 0));
    expect(spawns).toHaveLength(1);
    expect(spawns[0].program).toBe("claude");
    expect(spawns[0].stdin).toContain("note:3");
  });

  it("没选目标表：只加入队列，说明原因", async () => {
    const { push, files, spawns } = setup({ target: null });
    const r = (await push({ key: "note:3", analysis: ANALYSIS })) as { syncing: boolean; reason: string };
    expect(r.syncing).toBe(false);
    expect(r.reason).toMatch(/选目标表格/);
    expect(JSON.parse(files.get("queue.json")!).entries).toHaveLength(1);
    expect(spawns).toHaveLength(0);
  });

  it("找不到 claude：只加入队列", async () => {
    const { push, spawns } = setup({ claude: false });
    const r = (await push({ key: "note:3" })) as { syncing: boolean; reason: string };
    expect(r.reason).toMatch(/claude/);
    expect(spawns).toHaveLength(0);
  });

  it("认不出的事项报错", async () => {
    const { push } = setup();
    await expect(push({ key: "note:99" })).rejects.toThrow(/没有/);
  });
});
