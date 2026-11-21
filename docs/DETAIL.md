# 学习通助手（chaoxing-assistant）

这是一个 DeepSeek Harness 的 Host 插件：它不模拟接口，而是通过 Chrome DevTools Protocol（CDP）驱动**真实的 Edge 浏览器**，在用户自己的账号与登录态下完成学习通（超星）课程任务。因为计点的判定发生在真实页面里，插件做的只是"像人一样点播放、滚文档"。

---

## 1. 能力范围

| 任务类型 | 行为 | 计点保障 |
| --- | --- | --- |
| 视频任务点 | 真实鼠标点击播放按钮启动、保持 1x、播放到结束 | 计点三条件（真实点击 / playbackRate=1 / 播到 `ended`）都由真实操作满足 |
| 文档任务点 | 在 PDF 阅读器内用滚轮一路滚到底，到底后停留几秒等上报 | 滚轮事件打到正确的滚动容器，非 `scrollTop` 赋值 |
| 章节测验 | 默认 `chaoxing_auto` 让宿主模型直接作答并提交；也可用 `chaoxing_exam` 手工抓题/回填 | 模型答案低于 `minConfidence` 不提交；`dryRun` 只作答不交 |
| 作业 | 全自动模式会用模型作答并提交；手工工具同样需要 `confirm: true` | 提交后读"提交成功 等待教师批阅"确认 |
| 反爬 | 9010 验证码自动 OCR（ddddocr），字体反爬 `font-cxsecret` 自动解码 | 失败时转人工：保存验证码图片并等待人工输入 |

**不会做的事**：不猜测答案提交真实计分测验（模型作答有置信度门限，低于门限不提交）；不碰直播回放（没有 `<video>`）；不修改前端状态伪造进度（刷新即失效）；不删除 profile、不清 cookie、不关闭用户已有窗口。

## 2. 前置条件

1. **Microsoft Edge**：默认从 `Program Files (x86)` / `Program Files` / `LOCALAPPDATA` 查找 `msedge.exe`，也可用环境变量 `CHAOXING_EDGE` 或工具参数 `edgePath` 指定。
2. **登录态**：第一次使用需要在弹出的 Edge 窗口里扫码/账号登录学习通；登录态保存在插件自己的 profile 目录里（默认 `<dataDir>/profiles/<账号名>`）。
3. **Python（可选但推荐）**：验证码 OCR 与反爬字体解码需要 Python 3 + `ddddocr` + `rapidocr_onnxruntime` + `Pillow`。插件会自动探测 DSH 自带运行时
   `~/.dsh/dsh-runtimes/*/dependencies/python/python.exe`，也可用 `CHAOXING_PYTHON` 或工具参数 `python` 指定。
   缺少 Python 时：验证码会退化为人工输入，字体反爬题目会返回乱码提示。

## 3. 数据目录

默认 `%USERPROFILE%\.dsh-chaoxing`（可用环境变量 `CHAOXING_DATA_DIR` 或插件配置 `dataDir` 覆盖）：

```
state.json          账号、课程、扫描结果、缓存答案、作业记录
logs/job_<id>.jsonl 每次运行任务的 JSONL 日志
profiles/<账号>/    该账号独立 Edge profile（登录态在这里）
fonts/<md5>.ttf     反爬字体样本
fonts/<md5>.json    字体码点 → 真实汉字 的映射缓存
captchas/*.png      每次尝试的验证码截图（人工兜底用）
```

## 3.5 右侧栏面板与 `/chaoxing` 命令

目标课程输入框支持：课程名（如「电工电子技术」）、courseid、`courseid:clazzid:cpi`、课程 URL；留空时自动挑扫描记录里第一门还有待完成的课。课程名有歧义时会列出候选让你补 courseid。


插件同时带一个 **Client 半**（`client.js`），在会话右上角的 utilities 区注册「📚 学习通」按钮：点开后右侧栏出现「学习通助手」面板，8 个按钮（刷新状态 / 打开登录页 / 检测登录 / 扫描课程 / 刷课+做题 / 做作业 / 开始 / 停止）。

面板按钮并不直接操作浏览器，而是通过 Client 的 **Remote 命令通道**执行 `/chaoxing <verb>`（`ctx.remote.commands.execute(sessionId, '/chaoxing status', [])`），宿主侧由 `lib/commands.mjs` 用 `ctx.commands.register()` 注册的同名命令处理——所以**面板、斜杠命令、工具三者的行为完全一致**，都落在同一个 `Engine` / `Autopilot` 上。

命令也可以直接在输入框里敲，输出会作为命令结果出现在会话里：

```
/chaoxing status                         账号、扫描记录、运行中任务、全自动阶段
/chaoxing login                          打开登录页（已登录则直接报昵称）
/chaoxing check                          只探测登录态
/chaoxing courses                        列出扫描记录与剩余点数
/chaoxing scan [courseid[:clazzid[:cpi]]] 扫描课程目录+节点（不产生计点）
/chaoxing run [course]                   刷视频/文档 + 模型做测验/作业
/chaoxing works [course]                 只做作业
/chaoxing auto                           全自动：登录检测 → 扫描 → 刷课 → 做题（手动开始）
/chaoxing stop                           终止全部任务（含队列），不会自动恢复
```

课程参数支持三种写法：`209077533`、`209077533:152216246:491134169`，或从课程页复制完整 URL；只给 courseid 时会从 `state.json` 里已保存的课程记录补齐 clazzid/cpi。

插件配置（`cordis.patch.yml`）默认 `autoStart: false`：**插件启用（DSH 启动）时什么都不跑**，必须点面板「开始」或调用 `chaoxing_auto {"action":"start"}`。把 `autoStart` 改成 `true` 才会恢复"启用即自动跑"。

## 4. 工具

五个工具都通过 `action` 合并动作，减少常驻上下文开销。

### 4.0 `chaoxing_auto`（全自动托管，需手动开始）

**默认不自动启动**：插件启用/DSH 启动时不会跑任何任务，必须在面板点「开始」或显式调用 `start`。点击后：

1. `starting-browser`：启动/复用该账号的 Edge（保留登录态）；
2. `waiting-login`：打开学习通登录页，轮询登录状态（`loginWaitMinutes` 默认 30 分钟）；
3. `discovering`：列出所有课程，逐门读目录，筛出「还有待完成任务点」的课；
4. `working`：逐门课调用引擎刷视频/文档，然后让宿主模型作答章节测验与作业。

| action | 说明 | 主要参数 |
| --- | --- | --- |
| `start` | 手动开始全自动托管（重复调用幂等；会续跑上次未完成的队列） | `account`、`courses`、`concurrency`、`maxMinutes`、`kinds`、`solveQuizzes`、`solveWorks`、`minConfidence`、`autoSubmit`、`dryRun`、`worksOnly`、`loginWaitMinutes`、`scanLimit` |
| `stop` | **终止所有任务 + 清空队列**，之后不会自动恢复（浏览器保持打开、登录态保留） | `reason` |
| `status` | 返回阶段、队列、每门课结果、统计与日志 | `logLines` |
| `llm` | 自检宿主模型桥接是否可用（会发一次极短请求） | – |

`minConfidence`（默认 0.75）：每道题都要模型给出置信度，低于门限的题不自动提交；`dryRun: true` 只抓题+作答、不填不交，适合先用一门课看清模型水平。

**启动与停止语义（v1.5.1）**

- 默认 `autoStart: false` → 启用插件不跑任何任务；`start` 只能由面板「开始」/`/chaoxing auto`/工具调用来触发。
- 「停止」（面板按钮 ■ / `/chaoxing stop` / `chaoxing_auto stop`）= 硬停止：终止当前 job + 清空 autopilot 队列与结果（`autopilot.abort()`），`autoResumeMinutes`/`autoRepeatMinutes` 默认 0，所以**不会自动恢复、也不会自动重扫**。
- 面板**不自动轮询**：只在点击按钮时执行一条命令并显示结果（远程命令会在会话里留记录，轮询会刷屏）。
- **只开一个登录窗口**：刚启动的 Edge 复用自带标签页；已在运行则在当前窗口开标签页（`newWindow:false`）；当前页已是登录页时跳过重复导航。
- 若把 `autoStart` 改成 `true`，才会启用 keep-alive 看门狗（45s 检查、失败退避重试）与可选的自动续跑/重扫。
- 默认账号取配置 `autoAccount`，不再误用 `default` 另开浏览器。
- 复用窗口/标签：浏览器只开一个窗口；登录、扫描、任务页都在这个窗口里以标签方式打开（任务页用完即关），不再每开一个节点弹一个新窗口。若某门课视频因后台标签不推进，可设 `auto.taskWindow: true` 改回独立窗口。
- 账号记录误建（例如 `default`）可用 `chaoxing_account {"action":"remove","account":"default"}` 删除；缺 `profileDir` 的账号请用 `add` 重新登记到原有 Edge 目录。

#- **停止 = 全部终止（v1.6.2）**：`chaoxing_auto {"action":"stop"}` 会先停掉手动 `chaoxing_run`/`scan` 的后台任务（返回 `stoppedJobs`），再终止全自动并清空队列，之后不会自动恢复。
- **发现阶段会自愈（v1.6.3）**：控制器页的 CDP 会话中途失效（`Page.navigate Session with given id not found.`）时自动重建页面并重试该课程，日志 `page-reset`；不会再把后面所有课程误判为失败。
- **单个文档有超时预算（v1.6.3）**：阅读器无响应时读位置只等 2.5 秒，一个文档最多 90 秒（`doc-rolled k:"timeout"`），连续 4 次读不到就放弃（`k:"nometric"`）。
- **残留任务标签会自动清（v1.6.3）**：每次开跑前清扫上一轮异常退出留下的 cards/作业作答页标签（`tabs-swept`），不影响用户自己打开的页面。
- **任务页复用标签（v1.6.0+）**：刷课/扫描都在同一个浏览器窗口的标签页里进行，不再每处理一个节点弹一个新窗口；浏览器启动参数已关闭后台节流，标签页在后台也能推进视频。

## 4.1 `chaoxing_account`

| action | 说明 | 主要参数 |
| --- | --- | --- |
| `list` | 列出已登记的账号与浏览器状态 | – |
| `add` | 登记一个账号（不启动浏览器） | `account`（名字）、`port`、`profileDir` |
| `start` | 启动/复用该账号的 Edge，返回 CDP 端口与版本 | `account`、`startUrl`、`edgePath` |
| `login` | 打开学习通登录页，等用户扫码登录 | `account`、`edgePath` |
| `wait_login` | 轮询登录状态，最多 300 秒 | `account`、`timeoutSec` |
| `courses` | 抓取该账号的课程列表并写入 state | `account`、`edgePath` |
| `stop` | 停止浏览器（`kill: true` 才结束进程） | `account` |

### 4.2 `chaoxing_tasks`

| action | 说明 | 主要参数 |
| --- | --- | --- |
| `scan` | 后台扫描一门课的目录与每张卡片的附件，返回 jobId | `course`、`limit`（只扫前 N 个节点）、`concurrency` |
| `list` | 列出历史扫描与运行中的任务 | – |
| `status` | 查询任务进度；扫描任务会附节点明细 | `jobId` |
| `stop` | 请求停止任务 | `jobId` |

`course` 支持三种写法：`{"courseid":"...","clazzid":"...","cpi":"...","enc":"..."}`、`"courseid:clazzid:cpi:enc"` 或课程目录页 URL；缺 `clazzid` 时会回查 `store.courses`（先跑过 `courses`）。

### 4.3 `chaoxing_run`

后台运行"刷任务点"任务，立即返回 jobId，之后用 `chaoxing_tasks` 的 `status` 观察。

参数：`account`、`course`、`kinds`（默认 `["video","document"]`）、`concurrency`（1–4，默认 2）、`maxMinutes`（默认 120）、`only`（只跑这些节点 id）、`quizPolicy`（`skip` 默认；`cached` 只提交 `state.answers` 里有答案的测验；`auto` 让宿主模型作答并提交）、`solveWorks`（刷完后用模型做作业）、`minConfidence`、`autoSubmit`、`dryRun`、`startUrl`。

停止条件：用户 `stop`、预算耗尽、目录点数全清、连续两轮目录点数不下降。

### 4.4 `chaoxing_exam`

| action | 说明 | 参数 |
| --- | --- | --- |
| `quiz_fetch` | 打开章节测验抓题（题干/选项/已判分答案），自动解码字体 | `course`、`kid`、`num`、`save` |
| `quiz_submit` | 回填并提交测验，**必须** `confirm: true` | `course`、`kid`、`num`、`answers`、`save` |
| `work_list` | 列出作业 | `course` |
| `work_fetch` | 打开作业抓题 | `course`、`workUrl`/`workIndex` |
| `work_submit` | 回填并提交作业，**必须** `confirm: true` | 同上 + `answers` |
| `captcha` | 给"等待人工验证码"的任务提交识别结果 | `jobId`、`code` |

`answers` 格式：`[{"i":0,"letters":"AC","texts":["选项文字A","选项文字C"]},{"i":1,"text":"填空答案"}]`。
**建议同时给 `texts`**：学习通每次打开选项顺序都会打乱，插件优先按选项文字匹配，只有文字匹配不到时才退回字母/下标。

## 5. 典型流程

全自动（推荐）：

```
chaoxing_auto {"action":"llm"}                            # 先确认宿主模型可用
chaoxing_auto {"action":"start"}                     # 手动开始（插件启用时不会自动跑）
chaoxing_auto {"action":"status"}                         # waiting-login → discovering → working
chaoxing_auto {"action":"stop"}                           # 需要时停
```

只演练不提交（推荐第一次跑新课时用）：`{"action":"start","courses":["266998460:154442161:491134173"],"dryRun":true}`。

手工控制：

```
chaoxing_account  {"action":"add","account":"me"}
chaoxing_account  {"action":"login","account":"me"}        # 在弹出的 Edge 里扫码登录
chaoxing_account  {"action":"wait_login","account":"me"}
chaoxing_account  {"action":"courses","account":"me"}      # 确认能读到课程

chaoxing_tasks    {"action":"scan","course":"courseid:clazzid:cpi:enc"}
chaoxing_tasks    {"action":"status","jobId":"..."}        # 看还有多少待完成

chaoxing_run      {"course":"...","concurrency":2,"maxMinutes":180}
chaoxing_tasks    {"action":"status","jobId":"..."}        # 反复看进度
```

手工核对答案：`quiz_fetch` → 阅读题目与模型建议 → `quiz_submit`（带 `confirm: true`）。

## 6. 实现要点（为什么这样做）

- **视频计点**：程序化 `play()`、`seek` 到 94%、`playbackRate>1` 都不计点；后台标签页会暂停视频。因此每个任务页都开**独立新窗口**，注入 SPOOF（隐藏 `document.hidden/visibilityState`、丢弃 `blur/visibilitychange/pagehide` 监听），并用 CDP `Input.dispatchMouseEvent` 真实点击播放按钮。
- **文档计点**：需要 `mouseWheel` 事件打到内层滚动容器，`scrollTop = x` 赋值不算。每 6 轮重取 iframe 坐标，避免页面滚动后坐标失效。
- **并发**：K=2 约 20 点/小时，K=3 约 25–30 点/小时，K≥5 会大量触发 9010 验证码反而更慢。
- **目录点数不降 = 止损**：某些课（直播回放、空章节、平台不计点的课）永远刷不动，连续两轮点数不降就停止并报告，避免空转。
- **模型作答**：抓到的题目（字体已解码）整理成结构化 JSON 交给宿主 `llm` 服务，提示词要求只返回 `{"answers":[{"i","type","letters","text","confidence","reason"}]}`；返回的 JSON 做严格容错解析，题型/字母/漏题都会被纠正并写入 `warnings`。每道题的 `confidence` 汇总成 `gate`：任何一题低于 `minConfidence` 就整体不自动提交，避免"蒙一题毁一场"。
- **全自动状态机**：登录检测持续轮询（排除 `about:blank`、passport 登录页等误判），自动发现只处理"还有待完成点数"的课；每门课的进度落 `state.auto`，DSH 重启后可续跑。
- **安全**：只关闭自己创建的 CDP target（`/json/close/<id>`），永远不动用户已有标签页；手工工具的提交类动作都需要显式 `confirm: true`。

## 7. 常见问题

| 现象 | 处理 |
| --- | --- |
| `Edge 启动后立刻退出…请先关闭该窗口` | 该 profile 正被一个没有开调试端口的 Edge 占用，关掉那个窗口或换 `account`/`port` |
| `还没有登录学习通` | 先 `login`，在打开的窗口扫码，再 `wait_login` |
| 任务卡在 `need_captcha` | 打开 `captchas/` 最新图片，用 `chaoxing_exam {"action":"captcha","jobId":"..."}` 提交识别结果 |
| 目录一直读到 0 点 | `enc` 缺失或过期：先 `courses` 刷新，再用课程 URL 或 `{"courseid","clazzid"}` 形式传入；v1.0.3 起 `stucoursemiddle` 404 时自动换 mooc1 入口，enc 只是可选参数，缺了也能读目录 |
| `page.goto / page.close is not a function` | 旧版 bug：`openTaskPage` 返回的是包装对象，v1.0.3 已修，升级后重跑即可 |
| 视频一直从头播 | 同一张卡被多个窗口抢：把 `concurrency` 降到 1，并确认没有别处开着同课程 |
| 文档"假到底" | 没有滚到正确内层容器：v1.3.2 起会自动逐层下钻（`cards → ananas/modules/pdf → pan-yz screen/file`），日志里 `doc-end k=rolled` 且有 `metric:true` 才算成功 |
| 文档滚到底了但任务点没涨 | 2026-09 起学习通换成 pan-yz 阅读器，服务端是否计点不稳定：插件会真实滚轮翻到底（最多 30 轮 + 到底后停留），但不保证每个课程都记分；视频、章节测验、作业不受影响。这类节点会在两轮目录复核后自动止损（`stale-stop`），不会无限重试 |
| 某门课作业列表一直转（`work-list-retry`） | 该课程没有作业或作业列表页结构异常：v1.3.3 起只重试 2 轮快轮询就放弃，继续下一门课 |
| `chaoxing_auto` 卡在 `waiting-login` | 在已经打开的 Edge 窗口里完成扫码/登录；插件每 4 秒轮询一次，登录后自动进入下一阶段 |
| `chaoxing_auto` 报"未检测到可用的模型服务" | 宿主没有给插件 `llm` 服务或没选默认模型：先在 DSH 里选好默认模型，再 `chaoxing_auto {"action":"llm"}` 自检 |
| 模型作答被跳过（`quiz-low-confidence` / `work-low-confidence`） | 置信度低于 `minConfidence`：调低门限（如 0.5）重跑，或先用 `dryRun` 看答案再人工决定 |

## 8. 合规提示

自动刷课违反学校与平台的用户协议，平台有行为检测（`detect.chaoxing.com`），存在成绩作废、账号受限的风险。本插件只提供技术能力，请只在自己有权使用的账号与课程上、遵守学校规定的范围内使用，后果自担。
