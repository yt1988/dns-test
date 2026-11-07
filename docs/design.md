# 设计取舍和测过的结论

技术上为什么这样做，以及测过的结果，按日期倒序排列。改东西之前先看，别把已经证明行不通的方法再试一遍。

## 2026-11-06

- **「DoQ ≈」这一列是 DoT 的估算**。浏览器发不了 DoQ（DNS over QUIC），网页脚本也开不出 853 端口的 QUIC 连接（WebTransport 是另一套协议）。一家的 DoQ 和 DoT 是同一台服务器，连接建立后每次查询都是一个来回，所以用同一个估算。真实的 DoQ 时间要在服务器上测（东京探测、命令行工具）。
- **列表里写的 DoQ 以实测为准**：`1ms-dns-watch -scan-doq` 从东京把每家的 DoQ、DoT、DoH 域名都用 DoQ 连一遍，每个试 3 次。这天能连通的：AdGuard、AdGuard Unfiltered、NextDNS（3 次里通 1 次）、Control D、阿里 DNS、Quad9（`dns.quad9.net`）、Hurricane Electric（`ordns.he.net`）、Digitale Gesellschaft、DNSForge、DNS4ALL（`dot.dns4all.eu`）、Comss.one、Tiarap（`dot.tiar.app`）。Cloudflare、Google、OpenDNS、Mullvad 等不支持。
- **UncensoredDNS 已经没有明文 DNS**：53 端口的 UDP 和 TCP 都永久关闭了（见它的博客），列表里只留 DoT 和 DoH。博客说支持 DoQ，但从东京连不上。
- **测过的候选**（这天从东京和香港两地用 DoH GET 试）：
  - 两地都超时：Quad101（`dns.twnic.tw`）。
  - 返回错误：RESTENA（`kaitain.restena.lu`）、puntCAT、Surfshark。
  - 返回空内容：BebasID（`dns.bebasid.com/unfiltered`）。
  - 能用，但不带 CORS：FDN（`ns0.fdn.fr`）、FFMUC（`doh.ffmuc.net`）、AAISP（`dns.aa.net.uk`）。
- **LCP（首屏加载时间）落在测量结果上**：
  - 线上的 LCP 元素主要是「你的设备实际在用的 DNS」卡片的说明（`#mineE`），其次是第一名的名字（`#winName`）。这两样都比标题大，又要等测量结束才出现。标题当 LCP 时约 1.6–1.8 秒。
  - 卡片要等三段时间：查询从访客的解析器递归到 `<zone>`；连接结果接口；服务端为晚到的 ECS 查询多等的 600 ms。查询在 `app.js` 一执行就发出；token 每次都要随机，所以没法预加载；CSP 不允许内联脚本。

## 2026-11-05

- **结果位置的占位字符只会改变 LCP 算哪个元素**。试过：在结果元素里先放一个 1px 的空格，Chrome 就会在首次绘制时把这个元素记为已画出，后来填进去的文字不再算新的 LCP。但结果本身并没有更早出现，所以撤掉了。踩过的两个坑：
  - 空格要用系统字体：网页字体下载完之前，文字是不可见的，不可见的文字不算已绘制。
  - 要 `letter-spacing: normal`：继承来的负字距会把空格宽度压成 0，宽度为 0 也不算。
- **性能优化不改测法，结果不能先错后对**：比如不改成「每家先查一条就定领先者」，也不先显示、后更正 ECS 的判断。能做的是测量开始前少等：
  - 预热时第一条填缓存的查询一回来就显示领先者（`onPeek`），不必等三条全回来；
  - 每条查询的耗时直接从 Resource Timing 缓冲区取，不等 PerformanceObserver 的回调。手机繁忙时，每条能省下最多 150 ms。
- **状态页 `/status/`**：每家每种协议现在的状态、过去 24 小时（每格 1 小时，所有协议合在一起算）、24 小时可用率（用 `days/` 里的原始探测算）、7 天和 30 天可用率（`summary.json` 里各协议的平均，因为每种协议每轮都测），以及过去 24 小时的每次中断（连续失败的探测合成一次）。浏览器直接读探测结果的 JSON。

## 2026-11-04

- **ECS 看最先到的那条查询**：浏览器用的是它的答案。中国联通先发一条不带 ECS 的查询，约 250 ms 后再从同一网络里的其他地址发带 ECS 的；后面这几条不是同一个解析器，不能据此判断按 DNS 分配节点的 CDN。结果接口默认等 600 ms（原来是 300 ms），把晚到的也收进来，判断方法写在 docs/l-api.md。
- **「为你服务的节点」放在每家展开后的详情里**，不单独占一列：手机宽度放不下。
- **体检嵌入（`?embed=checkup`）的 facts 只给 `resolverCountry`**（解析器所在国家，两位大写字母，查不到就不写这个键），不给 IP 和网段。
- **权威 DNS 只做权威，不做递归**：区外的查询一律 REFUSED，UDP 按来源前缀限速（RRL），超限的部分隔一个回一个截断应答，让真正的解析器改走 TCP，其余丢弃。这样就不会被人借去做放大攻击。
