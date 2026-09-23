---
name: jubian-snatch
description: Use when 需要看剧变剧本池现在有多少本、哪些能领，或在指定时刻盯着新放出的剧本并第一时间抢下来（抢本/一键抢光），包括定时轮询、批量认领与抢后复核。
---

# 剧变抢本

剧变的「剧本池」不定时放本，服务端在每一行上给一个 `canClaim` 字段：**只有它标为可领的，才是你这个账号能领的那本**。本 skill 只提交服务端标为可领的剧本；候选为空就什么都不做。

**认领是对远端的真实写操作**：认领成功这本就归你的账号并进入你的待分发，撤回要走平台流程。所以这里的每条路径都是 fail-closed 的——不确定就不提交。

## 硬事实（别重新推导，都是实测）

- 基址 `https://web.jubianai.net/prod-api`。`PATH_*` 都相对它，**`/prod-api` 前缀必须带**：裸路径返回的是 HTTP 200 + 30444 字节的单页应用首页 HTML，只检查状态码的实现会「成功」却什么都没做。调用方不得手写该前缀（连接池统一补，写了会变成 `/prod-api/prod-api`）。
- envelope 两种形状都要吃：单对象 `{code,msg,data}`、列表 `{code,total,rows}`。
- 认证失败是 **HTTP 200 + `code:401`**，不是 HTTP 401。
- token 是服务端会话键，JWT payload 只有 `login_user_key`，**没有 `exp`**；平台重新登录会吊销旧 token。所以窗口期别登录剧变网页版。
- token 来源统一由 `snatcher.config.prefill_token()` 解析：`JUBIANAI_ADMIN_TOKEN` 环境变量 > 用户显式设置的兼容变量 `JUBIAN_TOKEN` > 当前 Harness home 的 `.credentials.yaml` 中的 `JUBIANAI_ADMIN_TOKEN`。非空 `DSH_HOME` 是唯一 home，缺文件、缺值或损坏都不得回退另一账户的 `~/.dsh`；仅未设置或为空时使用 `~/.dsh`。不自动读取 `.credentials-alt.yaml` 或 `jubian/token/alt`，CLI 不覆盖共享解析器的路径。
- `viewRole` 决定认领路径：`prodlead`（制片组长）走 `POST /script/center/pool/claim/{id}`；组员走 `POST /script/center/pool/memberClaim/{id}`。组长入口被拒且 `msg` 含「只有制作组员」时，按组员路径再提交一次——这是第二次真实请求，只有在服务端明确答复「刚才那次没有发生」之后才允许。
- 池子比一页大：一页 `pageSize` 默认 300，读取必须翻页读完（`api.read_pool`）；翻到页数上限还没读完就如实标记 `complete=False`，不能当成「池子就这些本」。
- 状态机：`pending_leader_claim` / `pending_lead_claim` / `pending_member_claim`（等认领）→ 认领成功 → `pending_distribute`（等你分发，`claimLeaderName` 变成你）→ `returned`（被退回，`sendbackCount` +1）。**状态名只用来缩小轮询响应，候选判据始终是 `canClaim`**；组长那一档两种写法都出现过，`config.CLAIMABLE_STATUSES` 是唯一来源。**退回不重抢**。

## 三道 fail-closed 闸门

1. **基线**：启动时先读完整池子，把「开始时已经可领的本」记下来不再碰。基线读失败、读不全，或服务端用 envelope 拒绝，脚本一律退出码 2，并且**一个认领请求都不发**。退化成「空基线」等于把认领范围放大到本来就摆在那里的本。
2. **账本**（`snatch-claims.ndjson`，默认在当前工作目录，`--ledger` 可改）：每本在请求发出**之前**写一条 intent，拿到答复后写一条 settle。只有 intent 没有 settle 的记录就是「结果未知」——那次请求可能已经在服务端生效。**已到手（accepted）与结果未知（unknown）的本都不会再发第二次**；只有服务端明确答复「这次没有发生」（rejected，例如系统繁忙）才允许重试。进程被杀、宿主重启都不影响：重新起跑读的是同一个账本。账本读不懂（有坏行）时同样拒绝提交。
3. **回读**：认领后 15 秒回读池子，只有行里写着你的名字（`claimLeaderName` / `claimMemberName`）才算「持有」。**从池子里消失不是认领成功的证据**——退回、被释放、被别人领走都会让它消失；回读读不全就什么都不下结论，下一轮再读。

## 两个脚本

都在本 skill 的 `scripts/` 下，引擎 `scripts/snatcher/`（config / httpclient / api / claimer / ledger）靠 `sys.path[0]` 解析，因此**在 `scripts/` 目录里运行**（Python 3.11 或更新）：

```bat
cd scripts
python check_pool_live.py                 :: 只读体检
python check_pool_live.py --claim 859     :: 对某个 canClaim 为可领的 id 试抢一次（真实写操作）
python check_pool_live.py --dump pool.json

python snatch_batch.py --start 18:25 --burst 18:29:30 --end 19:00 --skip 859 --log snatch.log
```

`--claim` 没有旁路：池子里没有这本、池子没读完、或 `canClaim` 不是可领，都会被拒绝且不发请求；账本里已有记录也不会再发。

| 参数 | 作用 |
|---|---|
| `--start HH:MM[:SS]` | 从该时刻起 0.25 秒/轮；之前是 1.0 秒/轮的热身（保持连接热着，也能提前吃到早放的本） |
| `--burst HH:MM[:SS]` | 从该时刻起 0.12 秒/轮（≈400 次/分），持续 5 分钟后回落到 0.5 秒/轮 |
| `--end HH:MM[:SS]` | 收工时刻，写总结后退出 |
| `--concurrency N` | 并发认领线程数（默认 12，每个线程一条热连接） |
| `--skip 859,860` | 明确不碰的 id（开始时已可领的、用户点过退回的） |
| `--include-preexisting` | 连开始时就已经可领的旧本也抢（默认只抢新出现的） |
| `--dry-run` | 只走检测与派发，一个认领请求都不发（演练用） |
| `--ledger PATH` | 认领账本路径（默认 `./snatch-claims.ndjson`） |
| `--log PATH` | 日志路径，默认 `snatch-<YYYYMMDD>.log` |

`check_pool_live.py` 打印：身份（name / dept / viewRole / permissions 数）、`statusCount`、自己名下项目数、池子 `total` 与读到的行数（没读完会显式警告）、按状态分布、可领的 id 与剧名、等认领状态的 id。

`snatch_batch.py` 日志每行带毫秒时间戳即时落盘，关键行：`发现新可领本 id=…《…》→ 立即认领`、`认领成功 id=… 请求 Xms 发现→成功 Yms`、`!! 认领结果未知 id=…`、`跳过 id=…`、`复核 id=… 归属=held|unconfirmed|lost`，收工行给出「服务端确认认领 / 回读确认归属 / 结果未知 / 读取不完整」四个数。

## 速度（实测，2026-09-20）

- keep-alive 持久连接单请求 p50 **30ms**；每请求新建连接 185ms；`requests.Session` 343ms。抢本拼的就是「发现→提交」这段延迟，所以别用 requests 重写。
- 一次真实批次：12 本新本在 **213ms 内全部识别**，12 路并发提交，单笔请求 201–343ms，**发现→抢到 429–523ms**；15 秒后复核 12/12 仍是 `pending_distribute` + `组长=杨礼楷`。
- 检测靠「组长/组员待认领列表」轮流轮询（响应小），每 20 轮做一次完整池子扫描兜底；候选判据始终是 `canClaim`，不依赖状态名。
- 写请求（认领 POST）**一次都不自动重试**：连接被回收时 GET 会重连一次，POST 不会——重发就是重复认领。

## 铁律

1. **只提交服务端标为可领的剧本**。候选为空就说清楚「池中暂无 canClaim 为可领的剧本」，不要对不属于你的本乱发请求，诊断路径也一样。
2. 抢本是**真实业务动作**：认领成功这本就归你并进入你的待分发。开始定时抢之前先确认用户要抢、以及要不要跳过哪些 id；不要自作主张扩大范围。
3. **结果未知就不重发**：传输失败、超时、响应读不懂，都按「可能已经生效」处理，交给账本记住，等人回读确认后再决定。永不靠重试来「碰运气」。
4. 不打印、不落盘、不回显 token；日志里只出现 id、剧名、状态。
5. 认领成功不等于万事大吉：15 秒后回读，只有行里写着你的名字才算持有；收回/退回的本不再抢。

## 已知限制

- Python 脚本没有接入桌面 UI 的凭据 Service／安全存储，也不自动读取 key-manager 的 `pipeline.env`。UI 已保存 token 不等于脚本已获授权配置；缺值时两个 CLI 都在发请求前以退出码 2 报「认证配置不足」。不要提取或复制 Vault、打印 token，或改用另一 home 解决；应通过当前进程的显式环境配置提供所需凭据。
- 只覆盖组长/组员两条认领路径，不做「分发给组员」等后续阶段。
- `statusCount` 与池子行的状态名对不齐，`pending_lead_claim` / `pending_claim` / `pending_produce_claim` 的语义至今未验证；所以候选判据只用 `canClaim`，状态名只用于缩小轮询响应，并且每 20 轮做一次完整扫描兜底。
- 脚本不替你判断这本该不该做（题材、版权、集数都在 `--dump` 出来的 JSON 里：`genreTagNames`、`copyrightOwner`、`episodeCount`、`sendbackCount` 等）。
- 后台 job 会随 DSH 宿主重启一起死；窗口期别重启宿主。重启本身不会导致重复认领（账本在磁盘上）。
- 一次运行最多翻 `config.MAX_POOL_PAGES`（默认 10 页 ≈ 3000 行）；池子比这更大时脚本会如实报告「没读完」，不会假装读全了。

## 正本与同步

- 维护源码就是本目录（`skills/jubian-snatch/`）：`SKILL.md`、`references/api-notes.md`、`scripts/`。改逻辑改在这里，再由使用者同步部署到 `.dsh/skills/jubian-snatch/`——已安装的副本是下游快照，不会自动更新。
- 本目录**不含** PyQt6 GUI（`main.py` + `snatcher/ui/`）、旧的 `check_*.py` 人工核对脚本和源项目的 `tests/`；它们只存在于操作者本机，理由见本包的 `maintenance/excluded-sources.json`。
- 离线回归测试在本包的 `tests/jubian_snatch/` 下（`npm test` 会跑），全部使用假连接池：不发真实请求、不产生费用、不认领任何剧本。
- 接口清单、envelope 形状、字段语义与实抢证据见 `references/api-notes.md`。
