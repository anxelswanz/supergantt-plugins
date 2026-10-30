/**
 * 日报插件：把某天在事项里记的「问题」「风险」整理成可粘贴的文字。
 * 单文件无 import（宿主按 Blob URL 加载）；React 必须用 api.react，hooks 才共享。
 */

const RISK_LEVELS = ["高", "中", "低"];

/**
 * @param date  "YYYY-MM-DD"
 * @param opts  carryOver：之前记的、到这天还没关的也算进来
 */
export function buildReport(items, date, opts = {}) {
  const { withTask = true, carryOver = false, title = "日报" } = opts;

  const inScope = (it) => it.day === date || (carryOver && !it.closed && it.day < date);
  // 未关闭在前，再按优先级（未填排最后）
  const order = (a, b) =>
    Number(a.closed) - Number(b.closed) || (a.priority ?? 9) - (b.priority ?? 9);

  const issues = items.filter((it) => it.kind === "issue" && inScope(it)).sort(order);
  const risks = items.filter((it) => it.kind === "risk" && inScope(it)).sort(order);

  const line = (it, i) => {
    let text = `${i + 1}. ${it.title || "（没写内容）"}`;
    const tags = [];
    if (it.riskLevel != null) tags.push(`${RISK_LEVELS[it.riskLevel] ?? "中"}风险`);
    if (withTask && it.taskName) tags.push(`任务：${it.taskName}`);
    if (withTask && it.personName) tags.push(`负责人：${it.personName}`);
    if (carryOver && it.day < date) tags.push(`${it.day.slice(5)} 记录`);
    if (tags.length) text += `（${tags.join("，")}）`;
    if (it.closed) text += it.resolution ? ` —— 已解决：${it.resolution}` : " —— 已关闭";
    return text;
  };

  const section = (name, list) =>
    [name, ...(list.length ? list.map(line) : ["1. 无"])].join("\n");

  return [`${title} ${date}`, "", section("问题", issues), "", section("风险", risks)].join("\n");
}

function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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

export function onload(api) {
  const React = api.react;
  const h = React.createElement;
  const { useEffect, useRef, useState } = React;

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
    desc: "打开后，前几天记下但到今天仍未解决的问题和风险也会列进来",
    def: false,
  });

  function ReportView() {
    const [date, setDate] = useState(todayIso);
    const [version, setVersion] = useState(0);
    const [text, setText] = useState("");
    const [copied, setCopied] = useState(false);
    const box = useRef(null);

    // 事项变了就重新生成（会覆盖手改内容）
    useEffect(() => api.data.items.subscribe(() => setVersion((v) => v + 1)), []);

    const generate = () =>
      setText(
        buildReport(api.data.items.list(), date, {
          title: api.settings.get("title") || "日报",
          withTask: api.settings.getBool("withTask"),
          carryOver: api.settings.getBool("carryOver"),
        }),
      );
    useEffect(generate, [date, version]);

    const copy = async () => {
      if (await copyText(text, box.current)) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    };

    return h(
      "div",
      { className: "dr-root" },
      h(
        "div",
        { className: "dr-bar" },
        h("span", { className: "dr-title" }, "日报"),
        h("input", {
          type: "date",
          className: "dr-date",
          value: date,
          onChange: (e) => e.target.value && setDate(e.target.value),
        }),
        date !== todayIso() &&
          h("button", { className: "dr-btn", onClick: () => setDate(todayIso()) }, "回到今天"),
        h(
          "button",
          { className: "dr-btn", onClick: generate, title: "丢掉手改的内容，按当前数据重新生成" },
          "重新生成",
        ),
        h(
          "button",
          { className: "dr-btn dr-primary", onClick: () => void copy() },
          copied ? "✓ 已复制" : "复制",
        ),
      ),
      h(
        "p",
        { className: "dr-hint" },
        "取这一天在事项里记下的「问题」和「风险」。下面的文字可以直接改，改完再复制。",
      ),
      h("textarea", {
        ref: box,
        className: "dr-text",
        value: text,
        spellCheck: false,
        onChange: (e) => setText(e.target.value),
      }),
    );
  }

  api.views.register(
    { type: "daily-report.view", label: "日报", hint: "今天记了哪些问题和风险 —— 一键整理成日报" },
    ReportView,
  );
}
