<div align="center">

# Roundtable

**把注意力还给团队。**

圆桌旁，人和 AI 平等落座：它听完整场讨论，很少开口，<br>把结论和分工摆上桌，再交给各自机器上的 Codex 把事做完。

*An AI teammate for Feishu/Lark that listens to the whole room, speaks rarely, and turns discussions into delivered work.*

[![CI](https://github.com/hudikiller/roundtable/actions/workflows/ci.yml/badge.svg)](https://github.com/hudikiller/roundtable/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 24](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)
![Feishu / Lark](https://img.shields.io/badge/Feishu%20%2F%20Lark-native-3370FF)

简体中文 · [English](README.en.md) · [核心能力](#核心能力) · [快速开始](#快速开始how-to-start) · [日常用法](#日常用法) · [配置参考](#配置参考)

</div>

---

## 为什么做这个

团队群聊里最贵的不是算力，是**注意力**：

- 每次请 AI 帮忙，都要先把前面三十句讨论再讲一遍；
- 讨论有了结论，还得有人整理、分工、追进度；
- 一个人在群里补了一句需求，负责那件事的人和 Agent 却不知道；
- AI 动不动插嘴，或者一个任务把另一个任务的上下文搅乱。

**Roundtable** 让 AI 像一位安静、可靠的同事那样坐在飞书群的圆桌旁：

> 它**一直在听**，所以你不用复述；它**很少说话**，所以不打扰；
> 它把每件事放进**独立的话题**里做，所以不串线；
> 它在**你指定的机器**上动手，过程**看得见**、结果**由人拍板**。

交互模式借鉴了 Slack 里的 Claude Tag（频道会话 + 话题工作会话），执行层基于 OpenAI Codex App Server，面向飞书/Lark 原生群聊与话题。

---

## 核心能力

### 🧠 记得整个群的主群 Agent
- **每个群一个长期会话**：主群的每一条消息都会入库，没 @ 它的也算；首次启用时还会用机器人身份完整导入群历史和全部话题。
- **被 @ 时增量补给**：把上次之后主群和各话题里的**全部新对话**交给它，不设“最近 20 条”之类的人为上限。积压太多时，近期的保留原文，更早的压缩成要点。
- **可回查原文**：完整记录写入 Agent 工作区的 `history.md`。问到“之前谁说过什么”时，它必须先检索核实，再回答。
- **事实不靠猜**：机器归属、授权、任务状态以系统数据库快照为准，不从聊天里推断。
- **群记忆**：一句“记住：周报一律用表格”就会长期生效，可以查看、更正、删除。

### 🤫 克制的主动性
- 默认保守：大多数没 @ 的消息它都不回应。只有有人明确提出它能直接解决的需求，或者它一条消息就能答清时，才会在那条消息下的话题里简短回复一次。
- **约 100 条暂停跟读**：自它上次参与后，又累积了约 100 条它没参与的消息，就暂停逐条判断，只入库，有人 @ 后恢复。这样既控制成本，又不被闲聊稀释，也不会乱插话。
- 一句话就能切换“只在被 @ 时回复”，也可以只让某个话题保持安静。

### 🧵 话题即会话，互不串线
- 每个话题有自己的工作区、Codex 会话和执行容器，不同任务的上下文彼此隔离。
- **话题里不用 @**：任何获准成员都可以直接接着聊、补需求；动手改代码仍需负责人、Leader 或执行协作者的身份。
- **主群里补一句也能找到对的话题**：Agent 会判断这句话补充的是哪个任务。任务正在跑就插话进当前回合；刚跑完就在原话题里接着执行；发话人没有执行权时 @ 负责人确认。主群里不出声，只点一个表情表示已转交。
- 也可以明确指定：在主群引用某个话题的消息，或者 @ 机器人说“修正一下导入那个话题”。

### 📋 从讨论到分工
- 聊了三十句、意见统一了，@ 它说“总结一下，按讨论分工”：它会给出结论，以及 **@ 到具体人的分工清单**，并自动记下新确定的约定。
- 再说一句“按这个分工开话题”：每项分工开成独立话题，负责人就是被分配的人。负责人回复后才开始，不会自动执行。

### 💬 自然语言就是界面
- 授权、停止、进度、接受/退回、换机器、换模型、读附件、出 Markdown……全部由 Bridge 上的意图模型理解，不需要背命令格式。
- **AI 只负责理解，权限由代码把关**：被授权人只认实际 @ 到的获准成员；模型不能扩大任何权限。意图模型不可用时，不执行任何有副作用的操作。
- 唯一例外：任务话题里只发“停止”，不经过任何模型，立即生效。

### 🖥️ 你的机器，你的规则（Runner）
- 同一个机器人可以把任务派给**团队服务器**，也可以派给**成员自己的电脑**。Runner 主动通过 HTTPS 长轮询领取任务，成员电脑不需要公网 IP。
- “在我电脑上修一下”会选发言人自己的机器；“用团队沙箱”会选服务器；没说就默认用服务器。
- **使用权分开授权**：自己的机器自己能用，主人或 Leader 可以授权给别人；团队服务器对所有获准成员开放。
- 一次配对，凭据可撤销；租约、独立看门狗、事件去重、分块成果校验、断线补传；不会自动换机器，也不会盲目重跑。
- 只讨论过的话题，第一次执行时可以迁到选定的机器，并带上之前的讨论；执行过之后就固定在这台机器上。

### 👀 看得见的进度，由人拍板
- 收到任务就点表情；回执卡片在**原地边做边打勾**：显示 Codex 自己列出的步骤（✅ / 🔄 / ⬜）、最近的命令、改动的文件、固定检查和用时。
- 卡片上有“停止”按钮；执行完成后可以直接“接受”，或填写意见后“退回”。
- 结果以飞书卡片呈现（渲染 Markdown、按状态显示颜色），并附上 diff 与新文件打包。业务仓库**不会被自动 push 或 merge**。

### 🔀 模型随手换
- 一句话（“用 Astra、高强度”）、群默认设置卡片、话题里的下拉框，三种方式都可以。
- 优先级：本轮 > 本话题 > 本群默认 > 系统默认。机器主人可以用白名单限定可用模型。

### 🔒 安全与可靠
- 任务在 Docker 沙箱里执行：非 root、只读根文件系统、去掉所有特权；限制 CPU、内存、进程数和时长；出网只走白名单代理。
- 联网搜索由模型服务端完成，不放宽容器网络。
- 容器里没有飞书凭据、GitHub 凭据、宿主 HOME、控制数据库或 Docker socket。
- 先持久化结果再投递；发送失败只补发，不重跑模型；状态不确定时标记待核对，不冒称成功；全程留有审计记录。

---

## 架构

```text
           飞书群（主群时间线 + 原生话题）
                     ▲      │  长连接：消息事件 + 卡片回调
                     │      ▼
┌──────────────────────────── Bridge ────────────────────────────┐
│ 意图模型（快）：路由 / 授权 / 主动判断 / 压缩                    │
│ 群会话状态：游标、记忆、默认模型；话题会话；任务队列；outbox    │
│ Runner API（HTTPS）：配对 · 长轮询 · 心跳 · 事件/成果           │
└──────────────▲─────────────────────────────────▲────────────────┘
               │ Runner 主动连接                  │
   ┌───────────┴───────────┐         ┌───────────┴───────────┐
   │ team-runner（服务器） │         │ 成员电脑（Mac/Linux） │
   │ · 主群 Agent 会话     │         │ · 话题任务            │
   │ · 话题任务            │         │                       │
   └───────────┬───────────┘         └───────────┬───────────┘
               ▼                                 ▼
     每回合独立 Docker 容器：Codex App Server（固定版本）
     持久工作区卷 + Codex 状态卷 · 出网白名单代理
```

- **Bridge** 只持有飞书凭据和意图模型 Key，负责理解、授权、派发、投递。
- **Runner** 持有节点凭据和本机的模型 Key，负责隔离执行，以及保存工作区和 Codex 会话。
- 模型推理发生在 `baseUrl` 指向的服务（需兼容 OpenAI **Responses** 流式协议）；文件和命令在所选 Runner 上执行。

---

## 快速开始（How to start）

下面带你从零搭一套最小可用环境：**一台 Linux 服务器同时运行 Bridge 和 `team-runner`**，在飞书测试群里跑通主群 Agent 与话题任务。成员电脑接入放在第 10 步。

### ⚡ 一键初始化（推荐）

先完成下文第 4 步“创建并配置飞书应用”（权限、事件、卡片回调、发布版本），然后：

```bash
git clone https://github.com/hudikiller/roundtable.git /opt/roundtable && cd /opt/roundtable
npm ci && npm run build
npm run init
```

向导会一步步带你完成：
1. 检查环境（Node 24、Docker、Git、OpenSSL）；
2. 填写飞书凭据和模型服务（密钥输入时不显示）；
3. **自动识别测试群和成员**：只要在群里 @ 一次机器人；
4. 生成证书、示例项目、`config.json` 和 `.env`；
5. 在本机登记 `team-runner`；
6. 可选：构建镜像、运行免费诊断和真实模型诊断、安装并启动 systemd 服务。

它不会覆盖已有配置，也支持用 `RT_*` 环境变量配合 `npm run init -- --yes` 做无人值守部署。下面的分步说明适合想了解细节或自定义部署的读者。

### 0. 准备

| 需要 | 说明 |
|---|---|
| Linux 服务器 | Node.js **24**、npm、Git、Docker Engine（cgroup v2）、OpenSSL |
| 飞书自建应用 | 可以创建应用、发布版本的企业账号 |
| 模型服务 | 兼容 OpenAI Responses API（含流式）。建议准备两个模型：一个快的用于意图识别，一个强的用于编码 |

### 1. 获取代码并构建

```bash
git clone https://github.com/hudikiller/roundtable.git /opt/roundtable
cd /opt/roundtable
npm ci
npm run build
npm test
```

### 2. 构建任务镜像

```bash
npm run image:build      # 生成 feishu-codex-task:runner-v1（内含固定版本 Codex 0.153.4）
```

**可选：** 如果你的编码模型不在 Codex 内置列表里，Codex 会提示 “Model metadata for X not found”，上下文窗口和搜索工具会退回默认值。可以从你本机 Codex 的模型目录里提取元数据，再重新构建镜像：

```bash
node scripts/extract-model-catalog.mjs ~/.codex/model_catalog.json your-coding-model
npm run image:build
```

### 3. 初始化示例项目

Runner 只在**独立的 Git 仓库**里工作。先把自带的 FeedbackDesk 示例复制成一个独立仓库，用来跑通流程：

```bash
npm run fixture:init      # 生成 data/fixture-repo（独立 Git 仓库），示例配置已指向它
```

接入你自己的项目时，把 `repositories` 和 Runner 的 `projects` 改成该仓库的绝对路径即可。Runner 只读取它的提交，不会修改你的本地工作区。

### 4. 创建并配置飞书应用

在 [飞书开放平台](https://open.feishu.cn/app) 创建企业自建应用，然后：

1. **添加应用能力 → 机器人**。
2. **权限管理**：按下表开通。权限名称以控制台显示为准：

   | 用途 | 权限 |
   |---|---|
   | 接收群里 @ 机器人的消息 | `im:message.group_at_msg` |
   | 读取群里所有消息（主群 Agent 需要） | `im:message.group_msg` |
   | 以机器人身份发消息、发卡片、回复话题 | `im:message:send_as_bot` |
   | 读取历史消息与话题（历史导入、回查） | `im:message`（或只读 `im:message:readonly`） |
   | 下载消息中的图片和文件 | `im:resource` |
   | 给消息点表情 | `im:message.reactions:write_only`（或包含表情回应的消息权限） |

3. **事件与回调**：
   - 事件配置：订阅方式选「使用长连接接收事件」，添加 **接收消息 `im.message.receive_v1`**；
   - 回调配置：订阅方式选「使用长连接接收回调」，添加 **卡片回传交互 `card.action.trigger`**。
4. **版本管理与发布**：创建版本并发布，必要时等待管理员审核。
5. 把机器人拉进测试群。

> 同一个应用同一时间只能有一个程序消费长连接事件。测试和生产请用不同的应用，或者先停掉旧服务。

### 5. 生成 Bridge 的 TLS 证书

Runner 通过 HTTPS 连接 Bridge。用自带工具生成私有 CA 和服务端证书（SAN 为 `127.0.0.1` 和 `localhost`）：

```bash
npm run runner:tls -- /opt/roundtable/data/tls
```

CA 私钥只留在服务器；只把 `ca.crt` 分发给 Runner。

### 6. 配置 Bridge

```bash
cp config.example.json config.json
cp .env.example .env && chmod 600 .env config.json
```

编辑 `.env`：填写飞书 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`，以及意图模型的 `BRIDGE_MODEL_API_KEY`。

编辑 `config.json`：

| 字段 | 怎么填 |
|---|---|
| `tenantId` | 消息事件里的 `tenant_key` |
| `allowedChats` | 测试群的 `chat_id`（`oc_…`） |
| `allowedMembers` / `leaders` | 成员的 `open_id`（`ou_…`）。Leader 必须同时是成员 |

> **怎么拿到这三类 ID：** 先用占位值启动 Bridge（第 7 步），让每位成员在测试群里 @ 一次机器人。日志里会出现
> `message_ignored`，并带上 `tenantId`、`chatId`、`senderId`，把它们填回配置后重启即可。
| `runnerBridge.intentModel` | 快模型的 `baseUrl` 和 `model` |
| `runnerBridge.defaults` / `models` | 默认编码模型、思考强度，以及卡片上可选的模型 |
| `repositories` | 允许的项目别名。第一次可以直接用自带的 `fixtures/feedbackdesk` |

`provider` 字段在 Bridge 模式下不会调用，保留示例里的占位值即可：真正的编码模型配置在 Runner 上。

### 7. 启动 Bridge

```bash
FEISHU_CODEX_CONFIG=/opt/roundtable/config.json node dist/src/main.js
```

看到日志 `service_ready` 就说明启动成功。如果启用了主群 Agent，几十秒后还会出现 `group_history_imported`。长期运行请使用 `deploy/roundtable.service`。

### 8. 接入 `team-runner`（服务器节点）

1. **签发一次性配对码**（10 分钟有效，只在可信终端里使用）：

   ```bash
   FEISHU_CODEX_CONFIG=/opt/roundtable/config.json npm run runner:admin -- pair <Leader的open_id> team-runner
   ```

2. **准备节点配置**，并用配对码完成配对：

   ```bash
   mkdir -p /opt/roundtable/runner && cd /opt/roundtable/runner
   cp ../runner.example.json template.json        # 按需修改 provider、projects、sandbox
   echo "CODEX_MODEL_API_KEY=你的编码模型Key" > .env && chmod 600 .env
   node -e 'const t=require("./template.json");t.code=process.argv[1];process.stdout.write(JSON.stringify(t))' "<配对码>" \
     | FEISHU_RUNNER_CONFIG=/opt/roundtable/runner/runner.json npm --prefix /opt/roundtable run runner:setup
   ```

3. **诊断**。两项都通过，节点才会接任务：

   ```bash
   cd /opt/roundtable
   FEISHU_RUNNER_CONFIG=/opt/roundtable/runner/runner.json npm run runner:doctor             # 免费：Docker、隔离、内存 OOM、TLS、项目
   FEISHU_RUNNER_CONFIG=/opt/roundtable/runner/runner.json npm run runner:doctor -- --live   # 付费：真实模型 + 真实 shell 工具调用
   ```

4. **运行**。长期运行请使用 `deploy/roundtable-runner.service`：

   ```bash
   FEISHU_RUNNER_CONFIG=/opt/roundtable/runner/runner.json npm run runner
   ```

5. 确认节点已经在线：

   ```bash
   FEISHU_CODEX_CONFIG=/opt/roundtable/config.json npm run runner:admin -- nodes
   ```

`team-runner` 由 Leader 登记，并且列在 `sharedNodes` 里，因此所有获准成员都能使用。

### 9. 在飞书里试一试

```text
（主群里先不 @，随便聊几句关于导入规则的讨论）
@机器人 总结一下我们刚才说的，按讨论分个工
@机器人 按这个分工开话题
（在自己的分工话题里，不用 @）开始，按要求改并跑 node --test
@机器人 设置
```

预期效果：
- 提问消息上会出现表情；
- 回答发在这条消息的话题里；
- 执行时回执卡片会边做边打勾，结束后结果卡片上有“接受 / 退回”按钮。

### 10. 接入成员电脑（可选）

成员电脑上需要 Node 24，以及一个**Linux 容器运行时**。macOS 推荐专用的 Colima profile，避免动到个人默认的 Docker 环境：

```bash
brew install node@24 docker colima
colima start feishu-codex --cpus 4 --memory 6 --disk 20 --vm-type vz
docker --context colima-feishu-codex build -t feishu-codex-task:runner-v1 -f docker/task.Dockerfile .
```

网络连通：Bridge 只监听 `127.0.0.1`。推荐用一个**只允许本地转发**的 SSH 账户把它映射到电脑本机，例如：

```bash
ssh -N -L 127.0.0.1:19443:127.0.0.1:9443 runner-forward@your-server
```

然后在节点配置里填：
- `bridgeUrl: https://127.0.0.1:19443`；
- `sandbox.dockerContext: colima-feishu-codex`；
- `ownerId` 填这台电脑主人的 `open_id`。

配对、诊断、运行与第 8 步相同。配好之后，这位成员在群里说“在我电脑上……”，任务就会派到他的电脑。别人要用这台电脑，需要主人或 Leader 授权（“把我的电脑给 @某人 用一下”）。

更完整的运维说明，包括 macOS LaunchAgent、VPN 假 DNS 处理、撤权、备份恢复和迁移，见 [docs/RUNNER_OPERATIONS.zh-CN.md](docs/RUNNER_OPERATIONS.zh-CN.md)。

---

## 日常用法

| 想做的事 | 怎么说（自然语言即可） |
|---|---|
| 问问题 / 让它总结 | `@机器人 总结一下我们刚才说的` |
| 分工、开话题 | `@机器人 按讨论分个工` → `@机器人 按这个分工开话题` |
| 让它改代码 | `@机器人 帮我把导入改成整批失败并跑测试` |
| 选机器 | `在我电脑上修一下…`、`用团队沙箱做…`、`在 Air 上跑…` |
| 选模型和强度 | `用 Astra、高强度…`、`这次想深一点`、`这个话题换成 Sol`、`@机器人 设置` |
| 话题里继续 | 直接说，不用 @ |
| 主群里修正某个话题 | 引用那个话题的消息说，或 `@机器人 修正一下导入那个话题：…` |
| 进度 / 停止 | 话题里说 `进度`；只发 `停止`；或点卡片上的按钮 |
| 验收 | 结果卡片上点“接受”，或填写意见后点“退回” |
| 授权机器 | `把我的 Mac mini 给 @某人 用一下`、`取消 @某人 用 Air 的权限` |
| 授权执行协作者 | `让 @某人 也能推进这个任务` |
| 群记忆 | `记住：…`、`你记得这个群什么`、`忘掉第 2 条` |
| 主动程度 | `以后只在被 @ 时回复`、`这个话题别再自动回复了` |
| 归档 / 删除工作区 | `这个任务归档吧`、`把工作区删掉`（两步确认） |

---

## 配置参考

完整字段见 `src/config.ts`（Bridge）与 `src/runner/config.ts`（Runner）。常用项：

| 字段 | 默认 | 说明 |
|---|---|---|
| `runnerBridge.intentModel` | — | Bridge 意图模型。配置后所有意图交给 AI；未配置时退回固定格式命令 |
| `runnerBridge.groupAgent.enabled` | `false` | 开启主群 Agent |
| `runnerBridge.groupAgent.pauseAfter` | `100` | 累计多少条未参与消息后暂停逐条判断 |
| `runnerBridge.groupAgent.feedBudgetChars` | `60000` | 单次增量补给预算，超出部分压缩 |
| `runnerBridge.groupAgent.webSearch` | `true` | 群会话联网搜索（由模型服务端完成） |
| `runnerBridge.groupAgent.ackEmoji` | `OnIt` | 收到任务时点的表情 |
| `runnerBridge.defaults` | — | 默认模型和思考强度（`low`、`medium`、`high`、`xhigh`） |
| `runnerBridge.models` | Sol、Astra | 可选模型（聊天与卡片里都能选） |
| `runnerBridge.sharedNodes` | `["team-runner"]` | 对所有获准成员开放的节点（必须由 Leader 登记） |
| `runnerBridge.defaultNode` | — | 未指定机器时使用的节点 |
| `concurrency` | `2` | 全局并发回合数；每个节点并发由 Runner 的 `capacity` 决定 |
| Runner `allowedModels` | 不限 | 这台机器允许使用的模型 |
| Runner `sandbox.*` | 2 CPU / 4 GiB / 30 分钟 | 每个任务容器的资源上限；磁盘为 2 秒一次的监测预算 |

不配置 `runnerBridge` 时为**单机兼容模式**：Bridge 直接在本机 Docker 中执行，适合最小实验。

---

## 开发

```bash
npm test                 # 单元与协议模拟测试
npm run build            # TypeScript 构建
npm run protocol:generate  # 由固定版本 Codex 生成 App Server 协议类型
FEISHU_RUNNER_CONFIG=… npm run test:sandbox   # 真实 Docker 隔离与资源检查（不调用模型）
```

贡献约定见 [AGENTS.md](AGENTS.md)。模拟测试、真实模型与真实飞书验收请分开报告。设计说明见 [docs/GROUP_AGENT_DESIGN.zh-CN.md](docs/GROUP_AGENT_DESIGN.zh-CN.md)。

## 已知限制与路线图

- 任务容器内的 Codex 能读到模型 Key。Docker 不能对同容器里的代码隐藏密钥，请使用专用的、限额的 Key。
- 磁盘预算是监测终止，不是硬配额。
- Bridge 的 TLS 证书只覆盖 `127.0.0.1` 和 `localhost`，远程节点请经 SSH 本地转发或 VPN 访问。
- 飞书权限名称和控制台入口会随版本变化，以开放平台为准。
- 路线图：
  - 托管 HTML 报告页 + 链接预览卡片；
  - GitHub 草稿 PR（凭据只在 Runner 一侧）与负责人 AI 审查；
  - 定时进度汇总、截止提醒、偏差与冲突提醒。

---

## English

Roundtable is an AI teammate for Feishu/Lark that listens to the whole room, speaks rarely, and turns discussions into delivered work. It pairs one long-lived group agent with isolated topic sessions and Codex runners on machines you choose. **Full English documentation: [README.en.md](README.en.md).**

## 致谢与声明

- 交互模式受 Slack 中 Claude Tag 的频道会话与话题工作会话启发；执行层基于 [OpenAI Codex](https://github.com/openai/codex) App Server，飞书接入基于官方 [Channel SDK](https://www.npmjs.com/package/@larksuite/channel)。
- 本项目与 Anthropic、OpenAI、字节跳动（飞书 / Lark）均无隶属或合作关系。相关名称和商标归各自所有者所有。
- `src/protocol/` 由固定版本的 `@openai/codex`（Apache-2.0）生成；第三方许可说明见 [NOTICE](NOTICE)。
- 本项目会让 AI 在你的机器上执行代码。请先在测试群和示例仓库中试用，并阅读 [SECURITY.md](SECURITY.md) 中的安全模型。

## 参与贡献

欢迎提交 Issue、讨论和 PR，参见 [CONTRIBUTING.md](CONTRIBUTING.md)。如果 Roundtable 对你的团队有帮助，点一个 ⭐ 就是最好的支持。

## License

[MIT](LICENSE)
