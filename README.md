# dsh-muse-drama

一份独立的 **DSH 短剧制作插件包**：把短剧制作模式需要的全部插件、技能、预设与品牌资源收在一个包里，装一次就齐，不再出现"某个宿主里少几个插件、工具静默消失"的情况。

## 包含什么

| 入口（`dsh-muse-drama/…`） | 注册的工具 / 能力 | 来源包 |
| --- | --- | --- |
| `jubian` | `jubian_catalog` `jubian_asset` `jubian_video` `jubian_storyboard` `jubian_media` `jubian_organize` `jubian_model` `jubian_watch` | `@deepseek-ai/dsh-tool-jubian` |
| `drama-gate` | 工具派发守卫（写/计费方法必须有 `idempotency_key`、镜头脚本结构、付费提交前必须有 `official=true` 资产、生图前对账、退役 MUSE 工具名） | `@deepseek-ai/dsh-guard-drama` |
| `drama-assets` | `drama_assets`：付费生图前的远端/清单对账与处置 | `@deepseek-ai/dsh-tool-drama-assets` |
| `drama-shot` | `drama_shot`：镜头脚本结构门禁、分包预览、matched JSON 与剧变包编译 | `@deepseek-ai/dsh-tool-shot-script` |
| `drama-bgm` | `drama_bgm`：48 kHz 配乐合成（交叉淡入、不覆盖已有文件） | `@deepseek-ai/dsh-tool-bgm-compose` |
| `drama-render` | `drama_render`（subtitles / prepare / render / verify）+ `drama_video`（版本禁用标签） | `@deepseek-ai/dsh-tool-episode-render` |
| `drama-settings` | 「设置 → 短剧」页（Host + Client） | `@deepseek-ai/dsh-drama-settings` |
| `bgm-match` | `bgm_match`：按情绪（valence/arousal）排序 BGM 候选 | `@deepseek-ai/dsh-perception-bgm` |

另外包含：

- `skills/` —— 17 个短剧技能（`tweet-drama-*`、`shot-script-creator-9-16`、`jubian-asset-library`、`jubian-snatch`、`xiaohongshu-reference`），外加 vendor 时生成的 `skills/index.json`（技能的 name/description/whenToUse，避免运行时解析 YAML）；
- `runtime/skills.js` —— 技能源插件（patch 行 `muse-drama-skills` → `dsh-muse-drama/skill-source`）：读 `skills/index.json`，把每个技能连同它的 `resourceBase`（技能目录，保证正文里的 `scripts/…` 相对路径可解析）注册进 `skills` 服务。**换机器、换宿主都不需要再单独配技能根**；
- `presets/short-drama/` —— 短剧 Agent 预设参考副本（`agent.cordis.yml` + `preset.yml`）；
- `assets/muse-med-logo-{black,white}.webp`、`assets/muse-med-logo.png` —— MUSE 黑白蜘蛛品牌图。

## 安装

`cordis.patch.yml` 是本包的 bundle 层：把它加进 profile 就会插入全部插件行，行 id 与短剧预设里用的 id 一致。

### 方式一：本地 vendor（离线、跟随本机 DSH 检出）

```sh
# 1) 放进 profile 的 vendor 目录（profile 的 pnpm-workspace 已含 vendor/*/*）
git clone https://github.com/felir7at62co-wq/musu.git "$DSH_HOME/profiles/web/vendor/muse/drama"

# 2) 在 profile 的 package.json 里加依赖与 bundle
#    "dependencies": { "dsh-muse-drama": "workspace:^" }
#    "dsh": { "profile": { "bundles": [ …, "dsh-muse-drama" ] } }

# 3) 安装并重启宿主
cd "$DSH_HOME/profiles/web" && pnpm install
```

### 方式二：npm（发布后）

```sh
dsh plugin --profile web add dsh-muse-drama
```

安装后用 `dsh --profile web --dump-config` 能看到 `drama-gate` / `tool-shot-script` / … 各行，会话里则应出现 `drama_shot`、`drama_render`、`drama_assets`、`drama_bgm`、`drama_video`、`bgm_match` 与 `jubian_*`。

### 桌面端（Electron 打包运行时）

桌面端**不读** `<DSH_HOME>/profiles`，它跑自己打包的运行时与包集，所以必须显式接进来，否则会复现"默认 preset 是短剧模式、插件行却静默加载失败"的老毛病（症状：会话有短剧人格和技能，但 `drama_shot` / `drama_assets` / `drama-gate` 全都不在，主体身份门禁失效，生成的片子用错人）。

桌面端的社区插件走 `third_party/plugins/` 钉版机制，`build.mjs` 有三条硬要求（实测）：

1. 拷进 staging 时会**剔除 `lib/`**（`filter: !/(node_modules|lib|\.git)/`）——**预编译包进不去，必须带源码构建**（toolchain 的 tsc/tsdown）；
2. `package.json` 的 `version` 与 `license` 必须与 `sources.json` 的钉完全一致，且仓库里要有**非空 LICENSE**；
3. 宿主版本变了（≠ `0.1.6-alpha.1`）会要求重新做兼容性复核。

因此桌面端两条路，二选一：

- **路线 A（推荐，合现有机制）**：把本仓库扩成**源码形态**——带各插件的 `src/`、`tsconfig.json` 与构建脚本，`sources.json` 钉 `{repository, version, commit, license}`，再把它加进 `DESKTOP_SOURCE_PLUGINS`，行照 `cordis.patch.yml` 加进 `apps/desktop-host/config/desktop.cordis.patch.yml`。仓库会变大（多出源码树），但完全走桌面端已有的门禁与构建。
- **路线 B（改动宿主管线）**：保留预编译形态，改 `apps/desktop/src/core-package-set.ts` / `prepare-package-set.ts`，让桌面包集也能收一个不含 `lib/` 的预编译包。改动在宿主侧，会影响其它包集消费者。

两条路都需要重新打包桌面端；只改 profile 对已安装的桌面端无效。

### 本机安装脚本

```sh
node scripts/install-into-profile.mjs --profile web           # 只打印计划
node scripts/install-into-profile.mjs --profile web --apply   # 写入 vendor + package.json
```

脚本做四件事（幂等，默认 dry-run）：把包复制到 `<profile>/vendor/muse/drama`；在 `<profile>/node_modules` 建 `dsh-muse-drama` 软链；把 `dependencies` 与 `dsh.profile.bundles` 各加一条；把包需要的 10 个 harness 包**从检出**接进 `vendor/muse/drama/node_modules`。

最后一件事不是多余的：profile 里可能躺着更早 vendored 的同名副本，包内编译产物按检出编的，撞上旧副本会在 import 期直接失败——实测 `<profile>/vendor/jubian/jubian` 的 `dsh-jubian` 缺 `checkBudget`，会让 `jubian` 行起不来。检出路径用 `--harness` 覆盖（默认 `E:/deepseek-harness`，也可用 `HARNESS`）。

### 加载自检（不需要重启宿主）

```sh
node scripts/verify-load.mjs                # 用包自己的 8 个子路径
node scripts/verify-load.mjs --profile web  # 用真实 profile 的 bundle 列表与解析器
```

两者都真起一个 `cordis-plugin-loader`、真 import 编译产物，然后读 Tool 与 Skill 注册表；`--profile` 模式读的是 profile `package.json` 的 bundles 与各 bundle 的 `cordis.patch.yml`，等价于宿主重启后会挂载的那一组行。期望输出：9 行 ok、14 个短剧工具、17/17 技能。

## 需要在 profile 里覆盖的配置

只有两处与机器相关（其余字段省略即用插件默认值）：

```yaml
- id: tool-bgm-compose
  config:
    ffmpegPath: 'C:\Users\…\ffmpeg.exe'
    ffprobePath: 'C:\Users\…\ffprobe.exe'

- id: perception-bgm
  config:
    pythonExecutable: '…\python.exe'     # 需装 torch/transformers/librosa/music21/mir_eval/pretty_midi
    weightsPath: '…\J_all.ckpt'
    dataDir: '…\models\data'
    env:
      HF_HOME: '…\hf-cache'
      HF_HUB_OFFLINE: '1'                # 模型已预置，别让它去联网检查
      OMP_NUM_THREADS: '1'
      MKL_NUM_THREADS: '1'
      OPENBLAS_NUM_THREADS: '1'
```

## 没有包含（需要另行准备）

- `tweet-drama-draft-build` 的本地语音识别模型（`models/faster-whisper/**/model.bin`，约 461 MB）—— 体积原因不入库，按该技能 `references/dependencies.md` 预置；
- ffmpeg / ffprobe 可执行文件；
- `bgm_match` 的 Python 运行时与情感头权重。

## 许可与限制

- 包内代码派生自 DeepSeek Harness（`@deepseek-ai/dsh-*`），遵循其许可证；
- `bgm_match` 的候选排序使用 m-a-p/MERT-v1-95M（CC-BY-NC-4.0），**仅限非商业用途**；使用候选排序即须遵守该限制；
- 品牌图（`assets/muse-med-logo-*`）为 MUSE 标识，仅供本产品使用。

## 维护：从 DSH 检出重新 vendor

包内 `lib/` 是 DSH 检出（当前 `0.1.6-alpha.1`）的**编译产物**，不是源码副本。升级 DSH 后重新生成：

```sh
node scripts/assemble.mjs            # 默认从 E:/deepseek-harness 读取，可用 HARNESS 覆盖
```

脚本会复制 8 个插件的 `lib/*.js`、17 个技能（自动跳过 461 MB 模型与缓存）、短剧预设与 MUSE 品牌图。
