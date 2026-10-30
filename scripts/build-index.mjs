// 生成 index.json，并找出这次要发布的新版本。
//
//   npm run index（用 tsx 跑：要直接 import sdk/ 里的 TS 校验器）
//
// - 版本号没变、且那个版本的 tag 已经存在的插件：沿用 index.json 里原来那一条（url、sha256 不动 ——
//   已经发出去的包不重打，否则 sha 一变，正在下载的人校验会失败）
// - 版本号变了 / 新插件：打包进 dist/，写进 index.json，并在 dist/releases.txt
//   里记一行「tag 文件 标题」，交给 workflow 去建 Release
//
// index.json 里每个插件只有最新版。客户端拿它的 apiVersion 和自己比，
// 主版本对不上就提示升级应用（见宿主 src/plugins/manifest.ts）。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { validateManifest } from "../sdk/manifest.ts";
import { REPO, assetOf, packPlugin, pluginIds, readManifest, tagOf, urlOf } from "./lib.mjs";

const INDEX = "index.json";
const old = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, "utf8")) : { plugins: [] };
const oldById = new Map(old.plugins.map((p) => [p.id, p]));
/** 已经建过 Release 的版本。只看 index.json 不够：上一次可能写了 index 却没建成 Release */
const tags = new Set(
  execFileSync("git", ["tag", "--list"], { encoding: "utf8" }).split("\n").filter(Boolean),
);

mkdirSync("dist", { recursive: true });
const releases = [];
const plugins = [];

for (const id of pluginIds()) {
  const raw = readFileSync(new URL(`../plugins/${id}/manifest.json`, import.meta.url), "utf8");
  const v = validateManifest(raw, id);
  if (!v.ok) throw new Error(`${id}：manifest 不合格 —— ${v.error}`);
  const m = readManifest(id);

  const prev = oldById.get(id);
  let download =
    prev?.version === m.version && tags.has(tagOf(id, m.version)) ? prev.download : null;
  if (!download) {
    const { bytes, sha256 } = packPlugin(id);
    const asset = assetOf(id, m.version);
    writeFileSync(`dist/${asset}`, bytes);
    releases.push(`${tagOf(id, m.version)} dist/${asset} ${m.name} v${m.version}`);
    download = { url: urlOf(id, m.version), sha256, size: bytes.length };
  }

  plugins.push({
    id,
    name: m.name,
    version: m.version,
    apiVersion: m.apiVersion,
    author: m.author,
    description: m.description,
    keywords: Array.isArray(m.keywords) ? m.keywords : [],
    // 市场详情页显示它。跟着仓库走，不跟着版本：改说明不用发新版
    readme: existsSync(`plugins/${id}/README.md`) ? readFileSync(`plugins/${id}/README.md`, "utf8") : "",
    permissions: m.permissions ?? {},
    skills: (m.skills ?? []).map((s) => s.name),
    download,
  });
}

const changed =
  releases.length > 0 || JSON.stringify(plugins) !== JSON.stringify(old.plugins);
const index = {
  schema: 1,
  repo: REPO,
  updatedAt: changed ? new Date().toISOString() : (old.updatedAt ?? new Date().toISOString()),
  plugins,
};
writeFileSync(INDEX, JSON.stringify(index, null, 2) + "\n");
writeFileSync("dist/releases.txt", releases.join("\n") + (releases.length ? "\n" : ""));
console.log(releases.length ? `要发布：\n${releases.join("\n")}` : "没有新版本");
