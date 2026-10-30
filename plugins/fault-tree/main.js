/**
 * 故障树分析插件：事项作顶事件，用或门/与门往下拆到基本事件，
 * 按门的逻辑推出因果链与最小割集。
 * 数据在 data/trees.json（按项目分开，卸载不删）；停用前未落盘的改动在 onunload 写入。
 * 树引用事项用 noteId，改分拣类型后仍认得。单文件无 import，React 用 api.react。
 */

/* ---------------- 数据 ---------------- */

export const STORE_FILE = "trees.json";

export const KIND_LABELS = {
  top: "顶事件",
  intermediate: "中间事件",
  basic: "基本事件",
  undeveloped: "未展开事件",
};
export const GATE_LABELS = { or: "或门", and: "与门" };
export const STATUS_LABELS = { open: "待验证", confirmed: "已确认", ruled: "已排除" };
export const ROLE_LABELS = { phenomenon: "现象", cause: "原因", action: "对策" };
export const ACTION_LABELS = { todo: "待做", doing: "进行中", done: "已完成", ineffective: "无效" };

/** 角色。老数据没有 role：顶事件当现象，其余当原因 */
export const roleOf = (n) => n.role ?? (n.kind === "top" ? "phenomenon" : "cause");
export const isAction = (n) => roleOf(n) === "action";
/** 结构上的叶子（基本 / 未展开）。对策不算 */
export const isLeaf = (n) => !isAction(n) && (n.kind === "basic" || n.kind === "undeveloped");
/** 参与推导的子事件 —— 去掉对策 */
export const causeKids = (tree, n) => n.children.filter((c) => tree.nodes[c] && !isAction(tree.nodes[c]));

export function emptyStore() {
  return { version: 1, trees: [] };
}

export function parseStore(text) {
  if (!text) return emptyStore();
  try {
    const s = JSON.parse(text);
    if (s && Array.isArray(s.trees)) return s;
  } catch {
    /* 坏文件当空的，别让页面打不开 */
  }
  return emptyStore();
}

/** 认一条事项：有 noteId 用 note:<id>，分拣改类型也认得出来 */
export const itemRef = (item) => (item.noteId != null ? `note:${item.noteId}` : item.key);

const node = (id, over = {}) => ({
  id,
  label: "",
  kind: "basic",
  gate: "or",
  status: "open",
  note: "",
  children: [],
  itemRef: null,
  /** 事件日期 YYYY-MM-DD：从事项来的取记录日，手写的取加入那天 */
  at: null,
  ...over,
});

/** 本地时区的 YYYY-MM-DD（日期框、筛选都按它） */
export function localDay(d = new Date()) {
  if (Number.isNaN(d.getTime())) return "";
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 老数据没有 at，退回到建树那天 */
export const nodeDay = (tree, n) => n.at || localDay(new Date(tree.createdAt));

export function newTree({ id, projectId, label = "", ref = null, at = null, now }) {
  return {
    id,
    projectId,
    createdAt: now,
    updatedAt: now,
    seq: 1,
    root: "n1",
    nodes: { n1: node("n1", { label, kind: "top", itemRef: ref, at }) },
  };
}

export const treeTitle = (tree) => tree.nodes[tree.root]?.label || "未命名的顶事件";

export function parentOf(tree, id) {
  for (const n of Object.values(tree.nodes)) if (n.children.includes(id)) return n;
  return null;
}

const withNodes = (tree, nodes, extra = {}) => ({ ...tree, ...extra, nodes });

/** 加子事件，返回 { tree, id }。叶子被加子事件后变中间事件 */
export function addChild(tree, parentId, init = {}, index = null) {
  const parent = tree.nodes[parentId];
  // 对策下面不再挂东西
  if (!parent || isAction(parent)) return { tree, id: null };
  const action = init.role === "action";
  const seq = tree.seq + 1;
  const id = `n${seq}`;
  const children = [...parent.children];
  children.splice(index ?? children.length, 0, id);
  const nextParent = {
    ...parent,
    children,
    // 挂对策不改变结构：一个基本事件有了对策，仍然是拆到底的那个基本事件
    ...(isLeaf(parent) && !action ? { kind: "intermediate", status: "open" } : {}),
  };
  return {
    tree: withNodes(
      tree,
      {
        ...tree.nodes,
        [parentId]: nextParent,
        [id]: node(id, action ? { actionStatus: "todo", due: null, ...init } : init),
      },
      { seq },
    ),
    id,
  };
}

/** 在 id 后面加一个同级事件。顶事件没有同级，退化成加子事件 */
export function addSibling(tree, id, init = {}) {
  const parent = parentOf(tree, id);
  if (!parent) return addChild(tree, id, init);
  const like = isAction(tree.nodes[id]) ? { role: "action", ...init } : init;
  return addChild(tree, parent.id, like, parent.children.indexOf(id) + 1);
}

export function updateNode(tree, id, patch) {
  const n = tree.nodes[id];
  if (!n) return tree;
  const next = { ...n, ...patch };
  const causes = causeKids(tree, n).length;
  // 有子事件的不能改成叶子；顶事件永远是顶事件
  if (n.kind === "top") next.kind = "top";
  else if (causes > 0) next.kind = "intermediate";
  else if (next.kind === "intermediate" || next.kind === "top") next.kind = "basic";

  // 角色：顶事件、下面有原因的、下面挂着对策的都不能变成对策
  if (patch.role === "action" && !isAction(n)) {
    if (id === tree.root || n.children.length > 0) return tree;
    next.actionStatus = n.actionStatus ?? "todo";
    next.due = n.due ?? null;
    next.kind = "basic";
  }
  if (patch.role && patch.role !== "action" && isAction(n)) {
    delete next.actionStatus;
    delete next.due;
  }
  return withNodes(tree, { ...tree.nodes, [id]: next });
}

/** 这个事件和它下面的全部 id */
export function subtreeIds(tree, id) {
  const out = [];
  const walk = (x) => {
    const n = tree.nodes[x];
    if (!n) return;
    out.push(x);
    n.children.forEach(walk);
  };
  walk(id);
  return out;
}

/** 删掉整枝；删空的中间事件变回基本事件 */
export function removeNode(tree, id) {
  if (id === tree.root || !tree.nodes[id]) return tree;
  const parent = parentOf(tree, id);
  const nodes = { ...tree.nodes };
  for (const x of subtreeIds(tree, id)) delete nodes[x];
  if (parent) {
    const children = parent.children.filter((c) => c !== id);
    const causes = children.filter((c) => !isAction(nodes[c]));
    nodes[parent.id] = {
      ...parent,
      children,
      ...(causes.length === 0 && parent.kind === "intermediate" ? { kind: "basic" } : {}),
    };
  }
  return withNodes(tree, nodes);
}

/** 同级之间挪一位。delta = -1 往左，+1 往右 */
export function moveNode(tree, id, delta) {
  const parent = parentOf(tree, id);
  if (!parent) return tree;
  const i = parent.children.indexOf(id);
  const j = i + delta;
  if (j < 0 || j >= parent.children.length) return tree;
  const children = [...parent.children];
  [children[i], children[j]] = [children[j], children[i]];
  return withNodes(tree, { ...tree.nodes, [parent.id]: { ...parent, children } });
}

/**
 * 按门的逻辑把叶子状态往上推，返回 { [id]: "confirmed" | "ruled" | "open" }。
 * 或门：任一成立即成立，全部排除才排除；与门：全部成立才成立，任一排除即排除。
 * 没拆的门（无子事件）算待验证 —— 没拆不等于没问题。
 */
export function evaluate(tree) {
  const out = {};
  const walk = (id) => {
    const n = tree.nodes[id];
    if (!n) return "open";
    let s;
    const causes = causeKids(tree, n);
    if (isLeaf(n) || causes.length === 0) {
      s = isLeaf(n) ? n.status : "open";
    } else {
      const kids = causes.map(walk);
      const all = (v) => kids.every((k) => k === v);
      const any = (v) => kids.some((k) => k === v);
      s =
        n.gate === "and"
          ? all("confirmed") ? "confirmed" : any("ruled") ? "ruled" : "open"
          : any("confirmed") ? "confirmed" : all("ruled") ? "ruled" : "open";
    }
    out[id] = s;
    return s;
  };
  walk(tree.root);
  return out;
}

/**
 * 最小割集：能单独导致顶事件、不可再少的叶子组合（MOCUS：或门并、与门两两拼）。
 * 树里每个事件只出现一次，互不包含；末尾去包含是防御（以后允许同一事件挂多处）。
 * 与门多会组合爆炸，超 limit 截断并置 truncated。按阶数升序，返回 { sets, truncated }。
 */
export function minimalCutSets(tree, limit = 200) {
  let truncated = false;
  const cap = (sets) => {
    if (sets.length > limit * 4) {
      truncated = true;
      return sets.slice(0, limit * 4);
    }
    return sets;
  };
  const walk = (id) => {
    const n = tree.nodes[id];
    if (!n) return [];
    const causes = causeKids(tree, n);
    if (isLeaf(n) || causes.length === 0) return [[id]];
    const kids = causes.map(walk);
    if (n.gate === "and") {
      return kids.reduce(
        (acc, sets) => cap(acc.flatMap((a) => sets.map((b) => [...new Set([...a, ...b])]))),
        [[]],
      );
    }
    return cap(kids.flat());
  };

  // 顶事件自己还没拆，就没有割集可言
  const root = tree.nodes[tree.root];
  if (!root || causeKids(tree, root).length === 0) return { sets: [], truncated: false };

  const order = Object.fromEntries(Object.keys(tree.nodes).map((id, i) => [id, i]));
  const raw = walk(tree.root).map((s) => [...s].sort((a, b) => order[a] - order[b]));
  const uniq = [...new Map(raw.map((s) => [s.join(","), s])).values()].sort(
    (a, b) => a.length - b.length || order[a[0]] - order[b[0]],
  );
  const minimal = uniq.filter(
    (s, i) => !uniq.some((o, j) => j !== i && o.length < s.length && o.every((x) => s.includes(x))),
  );
  if (minimal.length > limit) truncated = true;
  return { sets: minimal.slice(0, limit), truncated };
}

/** 含已排除的叶子即排除；全部已确认即成立 */
export function cutSetStatus(tree, set) {
  const st = set.map((id) => tree.nodes[id]?.status ?? "open");
  if (st.includes("ruled")) return "ruled";
  if (st.every((s) => s === "confirmed")) return "confirmed";
  return "open";
}

/**
 * 根因：已确认、拆到底（叶子），而且从它到顶事件一路都成立 ——
 * 也就是红色那条因果链最底下的那几个。排除掉了角标自然消失。
 */
export function rootCauses(tree, ev = evaluate(tree)) {
  const out = new Set();
  const walk = (id) => {
    const n = tree.nodes[id];
    if (!n || ev[id] !== "confirmed") return;
    if (isLeaf(n)) out.add(id);
    else causeKids(tree, n).forEach(walk);
  };
  walk(tree.root);
  return out;
}

/** 对策统计：共几条、完成几条、过了截止日还没做完的几条。today 是 YYYY-MM-DD */
export function actionStats(tree, today) {
  const acts = Object.values(tree.nodes).filter(isAction);
  const finished = (a) => a.actionStatus === "done" || a.actionStatus === "ineffective";
  return {
    total: acts.length,
    done: acts.filter((a) => a.actionStatus === "done").length,
    overdue: acts.filter((a) => !finished(a) && a.due && a.due < today).length,
  };
}

/** 顺着各事件挂的事项找任务；byRef 是 itemRef → 事项 */
export function treeTasks(tree, byRef) {
  const out = new Set();
  for (const n of Object.values(tree.nodes)) {
    const it = n.itemRef && byRef.get(n.itemRef);
    if (it && it.taskId != null) out.add(it.taskId);
  }
  return out;
}

/** from/to 按建树日期（含两端）；task 为 "" 全部、"none" 没挂任务、或 taskId。新建在前 */
export function filterTrees(trees, { from = "", to = "", task = "" }, byRef) {
  return trees
    .filter((t) => {
      const day = localDay(new Date(t.createdAt));
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (task === "") return true;
      const tasks = treeTasks(t, byRef);
      return task === "none" ? tasks.size === 0 : tasks.has(Number(task));
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** 树 → 缩进大纲，复制出去贴进周报、邮件 */
export function outline(tree) {
  const lines = [];
  const walk = (id, prefix, last, depth) => {
    const n = tree.nodes[id];
    if (!n) return;
    const head = depth === 0 ? "" : `${prefix}${last ? "└─ " : "├─ "}`;
    if (isAction(n)) {
      const due = n.due ? `，截止 ${n.due}` : "";
      lines.push(`${head}→ 对策：${n.label || "（未填写）"}（${ACTION_LABELS[n.actionStatus ?? "todo"]}${due}）`);
      return;
    }
    const kind = isLeaf(n) ? (n.kind === "basic" ? "○" : "◇") : `[${GATE_LABELS[n.gate]}]`;
    const status = isLeaf(n) && n.status !== "open" ? `（${STATUS_LABELS[n.status]}）` : "";
    const label = n.label || "（未填写）";
    lines.push(
      depth === 0
        ? `${KIND_LABELS.top}：${label}  ${kind}`
        : `${head}${isLeaf(n) ? `${kind} ${label}` : `${label}  ${kind}`}${status}`,
    );
    if (n.note) lines.push(`${prefix}${depth === 0 ? "" : last ? "   " : "│  "}  备注：${n.note}`);
    const next = depth === 0 ? "" : prefix + (last ? "   " : "│  ");
    n.children.forEach((c, i) => walk(c, next, i === n.children.length - 1, depth + 1));
  };
  walk(tree.root, "", true, 0);
  return lines.join("\n");
}

/* ---------------- 布局 ---------------- */

export const NODE_W = 176;
export const BOX_H = 66;
/** 事件框底到符号顶的短竖线 */
const STEM = 8;
const SYMBOL_H = 22;
export const LEVEL_H = 140;
const H_GAP = 28;
const PAD = 48;

/** 叶子自左排开，父节点居中于首尾子节点上方。返回各框顶边中点 */
export function layoutTree(tree) {
  const pos = {};
  let cursor = 0;
  let maxDepth = 0;
  const place = (id, depth) => {
    const n = tree.nodes[id];
    maxDepth = Math.max(maxDepth, depth);
    const y = PAD + depth * LEVEL_H;
    const kids = n.children.filter((c) => tree.nodes[c]);
    if (kids.length === 0) {
      const x = PAD + cursor + NODE_W / 2;
      cursor += NODE_W + H_GAP;
      pos[id] = { x, y };
      return x;
    }
    const xs = kids.map((c) => place(c, depth + 1));
    const x = (xs[0] + xs[xs.length - 1]) / 2;
    pos[id] = { x, y };
    return x;
  };
  if (tree.nodes[tree.root]) place(tree.root, 0);
  return {
    pos,
    width: Math.max(cursor - H_GAP, NODE_W) + PAD * 2,
    height: PAD * 2 + maxDepth * LEVEL_H + BOX_H + STEM + SYMBOL_H,
  };
}

/* ---------------- 视图 ---------------- */

/** 今年的省掉年份 —— 事件框很窄 */
const shortDay = (iso) => (iso && iso.slice(0, 4) === String(new Date().getFullYear()) ? iso.slice(5) : iso);

const uid = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 门 / 事件符号的 SVG 路径。(cx, t) 是符号顶边中点 */
function symbolPath(kind, gate, cx, t) {
  if (kind === "basic") return null; // 圆，单独画
  if (kind === "undeveloped") {
    return `M${cx},${t} L${cx + 12},${t + 11} L${cx},${t + 22} L${cx - 12},${t + 11} Z`;
  }
  return gate === "and"
    ? `M${cx - 12},${t + 22} L${cx - 12},${t + 11} A12,11 0 0 1 ${cx + 12},${t + 11} L${cx + 12},${t + 22} Z`
    : `M${cx - 13},${t + 22} Q${cx - 12},${t + 8} ${cx},${t} Q${cx + 12},${t + 8} ${cx + 13},${t + 22} Q${cx},${t + 15} ${cx - 13},${t + 22} Z`;
}

/** 门的输入从哪里伸出去：或门是凹进去的底，与门是平底 */
const gateBottom = (gate, t) => t + (gate === "and" ? 22 : 18);

export function onload(api) {
  const React = api.react;
  const h = React.createElement;
  const { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

  /* ---------------- 共享状态 ---------------- */

  const state = { store: emptyStore(), activeTree: null, loaded: false, version: 0 };
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

  /** 内存为准，落盘防抖：每字都写没必要，等写完再刷新又会让输入发涩 */
  let saveTimer = null;
  let saving = Promise.resolve();
  const writeNow = () => {
    clearTimeout(saveTimer);
    saveTimer = null;
    const text = JSON.stringify(state.store, null, 2);
    saving = saving
      .then(() => api.storage.write(STORE_FILE, text))
      .catch((e) => api.log("写入故障树失败", e));
    return saving;
  };
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeNow, 300);
  };
  // 停用、卸载、热重载都会先调 onunload：防抖中的改动不能丢
  flushPending = () => (saveTimer != null ? writeNow() : saving);

  /** 撤销 / 重做只管本次会话（最多 100 步） */
  const undo = [];
  const redo = [];
  const setStore = (next, { record = true } = {}) => {
    if (next === state.store) return;
    if (record) {
      undo.push(state.store);
      if (undo.length > 100) undo.shift();
      redo.length = 0;
    }
    state.store = next;
    notify();
    save();
  };
  const step = (from, to) => {
    const prev = from.pop();
    if (!prev) return false;
    to.push(state.store);
    state.store = prev;
    if (state.activeTree && !prev.trees.some((t) => t.id === state.activeTree)) {
      state.activeTree = prev.trees[0]?.id ?? null;
    }
    notify();
    save();
    return true;
  };

  const mutateTree = (treeId, fn) => {
    const now = new Date().toISOString();
    let changed = false;
    const trees = state.store.trees.map((t) => {
      if (t.id !== treeId) return t;
      const next = fn(t);
      if (next === t) return t;
      changed = true;
      return { ...next, updatedAt: now };
    });
    if (changed) setStore({ ...state.store, trees });
  };

  const treesOf = (projectId) => state.store.trees.filter((t) => t.projectId === projectId);
  const treeWithTop = (ref, projectId) =>
    treesOf(projectId).find((t) => t.nodes[t.root]?.itemRef === ref) ?? null;

  const createTree = (label, ref, at = localDay()) => {
    const project = api.data.project();
    if (!project) return null;
    const tree = newTree({ id: uid(), projectId: project.id, label, ref, at, now: new Date().toISOString() });
    state.activeTree = tree.id;
    setStore({ ...state.store, trees: [...state.store.trees, tree] });
    return tree;
  };

  const deleteTree = (tree) => {
    if (!window.confirm(`删除故障树「${treeTitle(tree)}」？关联的事项不受影响。`)) return;
    setStore({ ...state.store, trees: state.store.trees.filter((t) => t.id !== tree.id) });
    if (state.activeTree === tree.id) state.activeTree = null;
    notify();
  };

  void api.storage
    .read(STORE_FILE)
    .then((text) => {
      state.store = parseStore(text);
      state.loaded = true;
      notify();
    })
    .catch((e) => {
      api.log("读取故障树失败", e);
      state.loaded = true;
      notify();
    });

  /* ---------------- 事项页：分拣菜单 + 徽标 ---------------- */

  api.itemActions.register({
    id: "fault-tree.open",
    hint: "以这条事项为顶事件，在「故障树」页一层层拆到基本原因",
    label: (item) => {
      const project = api.data.project();
      return treeWithTop(itemRef(item), project?.id) ? "打开故障树分析" : "建故障树分析";
    },
    run: (item) => {
      const project = api.data.project();
      const existing = treeWithTop(itemRef(item), project?.id);
      if (existing) {
        state.activeTree = existing.id;
        notify();
      } else {
        createTree(item.title, itemRef(item), item.day);
      }
      api.act.setActiveView("fault-tree.view");
    },
  });

  api.itemBadges.register({
    id: "fault-tree.badge",
    render: (item) => {
      const project = api.data.project();
      if (!project) return null;
      const ref = itemRef(item);
      for (const t of treesOf(project.id)) {
        const hit = Object.values(t.nodes).find((n) => n.itemRef === ref);
        if (!hit) continue;
        const top = hit.id === t.root;
        return {
          text: top ? "故障树" : "故障树·原因",
          title: top
            ? `「${treeTitle(t)}」的顶事件`
            : `是「${treeTitle(t)}」里的一个${KIND_LABELS[hit.kind]}`,
          color: "#d97706",
        };
      }
      return null;
    },
  });

  /* ---------------- 小部件 ---------------- */

  function Seg({ options, value, onChange, disabled }) {
    return h(
      "div",
      { className: "ft-seg", role: "radiogroup" },
      options.map((o) =>
        h(
          "button",
          {
            key: o.value,
            role: "radio",
            "aria-checked": value === o.value,
            disabled: disabled || o.disabled,
            title: o.title,
            className: `ft-seg-btn${value === o.value ? " ft-on" : ""}`,
            style: value === o.value && o.color ? { color: o.color } : undefined,
            onClick: () => onChange(o.value),
          },
          o.label,
        ),
      ),
    );
  }

  /** 失焦才提交：打字过程中不写盘、不进撤销栈 */
  function DraftText({ value, onCommit, placeholder, rows = 2, className = "ft-input", autoFocus, grow }) {
    const [draft, setDraft] = useState(value);
    const ref = useRef(null);
    useEffect(() => setDraft(value), [value]);
    // grow：高度跟着字走
    useLayoutEffect(() => {
      const el = ref.current;
      if (!grow || !el) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + 2}px`;
    }, [grow, draft]);
    return h("textarea", {
      ref,
      className,
      rows,
      value: draft,
      placeholder,
      autoFocus,
      spellCheck: false,
      onChange: (e) => setDraft(e.target.value),
      onBlur: () => draft !== value && onCommit(draft),
      onKeyDown: (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          setDraft(value);
          e.currentTarget.blur();
        }
      },
    });
  }

  /* ---------------- 画布 ---------------- */

  function Canvas({ tree, selected, onSelect, editing, setEditing, highlight, ops, candidates }) {
    const box = useRef(null);
    const [view, setView] = useState({ x: 0, y: 0, k: 1 });
    const drag = useRef(null);
    const layout = useMemo(() => layoutTree(tree), [tree]);
    const ev = useMemo(() => evaluate(tree), [tree]);

    const fit = () => {
      const el = box.current;
      if (!el) return;
      const w = el.clientWidth || 800;
      const hgt = el.clientHeight || 600;
      const k = Math.min(1, Math.max(0.3, Math.min(w / layout.width, hgt / layout.height)));
      setView({ k, x: (w - layout.width * k) / 2, y: Math.max(0, (hgt - layout.height * k) / 2) * 0.4 });
    };
    // 换树才重新摆到中间；同树内加减节点不动视角，免得编辑就跳
    useLayoutEffect(fit, [tree.id]);

    // 选中节点跑出可视区就拉回来（键盘导航、新建子事件时）
    useEffect(() => {
      const el = box.current;
      const p = selected && layout.pos[selected];
      if (!el || !p) return;
      setView((v) => {
        const sx = v.x + p.x * v.k;
        const sy = v.y + p.y * v.k;
        const half = (NODE_W / 2) * v.k;
        const m = 24;
        let { x, y } = v;
        if (sx - half < m) x += m - (sx - half);
        if (sx + half > el.clientWidth - m) x -= sx + half - (el.clientWidth - m);
        if (sy < m) y += m - sy;
        if (sy + (BOX_H + 40) * v.k > el.clientHeight - m) y -= sy + (BOX_H + 40) * v.k - (el.clientHeight - m);
        return x === v.x && y === v.y ? v : { ...v, x, y };
      });
    }, [selected, layout]);

    const zoomAt = (factor, cx, cy) =>
      setView((v) => {
        const k = Math.min(2, Math.max(0.25, v.k * factor));
        const f = k / v.k;
        return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
      });

    useEffect(() => {
      const el = box.current;
      if (!el) return;
      // React 的 onWheel 是 passive 的，要 preventDefault 只能自己挂
      const onWheel = (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          const r = el.getBoundingClientRect();
          zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
        } else {
          setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
        }
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      return () => el.removeEventListener("wheel", onWheel);
    }, []);

    const onPointerDown = (e) => {
      if (e.button !== 0 || e.target.closest?.(".ft-node, .ft-tools, .ft-zoom")) return;
      drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e) => {
      const d = drag.current;
      if (!d) return;
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
      setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
    };
    const onPointerUp = () => {
      const d = drag.current;
      drag.current = null;
      // 点空白处（没拖动）= 取消选中
      if (d && !d.moved) onSelect(null);
    };

    const onKeyDown = (e) => {
      if (editing || e.target.closest?.("textarea, input, select")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? ops.redo() : ops.undo();
        return;
      }
      if (!selected) {
        if (e.key === "Enter" || e.key === "ArrowDown") {
          e.preventDefault();
          onSelect(tree.root);
        }
        return;
      }
      const n = tree.nodes[selected];
      const parent = parentOf(tree, selected);
      const sib = (d) => {
        if (!parent) return;
        const i = parent.children.indexOf(selected) + d;
        if (parent.children[i]) onSelect(parent.children[i]);
      };
      const keys = {
        Tab: () => ops.addChild(selected),
        Enter: () => ops.addSibling(selected),
        Backspace: () => ops.remove(selected),
        Delete: () => ops.remove(selected),
        F2: () => setEditing(selected),
        " ": () => setEditing(selected),
        Escape: () => onSelect(null),
        ArrowUp: () => parent && onSelect(parent.id),
        ArrowDown: () => n.children[0] && onSelect(n.children[0]),
        ArrowLeft: () => (e.altKey ? ops.move(selected, -1) : sib(-1)),
        ArrowRight: () => (e.altKey ? ops.move(selected, 1) : sib(1)),
      };
      if (keys[e.key]) {
        e.preventDefault();
        keys[e.key]();
      }
    };

    const color = (s) => (s === "confirmed" ? "var(--ft-hot)" : s === "ruled" ? "var(--ft-dim)" : "var(--ft-line)");
    const hl = highlight ? new Set(highlight) : null;

    // 连线：父门底 → 汇流横线 → 子框顶。成立的几条后画，压在别的上面
    const edges = [];
    for (const n of Object.values(tree.nodes)) {
      const p = layout.pos[n.id];
      if (!p) continue;
      const from = gateBottom(n.gate, p.y + BOX_H + STEM);
      const bus = p.y + LEVEL_H - 20;
      for (const c of n.children) {
        const q = layout.pos[c];
        if (!q) continue;
        if (isAction(tree.nodes[c])) {
          // 对策：从框底偏右单独拉一根绿色虚线下来，不经过门，也不接原因那条汇流线
          const ax = p.x + NODE_W / 2 - 18;
          const abus = p.y + LEVEL_H - 30;
          edges.push({
            key: `${n.id}-${c}`,
            d: `M${ax},${p.y + BOX_H} V${abus} H${q.x} V${q.y}`,
            s: "action",
            dim: hl && !hl.has(c),
          });
          continue;
        }
        edges.push({
          key: `${n.id}-${c}`,
          d: `M${p.x},${from} V${bus} H${q.x} V${q.y}`,
          s: ev[c],
          dim: hl && !(hl.has(c) || subtreeIds(tree, c).some((x) => hl.has(x))),
        });
      }
    }
    const rank = { action: -1, ruled: 0, open: 1, confirmed: 2 };
    edges.sort((a, b) => rank[a.s] - rank[b.s]);

    const nodes = Object.values(tree.nodes).filter((n) => layout.pos[n.id]);
    const r = box.current?.getBoundingClientRect();
    const roots = rootCauses(tree, ev);
    const today = localDay();

    return h(
      "div",
      {
        ref: box,
        className: "ft-canvas",
        tabIndex: 0,
        "aria-label": "故障树画布",
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onKeyDown,
      },
      h(
        "div",
        {
          className: "ft-stage",
          style: {
            width: layout.width,
            height: layout.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          },
        },
        h(
          "svg",
          { className: "ft-svg", width: layout.width, height: layout.height, "aria-hidden": true },
          edges.map((e) =>
            h("path", {
              key: e.key,
              d: e.d,
              fill: "none",
              stroke: e.s === "action" ? "var(--ft-act)" : color(e.s),
              strokeWidth: e.s === "confirmed" ? 2 : 1.25,
              strokeDasharray: e.s === "ruled" ? "4 3" : e.s === "action" ? "5 3" : undefined,
              opacity: e.dim ? 0.25 : 1,
            }),
          ),
          nodes.map((n) => {
            if (isAction(n)) return null;
            const p = layout.pos[n.id];
            const t = p.y + BOX_H + STEM;
            const s = ev[n.id];
            const c = color(s);
            const dim = hl && !hl.has(n.id);
            const path = symbolPath(n.kind, n.gate, p.x, t);
            const fill = s === "confirmed" ? "var(--ft-hot-soft)" : "var(--surface)";
            return h(
              "g",
              { key: n.id, opacity: dim ? 0.3 : 1 },
              h("line", { x1: p.x, y1: p.y + BOX_H, x2: p.x, y2: t, stroke: c, strokeWidth: 1.25 }),
              path
                ? h("path", { d: path, fill, stroke: c, strokeWidth: 1.5, strokeLinejoin: "round" })
                : h("circle", { cx: p.x, cy: t + 11, r: 10, fill, stroke: c, strokeWidth: 1.5 }),
              !isLeaf(n) &&
                h(
                  "text",
                  {
                    x: p.x,
                    y: t + (n.gate === "and" ? 17 : 15),
                    textAnchor: "middle",
                    className: "ft-gate-text",
                    fill: c,
                  },
                  n.gate === "and" ? "与" : "或",
                ),
              n.kind === "basic" &&
                s !== "open" &&
                h(
                  "text",
                  { x: p.x, y: t + 15, textAnchor: "middle", className: "ft-gate-text", fill: c },
                  s === "confirmed" ? "✓" : "✕",
                ),
            );
          }),
        ),
        nodes.map((n) =>
          h(NodeCard, {
            key: n.id,
            tree,
            n,
            pos: layout.pos[n.id],
            status: ev[n.id],
            rootCause: roots.has(n.id),
            temporary: isAction(n) && parentOf(tree, n.id)?.id === tree.root,
            today,
            selected: selected === n.id,
            editing: editing === n.id,
            dim: hl && !hl.has(n.id),
            onSelect,
            setEditing,
            ops,
            candidates,
          }),
        ),
      ),
      h(
        "div",
        { className: "ft-zoom" },
        h("button", { title: "缩小", onClick: () => zoomAt(1 / 1.2, (r?.width ?? 800) / 2, (r?.height ?? 600) / 2) }, "−"),
        h("span", { className: "ft-zoom-k" }, `${Math.round(view.k * 100)}%`),
        h("button", { title: "放大", onClick: () => zoomAt(1.2, (r?.width ?? 800) / 2, (r?.height ?? 600) / 2) }, "+"),
        h("button", { title: "整棵树放进视野", onClick: fit }, "适应"),
      ),
      h(
        "div",
        { className: "ft-keys" },
        "Tab 子原因 · ↵ 同级 · 空格 改名 · ⌫ 删除 · ⌥←→ 调顺序 · ⌘Z 撤销 · 拖空白处平移 · ⌘ + 滚轮缩放",
      ),
    );
  }

  function NodeCard({
    tree,
    n,
    pos,
    status,
    rootCause,
    temporary,
    today,
    selected,
    editing,
    dim,
    onSelect,
    setEditing,
    ops,
    candidates,
  }) {
    const top = n.kind === "top";
    const action = isAction(n);
    const role = roleOf(n);
    const act = n.actionStatus ?? "todo";
    const late = action && n.due && n.due < today && act !== "done" && act !== "ineffective";
    const cls = [
      "ft-node",
      top && "ft-node-top",
      action && `ft-node-action ft-act-${act}`,
      role === "phenomenon" && !top && "ft-node-phen",
      selected && "ft-sel",
      !action && status === "confirmed" && "ft-hot",
      !action && status === "ruled" && "ft-ruled",
      dim && "ft-faded",
    ]
      .filter(Boolean)
      .join(" ");
    const tag = action ? (temporary ? "临时措施" : "根本对策") : ROLE_LABELS[role];
    return h(
      "div",
      {
        className: cls,
        style: { left: pos.x - NODE_W / 2, top: pos.y, width: NODE_W, height: BOX_H },
        onPointerDown: (e) => e.stopPropagation(),
        onClick: (e) => {
          e.stopPropagation();
          onSelect(n.id);
        },
        onDoubleClick: (e) => {
          e.stopPropagation();
          onSelect(n.id);
          setEditing(n.id);
        },
        "data-node": n.id,
      },
      h(
        "div",
        { className: "ft-node-head" },
        h("span", { className: "ft-node-kind" }, tag),
        rootCause && h("span", { className: "ft-node-root", title: "已确认、拆到底，并且在成立的因果链上" }, "根因"),
        n.itemRef && h("span", { className: "ft-node-link", title: "关联了一条事项" }, "事项"),
        h("span", { className: "ft-grow" }),
        action
          ? h("span", { className: `ft-node-st ft-act-st-${act}` }, ACTION_LABELS[act])
          : status !== "open" &&
              !rootCause &&
              h("span", { className: `ft-node-st ft-st-${status}` }, STATUS_LABELS[status]),
        action
          ? n.due &&
              h(
                "span",
                { className: `ft-node-at${late ? " ft-late" : ""}`, title: late ? "过了截止日还没做完" : "截止日期" },
                `截止 ${shortDay(n.due)}`,
              )
          : h("span", { className: "ft-node-at" }, shortDay(nodeDay(tree, n))),
      ),
      editing
        ? h(DraftText, {
            value: n.label,
            className: "ft-node-edit",
            autoFocus: true,
            placeholder: action ? "要做什么？" : top ? "不希望发生的那件事" : "这个原因是什么？",
            onCommit: (label) => ops.update(n.id, { label }),
            rows: 2,
          })
        : h(
            "div",
            { className: `ft-node-label${n.label ? "" : " ft-empty"}` },
            n.label || (action ? "双击写下要做什么…" : top ? "写下顶事件…" : "双击写下这个原因…"),
          ),
      editing && h(EditCloser, { onDone: () => setEditing(null) }),
      selected &&
        !editing &&
        h(
          "div",
          { className: "ft-tools", onClick: (e) => e.stopPropagation() },
          !action && h("button", { title: "往下拆一层（Tab）", onClick: () => ops.addChild(n.id) }, "＋ 子原因"),
          !top && h("button", { title: action ? "再加一条对策（↵）" : "加一个并列的原因（↵）", onClick: () => ops.addSibling(n.id) }, "＋ 同级"),
          !action &&
            h(
              "button",
              { className: "ft-tool-act", title: top ? "先止血的临时措施" : "针对这个原因的对策", onClick: () => ops.addAction(n.id) },
              "＋ 对策",
            ),
          !action &&
            h(ItemPicker, {
              items: candidates,
              className: "ft-tool-pick",
              placeholder: "＋ 从事项",
              title: "挑一条事项，作为这个事件的子原因",
              onPick: (it) => ops.addChild(n.id, { label: it.title, itemRef: itemRef(it), at: it.day }),
            }),
          !top && h("button", { className: "ft-danger", title: "删掉这个事件和它下面的整枝（⌫）", onClick: () => ops.remove(n.id) }, "删除"),
        ),
    );
  }

  /** 编辑框失焦（提交或取消）后退出编辑态 */
  function EditCloser({ onDone }) {
    useEffect(() => {
      const onFocusOut = (e) => {
        if (e.target?.classList?.contains("ft-node-edit")) setTimeout(onDone, 0);
      };
      document.addEventListener("focusout", onFocusOut);
      return () => document.removeEventListener("focusout", onFocusOut);
    }, [onDone]);
    return null;
  }

  /* ---------------- 右栏 ---------------- */

  const kindOf = (n) => (n.kind === "top" ? "top" : isLeaf(n) ? n.kind : "intermediate");

  function Inspector({ tree, selected, items, candidates, onSelect, setHighlight, ops }) {
    const n = selected ? tree.nodes[selected] : null;
    const ev = useMemo(() => evaluate(tree), [tree]);
    const cuts = useMemo(() => minimalCutSets(tree), [tree]);
    const byRef = useMemo(() => new Map(items.map((it) => [itemRef(it), it])), [items]);

    const leaves = Object.values(tree.nodes).filter(isLeaf);
    const acts = actionStats(tree, localDay());
    const counts = { open: 0, confirmed: 0, ruled: 0 };
    for (const l of leaves) counts[l.status] += 1;
    const topState = ev[tree.root];
    const verdict =
      causeKids(tree, tree.nodes[tree.root]).length === 0
        ? { text: "还没开始拆", tone: "open" }
        : topState === "confirmed"
          ? { text: "因果链成立", tone: "confirmed" }
          : topState === "ruled"
            ? { text: "全部排除 · 原因不在树上", tone: "ruled" }
            : { text: `还有 ${counts.open} 个待验证`, tone: "open" };

    const linked = n?.itemRef ? byRef.get(n.itemRef) : null;

    return h(
      "aside",
      { className: "ft-side" },
      n &&
        h(
          "section",
          { className: "ft-sec", key: n.id },
          h(
            "div",
            { className: "ft-sec-head" },
            h(KindChip, { n }),
            isAction(n)
              ? h("span", { className: `ft-pill ft-act-st-${n.actionStatus ?? "todo"}` }, ACTION_LABELS[n.actionStatus ?? "todo"])
              : h("span", { className: `ft-pill ft-st-${ev[n.id]}` }, STATUS_LABELS[ev[n.id]]),
          ),
          h(DraftText, {
            value: n.label,
            rows: 1,
            grow: true,
            className: "ft-title-input",
            placeholder: isAction(n) ? "要做什么？" : n.kind === "top" ? "不希望发生的那件事" : "这个原因是什么？",
            onCommit: (label) => ops.update(n.id, { label }),
          }),
          h(
            "div",
            { className: "ft-props" },
            h(
              Prop,
              { label: "角色" },
              h(Seg, {
                value: roleOf(n),
                onChange: (role) => ops.update(n.id, { role }),
                options: [
                  { value: "phenomenon", label: "现象", title: "看得见的结果" },
                  { value: "cause", label: "原因", title: "导致上层发生的原因" },
                  {
                    value: "action",
                    label: "对策",
                    title:
                      n.kind === "top"
                        ? "顶事件不能是对策"
                        : n.children.length > 0
                          ? "下面还挂着东西，不能改成对策"
                          : "处理措施，不参与推导",
                    disabled: n.kind === "top" || (!isAction(n) && n.children.length > 0),
                  },
                ],
              }),
            ),
            isAction(n) &&
              h(
                Prop,
                { label: "状态" },
                h(Seg, {
                  value: n.actionStatus ?? "todo",
                  onChange: (actionStatus) => ops.update(n.id, { actionStatus }),
                  options: [
                    { value: "todo", label: "待做" },
                    { value: "doing", label: "进行中" },
                    { value: "done", label: "已完成", color: "var(--ft-act)" },
                    { value: "ineffective", label: "无效", title: "做了，问题还在 —— 回头重查原因" },
                  ],
                }),
              ),
            isAction(n) &&
              h(
                Prop,
                { label: "截止" },
                h(
                  "div",
                  { className: "ft-date-row" },
                  h("input", {
                    type: "date",
                    className: "ft-date",
                    value: n.due ?? "",
                    onChange: (e) => ops.update(n.id, { due: e.target.value || null }),
                  }),
                  n.due && h("button", { className: "ft-x", title: "清除截止日期", onClick: () => ops.update(n.id, { due: null }) }, "×"),
                ),
              ),
            !isLeaf(n) &&
              causeKids(tree, n).length > 0 &&
              h(
                Prop,
                { label: "门" },
                h(Seg, {
                  value: n.gate,
                  onChange: (gate) => ops.update(n.id, { gate }),
                  options: [
                    { value: "or", label: "或门", title: "任一输入发生，就导致上层" },
                    { value: "and", label: "与门", title: "所有输入同时发生，才导致上层" },
                  ],
                }),
              ),
            isLeaf(n) &&
              h(
                Prop,
                { label: "类型" },
                h(Seg, {
                  value: n.kind,
                  onChange: (kind) => ops.update(n.id, { kind }),
                  options: [
                    { value: "basic", label: "○ 基本", title: "拆到底了，可以直接验证" },
                    { value: "undeveloped", label: "◇ 未展开", title: "暂时不往下拆：信息不够，或不值得拆" },
                  ],
                }),
              ),
            isLeaf(n) &&
              h(
                Prop,
                { label: "验证" },
                h(Seg, {
                  value: n.status,
                  onChange: (status) => ops.update(n.id, { status }),
                  options: [
                    { value: "open", label: "待验证" },
                    { value: "confirmed", label: "已确认", color: "var(--ft-hot)" },
                    { value: "ruled", label: "已排除" },
                  ],
                }),
              ),
            h(
              Prop,
              { label: "时间" },
              h("input", {
                type: "date",
                className: "ft-date",
                value: nodeDay(tree, n),
                onChange: (e) => e.target.value && ops.update(n.id, { at: e.target.value }),
              }),
            ),
            h(
              Prop,
              { label: "事项" },
              n.itemRef
                ? h(
                    "div",
                    { className: "ft-linked" },
                    h(
                      "span",
                      { className: "ft-linked-text", title: linked?.title },
                      linked
                        ? h(React.Fragment, null, h("b", null, linked.kindLabel), " ", linked.title)
                        : "那条事项已经不在了",
                    ),
                    h(
                      "button",
                      { className: "ft-x", title: "解除关联", onClick: () => ops.update(n.id, { itemRef: null }) },
                      "×",
                    ),
                  )
                : h(ItemPicker, {
                    items: candidates,
                    placeholder: "关联一条事项…",
                    onPick: (it) => ops.update(n.id, { itemRef: itemRef(it), label: n.label || it.title }),
                  }),
            ),
            h(
              Prop,
              { label: "备注", top: true },
              h(DraftText, {
                value: n.note,
                rows: 2,
                placeholder: "证据、验证方法…",
                onCommit: (note) => ops.update(n.id, { note }),
              }),
            ),
          ),
        ),

      h(
        "section",
        { className: "ft-sec" },
        h("div", { className: "ft-sec-head" }, h("span", { className: "ft-sec-title" }, "分析")),
        h(
          "div",
          { className: `ft-verdict ft-verdict-${verdict.tone}` },
          h("span", { className: "ft-verdict-mark" }),
          verdict.text,
        ),
        leaves.length > 0 &&
          h(
            "div",
            { className: "ft-meter", "aria-hidden": true },
            ["confirmed", "ruled", "open"].map((k) =>
              counts[k] > 0 && h("span", { key: k, className: `ft-meter-${k}`, style: { flexGrow: counts[k] } }),
            ),
          ),
        leaves.length > 0 &&
          h(
            "div",
            { className: "ft-tally" },
            h("span", { className: "ft-st-confirmed" }, `确认 ${counts.confirmed}`),
            h("span", null, `排除 ${counts.ruled}`),
            h("span", null, `待验证 ${counts.open}`),
          ),
        acts.total > 0 &&
          h(
            "div",
            { className: "ft-acts" },
            h("span", { className: "ft-acts-mark" }),
            "对策 ",
            h("b", null, `${acts.done}/${acts.total}`),
            " 完成",
            acts.overdue > 0 && h("span", { className: "ft-late" }, ` · ${acts.overdue} 条逾期`),
          ),
        cuts.sets.length > 0 &&
          h(
            React.Fragment,
            null,
            h(
              "div",
              { className: "ft-sub", title: "能单独导致顶事件的最小原因组合，阶数越低越该先查" },
              "最小割集",
              h("span", { className: "ft-sub-n" }, cuts.truncated ? `前 ${cuts.sets.length}` : cuts.sets.length),
            ),
            h(
              "ol",
              { className: "ft-cuts", onPointerLeave: () => setHighlight(null) },
              cuts.sets.map((set) => {
                const st = cutSetStatus(tree, set);
                return h(
                  "li",
                  {
                    key: set.join(","),
                    className: `ft-cut ft-cut-${st}`,
                    onPointerEnter: () => setHighlight(set),
                    onClick: () => onSelect(set[0]),
                  },
                  h("span", { className: "ft-cut-order" }, `${set.length}阶`),
                  h(
                    "span",
                    { className: "ft-cut-body" },
                    set.map((id, j) =>
                      h(
                        React.Fragment,
                        { key: id },
                        j > 0 && h("span", { className: "ft-cut-and" }, " + "),
                        h("span", { className: `ft-cut-ev ft-st-${tree.nodes[id].status}` }, tree.nodes[id].label || "（未填写）"),
                      ),
                    ),
                  ),
                  h("span", { className: "ft-cut-st" }, st === "confirmed" ? "成立" : st === "ruled" ? "排除" : "待查"),
                );
              }),
            ),
          ),
      ),

      h(
        "section",
        { className: "ft-sec ft-legend" },
        h(Legend, { kind: "gate-or", name: "或门", text: "任一输入发生，就导致上层" }),
        h(Legend, { kind: "gate-and", name: "与门", text: "所有输入同时发生，才导致上层" }),
        h(Legend, { kind: "basic", name: "基本事件", text: "拆到底了，可以直接验证" }),
        h(Legend, { kind: "undeveloped", name: "未展开事件", text: "暂不往下拆：信息不够或不值得" }),
        h(Legend, { kind: "action", name: "对策", text: "处理措施，不参与推导" }),
      ),
    );
  }

  function KindChip({ n }) {
    if (isAction(n)) {
      return h("span", { className: "ft-kind ft-kind-action" }, h(Glyph, { kind: "action", size: 14 }), ROLE_LABELS.action);
    }
    const k = kindOf(n);
    return h(
      "span",
      { className: `ft-kind ft-kind-${k}` },
      h(Glyph, { kind: k === "basic" ? "basic" : k === "undeveloped" ? "undeveloped" : `gate-${n.gate}`, size: 14 }),
      KIND_LABELS[k],
    );
  }

  function Prop({ label, top, children }) {
    return h(
      "div",
      { className: `ft-prop${top ? " ft-prop-top" : ""}` },
      h("span", { className: "ft-prop-label" }, label),
      h("div", { className: "ft-prop-value" }, children),
    );
  }

  function ItemPicker({ items, onPick, placeholder, className = "ft-picker", title }) {
    return h(
      "select",
      {
        className,
        value: "",
        disabled: items.length === 0,
        title: items.length === 0 ? "没有还没用上的事项" : title,
        onChange: (e) => {
          const it = items.find((x) => x.key === e.target.value);
          if (it) onPick(it);
        },
      },
      h("option", { value: "" }, placeholder),
      items.map((it) =>
        h("option", { key: it.key, value: it.key }, `[${it.kindLabel}] ${it.title}${it.closed ? "（已关闭）" : ""}`),
      ),
    );
  }

  /** 门 / 事件的小符号，和画布上同一套路径 */
  function Glyph({ kind, size = 24 }) {
    const path =
      kind === "gate-or"
        ? symbolPath("intermediate", "or", 13, 1)
        : kind === "gate-and"
          ? symbolPath("intermediate", "and", 13, 1)
          : kind === "undeveloped"
            ? symbolPath("undeveloped", null, 13, 1)
            : null;
    if (kind === "action") {
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 26 24", "aria-hidden": true, className: "ft-glyph ft-glyph-act" },
        h("rect", { x: 3, y: 5, width: 20, height: 14, rx: 5, fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeDasharray: "3 2" }),
      );
    }
    return h(
      "svg",
      { width: size, height: size, viewBox: "0 0 26 24", "aria-hidden": true, className: "ft-glyph" },
      path
        ? h("path", { d: path, fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinejoin: "round" })
        : h("circle", { cx: 13, cy: 12, r: 10, fill: "none", stroke: "currentColor", strokeWidth: 1.5 }),
    );
  }

  function Legend({ kind, name, text }) {
    return h(
      "div",
      { className: "ft-legend-row" },
      h(Glyph, { kind, size: 20 }),
      h("b", null, name),
      h("span", null, text),
    );
  }

  /* ---------------- 整页 ---------------- */

  function FaultTreeView() {
    useShared();
    const [itemsVersion, setItemsVersion] = useState(0);
    useEffect(() => api.data.items.subscribe(() => setItemsVersion((v) => v + 1)), []);
    const items = useMemo(() => api.data.items.list(), [itemsVersion]);

    const [selected, setSelected] = useState(null);
    const [editing, setEditing] = useState(null);
    const [highlight, setHighlight] = useState(null);
    const [copied, setCopied] = useState(false);
    const [listOpen, setListOpen] = useState(false);

    const project = api.data.project();
    const trees = project ? treesOf(project.id) : [];
    const tree = trees.find((t) => t.id === state.activeTree) ?? trees[0] ?? null;

    // 换树时清掉选中
    useEffect(() => {
      setSelected(tree ? tree.root : null);
      setEditing(null);
      setHighlight(null);
    }, [tree?.id]);
    // 选中的节点被删 / 被撤销掉了
    useEffect(() => {
      if (tree && selected && !tree.nodes[selected]) setSelected(tree.root);
    }, [tree, selected]);

    const canvasFocus = () =>
      setTimeout(() => document.querySelector('[data-plugin="fault-tree"] .ft-canvas, .ft-canvas')?.focus(), 0);

    const ops = useMemo(() => {
      if (!tree) return null;
      const id = tree.id;
      const current = () => state.store.trees.find((t) => t.id === id);
      const addWith = (fn) => {
        const t = current();
        if (!t) return;
        const r = fn(t);
        if (!r.id) return;
        mutateTree(id, () => r.tree);
        setSelected(r.id);
        if (!r.tree.nodes[r.id].label) setEditing(r.id);
      };
      return {
        addChild: (nid, init) => addWith((t) => addChild(t, nid, { at: localDay(), ...init })),
        addSibling: (nid, init) => addWith((t) => addSibling(t, nid, { at: localDay(), ...init })),
        addAction: (nid) => addWith((t) => addChild(t, nid, { at: localDay(), role: "action" })),
        update: (nid, patch) => mutateTree(id, (t) => updateNode(t, nid, patch)),
        move: (nid, d) => mutateTree(id, (t) => moveNode(t, nid, d)),
        remove: (nid) => {
          const t = current();
          if (!t || nid === t.root) return;
          const parent = parentOf(t, nid);
          const sibs = parent?.children ?? [];
          const i = sibs.indexOf(nid);
          mutateTree(id, (x) => removeNode(x, nid));
          setSelected(sibs[i + 1] ?? sibs[i - 1] ?? parent?.id ?? t.root);
          canvasFocus();
        },
        undo: () => step(undo, redo),
        redo: () => step(redo, undo),
      };
    }, [tree?.id]);

    if (!project) {
      return h("div", { className: "ft-root ft-center" }, "先打开一个项目。");
    }
    if (!state.loaded) {
      return h("div", { className: "ft-root ft-center" }, "正在读取…");
    }

    const open = (id) => {
      state.activeTree = id;
      notify();
    };

    const header = h(
      "header",
      { className: "ft-bar" },
      h("span", { className: "ft-h1" }, "故障树"),
      h(
        "button",
        {
          className: `ft-btn ft-list-btn${listOpen ? " ft-on" : ""}`,
          title: "查看这个项目的全部故障树，按时间或任务筛选",
          "aria-expanded": listOpen,
          onClick: () => setListOpen((v) => !v),
        },
        h("span", { className: "ft-list-icon", "aria-hidden": true }),
        "列表",
        h("span", { className: "ft-count" }, trees.length),
      ),
      h(
        "div",
        { className: "ft-tabs", role: "tablist" },
        trees.map((t) => {
          const ev = evaluate(t)[t.root];
          const on = tree?.id === t.id;
          return h(
            "div",
            {
              key: t.id,
              role: "tab",
              tabIndex: 0,
              "aria-selected": on,
              className: `ft-tab${on ? " ft-on" : ""}`,
              title: treeTitle(t),
              onClick: () => open(t.id),
              onKeyDown: (e) => e.key === "Enter" && open(t.id),
            },
            h("span", { className: `ft-tab-dot ft-dot-${ev}` }),
            h("span", { className: "ft-tab-text" }, treeTitle(t)),
            h(
              "button",
              {
                className: "ft-tab-x",
                title: "删除这棵树",
                "aria-label": `删除「${treeTitle(t)}」`,
                onClick: (e) => {
                  e.stopPropagation();
                  deleteTree(t);
                },
              },
              "×",
            ),
          );
        }),
        h(
          "button",
          {
            className: "ft-tab ft-tab-new",
            title: "不从事项出发，直接写一个顶事件",
            onClick: () => createTree("", null),
          },
          "＋ 新建",
        ),
      ),
      tree &&
        h(
          "div",
          { className: "ft-bar-right" },
          h(
            "button",
            {
              className: "ft-btn",
              title: "把整棵树复制成缩进大纲，贴进周报或邮件",
              onClick: async () => {
                try {
                  await navigator.clipboard.writeText(outline(tree));
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch (e) {
                  api.log("复制失败", e);
                }
              },
            },
            copied ? "✓ 已复制" : "复制大纲",
          ),
        ),
      listOpen &&
        h(TreeList, {
          trees,
          items,
          activeId: tree?.id,
          onOpen: (id) => {
            open(id);
            setListOpen(false);
          },
          onDelete: deleteTree,
          onClose: () => setListOpen(false),
        }),
    );

    if (!tree) {
      return h(
        "div",
        { className: "ft-root" },
        header,
        h(
          "div",
          { className: "ft-empty-state" },
          h(EmptyArt),
          h("h2", null, "从一个问题出发，往下问「为什么」"),
          h(
            "p",
            null,
            "在「事项」页对一条问题或阻碍点 ⋯ →「建故障树分析」，它就成为顶事件。",
            h("br"),
            "然后用或门、与门一层层拆到基本事件，逐个确认或排除。",
          ),
          h("button", { className: "ft-btn ft-primary", onClick: () => createTree("", null) }, "直接新建一棵"),
        ),
      );
    }

    const usedRefs = new Set(Object.values(tree.nodes).map((x) => x.itemRef).filter(Boolean));
    const candidates = items.filter((it) => !usedRefs.has(itemRef(it)));
    const topRef = tree.nodes[tree.root].itemRef;
    const topItem = topRef ? items.find((it) => itemRef(it) === topRef) : null;

    return h(
      "div",
      { className: "ft-root" },
      header,
      topItem &&
        h(
          "div",
          { className: "ft-source" },
          "顶事件来自事项 ",
          h("b", null, topItem.kindLabel),
          ` · ${topItem.day}`,
          topItem.taskName ? ` · 任务：${topItem.taskName}` : "",
          topItem.personName ? ` · ${topItem.personName}` : "",
          topItem.closed ? " · 已关闭" : "",
        ),
      h(
        "div",
        { className: "ft-body" },
        h(Canvas, {
          tree,
          selected,
          onSelect: (id) => {
            setSelected(id);
            setEditing(null);
          },
          editing,
          setEditing: (id) => {
            setEditing(id);
            if (id == null) canvasFocus();
          },
          highlight,
          ops,
          candidates,
        }),
        h(Inspector, {
          tree,
          selected,
          items,
          candidates,
          onSelect: setSelected,
          setHighlight,
          ops,
        }),
      ),
    );
  }

  /** 按建树日期、关联任务筛 */
  function TreeList({ trees, items, activeId, onOpen, onDelete, onClose }) {
    const [f, setF] = useState({ from: "", to: "", task: "" });
    const byRef = useMemo(() => new Map(items.map((it) => [itemRef(it), it])), [items]);
    const tasks = useMemo(() => {
      const names = new Map(items.filter((it) => it.taskId != null).map((it) => [it.taskId, it.taskName]));
      const used = new Set(trees.flatMap((t) => [...treeTasks(t, byRef)]));
      return [...used].map((id) => ({ id, name: names.get(id) || `任务 ${id}` }));
    }, [trees, items, byRef]);
    const rows = filterTrees(trees, f, byRef);
    const filtered = f.from || f.to || f.task;
    const set = (patch) => setF((x) => ({ ...x, ...patch }));

    useEffect(() => {
      const onKey = (e) => e.key === "Escape" && onClose();
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    return h(
      React.Fragment,
      null,
      h("div", { className: "ft-scrim", onClick: onClose }),
      h(
        "div",
        { className: "ft-list", role: "dialog", "aria-label": "故障树列表" },
        h(
          "div",
          { className: "ft-list-filters" },
          h(
            "label",
            { className: "ft-filter" },
            h("span", null, "加入时间"),
            h("input", { type: "date", className: "ft-date", value: f.from, max: f.to || undefined, onChange: (e) => set({ from: e.target.value }), "aria-label": "起始日期" }),
            h("span", { className: "ft-filter-dash" }, "–"),
            h("input", { type: "date", className: "ft-date", value: f.to, min: f.from || undefined, onChange: (e) => set({ to: e.target.value }), "aria-label": "结束日期" }),
          ),
          h(
            "label",
            { className: "ft-filter" },
            h("span", null, "任务"),
            h(
              "select",
              { className: "ft-picker", value: f.task, onChange: (e) => set({ task: e.target.value }), "aria-label": "按任务筛选" },
              h("option", { value: "" }, "全部任务"),
              tasks.map((t) => h("option", { key: t.id, value: String(t.id) }, t.name)),
              h("option", { value: "none" }, "没关联任务的"),
            ),
          ),
          filtered && h("button", { className: "ft-clear", onClick: () => setF({ from: "", to: "", task: "" }) }, "清除"),
        ),
        rows.length === 0
          ? h("p", { className: "ft-list-empty" }, trees.length === 0 ? "还没有故障树" : "没有符合条件的故障树")
          : h(
              "ul",
              { className: "ft-list-rows" },
              rows.map((t) => {
                const st = evaluate(t)[t.root];
                const taskNames = [...treeTasks(t, byRef)].map((id) => tasks.find((x) => x.id === id)?.name).filter(Boolean);
                const count = Object.keys(t.nodes).length;
                return h(
                  "li",
                  {
                    key: t.id,
                    className: `ft-list-row${t.id === activeId ? " ft-on" : ""}`,
                    onClick: () => onOpen(t.id),
                  },
                  h("span", { className: `ft-tab-dot ft-dot-${st}` }),
                  h(
                    "span",
                    { className: "ft-list-main" },
                    h("span", { className: "ft-list-title" }, treeTitle(t)),
                    h(
                      "span",
                      { className: "ft-list-meta" },
                      h("span", { className: "ft-mono" }, localDay(new Date(t.createdAt))),
                      taskNames.length > 0 && h("span", null, taskNames.join("、")),
                      h("span", null, `${count} 个事件`),
                    ),
                  ),
                  h("span", { className: `ft-list-st ft-st-${st}` }, st === "confirmed" ? "已成立" : st === "ruled" ? "已排除" : "分析中"),
                  h(
                    "button",
                    {
                      className: "ft-tab-x ft-list-x",
                      title: "删除这棵树",
                      "aria-label": `删除「${treeTitle(t)}」`,
                      onClick: (e) => {
                        e.stopPropagation();
                        onDelete(t);
                      },
                    },
                    "×",
                  ),
                );
              }),
            ),
      ),
    );
  }

  function EmptyArt() {
    // 顶事件 → 或门 → 两个基本事件
    return h(
      "svg",
      { width: 120, height: 92, viewBox: "0 0 120 92", className: "ft-empty-art", "aria-hidden": true },
      h("rect", { x: 30, y: 2, width: 60, height: 20, rx: 4, fill: "none", stroke: "currentColor" }),
      h("line", { x1: 60, y1: 22, x2: 60, y2: 28, stroke: "currentColor" }),
      h("path", { d: symbolPath("intermediate", "or", 60, 28), fill: "none", stroke: "currentColor" }),
      h("path", { d: "M60,46 V58 H28 V66 M60,58 H92 V66", fill: "none", stroke: "currentColor" }),
      h("circle", { cx: 28, cy: 77, r: 10, fill: "none", stroke: "currentColor" }),
      h("circle", { cx: 92, cy: 77, r: 10, fill: "var(--ft-hot)", stroke: "var(--ft-hot)" }),
    );
  }

  api.views.register(
    {
      type: "fault-tree.view",
      label: "故障树",
      hint: "这个问题到底是怎么发生的 —— 从顶事件拆到基本原因，逐个验证、排除",
    },
    FaultTreeView,
  );
}

/** onload 里接上；没加载过就什么都不做 */
let flushPending = () => Promise.resolve();

export function onunload() {
  void flushPending();
  flushPending = () => Promise.resolve();
}
