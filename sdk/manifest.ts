/**
 * manifest.json 的校验。纯函数、不碰 IO，可直接单测；
 * 错误信息要指明哪个字段、应该是什么 —— 它唯一的读者是插件作者。
 */

import type { PluginManifest, PluginViewDeclaration, Version } from "./types";
import { APP_VIEWS } from "./views";

/**
 * 宿主当前提供的 API 版本。删字段/改语义 → major+1（旧插件拒绝加载）；
 * 只加新方法 → minor+1（旧插件照常跑）。
 */
export const HOST_API_VERSION: Version = { major: 1, minor: 4 };
/* 1.1：data.items；1.2：itemActions/itemBadges、proc、storage、data.project/people、
   ItemView.closedDay/noteId、permissions、skills；1.3：data.items.close、commands.run 带参数并返回 Promise、commands.has；1.4：data.items.reopen、close 可不带结论 */

/** 内置视图的 key，插件视图不能用。从 core/views.ts 读而不另抄一份 ——
 *  抄的那份会在新增内置视图后漏掉，冲突只在装了那个插件的机器上复现。 */
const RESERVED_VIEW_TYPES = new Set<string>(APP_VIEWS.map((v) => v.key));

/** 插件 id 的形状。id 同时用作目录名、settings key 前缀、视图 type 前缀，
 *  任一处出现空格/斜杠/点都各出一种 bug，所以在入口一次拦住。 */
const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

export type ValidationResult =
  | { ok: true; manifest: PluginManifest; warnings: string[] }
  | { ok: false; error: string };

/** "1.2" → {1, 2}。只认两段，第三段（patch）有也忽略 */
export function parseVersion(raw: string): Version | null {
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

/** 版本比较，看不懂的段按 0 算 —— 只用于设置页显示「更新」还是「已安装」 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/**
 * 校验 manifest。dirName 必须与 id 一致；host 可注入以便测试。
 */
export function validateManifest(
  raw: string | null,
  dirName: string,
  host: Version = HOST_API_VERSION,
): ValidationResult {
  if (raw == null) {
    return { ok: false, error: "缺少 manifest.json" };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `manifest.json 不是合法的 JSON：${(e as Error).message}` };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, error: "manifest.json 的顶层必须是一个对象" };
  }
  const m = json as Record<string, unknown>;
  const warnings: string[] = [];

  /* ---------------- 必填字段 ---------------- */

  for (const key of ["id", "name", "version", "apiVersion"] as const) {
    if (!str(m[key])) {
      return { ok: false, error: `manifest.json 缺少 "${key}" 字段，或者它不是非空字符串` };
    }
  }
  const id = m.id as string;

  if (!ID_PATTERN.test(id)) {
    return {
      ok: false,
      error: `id "${id}" 不合法：只能用小写字母、数字和连字符，字母开头，2–64 个字符`,
    };
  }
  if (id !== dirName) {
    return {
      ok: false,
      error: `id "${id}" 和所在目录名 "${dirName}" 不一致 —— 把目录改名成 "${id}"，或者把 id 改成 "${dirName}"`,
    };
  }

  /* ---------------- 版本兼容 ---------------- */

  const need = parseVersion(m.apiVersion as string);
  if (!need) {
    return {
      ok: false,
      error: `apiVersion "${m.apiVersion}" 看不懂，应该写成 "1.0" 这样的形式`,
    };
  }
  if (need.major !== host.major) {
    return {
      ok: false,
      error: `插件需要宿主 API ${need.major}.x，当前是 ${host.major}.${host.minor} —— 主版本不同，接口可能已经变了`,
    };
  }
  if (need.minor > host.minor) {
    // 不拒绝（宿主一落后就全挂），但要警告：新接口可能不可用
    warnings.push(
      `插件按宿主 API ${need.major}.${need.minor} 写的，当前是 ${host.major}.${host.minor}，新接口可能不可用`,
    );
  }

  /* ---------------- 可选字段 ---------------- */

  if (m.main !== undefined) {
    if (!str(m.main)) return { ok: false, error: `"main" 必须是非空字符串` };
    // 只允许一层文件名，"../" 等于允许读任意文件
    if (/[\\/]|\.\./.test(m.main as string)) {
      return { ok: false, error: `"main" 只能是插件目录里的文件名，不能带路径：${m.main}` };
    }
  }

  const views: PluginViewDeclaration[] = [];
  if (m.views !== undefined) {
    if (!Array.isArray(m.views)) return { ok: false, error: `"views" 必须是数组` };
    const seen = new Set<string>();
    for (const [i, v] of m.views.entries()) {
      const at = `views[${i}]`;
      if (typeof v !== "object" || v === null) return { ok: false, error: `${at} 必须是对象` };
      const vv = v as Record<string, unknown>;
      for (const key of ["type", "label", "hint"] as const) {
        if (!str(vv[key])) return { ok: false, error: `${at} 缺少 "${key}"` };
      }
      const type = vv.type as string;
      if (RESERVED_VIEW_TYPES.has(type)) {
        return { ok: false, error: `${at}.type "${type}" 是内置视图的名字，换一个` };
      }
      if (seen.has(type)) return { ok: false, error: `${at}.type "${type}" 重复了` };
      seen.add(type);
      if (!type.startsWith(`${id}.`)) {
        // 不强制；两个插件撞名时只有前缀能救
        warnings.push(`视图 "${type}" 没有用 "${id}." 作前缀，可能和别的插件撞名`);
      }
      views.push({ type, label: vv.label as string, hint: vv.hint as string });
    }
  }

  /* ---------------- 权限 / Skill（1.2） ---------------- */

  /** 程序名、Skill 名、目录名共用的形状：单段，不带路径 */
  const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

  let permissions: PluginManifest["permissions"];
  if (m.permissions !== undefined) {
    if (typeof m.permissions !== "object" || m.permissions === null || Array.isArray(m.permissions)) {
      return { ok: false, error: `"permissions" 必须是对象` };
    }
    const p = m.permissions as Record<string, unknown>;
    if (p.exec !== undefined) {
      if (!Array.isArray(p.exec) || !p.exec.every((x) => typeof x === "string" && SEGMENT.test(x))) {
        return { ok: false, error: `"permissions.exec" 必须是程序名数组，如 ["lark-cli"]，不能带路径` };
      }
      permissions = { exec: p.exec as string[] };
    }
  }

  const skills: { dir: string; name: string }[] = [];
  if (m.skills !== undefined) {
    if (!Array.isArray(m.skills)) return { ok: false, error: `"skills" 必须是数组` };
    for (const [i, v] of m.skills.entries()) {
      const vv = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
      if (typeof vv.dir !== "string" || !SEGMENT.test(vv.dir) || typeof vv.name !== "string" || !SEGMENT.test(vv.name)) {
        return { ok: false, error: `skills[${i}] 要写成 { "dir": "skill", "name": "my-skill" }，都不能带路径` };
      }
      skills.push({ dir: vv.dir, name: vv.name });
    }
  }

  return {
    ok: true,
    warnings,
    manifest: {
      id,
      name: (m.name as string).trim(),
      version: (m.version as string).trim(),
      apiVersion: (m.apiVersion as string).trim(),
      author: str(m.author) ? m.author : undefined,
      description: str(m.description) ? m.description : undefined,
      main: str(m.main) ? m.main : undefined,
      views,
      permissions,
      skills: skills.length ? skills : undefined,
    },
  };
}
