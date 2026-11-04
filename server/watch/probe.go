package main

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/miekg/dns"
	"github.com/quic-go/quic-go"
)

// Target is one resolver as listed in src/resolvers.mjs (targets.json is generated from it).
type Target struct {
	ID   string `json:"id"`
	UDP  string `json:"udp,omitempty"`  // first IPv4 address
	UDP6 string `json:"udp6,omitempty"` // first IPv6 address
	DoT  string `json:"dot,omitempty"`  // host name, port 853
	DoQ  string `json:"doq,omitempty"`  // host name, port 853 (RFC 9250)
	DoH  string `json:"doh"`            // URL
}

// Protos are the ways a resolver is probed, in display order.
var Protos = []string{"udp", "udp6", "dot", "doh", "doq"}

func (t Target) addr(p string) string {
	switch p {
	case "udp":
		return t.UDP
	case "udp6":
		return t.UDP6
	case "dot":
		return t.DoT
	case "doq":
		return t.DoQ
	case "doh":
		return t.DoH
	}
	return ""
}

// Result of one probe: Ms is the query's round trip on an established connection (so the protocols compare on the
// same footing: UDP has no connection, the others' handshakes are not counted), or Err is a short reason.
type Result struct {
	Ms  *int   `json:"ms,omitempty"`
	Err string `json:"err,omitempty"`
}

var timeout = 4 * time.Second

// tlsInsecure is for tests only (self-signed test servers).
var tlsInsecure = false

const qname = "example.com."

func question(id uint16) *dns.Msg {
	m := new(dns.Msg)
	m.SetQuestion(qname, dns.TypeA)
	m.Id = id
	m.SetEdns0(1232, false)
	return m
}

func check(r *dns.Msg, rtt time.Duration, err error) Result {
	if err != nil {
		return Result{Err: reason(err)}
	}
	if r.Rcode != dns.RcodeSuccess {
		return Result{Err: strings.ToLower(dns.RcodeToString[r.Rcode])}
	}
	if len(r.Answer) == 0 {
		return Result{Err: "empty"}
	}
	ms := max(int(rtt.Round(time.Millisecond)/time.Millisecond), 0)
	return Result{Ms: &ms}
}

func reason(err error) string {
	var ne net.Error
	s := strings.ToLower(err.Error())
	switch {
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, os.ErrDeadlineExceeded),
		errors.As(err, &ne) && ne.Timeout(), strings.Contains(s, "timeout"):
		return "timeout"
	case strings.Contains(s, "refused"):
		return "refused"
	case strings.Contains(s, "unreachable"):
		return "unreachable"
	case strings.Contains(s, "no such host"):
		return "nxdomain"
	case strings.Contains(s, "x509") || strings.Contains(s, "tls") || strings.Contains(s, "certificate"):
		return "tls"
	case strings.Contains(s, "http "):
		return strings.TrimSpace(s[strings.Index(s, "http "):])
	}
	return "error"
}

func Probe(ctx context.Context, p, addr string) Result {
	switch p {
	case "udp", "udp6":
		c := &dns.Client{Net: "udp", Timeout: timeout}
		return check(c.ExchangeContext(ctx, question(dns.Id()), net.JoinHostPort(addr, "53")))
	case "dot":
		return probeDoT(ctx, addr)
	case "doh":
		return probeDoH(ctx, addr)
	case "doq":
		return probeDoQ(ctx, addr)
	}
	return Result{Err: "unknown"}
}

func hostPort(a, port string) (host, hp string) {
	if h, _, err := net.SplitHostPort(a); err == nil {
		return h, a
	}
	return a, net.JoinHostPort(a, port)
}

func probeDoT(ctx context.Context, addr string) Result {
	host, hp := hostPort(addr, "853")
	c := &dns.Client{Net: "tcp-tls", Timeout: timeout, TLSConfig: &tls.Config{ServerName: host, InsecureSkipVerify: tlsInsecure}}
	conn, err := c.Dial(hp)
	if err != nil {
		return Result{Err: reason(err)}
	}
	defer conn.Close()
	return check(c.ExchangeWithConnContext(ctx, question(dns.Id()), conn))
}

// probeDoH sends the query twice on one connection and times the second (the first pays for the connection).
func probeDoH(ctx context.Context, u string) Result {
	tr := &http.Transport{ForceAttemptHTTP2: true, TLSHandshakeTimeout: timeout,
		TLSClientConfig: &tls.Config{InsecureSkipVerify: tlsInsecure}}
	defer tr.CloseIdleConnections()
	cl := &http.Client{Transport: tr, Timeout: timeout}
	if _, err := dohGet(ctx, cl, u); err != nil {
		return Result{Err: reason(err)}
	}
	start := time.Now()
	r, err := dohGet(ctx, cl, u)
	return check(r, time.Since(start), err)
}

func dohGet(ctx context.Context, cl *http.Client, u string) (*dns.Msg, error) {
	b, err := question(0).Pack()
	if err != nil {
		return nil, err
	}
	sep := "?"
	if strings.Contains(u, "?") {
		sep = "&"
	}
	req, err := http.NewRequestWithContext(ctx, "GET", u+sep+"dns="+base64.RawURLEncoding.EncodeToString(b), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/dns-message")
	req.Header.Set("User-Agent", "1ms-dns-watch (https://dns.1ms.dog)")
	res, err := cl.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 65536))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("http %d", res.StatusCode)
	}
	m := new(dns.Msg)
	return m, m.Unpack(body)
}

// probeDoQ: DNS over QUIC (RFC 9250): one query per stream, 2-byte length prefix, message ID 0.
func probeDoQ(ctx context.Context, addr string) Result {
	host, hp := hostPort(addr, "853")
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	conn, err := quic.DialAddr(ctx, hp, &tls.Config{ServerName: host, NextProtos: []string{"doq"}, InsecureSkipVerify: tlsInsecure},
		&quic.Config{HandshakeIdleTimeout: timeout})
	if err != nil {
		return Result{Err: reason(err)}
	}
	defer conn.CloseWithError(0, "")
	start := time.Now()
	st, err := conn.OpenStreamSync(ctx)
	if err != nil {
		return Result{Err: reason(err)}
	}
	b, _ := question(0).Pack()
	if _, err := st.Write(append([]byte{byte(len(b) >> 8), byte(len(b))}, b...)); err != nil {
		return Result{Err: reason(err)}
	}
	st.Close()
	st.SetReadDeadline(time.Now().Add(timeout))
	var l [2]byte
	if _, err := io.ReadFull(st, l[:]); err != nil {
		return Result{Err: reason(err)}
	}
	resp := make([]byte, int(l[0])<<8|int(l[1]))
	if _, err := io.ReadFull(st, resp); err != nil {
		return Result{Err: reason(err)}
	}
	rtt := time.Since(start)
	m := new(dns.Msg)
	return check(m, rtt, m.Unpack(resp))
}
