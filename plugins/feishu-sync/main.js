/**
 * 飞书同步插件：选多维表格，后台起 `claude -p` 用 gantt-feishu 技能逐条写入。
 * data/queue.json 和 `gantt feishu queue / mark-synced` 共用（格式见 feishu.rs）。
 * 单文件无 import（宿主按 Blob URL 加载）；React 用 api.react。
 */

/* ---------------- 队列 ---------------- */

export const QUEUE_FILE = "queue.json";
export const CONFIG_FILE = "config.json";

/** 判断同步后是否改过。⚠️ 和 gantt-core/src/feishu.rs 的 SNAPSHOT_FIELDS 必须一字不差 */
export const SNAPSHOT_FIELDS = [
  "title", "kind", "kindLabel", "priority", "personId", "personName", "taskId", "taskName", "day",
  "closed", "closedDay", "resolution", "riskLevel",
];

export const targetKey = (t) => `${t.baseToken}:${t.tableId}`;

/**
 * 有 noteId 就用 `note:<id>`：改分拣（问题→风险）时行 key 会变，
 * 但仍是同一条，飞书上应更新原记录而不是再建。
 */
export function entryKey(item) {
  return item.noteId != null ? `note:${item.noteId}` : item.key;
}

export function emptyQueue() {
  return { version: 1, entries: [] };
}

export function parseQueue(text) {
  if (!text) return emptyQueue();
  try {
    const q = JSON.parse(text);
    if (q && Array.isArray(q.entries)) return q;
  } catch {
    /* 坏文件当空的，别让页面打不开 */
  }
  return emptyQueue();
}

/** 快照：比较字段 + 识别字段 */
export function pickSnapshot(item) {
  const out = { key: item.key, source: item.source, noteId: item.noteId ?? null };
  for (const f of SNAPSHOT_FIELDS) out[f] = item[f] ?? null;
  return out;
}

export function sameSnapshot(a, b) {
  return SNAPSHOT_FIELDS.every((f) => (a?.[f] ?? null) === (b?.[f] ?? null));
}

/** 和 feishu.rs 的 status_of 同一套判定：pending / failed / changed / synced */
export function statusOf(entry, tkey) {
  const sync = entry.syncs?.[tkey];
  if (!sync) return "pending";
  if (sync.error != null) return "failed";
  if (!sync.recordId) return "pending";
  return sameSnapshot(entry.item, sync.snapshot) ? "synced" : "changed";
}

export function findEntry(queue, key) {
  return queue.entries.find((e) => e.key === key) ?? null;
}

export function addEntry(queue, item, project, now) {
  const key = entryKey(item);
  if (findEntry(queue, key)) return queue;
  return {
    ...queue,
    entries: [
      ...queue.entries,
      {
        key,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        addedAt: now,
        missing: false,
        item: pickSnapshot(item),
        syncs: {},
      },
    ],
  };
}

/** 只动本地，飞书上的记录不碰 */
export function removeEntry(queue, key) {
  return { ...queue, entries: queue.entries.filter((e) => e.key !== key) };
}

/**
 * 只碰当前项目的 —— 别项目的事项不在内存里，找不到不等于删了。
 * 找不到的标 missing 而不删：可能会撤销，且飞书上记录还在。
 */
export function refreshSnapshots(queue, items, projectId) {
  const byKey = new Map(items.map((it) => [entryKey(it), it]));
  let changed = false;
  const entries = queue.entries.map((e) => {
    if (e.projectId !== projectId) return e;
    const it = byKey.get(e.key);
    if (!it) {
      if (e.missing) return e;
      changed = true;
      return { ...e, missing: true };
    }
    const snap = pickSnapshot(it);
    if (!e.missing && sameSnapshot(e.item, snap) && e.item.key === snap.key) return e;
    changed = true;
    return { ...e, missing: false, item: snap };
  });
  return { queue: changed ? { ...queue, entries } : queue, changed };
}

/* ---------------- 解析 lark-cli 的输出 ---------------- */

/** /base/<token> 直接认；/wiki/<token> 是知识库节点，还要再解析背后是不是多维表格 */
export function parseBaseLink(text) {
  const s = String(text ?? "").trim();
  const base = /\/base\/([A-Za-z0-9]+)/.exec(s);
  if (base) {
    const table = /[?&]table=(tbl[A-Za-z0-9]+)/.exec(s);
    return { kind: "base", baseToken: base[1], tableId: table ? table[1] : null };
  }
  const wiki = /\/wiki\/([A-Za-z0-9]+)/.exec(s);
  if (wiki) {
    const table = /[?&]table=(tbl[A-Za-z0-9]+)/.exec(s);
    return { kind: "wiki", token: wiki[1], tableId: table ? table[1] : null };
  }
  return null;
}

/** lark-cli 约定：`{ ok: false, error: { message, hint } }` 为失败 */
export function parseLark(stdout) {
  let j;
  try {
    j = JSON.parse(stdout);
  } catch {
    return { ok: false, error: (stdout || "lark-cli 没有输出").trim().slice(0, 400) };
  }
  if (j && j.ok === false) {
    const e = j.error ?? {};
    return { ok: false, error: [e.message, e.hint].filter(Boolean).join("\n") || "lark-cli 报错" };
  }
  return { ok: true, data: j };
}

/** lark-cli 各命令外壳不同（有的包 data），按形状找数组比按路径稳 */
export function findArray(root, pred) {
  const queue = [root];
  while (queue.length) {
    const v = queue.shift();
    if (Array.isArray(v)) {
      if (v.length && v.every((x) => x && typeof x === "object" && pred(x))) return v;
      queue.push(...v);
    } else if (v && typeof v === "object") {
      queue.push(...Object.values(v));
    }
  }
  return [];
}

export function findKey(root, key) {
  const queue = [root];
  while (queue.length) {
    const v = queue.shift();
    if (v && typeof v === "object") {
      if (!Array.isArray(v) && typeof v[key] === "string") return v[key];
      queue.push(...Object.values(v));
    }
  }
  return null;
}

const stripTags = (s) => String(s ?? "").replace(/<\/?[a-z]+>/gi, "");

/**
 * drive +search：标题在 title_highlighted（带 <h> 标签），链接/token/类型在
 * result_meta —— 与接口文档示例不同，按实际输出来。
 */
export function parseSearchResults(data) {
  return findArray(data, (x) => "title_highlighted" in x || "result_meta" in x || "title" in x).map((r) => {
    const meta = r.result_meta ?? {};
    return {
      title: stripTags(r.title ?? r.title_highlighted ?? meta.title ?? "（无标题）"),
      url: r.url ?? meta.url ?? "",
      token: r.token ?? meta.token ?? null,
      type: String(r.doc_type ?? meta.doc_types ?? r.type ?? "").toLowerCase() || null,
      owner: meta.owner_name ?? null,
    };
  });
}

export function parseTables(data) {
  return findArray(data, (x) => (x.table_id || x.id) && x.name).map((t) => ({
    id: t.table_id ?? t.id,
    name: t.name,
  }));
}

export function parseUsers(data) {
  return findArray(data, (x) => x.open_id).map((u) => ({
    openId: u.open_id,
    name: u.name ?? u.localized_name ?? u.en_name ?? u.open_id,
    extra: [u.department_name ?? u.departments?.[0]?.name, u.email ?? u.enterprise_email]
      .filter(Boolean)
      .join(" · "),
  }));
}

/* ---------------- 浏览树 ---------------- */

/**
 * 只浏览「我的知识库」（my_library）；团队空间节点太多，用搜索。
 * 节点：base 非 null 才能选；load = { spaceId, parent }，无子节点为 null。
 */

/** 我的知识库在 wiki 接口里的空间 id */
export const MY_LIBRARY = "my_library";

export function parseWikiNodes(data) {
  return findArray(data, (x) => x.node_token).map((n) => {
    const isBase = n.obj_type === "bitable";
    return {
      id: `wiki:${n.node_token}`,
      spaceId: n.space_id ?? null,
      kind: isBase ? "bitable" : "wiki",
      label: n.title || "（无标题）",
      base: isBase ? { baseToken: n.obj_token, baseName: n.title || "", url: "" } : null,
      // 多维表格也可能挂子节点
      load: n.has_child ? { spaceId: n.space_id || MY_LIBRARY, parent: n.node_token } : null,
    };
  });
}

/* ---------------- 后台 Agent ---------------- */

/**
 * 写飞书只有 `gantt feishu write`：只新建或更新该事项自己建的记录，不删、空值不写。
 * lark-cli 只放行读命令。
 */
export const AGENT_TOOLS = [
  "Bash(gantt feishu queue:*)",
  "Bash(gantt feishu write:*)",
  "Bash(gantt feishu mark-failed:*)",
  "Bash(lark-cli base +field-list:*)",
  "Bash(lark-cli base +field-search-options:*)",
  "Bash(lark-cli base +table-list:*)",
  "Bash(lark-cli wiki +node-get:*)",
  "Read",
  "Skill",
];

/** 用户 settings 若放行过 `Bash(lark-cli:*)`，白名单挡不住；deny 优先于 allow，再钉一次 */
export const AGENT_DENY = [
  "Bash(lark-cli base +record-delete:*)",
  "Bash(lark-cli base +record-upsert:*)",
  "Bash(lark-cli base +record-batch-create:*)",
  "Bash(lark-cli base +record-batch-update:*)",
  "Bash(lark-cli base +table-delete:*)",
  "Bash(lark-cli base +table-create:*)",
  "Bash(lark-cli base +table-update:*)",
  "Bash(lark-cli base +field-delete:*)",
  "Bash(lark-cli base +field-create:*)",
  "Bash(lark-cli base +field-update:*)",
  "Bash(lark-cli base +view-delete:*)",
  "Bash(lark-cli drive +delete:*)",
  "Bash(lark-cli wiki +node-delete:*)",
  "Bash(lark-cli wiki +delete-space:*)",
  "Bash(lark-cli api:*)",
  "Bash(gantt feishu mark-synced:*)",
  "Write",
  "Edit",
];

export function agentArgs() {
  return [
    "-p", "--output-format", "stream-json", "--verbose",
    "--allowedTools", ...AGENT_TOOLS,
    "--disallowedTools", ...AGENT_DENY,
  ];
}

/** 提示词走 stdin：--allowedTools 是变长参数，放命令行上会吞掉提示词 */
export function buildSyncPrompt({ target, keys }) {
  return [
    "使用 gantt-feishu 技能，把 gantt 飞书同步队列里的事项写入飞书多维表格。",
    "",
    `- 目标表：base-token=${target.baseToken}，table-id=${target.tableId}（gantt 命令里写 --target ${targetKey(target)}）`,
    target.baseName || target.tableName
      ? `- 表名：${[target.baseName, target.tableName].filter(Boolean).join(" / ")}`
      : null,
    `- 本次只处理这些 key：${keys.join(",")}`,
    "- 这是后台无人值守运行：不要向用户提问。某一条处理不了，就用 `gantt feishu mark-failed` 记下原因，然后继续下一条。",
    "- 写入只能用 `gantt feishu write`（它自己决定新建还是更新）。不要删除任何记录、表或字段。",
    "- 全部处理完后，用一两句中文汇总：成功几条、失败几条、失败原因。",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export function describeStreamLine(line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return line.trim() ? [{ type: "raw", text: line }] : [];
  }
  if (ev.type === "system" && ev.subtype === "init") return [{ type: "info", text: "Claude 已启动" }];
  if (ev.type === "assistant") {
    return (ev.message?.content ?? []).flatMap((c) => {
      if (c.type === "text" && c.text?.trim()) return [{ type: "text", text: c.text.trim() }];
      if (c.type === "tool_use") {
        const cmd = c.input?.command ?? c.input?.skill ?? c.input?.file_path ?? "";
        return [{ type: "tool", text: `${c.name}${cmd ? "：" + String(cmd).slice(0, 300) : ""}` }];
      }
      return [];
    });
  }
  if (ev.type === "user") {
    return (ev.message?.content ?? [])
      .filter((c) => c.type === "tool_result" && c.is_error)
      .map((c) => ({
        type: "error",
        text: String(typeof c.content === "string" ? c.content : JSON.stringify(c.content)).slice(0, 300),
      }));
  }
  if (ev.type === "result") {
    return [
      {
        type: ev.is_error ? "error" : "result",
        text: String(ev.result ?? (ev.is_error ? "运行失败" : "完成")),
        cost: ev.total_cost_usd ?? null,
      },
    ];
  }
  return [];
}

/** 一次 tool 调用结束就可能有一条回写了队列 —— 用它决定什么时候重读 */
export function isToolResult(line) {
  return line.includes('"tool_result"');
}

/* ---------------- 配置 ---------------- */

export function defaultConfig() {
  // tableRules / ruleDocs 的 key 都是 <base>:<table>；ruleDocs 存显示用的表名
  return { globalRules: "", tableRules: {}, ruleDocs: {}, people: {}, target: null };
}

export function parseConfig(text) {
  try {
    return { ...defaultConfig(), ...(JSON.parse(text ?? "") ?? {}) };
  } catch {
    return defaultConfig();
  }
}

const STATUS = {
  pending: { label: "未同步", color: "#94a3b8" },
  synced: { label: "已同步", color: "#10b981" },
  changed: { label: "有变更", color: "#f59e0b" },
  failed: { label: "失败", color: "#f43f5e" },
};

/* ---------------- 插件入口 ---------------- */

export function onload(api) {
  const React = api.react;
  const h = React.createElement;
  const { useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

  /* ---------------- 共享状态 ---------------- */

  const state = { queue: emptyQueue(), config: defaultConfig(), version: 0 };
  const subs = new Set();
  const notify = () => {
    state.version += 1;
    for (const fn of subs) fn();
    api.itemBadges.refresh();
  };
  const subscribe = (fn) => {
    subs.add(fn);
    return () => subs.delete(fn);
  };
  const useShared = () => useSyncExternalStore(subscribe, () => state.version);

  /**
   * 写操作串成一条链：读最新文件 → 改 → 写回。
   * 必须先读：gantt CLI 会同时回写，用内存旧值覆盖会抹掉同步结果。
   */
  let chain = Promise.resolve();
  const mutateQueue = (fn) => {
    chain = chain
      .then(async () => {
        const fresh = parseQueue(await api.storage.read(QUEUE_FILE));
        const next = fn(fresh);
        if (next !== fresh) await api.storage.write(QUEUE_FILE, JSON.stringify(next, null, 2));
        state.queue = next;
        notify();
      })
      .catch((e) => api.log("写队列失败", e));
    return chain;
  };
  const mutateConfig = (fn) => {
    chain = chain
      .then(async () => {
        const next = fn(parseConfig(await api.storage.read(CONFIG_FILE)));
        await api.storage.write(CONFIG_FILE, JSON.stringify(next, null, 2));
        state.config = next;
        notify();
      })
      .catch((e) => api.log("写配置失败", e));
    return chain;
  };
  const reloadFromDisk = async () => {
    const [q, c] = await Promise.all([api.storage.read(QUEUE_FILE), api.storage.read(CONFIG_FILE)]);
    state.queue = parseQueue(q);
    state.config = parseConfig(c);
    notify();
  };

  /** 事项改了刷新快照，「有变更」由此而来 */
  let refreshTimer = null;
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      const project = api.data.project();
      if (!project) return;
      const items = api.data.items.list();
      const { changed } = refreshSnapshots(state.queue, items, project.id);
      if (changed) void mutateQueue((q) => refreshSnapshots(q, items, project.id).queue);
    }, 400);
  };
  api.data.items.subscribe(scheduleRefresh);
  void reloadFromDisk().then(scheduleRefresh);

  /* ---------------- 事项页：分拣菜单 + 徽标 ---------------- */

  api.itemActions.register({
    id: "feishu-sync.toggle",
    hint: "同步队列里的事项可以在「飞书」页写入多维表格",
    label: (item) => {
      if (item.kind == null) return null;
      return findEntry(state.queue, entryKey(item)) ? "移出飞书同步" : "加入飞书同步";
    },
    run: (item) => {
      const key = entryKey(item);
      const project = api.data.project();
      return mutateQueue((q) =>
        findEntry(q, key) ? removeEntry(q, key) : addEntry(q, item, project, new Date().toISOString()),
      );
    },
  });

  api.itemBadges.register({
    id: "feishu-sync.badge",
    render: (item) => {
      const e = findEntry(state.queue, entryKey(item));
      if (!e) return null;
      const t = state.config.target;
      if (!t) return { text: "飞书", title: "在飞书同步队列里，还没选目标表", color: STATUS.pending.color };
      const st = statusOf(e, targetKey(t));
      const mark = { pending: "", synced: " ✓", changed: " •", failed: " !" }[st];
      return { text: `飞书${mark}`, title: `飞书同步：${STATUS[st].label}`, color: STATUS[st].color };
    },
  });

  /* ---------------- lark-cli ---------------- */

  const lark = async (args) => {
    const r = await api.proc.exec("lark-cli", [...args, "--as", "user"]);
    const parsed = parseLark(r.stdout || r.stderr);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.data;
  };

  /**
   * 知识库节点 → 背后的多维表格 token。
   * 要传完整链接：只给 token 的话 lark-cli 当它是 obj_token，会要求 --obj-type
   */
  const resolveWiki = async (token, url) => {
    const ref = url && /\/wiki\//.test(url) ? url : `https://feishu.cn/wiki/${token}`;
    const data = await lark(["wiki", "+node-get", "--node-token", ref]);
    const type = findKey(data, "obj_type");
    const obj = findKey(data, "obj_token");
    if (type && type !== "bitable") throw new Error(`这个知识库节点是 ${type}，不是多维表格`);
    if (!obj) throw new Error("没从知识库节点里拿到多维表格的 token");
    return obj;
  };

  const listTables = async (baseToken) =>
    parseTables(await lark(["base", "+table-list", "--base-token", baseToken]));

  /* ---------------- 视图 ---------------- */

  function Btn({ primary, danger, small, ...props }) {
    const cls = ["fs-btn", primary && "fs-primary", danger && "fs-danger", small && "fs-small"]
      .filter(Boolean)
      .join(" ");
    return h("button", { ...props, className: cls });
  }

  /* ---------------- 浏览树的加载与缓存 ---------------- */

  /** 放插件闭包而非组件 state：关掉弹窗再打开不用重新加载 */
  const treeCache = new Map(); // id → { status: "loading" | "done" | "error", children, error }
  const treeSubs = new Set();
  const treeNotify = () => treeSubs.forEach((fn) => fn());

  const fetchChildren = async (load) => {
    const args = ["wiki", "+node-list", "--space-id", load.spaceId, "--page-all", "--page-limit", "20"];
    if (load.parent) args.push("--parent-node-token", load.parent);
    return parseWikiNodes(await lark(args));
  };

  const loadNode = (id, load) => {
    const hit = treeCache.get(id);
    if (hit && hit.status !== "error") return;
    treeCache.set(id, { status: "loading", children: [], error: "" });
    treeNotify();
    fetchChildren(load).then(
      (children) => {
        treeCache.set(id, { status: "done", children, error: "" });
        treeNotify();
      },
      (e) => {
        treeCache.set(id, { status: "error", children: [], error: e?.message ?? String(e) });
        treeNotify();
      },
    );
  };

  const ROOT = { id: "__my_library", load: { spaceId: MY_LIBRARY, parent: "" } };

  const KIND_ICON = { wiki: "▤", bitable: "▦" };

  /** lasts[i]：第 i 层祖先是否为该层最后一个，是则那一列不画竖线 */
  const guide = (lasts, isLast) =>
    lasts.map((last) => (last ? "  " : "│ ")).join("") + (isLast ? "└ " : "├ ");

  /** 递归渲染，展开哪个才加载哪个 */
  function TreeLevel({ id, load, lasts, expanded, toggle, onPick }) {
    const entry = treeCache.get(id);
    const prefix = lasts.map((last) => (last ? "  " : "│ ")).join("") + "  ";
    const note = (children) =>
      h("div", { className: "fs-tree-note" }, h("span", { className: "fs-tree-guide" }, prefix), children);

    if (!entry || entry.status === "loading") return note(h("span", { className: "fs-dim" }, "加载中…"));
    if (entry.status === "error") {
      return h(
        "div",
        { className: "fs-stack fs-tree-err" },
        h("pre", { className: "fs-error" }, entry.error),
        h(Btn, { small: true, onClick: () => loadNode(id, load) }, "重试"),
      );
    }
    if (entry.children.length === 0) {
      return note(
        h(
          "span",
          { className: "fs-dim" },
          lasts.length === 0 ? "我的知识库是空的。别处的多维表格用「搜索」找。" : "（空）",
        ),
      );
    }
    return entry.children.map((n, i) => {
      const isLast = i === entry.children.length - 1;
      const open = expanded.has(n.id);
      const click = () => (n.base ? onPick(n.base) : n.load && toggle(n.id, n.load));
      return h(
        React.Fragment,
        { key: n.id },
        h(
          "div",
          {
            className: `fs-tree-row${n.base ? " fs-tree-pick" : ""}${n.load || n.base ? "" : " fs-tree-leaf"}`,
            onClick: click,
            title: n.base ? "选这个多维表格" : n.load ? (open ? "收起" : "展开") : "只有多维表格能选",
          },
          h("span", { className: "fs-tree-guide" }, guide(lasts, isLast)),
          h("span", { className: "fs-tree-icon" }, KIND_ICON[n.kind] ?? "▤"),
          h("span", { className: "fs-tree-text" }, n.label),
          // 小三角单独可点，点名字是选中
          n.load &&
            h(
              "button",
              {
                className: "fs-tree-caret",
                onClick: (e) => {
                  e.stopPropagation();
                  toggle(n.id, n.load);
                },
                "aria-label": open ? "收起" : "展开",
              },
              open ? "▾" : "▸",
            ),
          n.base && h("span", { className: "fs-tree-hint" }, "选择"),
        ),
        open &&
          n.load &&
          h(TreeLevel, { id: n.id, load: n.load, lasts: [...lasts, isLast], expanded, toggle, onPick }),
      );
    });
  }

  /** 只有一张数据表就直接选 */
  function TablePick({ base, onBack, onChoose }) {
    const [tables, setTables] = useState(null);
    const [error, setError] = useState("");

    const choose = (t) => {
      const target = {
        baseToken: base.baseToken,
        tableId: t.id,
        baseName: base.baseName,
        tableName: t.name,
        url: base.url,
      };
      onChoose(target);
    };

    useEffect(() => {
      let live = true;
      listTables(base.baseToken).then(
        (list) => {
          if (!live) return;
          if (list.length === 1) choose(list[0]);
          else setTables(list);
        },
        (e) => live && setError(e?.message ?? String(e)),
      );
      return () => {
        live = false;
      };
    }, [base.baseToken]);

    return h(
      "div",
      { className: "fs-stack" },
      h(
        "div",
        { className: "fs-row" },
        onBack && h(Btn, { small: true, onClick: onBack }, "← 返回"),
        h("span", { className: "fs-label" }, `「${base.baseName || base.baseToken}」里的数据表`),
      ),
      error && h("pre", { className: "fs-error" }, error),
      tables == null && !error && h("div", { className: "fs-dim" }, "加载中…"),
      tables &&
        h(
          "div",
          { className: "fs-list" },
          tables.length === 0 && h("div", { className: "fs-dim" }, "这个多维表格里没有数据表"),
          tables.map((t) =>
            h(
              "button",
              {
                key: t.id,
                className: `fs-pick${t.id === base.preselect ? " fs-pick-on" : ""}`,
                onClick: () => choose(t),
              },
              h("span", null, t.name),
              h("span", { className: "fs-dim fs-mono" }, t.id),
            ),
          ),
        ),
    );
  }

  /** 选表弹窗：搜索框空时看目录树，输入则在我的知识库里搜，也认粘贴的链接 */
  function TreeModal({ title, onClose, onSelect }) {
    const [, bump] = useState(0);
    const [expanded, setExpanded] = useState(() => new Set());
    const [base, setBase] = useState(null);
    const [query, setQuery] = useState("");
    const [hits, setHits] = useState(null); // null = 没在搜
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const seq = useRef(0);

    useEffect(() => {
      const fn = () => bump((v) => v + 1);
      treeSubs.add(fn);
      loadNode(ROOT.id, ROOT.load);
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      };
      window.addEventListener("keydown", onKey, true);
      return () => {
        treeSubs.delete(fn);
        window.removeEventListener("keydown", onKey, true);
      };
    }, []);

    /** 搜索限定范围要真实 space id，从第一层节点上取 */
    const librarySpace = () => treeCache.get(ROOT.id)?.children?.find((n) => n.spaceId)?.spaceId ?? null;

    // 停 400ms 才发；旧请求晚回来的结果丢掉
    useEffect(() => {
      const q = query.trim();
      setError("");
      if (!q) {
        setHits(null);
        return;
      }
      const link = parseBaseLink(q);
      const my = ++seq.current;
      const timer = setTimeout(async () => {
        setBusy(true);
        try {
          if (link) {
            const baseToken = link.kind === "wiki" ? await resolveWiki(link.token, q) : link.baseToken;
            if (my === seq.current) setBase({ baseToken, baseName: "", url: q, preselect: link.tableId });
            return;
          }
          const space = librarySpace();
          if (!space) throw new Error("我的知识库还没加载出来（或者是空的），稍等再搜");
          const data = await lark([
            "drive", "+search", "--query", q, "--space-ids", space, "--doc-types", "bitable", "--page-size", "20",
          ]);
          if (my === seq.current) setHits(parseSearchResults(data));
        } catch (e) {
          if (my === seq.current) setError(e?.message ?? String(e));
        } finally {
          if (my === seq.current) setBusy(false);
        }
      }, 400);
      return () => clearTimeout(timer);
    }, [query]);

    const pickHit = async (r) => {
      setBusy(true);
      setError("");
      try {
        const link = parseBaseLink(r.url);
        const baseToken =
          link?.kind === "wiki" ? await resolveWiki(link.token, r.url) : (link?.baseToken ?? r.token);
        if (!baseToken) throw new Error("搜索结果里没有链接或 token");
        setBase({ baseToken, baseName: r.title, url: r.url, preselect: link?.tableId ?? null });
      } catch (e) {
        setError(e?.message ?? String(e));
      } finally {
        setBusy(false);
      }
    };

    const toggle = (id, load) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else {
          next.add(id);
          loadNode(id, load);
        }
        return next;
      });

    let body;
    if (base) {
      body = h(TablePick, {
        base,
        onBack: () => setBase(null),
        onChoose: (t) => {
          onSelect(t);
          onClose();
        },
      });
    } else if (hits) {
      body = h(
        "div",
        { className: "fs-tree" },
        hits.length === 0 && h("div", { className: "fs-tree-note fs-dim" }, "我的知识库里没搜到相关的多维表格"),
        hits.map((r, i) =>
          h(
            "div",
            { key: i, className: "fs-tree-row fs-tree-pick", onClick: () => void pickHit(r), title: r.url },
            h("span", { className: "fs-tree-icon" }, "▦"),
            h("span", { className: "fs-tree-text" }, r.title),
            r.owner && h("span", { className: "fs-dim" }, ` · ${r.owner}`),
            h("span", { className: "fs-tree-hint" }, "选择"),
          ),
        ),
      );
    } else {
      body = h(
        "div",
        { className: "fs-tree" },
        h("div", { className: "fs-tree-row fs-tree-root" }, h("span", { className: "fs-tree-text" }, "我的知识库")),
        h(TreeLevel, { id: ROOT.id, load: ROOT.load, lasts: [], expanded, toggle, onPick: setBase }),
      );
    }

    return h(
      "div",
      { className: "fs-modal-mask", onMouseDown: (e) => e.target === e.currentTarget && onClose() },
      h(
        "div",
        { className: "fs-modal", role: "dialog", "aria-label": title },
        h(
          "div",
          { className: "fs-row fs-modal-head" },
          h("span", { className: "fs-h1" }, title),
          h("span", { className: "fs-grow" }),
          !base &&
            !hits &&
            h(
              Btn,
              {
                small: true,
                title: "清掉已加载的目录，重新从飞书读",
                onClick: () => {
                  treeCache.clear();
                  setExpanded(new Set());
                  loadNode(ROOT.id, ROOT.load);
                },
              },
              "刷新",
            ),
          h(Btn, { small: true, onClick: onClose }, "关闭"),
        ),
        !base &&
          h("input", {
            className: "fs-input fs-modal-search",
            autoFocus: true,
            value: query,
            placeholder: "在我的知识库里搜索多维表格（也可以粘贴链接）",
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => {
              if (e.key !== "Escape") e.stopPropagation();
            },
          }),
        busy && h("div", { className: "fs-dim" }, "搜索中…"),
        error && h("pre", { className: "fs-error" }, error),
        body,
        !base &&
          h(
            "div",
            { className: "fs-dim fs-modal-foot" },
            hits ? "清空搜索框回到目录树。" : "▦ 是多维表格，点一下就选它；▤ 是文档或目录，点一下展开。",
          ),
      ),
    );
  }

  function useRun() {
    const [run, setRun] = useState(null); // { log: [], proc, startedAt, done, code }
    const ref = useRef(null);

    const start = async (target, keys) => {
      const log = [];
      const push = (entries) => {
        log.push(...entries);
        if (log.length > 300) log.splice(0, log.length - 300);
        setRun((r) => (r ? { ...r, log: [...log] } : r));
      };
      let reloadTimer = null;
      const reloadSoon = () => {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => void reloadFromDisk(), 300);
      };
      setRun({ log: [], startedAt: Date.now(), done: false, code: null, keys });
      try {
        const proc = await api.proc.spawn("claude", agentArgs(), {
          stdin: buildSyncPrompt({ target, keys }),
          onStdout: (line) => {
            push(describeStreamLine(line));
            if (isToolResult(line)) reloadSoon();
          },
          onStderr: (line) => line.trim() && push([{ type: "stderr", text: line }]),
        });
        ref.current = proc;
        const { code } = await proc.done;
        await reloadFromDisk();
        setRun((r) => ({ ...r, done: true, code }));
      } catch (e) {
        push([{ type: "error", text: e?.message ?? String(e) }]);
        setRun((r) => ({ ...r, done: true, code: -1 }));
      } finally {
        ref.current = null;
      }
    };
    const cancel = () => ref.current?.kill();
    return { run, start, cancel, clear: () => setRun(null) };
  }

  function useEnv() {
    const [env, setEnv] = useState(null);
    useEffect(() => {
      let live = true;
      void Promise.all(
        ["claude", "lark-cli", "gantt"].map(async (p) => [p, await api.proc.which(p).catch(() => null)]),
      ).then((pairs) => live && setEnv(Object.fromEntries(pairs)));
      return () => {
        live = false;
      };
    }, []);
    return env;
  }

  function QueueTab({ target, running, onSync }) {
    const project = api.data.project();
    const tkey = target ? targetKey(target) : null;
    const entries = useMemo(
      () => [...state.queue.entries].sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt))),
      [state.queue],
    );
    const [selected, setSelected] = useState(() => new Set());

    // 去掉已不在队列里的勾选
    useEffect(() => {
      setSelected((prev) => new Set([...prev].filter((k) => findEntry(state.queue, k))));
    }, [state.queue]);

    const toggle = (k) =>
      setSelected((prev) => {
        const next = new Set(prev);
        next.has(k) ? next.delete(k) : next.add(k);
        return next;
      });
    const selectable = entries.filter((e) => !e.missing);
    const selectNeeded = () =>
      setSelected(new Set(selectable.filter((e) => !tkey || statusOf(e, tkey) !== "synced").map((e) => e.key)));

    if (entries.length === 0) {
      return h(
        "div",
        { className: "fs-empty" },
        "队列是空的。到「事项」页，点一条已分拣事项右侧的类型按钮，在菜单里选「加入飞书同步」。",
      );
    }

    return h(
      "div",
      null,
      h(
        "div",
        { className: "fs-row fs-toolbar" },
        h(Btn, { small: true, onClick: selectNeeded, disabled: running }, "选中待同步"),
        h(Btn, { small: true, onClick: () => setSelected(new Set()), disabled: running }, "清空选择"),
        h("span", { className: "fs-dim" }, `共 ${entries.length} 条，已选 ${selected.size} 条`),
        h("span", { className: "fs-grow" }),
        h(
          Btn,
          {
            primary: true,
            disabled: running || !target || selected.size === 0,
            title: target ? "" : "先在上面选目标表",
            onClick: () => onSync([...selected]),
          },
          running ? "同步中…" : `同步 ${selected.size} 条`,
        ),
      ),
      h(
        "div",
        { className: "fs-list" },
        entries.map((e) => {
          const st = tkey ? statusOf(e, tkey) : null;
          const err = tkey ? e.syncs?.[tkey]?.error : null;
          const other = project && e.projectId !== project.id;
          return h(
            "label",
            { key: e.key, className: `fs-item${e.missing ? " fs-missing" : ""}` },
            h("input", {
              type: "checkbox",
              checked: selected.has(e.key),
              disabled: running || e.missing,
              onChange: () => toggle(e.key),
            }),
            h("span", { className: "fs-kind" }, e.item?.kindLabel ?? ""),
            h(
              "span",
              { className: "fs-title", title: e.item?.title },
              e.item?.title || "（没写内容）",
              e.item?.closed ? h("span", { className: "fs-dim" }, " · 已关闭") : null,
            ),
            other && h("span", { className: "fs-dim" }, e.projectName ?? "其他项目"),
            e.missing && h("span", { className: "fs-warn", title: "这条事项在 gantt 里被删除了，飞书上的记录不受影响" }, "源已删除"),
            st &&
              h(
                "span",
                { className: "fs-status", style: { color: STATUS[st].color }, title: err ?? "" },
                STATUS[st].label,
              ),
            h(
              Btn,
              {
                small: true,
                disabled: running,
                title: "只移出本地队列，飞书上已写入的记录不动",
                onClick: (ev) => {
                  ev.preventDefault();
                  void mutateQueue((q) => removeEntry(q, e.key));
                },
              },
              "移出",
            ),
          );
        }),
      ),
    );
  }

  /** 失焦时保存 */
  function RuleCard({ rkey, isTarget }) {
    const doc = state.config.ruleDocs?.[rkey] ?? {};
    const [text, setText] = useState(state.config.tableRules?.[rkey] ?? "");
    const save = () =>
      void mutateConfig((c) => ({ ...c, tableRules: { ...(c.tableRules ?? {}), [rkey]: text } }));
    const remove = () => {
      if (!window.confirm(`删除「${doc.tableName || rkey}」的填写规则？`)) return;
      void mutateConfig((c) => {
        const tableRules = { ...(c.tableRules ?? {}) };
        const ruleDocs = { ...(c.ruleDocs ?? {}) };
        delete tableRules[rkey];
        delete ruleDocs[rkey];
        return { ...c, tableRules, ruleDocs };
      });
    };
    return h(
      "div",
      { className: "fs-card" },
      h(
        "div",
        { className: "fs-row" },
        h("span", { className: "fs-tree-icon" }, "▦"),
        h(
          "span",
          { className: "fs-target", title: rkey },
          [doc.baseName, doc.tableName].filter(Boolean).join(" / ") || rkey,
        ),
        isTarget && h("span", { className: "fs-status", style: { color: "#10b981" } }, "当前同步目标"),
        h("span", { className: "fs-grow" }),
        h(Btn, { small: true, danger: true, onClick: remove }, "删除"),
      ),
      h("textarea", {
        className: "fs-textarea",
        value: text,
        placeholder:
          "写给 Agent 的填写要求，例如：\n· 「问题描述」写中文，「Description English」写对应英文\n· status 只用 Open / Closed\n· 「Category」按关联任务判断：机械 / 电气 / 软件",
        onChange: (e) => setText(e.target.value),
        onBlur: save,
        onKeyDown: (e) => e.stopPropagation(),
      }),
    );
  }

  /** 只放用户的要求；内置原则（按含义对字段、对不上不写）在技能里 */
  function RulesTab({ target }) {
    const [picking, setPicking] = useState(false);
    const keys = Object.keys(state.config.tableRules ?? {});
    const tkey = target ? targetKey(target) : null;

    const create = (t) => {
      const k = targetKey(t);
      void mutateConfig((c) => ({
        ...c,
        tableRules: { ...(c.tableRules ?? {}), [k]: c.tableRules?.[k] ?? "" },
        ruleDocs: { ...(c.ruleDocs ?? {}), [k]: { baseName: t.baseName, tableName: t.tableName } },
      }));
    };

    return h(
      "div",
      { className: "fs-stack" },
      h(
        "div",
        { className: "fs-row" },
        h(Btn, { primary: true, small: true, onClick: () => setPicking(true) }, "＋ 为文档新建填写规则"),
        h("span", { className: "fs-dim" }, "同步到哪张表，就按那张表的规则填写"),
      ),
      keys.length === 0 &&
        h("div", { className: "fs-empty" }, "还没有填写规则。先选一张多维表格，再写你希望怎么填。"),
      keys.map((k) => h(RuleCard, { key: k, rkey: k, isTarget: k === tkey })),
      picking &&
        h(TreeModal, { title: "选择要写规则的多维表格", onClose: () => setPicking(false), onSelect: create }),
    );
  }

  function PersonRow({ person }) {
    const mapped = state.config.people?.[person.id] ?? null;
    const [hits, setHits] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const save = (v) =>
      void mutateConfig((c) => {
        const people = { ...(c.people ?? {}) };
        if (v) people[person.id] = v;
        else delete people[person.id];
        return { ...c, people };
      });
    const lookup = async () => {
      setBusy(true);
      setError("");
      try {
        setHits(parseUsers(await lark(["contact", "+search-user", "--query", person.name])));
      } catch (e) {
        setError(e?.message ?? String(e));
      } finally {
        setBusy(false);
      }
    };
    return h(
      "div",
      { className: "fs-person" },
      h(
        "div",
        { className: "fs-row" },
        h("span", { className: "fs-pname" }, person.name),
        h("span", { className: "fs-dim" }, "→"),
        mapped
          ? h("span", null, mapped.name, h("span", { className: "fs-dim fs-mono" }, ` ${mapped.openId}`))
          : h("span", { className: "fs-dim" }, "未对应（同步时责任人留空）"),
        h("span", { className: "fs-grow" }),
        h(Btn, { small: true, disabled: busy, onClick: () => void lookup() }, busy ? "…" : "在飞书里查找"),
        mapped && h(Btn, { small: true, onClick: () => save(null) }, "清除"),
      ),
      error && h("pre", { className: "fs-error" }, error),
      hits &&
        h(
          "div",
          { className: "fs-list" },
          hits.length === 0 && h("div", { className: "fs-dim" }, "没找到同名用户"),
          hits.map((u) =>
            h(
              "button",
              {
                key: u.openId,
                className: "fs-pick",
                onClick: () => {
                  save({ openId: u.openId, name: u.name });
                  setHits(null);
                },
              },
              h("span", null, u.name),
              h("span", { className: "fs-dim" }, u.extra),
            ),
          ),
        ),
    );
  }

  function PeopleTab() {
    const people = api.data.people.list();
    if (people.length === 0) return h("div", { className: "fs-empty" }, "还没有负责人。");
    return h(
      "div",
      { className: "fs-stack" },
      people.map((p) => h(PersonRow, { key: p.id, person: p })),
    );
  }

  function Code({ text }) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      } catch {
        /* 剪贴板不可用时用户还能手动选中 */
      }
    };
    return h(
      "div",
      { className: "fs-codebox" },
      h("pre", { className: "fs-code" }, text),
      h(Btn, { small: true, onClick: () => void copy() }, copied ? "✓ 已复制" : "复制"),
    );
  }

  /** ok: true/false 显示检测结果；undefined 不显示 */
  function Step({ n, title, ok, children }) {
    return h(
      "div",
      { className: "fs-step" },
      h("div", { className: "fs-step-n" }, n),
      h(
        "div",
        { className: "fs-step-body" },
        h(
          "div",
          { className: "fs-row" },
          h("span", { className: "fs-step-title" }, title),
          ok === true && h("span", { className: "fs-ok" }, "✓ 已就绪"),
          ok === false && h("span", { className: "fs-warn" }, "未完成"),
        ),
        children,
      ),
    );
  }

  /** user 身份 ready 才算登录 */
  function useLarkAuth(found) {
    const [auth, setAuth] = useState(null); // null 未检测 / { ok, name, msg }
    const check = async () => {
      if (!found) return setAuth({ ok: false, msg: "没找到 lark-cli" });
      try {
        const r = await api.proc.exec("lark-cli", ["auth", "status"]);
        const j = JSON.parse(r.stdout || "{}");
        const u = j.identities?.user ?? {};
        setAuth({ ok: u.status === "ready", name: u.userName ?? null, msg: u.message ?? "" });
      } catch (e) {
        setAuth({ ok: false, msg: e?.message ?? String(e) });
      }
    };
    useEffect(() => {
      void check();
    }, [found]);
    return [auth, check];
  }

  /** 两种方式共用「准备」；能检测的步骤（程序、登录）直接显示检测结果 */
  function GuideTab({ target, env }) {
    const found = (p) => (env ? !!env[p] : undefined);
    const [auth, recheck] = useLarkAuth(found("lark-cli"));
    const t = target
      ? `「${[target.baseName, target.tableName].filter(Boolean).join(" / ")}」（--target ${targetKey(target)}）`
      : "<多维表格链接>";
    const queueCount = state.queue.entries.length;

    return h(
      "div",
      { className: "fs-stack fs-guide" },

      h("div", { className: "fs-h2" }, "准备（两种方式都需要，只做一次）"),
      h(
        Step,
        { n: 1, title: "安装 Claude Code 并登录", ok: found("claude") },
        h(Code, { text: "curl -fsSL https://claude.ai/install.sh | bash\nclaude    # 第一次运行会引导登录" }),
      ),
      h(
        Step,
        { n: 2, title: "安装飞书命令行 lark-cli", ok: found("lark-cli") },
        h(Code, { text: "npm i -g @larksuite/cli" }),
        h(
          "div",
          { className: "fs-dim" },
          "装完在终端里敲 lark-cli 提示「command not found」的话，把 npm 全局目录加进 PATH：",
        ),
        h(Code, { text: `echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc` }),
      ),
      h(
        Step,
        { n: 3, title: "安装飞书 Skill（让 Claude 会用飞书）" },
        h(Code, { text: "npx skills add larksuite/cli -g -y" }),
      ),
      h(
        Step,
        { n: 4, title: "配置飞书应用（第一次用 lark-cli 才需要）" },
        h(Code, { text: "lark-cli config init --new" }),
        h("div", { className: "fs-dim" }, "按提示在浏览器里创建 / 选择飞书应用。已经配过的跳过这一步。"),
      ),
      h(
        Step,
        { n: 5, title: "登录并授权", ok: auth ? auth.ok : undefined },
        h(Code, { text: 'lark-cli auth login --domain base,wiki,contact --scope "search:docs:read"' }),
        h(
          "div",
          { className: "fs-dim" },
          "会给出一个链接，用浏览器或飞书扫码打开、点授权。需要的权限：多维表格读写、知识库浏览、通讯录查人、文档搜索。",
          "如果提示某个 scope「未授予」，先到飞书开发者后台给应用开通它并发布版本，再执行一次上面的命令。",
        ),
        h(
          "div",
          { className: "fs-row" },
          auth &&
            h(
              "span",
              { className: auth.ok ? "fs-ok" : "fs-dim" },
              auth.ok ? `当前登录：${auth.name ?? "已登录"}` : auth.msg || "还没登录",
            ),
          h(Btn, { small: true, onClick: () => void recheck() }, "重新检测"),
        ),
      ),
      h(
        Step,
        { n: 6, title: "gantt 命令行", ok: found("gantt") },
        h(
          "div",
          { className: "fs-dim" },
          "Agent 通过它读同步队列、写飞书。终端里 gantt help 能运行就行。",
        ),
      ),

      h("div", { className: "fs-h2" }, "方式一：在这个页面里同步（后台调用 Claude）"),
      h(
        Step,
        { n: 1, title: "启用插件", ok: true },
        h("div", { className: "fs-dim" }, "设置 → 插件 → 飞书同步 →「启用」。启用时 gantt-feishu 技能会自动链接到 ~/.claude/skills。"),
      ),
      h(
        Step,
        { n: 2, title: "把事项加入同步队列", ok: queueCount > 0 || undefined },
        h(
          "div",
          { className: "fs-dim" },
          "到「事项」页，点一条已分拣事项右侧的类型按钮 → 菜单里选「加入飞书同步」。行上出现「飞书」小标就是加进来了。",
          queueCount > 0 ? `（队列里现在有 ${queueCount} 条）` : "",
        ),
      ),
      h(
        Step,
        { n: 3, title: "选目标多维表格", ok: target ? true : undefined },
        h("div", { className: "fs-dim" }, "页面顶部「浏览我的多维表格」→ 在目录树里点 ▦ 多维表格，或者在弹窗顶部搜索。"),
      ),
      h(
        Step,
        { n: 4, title: "（可选）填写规则、人员对照" },
        h(
          "div",
          { className: "fs-dim" },
          "「填写规则」里为这张表写你的要求，比如「status 只用 Open / Closed」；",
          "「人员对照」里把 gantt 负责人对应到飞书用户，表里的人员字段才能填上。",
        ),
      ),
      h(
        Step,
        { n: 5, title: "勾选并同步" },
        h(
          "div",
          { className: "fs-dim" },
          "「同步队列」里勾选（或点「选中待同步」）→「同步 N 条」。下方实时显示每一步；没同步过的新建，同步过的更新原来那条，不会删除任何记录。",
        ),
      ),

      h("div", { className: "fs-h2" }, "方式二：在 Claude Code 里自己操作"),
      h(
        "div",
        { className: "fs-dim" },
        "前提：完成上面的准备，并且插件启用过一次（gantt-feishu 技能已经链接好）、事项已加入同步队列。",
        "打开终端，进入任意目录运行 claude，然后直接说：",
      ),
      h("div", { className: "fs-label" }, "同步全部待同步的事项"),
      h(Code, { text: `用 gantt-feishu 把飞书同步队列里待同步的事项写到 ${t}` }),
      h("div", { className: "fs-label" }, "先看看队列，不写"),
      h(Code, { text: `用 gantt-feishu 列出飞书同步队列，告诉我哪些还没同步到 ${t}` }),
      h("div", { className: "fs-label" }, "只同步指定几条，先预演"),
      h(Code, {
        text: `用 gantt-feishu 只同步 note:12 和 risk:5 到 ${t}，先用 --dry-run 给我看每条要写哪些字段，我确认后再写`,
      }),
      h("div", { className: "fs-label" }, "临时加一条填写要求"),
      h(Code, {
        text: `用 gantt-feishu 把待同步的事项写到 ${t}，这次 description 控制在 50 字以内，Categorization 按关联任务判断`,
      }),
      h("div", { className: "fs-label" }, "重试失败的"),
      h(Code, { text: `用 gantt-feishu 重试飞书同步队列里同步失败的事项，目标 ${t}` }),
      h("div", { className: "fs-label" }, "不进交互界面，一条命令跑完"),
      h(Code, { text: `claude -p "用 gantt-feishu 把飞书同步队列里待同步的事项写到 ${t}"` }),
      h(
        "div",
        { className: "fs-dim" },
        "在 Claude Code 里同步，和在这个页面点「同步」用的是同一份队列和规则，结果会出现在「同步队列」的状态里。",
      ),

      h("details", { className: "fs-details" },
        h("summary", null, "Agent 用到的底层命令（也可以自己在终端里敲）"),
        h(Code, {
          text: [
            `gantt feishu queue${target ? ` --target ${targetKey(target)}` : " --target <base-token>:<table-id>"} --pending --json`,
            "gantt feishu write <key> --target <base>:<table> --fields '{\"字段\": \"值\"}' [--dry-run]   # 新建或更新，不删除",
            "gantt feishu mark-failed <key> --target <base>:<table> --error <原因>",
          ].join("\n"),
        }),
        h("div", { className: "fs-dim" }, `插件目录：${api.dir}`),
      ),
    );
  }

  function RunPanel({ run, onCancel, onClear }) {
    const box = useRef(null);
    useEffect(() => {
      if (box.current) box.current.scrollTop = box.current.scrollHeight;
    }, [run.log.length]);
    const secs = Math.round((Date.now() - run.startedAt) / 1000);
    return h(
      "div",
      { className: "fs-card" },
      h(
        "div",
        { className: "fs-row" },
        h(
          "span",
          { className: "fs-label" },
          run.done
            ? run.code === 0
              ? "同步结束"
              : `同步中断（退出码 ${run.code ?? "?"}）`
            : `后台同步 ${run.keys.length} 条 · ${secs}s`,
        ),
        h("span", { className: "fs-grow" }),
        run.done ? h(Btn, { small: true, onClick: onClear }, "收起") : h(Btn, { small: true, danger: true, onClick: onCancel }, "停止"),
      ),
      h(
        "div",
        { className: "fs-log", ref: box },
        run.log.length === 0 && h("div", { className: "fs-dim" }, "正在启动 Claude…"),
        run.log.map((l, i) =>
          h(
            "div",
            { key: i, className: `fs-log-${l.type}` },
            l.type === "tool" ? "› " : l.type === "result" ? "✓ " : l.type === "error" ? "✗ " : "",
            l.text,
            l.cost != null ? h("span", { className: "fs-dim" }, ` （$${Number(l.cost).toFixed(3)}）`) : null,
          ),
        ),
      ),
    );
  }

  function FeishuView() {
    useShared();
    const [tab, setTab] = useState("queue");
    const [picking, setPicking] = useState(false);
    const env = useEnv();
    const { run, start, cancel, clear } = useRun();
    const target = state.config.target;
    const running = !!run && !run.done;

    // 切回窗口时重读：期间可能有人在 Claude Code 里同步过
    useEffect(() => {
      void reloadFromDisk();
      const onFocus = () => !running && void reloadFromDisk();
      window.addEventListener("focus", onFocus);
      return () => window.removeEventListener("focus", onFocus);
    }, [running]);

    const missing = env ? Object.entries(env).filter(([, p]) => !p).map(([n]) => n) : [];

    return h(
      "div",
      { className: "fs-root" },
      h(
        "div",
        { className: "fs-row fs-head" },
        h("span", { className: "fs-h1" }, "飞书同步"),
        h("span", { className: "fs-dim" }, "目标表："),
        target
          ? h(
              "span",
              { className: "fs-target", title: targetKey(target) },
              [target.baseName, target.tableName].filter(Boolean).join(" / ") || targetKey(target),
            )
          : h("span", { className: "fs-dim" }, "未选择"),
        h(
          Btn,
          { small: true, primary: !target, disabled: running, onClick: () => setPicking(true) },
          "浏览我的多维表格",
        ),

      ),
      missing.length > 0 &&
        h(
          "div",
          { className: "fs-warnbar" },
          `找不到：${missing.join("、")}。`,
          missing.includes("claude") && " 后台同步需要 Claude Code（claude 命令）。",
          missing.includes("lark-cli") && " 搜表、查人需要 lark-cli（npm i -g @larksuite/cli，然后 lark-cli auth login）。",
          missing.includes("gantt") && " Agent 回写同步结果需要 gantt 命令行。",
        ),
      picking &&
        h(TreeModal, {
          title: "浏览我的多维表格",
          onClose: () => setPicking(false),
          onSelect: (target) => void mutateConfig((c) => ({ ...c, target })),
        }),
      run && h(RunPanel, { run, onCancel: cancel, onClear: clear }),
      h(
        "div",
        { className: "fs-tabs" },
        [
          ["queue", "同步队列"],
          ["rules", "填写规则"],
          ["people", "人员对照"],
          ["guide", "使用说明"],
        ].map(([k, label]) =>
          h("button", { key: k, className: `fs-tab${tab === k ? " fs-tab-on" : ""}`, onClick: () => setTab(k) }, label),
        ),
      ),
      tab === "queue" && h(QueueTab, { target, running, onSync: (keys) => void start(target, keys) }),
      tab === "rules" && h(RulesTab, { target }),
      tab === "people" && h(PeopleTab),
      tab === "guide" && h(GuideTab, { target, env }),
    );
  }

  api.views.register(
    { type: "feishu-sync.view", label: "飞书", hint: "哪些事项要同步到飞书多维表格、同步了没有" },
    FeishuView,
  );
}

export function onunload() {
  /* 宿主会回收注册项和子进程 */
}
