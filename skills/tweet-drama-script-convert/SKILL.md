---
name: tweet-drama-script-convert
description: 推文短剧剧本文档转换 skill。用于 agents 在创建项目时把用户提供的 .doc、.docx、.txt、.md 剧本文件复制归档到项目 source/original/，并转换/清洗为 source/source_script.txt，供后续分集拆分、少字检查、资产提取和镜头脚本生成使用。
---

# 剧本格式转换

把用户原始剧本归档进项目，并生成统一纯文本入口。

## 输入

- 用户提供的剧本路径：`.doc`、`.docx`、`.txt`、`.md`。
- 项目目录：`<root>/projects/<项目名>/`。

## 输出

```text
<project>/
  source/
    original/
      原始剧本文件
    source_script.txt
```

## 使用脚本

以下命令从本技能的实际目录运行，使用 Python 3.11+；不依赖项目当前工作目录。优先运行：

```powershell
python -B scripts/convert_script.py --input "<剧本路径>" --project "<项目目录>"
```

可选指定输出：

```powershell
python -B scripts/convert_script.py --input "<剧本路径>" --project "<项目目录>" --output "<项目目录>\source\source_script.txt"
```

## 转换规则

- `.txt`、`.md`：按 UTF-8、UTF-8-SIG、GB18030、GBK 顺序尝试读取。
- `.docx`：优先用内置 zip/XML 读取正文，不强依赖 `python-docx`。
- `.doc`：优先用本机 Word COM 转换；没有 Word 或 COM 失败时，尝试 LibreOffice `soffice`；都不可用时失败并提示用户转成 `.docx` 或 `.txt`。
- 原始文件必须复制到 `source/original/`，不要只引用外部路径。
- 输出文本要保留剧情原文，不要擅自改写，不要总结，不要删改台词。

## 失败处理

- 如果 `.doc` 无法读取，不要继续做分集拆分；向用户说明需要安装 Word/LibreOffice，或让用户另存为 `.docx/.txt`。
- 如果输出文本明显为空或过短，视为失败。
- 如果用户提供的是图片/PDF，不由本 skill 处理，先询问是否需要 OCR 或 PDF 文本提取。
