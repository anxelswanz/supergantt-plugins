/**
 * 日报插件：把一段日期里在事项中记下的东西（问题、风险、待办、自建类型……）整理成 Markdown。
 * 单文件无 import（宿主按 Blob URL 加载）；React 必须用 api.react，hooks 才共享。
 */

const RISK_LEVELS = ["高", "中", "低"];

/** 未分拣的事项 kind 为 null，筛选和分段时用这个 key 代替 */
export const UNSORTED = "__unsorted__";

/** 内置类型的固定顺序；自建类型（custom:…）按名字排在它们后面，未分拣垫底 */
const BUILTIN_KINDS = [
  ["issue", "问题"],
  ["risk", "风险"],
  ["todo", "待办"],
  ["blocker", "阻碍"],
];
const BUILTIN_RANK = new Map(BUILTIN_KINDS.map(([k], i) => [k, i]));

const kindKey = (it) => it.kind ?? UNSORTED;

/**
 * 这份数据里有哪些类型，按显示顺序排好。问题、风险总在（筛选项里要给用户看到），
 * 其余类型出现过才列。count 只数 range 内的条数（不传 range 数全部）。
 * 只影响筛选项和排序；日报里没有记录的段整段不输出。
 */
export function listKinds(items, range) {
  const kinds = new Map(BUILTIN_KINDS.slice(0, 2).map(([key, label]) => [key, { key, label, count: 0 }]));
  for (const it of items) {
    const key = kindKey(it);
    if (!kinds.has(key)) {
      const builtin = BUILTIN_KINDS.find(([k]) => k === key);
      kinds.set(key, { key, label: it.kindLabel || builtin?.[1] || "未分拣", count: 0 });
    }
    if (!range || inRange(it, range)) kinds.get(key).count++;
  }
  const rank = (k) =>
    k.key === UNSORTED ? 1e9 : BUILTIN_RANK.get(k.key) ?? BUILTIN_KINDS.length;
  return [...kinds.values()].sort(
    (a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, "zh"),
  );
}

function inRange(it, { from, to, carryOver }) {
  if (it.day >= from && it.day <= to) return true;
  return Boolean(carryOver) && !it.closed && it.day < from;
}

/** 兼容老调用：第二个参数可以只给一天 "YYYY-MM-DD" */
function normRange(range) {
  if (typeof range === "string") return { from: range, to: range };
  const { from, to } = range;
  return from <= to ? { from, to } : { from: to, to: from };
}

/**
 * @param range  "YYYY-MM-DD" 或 { from, to }（含两端）
 * @param opts   kinds：要哪些类型的 key，null/不传 = 全部；
 *               carryOver：开始日之前记的、还没关的也算进来
 */
export function buildReport(items, range, opts = {}) {
  const { withTask = true, carryOver = false, title = "日报", kinds = null } = opts;
  /** [{ name, progress, depth?, personName?, end? }]，按甘特顺序；不传就没有这一段 */
  const inProgress = opts.inProgress ?? null;
  const { from, to } = normRange(range);
  const singleDay = from === to;
  const scope = { from, to, carryOver };

  const picked = kinds ? new Set(kinds) : null;
  const sections = listKinds(items).filter((k) => !picked || picked.has(k.key));

  // 未关闭在前，再按优先级（未填排最后），同级按日期
  const order = (a, b) =>
    Number(a.closed) - Number(b.closed) ||
    (a.priority ?? 9) - (b.priority ?? 9) ||
    a.day.localeCompare(b.day);

  const line = (it, i) => {
    let text = `${i + 1}. ${it.title?.trim() || "（没写内容）"}`;
    const tags = [];
    if (it.riskLevel != null) tags.push(`${RISK_LEVELS[it.riskLevel] ?? "中"}风险`);
    if (withTask && it.taskName) tags.push(`任务：${it.taskName}`);
    if (withTask && it.personName) tags.push(`负责人：${it.personName}`);
    if (it.day < from) tags.push(`${it.day.slice(5)} 记录`);
    else if (!singleDay) tags.push(it.day.slice(5));
    if (tags.length) text += `（${tags.join("，")}）`;
    if (it.closed) text += it.resolution ? ` —— 已解决：${it.resolution}` : " —— 已关闭";
    return text;
  };

  const lists = sections.map((k) => ({
    ...k,
    rows: items.filter((it) => kindKey(it) === k.key && inRange(it, scope)).sort(order),
  }));

  const total = lists.reduce((n, s) => n + s.rows.length, 0);
  const closed = lists.reduce((n, s) => n + s.rows.filter((it) => it.closed).length, 0);
  const summary = lists
    .filter((s) => s.rows.length)
    .map((s) => `${s.label} ${s.rows.length}`)
    .join(" · ");

  const out = [`# ${title} ${singleDay ? from : `${from} ~ ${to}`}`, ""];
  out.push(
    total
      ? `> 共 ${total} 条：${summary}${closed ? `；其中已关闭 ${closed}` : ""}`
      : "> 这段时间没有记录",
  );
  if (inProgress && inProgress.length) {
    out.push("", "## In Progress", "");
    // 每层各自从 1 编号；子任务缩进 3 格成为嵌套列表
    const counters = [];
    out.push(
      ...inProgress.map((t) => {
        const depth = t.depth ?? 0;
        counters.length = depth + 1;
        counters[depth] = (counters[depth] ?? 0) + 1;
        const tags = [`进度 ${Math.round(t.progress * 100)}%`];
        if (withTask && t.personName) tags.push(`负责人：${t.personName}`);
        if (t.end) tags.push(`计划 ${t.end.slice(5)} 完成`);
        const name = t.name?.trim() || "（未命名任务）";
        return `${"   ".repeat(depth)}${counters[depth]}. ${name}（${tags.join("，")}）`;
      }),
    );
  }
  // 这段没东西就整段不出，不写「无」
  for (const s of lists) {
    if (!s.rows.length) continue;
    out.push("", `## ${s.label}`, "");
    out.push(...s.rows.map(line));
  }
  return out.join("\n");
}

/** 「In Progress」这一段在类型勾选里的 key，和事项类型一起记进 excludedKinds */
export const IN_PROGRESS = "__in_progress__";

/**
 * 到 day（天序号）为止还在做的任务，按甘特顺序。插件拿不到实施开始日，判据是：
 * 没做完，且已有进度、或有没关的阻碍、或计划工期盖住了这一天。里程碑不算。
 * depth = 往上有几层祖先也在进行中，日报里按它缩进，父任务下挂子任务。
 */
export function inProgressTasks(tasks, day) {
  const doing = (t) =>
    !t.milestone &&
    t.progress < 1 &&
    (t.progress > 0 || t.openBlockers > 0 || (t.startDay <= day && day <= t.endDay));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const picked = new Set(tasks.filter(doing).map((t) => t.id));
  const depthOf = (t) => {
    let d = 0;
    for (let p = byId.get(t.parentId); p; p = byId.get(p.parentId)) if (picked.has(p.id)) d++;
    return d;
  };
  return tasks.filter((t) => picked.has(t.id)).map((t) => ({ ...t, depth: depthOf(t) }));
}

/* ------------------------------------------------------------------ */
/* Markdown 预览：只认 buildReport 产出的这几种写法，外加 **粗体** 和 `代码`，  */
/* 够用户手改后看个样子。宿主不给 import，没法带 marked。                    */
/* ------------------------------------------------------------------ */

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const inline = (s) =>
  escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

export function renderMarkdown(md) {
  const html = [];
  const stack = []; // 打开着的列表，由外到内：{ tag, indent }
  const closeList = (indent = -1) => {
    while (stack.length && stack[stack.length - 1].indent > indent) {
      html.push(`</li></${stack.pop().tag}>`);
    }
  };
  /** 进入一条列表项：比当前深就开嵌套，同级就收掉上一条 li */
  const openItem = (tag, indent) => {
    closeList(indent);
    const top = stack[stack.length - 1];
    if (top && top.indent === indent && top.tag !== tag) closeList(indent - 1);
    const cur = stack[stack.length - 1];
    if (cur && cur.indent === indent) html.push("</li>");
    else {
      html.push(`<${tag}>`);
      stack.push({ tag, indent });
    }
    html.push("<li>");
  };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      closeList();
      html.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if ((m = /^(\s*)\d+[.)]\s+(.*)$/.exec(line))) {
      openItem("ol", m[1].length);
      html.push(inline(m[2]));
    } else if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) {
      openItem("ul", m[1].length);
      html.push(inline(m[2]));
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      closeList();
      html.push(`<blockquote>${inline(m[1])}</blockquote>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      html.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return html.join("");
}

/* ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function todayIso() {
  return iso(new Date());
}

/** 含今天在内往前数 n 天的起始日 */
function daysAgoIso(n) {
  const d = new Date();
  d.setDate(d.getDate() - (n - 1));
  return iso(d);
}

const PRESETS = [
  { label: "今天", days: 1 },
  { label: "近 7 天", days: 7 },
  { label: "近 30 天", days: 30 },
];

/** 复制到剪贴板。clipboard API 不可用时退回选中 + execCommand */
async function copyText(text, textarea) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!textarea) return false;
    textarea.select();
    return document.execCommand("copy");
  }
}

/** 记的是「取消勾选了哪些」而不是「勾了哪些」：新建的类型默认就在日报里 */
function readExcluded(api) {
  try {
    const v = JSON.parse(api.settings.get("excludedKinds") || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function onload(api) {
  const React = api.react;
  const h = React.createElement;
  const { useEffect, useMemo, useRef, useState } = React;

  api.settings.field({
    key: "title",
    kind: "text",
    label: "日报标题",
    desc: "生成的第一行，后面自动接日期",
    def: "日报",
  });
  api.settings.field({
    key: "withTask",
    kind: "toggle",
    label: "每条带上关联任务和负责人",
    desc: "关掉之后每条只有一句话，适合贴进群里",
    def: true,
  });
  api.settings.field({
    key: "carryOver",
    kind: "toggle",
    label: "包含之前记的、还没关闭的",
    desc: "打开后，开始日之前记下但仍未解决的事项也会列进来",
    def: false,
  });

  function ReportView() {
    const [from, setFrom] = useState(todayIso);
    const [to, setTo] = useState(todayIso);
    const [excluded, setExcluded] = useState(() => new Set(readExcluded(api)));
    const [version, setVersion] = useState(0);
    const [text, setText] = useState("");
    const [preview, setPreview] = useState(false);
    const [copied, setCopied] = useState(false);
    const box = useRef(null);

    // 事项、任务变了就重新生成（会覆盖手改内容）
    useEffect(() => api.data.items.subscribe(() => setVersion((v) => v + 1)), []);
    useEffect(() => api.data.tasks?.subscribe(() => setVersion((v) => v + 1)), []);

    const items = useMemo(() => api.data.items.list(), [version]);
    const end = from <= to ? to : from;
    const doing = useMemo(() => {
      const tasks = api.data.tasks?.list() ?? [];
      const people = new Map((api.data.people?.list() ?? []).map((p) => [p.id, p.name]));
      return inProgressTasks(tasks, api.util.toDay(end)).map((t) => ({
        name: t.name,
        progress: t.progress,
        depth: t.depth,
        personName: t.personId != null ? people.get(t.personId) ?? null : null,
        end: api.util.toISODate(t.endDay),
      }));
    }, [version, end]);
    const carryOver = api.settings.getBool("carryOver");
    const kinds = useMemo(
      () => listKinds(items, { from: from <= to ? from : to, to: from <= to ? to : from, carryOver }),
      [items, from, to, carryOver],
    );
    const allOn = !excluded.has(IN_PROGRESS) && kinds.every((k) => !excluded.has(k.key));

    const generate = () =>
      setText(
        buildReport(items, { from, to }, {
          title: api.settings.get("title") || "日报",
          withTask: api.settings.getBool("withTask"),
          carryOver,
          // 全选就不传，日报里列出全部类型
          kinds: allOn ? null : kinds.filter((k) => !excluded.has(k.key)).map((k) => k.key),
          inProgress: excluded.has(IN_PROGRESS) ? null : doing,
        }),
      );
    useEffect(generate, [items, doing, from, to, excluded]);

    const saveExcluded = (next) => {
      setExcluded(next);
      api.settings.set("excludedKinds", JSON.stringify([...next]));
    };
    const toggleKind = (key) => {
      const next = new Set(excluded);
      next.has(key) ? next.delete(key) : next.add(key);
      saveExcluded(next);
    };
    const toggleAll = () =>
      saveExcluded(allOn ? new Set([IN_PROGRESS, ...kinds.map((k) => k.key)]) : new Set());

    const today = todayIso();
    const setPreset = (days) => {
      setFrom(daysAgoIso(days));
      setTo(today);
    };
    const presetOn = (days) => to === today && from === daysAgoIso(days);

    const copy = async () => {
      if (await copyText(text, box.current)) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    };

    const chip = (on, label, onClick, key, title) =>
      h(
        "button",
        { key, className: `dr-chip${on ? " dr-chip-on" : ""}`, onClick, title },
        label,
      );

    return h(
      "div",
      { className: "dr-root" },
      h(
        "div",
        { className: "dr-bar" },
        h("span", { className: "dr-title" }, "日报"),
        ...PRESETS.map((p) => chip(presetOn(p.days), p.label, () => setPreset(p.days), p.label)),
        h("input", {
          type: "date",
          className: "dr-date",
          value: from,
          max: to,
          title: "开始日",
          onChange: (e) => e.target.value && setFrom(e.target.value),
        }),
        h("span", { className: "dr-dim" }, "至"),
        h("input", {
          type: "date",
          className: "dr-date",
          value: to,
          min: from,
          title: "结束日",
          onChange: (e) => e.target.value && setTo(e.target.value),
        }),
        h(
          "button",
          { className: "dr-btn dr-push", onClick: generate, title: "丢掉手改的内容，按当前数据重新生成" },
          "重新生成",
        ),
        h(
          "button",
          { className: "dr-btn", onClick: () => setPreview((p) => !p) },
          preview ? "编辑" : "预览",
        ),
        h(
          "button",
          { className: "dr-btn dr-primary", onClick: () => void copy(), title: "复制 Markdown 原文" },
          copied ? "✓ 已复制" : "复制",
        ),
      ),
      h(
        "div",
        { className: "dr-bar" },
        h("span", { className: "dr-dim" }, "类型"),
        chip(allOn, "全选", toggleAll, "__all__"),
        chip(
          !excluded.has(IN_PROGRESS),
          `In Progress ${doing.length}`,
          () => toggleKind(IN_PROGRESS),
          IN_PROGRESS,
          "结束日那天还在做的任务",
        ),
        ...kinds.map((k) =>
          chip(!excluded.has(k.key), `${k.label} ${k.count}`, () => toggleKind(k.key), k.key),
        ),
      ),
      h(
        "p",
        { className: "dr-hint" },
        "取这段日期里在事项中记下的记录，按类型分段，Markdown 格式。文字可以直接改，改完再复制。",
      ),
      preview
        ? h("div", {
            className: "dr-text dr-md",
            dangerouslySetInnerHTML: { __html: renderMarkdown(text) },
          })
        : h("textarea", {
            ref: box,
            className: "dr-text",
            value: text,
            spellCheck: false,
            onChange: (e) => setText(e.target.value),
          }),
    );
  }

  api.views.register(
    { type: "daily-report.view", label: "日报", hint: "今天或一段时间里记了什么 —— 一键整理成 Markdown 日报" },
    ReportView,
  );
}
