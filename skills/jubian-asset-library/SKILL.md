---
name: jubian-asset-library
description: Use when 新剧本需要角色、场景或道具，想在生图之前先从 56 个历史剧变项目的 8100 条资产里找现成的复用，包括按风格/类型/服装/地点检索、看本地图、判断可否复用。
---

# 剧变资产库（历史资产复用）

新剧本要角色、场景、道具时，**先来这里找，再决定要不要重新生成**：库里已有 56 个历史剧变项目的 8100 条父资产，其中 2615 条带视觉标签、2783 张图已下载到本地。找到合适的就省一次生成和一次审核；找不到再走正常生成。

**本技能只读**：不写远端、不改库、不碰 token。正式采用仍然要经过当前项目自己的「生成 → 视觉审核 → 确认出演」门禁。

## 数据根

默认 `$DSH_HOME/data/jubian-asset-library`（未设 DSH_HOME 时用 `~/.dsh`），可用环境变量 `JUBIAN_ASSET_LIBRARY_ROOT` 覆盖。资源包不带用户资产；下表规模是来源库的历史记录，不代表安装后已有数据。已有 `tags.local_path` 保留原值，迁库须另行受控处理。

| 路径 | 内容 | 实测规模 |
|---|---|---|
| `index/projects.json` | 历史项目清单：`script_id`、`name`、`style_label`(realistic/3d)、`episode_count` | **56 个项目** |
| `index/assets.jsonl` | 父资产元数据：`asset_id`、`script_id`、`project_name`、`style_label`、`asset_name`、`asset_type`、`url`、`is_local` 等 | **8100 行** |
| `index/tags.jsonl` | 视觉标签（视觉模型逐张分析的结果） | **2615 行** |
| `media/` | 已下载的图，文件名 `a{asset_id}.{ext}` | **2783 个文件** |
| `index/sample-list.jsonl`、`index/sample-manifest.jsonl` | 抽样清单与下载记录 | 各 300 行 |
| `index/inventory-report.md` | 库存统计 | — |

## 怎么搜

```powershell
# 在本技能目录执行；其他工作目录用技能加载器返回的完整脚本路径
python scripts/search_assets.py --style realistic --type character --q "西装 总裁" --prefer-project 2708 --limit 10
```

| 参数 | 取值 | 说明 |
|---|---|---|
| `--style` | `realistic` / `3d` / `all` | **先按目标项目的风格过滤**：真人短剧用 `realistic`，混风格会在成片审核阶段失败 |
| `--type` | `character` / `scene` / `prop` / `all` | |
| `--q` | 自由文本 | 匹配资产名、标签、身份、服装、地点与提示词摘要 |
| `--prefer-project` | 项目名或 `script_id`（如 `2708`、`山海`） | 命中同剧/同项目的候选会被加权 |
| `--gender` | `male` / `female` / `mixed` / `none` | 只对有标签的行生效 |
| `--age` | `child` / `teen` / `young` / `middle` / `senior` / `unknown` | 同上 |
| `--reusable` | `true` / `false` / `all` / `prefer`（默认 `prefer`） | `prefer` 是加权不是硬过滤 |
| `--avoid-text` | 开关 | 惩罚 `has_text=true` 的候选（画面里有可读文字） |
| `--require-local` | 开关 | 只返回本地已有图的候选 |
| `--limit` | 整数，默认 10 | |
| `--json` | 开关 | 输出 JSON 而不是表格 |

输出字段：`asset_id`、`project`、`style`、`type`、`name`、`gender`、`age`、`identity`、`clothing`/`place`/`prop_category`、`reusable`、`tags`、`local_path`、`url`、`score`。

## 标签口径

`index/tags.jsonl` 每行的 `tags` 是一个对象：

| 字段 | 取值 | 实测分布 |
|---|---|---|
| `style` | `realistic` / `3d` | 1846 / 769 |
| `type` | `character` / `scene` / `prop` | 1180 / 867 / 568 |
| `gender` | `male` / `female` / `mixed` / `none` | 767 / 381 / 73 / 1372 |
| `age_group` | `child` / `teen` / `young` / `middle` / `senior` / `unknown` | 45 / 9 / 667 / 382 / 106 / 1376 |
| `scene_kind` | `indoor` / `outdoor` / `none` | 549 / 346 / 1720 |
| `clothing`、`identity_hint`、`place_hint`、`prop_category` | 自由文本 | — |
| `has_text` / `text_content` | 画面里是否有可读文字 | 720 条为 true |
| `reusable` | 构图完整、无水印、身份清楚 | 2522 true / 93 false |
| `quality_note` | 视觉模型给的说明 | — |
| `tags` | 3–6 个中文检索标签 | 如「灰色西装、黑衬衫、白底」 |

**人物优先按名字找**：历史资产名里常常直接写着角色名（例如 `陆沉舟｜年轻曜石董事长装`）。先 `--q "角色名"`，再用性别、年龄、服装做二次过滤。

## 推荐流程（新剧本）

1. 从剧本抽出需求：角色（性别/年龄/身份/服装）、场景（内外/地点）、道具（类别/是否需要文字）。
2. 逐个需求跑 `search_assets.py`；`--style` 与目标项目一致；目标剧已在库里时加 `--prefer-project <script_id 或剧名>`。
3. 看候选：有 `local_path` 就直接看本地图（用你自己的看图工具，不要把图塞进上下文），没有就看 `url`；同时看 `reusable`、`has_text`、`quality_note`。
4. 每个需求给用户 **3–5 个候选**（资产名 + 来源项目），由用户挑——不要替用户决定。
5. 用户选中后，在当前项目里的采用路径：
   - 取该资产的图（`local_path`，或用 `jubian_media download` 把 `url` 落到本地）；
   - 在**当前项目**里把它当参考图用：`jubian_asset upload_reference` 换成 HTTPS URL，再交给生图；
   - 生成的图仍要走「`tweet-drama-asset-vision-check` 审核 → `jubian_asset confirm_casting` 确认出演 → 写 manifest `official=true`」。
6. 找不到合适的 → 回到 `tweet-drama-asset-extract` 正常写提示词、正常生成。

## 硬性规则

1. **只读**：任何时候都不要用本技能写、删或改剧变远端状态。
2. **检索不碰凭据**：只读本地 JSON/JSONL 与图片，不读取任何 env 文件或 Jubian token。维护脚本仅接受显式 `DEEPSEEK_API_KEY` 环境变量，这是视觉标注 key；缺失立即失败，不打印 key。
3. **先按风格过滤**：`realistic` 与 `3d` 不混用。
4. **命中 ≠ 采用**：检索到候选不等于已经采用，必须走当前项目的审核与确认出演。
5. **优先 `reusable=true`**，并检查 `quality_note` 与 `has_text`。
6. **不复制真人身份**：历史图只能用于提炼服化道与抽象五官审美，不得一比一复刻五官、不得复制品牌 Logo——与 `tweet-drama-asset-extract` 同一口径。

## 局限

- 标签只覆盖 2615 / 8100 条资产，其余只能按名字、提示词、类型检索。补标签用 `scripts/batch_tag_all.py`、`scripts/download_and_tag_project.py`（会下载图片并付费调用视觉模型，必须取得维护授权，不属于只读检索；禁止用真实 API 作迁移测试）。
- `identity_hint` 是视觉模型对图的猜测，**不是**剧本级的角色绑定；认角色优先看 `asset_name`。
- **跨项目是「参考图复用」，不是搬运**：当前剧变插件没有「导入其它项目资产」的方法（`asset.collect_existing` 那套 MUSE 工具已退役，不要再找它）。若这条影响使用，值得给插件补一个跨项目资产引用方法。
- 本地图单张可能几 MB，不要把大图内联进提示词或上下文。

## 相关技能

| 需求 | 用哪个 |
|---|---|
| 复用历史资产（本技能） | `jubian-asset-library` |
| 新写资产提示词 | `tweet-drama-asset-extract` |
| 生成后的视觉审核 | `tweet-drama-asset-vision-check` |
| 镜头绑定正式资产 | `tweet-drama-shot-asset-match` |
