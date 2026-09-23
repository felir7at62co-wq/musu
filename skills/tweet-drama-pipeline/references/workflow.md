# 仿真人流水线依赖映射

| stage | skill / 工具 | 核心检查 |
|---|---|---|
| source / episodes | tweet-drama-script-convert / tweet-drama-script-split | 原件归档、分集边界、缺漏字 |
| style / assets | tweet-drama-asset-extract | 先读实时主体设定，仅缺失资产需提示词和生成 |
| asset_candidates | jubian_video image_generate | 成功 IDs 与审核证据；本地正式主体可按门禁跳过 |
| official_assets | tweet-drama-asset-vision-check / jubian_asset | 非本地 material_id + 确认出演回查；本地主体独立门禁 |
| shots_and_matches | shot-script-creator-9-16 / tweet-drama-shot-asset-match | 原文、说话人、发声方式、正式资产身份；节奏建议仅警告 |
| video_tasks | tweet-drama-early-shot-script / jubian_storyboard | 当前分镜和实时目录约束，包含收束；授权内自检后提交 |
| reviewed_videos | jubian_video subtasks / jubian_storyboard erase_subtitle | 实际选用视频内容 QA；最终仅 clean/not_required |
| draft | tweet-drama-draft-build | pending 仅非最终预览；实际发声字幕，不伪造完成 |
| export | tweet-drama-background-render | 最终 MP4/SRT/草稿/来源映射、选曲计划与试听、实际输出 QA |

依赖就绪即可推进独立集或镜头，不要求整剧串行。模型自主安排异步任务后续查询，期间做独立工作。pending/unknown 查原 task ID，不盲目付费重投；确认失败后按根因、已花费用及剩余授权评估恢复。

主体视频路径保持有序：select_assets（免费 isGenerate=0）→ prepare_video（只读 preview）→ submit_video（一次 isGenerate=1 PUT，key=preview fingerprint）。授权范围内先核对项目、资产身份/顺序、规格、预计费用和已有任务，无需逐笔即时批准。禁止 direct POST 视频任务；提交后回读子项身份，丢失即暂停诊断。

非本地候选需 material_id、confirm_casting 成功和父资产回查一致；isLocal=1 正式主体须当前项目、isUsed=1、hsAssetStatus=Active、URL/hsAssetId 与父资产及 picker 一致。跳过生成链经唯一 writer 的合法阶段写 skipped、reason=skipped_with_official_local_evidence 和对应证据。
