# 这个包里装的是什么，别人升级了怎么办

包内版本：**v1.13.0-panel**（上游 revision `6b31db6`）+ 本机兼容层。
上游项目：<https://github.com/linguo2625469/workbuddy2api-panel>（MIT）。

```
src/                            上游源码 + 兼容层（Dockerfile 也在这里）
patches/compat.patch            兼容层相对上游 6b31db6 的完整补丁（119,662 B / 6 文件）
docker-compose.yml              从 ./src 现场 build 并起容器
config.example.json             配置样例（复制成 config.json 后只改 api_key）
```

**包里不带预构建镜像。** 镜像由 `docker compose up -d --build` 从 `src/` 现场编译，所以：

- 构建机要能拉到 `golang:1.23-alpine`（≈370 MB）与 `alpine:3.20`；拉不动时见 `README.md` 的镜像加速器写法。
- 编出来的是**本机架构**：Apple Silicon / ARM 服务器上直接得原生 arm64 镜像，不用 Rosetta 模拟（这也是不带 tar 的好处）。
- 首次构建约 2-4 分钟，之后改代码重建只重跑变化的层。

`patches/compat.patch` 存在的意义：把 `src/` 里的改动摊开，谁都能看出相对上游多了什么、也能逐行 diff；
它同时也是 MIT 分发时附带的「修改过的源码」。

---

## 打包时动了什么（相对上游工作区）

1. 删掉 `.git/` 与 `.github/`（CI 里推 GHCR / Release 的那套，本包不用）。
2. 在 `src/.gitignore` 末尾加一行 `!internal/prompt/defaultprompt.md` —— 上游用 `*.md` 忽略了所有 md，而这个文件是 `prompt.go` 里 `go:embed` 的构建输入，不进版本库时 `go build` 直接报错（从工作区打包看不出问题，克隆下来重打就会丢）。
3. 全部文件转成 LF（站点仓库的硬约束，见 `docs/adr/0004`）。

## 相对上游改了什么

上游只有 `/v1/chat/completions`。两处兼容层让它同时能接 codex 与 Claude Code：

| 文件 | 改动 |
|---|---|
| `internal/server/responses.go` | **新增**（约 1000 行）。`POST /v1/responses`：Responses 请求 → Chat 请求翻译；上游 chat SSE → Responses 事件流逐帧翻译；非流式聚合后整体转换；错误体原样透出。 |
| `internal/server/messages.go` | **新增**（约 1200 行）。`POST /v1/messages`：Anthropic Messages 请求/响应/流式三向翻译，含 `claude-*` → `cn:*` 模型名映射（表在 `messagesModelFamilies`）。 |
| `internal/server/responses_test.go` | **新增**。请求翻译、流式事件序、工具调用、非流式、400 校验、上游错误透传。 |
| `internal/server/messages_test.go` | **新增**。17 个用例（请求翻译 / 流式 / 非流式 / 错误边界 / 模型映射一一对应）。 |
| `internal/server/handler.go` | 注册上面两条路由；`ServeHTTP` 的 requestTrace 白名单加上它们（进用量统计与请求归档）；`withAuth` 对 `/v1/messages` 改用 Anthropic 形状的 401。 |
| `internal/server/logging.go` | `requestTrace` 增加 `path` 字段，归档里能区分 chat / responses / messages。 |

设计要点：**没有复制第二份上游调用**，兼容层都复用 `h.chatCompletions(翻译型 ResponseWriter, 改写后的请求)`。
所以选号轮转、粘性会话、降级提示词、冷却、用量账本、请求归档、错误策略全部自动继承，
不存在会漂移的第二份调度状态。

---

## 构建

包根目录（有 `docker-compose.yml` 的那层）：

```bash
docker compose build            # 只构建，不起容器
docker compose up -d --build    # 构建 + 起容器
```

想手动 build、不走 compose：

```bash
cd src
DOCKER_BUILDKIT=0 docker build -t workbuddy2api-panel:1.13.0 .
```

- **`DOCKER_BUILDKIT=0` 是 DNS 不通时的兜底**：`Dockerfile` 首行 `# syntax=docker/dockerfile:1` 会让
  BuildKit 去 Docker Hub 拉 frontend，国内常失败（`failed to fetch anonymous token ... dial tcp ...:443`）。
  遗留构建器忽略该指令即可。能正常访问 Docker Hub 的机器上带 BuildKit 也能 build。
- 编译产物靠 `-trimpath -ldflags="-s -w"` 与两阶段构建压到 ~117 MB。

## 跑测试（不用装 Go）

```bash
# 在本包根目录执行；Win 的 Git Bash 里要加 MSYS_NO_PATHCONV=1
MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD/src:/src" -v "wb2api-gocache:/go" -w /src golang:1.23-alpine \
  sh -c "go build ./... && echo BUILD_OK && go vet ./internal/server/ && go test ./... -count=1"
```

## 验证（起一个空白 canary，不碰正式实例）

```bash
mkdir -p /tmp/wb-canary/{auths,data} && cd /tmp/wb-canary
cp <包路径>/config.example.json config.json   # 把 api_key 改成随机串
docker run -d --name wb2api-canary -p 127.0.0.1:7864:7863 \
  -v "$PWD/config.json:/app/config.json" -v "$PWD/auths:/app/auths" -v "$PWD/data:/app/data" \
  workbuddy2api-panel:1.13.0
sleep 3
curl -s http://127.0.0.1:7864/healthz                                  # 503 + healthy:0（auths 空，正常；有账号时才是 200）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7864/panel/  # 200
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer wrong' \
  http://127.0.0.1:7864/v1/models                                      # 必须 401，200 = 鉴权没生效
# 三条端点都应回 503（路由在、池子空），不是 404：
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer <真 key>" \
  -H 'Content-Type: application/json' -d '{"model":"cn:auto","input":"hi"}' \
  http://127.0.0.1:7864/v1/responses
docker rm -f wb2api-canary
```

`auths/` 留空：canary 与正式实例**绝不要共用同一份 `auths/`**，两个容器会抢同一个账号的
token，把正在用的实例搞挂。

---

## 跟上游升版（并行克隆 + 补丁重放，做过一遍的流程）

上游更新后不要在本包 `src/` 里 `git pull`——`src/` 不是 git 仓库（只留了工作区文件）。
按下面的顺序做，全程不破坏手头正在跑的镜像：

```bash
# 0) GitHub 在本机直连不通，必须走代理；按你的环境改这一行
export HTTPS_PROXY=http://127.0.0.1:18790

# 1) 克隆新上游到旁边目录（浅克隆够用）
cd /tmp && rm -rf wb2api-next
git clone --depth 1 https://github.com/linguo2625469/workbuddy2api-panel.git wb2api-next
cd wb2api-next && git rev-parse --short HEAD

# 2) 重放兼容层（补丁里已含新增文件）
git apply --verbose /path/to/wb2api/patches/compat.patch
#    --verbose 会报每个 hunk 的偏移量；偏移(offset) ≠ 冲突(failed)。
#    若真有 conflict：手工合，重点是 handler.go 的三处（路由表 / requestTrace 白名单 /
#    withAuth 的 401 分支），logging.go 的 requestTrace.path。

# 3) 编译 + 全测试（容器里跑，本机不必装 Go）
MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD:/src" -v "wb2api-gocache:/go" -w /src golang:1.23-alpine \
  sh -c "go build ./... && go vet ./internal/server/ && go test ./... -count=1"

# 4) 用新版本号建镜像，先起 canary（见上一节）验 /healthz、/panel/、401，
#    再用真实 key 打一次 chat / responses / messages 各一条

# 5) 通过后替换本包内容：
#    - src/ 换成新上游 + 重放的兼容层（仍删掉 .git 与 .github）
#    - patches/compat.patch              ← git add -N 新文件后再 git diff，见下
#    - docker-compose.yml 的 image: tag、本文件与 README 里的版本号
#    - 回到站点仓库重跑 node tools/tools.mjs pack wb2api（重打 zip + 更新 manifest）
```

导出补丁的正确姿势（新文件默认不进 `git diff`，必须 `add -N` 标成 intent-to-add）：

```bash
git add -N internal/server/{messages,messages_test,responses,responses_test}.go
git diff > /path/to/patches/compat.patch
git reset -q            # 只是撤掉 intent-to-add，工作区文件不动
```

校验补丁确实能重放（干净的上游树里应零输出即通过）：

```bash
git archive HEAD-上游revision | tar -x -C /tmp/pristine
cd /tmp/pristine && git apply --check -p1 /path/to/patches/compat.patch
```

## 回滚

包里不带旧镜像，所以回滚靠**本地 tag**：

```bash
# 每次重建前先留一手（一次即可，别堆一堆）
docker tag workbuddy2api-panel:1.13.0 workbuddy2api-panel:prev

# 出事就回去
docker tag workbuddy2api-panel:prev workbuddy2api-panel:1.13.0
docker compose up -d --no-build
```

要保持「整套旧版本可复现」，另存一份旧的 `src/` 目录（约 2.2 MB）比存 tar（30 MB）划算得多。
返回上游原版（只有 chat）也可以：把 `image:` 换成上游 GHCR 镜像，但 codex 与 Claude Code 会失效。
