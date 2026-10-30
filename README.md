# SuperGantt 插件

SuperGantt 的官方插件。应用安装包里不带插件，用户在 **设置 → 插件** 里联网逐个下载。

| 插件 | 说明 |
|---|---|
| `daily-report` | 日报：按今天记下的问题和风险一键生成日报 |
| `fault-tree` | 故障树分析：把问题、阻碍拆到基本事件，推出成立的因果链 |
| `feishu-sync` | 飞书同步：把分拣好的事项同步到飞书多维表格 |

## 客户端怎么下载

1. 读 `https://raw.githubusercontent.com/anxelswanz/supergantt-plugins/main/index.json`
2. 每个插件只列最新版，带 `apiVersion`、权限、下载地址和 `sha256`
3. 下载 Release 上的 zip，校验 sha256，解压到插件目录（保留原来的 `data/`）

设置里可以填下载加速前缀（镜像）。因为有 sha256 校验，走镜像也不会装进被改过的包。

## 目录

```
plugins/<id>/      一个插件一个目录。目录名 = manifest 里的 id
  manifest.json    keywords 字段给市场搜索用
  README.md        市场详情页显示它（不进包，改了不用发新版）
  main.js          入口，单文件、不能 import（宿主从 Blob URL 加载）
  styles.css       可选，自动注入
  *.test.ts        测试，不进包
sdk/               宿主 manifest 校验器和类型的副本，测试和打包脚本用它
scripts/           打包、生成 index、同步 sdk
index.json         由 CI 生成，不要手改
```

## 开发

```sh
npm install
npm test
npm run pack feishu-sync   # 本地打个包看看里面有什么，产物在 dist/
```

在 SuperGantt 里试：**设置 → 插件 → 开发者模式 → 添加本地目录**，选 `plugins/<id>`。
改完点「重新加载」就生效，不用发布。

## 发布

改插件 `manifest.json` 里的 `version`，推到 `main`。GitHub Actions 会：

1. 跑测试，不过就停
2. 给版本号变了的插件打 zip（不含测试、`data/`、隐藏文件；打包可复现）
3. 建 Release，tag 是 `<id>-v<version>`
4. 更新 `index.json` 并提交回来

版本号不变就不会重发，已经发出去的包也不会重打。

## 宿主升级了插件接口之后

宿主（`anxelswanz/supergantt`）改了 `apiVersion` 或 manifest 规则后，同步一次 sdk：

```sh
npm run sync-sdk            # 默认从 ../gantt 读
npm run sync-sdk -- /path/to/supergantt
```

`sdk/` 里的文件都是同步出来的，不要手改。
