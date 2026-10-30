// 本地打包：node scripts/pack.mjs [id ...]，不给 id 就全部打。产物在 dist/。
// 只是给人看「这个包里有什么」用的，发布走 build-index.mjs。

import { mkdirSync, writeFileSync } from "node:fs";
import { assetOf, packPlugin, pluginIds, readManifest } from "./lib.mjs";

const ids = process.argv.slice(2).length ? process.argv.slice(2) : pluginIds();
mkdirSync("dist", { recursive: true });
for (const id of ids) {
  const { version } = readManifest(id);
  const { bytes, sha256, files } = packPlugin(id);
  writeFileSync(`dist/${assetOf(id, version)}`, bytes);
  console.log(`${assetOf(id, version)}  ${(bytes.length / 1024).toFixed(1)} KB  sha256 ${sha256}`);
  for (const f of files) console.log(`  ${f}`);
}
