# AGENTS.md

给在这个仓库里干活的人和 AI 代理（Claude Code、Codex、Cursor 等都适用）。

## 这是什么

dns.1ms.dog（DNS 测试）：在浏览器里从访客自己的网络给 33 家公共 DNS 测速，DoH 实测，UDP、DoT、DoQ 按同一台服务器估算，再检查 DNSSEC 和是否劫持不存在的域名。每家 DNS 有一个子页。另外还有三样东西：

- **你的设备实际在用的 DNS**：页面查一个 `l.1ms.dog` 下的随机域名，经 1ms.dog 自己的权威 DNS（`server/dns`，在东京的 VPS 上）看出是哪个解析器、有没有带出访客网段（ECS）。
- **东京状态页** `/status/`：VPS 上的定时任务（`server/watch`）每 10 分钟从东京探测全部 DNS 的 UDP、IPv6、DoT、DoH、DoQ。
- **命令行工具** dnstest 在另一个仓库 [yt1988/dns-test-cli](https://github.com/yt1988/dns-test-cli)，它读本站的 `/resolvers.json`。

先读 [README.md](README.md)（测法、文件、加一家 DNS 的步骤），再按需要读：

- [docs/vps.md](docs/vps.md)：VPS 上的两个服务（1ms-dns、1ms-dns-watch），从零装上、验证、哪些数据丢了就回不来。
- [docs/l-api.md](docs/l-api.md)：`l.1ms.dog` 结果接口的格式，给接入它的其他工具。
- [docs/design.md](docs/design.md)：设计取舍和测过的结论（为什么 DoQ 是估算、LCP 落在哪里、哪些做法试过没用）。改东西之前先看。

1ms.dog 全站的运营说明（账号、密钥、VPS 全局配置、各工具维护者）在私有仓库 1ms-shell，不在这里。

## 本地跑起来

```bash
npm install
npm run build      # 由 src/ 生成 public/（页面、资源、规则集、CSP）
npm run dev        # wrangler dev，http://localhost:8793
```

本地页面在 `localhost` 上也会读 `l.1ms.dog` 和 `data.1ms.dog`（线上的服务），所以「你的 DNS」卡片和状态页在本地也有数据。

## 测试：按改动范围选

| 改了什么 | 跑什么 |
|---|---|
| 任何 `src/`、`scripts/`、文案 | `npm test`（会先 `build --check`，确认 public/ 已重新生成并提交；再跑 test/*.test.mjs：页面结构、10 种语言的键和占位符、复数、站点约定）。提交前必须通过 |
| 页面外观 | 再在浏览器里看桌面和手机宽度 375px，中文和俄语（字最长）；页面不能横向滚动 |
| DNS 列表 `src/resolvers.mjs` | `npm run verify`（从你这里逐家检查 DoH、CORS、DNSSEC、NXDOMAIN；最好在另一个大洲也跑一次，每周一 GitHub Action 也会跑），`node scripts/icons.mjs <id>`，`node scripts/vps-targets.mjs`（更新 `server/watch/targets.json`，测试会检查它是否最新），然后重新编译并部署 1ms-dns-watch（见 docs/vps.md） |
| `server/`（Go） | 推送后 GitHub Actions 的 `server` 工作流跑 `go vet`、`go test`，并编译 linux/amd64 二进制；本地有 Go 的话 `cd server && go test ./...` |
| 上线后 | 打开线上页面看一遍 |

## 部署和发版

- **网站**：推送 `main` 就是上线。Cloudflare Workers Builds 自动跑 `npm ci && npm test`，再 `npx wrangler deploy`。`public/` 是生成的文件，要和源码一起提交。自己部署时，Worker 不绑域名（`wrangler.toml`），在 Cloudflare 面板里把你的域名绑到它上面，构建时用 `SITE_URL=https://<your-domain> npm run build`。
- **VPS 上的服务**：不随网站部署。改了 `server/` 之后，从 GitHub Actions 的 `server` 工作流下载二进制，传到机器上替换，再重启服务，步骤见 docs/vps.md。
- **命令行工具**：在 dns-test-cli 仓库发版（打 tag）。改 DNS 列表不需要发版：工具运行时会先读本站的 `/resolvers.json`，内置的那份每天自动同步。

## 规矩

- 文案 10 种语言都要有，键和占位符一致（测试会查）。数量放在名词后面写（「resolvers: 3」），避开各语言的复数变化；必须用复数时，用 `key_one`、`key_few` 这种形式。
- 国家和地区的名称、旗帜一律经过 `src/region.mjs`（`regionName`、`flagCode`），不要在别处直接调 `Intl.DisplayNames`。
- 隐私：访客的 IP、解析器 IP、ECS 网段都不进分享链接、分享卡片、体检 facts（facts 只放 `resolverCountry`）。说明文字要照实写，帮助里「会收集我的数据吗？」那条是现在的说法。
- 不往仓库里放密钥，不写进文档和提交说明。
- 技术取舍和测过的结论写进 docs/design.md。
- 提交说明用英文，文档用中文。
