---
name: tweet-drama-core
description: 仿真人剧变流水线公共能力：项目结构、唯一状态、资产 manifest、正式资产门禁、镜头与视频清单校验、日志和断点续跑。
---

# 仿真人流水线 Core

pipeline_state.json 是唯一流程状态源，assets_manifest.json、matches 和 video manifest 是业务产物。所有状态原子写入；并行分片由总控统一合并。上游输入变化时只把受影响下游标为 stale。

## 标准阶段

source、episodes、style、asset_prompts、asset_candidates、official_assets、shots_and_matches、video_tasks、reviewed_videos、draft、export。

## 谁写这个文件

从本技能实际目录执行下列命令；其他工作目录使用技能加载器给出的完整脚本路径，不假定个人安装副本的位置。

- `python -B scripts/pipeline_state.py <项目目录> sync` —— **产物投影**：按磁盘上的产物重算每个阶段（completed / review / pending），写 `status_source: "projection"`。**开工第一件事就是跑它**，把「现在在哪一阶段、哪几集走到哪」报出来再动手，不要凭记忆推进。
- `… set --stage <阶段> --status <状态>` —— **人工批注**：写 `status_source: "manual"`，此后 `sync` 只报告不覆盖，用来表达产物看不出来的事（预算、批准、已知缺口、阻塞）。
- 状态 = 产物投影 + 人工批注；手写自述必然腐烂，所以不要手改 JSON，也不要指望谁记得回写。
- 后段阶段（脚本匹配 / 生成 / 审片 / 草稿 / 成片）是**整部剧口径**：全部分集都走到才算 completed，否则是 review——否则「3/50 集交付」会被读成「整部已导出」。

## 资产硬字段

stable_id、type、name、aliases、episodes、prompt、review、review_attempts、max_review_attempts、jubian_asset_id、jubian_material_id、url、asset_confirmation、official。正式资产必须 official=true；非本地生成候选确认响应可追溯，本地正式主体使用总控规定的实时独立门禁证据，不伪造 material_id 或确认响应。

## 用户参考图

缺失重要角色资产的生图前置见[本地参考图流程](references/style-references.md)：默认接收用户图片，归档、逐图审核、记录用户确认后运行 `scripts/style_references.py <项目目录> <role_id> check`。缺图就询问并暂停，不自动搜索或启动小红书；空 approved 不构成证据。此流程不替代付费授权、生成资产视觉审核或确认出演。

## 视频禁用标签

`drama_video` 的 ban/unban/list/inspect 统一管理本项目 `video-bans.json`；ban 按实际文件 SHA256 标记具体版本，labels 至少一个自由可读标签（如“人物对调”），reason 可选，不要索取证据。同字节副本同样禁用；同路径换成不同字节不是旧版本。查标签、没有标签或 unban 都不等于审核通过，保留现有 hashreview 与 QA。标错用 unban；旧文件已替换时用 list 中旧 SHA256 解除，不删媒体、不删清单。

官方 Python render、draft、delivery 和状态投影通过 `scripts/video_bans.py` 只读检查同一清单，坏清单拒绝继续。状态人工批注保留，但必须同时看 projected 与 note 中的禁用标签；旧 completed 不覆盖禁用。禁止用通用 FFmpeg、项目手写脚本或直接复制绕过禁用；本门禁是项目范围的官方路径检查，不是对任意外部命令的拦截。无标签不证明历史成片没有使用旧禁用源，缺来源映射须核查实际母版。

## 校验

- 归一化本地路径和剧变 URL，不凭文件名猜资产。
- matched JSON 只引用正式资产。
- 1–4 秒、9 字/秒、36 字是节奏建议，超出记录警告并复核，不删除原文或改变说话人。
- 打包服从当前分镜和实时模型目录约束，包含收束；不覆盖项目已确认模型、分辨率或交付规格。
- 编辑输入须通过内容审核；pending 仅可作明确标注非最终的草稿/预览，由模型安排后续回读。最终选用文件必须 clean 或 not_required，并有对应实际文件的内容、字幕清理、分辨率与音画 QA；未知或失败不能放行。替换来源后重新审核。
- 续跑时先审计磁盘与远端 IDs，避免重复收费生成。
