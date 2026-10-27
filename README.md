# PaperQuest · 论文副本

把一篇英文 AI/ML 实证论文拆成「雨夜侦探故事 + 四关结案考核 + 结案报告」的本地网页游戏。上传 PDF / TXT / Markdown 后，先选一位调查员，再以第一人称进入四幕案发现场：在档案馆找研究缺口，在地下实验台核对方法，在数据观测室追证据，在审稿人密室确认边界。四幕结束，才进入 100 分制结案考核，检验自己是否真的读懂，最后带走阅读大纲与结案报告。原文抽屉提供「Markdown 阅读版」和「PDF 原件」两个视图，可导出 `.md`；已保存的上传案件会把 PDF 一并归档到本地资料库。场景与人物插画已预生成在 `static/assets/art/`，运行时不需要联网生图。

## 快速开始（Windows）

双击 `start.bat`。首次运行会自动创建 `.venv`、安装依赖，并打开 <http://127.0.0.1:5173>。以后再次双击即可启动。

手动启动：

```bat
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
copy .env.example .env
.venv\Scripts\python.exe app.py
```

没有 API Key 也能完整体验：默认 `MOCK_LLM=1`，上传任意论文会返回内置示例案件。必须先上传论文才能进入调查与考核，页面不再提供跳过上传的试玩入口。模拟模式只用于演示流程，不会解析你上传的内容。

## 部署到阿里云 ECS（Docker）

推荐配置：2 vCPU / 2 GB 内存以上的 ECS，Ubuntu 22.04 或 24.04，安全组放行 22、80、443。先把域名 A 记录指向 ECS 公网 IP，再按下面步骤操作。

1. 安装 Docker 与 Compose 插件（以 root 或 sudo 执行）：

   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo systemctl enable --now docker
   docker compose version
   ```

2. 上传代码并配置环境变量。可以在本地执行 `git clone` 后 `scp`，也可以直接在服务器上拉取：

   ```bash
   cd /opt
   sudo git clone <你的仓库地址> paperquest
   cd paperquest
   cp .env.example .env
   nano .env
   ```

   `.env` 至少要改这些：

   ```env
   LLM_BASE_URL=https://api.deepseek.com/v1
   LLM_API_KEY=sk-...
   LLM_MODEL=deepseek-chat
   MOCK_LLM=0

   SECRET_KEY=<随机长字符串>
   COOKIE_SECURE=0
   PUBLIC_BASE_URL=https://你的域名

   YIRENFU_API_KEY=yrp_live_...
   YIRENFU_WEBHOOK_SECRET=...
   BILLING_DISABLED=0

   DOMAIN=你的域名
   LETSENCRYPT_EMAIL=你的邮箱
   ```

   `SECRET_KEY` 可以用 `openssl rand -hex 32` 生成。`PUBLIC_BASE_URL` 必须与最终访问地址一致（含 `https://`），否则一人付支付完成后的回跳会落到错误地址。

3. 说明：`docker-compose.yml` 会把宿主机的 `./data` 挂载到容器的 `/app/data`，SQLite 数据库、归档 PDF 和会话密钥都在这里，重建容器不会丢数据。首次启动前确认该目录可写：

   ```bash
   mkdir -p data certbot/conf certbot/www
   ```

4. 启动并申请 HTTPS 证书：

   ```bash
   chmod +x deploy/init-letsencrypt.sh
   sudo ./deploy/init-letsencrypt.sh
   ```

   脚本会先用 HTTP 模式启动 nginx 完成 ACME 验证，再申请证书并重启 nginx。成功后访问 `https://你的域名`。之后 `certbot` 容器每 12 小时检查一次续期；建议再加一条每周重载 nginx 的定时任务，让续期后的证书生效：

   ```bash
   sudo crontab -e
   # 加入一行（路径按你的部署目录调整）
   0 3 * * 1 cd /opt/paperquest && /usr/bin/docker compose exec -T nginx nginx -s reload
   ```

5. 常用运维命令：

   ```bash
   docker compose ps                  # 查看状态
   docker compose logs -f app         # 查看应用日志
   git pull && docker compose up -d --build   # 更新代码
   docker compose restart app         # 改完 .env 后重启应用
   ```

   备份只需要保留 `data/`（数据库与 PDF）和 `certbot/conf/`（证书）。

6. 安全组与防火墙：只对公网开放 22、80、443；不要暴露 8000 端口。Gunicorn 默认 1 个 worker、8 个线程，模型连接信息保存在进程内存中，单 worker 可避免配置不一致；如果所有模型配置都写在 `.env`，可以用 `GUNICORN_WORKERS` 调整。

> 如果暂时没有域名，可以先不申请证书：`docker compose up -d --build` 后 nginx 会以 HTTP 模式提供访问。但一人付的支付回跳和登录 Cookie 建议在 HTTPS 下使用。

## 账号与一人付次数计费

开启计费后（`BILLING_DISABLED=0` 且填写了 `YIRENFU_API_KEY`）：

- 用户用**邮箱 + 密码**注册/登录，会话是 Flask 签名 Cookie（`pq_session`）。密码用 Werkzeug 哈希保存，资料库按账号隔离。
- **每个账号的第一局免费**：首次成功解析一篇论文不扣次数，之后每局消耗 1 次。
- 每上传并解析一篇论文算一局。前端在请求前生成一个局号 `game_id`，服务端用它作为一人付的 `idempotency_key`；失败重试会沿用同一局号，不会重复扣费。已存入资料库的案件重开不扣次数。
- 次数不足时返回 402 并打开购买窗口。购买走支付宝「一人付」的**次数包**：服务端调用 `/purchase` 生成二维码/跳转链接，付款后次数自动进入一人付账户，页面每 10 秒刷新一次 `/access`，到账后自动继续解析上一篇论文。
- 一人付凭证只保存在服务端环境变量，不下发浏览器。

一人付控制台（<https://ai6666.com/opcpay>）需要完成：

1. 创建产品，计费模式选择**次数包**（`quota_unit=COUNT`）。
2. 配置两个次数套餐（SKU），价格按下表填写；前端读取产品接口返回的 `charging_options` 自动展示，改价只需改控制台：

   | 套餐名 | 价格 | 次数 | 折合单次 |
   | --- | --- | --- | --- |
   | 单次 | 1 元 | 1 次 | 1 元/次 |
   | 10 次包 | 9.9 元 | 10 次 | 0.99 元/次 |

   两个 SKU 都要挂在同一个产品下，计费模式 `QUANTITY`、单位 `COUNT`、权益规则 `QUOTA`。
3. 生成服务端 API Key（`yrp_live_...`），填入 `YIRENFU_API_KEY`。
4. 配置通知地址 `https://你的域名/api/billing/webhook`，把签名密钥填入 `YIRENFU_WEBHOOK_SECRET`。服务端会校验 `Yirenfu-Signature`（HMAC-SHA256）、校验 300 秒时间偏差，并按事件 ID 去重。通知只做记录与幂等，次数以 `/access` 查询结果为准。
5. 确认支付宝正式环境已开通，否则 `/purchase` 可能返回 `PURCHASE_NOT_READY` 或 503。

本地调试计费时，保持 `COOKIE_SECURE=0` 即可；`docker-compose.yml` 会在生产容器里强制设为 1。也可以用 `BILLING_DISABLED=1` 完全关闭计费来验证游戏流程。

## 接入真实论文解析

PaperQuest 调用任意兼容 OpenAI Chat Completions 的接口（OpenAI、DeepSeek、Moonshot、通义等）。

方式一：在页面右上角「模型设置」填写 Base URL、API Key、模型名，保存后会立即切换为真实解析。连接信息只保存在本机 Flask 进程内存里，不写入浏览器存储，也不会回传给前端；刷新或重启服务后需要重新填写。

方式二（持久化）：复制 `.env.example` 为 `.env`，填写：

```env
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini
MOCK_LLM=0
```

修改 `.env` 后重启服务生效。建议使用长上下文、指令遵循较好的模型；较强的模型更容易产出可回链的引文。`MOCK_LLM=1` 优先级高于真实连接，调试流程时可随时切回模拟模式。

## 一局是怎么跑的

上传后，服务端用 PyMuPDF 提取文字与章节，把标题、研究问题、缺口、方法配置、关键主张、结果、局限与术语整理成案件档案。真实模式会要求模型为每条关键主张和关卡给出 `evidence_quote`，服务端再拿引文与提取文本做字符串核验；一条都对不上会直接停止生成，低于 50% 会在案件页标注提示。

档案建立后，先选调查员。三位调查员各带一种被动能力，只改变调查与提示的结算方式，不改变论文证据与基础评分：

- 林砚（档案员）：整局一次「索引记忆」，使用提示不扣分。
- 沈砾（实验员）：「沙盘推演」在实验装配题中为每个分类排除一个错误选项。
- 顾言（审稿人）：「反诘训练」让审稿关的提示不扣分。

选定后进入四幕第一人称现场。每幕有三处微光线索，点击任一热点都会记录到线索本，并可打开线索卡；带原文引文的线索可以一键跳到原文抽屉的对应位置。线索找齐后，推理锁会给出一道三选一判断，答错只锁定该选项并给出提示，不扣最终分；答对后写入结案笔记，再进入下一幕：

1. 雨夜档案馆：区分研究缺口、研究问题与摘要承诺，判断论文真正要补的空白。
2. 地下实验台：把数据集、方法组件、基线、指标拼成可复现的实验配置。
3. 数据观测室：逐条核对主张与原文引文，找出真正有证据托底的那一条。
4. 审稿人密室：沿着作者自己承认的局限，找到最专业的追问。

四幕全部推理成立后，才解锁四关结案考核。关卡在后台生成，案件页可以边读边等。四关分别是：

1. 缺口定位：从引言判断论文真正要填补的空白。
2. 实验装配：四类卡片各选一张，复原核心实验配置。
3. 结果侦探：判断哪条结论真正被数据支持，错误选项对应常见过度解读。
4. 审稿对线：先选最站得住脚的审稿意见，读作者回应后再做一次追问。

每题 25 分，总分 100。一次命中得满分，同一阶段第二次命中得 60%，展开解析得 20%；提示每次扣 3 分，角色能力可免除对应提示的扣分。审稿关拆成主问 15 分 + 追问 10 分，两段独立计分。答错会展示对应原文线索，第二次答错自动揭示解析。案件页、调查现场与考核页始终可以打开原文抽屉：默认是排版后的「Markdown 阅读版」，命中的摘录会高亮并自动滚到对应位置；如果案件附有 PDF，还可以切到「PDF 原件」直接翻阅、在新窗口打开，或把阅读版导出为 `.md`。

结案页给出分数、调查员、四幕推理结果、四关判定、论证地图、逐关记录与原文定位。填写自己的审稿追问后，可以生成阅读大纲、复制大纲，或下载 Markdown 结案报告。报告包含调查员、四幕现场、每关作答记录、使用提示的情况、证据链、局限与你的审稿判断。

## 资料库与进度保存

四关全部生成后，案件页底部和游戏侧栏会出现「存入资料库」。保存的内容包括论文原文、案件档案、四关题目以及当前进度：调查员、四幕现场进度、已发现线索、推理结果、每一关的作答、提示、得分、反思与阅读大纲。如果案件来自 PDF 上传，保存时还会把原始 PDF 作为 BLOB 一并写入资料库，之后在资料库中重新打开仍可查看「PDF 原件」；示例案件使用内置的 `data/sample_paper.pdf`，模拟模式下的示例案件同理。没有归档 PDF 的旧记录或 TXT / Markdown 案件只显示 Markdown 阅读版，并在抽屉中标注「未附 PDF」。

保存之后进度会自动同步：每次发现线索、解开推理锁、进入下一幕、作答、使用提示、进入下一关、修改反思或生成大纲，前端都会在短暂延迟后把最新进度写回数据库；切换案件或删除前会先把未完成的写入发出去。重新打开存档时，已全部完成会回到结案报告，四幕已结束会回到结案考核，四幕中途会回到当时那一幕，未选调查员的旧存档则先进入选人页面。顶栏的「资料库」按钮会显示已存案件数量。

资料库按更新时间倒序排列，每张卡片显示状态（未开始 / 调查中 / 已结案）、得分、已完成关卡数、更新时间和来源。可以继续调查、删除，或从案件页再次保存以覆盖更新。删除需要二次确认；如果删除的是当前正在玩的案件，内存中的案件仍可继续阅读，但不会再自动同步，需要重新保存才会生成新记录。

数据存放在本机 `data/paperquest.db`（SQLite，首次启动自动创建），不会上传到任何服务器。PDF 原件也保存在这个文件里，单个 PDF 上限 25 MB，因此资料库文件会随归档的论文数量增长。同一篇论文按正文内容哈希去重：重复保存会更新原记录并保留已有进度，而不是新增一条。开启计费后资料库按登录账号隔离；关闭计费时仍按本机单用户处理。

## 支持范围

- 输入：PDF（需要可提取文字，扫描版请先 OCR）、TXT、Markdown，单文件 25 MB 以内。
- 原文视图：Markdown 阅读版由提取文本重新排版，保留章节层级与段落；PDF 原件在示例案件、模拟模式和已归档 PDF 的上传案件中可用。
- 论文：英文 AI/ML 实证论文效果最好；其他领域也能跑，但题目质量取决于模型与论文结构。
- 未保存的案件只存在内存中，刷新页面会丢失；已保存的案件与进度写入本机 SQLite，可在资料库中继续或删除。
- 引文核验是普通字符串对齐，不是语义判断；报告与大纲用于辅助阅读，正式引用前请回到原始 PDF 复核。

## 目录

```
app.py                  Flask 服务与 API
storage.py              SQLite 资料库与账号/局/通知表
auth.py                 邮箱密码注册登录与签名会话
billing.py              一人付服务端客户端、webhook 验签
llm_client.py           OpenAI-compatible 调用、运行时配置
paper_utils.py          PDF 提取、章节切分、档案/关卡规范化、引文核验
prompts.py              案件档案与关卡生成提示词
data/                   示例论文、示例案件、示例关卡、测试 PDF；运行时生成 paperquest.db
static/                 单页前端（HTML / CSS / 原生 JS）
static/detective.js     调查员、四幕现场、线索与推理锁逻辑
static/assets/art/      预生成的封面、四幕场景与三张调查员插画
deploy/                 Nginx 配置、入口脚本与首次证书申请脚本
tests/                  测试 PDF 生成器与本地假模型服务
Dockerfile              生产镜像（Python 3.12 + Gunicorn）
docker-compose.yml      app + nginx + certbot 编排
gunicorn.conf.py        Gunicorn 参数
start.bat               Windows 一键启动
```

接口：`GET /api/status`、`GET /api/demo`、`POST /api/analyze`、`POST /api/generate`、`POST /api/config`、`POST /api/config/test`；账号相关为 `GET /api/auth/me`、`POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/logout`；计费相关为 `GET /api/billing/status`、`POST /api/billing/purchase`、`POST /api/billing/webhook`；资料库为 `GET /api/library`、`POST /api/library`、`GET /api/library/<id>`、`PATCH /api/library/<id>`、`DELETE /api/library/<id>`。PDF 相关接口为 `GET /api/demo/pdf` 和 `GET /api/library/<id>/pdf`（默认内联预览，加 `?download=1` 下载）；保存时 `POST /api/library` 既接受 JSON，也接受 `multipart/form-data`（`payload` JSON 字段 + `pdf` 文件字段）。

## 验证与调试

```bat
python tests/make_sample_pdf.py
python tests/mock_openai_server.py
```

假模型默认监听 `127.0.0.1:5055`，Base URL 填 `http://127.0.0.1:5055/v1`、API Key 随意，即可在不消耗真实额度的情况下走通真实解析分支。`data/sample_paper.pdf` 是配套测试论文。

## 已知边界

- 开启计费时资料库按登录邮箱隔离；关闭计费时仍是本机单用户。换机器需自行拷贝 `data/paperquest.db`，归档的 PDF 也在这个文件里。
- 首个账号首局免费依赖邮箱注册，目前没有邮箱验证码；如果担心被批量注册薅免费局，可以在注册入口加验证码/邀请码，或把免费规则改成「新账号赠送 N 次」。
- 同一篇论文按内容哈希去重，重复保存会更新原记录并保留进度。模拟模式下所有上传内容相同，会命中同一条示例记录。
- 模拟模式下上传真实 PDF，案件内容与「PDF 原件」都来自示例论文，不读取你上传的 PDF 正文；要解析自己的论文需关闭 `MOCK_LLM` 并配置真实模型。
- 未保存的上传 PDF 用浏览器临时 Blob 地址预览，刷新或换设备后就没了；只有保存进资料库才会归档原件。
- 已经保存但没有 PDF 的旧记录（例如本次升级前保存的案件）只能看 Markdown 阅读版，不会自动补回 PDF；重新上传同一篇论文并保存可补上原件。
- 运行时模型配置不落盘，需要持久化请写 `.env`。
- 超长论文只把摘要式 digest（约 28k 字符）送给模型，正文仍保留在本地供原文定位。
- 题目生成依赖模型能力；若模型反复给出无法对齐的引文，服务会安全失败而不是伪造证据。
