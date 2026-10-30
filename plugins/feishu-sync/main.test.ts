import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../../sdk/manifest";
// 插件是纯 JS 单文件（宿主从 Blob URL 加载，不能 import），这里直接测它导出的纯函数
import {
  SNAPSHOT_FIELDS,
  addEntry,
  agentArgs,
  buildSyncPrompt,
  describeStreamLine,
  emptyQueue,
  entryKey,
  parseBaseLink,
  parseWikiNodes,
  parseLark,
  parseSearchResults,
  parseTables,
  parseUsers,
  refreshSnapshots,
  removeEntry,
  statusOf,
} from "./main.js";

const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

const item = (over: Record<string, unknown> = {}) => ({
  key: "note:1",
  source: "note",
  title: "夹具尺寸不对",
  kind: "issue",
  kindLabel: "问题",
  priority: 1,
  personId: 3,
  personName: "张三",
  taskId: 12,
  taskName: "夹具设计",
  day: "2026-10-02",
  closed: false,
  closedDay: null,
  resolution: null,
  riskLevel: null,
  noteId: 1,
  ...over,
});

const project = { id: 7, name: "产线改造" };
const T = "bas1:tbl1";

describe("队列", () => {
  it("分拣改了 key 也认得是同一条：有 noteId 就用 note:<id>", () => {
    expect(entryKey(item({ key: "risk:5", noteId: 1 }))).toBe("note:1");
    expect(entryKey(item({ key: "blocker:12/b1", noteId: null }))).toBe("blocker:12/b1");
  });

  it("加入不重复，移出只动本地", () => {
    let q = addEntry(emptyQueue(), item(), project, "t");
    q = addEntry(q, item(), project, "t");
    expect(q.entries).toHaveLength(1);
    expect(q.entries[0]).toMatchObject({ key: "note:1", projectId: 7, projectName: "产线改造", missing: false });
    expect(removeEntry(q, "note:1").entries).toHaveLength(0);
  });

  it("状态：未同步 → 已同步 → 改了变「有变更」→ 失败", () => {
    const q = addEntry(emptyQueue(), item(), project, "t");
    const e = q.entries[0];
    expect(statusOf(e, T)).toBe("pending");

    e.syncs[T] = { recordId: "rec1", snapshot: { ...e.item }, error: null };
    expect(statusOf(e, T)).toBe("synced");

    const { queue } = refreshSnapshots(q, [item({ closed: true, closedDay: "2026-10-08" })], 7);
    expect(statusOf(queue.entries[0], T)).toBe("changed");

    queue.entries[0].syncs[T].error = "字段类型不对";
    expect(statusOf(queue.entries[0], T)).toBe("failed");
  });

  it("刷新快照：没变就原样返回；找不到标 missing 不删；别的项目不碰", () => {
    const q = addEntry(emptyQueue(), item(), project, "t");
    expect(refreshSnapshots(q, [item()], 7)).toMatchObject({ changed: false, queue: q });

    const gone = refreshSnapshots(q, [], 7);
    expect(gone.changed).toBe(true);
    expect(gone.queue.entries[0].missing).toBe(true);

    expect(refreshSnapshots(q, [], 8)).toMatchObject({ changed: false });
  });

  // 宿主的那份在 gantt-core/src/feishu.rs，sdk/ 里这份由 scripts/sync-sdk.mjs 从它抽出来
  it("比较字段和 gantt-core/src/feishu.rs 的 SNAPSHOT_FIELDS 一字不差", () => {
    const fields = JSON.parse(read("../../sdk/feishu-snapshot-fields.json"));
    expect(fields).toEqual(SNAPSHOT_FIELDS);
  });
});

describe("解析 lark-cli 的输出", () => {
  it("链接：base 带表、知识库、认不出", () => {
    expect(parseBaseLink("https://x.feishu.cn/base/bascnAbc?table=tblXyz&view=vew1")).toEqual({
      kind: "base",
      baseToken: "bascnAbc",
      tableId: "tblXyz",
    });
    expect(parseBaseLink("https://x.feishu.cn/wiki/wikAbc")).toMatchObject({ kind: "wiki", token: "wikAbc" });
    expect(parseBaseLink("问题记录")).toBeNull();
  });

  it("失败输出带上 hint —— 授权不足时用户要看到修复命令", () => {
    const out = JSON.stringify({ ok: false, error: { message: "need_user_authorization", hint: "requires scope(s): search:docs:read" } });
    expect(parseLark(out)).toEqual({ ok: false, error: "need_user_authorization\nrequires scope(s): search:docs:read" });
  });

  it("按形状找数组，不依赖外壳", () => {
    // lark-cli 1.0.44 的真实形状：标题带高亮标签，链接/token/类型在 result_meta 里
    const search = {
      ok: true,
      data: {
        results: [
          {
            entity_type: "WIKI",
            title_highlighted: "Philips <h>Hamburg</h> - Issue List",
            summary_highlighted: "",
            result_meta: {
              doc_types: "BITABLE",
              owner_name: "Ansel Zhong",
              token: "J1Gq",
              url: "https://x.feishu.cn/wiki/J1Gq?visible_space_id=756",
            },
          },
        ],
      },
    };
    expect(parseSearchResults(search)).toEqual([
      {
        title: "Philips Hamburg - Issue List",
        url: "https://x.feishu.cn/wiki/J1Gq?visible_space_id=756",
        token: "J1Gq",
        type: "bitable",
        owner: "Ansel Zhong",
      },
    ]);
    expect(parseTables({ data: { items: [{ table_id: "tbl1", name: "问题" }] } })).toEqual([{ id: "tbl1", name: "问题" }]);
    expect(parseUsers({ users: [{ open_id: "ou_1", name: "张三", department_name: "制造部" }] })).toEqual([
      { openId: "ou_1", name: "张三", extra: "制造部" },
    ]);
  });
});

describe("浏览树：我的知识库", () => {
  it("知识库节点：多维表格可选、用 obj_token；有子节点的都能展开（多维表格也可能有）", () => {
    const data = {
      data: {
        nodes: [
          { node_token: "n1", obj_token: "doc1", obj_type: "docx", has_child: true, space_id: "748", title: "目录" },
          { node_token: "n2", obj_token: "bas2", obj_type: "bitable", has_child: true, space_id: "748", title: "问题表" },
          { node_token: "n3", obj_token: "doc3", obj_type: "docx", has_child: false, space_id: "748", title: "说明" },
        ],
      },
    };
    const [dir, base, leaf] = parseWikiNodes(data);
    expect(dir).toMatchObject({ kind: "wiki", base: null, load: { spaceId: "748", parent: "n1" } });
    expect(base).toMatchObject({ kind: "bitable", base: { baseToken: "bas2", baseName: "问题表" }, load: { parent: "n2" } });
    expect(leaf).toMatchObject({ kind: "wiki", base: null, load: null });
  });

});

describe("后台 Agent", () => {
  it("安全：写只能走 gantt feishu write；lark-cli 只放行读命令；删除和直写被明确拒绝", () => {
    const args: string[] = agentArgs();
    const allow = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
    const deny = args.slice(args.indexOf("--disallowedTools") + 1);

    expect(allow).toContain("Bash(gantt feishu write:*)");
    // 没有任何宽泛的放行
    for (const bad of ["Bash", "Bash(*)", "Bash(lark-cli:*)", "Bash(gantt feishu:*)", "Write", "Edit"]) {
      expect(allow).not.toContain(bad);
    }
    // 放行的 lark-cli 全是读
    const lark = allow.filter((a) => a.startsWith("Bash(lark-cli"));
    expect(lark.every((a) => /\+(field-list|field-search-options|table-list|node-get):\*\)$/.test(a))).toBe(true);
    // 删除、直写、原始 API 都在拒绝名单里（防用户全局设置里放行过 lark-cli）
    for (const cmd of ["+record-delete", "+table-delete", "+field-delete", "+record-upsert", "+record-batch-update"]) {
      expect(deny).toContain(`Bash(lark-cli base ${cmd}:*)`);
    }
    expect(deny).toContain("Bash(lark-cli api:*)");
    expect(deny).toContain("Bash(gantt feishu mark-synced:*)");
  });

  it("提示词点名技能、目标和 keys，并说明无人值守", () => {
    const p = buildSyncPrompt({ target: { baseToken: "bas1", tableId: "tbl1", tableName: "问题" }, keys: ["note:1", "risk:5"] });
    expect(p).toContain("gantt-feishu");
    expect(p).toContain("--target bas1:tbl1");
    expect(p).toContain("note:1,risk:5");
    expect(p).toContain("不要向用户提问");
    expect(p).toContain("gantt feishu write");
  });

  it("stream-json：文本、工具调用、结果", () => {
    const tool = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "开始" }, { type: "tool_use", name: "Bash", input: { command: "gantt feishu queue" } }] },
    });
    expect(describeStreamLine(tool)).toEqual([
      { type: "text", text: "开始" },
      { type: "tool", text: "Bash：gantt feishu queue" },
    ]);
    const done = JSON.stringify({ type: "result", is_error: false, result: "成功 2 条", total_cost_usd: 0.05 });
    expect(describeStreamLine(done)).toEqual([{ type: "result", text: "成功 2 条", cost: 0.05 }]);
  });
});

describe("能被宿主加载", () => {
  it("manifest 通过校验，没有警告，声明了要用的程序和技能", () => {
    const r = validateManifest(read("./manifest.json"), "feishu-sync");
    expect(r).toMatchObject({
      ok: true,
      warnings: [],
      manifest: { permissions: { exec: ["claude", "lark-cli", "gantt"] }, skills: [{ dir: "skill", name: "gantt-feishu" }] },
    });
  });

  it("入口没有 import（宿主从 Blob URL 加载，没有模块解析）", () => {
    expect(/\bfrom\s*["']|\bimport\s*\(|\bimport\s+["']/.test(read("./main.js"))).toBe(false);
  });

  it("附带的技能有 SKILL.md，名字和 manifest 一致", () => {
    expect(read("./skill/SKILL.md")).toMatch(/^---\nname: gantt-feishu\n/);
  });
});
