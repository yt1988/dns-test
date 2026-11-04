package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/miekg/dns"
)

func answerer(w dns.ResponseWriter, r *dns.Msg) {
	m := new(dns.Msg)
	m.SetReply(r)
	m.Answer = []dns.RR{&dns.A{Hdr: dns.RR_Header{Name: r.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60}, A: net.IPv4(192, 0, 2, 1)}}
	w.WriteMsg(m)
}

func TestTargets(t *testing.T) {
	var ts []Target
	if err := json.Unmarshal(targetsJSON, &ts); err != nil || len(ts) < 30 {
		t.Fatalf("%d targets, %v", len(ts), err)
	}
	for _, x := range ts {
		if x.ID == "" || x.DoH == "" {
			t.Errorf("%+v", x)
		}
	}
}

func TestProbeUDP(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Skip(err)
	}
	srv := &dns.Server{PacketConn: pc, Handler: dns.HandlerFunc(answerer)}
	go srv.ActivateAndServe()
	defer srv.Shutdown()
	time.Sleep(50 * time.Millisecond)
	_, port, _ := net.SplitHostPort(pc.LocalAddr().String())
	c := &dns.Client{Net: "udp", Timeout: time.Second}
	r := check(c.Exchange(question(dns.Id()), "127.0.0.1:"+port))
	if r.Ms == nil || r.Err != "" {
		t.Fatalf("%+v", r)
	}
	// nothing listening: a short failure reason, not a panic
	timeout = 300 * time.Millisecond
	defer func() { timeout = 4 * time.Second }()
	if r := Probe(context.Background(), "dot", "127.0.0.1:1"); r.Ms != nil || r.Err == "" {
		t.Errorf("dot to nowhere: %+v", r)
	}
}

func TestProbeDoH(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, err := base64.RawURLEncoding.DecodeString(r.URL.Query().Get("dns"))
		q := new(dns.Msg)
		if err != nil || q.Unpack(b) != nil || q.Id != 0 {
			http.Error(w, "bad", 400)
			return
		}
		m := new(dns.Msg)
		m.SetReply(q)
		m.Answer = []dns.RR{&dns.A{Hdr: dns.RR_Header{Name: qname, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60}, A: net.IPv4(192, 0, 2, 1)}}
		out, _ := m.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		w.Write(out)
	}))
	defer srv.Close()
	tlsInsecure = true
	defer func() { tlsInsecure = false }()
	if r := Probe(context.Background(), "doh", srv.URL+"/dns-query"); r.Ms == nil {
		t.Fatalf("%+v", r)
	}
	if r := Probe(context.Background(), "doh", srv.URL+"/q?x=1"); r.Ms == nil {
		t.Fatalf("with a query string: %+v", r)
	}
}

func TestReason(t *testing.T) {
	for in, want := range map[error]string{
		context.DeadlineExceeded:                   "timeout",
		errors.New("dial tcp: connection refused"): "refused",
		errors.New("tls: handshake failure"):       "tls",
		errors.New("http 403"):                     "http 403",
		errors.New("something"):                    "error",
	} {
		if got := reason(in); got != want {
			t.Errorf("%v: %q", in, got)
		}
	}
}

func ms(v int) *int { return &v }

func TestSummarize(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 2, 30, 0, time.UTC)
	today := NewDay("2026-11-10")
	yesterday := NewDay("2026-11-09")
	old := NewDay("2026-10-20")
	// today: 10 ms at every slot up to now, one failure at 06:00
	for s := 0; s <= SlotOf(now); s++ {
		today.Set("a", "udp", s, Result{Ms: ms(10)})
	}
	today.Set("a", "udp", 36, Result{Err: "timeout"})
	// yesterday afternoon (inside 24 h): 30 ms
	for s := 80; s < Slots; s++ {
		yesterday.Set("a", "udp", s, Result{Ms: ms(30)})
	}
	// 3 weeks ago: all failed (counts only for 30 days)
	for s := 0; s < Slots; s++ {
		old.Set("a", "udp", s, Result{Err: "timeout"})
	}
	latest := map[string]map[string]Result{"a": {"udp": {Ms: ms(11)}, "dot": {Err: "tls"}}}
	s := Summarize(now, vantage, latest, []*Day{old, yesterday, today})
	st := s.R["a"]["udp"]
	if *st.Last != 11 || st.Err != "" {
		t.Errorf("last: %+v", st)
	}
	n24 := SlotOf(now) + 1 + (Slots - 80)
	if st.N24h != n24 {
		t.Errorf("n24h %d, want %d", st.N24h, n24)
	}
	if st.Up24h != round4(float64(n24-1)/float64(n24)) || st.Up7d != st.Up24h {
		t.Errorf("up: %+v", st)
	}
	if st.Up30d >= st.Up7d {
		t.Errorf("30 days should include the bad day: %+v", st)
	}
	if *st.Med24 != 10 {
		t.Errorf("median %d", *st.Med24)
	}
	if d := s.R["a"]["dot"]; d.Last != nil || d.Err != "tls" || d.N24h != 0 {
		t.Errorf("dot: %+v", d)
	}
	b, _ := json.Marshal(s)
	if !json.Valid(b) {
		t.Error("json")
	}
}

func TestDayFilesAndPrune(t *testing.T) {
	dir := t.TempDir()
	d := LoadDay(dir, "2026-11-10")
	d.Set("a", "doh", 3, Result{Ms: ms(25)})
	if err := writeJSON(filepath.Join(dir, "days", "2026-11-10.json"), d); err != nil {
		t.Fatal(err)
	}
	back := LoadDay(dir, "2026-11-10")
	if v := back.R["a"]["doh"]; len(v) != Slots || v[0] != nil || *v[3] != 25 {
		t.Fatalf("round trip: %v", v)
	}
	writeJSON(filepath.Join(dir, "days", "2026-01-01.json"), NewDay("2026-01-01"))
	Prune(dir, time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC), 90)
	if _, err := os.Stat(filepath.Join(dir, "days", "2026-01-01.json")); err == nil {
		t.Error("old day kept")
	}
	if _, err := os.Stat(filepath.Join(dir, "days", "2026-11-10.json")); err != nil {
		t.Error("today pruned")
	}
}
