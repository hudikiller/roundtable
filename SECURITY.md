# 安全策略 Security Policy

## 报告漏洞
请**不要**在公开 Issue 中披露安全问题。请使用 GitHub 的
[私密漏洞报告](https://github.com/hudikiller/roundtable/security/advisories/new)，
附上影响范围、复现步骤与版本。我们会尽快确认并在修复后致谢。

## 安全模型（请在部署前阅读）
Roundtable 会让 AI 在你指定的机器上读写代码、执行命令。我们的设计边界：

- **权限由代码校验，不由模型决定**：意图模型只负责理解；执行、授权、验收都要通过成员 / Leader / 协作者 / 节点授权的交集校验。
- **执行隔离**：每回合在 Docker 容器中运行，非 root、只读根文件系统、去掉全部 capabilities；限制 CPU、内存、进程数和时长；出网只走允许列表代理，私网和元数据地址被拦截。
- **凭据分离**：飞书凭据只在 Bridge；节点凭据和模型 Key 只在 Runner；容器内没有飞书或 GitHub 凭据、宿主 HOME、Docker socket 和控制数据库。
- **不自动发布**：不会自动 push、创建 PR、merge 或部署。

已知限制：
- 任务容器内的 Codex **可以读取模型 Key**（Docker 无法对同容器代码隐藏密钥），请使用专用、限额、可随时吊销的 Key。
- 磁盘预算是监测后终止，不是硬配额。
- 群聊内容、附件和仓库文件都可能包含提示注入；Roundtable 把它们当作数据，并不能保证模型永远不受影响，因此权限与沙箱才是最后一道防线。
- 请只把机器人加入可信成员所在的群，并为 `allowedMembers`、`leaders` 配置最小必要范围。
