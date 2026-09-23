---
name: tweet-drama-shot-asset-match
description: 仿真人镜头与剧变正式资产匹配。逐镜头绑定确认出演的人物服装版本、场景和道具，输出带 Jubian asset/material ID 与 URL 的 matched JSON。
---

# 镜头正式资产匹配

镜头设计与资产选择是一个逻辑阶段。写每镜时就从当前剧变项目“主体设定”的实时父资产中确定角色服装版本、场景状态和关键道具，禁止从本地候选目录、旧分镜、历史视频或名字相似项猜图。

每个绑定至少包含正式名、类型、适用集和场、视觉提示词、数字 `jubian_asset_id/materialAssetId`、剧变 URL、`official=true` 和主体设定实时详情证据。生成资产还必须包含 `jubian_material_id`、确认时间和确认出演响应；`isLocal=1` 的主体设定直接上传资产可以没有生成 material ID，但必须属于同一 `scriptId`、`delFlag=0` 且实时父资产 URL 有效。

matched JSON 只能记录主体设定当前版本；分镜中的 `materialAssetId`、`assetId`、URL、名称/缩略图和提示词映射必须共同指向该版本。生成资产的字符串 `assetId=asset-...` 不得当作父资产查询 ID。

候选图、仅自动审核通过的生成图、缺确认响应的生成图一律拒绝。人物必须选择当前场次正确服装和阶段；场景、道具必须符合当前时空。同一镜头引用顺序必须和视频提示词中的人物映射一致。出现新旧字段混合、已删除资产或缺少核心资产时，回到主体设定重新选择或资产生成与确认出演，不得用相似图顶替。
