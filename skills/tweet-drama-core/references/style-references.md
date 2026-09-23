# 用户参考图与生图前检查

默认请用户提供有权使用的本地服装、妆发或抽象审美参考。没有图片时暂停重要角色并询问，不自动安装或启动浏览器。正式资产复用仍走既有远端身份核验，不为满足参考流程重复收费生成。

从 `tweet-drama-core` 实际目录执行：

```powershell
python -B scripts/style_references.py <project> <role_id> import --name <角色名> --role-class lead --image <本地图片路径>
python -B scripts/style_references.py <project> <role_id> check
```

`--image` 可重复。导入复用现有 `asset_image_import` 的图片校验与 PNG 归档，路径在项目 `assets/character/reference_<hash>.png`，不改用户原图。既有 `asset_style_references.json` 保留其他角色，本角色重新导入会重置为 `pending_review`。`note_id=local-<归档图片SHA256>` 绑定实际字节，`title` 保留用户文件名，空 `source_url` 不冒充网络来源。总控串行更新该清单，不并发写入。

Agent 必须读取每张实际图片，逐候选写既有字段：`review_status=approved` 或 `rejected`、具体 `review_reason`、`extracted_visual_elements`（非空文字值，说明采用元素和不继承元素）。不能只因图片解码成功就填 approved。向用户展示选用图片和提炼结果，得到当前用户明确确认后，在角色的 `review_reason` 记录确认内容及可追溯的对话位置，再写 `style_reference_status=approved`。没有确认不得填造记录；无需建立另一份批准数据库。

收费生图前逐角色运行 `check`。它拒绝空批准、缺图片、路径越界、未完成逐图审核、缺确认记录及本地图片字节变化，不进行视觉审核、不验证自然语言证据真伪、不授权付费。资产清单的 `style_reference_ids` 引用采用候选的 `note_id`；生成时只上传这些候选的已审核本地图。引用关系与当前用户确认由总控核对。此检查是技能工作流前置，不是 `jubian_video` 工具内的付费执行拦截。

用户明确选择并自行准备合法小红书运行时及独立账号端点时，可消费其既有候选格式，同样逐图审核和用户确认后再检查。不得把缺图变成自动联网检索，亦不得以旧服务健康响应冒充当前账号归属。生成后的视觉审核、正式资产身份回查和确认出演保持独立且必需。
