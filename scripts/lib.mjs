// 打包脚本共用的部分：哪些文件进包、怎么把一个插件目录打成 zip。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import { zipSync } from "fflate";

export const REPO = "anxelswanz/supergantt-plugins";
export const PLUGINS_DIR = new URL("../plugins/", import.meta.url).pathname;

/**
 * 不进包的文件。和宿主 plugin_host.rs 的 skip_on_install 是同一套规则：
 * 测试、插件运行时数据（data/）、隐藏文件。宿主那边还会再挡一次。
 */
export function skip(name) {
  return name.startsWith(".") || name === "data" || /\.test\.[cm]?[jt]sx?$/.test(name);
}

export function pluginIds() {
  return readdirSync(PLUGINS_DIR)
    .filter((d) => !d.startsWith(".") && statSync(join(PLUGINS_DIR, d)).isDirectory())
    .sort();
}

export function readManifest(id) {
  return JSON.parse(readFileSync(join(PLUGINS_DIR, id, "manifest.json"), "utf8"));
}

export const tagOf = (id, version) => `${id}-v${version}`;
export const assetOf = (id, version) => `${id}-${version}.zip`;
export const urlOf = (id, version) =>
  `https://github.com/${REPO}/releases/download/${tagOf(id, version)}/${assetOf(id, version)}`;

function collect(root, dir, out) {
  for (const name of readdirSync(dir).sort()) {
    if (skip(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collect(root, full, out);
    else out[relative(root, full).split(sep).join("/")] = [readFileSync(full), { mtime: ZIP_EPOCH }];
  }
  return out;
}

/** 固定时间戳：同样的源码打出同样的字节，sha256 才有意义 */
const ZIP_EPOCH = new Date("2000-01-01T00:00:00Z");

/** 打包一个插件。zip 里不带外层目录：根上直接是 manifest.json */
export function packPlugin(id) {
  const root = join(PLUGINS_DIR, id);
  const files = collect(root, root, {});
  if (!files["manifest.json"]) throw new Error(`${id}：没有 manifest.json`);
  const bytes = zipSync(files, { level: 9 });
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), files: Object.keys(files) };
}
