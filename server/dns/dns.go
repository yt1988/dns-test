package main

import (
	"net"
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"
)

// DNS answers for the zone l.1ms.dog (and nothing else: no recursion, everything outside is REFUSED).
//
//	<token>[-<tag>].l.1ms.dog      A + AAAA of this server; the query is recorded under the token
//	<token>[-<tag>].v4.l.1ms.dog   the same, but v4.l.1ms.dog is delegated to ns4.l.1ms.dog, which has only an A record:
//	                               a resolver can only get the answer by reaching us over IPv4
//	<token>[-<tag>].v6.l.1ms.dog   likewise over IPv6 (ns6.l.1ms.dog, AAAA only)
//	api.l.1ms.dog, whoami.l.1ms.dog   this server; TXT on whoami (and on any token name) says which resolver asked
//	_acme-challenge.l.1ms.dog      TXT for Let's Encrypt DNS-01 while a certificate is being issued
//
// The same process is ns-l, ns4 and ns6: for a v4/v6 name it tells by the address the query arrived on whether it is
// acting as the child server (answer) or as the parent (referral to the child).
type DNS struct {
	apex, v4z, v6z, ns, ns4, ns6 string
	a, aaaa                      net.IP
	store                        *Store
	rrl                          *RRL
	acme                         *ACMETXT
	now                          func() time.Time
}

const (
	tokenTTL = 0
	hostTTL  = 300
	nsTTL    = 3600
	serial   = 2026110401
)

func NewDNS(apex, ns string, a, aaaa net.IP, store *Store, rrl *RRL, acme *ACMETXT) *DNS {
	apex = dns.Fqdn(strings.ToLower(apex))
	return &DNS{apex: apex, v4z: "v4." + apex, v6z: "v6." + apex, ns: dns.Fqdn(strings.ToLower(ns)),
		ns4: "ns4." + apex, ns6: "ns6." + apex, a: a.To4(), aaaa: aaaa.To16(), store: store, rrl: rrl, acme: acme, now: time.Now}
}

func addrIP(a net.Addr) (net.IP, string) {
	switch x := a.(type) {
	case *net.UDPAddr:
		return x.IP, "udp"
	case *net.TCPAddr:
		return x.IP, "tcp"
	}
	return nil, ""
}

func family(ip net.IP) int {
	if ip.To4() != nil {
		return 4
	}
	return 6
}

func (d *DNS) ServeDNS(w dns.ResponseWriter, r *dns.Msg) {
	now := d.now()
	src, proto := addrIP(w.RemoteAddr())
	local, _ := addrIP(w.LocalAddr())
	if src == nil || local == nil {
		return
	}
	m := d.answer(r, src, proto, family(local), now)
	if proto == "udp" {
		switch d.rrl.Allow(src, now) {
		case "drop":
			return
		case "slip":
			t := new(dns.Msg)
			t.SetReply(r)
			t.Truncated = true
			w.WriteMsg(t)
			return
		}
		size := dns.MinMsgSize
		if o := r.IsEdns0(); o != nil && int(o.UDPSize()) > size {
			size = min(int(o.UDPSize()), 1232)
		}
		m.Truncate(size)
	}
	w.WriteMsg(m)
}

func ecsOf(o *dns.OPT) *dns.EDNS0_SUBNET {
	for _, x := range o.Option {
		if e, ok := x.(*dns.EDNS0_SUBNET); ok && (e.Family == 1 || e.Family == 2) {
			return e
		}
	}
	return nil
}

func formatECS(e *dns.EDNS0_SUBNET) string {
	bits := 32
	ip := e.Address.To4()
	if e.Family == 2 {
		bits, ip = 128, e.Address.To16()
	}
	if ip == nil || int(e.SourceNetmask) > bits {
		return ""
	}
	return (&net.IPNet{IP: ip.Mask(net.CIDRMask(int(e.SourceNetmask), bits)), Mask: net.CIDRMask(int(e.SourceNetmask), bits)}).String()
}

// answer builds the reply to one query that came from src over proto, to our address of family localFam.
func (d *DNS) answer(r *dns.Msg, src net.IP, proto string, localFam int, now time.Time) *dns.Msg {
	m := new(dns.Msg)
	m.SetReply(r)
	m.RecursionAvailable = false
	m.Compress = true
	if r.Opcode != dns.OpcodeQuery {
		m.Rcode = dns.RcodeNotImplemented
		return m
	}
	if len(r.Question) != 1 {
		m.Rcode = dns.RcodeFormatError
		return m
	}
	q := r.Question[0]
	name := strings.ToLower(q.Name)
	ecs := ""
	if opt := r.IsEdns0(); opt != nil {
		m.SetEdns0(1232, false)
		if e := ecsOf(opt); e != nil {
			ecs = formatECS(e)
			// RFC 7871: echo it; scope 0 = the answer is the same for every client subnet
			ro := m.IsEdns0()
			ro.Option = append(ro.Option, &dns.EDNS0_SUBNET{Code: dns.EDNS0SUBNET, Family: e.Family,
				SourceNetmask: e.SourceNetmask, SourceScope: 0, Address: e.Address})
		}
	}
	if q.Qclass != dns.ClassINET || !dns.IsSubDomain(d.apex, name) {
		m.Rcode = dns.RcodeRefused
		return m
	}
	m.Authoritative = true

	if strings.HasPrefix(name, "_acme-challenge.") {
		vals := d.acme.Get(name)
		switch {
		case len(vals) == 0:
			d.nxdomain(m, d.apex)
		case q.Qtype == dns.TypeTXT:
			for _, v := range vals {
				m.Answer = append(m.Answer, &dns.TXT{Hdr: hdr(q.Name, dns.TypeTXT, 0), Txt: []string{v}})
			}
		default:
			d.nodata(m, d.apex)
		}
		return m
	}

	zone, origin := "l", d.apex
	if dns.IsSubDomain(d.v4z, name) {
		zone, origin = "v4", d.v4z
	} else if dns.IsSubDomain(d.v6z, name) {
		zone, origin = "v6", d.v6z
	}
	if zone == "v4" && localFam != 4 || zone == "v6" && localFam != 6 {
		// we are the parent here: refer the resolver to the single-family child server
		m.Authoritative = false
		ns, glue := d.child(zone)
		m.Ns = []dns.RR{ns}
		m.Extra = append([]dns.RR{glue}, m.Extra...)
		return m
	}

	label := ""
	if name != origin {
		label = strings.TrimSuffix(name, "."+origin)
	}
	if tok, tag, ok := ParseLabel(label); ok {
		d.store.Add(tok, Hit{Tag: tag, Zone: zone, IP: src.String(), Family: family(src), Proto: proto,
			QType: dns.TypeToString[q.Qtype], ECS: ecs}, now)
		d.host(m, q, origin, zone != "v6", zone != "v4", src, ecs, tokenTTL)
		return m
	}
	switch {
	case label == "":
		switch q.Qtype {
		case dns.TypeSOA:
			m.Answer = []dns.RR{d.soa(origin)}
		case dns.TypeNS:
			if zone == "l" {
				m.Answer = []dns.RR{&dns.NS{Hdr: hdr(origin, dns.TypeNS, nsTTL), Ns: d.ns}}
			} else {
				ns, glue := d.child(zone)
				m.Answer = []dns.RR{ns}
				m.Extra = append([]dns.RR{glue}, m.Extra...)
			}
		case dns.TypeANY:
			m.Answer = []dns.RR{&dns.HINFO{Hdr: hdr(q.Name, dns.TypeHINFO, hostTTL), Cpu: "RFC8482"}}
		default:
			d.nodata(m, origin)
		}
	case label == "whoami" || zone == "l" && label == "api":
		d.host(m, q, origin, zone != "v6", zone != "v4", src, ecs, hostTTL)
	case zone == "l" && label == "ns4":
		d.host(m, q, origin, true, false, nil, "", nsTTL)
	case zone == "l" && label == "ns6":
		d.host(m, q, origin, false, true, nil, "", nsTTL)
	default:
		d.nxdomain(m, origin)
	}
	return m
}

func hdr(name string, t uint16, ttl uint32) dns.RR_Header {
	return dns.RR_Header{Name: name, Rrtype: t, Class: dns.ClassINET, Ttl: ttl}
}

// host answers for a name that is this server: A and/or AAAA, and a TXT saying who asked (when src is given).
func (d *DNS) host(m *dns.Msg, q dns.Question, origin string, v4, v6 bool, src net.IP, ecs string, ttl uint32) {
	switch {
	case q.Qtype == dns.TypeA && v4:
		m.Answer = []dns.RR{&dns.A{Hdr: hdr(q.Name, dns.TypeA, ttl), A: d.a}}
	case q.Qtype == dns.TypeAAAA && v6:
		m.Answer = []dns.RR{&dns.AAAA{Hdr: hdr(q.Name, dns.TypeAAAA, ttl), AAAA: d.aaaa}}
	case q.Qtype == dns.TypeTXT && src != nil:
		txt := []string{"resolver=" + src.String()}
		if ecs != "" {
			txt = append(txt, "ecs="+ecs)
		}
		m.Answer = []dns.RR{&dns.TXT{Hdr: hdr(q.Name, dns.TypeTXT, 0), Txt: txt}}
	case q.Qtype == dns.TypeANY:
		m.Answer = []dns.RR{&dns.HINFO{Hdr: hdr(q.Name, dns.TypeHINFO, ttl), Cpu: "RFC8482"}}
	default:
		d.nodata(m, origin)
	}
}

func (d *DNS) child(zone string) (dns.RR, dns.RR) {
	if zone == "v4" {
		return &dns.NS{Hdr: hdr(d.v4z, dns.TypeNS, nsTTL), Ns: d.ns4}, &dns.A{Hdr: hdr(d.ns4, dns.TypeA, nsTTL), A: d.a}
	}
	return &dns.NS{Hdr: hdr(d.v6z, dns.TypeNS, nsTTL), Ns: d.ns6}, &dns.AAAA{Hdr: hdr(d.ns6, dns.TypeAAAA, nsTTL), AAAA: d.aaaa}
}

func (d *DNS) soa(origin string) dns.RR {
	mname := d.ns
	switch origin {
	case d.v4z:
		mname = d.ns4
	case d.v6z:
		mname = d.ns6
	}
	return &dns.SOA{Hdr: hdr(origin, dns.TypeSOA, 60), Ns: mname, Mbox: "hostmaster.1ms.dog.", Serial: serial,
		Refresh: 3600, Retry: 600, Expire: 86400, Minttl: 60}
}

func (d *DNS) nodata(m *dns.Msg, origin string) { m.Ns = []dns.RR{d.soa(origin)} }

func (d *DNS) nxdomain(m *dns.Msg, origin string) {
	m.Rcode = dns.RcodeNameError
	m.Ns = []dns.RR{d.soa(origin)}
}

// ACMETXT holds the DNS-01 challenge records while a certificate is being issued.
type ACMETXT struct {
	mu sync.Mutex
	m  map[string][]string
}

func NewACMETXT() *ACMETXT { return &ACMETXT{m: map[string][]string{}} }

func (a *ACMETXT) Add(name, v string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	name = dns.Fqdn(strings.ToLower(name))
	a.m[name] = append(a.m[name], v)
}

func (a *ACMETXT) Get(name string) []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.m[name]...)
}

func (a *ACMETXT) Clear() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.m = map[string][]string{}
}
