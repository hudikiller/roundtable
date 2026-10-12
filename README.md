<div align="center">

# Roundtable

**Give your team its attention back.**

An AI teammate for Feishu/Lark that listens to the whole room, speaks rarely,<br>and turns discussions into delivered work — on machines you choose.

[![CI](https://github.com/hudikiller/roundtable/actions/workflows/ci.yml/badge.svg)](https://github.com/hudikiller/roundtable/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 24](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)
![Feishu / Lark](https://img.shields.io/badge/Feishu%20%2F%20Lark-native-3370FF)

English · [简体中文](README.zh-CN.md) · [Highlights](#highlights) · [Quick start](#quick-start) · [Everyday use](#everyday-use) · [Configuration](#configuration)

</div>

---

## Why

The most expensive thing in a team chat isn't compute. It's **attention**:

- Every time you ask an AI for help, you first retell the last thirty messages.
- When a discussion converges, someone still has to summarise it, split the work and chase progress.
- Someone adds a requirement in the main chat, and the person (and agent) working on it never sees it.
- Bots butt in constantly, or one task's context bleeds into another.

**Roundtable** seats an AI at your team's table like a quiet, dependable colleague:

> It **always listens**, so nobody repeats themselves. It **rarely speaks**, so nobody gets interrupted.
> Each piece of work lives in **its own topic**, so nothing gets tangled.
> It works **on the machine you pick**, its progress is **visible**, and **humans make the call**.

---

## Highlights

### 🧠 A group agent that remembers the whole group
- **One long-lived session per group.**
  - Every main-timeline message is stored, including ones that never mention the bot.
  - The first time it is enabled, the bot imports the full history of the group and of every topic.
- **Incremental context on every mention.** It receives *everything* said in the main timeline and in topics since its last turn, with no "last 20 messages" cap. A large backlog is compressed: recent messages verbatim, older ones as key points.
- **Look up the original.** A complete transcript is written to `history.md` in the agent's workspace. Questions about the past must be checked there before answering.
- **Facts, not guesses.** Machine ownership, grants and task status come from a snapshot of the control database, never from inference.
- **Group memory.** "Remember: weekly reports are always tables" sticks, and anyone can list, correct or remove entries.

### 🤫 Restrained proactivity
- **Conservative by default.** Most unmentioned messages get no response. It replies once, briefly, in a topic under the message, only when:
  - someone states a need it can clearly meet, or
  - it can answer in a single message.
- **Pause after ~100.** After about 100 top-level messages without engaging, it stops judging each message and only stores them until someone mentions it again. This saves cost, keeps idle chatter out of its context and prevents random interjections.
- **Easy to quiet.** One sentence switches the group to "reply only when mentioned", or quiets a single topic.

### 🧵 Topics are sessions — nothing bleeds over
- **Isolation.** Each topic has its own workspace, Codex thread and sandbox.
- **No @ needed inside a topic.** Any allowed member can continue the conversation. Changing code still needs the owner, a Leader or an execution collaborator.
- **Side remarks find the right task.** When someone adds a requirement in the main chat, the agent works out which task it belongs to, says nothing in the main timeline, adds an emoji to the message, and then:
  - **task running** → it steers the current turn;
  - **task just finished** → it continues the task in its topic;
  - **sender may not execute** → it asks the owner.
- **Explicit routing.** Quote a topic's message in the main chat, or say "fix the import topic: …".

### 📋 From discussion to assignments
- **Summary and split.** After thirty messages of agreement, say "summarise and split the work". You get the decisions, an **@-mentioned assignment list**, and the new conventions saved to memory.
- **One topic per item.** Say "open topics for these": each assignment becomes its own topic owned by its assignee. Nothing runs until the owner replies.

### 💬 Natural language is the UI
- **One intent model for everything.** Grants, stop, progress, accept/reject, machine choice, model choice, attachments, Markdown delivery… a fast intent model on the Bridge understands them all. No command syntax to memorise.
- **The model understands; code decides.** Grantees are only the actually @-mentioned allowed members, and the model cannot widen any permission. If the intent model is down, nothing with side effects happens.
- **One deliberate exception.** A bare "停止" (stop) in a topic always works, without any model.

### 🖥️ Your machines, your rules (Runners)
- **Run anywhere.** The same bot dispatches work to a **team server** or to **members' own laptops**. Runners long-poll the Bridge over HTTPS, so laptops need no public IP.
- **Pick a machine in plain words.** "On my computer…" picks the speaker's machine, "use the team sandbox…" picks the server, and the server is the default.
- **Separate grants.** Your own machine is yours to use; its owner or a Leader can grant it to others. The team server is open to all allowed members.
- **Built for unreliable networks.**
  - One-time pairing with revocable credentials.
  - Leases, an independent watchdog, deduplicated events and chunked, checksummed artifacts that resume after disconnects.
  - No silent machine switching, no blind reruns.
- **Move once, then stay.** A discussion-only topic may move to the chosen machine at its first execution, carrying the discussion with it; after that it stays put.

### 👀 Visible progress, human decisions
- **Live checklist.** An emoji acknowledges the request; the task card then **updates in place as work happens**: Codex's own plan steps (✅ / 🔄 / ⬜), recent commands, changed files, fixed checks and elapsed time.
- **Buttons.** Stop from the card; when it's done, **Accept** or **Reject with feedback**.
- **Results.** They arrive as Feishu cards with rendered Markdown and status colours, plus a diff and new files. Business repositories are **never pushed or merged automatically**.

### 🔀 Switch models freely
- **Three ways.** A sentence ("use Astra, high effort"), a group-default settings card, or dropdowns in a topic.
- **Priority:** this turn > topic > group default > system default. Machine owners can allowlist models.

### 🔒 Secure and reliable
- **Docker sandbox for every task.**
  - Non-root, read-only root filesystem, all capabilities dropped.
  - CPU, memory, pids and time limits.
  - Egress only through an allowlisted proxy.
- **Web search without widening egress.** Search happens on the model provider's side.
- **Nothing sensitive in the container.** No Feishu or GitHub credentials, host HOME, control database or Docker socket.
- **Persist first, then deliver.**
  - Delivery failures are retried without rerunning the model.
  - Uncertain states are marked for review, never reported as success.
  - Everything is audited.

---

## Architecture

```text
            Feishu / Lark group (main timeline + native topics)
                     ▲      │  long connection: message events + card callbacks
                     │      ▼
┌──────────────────────────── Bridge ────────────────────────────┐
│ Fast intent model: routing / grants / proactivity / compaction  │
│ Group session state (cursor, memory, defaults), topic sessions, │
│ job queue, outbox                                               │
│ Runner API (HTTPS): enroll · long-poll · heartbeat · events     │
└──────────────▲─────────────────────────────────▲────────────────┘
               │ runners dial out                │
   ┌───────────┴───────────┐         ┌───────────┴───────────┐
   │ team-runner (server)  │         │ member laptop (Mac/Linux)
   │ · group agent session │         │ · topic tasks         │
   │ · topic tasks         │         │                       │
   └───────────┬───────────┘         └───────────┬───────────┘
               ▼                                 ▼
     A fresh Docker container per turn: Codex App Server (pinned)
     persistent workspace + Codex state volumes · allowlisted egress
```

- The **Bridge** holds only the Feishu credentials and the intent-model key. It understands, authorises, dispatches and delivers.
- **Runners** hold their node credential and local model key. They execute in isolation and keep workspaces and Codex threads.
- Inference happens wherever `baseUrl` points (an OpenAI **Responses**-compatible API with streaming). Files and commands live on the chosen Runner.

---

## Quick start

This walkthrough sets up a minimal deployment: **one Linux server running both the Bridge and `team-runner`**, tested in a Feishu group. Member laptops are step 10.

### ⚡ Quick install

Create your Feishu app first (step 4 below: bot, scopes, events, card callback, publish). Then, on a Linux server with Node.js 24 and Docker:

```bash
git clone https://github.com/hudikiller/roundtable.git && cd roundtable && npm ci && npm run build && npm run init
```

Prefer a single script? `curl -fsSL https://raw.githubusercontent.com/hudikiller/roundtable/main/install.sh | bash` does the same.

The wizard walks you through:
1. an environment check (Node 24, Docker, Git, OpenSSL);
2. your Feishu credentials and model provider (secrets are hidden while typing);
3. **automatic discovery of the test group and members**: just @-mention the bot once;
4. generating the certificate, sample project, `config.json` and `.env`;
5. registering `team-runner` on this machine;
6. optionally: building the image, running the free and live diagnostics, and installing the systemd services.

It never overwrites an existing deployment, and supports unattended setup via `RT_*` environment variables with `npm run init -- --yes`. The step-by-step guide below explains every detail for custom deployments.

### 0. Prerequisites

| You need | Notes |
|---|---|
| A Linux server | Node.js **24**, npm, Git, Docker Engine (cgroup v2), OpenSSL |
| A Feishu / Lark self-built app | An organisation account that can create and publish apps |
| A model provider | OpenAI Responses-compatible, with streaming. Ideally a fast model (intent routing) and a strong model (coding) |

### 1. Get the code and build

```bash
git clone https://github.com/hudikiller/roundtable.git /opt/roundtable
cd /opt/roundtable
npm ci
npm run build
npm test
```

### 2. Build the task image

```bash
npm run image:build      # feishu-codex-task:runner-v1 (includes pinned Codex 0.153.4)
```

**Optional:** if Codex says "Model metadata for X not found", copy metadata from your own Codex catalog and rebuild. Without it, context limits and tools such as web search fall back to defaults.

```bash
node scripts/extract-model-catalog.mjs ~/.codex/model_catalog.json your-coding-model
npm run image:build
```

### 3. Create the sample project

Runners work on **standalone Git repositories**. Create one from the bundled FeedbackDesk sample:

```bash
npm run fixture:init      # creates data/fixture-repo; the example configs already point to it
```

For your own project, point `repositories` and the Runner's `projects` at its absolute path. Runners only read its commits and never touch your working tree.

### 4. Create and configure the Feishu app

In the [Feishu Open Platform](https://open.feishu.cn/app) (or [Lark Developer](https://open.larksuite.com/app)), create a self-built app, then:

1. **Add the Bot capability.**
2. **Permissions**: grant the following. Exact names may differ slightly in the console.

   | Purpose | Scope |
   |---|---|
   | Receive @-mentions in groups | `im:message.group_at_msg` |
   | Read all group messages (needed by the group agent) | `im:message.group_msg` |
   | Send messages and cards, reply in topics | `im:message:send_as_bot` |
   | Read history and topics (import, look-up) | `im:message` (or read-only `im:message:readonly`) |
   | Download images and files | `im:resource` |
   | Add emoji reactions | `im:message.reactions:write_only` (or a message scope that includes reactions) |

3. **Events & callbacks**:
   - events via **long connection**, subscribe to **`im.message.receive_v1`**;
   - callbacks via **long connection**, subscribe to **`card.action.trigger`**.
4. **Publish** a version; your admin may need to approve it.
5. Add the bot to a test group.

> Only one process may consume an app's long connection at a time. Use separate apps for test and production, or stop the old service first.

### 5. Generate the Bridge TLS certificate

Runners talk to the Bridge over HTTPS. Generate a private CA and a server certificate (SAN `127.0.0.1` and `localhost`):

```bash
npm run runner:tls -- /opt/roundtable/data/tls
```

Keep the CA private key on the server; distribute only `ca.crt` to Runners.

### 6. Configure the Bridge

```bash
cp config.example.json config.json
cp .env.example .env && chmod 600 .env config.json
```

Fill in `.env`: `FEISHU_APP_ID`, `FEISHU_APP_SECRET` and the intent-model `BRIDGE_MODEL_API_KEY`. Then edit `config.json`:

| Field | What to put |
|---|---|
| `tenantId` | The `tenant_key` from message events |
| `allowedChats` | Your test group's `chat_id` (`oc_…`) |
| `allowedMembers` / `leaders` | Members' `open_id`s (`ou_…`); Leaders must also be members |
| `runnerBridge.intentModel` | The fast model's `baseUrl` and `model` |
| `runnerBridge.defaults` / `models` | Default coding model and effort, and the models offered on cards |

> **Finding these IDs:** start the Bridge with placeholders (step 7) and have each member @-mention the bot once in the group.
> The log prints `message_ignored` with `tenantId`, `chatId` and `senderId`. Copy them into the config and restart.

In Runner mode the `provider` block is not called; keep the placeholder. Real coding models are configured on Runners.

### 7. Start the Bridge

```bash
FEISHU_CODEX_CONFIG=/opt/roundtable/config.json node dist/src/main.js
```

- Look for `service_ready` in the log; with the group agent enabled, `group_history_imported` follows shortly.
- For production use `deploy/roundtable.service`.

### 8. Add `team-runner` (the server node)

1. **Issue a one-time pairing code** (valid for 10 minutes; use it only in a trusted terminal):

   ```bash
   FEISHU_CODEX_CONFIG=/opt/roundtable/config.json npm run runner:admin -- pair <leader_open_id> team-runner
   ```

2. **Pair:**

   ```bash
   mkdir -p /opt/roundtable/runner && cd /opt/roundtable/runner
   cp ../runner.example.json template.json        # adjust provider, projects, sandbox
   echo "CODEX_MODEL_API_KEY=your-coding-model-key" > .env && chmod 600 .env
   node -e 'const t=require("./template.json");t.code=process.argv[1];process.stdout.write(JSON.stringify(t))' "<pairing-code>" \
     | FEISHU_RUNNER_CONFIG=/opt/roundtable/runner/runner.json npm --prefix /opt/roundtable run runner:setup
   ```

3. **Diagnose.** Both must pass before the node accepts work:

   ```bash
   cd /opt/roundtable
   FEISHU_RUNNER_CONFIG=/opt/roundtable/runner/runner.json npm run runner:doctor             # free: Docker, isolation, real OOM, TLS, projects
   FEISHU_RUNNER_CONFIG=/opt/roundtable/runner/runner.json npm run runner:doctor -- --live   # paid: real model + real shell tool call
   ```

4. **Run** (for production use `deploy/roundtable-runner.service`):

   ```bash
   FEISHU_RUNNER_CONFIG=/opt/roundtable/runner/runner.json npm run runner
   ```

5. **Check that the node is online:**

   ```bash
   FEISHU_CODEX_CONFIG=/opt/roundtable/config.json npm run runner:admin -- nodes
   ```

`team-runner` is registered by a Leader and listed in `sharedNodes`, so every allowed member can use it.

### 9. Try it in Feishu

```text
(chat a bit in the main timeline without mentioning the bot)
@bot summarise what we just said and split the work
@bot open topics for these
(in your own assignment topic, no @ needed) go ahead, implement it and run node --test
@bot settings
```

What you should see:
- an emoji appears on your message;
- the answer lands in that message's topic;
- during execution the card ticks items off in place, and the result card offers Accept / Reject.

### 10. Add member laptops (optional)

Laptops need Node 24 and a **Linux container runtime**. On macOS, use a dedicated Colima profile so your default Docker setup is left alone:

```bash
brew install node@24 docker colima
colima start feishu-codex --cpus 4 --memory 6 --disk 20 --vm-type vz
docker --context colima-feishu-codex build -t feishu-codex-task:runner-v1 -f docker/task.Dockerfile .
```

The Bridge listens on `127.0.0.1` only. Map it to the laptop through an SSH account that can **only** forward locally:

```bash
ssh -N -L 127.0.0.1:19443:127.0.0.1:9443 runner-forward@your-server
```

Then set these in the node config:
- `bridgeUrl: https://127.0.0.1:19443`
- `sandbox.dockerContext: colima-feishu-codex`
- `ownerId`: the laptop owner's `open_id`

Pair, diagnose and run as in step 8. From then on, "on my computer…" from that member runs on their laptop. Others need a grant from the owner or a Leader ("let @someone use my computer").

See [docs/RUNNER_OPERATIONS.zh-CN.md](docs/RUNNER_OPERATIONS.zh-CN.md) for the full operations guide: macOS LaunchAgents, VPN fake-DNS, revocation, backup and migration.

---

## Everyday use

Natural language works in Chinese or English; these are examples.

| Goal | Say |
|---|---|
| Ask / summarise | `@bot summarise what we just said` |
| Split work, open topics | `@bot split the work` → `@bot open topics for these` |
| Change code | `@bot make imports fail atomically on conflicts and run the tests` |
| Choose a machine | `on my computer…`, `use the team sandbox…`, `run it on Air…` |
| Choose model and effort | `use Astra, high effort…`, `think harder this time`, `@bot settings` |
| Continue in a topic | just reply, no @ |
| Correct a topic from the main chat | quote one of its messages, or `@bot fix the import topic: …` |
| Progress / stop | `progress` in the topic; a bare `停止`; or the card buttons |
| Review | **Accept** on the result card, or **Reject** with feedback |
| Grant a machine | `let @someone use my Mac mini`, `revoke @someone's access to Air` |
| Grant a collaborator | `let @someone drive this task too` |
| Memory | `remember: …`, `what do you remember about this group`, `forget item 2` |
| Proactivity | `only reply when mentioned`, `stop auto-replying in this topic` |
| Archive / delete | `archive this task`, `delete the workspace` (two-step confirmation) |

---

## Configuration

See `src/config.ts` (Bridge) and `src/runner/config.ts` (Runner) for every field. Common ones:

| Field | Default | Meaning |
|---|---|---|
| `runnerBridge.intentModel` | — | Bridge intent model; without it, fixed-format commands are used |
| `runnerBridge.groupAgent.enabled` | `false` | Enable the group agent |
| `runnerBridge.groupAgent.pauseAfter` | `100` | Unengaged top-level messages before pausing per-message judgement |
| `runnerBridge.groupAgent.feedBudgetChars` | `60000` | Incremental context budget; overflow is compressed |
| `runnerBridge.groupAgent.webSearch` | `true` | Provider-side web search for the group agent |
| `runnerBridge.groupAgent.ackEmoji` | `OnIt` | Emoji used to acknowledge a request |
| `runnerBridge.defaults` | — | Default model and effort (`low`, `medium`, `high`, `xhigh`) |
| `runnerBridge.models` | Sol, Astra | Models offered in chat and on cards |
| `runnerBridge.sharedNodes` | `["team-runner"]` | Nodes open to all allowed members (must be registered by a Leader) |
| `runnerBridge.defaultNode` | — | Node used when none is named |
| `concurrency` | `2` | Global concurrent turns; per-node capacity comes from the Runner's `capacity` |
| Runner `allowedModels` | any | Models this machine allows |
| Runner `sandbox.*` | 2 CPU / 4 GiB / 30 min | Per-task container limits; disk is a 2-second monitored budget |

Without `runnerBridge`, the Bridge runs in **single-server compatibility mode** and executes tasks in local Docker, which is handy for a minimal experiment.

---

## Development

```bash
npm test                 # unit and protocol-simulation tests
npm run build            # TypeScript build
npm run protocol:generate  # regenerate App Server protocol types from the pinned Codex
FEISHU_RUNNER_CONFIG=… npm run test:sandbox   # real Docker isolation and resource checks (no model calls)
```

Contribution guide: [CONTRIBUTING.md](CONTRIBUTING.md). Report simulated tests, real-model runs and real-Feishu runs separately. Design notes: [docs/GROUP_AGENT_DESIGN.zh-CN.md](docs/GROUP_AGENT_DESIGN.zh-CN.md).

## Known limitations and roadmap

- Codex inside the task container can read the model key. Docker cannot hide secrets from code in the same container, so use a dedicated, rate-limited key.
- The disk budget is monitored termination, not a hard quota.
- The Bridge certificate covers only `127.0.0.1` and `localhost`; reach it from remote nodes through an SSH local forward or a VPN.
- Feishu permission names and console entries change over time; follow the Open Platform.
- Roadmap:
  - hosted HTML reports with link-preview cards;
  - GitHub draft PRs (credentials stay on the Runner) with AI review for owners;
  - scheduled digests, deadline reminders, drift and conflict alerts.

## Acknowledgements and notices

- Execution uses [OpenAI Codex](https://github.com/openai/codex) App Server; Feishu integration uses the official [Channel SDK](https://www.npmjs.com/package/@larksuite/channel).
- Roundtable is independent and not affiliated with Anthropic, OpenAI or ByteDance (Feishu / Lark). Names and trademarks belong to their owners.
- `src/protocol/` is generated from the pinned `@openai/codex` (Apache-2.0); see [NOTICE](NOTICE).
- Roundtable lets an AI execute code on your machines. Try it in a test group with the sample repository first, and read the security model in [SECURITY.md](SECURITY.md).

## Contributing

Issues, discussions and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). If Roundtable helps your team, a ⭐ is the best way to support it.

## License

[MIT](LICENSE)
