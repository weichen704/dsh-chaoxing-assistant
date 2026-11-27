# 学习通助手 · dsh-chaoxing-assistant

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的学习通（超星）任务助手：在**真实 Edge 浏览器**（CDP 驱动）或**学习通 Windows 客户端**（UIA + OCR）里点播、翻页、答题——右侧栏一块面板、`/chaoxing` 命令、5 个模型可调用的工具。答案由宿主模型生成；不伪造进度、不调用平台后端接口，只做网页上看得见的操作。

- **两条通道**：网页版用你自己的 Edge 和登录态（不用扫码重登）；桌面版直接驱动学习通客户端，专治只有客户端能打开的小节点。
- **默认保守**：出现人脸/活体/实人认证立即停机且**零点击**；空题默认**不交卷**（只存草稿）；视频“放完”不算完，要等平台确认，连续几节没确认就停。
- **能答也认字**：章节测验字体反爬解码、LLM 分批作答 + 置信度门控、答案缓存、作业 fail-closed（数不清空题就存草稿）。
- **每一步可查**：动作写 `~/.dsh-chaoxing/logs/*.jsonl`，面板 2.5 秒快照，随时停止；15 个测试文件覆盖窗口标定、认页、作业导航、护栏等真实事故回归。

> ⚠️ **先读这段**：刷课、自动答题违反学习通用户协议与多数学校规定，平台有行为检测（`detect.chaoxing.com`），可能导致成绩作废、任务点清零或账号受限。模型答案会计入真实成绩。是否使用、如何使用以及后果，全部由使用者自己承担；作者不提供任何形式的成绩保证或合规背书。

## 安装

要求 **DeepSeek Harness ≥ 0.2.1**（用到 `@deepseek-ai/dsh-client-ui-conversation` 与 `dsh-client-ui-sidebar-right` 两个客户端注入点）。

**方式一：插件市场**
dsh 0.2.1 起，打开 **设置 → 插件 → 发现（Discover）→ 索引源**，添加

```
https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json
```

然后在市场里搜 `学习通` 或 `chaoxing`，一键安装。

**方式二：让 agent 装**
对 DSH 说「安装 npm 包 dsh-chaoxing-assistant」，它会调用 `plugin_manager`：

```
action=install_bundle
target=dsh-chaoxing-assistant
```

**方式三：直接从 GitHub 装**

```
action=install_bundle
target=github:weichen704/dsh-chaoxing-assistant
```

**方式四：本地目录**
把仓库下载/解压到固定位置（之后不能删或移动，link 安装指向它），然后在 **设置 → 插件 → 添加插件** 里选这个目录。

装好后新开一个会话：会话头部出现「📚 学习通」按钮，`/chaoxing` 命令与 `chaoxing_*` 工具可用。升级客户端 bundle 后需要**完整重启 DSH**，面板才会换成新版。

## 运行环境

| 需要 | 说明 |
| --- | --- |
| Windows | 面板的桌面模式依赖 Windows UIA + 系统 OCR；网页模式同理依赖本机 Edge |
| Microsoft Edge | 插件用真实 Edge，通过远程调试端口（默认 `9422`）驱动，不装浏览器驱动 |
| Python 3（可选） | 验证码 OCR（`python/captcha.py`）与反爬字体解码（`python/fontmap.py`）用，只用标准库，不需要 pip。找不到时设 `CHAOXING_PYTHON` 指向解释器 |
| 端口 `9483` | 面板与宿主之间的本地 HTTP 桥，只监听 `127.0.0.1` |

## 快速开始

1. 打开右侧栏面板，点「登录」，在弹出的 Edge 里扫码登录学习通；点「检查」确认登录态。
2. 课程输入框写课程名（例如 `高等数学`），也可以写 `courseid:clazzid:cpi` 或课程 URL；留空 = 所有课程。
3. 点「扫描」看待完成任务点，「刷课 / 作业 / 开始」任选一个。
4. 「停止」= 终止所有任务并清空队列，**不会自动恢复**（`autoResumeMinutes` / `autoRepeatMinutes` 默认 0）。

## 面板按钮

| 按钮 | 作用 |
| --- | --- |
| 刷新进度 | 拉一次多行实时进度（面板每 2.5 秒自动刷新，走本地 HTTP 桥，不写会话记录） |
| 登录 / 检查 | 打开/复用登录页；探测登录态 |
| 扫描 | 后台扫描当前课程的待完成任务点 |
| 刷课 | 只刷视频与文档任务点 |
| 作业 | 只做作业（模型作答 + 提交） |
| 开始 | 全自动：登录检测 → 扫描全部课程 → 刷课 → 章节测验/作业 |
| 停止 | 终止全部任务、清空队列，之后不再自动跑 |

课程输入框右侧的「确定」= 优先完成这门课（会中断当前队列）。

面板还提供两个入口：**网页版**（在插件驱动的 Edge 里打开学习通网页）与**桌面版**（启动本机学习通客户端 `cxstudy.exe`，用 UIA + OCR 在客户端里跑）。

## 工具（模型可调用）

| 工具 | 动作 |
| --- | --- |
| `chaoxing_account` | `list / add / start / login / wait_login / courses / stop / remove` |
| `chaoxing_tasks` | `scan / list / status / stop` |
| `chaoxing_run` | 启动后台跑课任务（`kinds`、`quizPolicy`、`solveWorks`、`dryRun`、`workLimit`、`maxBlanks`） |
| `chaoxing_exam` | `quiz_fetch / quiz_submit / work_list / work_fetch / work_submit / captcha` |
| `chaoxing_auto` | `start / stop / status / progress / llm` |

## 配置

插件没有导出 Config schema，所以**设置页没有表单**，参数在插件的 `cordis.patch.yml` 里（安装即生效的默认值）。要改有两种办法：

- 直接改插件目录里的 `cordis.patch.yml`（npm 装的在 profile 的 `node_modules/dsh-chaoxing-assistant/` 下），然后重启 DSH；
- 或在自己 profile 的 `cordis.patch.yml` 里按 id 覆盖（更推荐，升级插件不会丢）：

```yaml
- id: chaoxing-assistant
  config:
    autoStart: false
    autoAccount: default
    auto:
      minConfidence: 0.75
      autoSubmit: false
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `uiPort` | `9483` | 面板 HTTP 桥端口，只监听 127.0.0.1 |
| `autoStart` | `false` | 插件启用/DSH 启动时是否自动跑（默认不跑，必须手动点「开始」） |
| `autoAccount` | `default` | 默认账号别名 |
| `autoResumeMinutes` | `0` | 停止后自动恢复的等待分钟数，0 = 永不 |
| `autoRepeatMinutes` | `0` | 自动重扫间隔分钟数，0 = 永不 |
| `auto.concurrency` | `2` | 并发窗口数，1–4；≥5 容易触发验证码 |
| `auto.maxMinutes` | `180` | 单门课最长运行分钟数 |
| `auto.solveQuizzes` / `auto.solveWorks` | `true` | 是否自动做章节测验 / 作业 |
| `auto.minConfidence` | `0.75` | 模型作答置信度门限，低于它的题不提交 |
| `auto.autoSubmit` | `true` | 是否真的提交模型答案（`false` = 只填不交） |
| `auto.dryRun` | `false` | 演练：抓题 + 作答但不填不交 |
| `auto.taskWindow` | `false` | 每个任务页是否独立开窗口 |
| `auto.maxBlanks` | `0` | 允许提交的空白题上限；超了就存草稿不提交，避免低分卷 |
| `auto.videoNotConfirmedMax` | `3` | 连续几节「播放器放完但平台未确认完成」就停机，`0` = 不检查 |
| `auto.blankGuard` | `true` | 交卷前回读页面空题数；题数与抓到的题一致时以页面为准，否则退回答案计划 |
| `auto.humanGuard` | `true` | 出现人脸/活体/实人认证提示就停机，零点击、不尝试绕过 |
| `desktopPath` | 自动查找 | 学习通桌面客户端 `cxstudy.exe` 的路径 |
| `desktopInput` | `auto` | 桌面模式的输入通道：`auto` / `ps`（强制只用 PowerShell） |

环境变量：`CHAOXING_DATA_DIR`（数据目录）、`CHAOXING_PYTHON`（Python 解释器）、`CHAOXING_DESKTOP`（桌面客户端路径）。

## 工作原理

- **网页版**：启动一个独立的 Edge 用户目录 + CDP 调试端口，用真实鼠标键盘事件（`Input.dispatchMouseEvent` 等）点播放、翻文档、点选项，不靠 DOM 注入，平台侧看到的就是普通浏览器操作。
- **任务页**：每个节点在当前窗口开一个标签，已完成的任务点直接跳过；视频按播放器时间推进判断结束，再回读平台任务点确认「真的算完成」，连续几节没确认就停；文档用滚屏 + 像素稳定判断到底，没通过就重进卡片再翻（最多 2 次）。
- **答题**：抓题（含图片题干提示）→ 交给宿主模型 → 回填 → 低置信度题不提交；交卷前回读页面空题数，超 `maxBlanks` 只点「暂时保存/保存草稿」，点不到就放弃，绝不退化成提交。
- **验证码与人工核验**：遇到 9010 类验证码自动 OCR，失败会转人工并在任务状态里给出截图路径；看到人脸/活体/实人认证提示立即停机（`HUMAN_VERIFICATION`），不点、不绕。
- **桌面版**：调试端口被客户端拦截、改 asar 会被完整性自检拒绝，于是改用 Windows UIA + 系统 OCR + 键盘事件驱动；检测到宿主装了 `@copylee/dsh-computer-use` 时，点按与输入交给它执行，截图/OCR/像素哈希仍走本地 PowerShell 通道（不可用时自动降级）。

## 已知限制

- 桌面版会占用鼠标键盘（依赖聚焦窗口），运行期间不要抢焦点；每次「开始」会先重启客户端获得干净状态。
- 2026-09 之后的新版 pan-yz 阅读器不上报文档计点，插件会 `stale-stop` 止损而不是空转。
- 直播回放、空章节会跳过；`num=0` 的信息页会继续往后摸节点。
- 平台改版会让选择器/OCR 分区失配，这类问题只能跟着修（欢迎提 issue 时附日志）。

## 数据与隐私

- 所有数据在本机 `%USERPROFILE%\.dsh-chaoxing`（可用 `CHAOXING_DATA_DIR` 改）：`profiles/`（每个账号一个独立 Edge 用户目录，登录态在这里）、`logs/`、`fonts/`、`captchas/`、`shots/`、`state.json`（含答案缓存）。
- 除了宿主模型本身（答题走你配置的 provider），插件不向外发送任何数据；日志与截图都只落本地。
- 这个目录含登录态和答案缓存，**不要提交到仓库、不要分享给他人**。

## 更新日志

### v2.3.0（护栏优先：宁可停，不可猜）

- **人工验证硬停**：新增文本级检测（强文案 + 「人脸/核验/摄像头」弱匹配），网页版播放循环、任务页就绪检查与桌面版读屏都会拦；命中即停且**零点击**，课程正文与目录标题（如「第 1 章 人脸识别概述」）不误停。
- **空题不交卷**：新增页内空题探针（认真题、已批阅的 `.Py_answer`、只加样式类的选项、contenteditable/iframe 编辑器），探针与抓到的题数一致才采信，否则退回答案计划；超 `maxBlanks`（默认 0）只存草稿，桌面版点「暂时保存」，找不到保存入口就放弃，**绝不退化成提交**。
- **播完要平台确认**：新增 `confirmVideoWatched`，按附件 `jobid`/名称回读 `passed` 或 `isUnFinishJob() === done`，最多等约 16 秒；连续 `videoNotConfirmedMax`（默认 3）节没确认就停 `VIDEO_NOT_CONFIRMED`，无法判定（`unk`）时不误停。
- **判据纯函数化**：新增 `lib/judge.mjs`（播放完成比例、空题统计、交卷闸门、未确认止损）与 `lib/guard.mjs`，配 20 + 15 项表驱动测试；`minConfidence` 在面板/命令/桌面/引擎统一为 0.75。
- **工程**：Edge 启动补 `CalculateNativeWinOcclusion` 反节流；面板与 autopilot 补传 `maxBlanks`/`videoNotConfirmedMax`/`humanGuard`/`blankGuard`；版本号与 `client.js` 对齐；移除打包里的 `.bak` 残留。

### v2.2.13

桌面版稳定性修复（按 `cxstudy.exe` 认窗口、作业列表就绪判据、`readWorks` 阈值）与网页版导航修复。

## 开发

```
index.js       宿主侧入口：注册 5 个工具
client.js      右侧栏面板（web 客户端 bundle）
lib/           网页引擎（CDP）、任务引擎、答题链路、桌面驱动、HTTP 桥
python/        验证码 OCR、反爬字体解码（仅标准库）
desktop/       PowerShell UIA 脚本 + OCR 辅助
cordis.patch.yml  安装即生效的默认配置
```

## License

MIT，见 [LICENSE](LICENSE)。软件按「现状」提供，不附带任何担保；使用风险自负。
