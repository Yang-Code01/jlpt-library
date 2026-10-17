# WorkBuddy2API 部署包（v1.13.0-panel）

把 WorkBuddy / CodeBuddy 的订阅额度包装成 OpenAI 与 Anthropic 兼容网关，单容器，自带管理面板。
`/v1/chat/completions`、`/v1/responses`、`/v1/messages` 三条端点，pi / codex / Claude Code 都能直连。

完整部署步骤、三份客户端接入模板与风险说明见站点详情页（工具开发区 → WorkBuddy2API）。
包里有什么、怎么重建、上游升版怎么跟，见 `UPSTREAM.md`。

```bash
cp config.example.json config.json        # 必须把 api_key 改成你自己的随机串
docker compose up -d --build              # 首次会拉基础镜像并编译，约 2-4 分钟
docker compose logs -f                    # 看到监听 :7863 就可以 Ctrl+C
```

> 非官方网关。只用来接**你自己的**已注册账号，不要转售或批量注册。
> `config.json` 必须先存在，且 `api_key` 不能为空 —— 为空等于完全不鉴权。
> 上游项目：<https://github.com/linguo2625469/workbuddy2api-panel>（MIT）。

## 拉不到基础镜像

首次构建要 `golang:1.23-alpine`（约 370 MB）与 `alpine:3.20`。国内直连 Docker Hub 常常拉不动：

```bash
# 换镜像加速器（示例：DaoCloud），然后重试
docker pull docker.m.daocloud.io/library/golang:1.23-alpine
docker tag  docker.m.daocloud.io/library/golang:1.23-alpine  golang:1.23-alpine
docker pull docker.m.daocloud.io/library/alpine:3.20
docker tag  docker.m.daocloud.io/library/alpine:3.20  alpine:3.20
docker compose up -d --build
```

Dockerfile 首行是 `# syntax=docker/dockerfile:1`，BuildKit 会额外拉一个 frontend 镜像。
DNS 不通时改成传统构建器：`DOCKER_BUILDKIT=0 docker compose up -d --build`。
