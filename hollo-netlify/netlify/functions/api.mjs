// Holló eseménytér – szerveroldali API (Netlify Function)
// Minden esemény és fájl a koordinátor személyes OneDrive-jába kerül (Microsoft Graph).
import { getStore } from "@netlify/blobs";
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = "offline_access Files.ReadWrite User.Read";
const env = k => (globalThis.Netlify?.env?.get?.(k)) ?? process.env[k] ?? "";
const ROOT = () => (env("HOLLO_MAPPA") || "Holló Archívum").trim().replace(/^\/+|\/+$/g, "");
const TENANT = () => env("MS_TENANT") || "consumers";

const CITIES = { budapest: "Budapest", miskolc: "Miskolc", szeged: "Szeged", pecs: "Pécs", debrecen: "Debrecen" };
const STATUS = { 1: "Előkészületben", 2: "One-pager leadva", 3: "One-pager elfogadva", 4: "Kommunikációs terv leadva", 5: "Eseményre kész" };
const KIND = { onepager: { label: "One-pager", file: "OnePager" }, komm: { label: "Kommunikációs terv", file: "Kommunikacios_terv" } };

/* ---------------- small helpers ---------------- */
const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const coded = (code, httpStatus = 400, message = code) => Object.assign(new Error(message), { code, httpStatus });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = p => p.split("/").map(encodeURIComponent).join("/");
const safe = s => String(s || "").normalize("NFC").replace(/[<>:"/\\|?*#%\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 60).replace(/[. ]+$/, "") || "esemeny";
const extOf = n => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(n || "")); return m ? m[1].toLowerCase() : ""; };
const baseOf = n => String(n || "").replace(/\.[A-Za-z0-9]{1,8}$/, "");
const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const store = () => getStore({ name: "hollo", consistency: "strong" });
const fmtStamp = ms => ms ? new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(ms)) : "";

/* ---------------- signing & login ---------------- */
let secretCache = null;
async function secret() {
  if (secretCache) return secretCache;
  const s = store();
  let v = await s.get("secret");
  if (!v) { await s.set("secret", randomBytes(32).toString("hex")); v = await s.get("secret"); }
  return (secretCache = v);
}
const b64u = b => Buffer.from(b).toString("base64url");
async function sign(obj) {
  const body = b64u(JSON.stringify(obj));
  const mac = createHmac("sha256", await secret()).update(body).digest("base64url");
  return body + "." + mac;
}
async function verify(tok) {
  if (!tok || typeof tok !== "string" || !tok.includes(".")) return null;
  const [body, mac] = tok.split(".");
  const want = createHmac("sha256", await secret()).update(body).digest("base64url");
  const a = Buffer.from(mac || ""), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
}
const pwFp = pw => createHash("sha256").update("hollo:" + pw).digest("hex").slice(0, 12);
function eqStr(a, b) {
  const x = createHash("sha256").update(String(a)).digest(), y = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(x, y);
}
function roleFor(pw) {
  const k = env("HOLLO_KOORDINATOR_JELSZO"), s = env("HOLLO_JELSZO");
  if (k && eqStr(pw, k)) return { role: "koord", fp: pwFp(k) };
  if (s && eqStr(pw, s)) return { role: k ? "szervezo" : "koord", fp: pwFp(s) };
  return null;
}
async function login(req) {
  if (!env("HOLLO_JELSZO") && !env("HOLLO_KOORDINATOR_JELSZO")) return J({ error: "no_password_set" }, 500);
  const b = await req.json().catch(() => ({}));
  const name = clip(b.name, 60);
  if (!name) return J({ error: "name_required" }, 400);
  await sleep(300);
  const r = roleFor(String(b.password || ""));
  if (!r) return J({ error: "bad_password" }, 401);
  const token = await sign({ n: name, r: r.role, f: r.fp, e: Date.now() + 30 * 864e5 });
  return J({ token, name, role: r.role });
}
async function auth(req) {
  const h = req.headers.get("authorization") || "";
  const t = await verify(h.replace(/^Bearer\s+/i, ""));
  if (!t || !t.e || t.e < Date.now()) return null;
  // jelszócsere után a régi belépések érvénytelenek
  const k = env("HOLLO_KOORDINATOR_JELSZO"), s = env("HOLLO_JELSZO");
  const valid = [k && pwFp(k), s && pwFp(s)].filter(Boolean);
  if (!valid.includes(t.f)) return null;
  const role = (t.r === "koord" && k && t.f !== pwFp(k)) ? "szervezo" : t.r;
  return { name: t.n, role };
}
const needKoord = u => { if (u.role !== "koord") throw coded("forbidden", 403, "Ehhez koordinátori belépés kell."); };

/* ---------------- Microsoft tokens ---------------- */
let tokCache = null;
async function msTokens() {
  if (tokCache) return tokCache;
  tokCache = await store().get("ms", { type: "json" });
  return tokCache;
}
async function saveTokens(t) { tokCache = t; await store().setJSON("ms", t); }
const tokenUrl = () => `https://login.microsoftonline.com/${TENANT()}/oauth2/v2.0/token`;
async function accessToken() {
  const t = await msTokens();
  if (!t || !t.refresh_token) throw coded("not_connected", 409);
  if (t.access_token && t.expires_at > Date.now() + 120000) return t.access_token;
  const body = new URLSearchParams({ client_id: env("MS_CLIENT_ID"), client_secret: env("MS_CLIENT_SECRET"), grant_type: "refresh_token", refresh_token: t.refresh_token, scope: SCOPES });
  const r = await fetch(tokenUrl(), { method: "POST", body });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("token refresh failed", d.error, d.error_description);
    if (d.error === "invalid_grant") { tokCache = null; await store().delete("ms"); throw coded("not_connected", 409); }
    throw coded("ms_token", 502, "Microsoft token hiba: " + (d.error || r.status));
  }
  const n = Object.assign({}, t, { access_token: d.access_token, refresh_token: d.refresh_token || t.refresh_token, expires_at: Date.now() + (d.expires_in || 3600) * 1000 });
  await saveTokens(n);
  return n.access_token;
}

/* ---------------- Graph helpers ---------------- */
async function g(method, path, opts = {}) {
  const tok = await accessToken();
  const headers = Object.assign({ Authorization: `Bearer ${tok}` }, opts.headers || {});
  let body = opts.body;
  if (opts.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(opts.json); }
  for (let i = 0; i < 3; i++) {
    const res = await fetch(path.startsWith("http") ? path : GRAPH + path, { method, headers, body });
    if ((res.status === 429 || res.status === 503) && i < 2) { await sleep((Number(res.headers.get("retry-after")) || 1) * 1000); continue; }
    if (opts.raw) return res;
    if (!res.ok) throw await gErr(res);
    return res.status === 204 ? null : res.json();
  }
}
async function gErr(res) {
  const t = await res.text().catch(() => "");
  console.error("Graph error", res.status, t.slice(0, 500));
  return coded(res.status === 404 ? "ms_not_found" : "ms_error", res.status === 404 ? 404 : 502, `OneDrive hiba (${res.status})`);
}
const itemByPath = p => `/me/drive/root:/${enc(p)}`;

async function ensureFolder(path) {
  const r = await g("GET", itemByPath(path), { raw: true });
  if (r.ok) return r.json();
  if (r.status !== 404) throw await gErr(r);
  const i = path.lastIndexOf("/");
  const parent = i > 0 ? await ensureFolder(path.slice(0, i)) : await g("GET", "/me/drive/root");
  const c = await g("POST", `/me/drive/items/${parent.id}/children`, { json: { name: path.slice(i + 1), folder: {}, "@microsoft.graph.conflictBehavior": "fail" }, raw: true });
  if (c.ok) return c.json();
  if (c.status === 409) return g("GET", itemByPath(path));
  throw await gErr(c);
}
async function ensureChildFolder(parentId, name) {
  const c = await g("POST", `/me/drive/items/${parentId}/children`, { json: { name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }, raw: true });
  if (c.ok) return c.json();
  if (c.status === 409) return g("GET", `/me/drive/items/${parentId}:/${enc(name)}`);
  throw await gErr(c);
}
async function putText(path, text) {
  return g("PUT", `${itemByPath(path)}:/content`, { body: text, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/* ---------------- index (events JSON in OneDrive) ---------------- */
const indexPath = () => `${ROOT()}/_adatok/esemenyek.json`;
async function readIndex() {
  const r = await g("GET", itemByPath(indexPath()), { raw: true });
  if (r.status === 404) return { data: { version: 1, events: {} }, etag: null, id: null };
  if (!r.ok) throw await gErr(r);
  const meta = await r.json();
  const c = await fetch(meta["@microsoft.graph.downloadUrl"], { cache: "no-store" });
  if (!c.ok) throw coded("ms_error", 502, "Az eseménylista nem olvasható a OneDrive-ból.");
  const data = await c.json();
  if (!data.events) data.events = {};
  return { data, etag: meta.eTag, id: meta.id };
}
async function writeIndex(idx) {
  const body = JSON.stringify(idx.data, null, 1);
  let res;
  if (idx.id) res = await g("PUT", `/me/drive/items/${idx.id}/content`, { body, raw: true, headers: { "Content-Type": "application/json", "If-Match": idx.etag } });
  else res = await g("PUT", `${itemByPath(indexPath())}:/content?@microsoft.graph.conflictBehavior=fail`, { body, raw: true, headers: { "Content-Type": "application/json" } });
  if (res.status === 412 || res.status === 409) throw coded("conflict", 409);
  if (!res.ok) throw await gErr(res);
}
// read-modify-write with optimistic locking; fn mutates data.events (no OneDrive side effects inside)
async function mutate(fn) {
  for (let i = 0; i < 6; i++) {
    const idx = await readIndex();
    const out = fn(idx.data);
    try { await writeIndex(idx); return { data: idx.data, out }; }
    catch (e) { if (e.code === "conflict") { await sleep(150 * (i + 1) + Math.random() * 200); continue; } throw e; }
  }
  throw coded("busy", 503, "Túl sok egyidejű módosítás, próbáld újra.");
}
const list = data => Object.values(data.events || {});

/* ---------------- archive files (txt, csv) ---------------- */
function csvOf(events) {
  const q = v => { const s = String(v ?? ""); return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const last = (e, k) => { const a = e.files?.[k] || []; return a.length ? a[a.length - 1].name : ""; };
  const head = ["Város", "Dátum", "Időpont", "Esemény", "Főszervező", "Helyszín", "Állapot", "One-pager", "Kommunikációs terv", "Utoljára módosítva"];
  const rows = events.slice().sort((a, b) => (a.city || "").localeCompare(b.city || "") || (a.date || "").localeCompare(b.date || ""))
    .map(e => [CITIES[e.city], e.date, e.time, e.title, e.organizer, e.location, `${e.status}. ${STATUS[e.status]}`, last(e, "onepager"), last(e, "komm"), fmtStamp(e.updatedAt)].map(q).join(";"));
  return "﻿" + [head.join(";")].concat(rows).join("\r\n");
}
function eventTxt(e) {
  const L = [e.title, "=".repeat(Math.min(60, Math.max(6, (e.title || "").length))), "",
    `Város: ${CITIES[e.city] || ""}`, `Dátum: ${e.date}${e.time ? " " + e.time : ""}`, `Főszervező: ${e.organizer || ""}`,
    `Helyszín: ${e.location || ""}`, `Állapot: ${e.status}. ${STATUS[e.status]}`, "", "Leírás:", e.description || "–", "", "Fájlok:"];
  for (const k of ["onepager", "komm"]) (e.files?.[k] || []).forEach((f, i, a) => L.push(`- ${KIND[k].label} ${i + 1}. verzió${i === a.length - 1 ? " (aktuális)" : ""}: ${f.name} · ${fmtStamp(f.at)} · ${f.by || ""}`));
  L.push("", "Előzmények:");
  (e.history || []).forEach(x => L.push(`- ${fmtStamp(x.at)} · ${x.by || ""} · ${x.text || x.type}${x.status ? " → " + STATUS[x.status] : ""}${x.note ? " · Megjegyzés: " + x.note : ""}`));
  return L.join("\r\n");
}
async function writeArchiveFiles(data, ev, cities) {
  const jobs = [putText(`${ROOT()}/osszes_esemeny.csv`, csvOf(list(data)))];
  for (const c of new Set(cities.filter(Boolean))) jobs.push(putText(`${ROOT()}/${CITIES[c]}/${CITIES[c]}_esemenyek.csv`, csvOf(list(data).filter(e => e.city === c))));
  if (ev && ev.folderId) jobs.push(g("PUT", `/me/drive/items/${ev.folderId}:/esemeny.txt:/content`, { body: eventTxt(ev), headers: { "Content-Type": "text/plain; charset=utf-8" } }));
  const r = await Promise.allSettled(jobs);
  r.forEach(x => { if (x.status === "rejected") console.error("archive write failed", x.reason?.message); });
}

/* ---------------- event folders ---------------- */
const parentPathOf = ev => `${ROOT()}/${CITIES[ev.city]}/${(ev.date || "").slice(0, 4) || "datum_nelkul"}`;
const folderNameOf = ev => `${ev.date}_${safe(ev.title)}`;
async function ensureEventFolder(ev) {
  const parent = await ensureFolder(parentPathOf(ev));
  const want = folderNameOf(ev);
  if (ev.folderId) {
    const r = await g("GET", `/me/drive/items/${ev.folderId}`, { raw: true });
    if (r.ok) {
      const it = await r.json();
      if (it.parentReference?.id === parent.id && (it.name === want || it.name.startsWith(want + "_"))) return it.id;
      for (const name of [want, `${want}_${ev.id.slice(0, 4)}`]) {
        const m = await g("PATCH", `/me/drive/items/${ev.folderId}`, { json: { name, parentReference: { id: parent.id } }, raw: true });
        if (m.ok) return (await m.json()).id;
        if (m.status !== 409) throw await gErr(m);
      }
      throw coded("ms_error", 502, "Az esemény mappáját nem sikerült áthelyezni.");
    }
    if (r.status !== 404) throw await gErr(r);
  }
  const c = await g("POST", `/me/drive/items/${parent.id}/children`, { json: { name: want, folder: {}, "@microsoft.graph.conflictBehavior": "rename" } });
  return c.id;
}

/* ---------------- event endpoints ---------------- */
function cleanFields(b) {
  const f = {
    title: clip(b.title, 140), date: clip(b.date, 10), time: clip(b.time, 5), organizer: clip(b.organizer, 80),
    city: clip(b.city, 20), location: clip(b.location, 140), description: clip(b.description, 2000),
  };
  if (!f.title || !f.organizer || !/^\d{4}-\d{2}-\d{2}$/.test(f.date) || !CITIES[f.city]) throw coded("invalid", 400, "Hiányzó vagy hibás adat.");
  if (f.time && !/^\d{2}:\d{2}$/.test(f.time)) f.time = "";
  return f;
}
async function createEvent(req, user) {
  const f = cleanFields(await req.json());
  const now = Date.now();
  const ev = Object.assign({ id: randomBytes(8).toString("hex") }, f, {
    status: 1, files: { onepager: [], komm: [] }, createdAt: now, createdBy: user.name, updatedAt: now,
    history: [{ type: "created", text: "Esemény létrehozva", status: 1, at: now, by: user.name }],
  });
  ev.folderId = await ensureEventFolder(ev);
  const { data } = await mutate(d => { d.events[ev.id] = ev; });
  await writeArchiveFiles(data, ev, [ev.city]);
  return J({ ok: true, id: ev.id, events: list(data) });
}
async function getEvent(id) {
  const { data } = await readIndex();
  const ev = data.events[id];
  if (!ev) throw coded("not_found", 404, "Az esemény nem található.");
  return ev;
}
async function editEvent(req, user, id) {
  const f = cleanFields(await req.json());
  const cur = await getEvent(id);
  const folderId = await ensureEventFolder(Object.assign({}, cur, f));
  const now = Date.now();
  const { data, out } = await mutate(d => {
    const e = d.events[id]; if (!e) return null;
    Object.assign(e, f, { folderId, updatedAt: now });
    e.history = (e.history || []).concat([{ type: "edit", text: "Adatok módosítva", at: now, by: user.name }]);
    return e;
  });
  if (!out) throw coded("not_found", 404);
  await writeArchiveFiles(data, out, [cur.city, out.city]);
  return J({ ok: true, events: list(data) });
}
async function deleteEvent(user, id) {
  needKoord(user);
  const cur = await getEvent(id);
  if (cur.folderId) { const r = await g("DELETE", `/me/drive/items/${cur.folderId}`, { raw: true }); if (!r.ok && r.status !== 404) throw await gErr(r); }
  const { data } = await mutate(d => { delete d.events[id]; });
  await writeArchiveFiles(data, null, [cur.city]);
  return J({ ok: true, events: list(data) });
}

async function uploadStart(req, user, id) {
  const b = await req.json();
  const kind = b.kind; if (!KIND[kind]) throw coded("invalid", 400);
  const name = clip(b.name, 180); if (!name) throw coded("invalid", 400);
  const size = Number(b.size) || 0;
  if (size > 250 * 1024 * 1024) throw coded("too_large", 400, "A fájl túl nagy (max. 250 MB).");
  const ev = await getEvent(id);
  const s = Number(ev.status);
  if (kind === "onepager" && s > 2) throw coded("wrong_state", 409, "A one-pager már el van fogadva.");
  if (kind === "komm" && (s < 3 || s > 4)) throw coded("wrong_state", 409, "Kommunikációs tervet az elfogadott one-pager után lehet feltölteni.");
  const folderId = await ensureEventFolder(ev);
  const ext = extOf(name);
  const temp = `_feltoltes_${randomBytes(4).toString("hex")}_${safe(baseOf(name))}${ext ? "." + ext : ""}`;
  const r = await g("POST", `/me/drive/items/${folderId}:/${enc(temp)}:/createUploadSession`, { json: { item: { "@microsoft.graph.conflictBehavior": "rename" } } });
  return J({ uploadUrl: r.uploadUrl });
}
async function uploadDone(req, user, id) {
  const b = await req.json();
  const kind = b.kind; if (!KIND[kind]) throw coded("invalid", 400);
  const name = clip(b.name, 180) || "fajl";
  const ev = await getEvent(id);
  const folderId = await ensureEventFolder(ev);
  const item = await g("GET", `/me/drive/items/${encodeURIComponent(String(b.itemId || ""))}`);
  if (item.parentReference?.id !== folderId) throw coded("invalid", 400, "A feltöltött fájl nem az esemény mappájában van.");
  const arr = ev.files?.[kind] || [];
  const prev = arr.length ? arr[arr.length - 1] : null;
  // previous version -> korabbi_verziok
  let prevMoved = null;
  if (prev && !prev.old) {
    const old = await ensureChildFolder(folderId, "korabbi_verziok");
    const newName = `v${arr.length}_${prev.stored || prev.name}`;
    const m = await g("PATCH", `/me/drive/items/${prev.itemId}`, { json: { name: newName, parentReference: { id: old.id }, "@microsoft.graph.conflictBehavior": "rename" }, raw: true });
    if (m.ok) prevMoved = (await m.json()).name;
    else if (m.status !== 404) throw await gErr(m);
  }
  const ext = extOf(name);
  const mainName = `${KIND[kind].file} - ${safe(baseOf(name))}${ext ? "." + ext : ""}`;
  let stored = item.name;
  const rn = await g("PATCH", `/me/drive/items/${item.id}`, { json: { name: mainName }, raw: true });
  if (rn.ok) stored = (await rn.json()).name;
  const now = Date.now();
  const { data, out } = await mutate(d => {
    const e = d.events[id]; if (!e) return null;
    e.files = e.files || { onepager: [], komm: [] };
    const a = (e.files[kind] = e.files[kind] || []);
    if (a.length && prevMoved != null) Object.assign(a[a.length - 1], { old: true, stored: prevMoved });
    a.push({ itemId: item.id, name, stored, mainName, size: item.size || Number(b.size) || 0, at: now, by: user.name, old: false });
    const s = Number(e.status) || 1;
    let ns = s;
    if (kind === "onepager" && s <= 2) ns = 2;
    if (kind === "komm" && (s === 3 || s === 4)) ns = 4;
    e.status = ns; e.updatedAt = now;
    e.history = (e.history || []).concat([{ type: "upload", kind, file: name, text: `${KIND[kind].label} feltöltve: ${name}`, status: ns !== s ? ns : null, at: now, by: user.name }]);
    return e;
  });
  if (!out) throw coded("not_found", 404);
  await writeArchiveFiles(data, out, [out.city]);
  return J({ ok: true, events: list(data) });
}
async function decide(req, user, id) {
  needKoord(user);
  const b = await req.json();
  const kind = b.kind, accept = !!b.accept, note = clip(b.note, 1000);
  if (!KIND[kind]) throw coded("invalid", 400);
  const now = Date.now();
  const { data, out } = await mutate(d => {
    const e = d.events[id]; if (!e) return null;
    const s = Number(e.status);
    const expected = kind === "onepager" ? 2 : 4;
    if (s !== expected) return "state";
    const ns = kind === "onepager" ? (accept ? 3 : 1) : (accept ? 5 : 3);
    e.status = ns; e.updatedAt = now;
    e.history = (e.history || []).concat([{ type: accept ? "accept" : "reject", kind, text: `${KIND[kind].label} ${accept ? "elfogadva" : "visszaküldve javításra"}`, status: ns, note, at: now, by: user.name }]);
    return e;
  });
  if (out === null) throw coded("not_found", 404);
  if (out === "state") throw coded("wrong_state", 409, "Az esemény állapota közben megváltozott.");
  await writeArchiveFiles(data, out, [out.city]);
  return J({ ok: true, events: list(data) });
}
async function revert(req, user, id) {
  needKoord(user);
  const b = await req.json();
  const to = Number(b.to), note = clip(b.note, 1000);
  if (!(to >= 1 && to <= 4)) throw coded("invalid", 400);
  const now = Date.now();
  const { data, out } = await mutate(d => {
    const e = d.events[id]; if (!e) return null;
    if (to >= Number(e.status)) return "state";
    e.status = to; e.updatedAt = now;
    e.history = (e.history || []).concat([{ type: "revert", text: "Állapot visszaállítva", status: to, note, at: now, by: user.name }]);
    return e;
  });
  if (out === null) throw coded("not_found", 404);
  if (out === "state") throw coded("wrong_state", 409, "Csak korábbi állapotra lehet visszaállítani.");
  await writeArchiveFiles(data, out, [out.city]);
  return J({ ok: true, events: list(data) });
}
async function deleteFile(user, id, kind, idx) {
  if (!KIND[kind]) throw coded("invalid", 400);
  const ev = await getEvent(id);
  const arr = ev.files?.[kind] || [];
  const f = arr[idx]; if (!f) throw coded("not_found", 404, "A fájl nem található.");
  const s = Number(ev.status);
  const accepted = (kind === "onepager" && s >= 3) || (kind === "komm" && s >= 5);
  if (accepted && user.role !== "koord") throw coded("forbidden", 403, "Elfogadott dokumentumot csak koordinátor törölhet.");
  const r = await g("DELETE", `/me/drive/items/${f.itemId}`, { raw: true });
  if (!r.ok && r.status !== 404) throw await gErr(r);
  const isLatest = idx === arr.length - 1;
  let restored = null;
  if (isLatest && idx > 0) {
    const p = arr[idx - 1];
    const folderId = await ensureEventFolder(ev);
    const m = await g("PATCH", `/me/drive/items/${p.itemId}`, { json: { name: p.mainName || p.name, parentReference: { id: folderId }, "@microsoft.graph.conflictBehavior": "rename" }, raw: true });
    if (m.ok) restored = { itemId: p.itemId, stored: (await m.json()).name };
  }
  const now = Date.now();
  const { data, out } = await mutate(d => {
    const e = d.events[id]; if (!e) return null;
    const a = e.files?.[kind] || [];
    const j = a.findIndex(x => x.itemId === f.itemId);
    if (j >= 0) a.splice(j, 1);
    if (restored) { const p = a.find(x => x.itemId === restored.itemId); if (p) Object.assign(p, { old: false, stored: restored.stored }); }
    let ns = Number(e.status);
    if (!a.length) { if (kind === "onepager") ns = 1; else if (ns >= 4) ns = 3; }
    const changed = ns !== Number(e.status);
    e.status = ns; e.updatedAt = now;
    e.history = (e.history || []).concat([{ type: "file-delete", kind, file: f.name, text: `${KIND[kind].label} törölve: ${f.name}`, status: changed ? ns : null, at: now, by: user.name }]);
    return e;
  });
  if (!out) throw coded("not_found", 404);
  await writeArchiveFiles(data, out, [out.city]);
  return J({ ok: true, events: list(data) });
}
async function checkFiles(id) {
  const ev = await getEvent(id);
  const all = ["onepager", "komm"].flatMap(k => ev.files?.[k] || []);
  if (!all.length || !ev.folderId) return J({ missing: [] });
  const seen = new Set();
  const r = await g("GET", `/me/drive/items/${ev.folderId}/children?$select=id,name,folder&$top=200`, { raw: true });
  if (r.status === 404) return J({ missing: all.map(f => f.itemId) });
  if (!r.ok) throw await gErr(r);
  const kids = (await r.json()).value || [];
  kids.forEach(k => seen.add(k.id));
  const old = kids.find(k => k.folder && k.name === "korabbi_verziok");
  if (old) { const o = await g("GET", `/me/drive/items/${old.id}/children?$select=id&$top=200`); (o.value || []).forEach(k => seen.add(k.id)); }
  return J({ missing: all.filter(f => !seen.has(f.itemId)).map(f => f.itemId) });
}
async function fileLink(url) {
  const id = url.searchParams.get("id") || "";
  const mode = url.searchParams.get("mode") || "download";
  const { data } = await readIndex();
  const known = list(data).some(e => ["onepager", "komm"].some(k => (e.files?.[k] || []).some(f => f.itemId === id)));
  if (!known) throw coded("not_found", 404, "A fájl nem található.");
  if (mode === "view") {
    const p = await g("POST", `/me/drive/items/${encodeURIComponent(id)}/preview`, { json: {}, raw: true });
    if (p.ok) { const d = await p.json(); if (d.getUrl) return J({ url: d.getUrl }); }
  }
  const r = await g("GET", `/me/drive/items/${encodeURIComponent(id)}`, { raw: true });
  if (r.status === 404) throw coded("missing", 404, "A fájl már nincs meg a OneDrive-ban.");
  if (!r.ok) throw await gErr(r);
  const it = await r.json();
  return J({ url: it["@microsoft.graph.downloadUrl"], name: it.name });
}

/* ---------------- state & OneDrive connection ---------------- */
async function stateFor(user) {
  const missingConfig = !env("MS_CLIENT_ID") || !env("MS_CLIENT_SECRET");
  const t = await msTokens();
  const base = { name: user.name, role: user.role, missingConfig, root: ROOT() };
  if (!t || !t.refresh_token) return Object.assign(base, { connected: false });
  try {
    const { data } = await readIndex();
    return Object.assign(base, { connected: true, account: t.account || "", folderUrl: user.role === "koord" ? (t.rootUrl || "") : "", events: list(data) });
  } catch (e) {
    if (e.code === "not_connected") return Object.assign(base, { connected: false });
    throw e;
  }
}
async function connectUrl(origin) {
  if (!env("MS_CLIENT_ID") || !env("MS_CLIENT_SECRET")) throw coded("missing_config", 500, "Hiányzik az MS_CLIENT_ID vagy az MS_CLIENT_SECRET a Netlify beállításaiból.");
  const state = await sign({ t: Date.now(), n: randomBytes(8).toString("hex") });
  const q = new URLSearchParams({ client_id: env("MS_CLIENT_ID"), response_type: "code", redirect_uri: origin + "/api/ms-callback", response_mode: "query", scope: SCOPES, state, prompt: "select_account" });
  return `https://login.microsoftonline.com/${TENANT()}/oauth2/v2.0/authorize?${q}`;
}
function page(title, body) {
  return new Response(`<!DOCTYPE html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#eff1ee;color:#15181d;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}main{background:#fff;border:1px solid #d9ddd8;border-radius:14px;padding:28px;max-width:520px}h1{margin:0 0 10px;font-size:26px}a{display:inline-block;margin-top:16px;background:#1d4c5c;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600}</style></head><body><main>${body}</main></body></html>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
const escH = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
async function msCallback(url) {
  const err = url.searchParams.get("error");
  if (err) return page("Hiba", `<h1>Nem sikerült összekapcsolni</h1><p>A Microsoft ezt válaszolta: ${escH(url.searchParams.get("error_description") || err)}</p><a href="/">Vissza</a>`);
  const st = await verify(url.searchParams.get("state") || "");
  if (!st || Date.now() - st.t > 15 * 60000) return page("Hiba", `<h1>Lejárt a kérés</h1><p>Indítsd újra az összekapcsolást a felületről.</p><a href="/">Vissza</a>`);
  const body = new URLSearchParams({ client_id: env("MS_CLIENT_ID"), client_secret: env("MS_CLIENT_SECRET"), grant_type: "authorization_code", code: url.searchParams.get("code") || "", redirect_uri: url.origin + "/api/ms-callback", scope: SCOPES });
  const r = await fetch(tokenUrl(), { method: "POST", body });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.refresh_token) return page("Hiba", `<h1>Nem sikerült összekapcsolni</h1><p>${escH(d.error_description || d.error || "Ismeretlen hiba")}</p><a href="/">Vissza</a>`);
  await saveTokens({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in || 3600) * 1000 });
  let account = "";
  try { const me = await g("GET", "/me"); account = me.userPrincipalName || me.mail || me.displayName || ""; } catch (_) {}
  let rootUrl = "";
  try {
    const root = await ensureFolder(ROOT());
    rootUrl = root.webUrl || "";
    const idx = await readIndex();
    if (!idx.id) await writeIndex(idx);
    await putText(`${ROOT()}/OLVASS_EL.txt`, "Ezt a mappát a Holló eseménytér kezeli.\r\nA fájlokat a felületen érdemes szerkeszteni és törölni, hogy a mappaszerkezet rendben maradjon.\r\nA _adatok mappát ne töröld és ne szerkeszd.");
  } catch (e) { console.error("init folder failed", e.message); }
  await saveTokens(Object.assign({}, await msTokens(), { account, rootUrl }));
  return page("Kész", `<h1>Kész, a OneDrive össze van kötve</h1><p>Fiók: <b>${escH(account)}</b><br>Mappa: <b>${escH(ROOT())}</b></p><a href="/">Vissza a felületre</a>`);
}
async function disconnect(user) {
  needKoord(user);
  tokCache = null; await store().delete("ms");
  return J({ ok: true });
}

/* ---------------- router ---------------- */
export default async (req) => {
  const url = new URL(req.url);
  const p = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const m = req.method;
  try {
    if (p[0] === "login" && m === "POST") return await login(req);
    if (p[0] === "ms-callback" && m === "GET") return await msCallback(url);
    const user = await auth(req);
    if (!user) return J({ error: "auth" }, 401);
    if (p[0] === "state" && m === "GET") return J(await stateFor(user));
    if (p[0] === "ms-connect" && m === "POST") { needKoord(user); return J({ url: await connectUrl(url.origin) }); }
    if (p[0] === "ms-disconnect" && m === "POST") return await disconnect(user);
    if (p[0] === "file" && m === "GET") return await fileLink(url);
    if (p[0] === "events") {
      if (p.length === 1 && m === "POST") return await createEvent(req, user);
      const id = p[1];
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id || "")) return J({ error: "not_found" }, 404);
      if (p.length === 2 && m === "PUT") return await editEvent(req, user, id);
      if (p.length === 2 && m === "DELETE") return await deleteEvent(user, id);
      if (p[2] === "upload-start" && m === "POST") return await uploadStart(req, user, id);
      if (p[2] === "upload-done" && m === "POST") return await uploadDone(req, user, id);
      if (p[2] === "decide" && m === "POST") return await decide(req, user, id);
      if (p[2] === "revert" && m === "POST") return await revert(req, user, id);
      if (p[2] === "check" && m === "GET") return await checkFiles(id);
      if (p[2] === "files" && m === "DELETE") return await deleteFile(user, id, p[3], Number(p[4]));
    }
    return J({ error: "not_found" }, 404);
  } catch (e) {
    if (!e.httpStatus) console.error(e);
    return J({ error: e.code || "server", message: e.httpStatus ? e.message : "Szerverhiba történt." }, e.httpStatus || 500);
  }
};

export const config = { path: "/api/*" };
