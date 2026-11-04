package main

import (
	"encoding/json"
	"net"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/miekg/dns"
)

var t0 = time.Date(2026, 11, 4, 0, 0, 0, 0, time.UTC)

func newTestDNS() (*DNS, *Store) {
	st := NewStore(2 * time.Minute)
	return NewDNS("l.1ms.dog", "ns-l.1ms.dog", net.ParseIP("16.76.79.94"), net.ParseIP("2406:da14:3c2:6400:d2e5:c654:ae70:30c5"),
		st, NewRRL(50, 100), NewACMETXT()), st
}

func query(name string, t uint16, ecs string) *dns.Msg {
	m := new(dns.Msg)
	m.SetQuestion(name, t)
	if ecs != "" {
		_, n, _ := net.ParseCIDR(ecs)
		ones, _ := n.Mask.Size()
		fam := uint16(1)
		if n.IP.To4() == nil {
			fam = 2
		}
		m.SetEdns0(1232, false)
		o := m.IsEdns0()
		o.Option = append(o.Option, &dns.EDNS0_SUBNET{Code: dns.EDNS0SUBNET, Family: fam, SourceNetmask: uint8(ones), Address: n.IP})
	}
	return m
}

func packs(t *testing.T, m *dns.Msg) {
	t.Helper()
	if _, err := m.Pack(); err != nil {
		t.Fatalf("pack: %v\n%v", err, m)
	}
}

func TestParseLabel(t *testing.T) {
	for _, c := range []struct {
		in, tok, tag string
		ok           bool
	}{
		{"abcdefgh", "abcdefgh", "", true},
		{"AbCdEfGh12-g", "abcdefgh12", "g", true},
		{"abcdefgh-google1", "abcdefgh", "google1", true},
		{"abc", "", "", false},
		{"api", "", "", false},
		{"whoami", "", "", false},
		{"abcdefgh-", "", "", false},
		{"abcdefgh.x", "", "", false},
		{"abcdefgh-a-b", "", "", false},
	} {
		tok, tag, ok := ParseLabel(c.in)
		if tok != c.tok || tag != c.tag || ok != c.ok {
			t.Errorf("%q: got %q %q %v", c.in, tok, tag, ok)
		}
	}
}

func TestTokenAnswerAndRecord(t *testing.T) {
	d, st := newTestDNS()
	src := net.ParseIP("8.8.4.4")
	m := d.answer(query("TestTok01-G.l.1ms.dog.", dns.TypeA, "203.0.113.77/24"), src, "udp", 4, t0)
	packs(t, m)
	if !m.Authoritative || m.RecursionAvailable || len(m.Answer) != 1 || m.Answer[0].(*dns.A).A.String() != "16.76.79.94" || m.Answer[0].Header().Ttl != 0 {
		t.Fatalf("answer: %v", m)
	}
	var echoed bool
	for _, o := range m.IsEdns0().Option {
		if e, ok := o.(*dns.EDNS0_SUBNET); ok && e.SourceNetmask == 24 && e.SourceScope == 0 {
			echoed = true
		}
	}
	if !echoed {
		t.Errorf("ECS not echoed: %v", m)
	}
	d.answer(query("testtok01-g.l.1ms.dog.", dns.TypeA, "203.0.113.77/24"), src, "udp", 4, t0.Add(time.Second))
	d.answer(query("testtok01.l.1ms.dog.", dns.TypeAAAA, ""), net.ParseIP("2001:db8::1"), "tcp", 6, t0.Add(2*time.Second))
	hits, _ := st.Get("testtok01", t0.Add(3*time.Second))
	if len(hits) != 2 {
		t.Fatalf("hits: %+v", hits)
	}
	h := hits[0]
	if h.Tag != "g" || h.Zone != "l" || h.IP != "8.8.4.4" || h.Family != 4 || h.Proto != "udp" || h.QType != "A" || h.ECS != "203.0.113.0/24" || h.N != 2 || h.Ms != 0 {
		t.Errorf("hit 0: %+v", h)
	}
	if h := hits[1]; h.Tag != "" || h.Family != 6 || h.Proto != "tcp" || h.QType != "AAAA" || h.ECS != "" || h.Ms != 2000 {
		t.Errorf("hit 1: %+v", h)
	}
	if hits, _ := st.Get("testtok01", t0.Add(3*time.Minute)); hits != nil {
		t.Errorf("kept past 2 minutes")
	}
}

func TestRefusedOutsideZone(t *testing.T) {
	d, _ := newTestDNS()
	for _, n := range []string{"example.com.", "1ms.dog.", "xl.1ms.dog."} {
		m := d.answer(query(n, dns.TypeA, ""), net.ParseIP("1.2.3.4"), "udp", 4, t0)
		packs(t, m)
		if m.Rcode != dns.RcodeRefused || m.Authoritative || len(m.Answer) != 0 {
			t.Errorf("%s: %v", n, m)
		}
	}
}

func TestSingleFamilyChildren(t *testing.T) {
	d, st := newTestDNS()
	// over IPv4, a v6 name gets a referral to the IPv6-only server, and nothing is recorded
	m := d.answer(query("abcdefgh.v6.l.1ms.dog.", dns.TypeA, ""), net.ParseIP("1.2.3.4"), "udp", 4, t0)
	packs(t, m)
	if m.Authoritative || len(m.Answer) != 0 || len(m.Ns) != 1 || m.Ns[0].(*dns.NS).Ns != "ns6.l.1ms.dog." {
		t.Fatalf("referral: %v", m)
	}
	if _, ok := m.Extra[0].(*dns.AAAA); !ok {
		t.Errorf("glue: %v", m.Extra)
	}
	if hits, _ := st.Get("abcdefgh", t0); hits != nil {
		t.Errorf("recorded a referral")
	}
	// over IPv6 it is answered and recorded; the v6 zone has no A records
	m = d.answer(query("abcdefgh.v6.l.1ms.dog.", dns.TypeAAAA, ""), net.ParseIP("2001:db8::53"), "udp", 6, t0)
	packs(t, m)
	if !m.Authoritative || len(m.Answer) != 1 {
		t.Fatalf("answer: %v", m)
	}
	m = d.answer(query("abcdefgh.v6.l.1ms.dog.", dns.TypeA, ""), net.ParseIP("2001:db8::53"), "udp", 6, t0)
	if len(m.Answer) != 0 || len(m.Ns) != 1 || m.Ns[0].(*dns.SOA).Ns != "ns6.l.1ms.dog." {
		t.Errorf("v6 zone A: %v", m)
	}
	if hits, _ := st.Get("abcdefgh", t0); len(hits) != 2 || hits[0].Zone != "v6" {
		t.Errorf("hits: %+v", hits)
	}
	// ns4 has only an A record
	m = d.answer(query("ns4.l.1ms.dog.", dns.TypeAAAA, ""), net.ParseIP("1.2.3.4"), "udp", 4, t0)
	if len(m.Answer) != 0 || m.Rcode != dns.RcodeSuccess {
		t.Errorf("ns4 AAAA: %v", m)
	}
}

func TestNamesAndAcme(t *testing.T) {
	d, _ := newTestDNS()
	src := net.ParseIP("1.2.3.4")
	if m := d.answer(query("nope.l.1ms.dog.", dns.TypeA, ""), src, "udp", 4, t0); m.Rcode != dns.RcodeNameError || !m.Authoritative {
		t.Errorf("nxdomain: %v", m)
	}
	if m := d.answer(query("l.1ms.dog.", dns.TypeNS, ""), src, "udp", 4, t0); len(m.Answer) != 1 || m.Answer[0].(*dns.NS).Ns != "ns-l.1ms.dog." {
		t.Errorf("NS: %v", m)
	}
	if m := d.answer(query("api.l.1ms.dog.", dns.TypeAAAA, ""), src, "udp", 4, t0); len(m.Answer) != 1 {
		t.Errorf("api AAAA: %v", m)
	}
	m := d.answer(query("whoami.l.1ms.dog.", dns.TypeTXT, "198.51.100.9/24"), src, "udp", 4, t0)
	packs(t, m)
	if txt := m.Answer[0].(*dns.TXT).Txt; len(txt) != 2 || txt[0] != "resolver=1.2.3.4" || txt[1] != "ecs=198.51.100.0/24" {
		t.Errorf("whoami: %v", txt)
	}
	if m := d.answer(query("_acme-challenge.l.1ms.dog.", dns.TypeTXT, ""), src, "udp", 4, t0); m.Rcode != dns.RcodeNameError {
		t.Errorf("acme before: %v", m)
	}
	d.acme.Add("_acme-challenge.l.1ms.dog", "one")
	d.acme.Add("_acme-challenge.l.1ms.dog", "two")
	if m := d.answer(query("_ACME-challenge.l.1ms.dog.", dns.TypeTXT, ""), src, "udp", 4, t0); len(m.Answer) != 2 {
		t.Errorf("acme: %v", m)
	}
}

func TestRRL(t *testing.T) {
	r := NewRRL(1, 3)
	ip := net.ParseIP("192.0.2.1")
	var got []string
	for i := 0; i < 6; i++ {
		got = append(got, r.Allow(ip, t0))
	}
	want := []string{"ok", "ok", "ok", "slip", "drop", "slip"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v", got)
		}
	}
	if r.Allow(net.ParseIP("192.0.2.200"), t0) != "drop" { // same /24
		t.Errorf("prefix not shared")
	}
	if r.Allow(ip, t0.Add(2*time.Second)) != "ok" {
		t.Errorf("no refill")
	}
}

func TestAPI(t *testing.T) {
	d, st := newTestDNS()
	api := &API{store: st, geo: &Geo{}, apex: "l.1ms.dog", settle: 0}
	d.answer(query("apitok123-x.l.1ms.dog.", dns.TypeA, ""), net.ParseIP("1.2.3.4"), "udp", 4, time.Now())
	for _, c := range []struct{ host, path string }{{"api.l.1ms.dog:2053", "/t/apitok123"}, {"APITOK123-y.l.1ms.dog:2053", "/"}} {
		w := httptest.NewRecorder()
		api.ServeHTTP(w, httptest.NewRequest("GET", "https://"+c.host+c.path, nil))
		var res Result
		if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil || w.Code != 200 {
			t.Fatalf("%s%s: %d %s", c.host, c.path, w.Code, w.Body)
		}
		if res.Token != "apitok123" || len(res.Hits) != 1 || res.Hits[0].Tag != "x" || w.Header().Get("Access-Control-Allow-Origin") != "*" {
			t.Errorf("%s%s: %s", c.host, c.path, w.Body)
		}
	}
	w := httptest.NewRecorder()
	api.ServeHTTP(w, httptest.NewRequest("GET", "https://api.l.1ms.dog:2053/t/emptytok1?wait=0", nil))
	if w.Code != 200 || w.Body.String() == "" {
		t.Errorf("empty: %d %s", w.Code, w.Body)
	}
	var res Result
	json.Unmarshal(w.Body.Bytes(), &res)
	if res.Hits == nil || len(res.Hits) != 0 {
		t.Errorf("empty hits: %s", w.Body)
	}
	w = httptest.NewRecorder()
	api.ServeHTTP(w, httptest.NewRequest("GET", "https://api.l.1ms.dog:2053/t/x", nil))
	if w.Code != 400 {
		t.Errorf("bad token: %d", w.Code)
	}
}

func TestServeOverSockets(t *testing.T) {
	d, st := newTestDNS()
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Skip(err)
	}
	srv := &dns.Server{PacketConn: pc, Handler: d}
	go srv.ActivateAndServe()
	defer srv.Shutdown()
	time.Sleep(50 * time.Millisecond)
	c := new(dns.Client)
	r, _, err := c.Exchange(query("socktok12.l.1ms.dog.", dns.TypeTXT, ""), pc.LocalAddr().String())
	if err != nil || len(r.Answer) != 1 {
		t.Fatalf("%v %v", r, err)
	}
	if hits, _ := st.Get("socktok12", time.Now()); len(hits) != 1 || hits[0].IP != "127.0.0.1" {
		t.Errorf("hits: %+v", hits)
	}
}
