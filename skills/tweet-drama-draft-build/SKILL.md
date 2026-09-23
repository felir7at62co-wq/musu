---
name: tweet-drama-draft-build
description: Use when 仿真人短剧需要可编辑草稿、实际发声字幕、音频校时或待处理镜头预览。
---

# 仿真人剪辑与字幕

运行前检查 [外部依赖与授权](references/dependencies.md) 和 [输入输出](references/io-contract.md)；此源码包不附带第三方 Python 库、可执行文件或媒体。每集草稿采用与成片一致的已审核 BGM 混合音轨（至少两首，按情绪分段），不把生成器的单文件输入误解为允许一首循环。生成时长和分辨率取当前所选模型与分镜，不以历史固定镜头秒数或字数限制替代。

输入按任务和镜头排序并通过内容审核。clean/not_required 可进入时间线；pending 仅用于明确标注“未完成，非最终交付”的草稿/预览，由模型安排后续回读并替换来源，不把等待交给用户。未知或 failed 需核查恢复，不得假称完成。最终选用文件必须 clean/not_required 且通过实际文件内容、字幕清理、分辨率和音画 QA。

字幕覆盖全部真实发声，保留原文与说话人：dialogue/台词、vo/画外音，以及已确认实际发声的 os/心声/旁白/解说。少用旁白是创作建议，不是删除原文的许可；未确认发声时先核查音频，不把心理或叙述说明直接变字幕。动作、表情、场景和摄影说明不出字幕。内嵌字幕与后加字幕分别记录，避免重复。去字幕清理的是源视频中不需要的生成文字，最终设计字幕仍按项目已批准要求制作，clean 不表示最终成片必须无字幕。

输出可编辑草稿、SRT、预览 MP4 和镜头/任务来源映射。SRT 由 `drama_render subtitles` 写出（台词计划 + 成片清单 → `editing/<集>.srt`），它同时把每镜的 `actual_speech_start/end` 测出来。`scripts/build_spoken_subtitles.py` 的 build_spoken_cues 默认只接受 clean/not_required；pending 必须显式 draft=True。默认所有发声（包括编译为 vo 的旁白/心声）必须有完整 actual_speech_start/end，否则报缺少音频证据，不静默漏句；仅显式 draft=True 可用带 timing_source=9_chars_per_second 标记的预估时间。该函数只构造 cues，9字/秒预排不是最终校时，也不代替成片 QA。

## 视频禁用标签

先用 `drama_video` list/inspect 查项目 `video-bans.json`。labels 至少一个自由可读标签（如“人物对调”），reason 可选，ban 不要证据。标错用 unban；查询无标签或 unban 不等于审核通过。禁用版本不得进入草稿或预览，禁止通用 FFmpeg、手写脚本和直接复制绕过。门禁按本项目实际 SHA256 检查，同字节副本也命中，同路径新字节不继承旧禁用。

`DraftGenerator.prepare_materials` 在删除旧素材目录前检查实际选源；`jianying_draft.main_with_args` 在删除旧草稿前检查视频。`prepare_materials`、`process`、`generate_draft` 可传 `project`；`main_with_args` 可传 `args.project`。未传时只从素材或视频目录祖先的 `project_config.json` 定位项目；外置素材无法定位时明确补 project，不能当作无禁用继续。纯图片流程不要求该映射。这是官方路径检查，不拦截外部命令。

## 字幕交付样式（固定，不得自行发挥）

- **时间必须来自语音识别对齐，用 `drama_render subtitles` 落位**：先对该镜**自己的**成片（此时还没有任何 BGM 混进来）跑一次语音识别，把每一句的起止时间写成逐镜、镜内相对的对齐文档 `{"shots":[{"shot":1,"cues":[{"text":"识别文本","start":0.0,"end":0.8}]}]}`，再连同 `lines` 一起传给 `drama_render subtitles`。**本工具不做识别、不测能量、不估算时间**：能量门限只能说明有人在说话，说不出具体哪句在哪里，估算出来的时间正是字幕压错句的原因。cue 时间 = 该镜在时间线上的起点 + 镜内偏移；字幕文字始终取剧本原文，识别文本只用于核对是不是同一段表演。缺某一镜的对齐、段数与台词条数不符、识别文本与剧本对不上、或该镜的策略不是 `asr_aligned`，都会按 failure 报出并提示该对哪一镜重跑识别；有识别结果却没声明台词同样报 failure。写出的 cue 还会检查时长、重叠、越界与阅读速度（>20 有效字/秒失败，>12 警告）。识别本身的准确度由调用方负责，`speech_alignment` 永远留在 `not_checked`。9 个有效字/秒只作为**草稿预估**，不得用于最终交付。
- **对齐文档由本技能的 `scripts/align_subtitles.py` 产出**（不要再用 `_probe` 里那份）：`python -B <技能目录>/scripts/align_subtitles.py --project <项目根> --episode <集号> [--strict]`。它逐镜本地转写、把剧本原文对齐到识别到的时间，识别文本不进字幕；每镜写出策略 `asr_aligned`（整镜锚定）/ `anchored`（部分锚定）/ `estimated_total`（一条都没锚定），**只有 `asr_aligned` 会被 `drama_render subtitles` 接受**，所以看到后两种就说明台词与成片不是同一版，必须先查清楚再重跑，不要拿估算时间交付。模型选择以显式 `--model-dir` 或 `--model-url` + `--model-sha256` 为先；未显式选择时读取 `MUSE_WHISPER_MODEL_DIR`（Desktop 随包离线模型），再查缓存。默认缓存为 `${DSH_HOME:-~/.dsh}/cache/models/faster-whisper`，`--cache-dir` 可覆盖；不往安装技能源目录写模型。已有随包模型无需下载，只有显式模型 URL 才下载并校验固定摘要；脚本不会自行去模型仓库拉取，否则同一集在不同机器上会跑出不同的对齐。项目固定用的模型包是 `https://muse.tos-cn-beijing.volces.com/asr/faster-whisper-small-536b0662.zip`（`--model-sha256 b5f1095b98f6583fb91252d1bbd68a1422cfd3d661449bcfc19d752f234a6f5f`，486,212,794 字节，四个文件，Whisper/CTranslate2 均为 MIT）。**识别固定为单线程 + temperature 0**：多线程 int8 解码不可重现（同一镜两次跑出 34 字与 30 字），会让同一句这次锚定、下次锚不上；固定后同一镜同一模型每次结果一致，但**换模型版本仍会变**，所以模型包必须锁定摘要。依赖 `faster-whisper` 与 `ffmpeg`（路径走 `paths.py` 的 `DSH_FFMPEG_PATH`/`FFMPEG_PATH`）。
- **单行、无标点、按语义切分**。用空格分隔语义组代替逗号句号；1080×1920 设计帧在 40px 边距内可用 1000px，SimHei 68 每字约 68px，**单条不超过 14 个字**（空格按半字计）。超长必须按语义拆成连续两条，不许压成两行。
- 字幕文字用剧本原文，不改写、不省略、不合并不同说话人的句子。
- **一集内不得漏句**：交付前逐镜核对 `drama_render subtitles` 的结果——`subtitle_line_coverage` 必须为空，既不能有「声明了台词却没有这一镜的对齐」，也不能有「有识别结果却没声明台词」。具体字词有没有读对（漏读、串词、同音字）只能靠试听判定；`align_subtitles.py` 的识别结果留给对齐用，不参与校核台词对错。

## 剪映草稿字幕样式

剪映草稿字幕固定用系统默认黑体、字号 `11`、字间距 `0`、黑色描边参数 `20`。它与 FFmpeg 成片的字幕字号相互独立（成片见 `tweet-drama-background-render`），改一个不得联动另一个。剪映草稿**不添加**「内容纯属虚构 请勿带入现实」和「内容由AI生成」水印轨；已确认的 FFmpeg 样式只保留右下角「内容由AI生成」，不加右上角水印。

剪映主轨按项目剪辑计划使用任务视频，保留必要收束；字幕预排可参考脚本相对时间，最终逐句按真实音频校正，不以等比例映射代替真实发声时间。保留项目已确认字幕与草稿样式。
