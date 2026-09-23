---
name: xiaohongshu-reference
description: Use when 需要通过本地 xpzouying/xiaohongshu-mcp 只读检索小红书高赞图文参考、读取详情、下载公开参考图并保存可审核清单，尤其用于仿真人角色服装、妆发和抽象五官审美参考。
---

# 小红书只读参考检索

本 skill 仅在用户明确另选小红书、已自行配置合法运行时并提供且确认当前账号归属的独立 endpoint 时可用。默认短剧流程使用用户本地参考图，不依赖本 skill。此处只负责登录状态检查、公开笔记检索、详情读取、参考图下载和安全落盘，不安装或启动服务，不决定角色重要性，不生成图片。

## 只读边界

包装器只允许 `check_login_status`、`search_feeds` 和 `get_feed_detail`。禁止发布、编辑、删除、评论、回复、点赞、收藏及取消操作。即使上游 MCP 暴露这些工具，也不得绕过包装器调用。

用户负责隔离运行时、Cookie 和账号；不能把端口健康视为归属证明。未明确提供 endpoint 时暂停，不使用客户端默认 18060 地址或借用旧 Cookie。项目产物不得保存 Cookie、`xsec_token`、MCP session ID、请求头、Authorization 或登录二维码。可保存公开笔记 ID、来源链接、公开作者名、发布时间、互动数、图片 URL、本地路径、查询条件和审核状态。

## 使用流程

以下命令从本技能实际目录运行；需要 Windows amd64、PowerShell 和 Python 3.11+。

1. 完整阅读 [使用契约](references/usage-contract.md)。
2. 确认用户主动选择本渠道，并给出合法、独立、当前账号的 endpoint；缺一就暂停。
3. 运行 `python -B scripts/xhs_reference_search.py --endpoint <用户确认的端点> status`，后续 search 同样显式传 endpoint。
4. 返回 `login_required` 时暂停，请用户在其自行管理的运行时完成登录。不得运行旧安装/启动 helper 或代处理凭据；这些源脚本不属于产品支持的生命周期管理。
5. 用调用方提供的主体 ID、标签和 2–3 个查询执行 `search`。默认筛选“最多点赞、图文、半年内”。
6. 下载 3–6 个互补候选，写入调用方项目的 `asset_style_references.json`，初始状态只能是 `pending_review`。
7. 由调用方 Agent 审核并决定采用/淘汰。本 skill 不得自行把 `style_reference_status` 改成 `approved`。

搜索结果为空、未登录、超时或下载失败时必须返回真实状态，不得伪造候选，也不得切换到发布类接口。

## 上游源码

运行时固定使用 `xpzouying/xiaohongshu-mcp` v2.2.6 发布包，并按清单校验文件大小和 SHA-256。仓库根目录用户准备的 `xiaohongshu-mcp-main/` 仅作为上游源码审计和将来构建备用，不是运行时硬依赖，也不复制进本 skill。

上游采用 Apache-2.0，许可证副本见 [LICENSE.xiaohongshu-mcp.txt](references/LICENSE.xiaohongshu-mcp.txt)。
