package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const authTestSecret = "test-secret"

var authNow = time.Unix(1_700_000_000, 0)

func mintToken(secret, scope string, exp int64, nonce string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "v1|%d|%s|%s", exp, nonce, scope)
	return fmt.Sprintf("v1.%d.%s.%x", exp, nonce, mac.Sum(nil))
}

func authCall(auth *Auth, host, path, header string) (int, string) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	req := httptest.NewRequest("GET", "https://"+host+path, nil)
	if header != "" {
		req.Header.Set("Authorization", header)
	}
	rec := httptest.NewRecorder()
	auth.Wrap(next).ServeHTTP(rec, req)
	return rec.Code, strings.TrimSpace(rec.Body.String())
}

func testAuth(secret string) *Auth {
	a := NewAuth(secret, "api.l.1ms.dog")
	a.now = func() time.Time { return authNow }
	return a
}

func TestAuthUnsetLetsEverythingThrough(t *testing.T) {
	a := testAuth("")
	for _, u := range [][2]string{{"api.l.1ms.dog:2053", "/t/abc"}, {"abcd-s.l.1ms.dog:2053", "/"}} {
		if code, body := authCall(a, u[0], u[1], ""); code != 200 {
			t.Errorf("%s%s without a secret: %d %q, want 200", u[0], u[1], code, body)
		}
	}
}

func TestAuthNeedsATokenOnTheAPI(t *testing.T) {
	a := testAuth(authTestSecret)
	cases := map[string]string{"no Authorization": "", "another scheme": "Basic abc", "empty Bearer": "Bearer "}
	for name, header := range cases {
		if code, body := authCall(a, "api.l.1ms.dog:2053", "/t/abc", header); code != 401 || body != "no_token" {
			t.Errorf("%s: %d %q, want 401 no_token", name, code, body)
		}
	}
	// the same API under another name: /t/ is still the API, so a random hostname cannot be used to skip the check
	if code, body := authCall(a, "abcd-s.l.1ms.dog:2053", "/t/abc", ""); code != 401 || body != "no_token" {
		t.Errorf("no token under another host: %d %q, want 401 no_token", code, body)
	}
}

func TestAuthRejectsBadTokens(t *testing.T) {
	a := testAuth(authTestSecret)
	exp := authNow.Add(time.Minute).Unix()
	cases := map[string]string{
		"expired":      mintToken(authTestSecret, "dns", authNow.Unix()-1, "n1"),
		"other scope":  mintToken(authTestSecret, "probe", exp, "n2"),
		"wrong secret": mintToken("other", "dns", exp, "n3"),
		"malformed":    "v1.notanumber.n4.deadbeef",
	}
	for name, tok := range cases {
		if code, body := authCall(a, "api.l.1ms.dog:2053", "/t/abc", "Bearer "+tok); code != 401 || body != "bad_token" {
			t.Errorf("%s: %d %q, want 401 bad_token", name, code, body)
		}
	}
}

func TestAuthAcceptsPageAndServiceTokens(t *testing.T) {
	a := testAuth(authTestSecret)
	exp := authNow.Add(time.Minute).Unix()
	page := mintToken(authTestSecret, "dns", exp, "n1")
	full := mintToken(authTestSecret, strings.Join(capabilities, ","), exp, "n2")
	svc := mintToken(authTestSecret, "*", exp, "n3")
	for name, tok := range map[string]string{"page dns": page, "whole page set": full, "service *": svc} {
		if code, body := authCall(a, "api.l.1ms.dog:2053", "/t/abc", "Bearer "+tok); code != 200 {
			t.Errorf("%s: %d %q, want 200", name, code, body)
		}
	}
}

func TestAuthLeavesTheMeasurementHostsAlone(t *testing.T) {
	a := testAuth(authTestSecret)
	for _, host := range []string{"abcd-s.l.1ms.dog:2053", "abcd.l.1ms.dog:2053", "abcd-s.v6.l.1ms.dog:2053"} {
		if code, body := authCall(a, host, "/", ""); code != 200 {
			t.Errorf("%s: %d %q, want 200 (the random-name lookup is the measurement)", host, code, body)
		}
	}
	if code, body := authCall(a, "127.0.0.1:2054", "/t/abc", ""); code != 200 {
		t.Errorf("loopback self-check: %d %q, want 200", code, body)
	}
}

func TestAuthLetsPreflightThrough(t *testing.T) {
	a := testAuth(authTestSecret)
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	req := httptest.NewRequest("OPTIONS", "https://api.l.1ms.dog:2053/t/abc", nil)
	rec := httptest.NewRecorder()
	a.Wrap(next).ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("preflight: %d, want 204", rec.Code)
	}
}
