# I/O Contract

## Required input

- `--input`: `.doc`、`.docx`、`.txt`、`.md` 剧本文档。
- `--project`: 推文项目目录。

## Required output

- `<project>/source/original/<原文件名>`
- `<project>/source/source_script.txt`

## Guarantees

- 原文件会归档进项目内。
- 纯文本用 UTF-8 写出。
- 转换脚本不改写剧情内容，只做格式转换和基础换行清理。
