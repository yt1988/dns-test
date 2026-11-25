// The results API takes the shell's short-lived token; the random-name lookups never do (tool-contract.md, 端点鉴权).
import test from "node:test";
import assert from "node:assert/strict";
import { authFetch, tokenOf } from "../src/auth.mjs";

function fakeDoc(value) {
  const meta = value == null ? null : {
    value,
    getAttribute() { return this.value; },
    setAttribute(k, v) { this.value = v; },
  };
  return { meta, querySelector: sel => sel === 'meta[name="ms-auth"]' ? meta : null };
}

function recorder(responses) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, auth: new Headers(init.headers || {}).get("authorization") });
    const r = responses.shift();
    return typeof r === "function" ? r() : r;
  };
  return { calls, fetch };
}

const ok = () => ({ status: 200, ok: true, json: async () => ({ hits: [] }) });
const unauth = () => ({ status: 401, ok: false });
const newToken = tok => ({ status: 200, ok: true, json: async () => ({ token: tok }) });

test("a page with the meta sends its token", async () => {
  const doc = fakeDoc("v1.token.one");
  const { calls, fetch } = recorder([ok]);
  const res = await authFetch("https://api.example.com:2053/t/abc", {}, { fetch, doc });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [{ url: "https://api.example.com:2053/t/abc", auth: "Bearer v1.token.one" }]);
});

test("no meta means no Authorization header", async () => {
  const doc = fakeDoc(null);
  const { calls, fetch } = recorder([ok]);
  await authFetch("https://api.example.com:2053/t/abc", {}, { fetch, doc });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth, null);
});

test("a 401 renews the token once and retries once", async () => {
  const doc = fakeDoc("v1.old");
  const { calls, fetch } = recorder([unauth, newToken("v1.new"), ok]);
  const res = await authFetch("https://api.example.com:2053/t/abc", {}, { fetch, doc });
  assert.equal(res.status, 200);
  assert.deepEqual(calls.map(c => c.url), ["https://api.example.com:2053/t/abc", "/_ms/token", "https://api.example.com:2053/t/abc"]);
  assert.deepEqual(calls.map(c => c.auth), ["Bearer v1.old", null, "Bearer v1.new"]);
  assert.equal(tokenOf(doc), "v1.new", "the meta carries the new token");
});

test("a second 401 is the answer: no third attempt", async () => {
  const doc = fakeDoc("v1.old");
  const { calls, fetch } = recorder([unauth, newToken("v1.new"), unauth]);
  const res = await authFetch("https://api.example.com:2053/t/abc", {}, { fetch, doc });
  assert.equal(res.status, 401);
  assert.equal(calls.length, 3);
});

test("a renewal that fails leaves the 401 and stops", async () => {
  for (const renewal of [unauth, () => { throw new Error("offline"); }, newToken("")]) {
    const doc = fakeDoc("v1.old");
    const { calls, fetch } = recorder([unauth, renewal]);
    const res = await authFetch("https://api.example.com:2053/t/abc", {}, { fetch, doc });
    assert.equal(res.status, 401);
    assert.equal(calls.length, 2, "the API and /_ms/token, nothing else");
    assert.equal(tokenOf(doc), "v1.old", "the meta is left alone");
  }
});
