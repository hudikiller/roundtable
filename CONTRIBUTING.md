# 参与贡献 Contributing

感谢你愿意让 Roundtable 变得更好！Thanks for helping improve Roundtable.

## 开始之前
- 先搜一下 [Issues](https://github.com/hudikiller/roundtable/issues) 和 [Discussions](https://github.com/hudikiller/roundtable/discussions)，避免重复。
- 较大的改动（新的交互方式、协议、数据结构）请先开 Issue 或在 Discussions 里讨论方案，再动手。

## 本地开发
```bash
npm ci
npm test          # 单元与协议模拟测试（不调用模型、不连飞书）
npm run build     # TypeScript 构建
```
需要真实 Docker 的检查见 README 的“开发”一节。真实模型、真实飞书的验证请在**测试群与测试应用**中进行。

## 提交 PR
- 一个 PR 只做一件事；附上动机、改动说明和验证方式。
- 新行为请补测试。修 bug 时，先写一个能复现问题的失败测试。
- 不要削弱权限或安全校验来让测试通过；涉及权限、沙箱、凭据的改动请在 PR 中单独说明。
- **永远不要提交**：凭据、`.env`、真实 `config.json`、聊天记录、成员 ID、`data/` 下的任何运行数据。
- 报告结果时请区分：模拟测试 / 真实模型 / 真实飞书 / 真人验收。

## 代码风格
- TypeScript（Node 24，ESM），沿用周围代码的命名与注释密度；面向用户的文案使用简体中文。
- 保持依赖精简，`@openai/codex` 版本固定，升级需同时重新生成 `src/protocol/` 并通过真实验证。

## 行为准则
参与本项目即表示同意遵守 [行为准则](CODE_OF_CONDUCT.md)。
