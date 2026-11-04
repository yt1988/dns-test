package main

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/acme"
)

// CertMgr gets and renews the certificate for l.1ms.dog and *.l.1ms.dog from Let's Encrypt with DNS-01, answering the
// challenge from our own zone (ACMETXT), so it needs no port 80 and no other service.
type CertMgr struct {
	dir       string // state dir for this ACME directory
	directory string
	domains   []string
	txt       *ACMETXT
	cert      atomic.Pointer[tls.Certificate]
}

func NewCertMgr(state, directory string, domains []string, txt *ACMETXT) *CertMgr {
	sum := sha256.Sum256([]byte(directory))
	dir := filepath.Join(state, "acme-"+hex.EncodeToString(sum[:4]))
	os.MkdirAll(dir, 0o700)
	return &CertMgr{dir: dir, directory: directory, domains: domains, txt: txt}
}

func (c *CertMgr) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	if p := c.cert.Load(); p != nil {
		return p, nil
	}
	return nil, errors.New("no certificate yet")
}

func (c *CertMgr) load() error {
	kp, err := tls.LoadX509KeyPair(filepath.Join(c.dir, "cert.pem"), filepath.Join(c.dir, "key.pem"))
	if err != nil {
		return err
	}
	if kp.Leaf, err = x509.ParseCertificate(kp.Certificate[0]); err != nil {
		return err
	}
	c.cert.Store(&kp)
	return nil
}

func (c *CertMgr) needed() bool {
	p := c.cert.Load()
	if p == nil || time.Until(p.Leaf.NotAfter) < 30*24*time.Hour {
		return true
	}
	for _, d := range c.domains {
		if !slices.Contains(p.Leaf.DNSNames, d) {
			return true
		}
	}
	return false
}

func (c *CertMgr) Run(ctx context.Context) {
	c.load()
	backoff := 10 * time.Minute
	for {
		next := 12 * time.Hour
		if c.needed() {
			octx, cancel := context.WithTimeout(ctx, 5*time.Minute)
			err := c.obtain(octx)
			cancel()
			if err != nil {
				log.Printf("acme: %v", err)
				next, backoff = backoff, min(backoff*2, 6*time.Hour)
			} else {
				log.Printf("acme: certificate for %s until %s", strings.Join(c.domains, ", "), c.cert.Load().Leaf.NotAfter.Format(time.DateOnly))
				backoff = 10 * time.Minute
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(next):
		}
	}
}

func (c *CertMgr) accountKey() (crypto.Signer, error) {
	p := filepath.Join(c.dir, "account.pem")
	if b, err := os.ReadFile(p); err == nil {
		if blk, _ := pem.Decode(b); blk != nil {
			return x509.ParseECPrivateKey(blk.Bytes)
		}
	}
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, _ := x509.MarshalECPrivateKey(k)
	return k, writeFile(p, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}))
}

func writeFile(p string, b []byte) error {
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func (c *CertMgr) obtain(ctx context.Context) error {
	akey, err := c.accountKey()
	if err != nil {
		return err
	}
	cl := &acme.Client{Key: akey, DirectoryURL: c.directory, UserAgent: "1ms-dns"}
	if _, err := cl.Register(ctx, &acme.Account{}, acme.AcceptTOS); err != nil && !errors.Is(err, acme.ErrAccountAlreadyExists) {
		return fmt.Errorf("register: %w", err)
	}
	o, err := cl.AuthorizeOrder(ctx, acme.DomainIDs(c.domains...))
	if err != nil {
		return fmt.Errorf("order: %w", err)
	}
	defer c.txt.Clear()
	type pend struct {
		ch  *acme.Challenge
		uri string
	}
	var ps []pend
	for _, u := range o.AuthzURLs {
		z, err := cl.GetAuthorization(ctx, u)
		if err != nil {
			return err
		}
		if z.Status == acme.StatusValid {
			continue
		}
		var ch *acme.Challenge
		for _, x := range z.Challenges {
			if x.Type == "dns-01" {
				ch = x
			}
		}
		if ch == nil {
			return fmt.Errorf("no dns-01 challenge for %s", z.Identifier.Value)
		}
		rec, err := cl.DNS01ChallengeRecord(ch.Token)
		if err != nil {
			return err
		}
		c.txt.Add("_acme-challenge."+z.Identifier.Value, rec)
		ps = append(ps, pend{ch, z.URI})
	}
	for _, p := range ps {
		if _, err := cl.Accept(ctx, p.ch); err != nil {
			return fmt.Errorf("accept: %w", err)
		}
	}
	for _, p := range ps {
		if _, err := cl.WaitAuthorization(ctx, p.uri); err != nil {
			return fmt.Errorf("authorization: %w", err)
		}
	}
	if o, err = cl.WaitOrder(ctx, o.URI); err != nil {
		return fmt.Errorf("order: %w", err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{DNSNames: c.domains}, key)
	if err != nil {
		return err
	}
	ders, _, err := cl.CreateOrderCert(ctx, o.FinalizeURL, csr, true)
	if err != nil {
		return fmt.Errorf("finalize: %w", err)
	}
	var chain []byte
	for _, d := range ders {
		chain = append(chain, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: d})...)
	}
	kder, _ := x509.MarshalECPrivateKey(key)
	if err := writeFile(filepath.Join(c.dir, "key.pem"), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder})); err != nil {
		return err
	}
	if err := writeFile(filepath.Join(c.dir, "cert.pem"), chain); err != nil {
		return err
	}
	return c.load()
}
