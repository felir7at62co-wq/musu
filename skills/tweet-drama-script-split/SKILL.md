---
name: tweet-drama-script-split
description: 推文短剧剧本拆分 skill。用于 agents 从 txt/doc/docx/markdown 剧本中识别集数、拆分保存单集文本，并检查少字、漏字、重复、标题边界错误。
---

# 剧本拆分

把用户上传的整本剧本拆成 `episodes/<episode>.txt`。

## 流程

1. 读取原始剧本文本。
2. 识别分集标题，例如 `第1集：...`。
3. 按标题边界切分，不删除正文里的钩子和对白。
4. 保存单集文件。
5. 对比原文和拆分结果，检查是否少字、漏集、乱序。

## 脚本接口

需要 Python 3.11+ 与 `python-docx`。从本技能实际目录导入 `scripts/script_processor.py` 的 `ScriptProcessor`；`.doc` / `.md` 先用 `tweet-drama-script-convert` 转成 `.txt`。先调用 `analyze(script_path)`，审核候选、过滤决定及原文差异后，再调用 `save(project_dir, analysis)`；仅在用户要求重新生成时允许覆盖分集。无标题时脚本提供单集候选，仍需人工确认。`save` 仅写分集和 `episodes/manifest.json`，不管理制作状态；审核通过后由 `tweet-drama-core` 维护唯一 `pipeline_state`。

## 输出

- `episodes/01.txt`
- `episodes/02.txt`
- `split_report.json`

## 集长标注不可信

原剧本分集标题下面自带的「预计时长：约 X 分 Y 秒」原样保留，但**它不可信**：不要拿它判断这一集该写多长、不要用它验收、也不要在汇报里引用。字数和编译时长仅作计划估算；最终以实际选用视频、真实音频和导出文件的实测时长为准，不改原文去凑估计值。

## 失败处理

- 找不到分集标题时，不要硬猜；先输出候选切分点。
- 少字时保留原文，报告缺失范围。
- 只修拆分结果，不改原始剧本。
