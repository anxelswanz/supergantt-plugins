/** 顶层视图清单。各视图的数据需求归各自组件，本文件不依赖插件系统。 */

/** 视图 key。插件运行时注册视图，故是 string；认不认得由 Workspace 查注册表，查不到回退甘特。 */
export type AppView = string;

/** 内置视图 key。 */
export type BuiltinView =
  | "gantt"
  | "board"
  | "timeline"
  | "review"
  | "ai-review"
  | "items"
  | "milestone";

export interface ViewMeta {
  key: BuiltinView;
  label: string;
  hint: string;
}

/** 内置视图。插件视图由 plugins/registry.ts 注册，在 Workspace 合并。 */
export const APP_VIEWS: ViewMeta[] = [
  { key: "gantt", label: "甘特", hint: "这些活排在哪 —— 拖拽改期、改工期、记进度" },
  { key: "board", label: "看板", hint: "此刻谁没开始、谁在做、谁卡住了" },
  { key: "timeline", label: "时间线", hint: "逐日流水：每天发生了什么" },
  { key: "review", label: "复盘", hint: "计划与实际差在哪、为什么、丢了多少天" },
  { key: "ai-review", label: "AI 复盘", hint: "Claude 问十道题，写出根因分析和可沉淀的 SOP、避坑清单" },
  { key: "items", label: "事项", hint: "还没成为计划的那些：代办、问题、风险、阻碍" },
  { key: "milestone", label: "里程碑", hint: "项目关键节点：设定、关联任务、在甘特图上标记" },
];

/* ------------------------------------------------------------------ */
/* 开关                                                                */
/* ------------------------------------------------------------------ */

/** 甘特不可关：唯一的编辑面，也保证了「至少一个视图」。 */
export const PERMANENT_VIEW: BuiltinView = "gantt";

/** 可关的视图，顺序同 APP_VIEWS */
export const OPTIONAL_VIEWS: BuiltinView[] = [
  "board",
  "timeline",
  "review",
  "ai-review",
  "items",
  "milestone",
];

export const DEFAULT_ENABLED: BuiltinView[] = [PERMANENT_VIEW, ...OPTIONAL_VIEWS];

/**
 * 读 `settings.enabled_views`；读不懂回退全开。
 * 插件视图不受此开关管（开关是装不装插件），未知 key 一律丢掉。
 */
export function parseEnabledViews(raw: string | null | undefined): BuiltinView[] {
  if (!raw) return [...DEFAULT_ENABLED];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [...DEFAULT_ENABLED];
  }
  if (!Array.isArray(parsed)) return [...DEFAULT_ENABLED];

  const wanted = new Set(
    parsed.filter((v): v is BuiltinView => typeof v === "string" && isOptionalView(v)),
  );
  // 甘特永远第一个 —— ⌘1 依赖它
  return [PERMANENT_VIEW, ...OPTIONAL_VIEWS.filter((v) => wanted.has(v))];
}

export const serializeEnabledViews = (views: BuiltinView[]): string =>
  JSON.stringify(views.filter((v) => v === PERMANENT_VIEW || isOptionalView(v)));

const isOptionalView = (v: string): v is BuiltinView =>
  (OPTIONAL_VIEWS as string[]).includes(v);

/** 开关一个视图；甘特关不掉，原样返回。 */
export function toggleView(
  enabled: BuiltinView[],
  key: BuiltinView,
  on: boolean,
): BuiltinView[] {
  if (key === PERMANENT_VIEW) return enabled;
  const set = new Set(enabled);
  if (on) set.add(key);
  else set.delete(key);
  return [PERMANENT_VIEW, ...OPTIONAL_VIEWS.filter((v) => set.has(v))];
}

/**
 * 与 plugins/manifest.ts 的 ID_PATTERN 同源。只挡格式；
 * 「插件已删、key 已失效」要等 Workspace 查注册表才知道。
 */
const VIEW_KEY_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;

export const isViewKey = (v: unknown): v is AppView =>
  typeof v === "string" && VIEW_KEY_PATTERN.test(v);

/* ------------------------------------------------------------------ */
/* 顺序                                                                */
/* ------------------------------------------------------------------ */

/** 读 `settings.view_order`（含插件视图的完整 key 列表）；读不懂返回 []。 */
export function parseViewOrder(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isViewKey);
  } catch {
    return [];
  }
}

/**
 * 按手动顺序重排：排过的在前；未排过的保持原相对顺序接在后面；
 * order 里有而清单里没有的忽略。
 */
export function applyViewOrder<T extends { key: string }>(views: T[], order: string[]): T[] {
  if (order.length === 0) return views;
  const rank = new Map(order.map((k, i) => [k, i]));
  const ranked = views.filter((v) => rank.has(v.key));
  const rest = views.filter((v) => !rank.has(v.key));
  ranked.sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  return [...ranked, ...rest];
}

/** 把 `from` 挪到 `to` 前/后；from === to 或任一不在清单里时原样返回。 */
export function moveView(
  keys: string[],
  from: string,
  to: string,
  place: "before" | "after",
): string[] {
  if (from === to) return keys;
  const fromIndex = keys.indexOf(from);
  if (fromIndex < 0 || !keys.includes(to)) return keys;
  const next = keys.filter((k) => k !== from);
  const target = next.indexOf(to);
  next.splice(place === "before" ? target : target + 1, 0, from);
  return next;
}
