// 从宿主仓库同步 sdk/。宿主改了 apiVersion 或 manifest 规则之后跑一次：
//
//   node scripts/sync-sdk.mjs [宿主仓库路径，默认 ../gantt]
//
// sdk/ 是宿主 src/plugins/{manifest,types}.ts 和 src/core/views.ts 的副本，
// 只改了一处 import 路径；外加从 gantt-core/src/feishu.rs 抽出来的
// SNAPSHOT_FIELDS（feishu-sync 的比较字段必须和它一字不差）。
// 不要手改 —— 改了下次同步就丢。

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const host = resolve(process.argv[2] ?? new URL("../../gantt", import.meta.url).pathname);
const files = [
  ["src/plugins/manifest.ts", "sdk/manifest.ts"],
  ["src/plugins/types.ts", "sdk/types.ts"],
  ["src/core/views.ts", "sdk/views.ts"],
];
for (const [from, to] of files) {
  const text = readFileSync(join(host, from), "utf8").replace('from "../core/views"', 'from "./views"');
  writeFileSync(new URL(`../${to}`, import.meta.url), text);
  console.log(`${from} → ${to}`);
}

const rs = readFileSync(join(host, "gantt-core/src/feishu.rs"), "utf8");
const block = /SNAPSHOT_FIELDS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rs);
if (!block) throw new Error("gantt-core/src/feishu.rs 里找不到 SNAPSHOT_FIELDS");
const fields = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
writeFileSync(
  new URL("../sdk/feishu-snapshot-fields.json", import.meta.url),
  JSON.stringify(fields, null, 2) + "\n",
);
console.log(`gantt-core/src/feishu.rs SNAPSHOT_FIELDS → sdk/feishu-snapshot-fields.json（${fields.length} 个）`);
