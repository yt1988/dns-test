// 1ms-dns: the authoritative DNS server for l.1ms.dog and its results API, on the 1ms.dog VPS.
//
// A page makes the browser look up a fresh random name under l.1ms.dog; the query that reaches us comes from the
// resolver the visitor really uses, so we can say which one it is (address, network, country) and whether it passed on
// the visitor's subnet (ECS). Query records are kept in memory for 2 minutes and never written anywhere.
//
// Port and directory are as registered in 1ms-shell docs/processes.md ("专用服务器"): 53/udp+tcp and 2053/tcp,
// /opt/1ms/dns/, service 1ms-dns, user 1ms-dns.
package main

import (
	"context"
	"crypto/tls"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/miekg/dns"
	"golang.org/x/crypto/acme"
)

func split(s string) []string {
	var out []string
	for _, x := range strings.Split(s, ",") {
		if x = strings.TrimSpace(x); x != "" {
			out = append(out, x)
		}
	}
	return out
}

func main() {
	dnsAddrs := flag.String("dns", "127.0.0.1:5353", "addresses to answer DNS on, udp and tcp (comma-separated)")
	apiAddrs := flag.String("api", "", "addresses for the HTTPS results API (comma-separated)")
	apiHTTP := flag.String("api-http", "", "a plain-HTTP results API address, for checks on the machine itself (loopback)")
	zone := flag.String("zone", "l.1ms.dog", "the zone")
	ns := flag.String("ns", "ns-l.1ms.dog", "the zone's name server (as delegated in the parent)")
	a := flag.String("a", "16.76.79.94", "this server's public IPv4 address")
	aaaa := flag.String("aaaa", "2406:da14:3c2:6400:d2e5:c654:ae70:30c5", "this server's public IPv6 address")
	state := flag.String("state", "/var/lib/1ms-dns", "state directory (certificate, geolocation databases)")
	acmeDir := flag.String("acme", acme.LetsEncryptURL, "ACME directory URL")
	flag.Parse()
	log.SetFlags(0)

	ctx := context.Background()
	store := NewStore(2 * time.Minute)
	rrl := NewRRL(50, 100)
	txt := NewACMETXT()
	d := NewDNS(*zone, *ns, net.ParseIP(*a), net.ParseIP(*aaaa), store, rrl, txt)
	for _, addr := range split(*dnsAddrs) {
		for _, n := range []string{"udp", "tcp"} {
			srv := &dns.Server{Addr: addr, Net: n, Handler: d, UDPSize: 1232,
				ReadTimeout: 3 * time.Second, WriteTimeout: 3 * time.Second, IdleTimeout: func() time.Duration { return 5 * time.Second }}
			go func() { log.Fatalf("dns %s/%s: %v", addr, n, srv.ListenAndServe()) }()
		}
	}
	go func() {
		for now := range time.Tick(15 * time.Second) {
			store.Sweep(now)
			rrl.Sweep(now)
		}
	}()

	geo := NewGeo(*state)
	go geo.Run(ctx)
	api := &API{store: store, geo: geo, apex: strings.TrimSuffix(strings.ToLower(*zone), "."), settle: 300 * time.Millisecond}
	quiet := log.New(io.Discard, "", 0) // TLS handshake errors name the client; never log them
	if addrs := split(*apiAddrs); len(addrs) > 0 {
		cm := NewCertMgr(*state, *acmeDir, []string{api.apex, "*." + api.apex}, txt)
		go cm.Run(ctx)
		for _, addr := range addrs {
			srv := &http.Server{Addr: addr, Handler: api, ErrorLog: quiet,
				TLSConfig:         &tls.Config{GetCertificate: cm.GetCertificate, MinVersion: tls.VersionTLS12},
				ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
			go func() { log.Fatalf("api %s: %v", addr, srv.ListenAndServeTLS("", "")) }()
		}
	}
	if *apiHTTP != "" {
		srv := &http.Server{Addr: *apiHTTP, Handler: api, ErrorLog: quiet, ReadHeaderTimeout: 5 * time.Second}
		go func() { log.Fatalf("api-http: %v", srv.ListenAndServe()) }()
	}
	log.Printf("1ms-dns: zone %s, dns %s, api %s", *zone, *dnsAddrs, *apiAddrs)
	select {}
}
