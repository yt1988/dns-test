# 两个服务端程序：自己部署

`server/` 下有两个 Go 程序，跑在一台有公网地址的 Linux 机器上：

| 程序 | 做什么 |
|---|---|
| `server/dns` | 一个子区（下文的 `<zone>`，1ms.dog 用的是 `l.1ms.dog`）的权威 DNS，加上 HTTPS 结果接口：看出访客实际用的解析器，以及它有没有转交 ECS（接口见 docs/l-api.md） |
| `server/watch` | 一次探测：从这台机器用 UDP、IPv6、DoT、DoH、DoQ 测一遍列表里的全部 DNS，写出 JSON。由 systemd timer 每 10 分钟启动一次 |

网页会读这两样东西：「你的设备实际在用的 DNS」卡片读结果接口（`src/app.js` 里的 `LZ`），状态页读探测结果（`src/status.js` 里的 `BASE`）。默认指向 1ms.dog 的服务，自己部署时把这两处改成你的地址；CSP 在 `scripts/build.mjs` 里。

## 下载（不用自己编译）

`server/` 的改动每次合进 `main`，GitHub Actions 都会编译出静态的 linux/amd64 程序，发布成一个 Release（tag 是 `server-<短提交号>`，最新一版标为 latest），并附上 `SHA256SUMS`：

```bash
cd /tmp
for f in 1ms-dns 1ms-dns-watch SHA256SUMS; do
  curl -fsSLO https://github.com/yt1988/dns-test/releases/latest/download/$f
done
sha256sum -c SHA256SUMS          # 两行都应该是 OK
install -m 755 1ms-dns 1ms-dns-watch /opt/<app>/
```

要装某一个特定版本，把 `latest/download` 换成 `download/server-<短提交号>`。

## 编译

```bash
cd server && go test ./... && \
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o out/1ms-dns ./dns && \
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o out/1ms-dns-watch ./watch
```

没有 Go 也可以：推送 `server/` 下的改动后，GitHub Actions 的 `server` 工作流会测试并编译两个程序，结果在名为 `server` 的 artifact 里。

探测列表 `server/watch/targets.json` 是编译进程序的：改了 `src/resolvers.mjs` 之后，先跑 `node scripts/vps-targets.mjs`，再重新编译。

## 参数

`dns`：

| 参数 | 含义 |
|---|---|
| `-zone` | 子区，如 `l.example.com` |
| `-ns` | 父区里委派给它的名称服务器，如 `ns-l.example.com` |
| `-a`、`-aaaa` | 对外公布的公网 IPv4、IPv6（名字的应答，以及只走 IPv4、只走 IPv6 那两个子区的胶水记录） |
| `-dns` | 应答 DNS 的地址，UDP 和 TCP 都用，逗号分隔。要绑网卡上实际有的地址：在 NAT 后面的机器（比如云主机的公网 IPv4）上，绑的是内网地址 |
| `-api` | HTTPS 结果接口的地址（如 `<内网 IPv4>:2053,[<公网 IPv6>]:2053`） |
| `-api-http` | 可选：只在本机用的明文接口，用来自检（如 `127.0.0.1:2054`） |
| `-state` | 状态目录：证书、ACME 账户、IP 库 |
| `-acme` | ACME 目录地址，默认 Let's Encrypt 正式环境。试装时可以用 staging |

`watch`：`-out <目录>` 结果写到哪里，`-keep 90` 历史保留天数，`-scan-doq` 逐家试一遍 DoQ，只打印结果，不写文件。

## 装上

1. **建系统用户，放程序**：比如用户 `<user>`，程序放 `/opt/<app>/`，探测结果写到 `<data-dir>`，后者的属主设成 `<user>`。
2. **systemd**：仓库里的 `server/dns/1ms-dns.service`、`server/watch/1ms-dns-watch.{service,timer}` 是 1ms.dog 用的，路径和地址都要换成你的。要点：
   - 以 `<user>` 运行，dns 只要 `CAP_NET_BIND_SERVICE` 一项能力；
   - `StateDirectory` 给 dns 一个 0700 的状态目录；
   - watch 是 oneshot，只给它写 `<data-dir>` 的权限；
   - timer 用 `OnCalendar=*:02/10`。
3. **防火墙**：53/udp、53/tcp 和结果接口的端口要对外放行，IPv4 和 IPv6 都要。在机器本身上测不出防火墙的问题，要从外面测。
4. **委派**：在父区里加 `<zone>` NS `<ns-host>`，再给 `<ns-host>` 加 A、AAAA 记录，指向这台机器。如果父区在 Cloudflare 这类有代理的服务上，这两条要设成只做 DNS，不走代理。
5. **证书**：不用手动签。dns 启动后会用 DNS-01 给 `<zone>`、`*.<zone>` 签证书，验证记录由它自己应答，前提是第 3、4 步已经通了。证书剩不到 30 天时自动续。Let's Encrypt 对同一组域名每周最多签 5 张，反复重装时，先保存好状态目录再放回去。
6. **IP 库**：dns 会把 DB-IP 的免费库（`dbip-country-lite`、`dbip-asn-lite`，CC BY 4.0）下载到状态目录，每月更新。展示国家和网络时要带上接口返回的 `geo` 署名。
7. **发布探测结果**：网页需要读到 `<data-dir>` 下的 `summary.json` 和 `days/`。用任意网页服务器只读发布这个目录，并带上 `Access-Control-Allow-Origin: *`。

## 验证

```bash
dig +norec @<ns-host> abcdefgh12345678.<zone> A    # 有应答，带 aa 标志
dig +norec @<ns-host> example.com A                # REFUSED：只做权威，不做递归
dig TXT whoami.<zone>                              # "resolver=<你的解析器>"
curl https://api.<zone>:2053/health                # ok
```

在机器之外跑，IPv4 和 IPv6 各一次。

## 数据

- `<data-dir>/days/`：每天一个文件，保留 `-keep` 天。可用率和中断记录都从这里来，丢了就回不来，换机器时要拷走。
- `latest.json`、`summary.json`：下一轮就会重写。
- 状态目录：都能重新获取（证书受签发次数限制）。
- dns 的查询记录只在内存里放 2 分钟，不写盘。程序不写访问日志，TLS 握手错误也丢弃。
