---
name: gantt-feishu
description: 把 Gantt（甘特图）飞书同步队列里的事项写入飞书多维表格：读表格字段，按字段含义智能填写、润色中英文描述，逐条新建或更新记录，并把同步结果回写给 gantt。当用户说「把飞书队列同步到 <多维表格链接>」「把 gantt 里加入飞书的事项写到问题记录表」「用 gantt-feishu 同步」，或 gantt 的飞书插件在后台调用时使用。不适用：直接编辑飞书文档正文、gantt 里还没加入飞书同步队列的事项。
---

# gantt-feishu：把 gantt 事项写进飞书多维表格

数据从 `gantt feishu queue` 拿，写入**只走** `gantt feishu write`（它调用 lark-cli 并回写结果）。lark-cli 只用来读：表、字段、选项。
**不要**直接读写 queue.json，也不要碰 gantt.db。

lark-cli 一律带 `--as user`。字段值的写法以 lark-base 技能的 `references/lark-base-cell-value.md` 为准。

## 1. 确定目标表

- 后台调用：提示词里已经给了 `base-token` 和 `table-id`，直接用。
- 用户在对话里给了链接：
  - `/base/<token>?table=tblXXX` → base-token 是 `<token>`，table-id 是 `tblXXX`
  - `/wiki/<token>` → `lark-cli wiki +node-get --as user --node-token <token>`，取 `obj_type=bitable` 的 `obj_token` 当 base-token
  - 链接里没有 table：`lark-cli base +table-list --as user --base-token <base>` 列出来，**问用户**选哪张（后台运行时不许问，直接失败退出并说明）
- 用户只说了表名：`lark-cli drive +search --as user --query "<名称>" --doc-types bitable`，候选不唯一就问。

下面的 `<target>` 都写成 `<base-token>:<table-id>`。

## 2. 拿事项

```bash
gantt feishu queue --target <target> --json            # 全部
gantt feishu queue --target <target> --pending --json  # 只要还没同步/有变更/失败的（用户没指定时默认用这个）
gantt feishu queue --target <target> --keys note:3,risk:7 --json   # 指定几条（后台调用会给 keys）
```

输出里：`items[]` 是要写的事项，`rules.global` / `rules.table` 是用户补充的规则，`today` 是今天。
每条的 `recordId` 有值 = 之前写过 → **更新**那一条，不要新建。`deleted: true` 的跳过（源事项已删除），除非用户明确要求。

## 3. 读表结构

```bash
lark-cli base +field-list --as user --base-token <base> --table-id <table>
```

记下每个字段的名字、类型、单选/多选的现有选项。只读字段（公式、查找引用、自动编号、创建时间等）不写。

## 4. 逐条填写

按 [references/fill-rules.md](references/fill-rules.md) 把一条事项变成一行记录的字段值。
核心只有一条：**把事项的信息和表的字段按含义一一对上，对不上的字段直接忽略**（不写、不清空、不编造）。
用户为这张表写的规则 `rules.table` 优先级最高，其次 `rules.global`。

然后**只用这一个命令写入**：

```bash
gantt feishu write <key> --target <target> --fields '<字段 JSON>' --json
```

它自己决定新建还是更新：这条事项在这张表上建过记录就更新那一条，没建过就新建，并把结果记进队列。
不用、也不能自己传 record id；值为空的字段会被丢掉。不确定时先加 `--dry-run` 看它要做什么。

某一条失败（字段类型不对、权限不足……）：能改正就改正重试一次；还不行就

```bash
gantt feishu mark-failed <key> --target <target> --error "<一句话原因>"
```

然后继续下一条，不要整批停下。一次一条串行写，不要并发。

## 安全红线

- **绝不删除**任何记录、数据表、字段、视图、文档 —— 用户要求也不在这个技能里做，让用户自己在飞书里删。
- **绝不直接调用** `lark-cli base +record-upsert / +record-batch-*`：绕过 `gantt feishu write` 就绕过了「只改自己那条」的保护。
- **不改表结构**：不建字段、不改字段、不新增单选选项（选不到合适的已有选项就忽略这个字段）。
- 不手动 `gantt feishu mark-synced`：record id 记错，以后的更新就会改到别人的记录上。

## 5. 汇总

最后用一两句话说：写了几条（新建几条、更新几条）、失败几条及原因、哪些字段因为没有依据留空了。

## 出错时

- `need_user_authorization` / 缺 scope：把错误里的 `hint` 原样告诉用户（通常是 `lark-cli auth login --scope "..."`），本批全部 mark-failed，原因写「飞书授权不足：<scope>」。
- `gantt feishu write` 报「另一个同步正在写飞书」：等几秒重试同一条，不要换别的方式写。
- 报「源事项已在 gantt 里删除」：跳过这条，汇总时说明。
- `gantt feishu queue` 报「没有某个 key」：说明用户没在 gantt 事项页把它加入飞书同步。
