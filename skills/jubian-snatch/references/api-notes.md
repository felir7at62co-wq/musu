# 剧变抢本接口笔记

本文件只记实测到的形状与证据。所有请求都相对 `https://web.jubianai.net/prod-api`（前缀由连接池补，调用方不写）。

## 用到的接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/getInfo` | 身份：`user.userName`、`user.dept.deptName`、`permissions[]` |
| GET | `/script/center/pool/viewRole` | 账号在剧本池里的角色，`data` 是字符串：`prodlead`（制片组长）/ `prodmaker`（制作人）/ 组员类 |
| GET | `/script/center/pool/list?pageNum=1&pageSize=300[&status=<状态>]` | 池子列表；响应是 `{code,total,rows}`，**没有 `data` 包裹** |
| GET | `/script/center/pool/statusCount` | 分状态计数，`data` 是字典 |
| POST | `/script/center/pool/claim/{id}` | 组长认领（主路径） |
| POST | `/script/center/pool/memberClaim/{id}` | 组员认领（收到「只有制作组员可以认领」时按此再提交一次） |
| GET | `/aigc/script/list?pageNum=1&pageSize=1` | 自己名下的画布项目，看 `total` 即可 |

列表接口必须翻页读完：`pageSize` 只是服务端接受的每页行数上限，`total` 才是池子大小；只读第一页会把「池子比一页大」变成静默漏本（`api.read_pool` 用 `complete=False` 表示没读完）。

## 池子行里实测出现过的字段

`id`、`scriptName`、`manuscriptName`、`originalNovelName`、`versionNo`、`manuscriptType`、`status`、`canClaim`、`episodeCount`、`scriptFormat`、`editorType`、`producerType`、`isUrgent`、`bizPhase`、`hasCopyright`、`copyrightOwner`、`genreTagIds/genreTagNames`、`eraTagIds/eraTagNames`、`audienceTagIds/audienceTagNames`、`createUserId`、`createBy`、`writerName`、`writerDeptName`、`sendbackCount`、`lastSendbackTime`、`lastSubmitTime`、`publishTime`、`createTime`、`claimLeaderId/claimLeaderName/claimLeaderDeptName/claimLeaderTime`、`claimMemberId/claimMemberName/claimMemberTime`、`claimDeptId/claimDeptName`、`assignLeaderId/assignLeaderName`、`enterpriseId`、`companyId`、`mainDeptId`、`secondDeptId`、`holderPostCode`、`canCancelClaim`、`canShare`、`sharedToMe`、`canCancelPublish`、`canRecallAudit`、`canRecallRelease`。

判定只用两组：`canClaim`（服务端说这本你这个账号能领）与 `claimLeaderName` / `claimMemberName`（回读归属）。

## 状态名

池子行里实测出现过：`pending_leader_claim`、`pending_member_claim`、`pending_lead_claim`、`pending_distribute`、`claimed`、`in_production`、`maker_holding`、`produce_finished`、`returned`。

`statusCount` 用的却是另一套名字，和行里的对不齐（2026-09-20 实测）：

```json
{"pending_claim": 17, "total": 166, "pending_produce_claim": 4, "claimed": 75,
 "produce_finished": 32, "pending_publish": 0, "returned": 18, "in_production": 24}
```

所以候选判据是 `canClaim`，**不拿状态名当判据**：状态名只用来缩小轮询响应（`config.CLAIMABLE_STATUSES` 是唯一来源，组长那一档两种写法都轮询），外加每 20 轮一次完整池子扫描兜底。`pending_lead_claim` / `pending_claim` / `pending_produce_claim` 的语义至今未验证。

## 认领响应

```json
{"code": 200, "msg": "认领成功", "data": 859}
```

批次里 12 笔回的是 `msg: "操作成功"`。两类都算成功（`code` ∈ {0, 200}）。权限不足回 HTTP 200 + `code: 401`，或 `msg` 含「只有制作组员」「只有制片组长」「无权限」「权限不足」「认证失败」。

**没有答复就是「结果未知」**：连接中断、超时、响应不是 JSON，都意味着那次请求可能已经在服务端生效。写路径一次都不自动重试，由本地账本记录（`snatcher/ledger.py`）：已确认与结果未知的本都不再重发。

## 回读归属

认领之后，池子里那一行才是证据：

| 观察 | 结论 |
|---|---|
| `claimLeaderName`（或 `claimMemberName`）等于你的用户名 | 持有 |
| `canClaim` 又变成可领，或 `status=returned` | 没持有（被退回 / 被释放） |
| 这一行不在当前页里 | **不能下结论**：退回、被释放、被别人领走都会让它消失；读不全也一样 |

`api.classify_ownership` 就是这张表；只有第一种算「认领成功」。

## 2026-09-20 实抢证据

- 18:30:24.617 起，12 本新本在 **213ms 内**全部被识别；12 路并发提交，单笔请求 201–343ms，**发现→抢到 429–523ms**，全部成功。
- 18:30:40 复核：12/12 `status=pending_distribute`、`claimLeaderName=杨礼楷`、`sendbackCount=0`。
- 18:31:40 独立回读：仍是 12/12 在名下；池子 total 166 → 178，`canClaim=1` 只剩 3 本（用户点名跳过的）。
- 抢到的 12 本：885 墙缝里的眼 / 884 天价猪圈：开局继承千万原浆 / 874 我靠哄睡成了侯府团宠 / 866 泥土里开出万丈荣光 / 851《执尺》/ 848 双生子的谎言 / 841《大局已定》/ 840《泥人指出黄金路》/ 838 拼车惊魂 / 712 狂龙出狱，医武通天 / 676 灰烬里飞出的金凤凰 / 617 暗访迷局。
- 退回样本：859《惊雷：落魄修鞋匠竟是首富》被认领成功后，用户于 18:13:02 在平台点了退回 → `status=returned`、`sendbackCount=2`、`claimLeaderName=null`、`canClaim=0`。**退回即不要，不重抢。**

## 延迟（同机同接口实测）

| 客户端 | 单请求 p50 |
|---|---|
| `http.client` 持久连接（本 skill 的 `snatcher/httpclient.py`，每线程一条） | **30ms** |
| 每次新建连接 | 185ms |
| `requests.Session` | 343ms |

## 前端证据来源

接口清单来自剧变前端 bundle 里的 axios 封装与探针文件（只读、离线复制，不随本包分发）。

## 未验证

- `memberClaim` 的**成功**分支（当时账号是 `prodlead`，只验证到组长路径与被拒分支）。
- 认领后的「分发给组员」及之后的所有阶段。
- 本包新增的账本、分页与回读判定全部由离线回归测试覆盖，**没有**用真实服务端验证过端到端认领。
