# 小红书只读参考契约

本契约适用于通过公开小红书图文寻找视觉参考。调用方决定哪些主体需要检索；在仿真人短剧流水线中，通常由 `tweet-drama-asset-extract` 对 `lead` 和 `important_support` 发起请求。小红书只提供参考，剧变仍是唯一图片生成服务。

## 安装、登录与只读边界

默认使用用户本地图片，不需要小红书。只有用户主动另选本渠道并自行配置合法 v2.2.6 运行时、明确提供且确认当前账号归属的独立 endpoint 后才可使用。缺 endpoint、未登录或账号不明就暂停；不能连接默认 18060 猜测身份，不运行旧安装/启动 helper，不代处理 Cookie。源代码保留不等于这些 helper 已通过产品账号隔离验收。

```powershell
python -B scripts/xhs_reference_search.py --endpoint <用户确认的端点> status
```

上游 MCP 的 Apache-2.0 不覆盖其定制浏览器的再分发权利，产品不捆绑或自动下载该浏览器。

包装器硬性只允许 `check_login_status`、`search_feeds`、`get_feed_detail`。禁止发布、编辑、删除、评论、回复、点赞、收藏及其取消操作。

## 查询与筛选

从剧本提取身份、年龄、阶层、地域审美、场次和气质，每个重要角色写 2–3 个互补查询：身份穿搭、妆容、发型。禁止使用演员或博主姓名做身份复刻查询。

```powershell
python -B scripts/xhs_reference_search.py --endpoint <用户确认的端点> search `
  --role-id char_shen_zhiyi `
  --role-name 沈知意 `
  --role-class lead `
  --role-tag 年轻东亚女性 `
  --role-tag 豪门女总裁 `
  --role-tag 韩系妆造 `
  --query "韩系财阀千金穿搭" `
  --query "韩系女总裁妆造" `
  --project-dir <project> `
  --limit 6
```

客户端固定使用“最多点赞、图文、半年内”。Agent 从 3–6 个候选中审核：剧本身份与阶段、服装轮廓与材质、配色、妆发、可拍摄性、信息清晰度和候选差异性。高点赞但角色不匹配的结果必须淘汰。

## 提炼与使用

- 服装：提炼廓形、比例、面料、层次、配色和配饰，不复制 Logo 或独占图案。
- 妆发：提炼妆容浓淡、眉眼走势、唇色、发型结构和气质。
- 五官：只提炼抽象审美特征，不复制真人身份或要求一比一相同。
- 完整人物参考图必须明确哪些图只参考服装、哪些只参考妆发或抽象五官，以及不得继承的元素。
- 剧本中的年龄、职业、经济阶层、伤病、孕期、婚礼和服装连续性优先于平台潮流。

调用方 Agent 在 `asset_style_references.json` 为候选填写采用/淘汰原因和视觉元素。逐图审核并取得用户确认后，按 [本地参考图流程](../../tweet-drama-core/references/style-references.md) 记录确认依据、检查证据，再把采用的本地参考图交给剧变 `gpt-image-2`。本 skill 输出时只能写 `pending_review`，检索成功不等于批准。

## 产物与安全

公开产物可保存笔记 ID、来源链接、标题、作者公开名、发布时间、点赞/收藏/评论数、图片 URL、本地路径、检索版本、输入哈希和审核证据。

禁止保存 Cookie、`xsec_token`、MCP session ID、请求头、Authorization 或登录二维码。已经成功且输入哈希未变的结果复用；未登录、超时或无合格结果时暂停该重要角色，禁止悄悄绕过门禁提交收费生图。

上游项目采用 Apache-2.0；许可证副本见 [LICENSE.xiaohongshu-mcp.txt](LICENSE.xiaohongshu-mcp.txt)。
