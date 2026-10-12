# 三节点 Runner 安装与运维

## 职责及数据边界

飞书是协作入口；Bridge 保存成员授权、任务队列、租约、事件和投递 outbox。
Runner 通过 HTTPS 主动领取任务，本机保存执行账本、原始 Codex thread ID、项目白名单、
模型 Key 和工作区。机器名称是显示名，配对后 UUID 才是持久节点身份。

每个任务有独立 Git 工作区卷和 Codex 状态卷。每回合创建容器，结束后释放进程和网络；
下一回合恢复该任务的实际 thread ID。不会使用 `resume --last`，不会自动换机器或重新执行
失去确认的回合。模型推理仍发生在节点配置的 Base URL 指向的服务。

Bridge 仅需飞书凭据；Runner 仅需节点凭据和项目模型 Key。任务容器没有控制数据库、
Docker socket、宿主 HOME、个人整个仓库管理目录、飞书凭据或 GitHub 凭据。
任务内的模型凭据仍可能被任务代码读到；Docker 不提供同容器代码之间的秘密隔离。
新增 Git 网络凭据应留在 Runner 编排端，并经独立评审后集成，本版不自动 push/PR/merge/部署。

## Bridge 独立安装

使用 Node 24：

```sh
npm ci
npm run build
npm test
npm run runner:tls -- ./data/tls
```

从 `config.example.json` 建立专用配置，保持 `replyMode: "thread"`，
填入实际租户、允许群、允许成员和 Leader。在配置中增加：

```json
{
  "runnerBridge": {
    "port": 9443,
    "certFile": "/absolute/private/data/tls/bridge.crt",
    "keyFile": "/absolute/private/data/tls/bridge.key",
    "enrollmentKeyFile": "/absolute/private/data/enrollment.key",
    "projectDefaults": { "feedbackdesk": "team-runner" },
    "feishuEnabled": false
  }
}
```

API 只监听 `127.0.0.1`，不开放公网。Bridge 的 `provider` 保留兼容配置结构，可用
`https://unused.invalid/v1` 和 `node-only`；真正 provider 仅在节点。Bridge `.env` 只填写
`FEISHU_APP_ID`、`FEISHU_APP_SECRET`。先以 `feishuEnabled: false` 做技术验收；
生产消费者切换必须执行后文单消费者窗口。
显式指定节点优先于项目默认节点，再其次为 `defaultNode`（建议配置为 `team-runner`）。
两者都未配置时机器人会询问一次节点选择；没有授权或节点离线时不自动换机器。
原请求及附件保留在原话题，负责人再次 @ 回复“在 Mac mini 上”即可继续原授权。
不需要重新粘贴需求；等待选择时可以用“停止”取消尚未派发的请求。

```sh
FEISHU_CODEX_CONFIG=/absolute/private/config.json npm start
```

CA 私钥只留在可信服务器。向节点分发的仅是 CA 公共证书；通过已验证 SSH 通道核对
SHA-256 指纹。服务端证书有 `IP:127.0.0.1` SAN；Runner 客户端只额外信任该 CA，
不关闭 TLS 校验、不修改操作系统全局信任。提前轮换一年有效期的证书，保留回退副本。

## Mac 网络及环境

现有 SSH `-R` 通道只作管理员安装和诊断。业务使用另一组专用账户、密钥及 LaunchAgent：

```text
Mac Runner → https://127.0.0.1:19443
             SSH -L 127.0.0.1:19443:127.0.0.1:9443
             → SSH 服务端网络命名空间中的 Bridge
```

必须核实 SSH 服务端和 Bridge 实际可达，不能仅靠宿主名称推断。专用账户配置
`AllowTcpForwarding local`、`PermitOpen 127.0.0.1:9443`、`PermitListen none`，
禁止 StreamLocal、Tunnel、PTY、agent/X11 转发、密码登录。不要扩大原 `-R` 凭据权限。
Mac 业务隧道私钥由 Mac 生成并留在 Mac；服务器仅接收其公钥。

成员电脑上的 Runner 目录建议使用 `~/Library/Application Support/FeishuCodex/runner`（macOS），
其中放 `runner.json`、`.env`、`state/` 和编译好的程序；转发用的私钥由这台电脑生成并留在本机。

Node 24 采用 Homebrew keg 独立路径，不替换全局 Node。已有合格 Docker 可复用，
否则使用专用 Colima profile：

```sh
brew install node@24 docker colima
colima start feishu-codex --activate=false --cpus 4 --memory 6 --disk 20 \
  --vm-type vz --mount-type virtiofs \
  --mount "$HOME/Library/Application Support/FeishuCodex/colima-shared:w"
docker --context colima-feishu-codex info
```

先创建上述空目录。只共享专用目录，避免默认整个 HOME 共享；核对实际 VM mount 配置。
每条 Runner Docker 命令显式使用 `colima-feishu-codex`，不修改默认 context。
服务器（amd64）与 Apple Silicon（arm64）需要分别在本机构建镜像：

```sh
docker --context colima-feishu-codex build -t feishu-codex-task:runner-v1 \
  -f docker/task.Dockerfile .
```

镜像固定 Codex 0.153.4。Mac 现有宿主 Codex CLI 版本不影响容器，不作为验收依据。
模型及检查容器非 root、无特权、只读根文件系统；CPU、内存、pids、时长及工作区预算
在本机执行。Docker 卷预算是两秒监测，尤其 `vfs` 不是硬磁盘配额。
所有任务阶段（导入、模型、代理、检查、导出）都设置内存及 swap 上限。
为兼容 systemd/runc 对零 swap 的处理，额外使用
`org.systemd.property.MemorySwapMax=uint64 0` 注解；免费诊断同时检查实际
`memory.swap.max=0` 和受限容器的真实 OOM，不能仅凭 Docker inspect 参数判定有效。

## 配对、项目与诊断

由 Bridge 的可信本地管理员为真实获准成员创建一次配对码：

```sh
FEISHU_CODEX_CONFIG=/absolute/private/config.json \
  npm run runner:admin -- pair APPROVED_MEMBER_OPEN_ID mac-mini
```

10 分钟有效，原子消费。码只通过可信终端或 SSH stdin 传递，不放群消息。
节点使用 `runner.example.json` 建立专用模板，登记实际项目别名、绝对路径、ref 和固定检查；
将 `code` 作为模板额外字段通过 stdin 交给 `runner:setup`。
工具写入 `runner.json`、节点 UUID 和撤销凭据，权限 0600。相同配对请求丢回执可重试，
完成后重新运行 setup 仅回报既有节点，不静默换配置。

Runner `.env` 在 `runner.json` 同目录，只存必要项目模型 Key：

```text
CODEX_MODEL_API_KEY=YOUR_PROJECT_KEY
```

```sh
npm ci
npm run build
FEISHU_RUNNER_CONFIG=/absolute/private/runner.json npm run runner:doctor
FEISHU_RUNNER_CONFIG=/absolute/private/runner.json npm run runner:doctor -- --live
FEISHU_RUNNER_CONFIG=/absolute/private/runner.json npm run runner
```

免费诊断检查网络、TLS、节点身份、Git ref、Docker 资源、原生架构、固定版本和隔离；
`--live` 才调用真实 Responses 流式 API 和工具。普通聊天成功不算兼容性通过。
配置或 Key 改变后必须重新 live 诊断，未通过的节点只同步状态、不接模型任务。
任务初始化/恢复钩子只使用本机配置的批准版本；配置版本变化不会隐式迁移已有任务。
启用新版内存诊断后，旧诊断缓存也会失效，需要重新完成免费和 live 诊断。

若 macOS 的 VPN 返回 `198.18.0.0/15` 等假 DNS 地址，可在本机节点配置
`sandbox.egressAddresses`，为已经允许的模型域名登记从可信网络独立解析的公共 IP，
最多 16 个。代理仍校验公共地址，TLS 仍验证原域名；固定 IP 不新增域名授权，
不放行私网或元数据地址。DNS/CDN 变化时在节点本机重新核对，更新后重新诊断。
不修改系统 DNS。

macOS 上建议用两个 LaunchAgent：`com.feishucodex.https-forward`（SSH 本地转发）和
`com.feishucodex.runner`（Runner 常驻）。Runner 的 plist 示例：

```xml
<dict>
  <key>Label</key><string>com.feishucodex.runner</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/opt/node@24/bin/node</string>
    <string>/Users/you/Library/Application Support/FeishuCodex/runner/runtime/dist/src/runner/cli.js</string>
    <string>run</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>FEISHU_RUNNER_CONFIG</key><string>/Users/you/Library/Application Support/FeishuCodex/runner/runner.json</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>AbandonProcessGroup</key><true/>
</dict>
```

Runner 设置 `AbandonProcessGroup`，使独立看门狗能在 Runner 退出后清理受管容器。
LaunchAgent 在当前登录用户会话中启动；电脑睡眠、注销和网络断开时不得假称在线。
按任务 lease 的墙钟及单调时钟双重期限处理唤醒后的过期执行，恢复前先对账。
重启 Mac 后如专用 Colima VM 未运行，先按上述命令启动该 profile，再重启 Runner
LaunchAgent；当前不修改个人默认 VM，也不将 Docker 不可用的节点标为就绪。

## 群内协作与授权

```text
@机器人 节点
@机器人 在我电脑上帮我修复 feedbackdesk 的导入冲突
@机器人 用团队沙箱实现统计页面
@机器人 把我的 Mac mini 给 @成员 用一下
@机器人 取消 @成员 用 Mac mini 的权限
```

主群未 @ 的消息只作背景；已有任务话题内的消息免 @ 接续该会话。未指定机器时使用
服务器 `team-runner`（`runnerBridge.sharedNodes` 中且由 Leader 登记的节点对所有获准成员开放）。
“在我电脑上”选择发言人自己登记的机器，点名机器则用该机器；离线、隔离未通过或无授权时
明确说明，不降级到另一台机器。只讨论过的话题第一次执行时可以迁到所选机器并携带已有问答；
执行过之后固定在原机器，另开话题选择其他机器。

授权与撤权用自然语言表达，由 `runnerBridge.intentModel` 配置的 Bridge 模型识别意图，
被授权人只以消息中实际 @ 的获准成员为准；机器主人或 Leader 才能授权，模型不能扩大权限。
Bridge 的意图识别 Key 写在 Bridge 本机 `.env`（默认 `BRIDGE_MODEL_API_KEY`），
不进入 Runner、任务容器或群消息。未配置该模型时回退为固定格式
`节点授权 <机器> <项目> @成员`。任务执行仍需负责人/Leader/已授权协作者身份，并有节点及项目使用权。

```text
@机器人 允许执行 @成员
@机器人 撤销执行 @成员
@机器人 插话 当前回合改为先核对冲突
停止
进度
@机器人 接受
@机器人 退回 补充回滚检查
```

节点共享和任务执行协作者是两种不同授权。插话绑定实际 run/generation/turn ID；
已结束时拒绝，回执不确定时不重发，也不改成新回合。停止只有确认容器及其子进程结束后
才回复“已停止”。模型结束、检查、成果保存、飞书送达和人工接受分别记录。
外侧话题入口使用客户端个人消息展示规则调整，群内继续原生话题。

## 主群 Agent（群会话）

模仿 Claude Tag：每个群有一个长期群会话，跑在服务器 `team-runner` 上；每个话题是独立工作会话。设计与进度见
[GROUP_AGENT_DESIGN](GROUP_AGENT_DESIGN.zh-CN.md)。在 Bridge 配置中启用：

```json
"runnerBridge": {
  "intentModel": { "baseUrl": "https://provider.example/v1", "model": "MODEL", "keyEnv": "BRIDGE_MODEL_API_KEY" },
  "sharedNodes": ["team-runner"],
  "groupAgent": { "enabled": true, "node": "team-runner", "pauseAfter": 100, "ackEmoji": "OnIt", "webSearch": true }
}
```

- 主群：
  - 所有消息入库，首次启用时按机器人身份导入群历史；
  - 顶层 @ 交给群会话，带自上次以来主群与各话题的全部新对话、系统状态快照和群记忆；
  - 完整记录在群会话工作区 `.group/history.md`，供模型检索。
- 主动说话：
  - 未 @ 消息由 Bridge 意图模型判断 none / reply / handoff，默认保守；
  - 累计 `pauseAfter` 条未参与即只入库，有人 @ 后恢复；
  - 成员可用自然语言切换“只在被 @ 时回复”。
- 总结与分工：
  - 群会话结构化输出正文、待记住事实与 @ 分工；
  - “按这个分工开话题”为每项发群消息，建立负责人所有的话题。
- 联网：群会话回合由 provider 服务端搜索，容器出网白名单不变。
- 唯一不经模型的命令：任务话题内整条消息为“停止 / !停止 / !stop”。

## 断联、重启、撤权、清理

默认全局 2、每节点 1、同会话串行，poll 最长 20 秒；heartbeat 独立每 10 秒，
30 秒未见状态显示离线，执行租约 60 秒。本机独立看门狗在父进程消失、lease 到期
或回合达到 30 分钟后清理该节点/run/generation 的容器与网络，不清理其他代次或节点。
Bridge 重启仅对账，不调用旧版整机孤儿清理。

启动意图在调用模型前落 SQLite；重复领取仅回报已有状态。事件按代次/序号持久去重，
旧代次结果隔离保存。结果已完成但附件中断时只重传缺失块，不重新执行模型；
256 KiB/块、最多 4 并行、完整上限 24 MiB，完整 SHA-256 校验后才进入 outbox。
Runner 成果和 Bridge 分块会同步文件及目录，再记录账本/回执，避免确认未落盘的成果。
已报告的结果等待同步时锁定自己的会话，不占其他任务的执行容量。

执行不确定时保留原机器和工作区，标记待恢复。负责人/Leader 必须有原机器授权，
明确使用“恢复”；先确认旧代次结束，再开始新代次，接续本机实际 Codex 会话。
撤销凭据会立即取消尚未领取任务；已领取执行由节点/本机看门狗停止。

```sh
npm run runner:admin -- nodes
npm run runner:admin -- status
npm run runner:admin -- revoke NODE_UUID OWNER_OPEN_ID
```

凭据撤销后的重新配对保留节点 UUID，但签发新 Key；旧 Key 无法 heartbeat 复活。
停止后的工作区保留。归档只标记并保留代码、会话、成果。删除采用两步确认：

```text
@机器人 删除工作区
@机器人 确认删除 机器人返回的确认码
```

确认码十分钟有效，任务变化使旧确认失效。离线时记录待清理，节点实际确认后才显示删除；
不自动删除未验收成果，也不自动清空 Mac 本地原项目。

## 备份、恢复及旧会话迁移

停接新任务，停止并核对所有执行，停 Runner，再停 Bridge。用 SQLite 在线 backup API
备份控制库和每个 Runner 账本，不能只复制正在写入的 `.sqlite` 而遗漏 WAL。

```sh
FEISHU_CODEX_CONFIG=/absolute/private/config.json npm run backup -- /absolute/private/backups
```

额外备份控制端成果目录、CA/Bridge 私钥、配对回执加密根、专用配置及 `.env`；
各节点独立备份本机账本、workspace/state Docker 卷及待上传成果。秘密备份加密并限制
访问，不能放 GitHub。Docker 卷通过非 root 的只读导出容器打包；恢复时保留卷名。

恢复时先核对节点 UUID、CA、配置版本及账本，再恢复其卷/成果；不要复制另一台电脑的
个人配置或把某机器的 thread ID 用在另一机器。Bridge 启动后先对账；不确定执行继续
待恢复。飞书发送期间崩溃的 outbox 保留 `uncertain`，管理员回读消息后补发或记录已送达，
不能重跑模型。`npm run outbox:resolve` 在 Runner 模式同样可用。

从旧版迁移时先停止旧消费者并核对其执行已结束，制作独立数据库、配置和卷备份。
注册 `team-runner` 后，在迁移副本运行：

```sh
npm run runner:admin -- migrate-legacy
```

迁移增加表和 JSON 字段，保留原会话 ID、卷名、基准 commit、thread ID、线程别名和 outbox。
旧会话固定在 `team-runner`；开始后不能换机器。回滚使用迁移前一致性备份及旧程序，
不要让旧程序打开新库后执行其旧式恢复/容器清理。测试期间不修改生产 unit/config/database。

## 切换生产消费者

同一个飞书应用同一时间只能有一个长连接消费者。切换新版本前先确认没有正在执行的任务，
记录旧服务的 unit、配置和提交；停止旧消费者及其自动重启，再启动新 Bridge，
核对只有一个消费者在线。新版本出现问题时，先停止新消费者，再恢复旧服务。

## 技术验证入口

```sh
FEISHU_RUNNER_CONFIG=/absolute/private/runner.json npm run test:sandbox
FEISHU_RUNNER_CONFIG=/absolute/private/runner.json node dist/scripts/runner-resource-smoke.js --live
FEISHU_CODEX_CONFIG=/absolute/private/config.json npx tsx scripts/group-agent-smoke.ts
```

- `test:sandbox`：免费检查实际 OOM、进程数限制、后台进程停止和租约过期清理。
- `runner-resource-smoke --live`：在独立的诊断工作区里把磁盘预算临时设为 16 MiB，用真实工具写入 24 MiB，验证监测能终止任务。
- `group-agent-smoke`：在启用主群 Agent 的 Bridge 上，用隔离的合成群 ID 让真实群会话回答；验证增量补给、`history.md` 回查、结构化分工和联网搜索，不向真实群发消息。
- `npm run test:runner-runtime -- <m0|coding|page|stop|steer|restart|crash> <节点名>`：需要在关闭飞书消费者（`feishuEnabled: false`）的独立配置下运行，所有场景都会调用真实模型。

相关公开接口：

- OpenAI App Server：<https://developers.openai.com/codex/app-server/>
- OpenAI 自定义 provider：<https://developers.openai.com/codex/config-reference/>
- 飞书 Channel SDK 固定发布包：<https://registry.npmjs.org/@larksuite%2fchannel/0.7.1>
- Colima：<https://github.com/abiosoft/colima>
- OpenSSH 手册：<https://www.openssh.com/manual.html>
