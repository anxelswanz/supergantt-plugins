/**
 * 插件系统的契约来源。改这里任何字段都是破坏性变更，manifest 的
 * apiVersion 必须跟着涨（见 manifest.ts 的版本检查）。
 */

import type { ComponentType } from "react";

/** 半兼容版本号，与项目文件格式同一套约定 */
export interface Version {
  major: number;
  minor: number;
}

/** manifest.json。字段刻意少：每个都得能回答「宿主拿它做什么决定」。 */
export interface PluginManifest {
  /** 唯一标识，必须等于所在目录名（见 plugin.rs） */
  id: string;
  /** 显示名 */
  name: string;
  version: string;
  /** 插件作者，纯展示 */
  author?: string;
  /** 一句话说明，显示在设置面板名字下 */
  description?: string;
  /** 需要的宿主 API 版本。major 不符拒绝，minor 落后只警告 */
  apiVersion: string;
  /** 入口文件，相对插件目录。缺省 main.js */
  main?: string;
  /** 视图声明；渲染函数在 onload 里注册 */
  views?: PluginViewDeclaration[];
  /** 需要的宿主能力，不声明就拿不到 */
  permissions?: PluginPermissions;
  /** 附带的 Claude Skill：启用时软链接到 `~/.claude/skills/<name>`，停用时移除 */
  skills?: { dir: string; name: string }[];
}

export interface PluginPermissions {
  /** 允许运行的程序（裸程序名）。工作目录固定是插件目录，shell 一律不许 */
  exec?: string[];
}

/** manifest 里声明的视图元信息；扫描阶段就要知道，工具条才不会先画错位再跳。 */
export interface PluginViewDeclaration {
  /** 视图 key，全局唯一，建议 "<插件id>.<名字>" */
  type: string;
  /** 工具条上的标签，两三个字 */
  label: string;
  /** 悬停提示 */
  hint: string;
}

/** 可渲染的视图（React 组件，共用宿主的 hooks 和错误边界） */
export interface RegisteredView extends PluginViewDeclaration {
  /** 来自哪个插件；内置视图为 "builtin" */
  pluginId: string;
  render: ComponentType;
}

/** 注册返回的句柄，宿主卸载插件时统一 dispose */
export interface Disposable {
  dispose: () => void;
}

/** 插件设置项，只支持这三种 */
export type PluginSettingField =
  | { key: string; kind: "text"; label: string; desc?: string; placeholder?: string; def?: string }
  | { key: string; kind: "toggle"; label: string; desc?: string; def?: boolean }
  | {
      key: string;
      kind: "select";
      label: string;
      desc?: string;
      options: { value: string; label: string }[];
      def?: string;
    };

/** 设置读写。key 自动加 "plugin.<id>." 前缀 */
export interface PluginSettings {
  get(key: string): string | null;
  getBool(key: string): boolean;
  set(key: string, value: string): void;
  /** 注册设置项，显示在设置面板的插件页 */
  field(field: PluginSettingField): Disposable;
}

/** 命令。注册后在命令面板里可搜、可绑快捷键 */
export interface PluginCommand {
  /** 命令 id，建议带插件前缀 */
  id: string;
  label: string;
  /** 快捷键提示，如 "⌘⇧K"。只显示，绑定需自己加监听 */
  hint?: string;
  /** 1.3：别的插件经 commands.run(id, ...args) 调用时带参数；返回值原样交回调用方 */
  run: (...args: unknown[]) => unknown;
}

/** 工具栏按钮 */
export interface PluginToolbarItem {
  id: string;
  /** 按钮文字，宜短 */
  label: string;
  title?: string;
  /** 只在该视图下显示；不填则都显示 */
  onlyInView?: string;
  onClick: () => void;
}

/* ------------------------------------------------------------------ */
/* 数据访问                                                            */
/* ------------------------------------------------------------------ */

/** Task 的只读投影，隔离内部类型重构。 */
export interface TaskView {
  id: number;
  parentId: number | null;
  name: string;
  /** 天序号，用 api.util.toISODate 转日期 */
  startDay: number;
  endDay: number;
  progress: number;
  /** 0 高 / 1 中 / 2 低 / 3 无 */
  priority: number;
  personId: number | null;
  milestone: boolean;
  collapsed: boolean;
  /** 未关闭的阻碍条数 */
  openBlockers: number;
  /* 刻意不给 note：store 里那份可能过期，读旧值写回会覆盖用户刚写的（见 db/convert.ts） */
}

/** 事项清单的一行，core/items.ItemRow 的只读投影 */
export interface ItemView {
  /** 跨来源唯一，如 "note:3" / "risk:7" / "blocker:12/b1" */
  key: string;
  source: "note" | "blocker" | "risk";
  title: string;
  /** 类型 key：'todo' / 'issue' / 'custom:…' / 'blocker' / 'risk'；null = 未分拣 */
  kind: string | null;
  /** 类型显示名；未分拣为「未分拣」 */
  kindLabel: string;
  /** 0–3；null = 没填过 */
  priority: number | null;
  personId: number | null;
  /** 负责人名字；没有为 null */
  personName: string | null;
  taskId: number | null;
  taskName: string | null;
  /** 记录日，本地 "YYYY-MM-DD"；阻碍为起始日 */
  day: string;
  closed: boolean;
  /** 关闭原因 */
  resolution: string | null;
  /** 风险等级 0 高 / 1 中 / 2 低；不是风险为 null */
  riskLevel: number | null;
  /** 关闭日（本地日期），没关为 null。阻碍为区间结束日，风险为处置日 */
  closedDay: string | null;
  /** 背后事项 id，甘特上直接建的为 null。认住事项用它而非 key（分拣会改 key） */
  noteId: number | null;
}

/** 事项分拣菜单项。label 按行返回文字，返回 null 则该行不显示。 */
export interface PluginItemAction {
  id: string;
  label: (item: ItemView) => string | null;
  hint?: string;
  run: (item: ItemView) => void | Promise<void>;
}

/** 事项行标题旁的小标签。返回 null 不显示 */
export interface PluginItemBadge {
  id: string;
  render: (item: ItemView) => { text: string; title?: string; color?: string } | null;
}

/** 子进程的一次运行 */
export interface PluginProcess {
  /** 结束时 resolve；code 为 null 表示被杀或出错 */
  done: Promise<{ code: number | null }>;
  kill(): void;
}

export interface PluginProcApi {
  /** 在 PATH 里找程序，返回绝对路径或 null */
  which(program: string): Promise<string | null>;
  /** 起进程，输出按行回调。程序须在 permissions.exec 里 */
  spawn(
    program: string,
    args: string[],
    opts?: {
      stdin?: string;
      onStdout?: (line: string) => void;
      onStderr?: (line: string) => void;
    },
  ): Promise<PluginProcess>;
  /** spawn 便捷版：跑完后一次返回全部输出 */
  exec(
    program: string,
    args: string[],
    opts?: { stdin?: string },
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

/**
 * 插件私有存储 `<插件目录>/data/<name>`，原子写入。小开关走 settings，结构化数据走这里。
 * 卸载不删 data/。
 */
export interface PluginStorage {
  read(name: string): Promise<string | null>;
  write(name: string, content: string): Promise<void>;
}

/**
 * 数据 API，全部同步（视图在 render 期间读）。tasks 只读，改走 act；
 * dailyNotes / risks 即写即存，不进撤销栈。
 */
export interface PluginDataApi {
  tasks: {
    /** 当前项目任务快照；没打开项目时为空数组 */
    list(): TaskView[];
    byId(id: number): TaskView | null;
    /** 每次命令落地都通知；返回值取消订阅 */
    subscribe(listener: () => void): () => void;
  };
  dailyNotes: {
    list(): { id: number; taskId: number | null; day: string; content: string }[];
    add(taskId: number | null, day: string, content: string): void;
    remove(id: number): void;
  };
  risks: {
    /** 未关闭的风险 */
    open(): { id: number; taskId: number; content: string; level: number }[];
    add(taskId: number, content: string, level: number): void;
  };
  /** 当前打开的项目；项目列表页时为 null */
  project(): { id: number; name: string } | null;
  /** 全部负责人 */
  people: {
    list(): { id: number; name: string }[];
  };
  /** 事项清单；与事项视图同一合并层（core/items.mergeItems） */
  items: {
    list(): ItemView[];
    /**
     * 1.3：关闭一条事项并写下结论（key 即 ItemView.key）。
     * 事项、风险写进结论；阻碍在今天结束并记下结论。已关闭的事项、风险会覆盖结论，
     * 关闭日期记成今天；已结束的阻碍只改结论。
     * 认不出、悬挂引用、还没分拣的事项会抛错 —— 规则和事项页的圆圈一致
     */
    close(key: string, resolution: string): Promise<void>;
    /** 事项、风险、类型表变了才通知；返回值取消订阅 */
    subscribe(listener: () => void): () => void;
  };
}

/** 修改动作，全部经命令栈，自动获得撤销/重做/落库。 */
export interface PluginActionApi {
  /** 改任务字段；label 显示在撤销提示里 */
  patchTask(id: number, changes: Partial<TaskPatch>, label: string): void;
  /** 新建任务插到 afterId 后（null = 末尾），返回新 id */
  addTask(name: string, afterId: number | null): number;
  deleteTask(id: number): void;
  /** 切顶层视图 */
  setActiveView(viewType: string): void;
}

/** 插件能改的任务字段（父任务日期是汇总值，不可直接改） */
export interface TaskPatch {
  name: string;
  startDay: number;
  endDay: number;
  progress: number;
  priority: 0 | 1 | 2 | 3;
  personId: number | null;
  milestone: boolean;
}

/** 宿主交给插件的完整 api。不暴露 Tauri invoke，每项能力都须在此显式加方法。 */
export interface PluginApi {
  /** 插件自己的 id */
  readonly id: string;
  /** 宿主 API 版本，可据此降级 */
  readonly hostApiVersion: Version;
  /** 宿主的 React 实例（入口仍须自带打包的 React，见 registry.assertSelfContained） */
  readonly react: typeof import("react");
  views: {
    register(view: PluginViewDeclaration, render: ComponentType): Disposable;
  };
  commands: {
    register(command: PluginCommand): Disposable;
    /**
     * 按 id 跑命令，可跨插件调用。1.3 起可以带参数，返回命令的返回值；
     * 命令不存在或抛错时 reject（1.2 及以前是静默吞掉）
     */
    run(id: string, ...args: unknown[]): Promise<unknown>;
    /** 1.3：这个命令现在有没有（对方插件停用了就没有） */
    has(id: string): boolean;
  };
  toolbar: {
    register(item: PluginToolbarItem): Disposable;
  };
  settings: PluginSettings;
  data: PluginDataApi;
  act: PluginActionApi;
  /** 插件目录的绝对路径 */
  readonly dir: string;
  /** 事项页的扩展点 */
  itemActions: {
    register(action: PluginItemAction): Disposable;
  };
  itemBadges: {
    register(badge: PluginItemBadge): Disposable;
    /** 插件状态变了、徽标需重画时调用 */
    refresh(): void;
  };
  proc: PluginProcApi;
  storage: PluginStorage;
  /** 日期换算工具 */
  util: {
    /** 天序号 → "YYYY-MM-DD" */
    toISODate(day: number): string;
    /** "YYYY-MM-DD" → 天序号 */
    toDay(iso: string): number;
    today(): number;
  };
  /** 控制台日志，自动带插件前缀 */
  log(...args: unknown[]): void;
}

/** 插件模块导出。onunload 只需清理自己挂在 window/document 上的监听和定时器。 */
export interface PluginModule {
  onload(api: PluginApi): void | Promise<void>;
  onunload?(): void;
}

/** 扫描 + 校验后一个插件的完整状态 */
export interface PluginRecord {
  manifest: PluginManifest;
  /** 目录绝对路径 */
  path: string;
  /** 从开发目录（本地源码）加载的，不是装在插件目录里的 */
  dev: boolean;
  enabled: boolean;
  /** disabled 是用户关的，error 是坏的需修 */
  status: "loaded" | "disabled" | "error";
  /** error 时的原因，直接显示给用户 */
  error?: string;
  /** 校验警告，不挡加载 */
  warnings: string[];
}
