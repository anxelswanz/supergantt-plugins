# 填写规则

输入是 `gantt feishu queue --json` 的一条 item，输出是一行记录的字段 JSON。

## 唯一的原则：一一智能匹配，没提到的忽略

1. **先看表有哪些字段**（`+field-list` 的名字、类型、选项），再看这条事项有哪些信息（见下表）。
2. **按含义把两边对上**，一个飞书字段对一项事项信息。不看字段名是否字面一致：
   「问题描述」「Issue」「description」都是描述；「Owner」「负责人」「责任人」都是负责人。
3. **对得上的才写。** 飞书表里有、但事项里没有对应信息的字段 —— **直接忽略，不写、不清空、不编造**。
   事项里有、但表里没有对应字段的信息 —— 也忽略。
4. 写进去的值要符合字段类型（单选只用已有选项、人员字段要 open_id、日期写 `YYYY-MM-DD 00:00:00`……
   以 lark-base 技能的 `references/lark-base-cell-value.md` 为准）。类型对不上又没法转换的，忽略这个字段。
5. 文字类字段可以润色成通顺、专业的句子，但**只改表达，不加事实**。
6. **用户为这张表写的规则（`rules.table`）优先级最高**，和上面冲突时听用户的；`rules.global` 次之。

## 事项能提供的信息

| item 字段 | 含义 |
|---|---|
| `title` | 记录下来的那句话（唯一的正文） |
| `kindLabel` / `kind` / `source` | 类型：问题、代办、阻碍、风险、自定义类型 |
| `priority` | P0（最急）… P3；可能为 null |
| `riskLevel` | 风险的严重程度：高/中/低（只有风险有） |
| `owner.name` / `owner.feishuOpenId` / `owner.feishuName` | gantt 负责人 / 对应的飞书用户（在插件「人员对照」里配的，可能为 null） |
| `task.name` / `task.note` / `task.start` / `task.end` / `task.progress` | 关联的任务及其备注 |
| `project.name` | 所属项目 |
| `startDate` / `closeDate` / `lastingDays` | 记录日 / 关闭日 / 持续天数（已经算好，直接用） |
| `closed` / `resolution` | 是否关闭 / 关闭时写的结论（怎么解决的） |
| `analysis` | 可选：故障树附上的根因分析，见下一节 |

## 示例：一张问题记录表

下面只是**示例**，说明「按含义对上」大概长什么样。实际以目标表的字段和用户规则为准。

| 飞书字段 | 对上的事项信息 | 怎么写 |
|---|---|---|
| description | `title`（+ `task.name` 作背景） | 润色成「现象 + 影响」的一两句中文 |
| Description English | 同上 | 上一格的忠实英译 |
| Categorization | `kindLabel` | 单选：选最贴近的已有选项；没有贴近的就忽略 |
| status | `closed` | 关闭 → 「Closed/已解决」一类选项；否则 → 「Open/进行中」一类 |
| Priority | `priority`（风险可退而用 `riskLevel`） | P0 → 最高 … P3 → 最低，按选项档位就近映射 |
| Start Date | `startDate` | 日期 |
| Close Date | `closeDate` | 日期；未关闭 → 没有对应信息，忽略 |
| Lasting Date | `lastingDays` | 数字或「N 天」；字段若是日期类型 → 类型对不上，忽略 |
| 责任人 | `owner.feishuOpenId` | 人员字段 `[{"id": "<openId>"}]`；没有 openId → 忽略，**不要自己去通讯录猜** |
| Solution | `resolution` | 润色；没有结论 → 忽略 |
| Root Cause | （没有直接对应） | 只有 `resolution` / `task.note` 里**明确写了原因**才提炼；否则忽略 |

## 根因分析（`analysis`）

用故障树确认过解决方案的问题会带上 `analysis`，是比 `resolution` 更细的结构化信息：

| analysis 字段 | 含义 |
|---|---|
| `problem` | 顶事件：要解决的那个问题 |
| `rootCauses[].label` | 根因（可能有几个） |
| `rootCauses[].chain` | 从问题一路到这个根因的因果链，第一项是问题、最后一项是根因 |
| `rootCauses[].actions` | 针对这个根因的对策 |
| `solution` | 解决方案：全部根因的对策合在一起（为空表示「未制定」） |
| `steps` | 解决步骤 = 排查过程：树上每个事件一行，按层级缩进、编号（1. / 1.1），带验证结果和日期，例如 `1.1 图纸版本旧 — 已确认（根因） · 2026-10-22`。被排除的也在 |

`resolution` 里已经有这些内容合成的一段文字；有 `analysis` 时**以 `analysis` 为准**，按表的字段拆开：

1. **表里有对应的列就分开填**：根因 / 原因分析 / Root Cause ← `rootCauses[].label`；
   解决方案 / 措施 / 对策 / Solution ← `solution`；排查过程 / 处理过程 / 解决步骤 / Action Steps ← `steps`；
   因果链 / 分析过程 ← `rootCauses[].chain`（写成「A → B → C」）。
2. **没有对应的列就合并进最接近的那一列**。例如只有一个 Solution 列：写成
   「解决方案：…」+ 换行 +「根因：…」+ 换行 +「排查过程：」+ 步骤原样多行；只有描述列、没有任何原因或方案列：
   在描述末尾补一句「根因：…」。不要因为表里没有「根因」列就把根因丢掉 —— 这是用户点名要同步过去的信息。
3. `steps` **保留原来的编号、缩进、验证结果和日期**，不要改成别的格式，也不要删掉「已排除」的那几行 —— 它们就是排查过程。
   写进单行文本字段时用换行分开；字段不支持换行时用「；」连起来。
4. 多个根因用「；」分开。`solution` 为空时写「未制定」。
5. 单选 / 多选类型的「原因分类」列：只在根因明显属于某个已有选项时才选，否则忽略。
6. 同样只改表达、不加事实：可以把对策润色通顺，不要补出树上没有的步骤或原因。

## 更新已有记录时

只写这次对得上的字段。没写的字段飞书会保持原值 —— 那可能是别人在飞书上手动补的，不要动。
