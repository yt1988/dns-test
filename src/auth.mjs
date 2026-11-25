// The shell's short-lived token for the results API (tool-contract.md, "端点鉴权"): the page carries
// <meta name="ms-auth" content="v1.<exp>.<nonce>.<scope>.<hmac>"> and sends it only to api.<zone>/t/<token>.
// The random-name lookups are the DNS measurement itself and never take it; neither does anything else.
//
// A 401 means the page's copy has expired (or was minted before the secret was set): ask the shell's /_ms/token
// once, write the new value back into the meta and try once more. If that fails, the 401 stands and the caller
// degrades — no retry loop. `deps` exists so the tests can run without a browser.

export function tokenOf(doc = globalThis.document) {
  const m = doc && doc.querySelector && doc.querySelector('meta[name="ms-auth"]');
  return (m && m.getAttribute("content")) || "";
}

export function setToken(doc, token) {
  const m = doc && doc.querySelector && doc.querySelector('meta[name="ms-auth"]');
  if (m) m.setAttribute("content", token);
}

export async function authFetch(url, init = {}, deps = {}) {
  const f = deps.fetch || globalThis.fetch;
  const doc = deps.doc || globalThis.document;
  const tokenPath = deps.tokenPath || "/_ms/token";
  const send = token => {
    const headers = new Headers(init.headers || {});
    if (token) headers.set("Authorization", "Bearer " + token);
    else headers.delete("Authorization");
    return f(url, { ...init, headers });
  };
  const res = await send(tokenOf(doc));
  if (res.status !== 401) return res;
  let fresh = "";
  try {
    const rr = await f(tokenPath, { cache: "no-store", credentials: "same-origin" });
    if (rr.ok) fresh = String((await rr.json()).token || "").trim();
  } catch (e) { /* no renewal: the 401 is the answer, the caller degrades */ }
  if (!fresh) return res;
  setToken(doc, fresh);
  return send(fresh);
}
