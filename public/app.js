import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithCustomToken, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, collection, query, where, orderBy,
  limit, onSnapshot, writeBatch, serverTimestamp, arrayUnion, arrayRemove, deleteField
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getMessaging, getToken, onMessage, isSupported, deleteToken
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
import * as CONFIG from "./firebase-config.js";
const { firebaseConfig, COUNTRY_CODE } = CONFIG;
const VAPID_KEY = CONFIG.VAPID_KEY || "";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
auth.useDeviceLanguage();
const db = getFirestore(fb);

/* ================= helpers ================= */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem("kaburlu:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("kaburlu:" + k, JSON.stringify(v)); } catch {} }
};
const AV = ["#0E7C66", "#C2492B", "#3A5BA0", "#B0742A", "#7A4E9C", "#2E7D9A", "#A33E6B", "#4F7A2C"];
const hashStr = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const initials = (n) => (n || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
const avatar = (p, cls = "") => `<div class="av ${cls}" style="background:${AV[hashStr(p?.id || "x") % AV.length]}">${esc(initials(p?.name))}</div>`;
const fmtPhone = (p) => (p || "").replace(/^(\+91)(\d{5})(\d{5})$/, "$1 $2 $3");
const two = (n) => String(n).padStart(2, "0");
const hhmm = (ms) => { const d = new Date(ms); let h = d.getHours(); const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12; return `${h}:${two(d.getMinutes())} ${ap}`; };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const dayLabel = (ms) => {
  const d = new Date(ms), t = new Date(), y = new Date(); y.setDate(t.getDate() - 1);
  if (dayKey(ms) === dayKey(t)) return "Today";
  if (dayKey(ms) === dayKey(y)) return "Yesterday";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== t.getFullYear() ? " " + d.getFullYear() : ""}`;
};
const listTime = (ms) => dayKey(ms) === dayKey(Date.now()) ? hhmm(ms) : dayLabel(ms);
const ms = (ts) => ts?.toMillis ? ts.toMillis() : (typeof ts === "number" ? ts : Date.now());
const chatIdFor = (a, b) => [a, b].sort().join("_");
const otherOf = (cid, me) => cid.split("_").find(x => x !== me) || me;
const digits = (v) => v.replace(/\D/g, "");
const validMobile = (d) => /^[6-9]\d{9}$/.test(d);

async function sha(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const randomSalt = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");

let toastT;
function toast(msg) {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; t.setAttribute("role", "status");
  document.body.appendChild(t); clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 3500);
}

/* ================= state ================= */
const S = {
  user: null, profile: null, settings: { hidden: [], pinHash: null, salt: null },
  people: new Map(), chats: [], open: null, msgs: [], unlocked: false, vault: false, q: "",
  unsubs: [], unsubMsgs: null, unsubOpenChat: null
};
const hiddenSet = () => new Set(S.settings.hidden || []);
// Name to show for a contact: your own nickname for them, or the name they registered with.
const nameOf = (p) => (p && S.settings.nicknames?.[p.id]) || p?.name || "…";
const setScreen = (id) => { for (const s of ["loading", "auth", "app"]) $("#" + s).hidden = s !== id; };

/* ================= THEMES ================= */
const ACCENTS = [["jade", "#0E7C66", "Jade"], ["ocean", "#1F6FB2", "Ocean"], ["rose", "#C0396B", "Rose"], ["sunset", "#C8561E", "Sunset"], ["violet", "#6A4BC4", "Violet"]];
const WALLS = [["dots", "Dots"], ["plain", "Plain"], ["gradient", "Glow"], ["doodle", "Doodle"]];
const themeNow = () => ({ mode: "auto", accent: "jade", wall: "dots", ...ls.get("theme", {}) });
function applyTheme(t) {
  t = { mode: "auto", accent: "jade", wall: "dots", ...t };
  const r = document.documentElement;
  if (t.mode === "light" || t.mode === "dark") r.dataset.theme = t.mode; else delete r.dataset.theme;
  if (t.accent !== "jade") r.dataset.accent = t.accent; else delete r.dataset.accent;
  if (t.wall !== "dots") r.dataset.wall = t.wall; else delete r.dataset.wall;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(r).getPropertyValue("--accent").trim() || "#0E7C66";
  ls.set("theme", t);
}
applyTheme(themeNow());
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyTheme(themeNow()));

/* ================= server calls (Vercel functions) ================= */
async function api(path, body) {
  let r;
  try {
    r = await fetch("/api/" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch { throw new Error("No connection. Check your internet and try again."); }
  let d = {}; try { d = await r.json(); } catch {}
  if (!r.ok) throw new Error(d.error || "Server error. Try again in a minute.");
  return d;
}

/* ================= AUTH UI ================= */
let pending = null; // { body, ticket }
const FORMS = ["f-reg", "f-login", "f-forgot", "f-otp"];
function showForm(id) {
  for (const f of FORMS) $("#" + f).hidden = f !== id;
  $("#tab-reg").setAttribute("aria-selected", id === "f-reg");
  $("#tab-login").setAttribute("aria-selected", id === "f-login" || id === "f-forgot");
  $(".seg").hidden = id === "f-otp";
}
$("#tab-reg").onclick = () => showForm("f-reg");
$("#tab-login").onclick = () => showForm("f-login");
$("#l-forgot").onclick = () => {
  const d = digits($("#l-phone").value); if (d) $("#f-id").value = d;
  showForm("f-forgot"); setTimeout(() => $("#f-id").focus(), 50);
};
$("#f-back").onclick = () => showForm("f-login");
for (const id of ["#r-phone", "#l-phone"]) $(id).addEventListener("input", e => {
  const d = digits(e.target.value).slice(0, 10);
  e.target.value = d.length > 5 ? d.slice(0, 5) + " " + d.slice(5) : d;
});
$("#o-code").addEventListener("input", e => { e.target.value = digits(e.target.value).slice(0, 6); });

async function requestCode(body, btn, errEl) {
  const label = btn.textContent; btn.disabled = true; btn.textContent = "Sending…"; errEl.textContent = "";
  try {
    const d = await api("send-otp", body);
    pending = { body, ticket: d.ticket };
    const reset = body.mode === "reset";
    $("#o-to").innerHTML = `We emailed a 6-digit code to <b>${esc(d.to)}</b>. Check your inbox and spam folder.`;
    $("#o-pass-wrap").hidden = !reset; $("#o-pass").value = "";
    $("#o-go").textContent = reset ? "Set new password" : "Verify and create account";
    $("#o-code").value = ""; $("#o-err").textContent = "";
    showForm("f-otp"); setTimeout(() => $("#o-code").focus(), 50);
  } catch (ex) { errEl.textContent = ex.message; }
  finally { btn.disabled = false; btn.textContent = label; }
}

$("#f-reg").addEventListener("submit", (e) => {
  e.preventDefault(); const err = $("#r-err");
  const name = $("#r-name").value.trim().replace(/\s+/g, " ");
  const phone = digits($("#r-phone").value);
  const email = $("#r-email").value.trim().toLowerCase();
  const password = $("#r-pass").value;
  if (name.length < 2) { err.textContent = "Enter your name (at least 2 letters)."; return; }
  if (!validMobile(phone)) { err.textContent = "Enter a 10-digit mobile number starting with 6, 7, 8 or 9."; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err.textContent = "Enter a valid email address."; return; }
  if (password.length < 8) { err.textContent = "Password must be at least 8 characters."; return; }
  requestCode({ mode: "register", name, phone, email, password }, $("#r-go"), err);
});

$("#f-login").addEventListener("submit", async (e) => {
  e.preventDefault(); const err = $("#l-err"); err.textContent = "";
  const phone = digits($("#l-phone").value);
  const password = $("#l-pass").value;
  if (!validMobile(phone)) { err.textContent = "Enter your 10-digit mobile number."; return; }
  if (!password) { err.textContent = "Enter your password."; return; }
  const btn = $("#l-go"); btn.disabled = true; btn.textContent = "Logging in…";
  try {
    const d = await api("login", { phone, password });
    await signInWithCustomToken(auth, d.token);
    $("#l-pass").value = "";
  } catch (ex) { err.textContent = ex.message; }
  finally { btn.disabled = false; btn.textContent = "Log in"; }
});

$("#f-forgot").addEventListener("submit", (e) => {
  e.preventDefault(); const err = $("#f-err");
  const id = $("#f-id").value.trim();
  if (!id) { err.textContent = "Enter your mobile number or email."; return; }
  requestCode({ mode: "reset", id }, $("#f-go"), err);
});

$("#o-back").onclick = () => showForm(pending?.body.mode === "reset" ? "f-forgot" : "f-reg");
$("#o-resend").onclick = () => { if (pending) requestCode(pending.body, $("#o-resend"), $("#o-err")); };

$("#f-otp").addEventListener("submit", async (e) => {
  e.preventDefault(); const err = $("#o-err"); err.textContent = "";
  const code = $("#o-code").value;
  const reset = pending?.body.mode === "reset";
  const newPassword = $("#o-pass").value;
  if (code.length !== 6) { err.textContent = "Enter all 6 digits."; return; }
  if (reset && newPassword.length < 8) { err.textContent = "New password must be at least 8 characters."; return; }
  const btn = $("#o-go"); const label = btn.textContent; btn.disabled = true; btn.textContent = "Verifying…";
  try {
    const d = await api("verify-otp", { ticket: pending.ticket, code, ...(reset ? { newPassword } : {}) });
    await signInWithCustomToken(auth, d.token); // onAuthStateChanged takes over
    pending = null;
    toast(reset ? "Password changed. You're logged in." : "Account created. Welcome to Kaburlu!");
  } catch (ex) { err.textContent = ex.message; }
  finally { btn.disabled = false; btn.textContent = label; }
});

onAuthStateChanged(auth, async (u) => {
  stopApp();
  if (!u) { setScreen("auth"); if ($("#f-otp").hidden && $("#f-forgot").hidden) showForm("f-login"); return; }
  setScreen("loading");
  try {
    const p = await getDoc(doc(db, "users", u.uid));
    if (!p.exists()) { await signOut(auth); $("#l-err").textContent = "Account not found. Register first."; return; }
    await startApp(u);
  } catch (ex) { console.error(ex); setScreen("auth"); $("#l-err").textContent = "Couldn't load your account. Check that the Firestore rules are deployed (see README)."; showForm("f-login"); }
});

/* ================= APP ================= */
async function startApp(u) {
  S.user = u; S.vault = false; S.unlocked = false; S.open = null;
  setScreen("app");
  S.unsubs.push(onSnapshot(doc(db, "users", u.uid), s => {
    S.profile = { id: u.uid, ...s.data() }; S.people.set(u.uid, S.profile); renderMe();
  }));
  S.unsubs.push(onSnapshot(doc(db, "users", u.uid, "private", "settings"), s => {
    S.settings = s.exists() ? s.data() : { hidden: [], pinHash: null, salt: null };
    if (S.settings.theme && JSON.stringify({ ...themeNow(), ...S.settings.theme }) !== JSON.stringify(themeNow())) applyTheme(S.settings.theme);
    renderList(); renderMain(false);
  }));
  S.unsubs.push(onSnapshot(
    query(collection(db, "chats"), where("members", "array-contains", u.uid), orderBy("lastAt", "desc")),
    async snap => {
      S.chats = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
      await loadPeople(S.chats.map(c => otherOf(c.id, u.uid)));
      renderList();
      if (S.open && S.chats.some(c => c.id === S.open) && !S.unsubMsgs) subscribeMsgs(S.open);
      if (S.open) renderMsgs();
      markRead();
      openPendingChat();
    },
    err => { console.error(err); toast("Couldn't load chats. Check the Firestore index (see README)."); }
  ));
  renderMe(); renderMain(true);
  updateNotifyUI(); refreshPushToken();
}
function stopApp() {
  S.unsubs.forEach(f => f()); S.unsubs = [];
  S.unsubMsgs?.(); S.unsubMsgs = null;
  S.user = null; S.profile = null; S.chats = []; S.people = new Map(); S.open = null; S.msgs = [];
  $("#app").classList.remove("open");
}

async function loadPeople(ids) {
  const need = [...new Set(ids)].filter(id => !S.people.has(id));
  await Promise.all(need.map(async id => {
    try { const s = await getDoc(doc(db, "users", id)); S.people.set(id, s.exists() ? { id, ...s.data() } : { id, name: "Deleted user", phone: "" }); }
    catch { S.people.set(id, { id, name: "Unknown", phone: "" }); }
  }));
}

function renderMe() {
  const p = S.profile; if (!p) return;
  $("#me-av").innerHTML = avatar(p, "sm");
  $("#me-name").textContent = p.name || "";
  $("#me-phone").textContent = fmtPhone(p.phone);
}

/* --- list --- */
function renderList() {
  if (!S.user) return;
  const me = S.user.uid; const hid = hiddenSet();
  const q = S.q.trim().toLowerCase(); const qd = digits(q);
  const match = (p) => !q || (p.name || "").toLowerCase().includes(q) || nameOf(p).toLowerCase().includes(q) || (qd.length >= 3 && (p.phone || "").includes(qd));
  $("#vault-head").hidden = !S.vault;
  $("#newchat").hidden = S.vault;
  let html = "";
  if (S.vault) {
    const byId = new Map(S.chats.map(c => [c.id, c]));
    const ids = [...hid].sort((x, y) => ms(byId.get(y)?.lastAt || 0) - ms(byId.get(x)?.lastAt || 0));
    html = ids.length
      ? `<div class="sec">${ids.length} hidden</div>` + ids.map(cid => rowHtml(cid, byId.get(cid), true)).join("")
      : `<div class="empty"><div class="bubble-ill"><svg class="icon" style="width:28px;height:28px"><use href="#i-eyeoff"/></svg></div>No hidden chats yet.<br>Use the ⋮ menu on any chat to hide it.</div>`;
  } else {
    const visible = S.chats.filter(c => !hid.has(c.id) && match(S.people.get(otherOf(c.id, me)) || {}));
    if (validMobile(qd.slice(-10)) && qd.length >= 10) {
      html += `<div class="sec">Start a chat</div><div class="row" data-phone="${esc(COUNTRY_CODE + qd.slice(-10))}" tabindex="0" role="button">
        <div class="av" style="background:var(--accent)">+</div>
        <div class="meta"><div class="l1"><span class="name">Message ${esc(fmtPhone(COUNTRY_CODE + qd.slice(-10)))}</span></div>
        <div class="l2"><span class="preview">Find this number on Kaburlu</span></div></div></div>`;
    }
    if (visible.length) html += `<div class="sec">Chats</div>` + visible.map(c => rowHtml(c.id, c, false)).join("");
    if (!html) html = q
      ? `<div class="empty">No chats match "${esc(S.q)}".<br>Type a full 10-digit number to start a new chat.</div>`
      : `<div class="empty"><div class="bubble-ill"><svg class="icon" style="width:28px;height:28px"><use href="#i-msg"/></svg></div>No chats yet.<br>Type a friend's 10-digit mobile number above to start one.</div>`;
  }
  $("#list").innerHTML = html;
}
function isUnread(c) {
  const me = S.user.uid;
  return c && c.lastFrom && c.lastFrom !== me && ms(c.lastAt) > ms(c.reads?.[me] || 0) && S.open !== c.id;
}
function rowHtml(cid, chat, inVault) {
  const o = S.people.get(otherOf(cid, S.user.uid)) || { id: cid, name: "…", phone: "" };
  const unread = isUnread(chat);
  const mine = chat?.lastFrom === S.user.uid;
  const seen = mine && ms(chat?.reads?.[o.id] || 0) >= ms(chat?.lastAt || 0);
  const preview = chat?.lastText
    ? (mine ? `<svg class="tick ${seen ? "seen" : ""}"><use href="#i-check${seen ? 2 : 1}"/></svg>You: ` : "") + esc(chat.lastText)
    : esc(fmtPhone(o.phone));
  return `<div class="row ${S.open === cid ? "active" : ""} ${unread ? "unread" : ""}" data-cid="${esc(cid)}" tabindex="0" role="button">
    ${avatar({ ...o, name: nameOf(o) })}
    <div class="meta">
      <div class="l1"><span class="name">${esc(nameOf(o))}</span>${chat?.lastAt ? `<span class="time">${esc(listTime(ms(chat.lastAt)))}</span>` : ""}</div>
      <div class="l2"><span class="preview">${preview}</span>${unread ? `<span class="dot"></span>` : ""}</div>
    </div>
    <button class="more" data-menu="${esc(cid)}" data-vault="${inVault ? 1 : 0}" aria-label="Chat options" aria-expanded="false"><svg class="icon"><use href="#i-more"/></svg></button>
  </div>`;
}
$("#list").addEventListener("click", (e) => {
  const m = e.target.closest("[data-menu]");
  if (m) { e.stopPropagation(); openMenu(m, m.dataset.menu, m.dataset.vault === "1"); return; }
  const r = e.target.closest(".row"); if (!r) return;
  if (r.dataset.phone) startChatWith(r.dataset.phone); else openChat(r.dataset.cid);
});
$("#list").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.classList.contains("row")) e.target.click(); });
$("#search").addEventListener("input", (e) => { S.q = e.target.value; renderList(); });
$("#newchat").addEventListener("submit", (e) => { e.preventDefault(); $("#list .row")?.click(); });

async function startChatWith(phone) {
  if (phone === S.profile?.phone) { toast("That's your own number."); return; }
  try {
    const s = await getDoc(doc(db, "phoneIndex", phone));
    if (!s.exists()) { toast(`${fmtPhone(phone)} isn't on Kaburlu yet. Invite them to sign up.`); return; }
    const uid = s.data().uid;
    await loadPeople([uid]);
    S.q = ""; $("#search").value = "";
    openChat(chatIdFor(S.user.uid, uid));
  } catch (ex) { console.error(ex); toast("Couldn't look up that number. Try again."); }
}

/* --- menu --- */
function closeMenu() { document.querySelector(".menu")?.remove(); document.querySelectorAll('.more[aria-expanded="true"]').forEach(b => b.setAttribute("aria-expanded", "false")); }
function openMenu(anchor, cid, inVault) {
  closeMenu(); anchor.setAttribute("aria-expanded", "true");
  const m = document.createElement("div"); m.className = "menu";
  m.innerHTML = `<button data-act="rename"><svg class="icon"><use href="#i-pencil"/></svg>Rename</button>` + (inVault
    ? `<button data-act="unhide"><svg class="icon"><use href="#i-eye"/></svg>Unhide chat</button>`
    : `<button data-act="hide"><svg class="icon"><use href="#i-eyeoff"/></svg>Hide chat</button>`);
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8) + "px";
  m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8)) + "px";
  m.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; closeMenu();
    const act = b.dataset.act;
    if (act === "rename") renameContact(otherOf(cid, S.user.uid));
    else if (act === "hide") hideChat(cid); else unhideChat(cid);
  };
  m.querySelector("button").focus();
}
document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) closeMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

/* --- conversation --- */
function subscribeMsgs(cid) {
  S.unsubMsgs?.();
  S.unsubMsgs = onSnapshot(
    query(collection(db, "chats", cid, "messages"), orderBy("createdAt", "desc"), limit(300)),
    { includeMetadataChanges: true },
    snap => {
      S.msgs = snap.docs.map(d => ({ id: d.id, pending: d.metadata.hasPendingWrites, ...d.data({ serverTimestamps: "estimate" }) })).reverse();
      renderMsgs(); markRead();
    },
    err => { console.error(err); }
  );
}
function openChat(cid) {
  const hid = hiddenSet();
  if (hid.has(cid) && !S.unlocked) { askUnlock(() => { S.vault = true; openChat(cid); }); return; }
  if (!hid.has(cid) && S.vault) { S.vault = false; S.unlocked = false; }
  if (S.open !== cid) {
    S.unsubMsgs?.(); S.unsubMsgs = null; S.msgs = []; S.open = cid;
    // A brand-new chat has no document yet; we subscribe once the first message creates it.
    if (S.chats.some(c => c.id === cid)) subscribeMsgs(cid);
  }
  $("#app").classList.add("open");
  renderList(); renderMain(true); markRead();
}
function closeChat() {
  S.unsubMsgs?.(); S.unsubMsgs = null; S.open = null; S.msgs = [];
  $("#app").classList.remove("open"); renderList(); renderMain(true);
}
let marking = false;
async function markRead() {
  const c = S.chats.find(x => x.id === S.open);
  if (!c || document.hidden || marking) return;
  const me = S.user.uid;
  if (c.lastFrom && c.lastFrom !== me && ms(c.lastAt) > ms(c.reads?.[me] || 0)) {
    marking = true;
    try { await updateDoc(doc(db, "chats", c.id), { [`reads.${me}`]: serverTimestamp() }); } catch {}
    marking = false;
  }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) markRead(); });

const convWho = (o, hidden) => `<b>${esc(nameOf(o))}${hidden ? `<span class="chip"><svg class="icon"><use href="#i-lock"/></svg>Hidden</span>` : ""}</b><span class="mono">${esc(fmtPhone(o.phone))}${S.settings.nicknames?.[o.id] ? ` · ${esc(o.name)}` : ""}</span>`;
const hideBtn = (hidden) => `<button class="iconbtn" id="b-hide" title="${hidden ? "Unhide chat" : "Hide chat"}" aria-label="${hidden ? "Unhide chat" : "Hide chat"}"><svg class="icon"><use href="#i-${hidden ? "eye" : "eyeoff"}"/></svg></button>`;
const grow = (ta) => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; };

function renderMain(full) {
  const main = $("#main");
  if (!S.open) {
    if (!full && main.querySelector(".welcome")) return;
    const pinSet = !!S.settings.pinHash;
    main.innerHTML = `<div class="welcome"><div class="welcome-in">
      <div class="mark" style="width:64px;height:64px;font-size:32px;border-radius:20px">క</div>
      <h2>Pick someone to chat with</h2>
      <p>Type a friend's mobile number in the search box to start a new chat.</p>
      <div class="tips">
        <div class="tip"><svg class="icon"><use href="#i-eyeoff"/></svg><span>Open the <b>⋮</b> menu on a chat and choose <b>Hide chat</b>.</span></div>
        <div class="tip"><svg class="icon"><use href="#i-lock"/></svg><span>Tap the lock to see hidden chats. ${pinSet ? "Your 4-digit PIN is set." : "You'll create a 4-digit PIN the first time."}</span></div>
      </div></div></div>`;
    return;
  }
  const o = S.people.get(otherOf(S.open, S.user.uid)) || { id: "x", name: "…", phone: "" };
  const isHidden = hiddenSet().has(S.open);
  if (!full && main.querySelector(".conv-top")) {
    main.querySelector(".conv-top .who").innerHTML = convWho(o, isHidden);
    main.querySelector("#b-hide").outerHTML = hideBtn(isHidden);
    return;
  }
  main.innerHTML = `
    <div class="conv-top">
      <button class="iconbtn back" id="b-back" aria-label="Back to chats"><svg class="icon"><use href="#i-back"/></svg></button>
      ${avatar({ ...o, name: nameOf(o) }, "sm")}
      <div class="who">${convWho(o, isHidden)}</div>
      <button class="iconbtn" id="b-rename" title="Rename" aria-label="Rename contact"><svg class="icon"><use href="#i-pencil"/></svg></button>
      ${hideBtn(isHidden)}
    </div>
    <div class="msgs" id="msgs" aria-live="polite"></div>
    <form class="composer" id="composer">
      <button class="tool" id="b-emoji" type="button" aria-label="Emoji" aria-expanded="false"><svg class="icon"><use href="#i-smile"/></svg></button>
      <button class="tool" id="b-attach" type="button" aria-label="Send a photo, video or file"><svg class="icon"><use href="#i-clip"/></svg></button>
      <input type="file" id="file-in" accept="image/*,video/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip" hidden>
      <textarea id="draft" rows="1" placeholder="Type a message" maxlength="2000" aria-label="Message"></textarea>
      <button class="send" id="send" type="submit" aria-label="Send" disabled><svg class="icon"><use href="#i-send"/></svg></button>
    </form>`;
  renderMsgs();
  const ta = $("#draft");
  const drafts = ls.get("drafts", {}); ta.value = drafts[S.open] || ""; grow(ta);
  ta.addEventListener("input", () => { grow(ta); $("#send").disabled = !ta.value.trim(); const d = ls.get("drafts", {}); d[S.open] = ta.value; ls.set("drafts", d); });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !matchMedia("(hover:none)").matches) { e.preventDefault(); $("#composer").requestSubmit(); } });
  $("#send").disabled = !ta.value.trim();
  $("#composer").addEventListener("submit", (e) => { e.preventDefault(); send(); });
  $("#b-back").onclick = closeChat;
  $("#b-emoji").onclick = (e) => { e.stopPropagation(); toggleEmoji(); };
  $("#b-attach").onclick = () => $("#file-in").click();
  $("#file-in").onchange = (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) uploadAndSend(f); };
  if (matchMedia("(min-width:761px)").matches) ta.focus();
}
$("#main").addEventListener("click", (e) => {
  if (e.target.closest("#b-hide")) hiddenSet().has(S.open) ? unhideChat(S.open) : hideChat(S.open);
  if (e.target.closest("#b-rename")) renameContact(otherOf(S.open, S.user.uid));
});

const REACTIONS = ["❤️", "😂", "👍", "😮", "😢", "🙏"];
const cldThumb = (url, w = 720) => url.replace("/upload/", `/upload/c_limit,w_${w},q_auto,f_auto/`);
const cldDownload = (url) => url.replace("/upload/", "/upload/fl_attachment/");
const fmtSize = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
const mediaLabel = (m) => ({ image: "📷 Photo", video: "🎥 Video", file: "📄 " + (m.name || "File") }[m.type] || "📎 Attachment");

function tickHtml(m, otherRead) {
  if (m.from !== S.user.uid) return "";
  if (m.pending) return `<svg class="tick"><use href="#i-clock"/></svg>`;
  const seen = otherRead >= ms(m.createdAt);
  return `<svg class="tick ${seen ? "seen" : ""}" aria-label="${seen ? "Seen" : "Sent"}"><use href="#i-check${seen ? 2 : 1}"/></svg>`;
}
function reactHtml(m) {
  const r = m.reactions || {}; const vals = Object.values(r); if (!vals.length) return "";
  const counts = {}; vals.forEach(e => counts[e] = (counts[e] || 0) + 1);
  const em = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 3).join("");
  return `<span class="reacts" data-react="${esc(m.id)}">${esc(em)}${vals.length > 1 ? `<span class="n">${vals.length}</span>` : ""}</span>`;
}
function mediaHtml(md) {
  if (md.type === "image") {
    const ar = md.w && md.h ? `aspect-ratio:${md.w}/${md.h};` : "";
    return `<a class="ph" data-full="${esc(md.url)}" href="${esc(md.url)}" target="_blank" rel="noopener"><img src="${esc(cldThumb(md.url))}" alt="Photo" loading="lazy" style="${ar}"></a>`;
  }
  if (md.type === "video") return `<video class="vid" src="${esc(md.url)}" controls preload="metadata" playsinline></video>`;
  const ext = (md.name || "").split(".").pop().slice(0, 4).toUpperCase() || "FILE";
  return `<a class="file" href="${esc(md.url)}" target="_blank" rel="noopener"><span class="fi">${esc(ext)}</span><div><b>${esc(md.name || "File")}</b><span>${md.size ? esc(fmtSize(md.size)) : "Open"}</span></div></a>`;
}

function renderMsgs() {
  const box = $("#msgs"); if (!box) return;
  const me = S.user.uid;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const ups = uploads.filter(u => u.cid === S.open);
  if (!S.msgs.length && !ups.length) {
    const o = S.people.get(otherOf(S.open, me));
    box.innerHTML = `<div class="empty" style="margin:auto"><div class="bubble-ill"><svg class="icon" style="width:28px;height:28px"><use href="#i-msg"/></svg></div>No messages yet.<br>Say namaste to ${esc(nameOf(o).split(" ")[0] || "them")}.</div>`;
    return;
  }
  const chat = S.chats.find(c => c.id === S.open);
  const otherRead = ms(chat?.reads?.[otherOf(S.open, me)] || 0);
  let html = "", lastDay = "", lastFrom = "", lastTs = 0;
  for (const m of S.msgs) {
    const t = ms(m.createdAt); const dk = dayKey(t);
    if (dk !== lastDay) { html += `<div class="day">${esc(dayLabel(t))}</div>`; lastDay = dk; lastFrom = ""; }
    const cont = m.from === lastFrom && t - lastTs < 5 * 60 * 1000;
    const r = reactHtml(m);
    const cls = `b ${m.from === me ? "out" : "in"} ${cont ? "cont" : "first"}${m.media ? " media" : ""}${r ? " has-react" : ""}`;
    // No whitespace between tags: bubbles use white-space: pre-wrap.
    const body = m.media
      ? mediaHtml(m.media) + (m.text ? `<span class="cap">${esc(m.text)}</span>` : "")
      : esc(m.text);
    html += `<div class="${cls}" data-id="${esc(m.id)}">${body}<span class="t">${esc(hhmm(t))}${tickHtml(m, otherRead)}</span>${r}</div>`;
    lastFrom = m.from; lastTs = t;
  }
  for (const u of ups) {
    html += `<div class="uploading" data-up="${u.id}"><div class="row2"><b>${esc(u.name)}</b><span>${u.error ? "Failed" : Math.round(u.pct) + "%"}</span></div><div class="bar"><i style="width:${u.pct}%"></i></div>${u.error ? `<span style="color:var(--warn)">${esc(u.error)}</span>` : ""}</div>`;
  }
  box.innerHTML = html;
  if (nearBottom || box.dataset.init !== S.open) { box.scrollTop = box.scrollHeight; box.dataset.init = S.open; }
  // Keep the newest message in view while photos finish loading.
  if (!box.dataset.watch) {
    box.dataset.watch = "1";
    box.addEventListener("load", (e) => {
      if (e.target.tagName === "IMG" && box.scrollHeight - box.scrollTop - box.clientHeight < 400) box.scrollTop = box.scrollHeight;
    }, true);
  }
}

let sendChain = Promise.resolve();
function send() {
  const ta = $("#draft"); const text = ta.value.trim(); if (!text || !S.open) return;
  const cid = S.open;
  ta.value = ""; grow(ta); $("#send").disabled = true;
  const d = ls.get("drafts", {}); delete d[cid]; ls.set("drafts", d);
  closeEmoji();
  postMessage(cid, text, null).catch(() => {
    if (S.open === cid && !$("#draft").value) { $("#draft").value = text; $("#send").disabled = false; }
  });
}
function postMessage(cid, text, media) {
  const me = S.user.uid;
  const p = sendChain.then(async () => {
    try {
      const b = writeBatch(db);
      const lastText = media ? (mediaLabel(media) + (text ? " · " + text : "")) : text;
      b.set(doc(db, "chats", cid), {
        members: cid.split("_"), lastText: lastText.slice(0, 140), lastAt: serverTimestamp(), lastFrom: me,
        reads: { [me]: serverTimestamp() }
      }, { merge: true });
      const msg = { from: me, text, createdAt: serverTimestamp() };
      if (media) msg.media = media;
      b.set(doc(collection(db, "chats", cid, "messages")), msg);
      await b.commit();
      notifyOther(cid);
    } catch (ex) {
      console.error(ex); toast("Message not sent. Check your connection and try again.");
      throw ex;
    }
  });
  sendChain = p.catch(() => {});
  return p;
}

/* ================= REACTIONS ================= */
let pressT = null;
function closeReactBar() { document.querySelector(".react-bar")?.remove(); document.querySelector(".b.picked")?.classList.remove("picked"); }
function openReactBar(bubble) {
  closeReactBar(); closeEmoji();
  const m = S.msgs.find(x => x.id === bubble.dataset.id); if (!m || m.pending) return;
  const mine = m.reactions?.[S.user.uid];
  const bar = document.createElement("div"); bar.className = "react-bar"; bar.setAttribute("role", "menu");
  bar.innerHTML = REACTIONS.map(e => `<button data-e="${e}" aria-pressed="${mine === e}" aria-label="React ${e}">${e}</button>`).join("");
  document.body.appendChild(bar);
  bubble.classList.add("picked");
  const r = bubble.getBoundingClientRect();
  const top = r.top - bar.offsetHeight - 8 < 8 ? r.bottom + 8 : r.top - bar.offsetHeight - 8;
  const left = bubble.classList.contains("out") ? r.right - bar.offsetWidth : r.left;
  bar.style.top = top + "px";
  bar.style.left = Math.max(8, Math.min(left, innerWidth - bar.offsetWidth - 8)) + "px";
  bar.onclick = async (e) => {
    const b = e.target.closest("[data-e]"); if (!b) return;
    const emoji = b.dataset.e; closeReactBar();
    try {
      await updateDoc(doc(db, "chats", S.open, "messages", m.id), { [`reactions.${S.user.uid}`]: mine === emoji ? deleteField() : emoji });
    } catch (ex) { console.error(ex); toast("Couldn't react. Try again."); }
  };
}
$("#main").addEventListener("dblclick", (e) => {
  const b = e.target.closest(".b[data-id]"); if (!b || e.target.closest("video,a")) return;
  e.preventDefault(); getSelection()?.removeAllRanges(); openReactBar(b);
});
$("#main").addEventListener("contextmenu", (e) => {
  const b = e.target.closest(".b[data-id]"); if (!b || e.target.closest("video")) return;
  e.preventDefault(); openReactBar(b);
});
$("#main").addEventListener("touchstart", (e) => {
  const b = e.target.closest(".b[data-id]"); if (!b || e.target.closest("video")) return;
  clearTimeout(pressT); pressT = setTimeout(() => { navigator.vibrate?.(15); openReactBar(b); }, 450);
}, { passive: true });
for (const ev of ["touchend", "touchmove", "touchcancel"]) $("#main").addEventListener(ev, () => clearTimeout(pressT), { passive: true });
$("#main").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-react]");
  if (chip) { e.stopPropagation(); openReactBar(chip.closest(".b")); return; }
  const ph = e.target.closest(".ph[data-full]");
  if (ph) { e.preventDefault(); openViewer(ph.dataset.full); }
});
document.addEventListener("click", (e) => { if (!e.target.closest(".react-bar,[data-react]")) closeReactBar(); });
document.addEventListener("scroll", closeReactBar, true);

/* ================= EMOJI PICKER ================= */
const EMOJI = {
  "Smileys": "😀 😁 😂 🤣 😊 😍 🥰 😘 😎 🤩 🥳 😇 🙂 😉 😜 🤪 🤗 🤔 🤫 😴 😌 🥺 😢 😭 😤 😡 😱 😳 🤯 😅 🙃 😬",
  "Hands": "👍 👎 👏 🙌 🙏 🤝 👋 ✌️ 🤞 👌 🤙 💪 👊 ✊ 🫶 👀",
  "Hearts": "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💕 💖 💯 ✨ 🔥 ⭐ 🌹",
  "Fun": "🎉 🎂 🎁 🍕 🍔 ☕ 🍫 🍦 🏏 ⚽ 🎬 🎵 📚 💻 📱 🚗 ✈️ 🏖️ 🌧️ ☀️ 🌙 🐶 🐱 🦁"
};
function closeEmoji() { document.querySelector(".emoji-pop")?.remove(); $("#b-emoji")?.setAttribute("aria-expanded", "false"); }
function toggleEmoji() {
  if (document.querySelector(".emoji-pop")) { closeEmoji(); return; }
  const pop = document.createElement("div"); pop.className = "emoji-pop";
  pop.innerHTML = Object.entries(EMOJI).map(([g, list]) => `<div class="grp">${g}</div>` + list.split(" ").map(e => `<button type="button" data-e="${e}">${e}</button>`).join("")).join("");
  $("#composer").appendChild(pop); $("#b-emoji").setAttribute("aria-expanded", "true");
  pop.onclick = (e) => {
    e.stopPropagation();
    const b = e.target.closest("[data-e]"); if (!b) return;
    const ta = $("#draft"); const st = ta.selectionStart ?? ta.value.length, en = ta.selectionEnd ?? st;
    ta.value = ta.value.slice(0, st) + b.dataset.e + ta.value.slice(en);
    const pos = st + b.dataset.e.length; ta.setSelectionRange(pos, pos);
    ta.dispatchEvent(new Event("input"));
    if (!matchMedia("(hover:none)").matches) ta.focus();
  };
}
document.addEventListener("click", (e) => { if (!e.target.closest(".emoji-pop,#b-emoji")) closeEmoji(); });

/* ================= HIDE + PIN ================= */
const settingsRef = () => doc(db, "users", S.user.uid, "private", "settings");
async function saveSettings(patch) {
  try { await setDoc(settingsRef(), patch, { merge: true }); return true; }
  catch (ex) { console.error(ex); toast("Couldn't save. Try again."); return false; }
}
function hideChat(cid) {
  const doHide = async () => {
    const hidden = [...new Set([...(S.settings.hidden || []), cid])];
    if (await saveSettings({ hidden })) {
      if (S.open === cid && !S.unlocked) closeChat();
      toast("Chat hidden. Tap the lock and enter your PIN to see it.");
    }
  };
  if (!S.settings.pinHash) setupPin(doHide); else doHide();
}
async function unhideChat(cid) {
  const hidden = (S.settings.hidden || []).filter(x => x !== cid);
  if (await saveSettings({ hidden })) {
    toast("Chat moved back to your chat list.");
    if (S.open === cid) { S.vault = false; S.unlocked = false; renderList(); renderMain(false); }
  }
}
const checkPin = async (p) => S.settings.pinHash && (await sha(`${S.settings.salt}:${p}`)) === S.settings.pinHash;

function pinPad({ title, sub, onPin, extra }) {
  document.querySelector(".scrim")?.remove();
  const sc = document.createElement("div"); sc.className = "scrim";
  sc.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="lockic"><svg class="icon"><use href="#i-lock"/></svg></div>
    <h3>${esc(title)}</h3><p class="sub" id="pp-sub">${esc(sub)}</p>
    <div class="dots" id="pp-dots"><i></i><i></i><i></i><i></i></div>
    <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-k="${n}">${n}</button>`).join("")}
      <button class="fn" data-k="cancel">Cancel</button><button data-k="0">0</button><button class="fn" data-k="del">Delete</button></div>
    ${extra ? `<p class="fine">${extra}</p>` : ""}
  </div>`;
  document.body.appendChild(sc);
  let pin = "", busy = false;
  const dots = sc.querySelector("#pp-dots"), subEl = sc.querySelector("#pp-sub");
  const paint = () => dots.querySelectorAll("i").forEach((d, i) => d.classList.toggle("on", i < pin.length));
  const close = () => { sc.remove(); document.removeEventListener("keydown", onKey, true); };
  const press = async (k) => {
    if (busy) return;
    if (k === "cancel") return close();
    if (k === "del") { pin = pin.slice(0, -1); paint(); return; }
    if (pin.length >= 4) return;
    pin += k; paint(); dots.classList.remove("bad");
    if (pin.length === 4) {
      busy = true;
      const res = await onPin(pin);
      if (res === true) { close(); return; }
      dots.classList.add("shake", "bad"); subEl.textContent = res || "Try again.";
      setTimeout(() => { dots.classList.remove("shake"); pin = ""; paint(); busy = false; }, 420);
    }
  };
  sc.addEventListener("click", (e) => {
    const b = e.target.closest("[data-k]"); if (b) press(b.dataset.k);
    else if (e.target === sc) close();
    if (e.target.closest("[data-forgot]")) { close(); forgotPin(); }
  });
  const onKey = (e) => {
    if (/^\d$/.test(e.key)) { e.preventDefault(); press(e.key); }
    else if (e.key === "Backspace") { e.preventDefault(); press("del"); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  };
  document.addEventListener("keydown", onKey, true);
  sc.querySelector(".pad button").focus();
}

function setupPin(after) {
  pinPad({
    title: "Create a 4-digit PIN", sub: "You'll use it to open hidden chats.", onPin: (p1) => {
      if (/^(\d)\1{3}$/.test(p1) || "0123456789".includes(p1) || "9876543210".includes(p1)) return "Too easy to guess. Choose a different PIN.";
      setTimeout(() => pinPad({
        title: "Confirm your PIN", sub: "Enter the same 4 digits again.", onPin: async (p2) => {
          if (p2 !== p1) return "PINs don't match. Enter it again.";
          const salt = randomSalt();
          if (!(await saveSettings({ salt, pinHash: await sha(`${salt}:${p2}`) }))) return "Couldn't save the PIN.";
          S.settings = { ...S.settings, salt, pinHash: await sha(`${salt}:${p2}`) };
          toast("PIN saved"); setTimeout(() => after?.(), 50); return true;
        }
      }), 0);
      return true;
    }
  });
}

const LOCK_KEY = "lockout";
function askUnlock(after) {
  if (!S.settings.pinHash) { setupPin(() => { S.unlocked = true; after?.(); }); return; }
  pinPad({
    title: "Enter your PIN", sub: "Hidden chats are locked.", extra: `<button class="linkbtn" data-forgot>Forgot PIN?</button>`,
    onPin: async (p) => {
      const lock = ls.get(LOCK_KEY, { n: 0, until: 0 });
      if (Date.now() < lock.until) return `Too many tries. Wait ${Math.ceil((lock.until - Date.now()) / 1000)} seconds.`;
      if (await checkPin(p)) { ls.set(LOCK_KEY, { n: 0, until: 0 }); S.unlocked = true; setTimeout(() => after?.(), 0); return true; }
      lock.n += 1; if (lock.n >= 5) { lock.until = Date.now() + 30000; lock.n = 0; }
      ls.set(LOCK_KEY, lock);
      return lock.until > Date.now() ? "Too many tries. Wait 30 seconds." : "Wrong PIN. Try again.";
    }
  });
}
function lockVault() {
  const wasHiddenOpen = S.open && hiddenSet().has(S.open);
  S.vault = false; S.unlocked = false;
  if (wasHiddenOpen) closeChat(); else renderList();
}
$("#b-vault").onclick = () => {
  if (S.vault) { lockVault(); return; }
  askUnlock(() => { S.vault = true; S.q = ""; $("#search").value = ""; if (S.open && !hiddenSet().has(S.open)) closeChat(); else renderList(); });
};
$("#b-leave").onclick = lockVault;
document.addEventListener("visibilitychange", () => { if (document.hidden && S.unlocked) lockVault(); });

function modal(html) {
  document.querySelector(".scrim")?.remove();
  const sc = document.createElement("div"); sc.className = "scrim";
  sc.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  sc.addEventListener("click", (e) => { if (e.target === sc || e.target.closest("[data-close]")) sc.remove(); });
  document.body.appendChild(sc); return sc;
}
$("#b-settings").onclick = openSettings;
function openSettings() {
  const st = S.settings; const n = (st.hidden || []).length;
  const t = themeNow();
  const accentName = ACCENTS.find(a => a[0] === t.accent)?.[2] || "Jade";
  const modeName = { auto: "Auto", light: "Light", dark: "Dark" }[t.mode];
  const sc = modal(`<h3>Settings</h3>
    <div class="settings-list">
      <button class="settings-item" id="s-theme"><svg class="icon"><use href="#i-palette"/></svg><div><b>Appearance</b><span>${esc(modeName)} · ${esc(accentName)} · ${esc(WALLS.find(w => w[0] === t.wall)?.[1] || "Dots")} wallpaper</span></div></button>
      <button class="settings-item" id="s-notify"><svg class="icon"><use href="#i-bell"/></svg><div><b>Notifications</b><span>${esc(notifyStatusText())}</span></div></button>
      <button class="settings-item" id="s-pin"><svg class="icon"><use href="#i-lock"/></svg><div><b>${st.pinHash ? "Change PIN" : "Create PIN"}</b><span>${st.pinHash ? `${n} chat${n === 1 ? "" : "s"} hidden` : "Needed to hide chats"}</span></div></button>
      ${st.pinHash ? `<button class="settings-item" id="s-forgot"><svg class="icon"><use href="#i-shield"/></svg><div><b>Forgot PIN</b><span>Reset it with an email code</span></div></button>` : ""}
    </div>
    <button class="btn ghost" data-close>Close</button>
    <p class="fine">Email: ${esc(st.email || "not set")}</p>`);
  sc.querySelector("#s-theme").onclick = () => { sc.remove(); openTheme(); };
  sc.querySelector("#s-notify").onclick = () => { sc.remove(); enableNotifications(); };
  sc.querySelector("#s-pin").onclick = () => {
    sc.remove();
    if (!S.settings.pinHash) { setupPin(); return; }
    pinPad({ title: "Enter current PIN", sub: "Confirm it's you first.", onPin: async (p) => (await checkPin(p)) ? (setTimeout(() => setupPin(), 0), true) : "Wrong PIN. Try again." });
  };
  sc.querySelector("#s-forgot")?.addEventListener("click", () => { sc.remove(); forgotPin(); });
}

let themeSaveT;
function openTheme() {
  let t = themeNow();
  const sc = modal(`<h3>Appearance</h3>
    <p class="opt-label">Mode</p>
    <div class="seg3" id="th-mode">${[["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]].map(([k, l]) => `<button data-v="${k}" aria-pressed="${t.mode === k}">${l}</button>`).join("")}</div>
    <p class="opt-label">Color</p>
    <div class="swatches" id="th-accent">${ACCENTS.map(([k, c, l]) => `<button class="swatch" data-v="${k}" style="background:${c}" aria-label="${l}" title="${l}" aria-pressed="${t.accent === k}"></button>`).join("")}</div>
    <p class="opt-label">Chat wallpaper</p>
    <div class="walls" id="th-wall">${WALLS.map(([k, l]) => `<button class="wall w-${k}" data-v="${k}" aria-pressed="${t.wall === k}">${l}</button>`).join("")}</div>
    <button class="btn" data-close>Done</button>`);
  sc.querySelector(".modal").classList.add("wide");
  const bind = (id, key) => sc.querySelector(id).addEventListener("click", (e) => {
    const b = e.target.closest("[data-v]"); if (!b) return;
    t = { ...t, [key]: b.dataset.v };
    sc.querySelectorAll(`${id} [data-v]`).forEach(x => x.setAttribute("aria-pressed", x === b));
    applyTheme(t);
    clearTimeout(themeSaveT);
    themeSaveT = setTimeout(() => { if (S.user) setDoc(settingsRef(), { theme: t }, { merge: true }).catch(() => {}); }, 600);
  });
  bind("#th-mode", "mode"); bind("#th-accent", "accent"); bind("#th-wall", "wall");
}

/* Forgot PIN: prove it's you with a fresh code sent to your own email. Hidden chats stay hidden. */
function forgotPin() {
  const email = S.settings.email;
  const sc = modal(`<div class="lockic"><svg class="icon"><use href="#i-shield"/></svg></div>
    <h3>Reset your PIN</h3>
    <p class="sub">We'll email a code to <b>${esc(email)}</b>. Your hidden chats stay hidden.</p>
    <input id="fp-code" class="input otp" inputmode="numeric" maxlength="6" placeholder="••••••" hidden>
    <p class="err" id="fp-err"></p>
    <div class="row-btns"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="fp-go">Send code</button></div>`);
  let ticket = null;
  const btn = sc.querySelector("#fp-go"), code = sc.querySelector("#fp-code"), err = sc.querySelector("#fp-err");
  code.addEventListener("input", () => { code.value = digits(code.value).slice(0, 6); });
  btn.onclick = async () => {
    err.textContent = ""; btn.disabled = true;
    try {
      if (!ticket) {
        ticket = (await api("send-otp", { mode: "pin", id: email })).ticket;
        code.hidden = false; code.focus(); btn.textContent = "Verify";
      } else {
        await api("verify-otp", { ticket, code: code.value });
        sc.remove(); setupPin();
      }
    } catch (ex) { err.textContent = ex.message; }
    finally { btn.disabled = false; }
  };
}

/* ================= RENAME CONTACTS ================= */
// Nicknames are private: saved in your own settings, only you see them.
function renameContact(uid) {
  const p = S.people.get(uid) || { id: uid, name: "", phone: "" };
  const current = S.settings.nicknames?.[uid] || "";
  const sc = modal(`<div class="lockic"><svg class="icon"><use href="#i-pencil"/></svg></div>
    <h3>Rename contact</h3>
    <p class="sub">Only you see this name. They registered as <b>${esc(p.name)}</b>${p.phone ? ` · <span class="mono">${esc(fmtPhone(p.phone))}</span>` : ""}.</p>
    <input id="rn-name" class="input" maxlength="40" placeholder="${esc(p.name)}" value="${esc(current)}" autocomplete="off">
    <p class="err" id="rn-err"></p>
    <div class="row-btns">${current ? `<button class="btn ghost" id="rn-reset">Use their name</button>` : `<button class="btn ghost" data-close>Cancel</button>`}<button class="btn" id="rn-save">Save</button></div>`);
  const input = sc.querySelector("#rn-name");
  const save = async (value) => {
    const nick = value.trim().replace(/\s+/g, " ").slice(0, 40);
    const nicknames = { ...(S.settings.nicknames || {}) };
    if (nick && nick !== p.name) nicknames[uid] = nick; else delete nicknames[uid];
    // updateDoc replaces the whole nicknames map, so a removed nickname is really removed.
    let ok = false;
    try { await updateDoc(settingsRef(), { nicknames }); ok = true; } catch (ex) { console.error(ex); toast("Couldn't save. Try again."); }
    if (ok) {
      S.settings = { ...S.settings, nicknames };
      sc.remove(); renderList(); renderMain(false);
      toast(nicknames[uid] ? `Renamed to ${nicknames[uid]}` : `Showing ${p.name} again`);
    }
  };
  sc.querySelector("#rn-save").onclick = () => save(input.value);
  sc.querySelector("#rn-reset")?.addEventListener("click", () => save(""));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(input.value); });
  input.focus(); input.select();
}

/* ================= INSTALL AS APP ================= */
if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let installEvent = null;

function updateInstallUI() {
  const can = !isStandalone() && (installEvent || isIOS);
  const dismissed = ls.get("installDismissed", 0) > Date.now();
  $("#install-bar").hidden = !can || dismissed;
  $("#auth-install").hidden = !can;
}
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; updateInstallUI(); });
addEventListener("appinstalled", () => { installEvent = null; updateInstallUI(); toast("Kaburlu is on your home screen"); });

async function doInstall() {
  if (installEvent) {
    installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    if (outcome === "accepted") installEvent = null;
    updateInstallUI();
    return;
  }
  if (isIOS) {
    modal(`<div class="lockic"><svg class="icon"><use href="#i-install"/></svg></div>
      <h3>Add Kaburlu to your home screen</h3>
      <ol class="steps">
        <li><span>Open this page in <b>Safari</b>.</span></li>
        <li><span>Tap the <b>Share</b> button (square with an arrow) at the bottom.</span></li>
        <li><span>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</span></li>
      </ol>
      <button class="btn" data-close>Got it</button>`);
  }
}
$("#b-install").onclick = doInstall;
$("#b-install-auth").onclick = doInstall;
$("#b-install-x").onclick = () => { ls.set("installDismissed", Date.now() + 7 * 864e5); updateInstallUI(); };
updateInstallUI();

/* ================= MEDIA (Cloudinary) ================= */
// Files go straight from the browser to Cloudinary. Our server only signs the upload,
// after checking you're signed in and part of this chat.
const uploads = [];
const MAX_IMAGE = 10 * 1024 * 1024, MAX_VIDEO = 100 * 1024 * 1024, MAX_FILE = 10 * 1024 * 1024;

async function uploadAndSend(file) {
  const cid = S.open; if (!cid) return;
  const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "file";
  const max = kind === "video" ? MAX_VIDEO : kind === "image" ? MAX_IMAGE : MAX_FILE;
  if (file.size > max) { toast(`That ${kind === "file" ? "file" : kind} is too big. The limit is ${fmtSize(max)}.`); return; }

  const up = { id: Math.random().toString(36).slice(2), cid, name: file.name, pct: 0, error: "" };
  uploads.push(up); renderMsgs();
  const done = () => { uploads.splice(uploads.indexOf(up), 1); renderMsgs(); };
  try {
    const idToken = await S.user.getIdToken();
    const sig = await api("sign-upload", { idToken, chatId: cid });
    const res = await new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append("file", file); fd.append("api_key", sig.apiKey); fd.append("timestamp", sig.timestamp);
      fd.append("signature", sig.signature); fd.append("folder", sig.folder);
      const xhr = new XMLHttpRequest();
      const type = kind === "file" ? "raw" : kind;
      xhr.open("POST", `https://api.cloudinary.com/v1_1/${sig.cloudName}/${type}/upload`);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { up.pct = e.loaded / e.total * 100; const el = document.querySelector(`[data-up="${up.id}"]`); if (el) { el.querySelector("i").style.width = up.pct + "%"; el.querySelector(".row2 span").textContent = Math.round(up.pct) + "%"; } } };
      xhr.onload = () => { let d = {}; try { d = JSON.parse(xhr.responseText); } catch {} xhr.status < 300 ? resolve(d) : reject(new Error(d.error?.message || "Upload failed.")); };
      xhr.onerror = () => reject(new Error("Upload failed. Check your connection."));
      xhr.send(fd);
    });
    const media = { url: res.secure_url, type: kind, name: file.name.slice(0, 120), size: res.bytes || file.size };
    if (res.width && res.height) { media.w = res.width; media.h = res.height; }
    // Use what's typed in the box as the caption.
    let caption = "";
    if (S.open === cid) {
      const ta = $("#draft"); caption = ta.value.trim().slice(0, 2000); ta.value = ""; grow(ta); $("#send").disabled = true;
      const d = ls.get("drafts", {}); delete d[cid]; ls.set("drafts", d);
    }
    done();
    await postMessage(cid, caption, media);
  } catch (ex) {
    console.error(ex);
    up.error = ex.message; renderMsgs();
    setTimeout(done, 5000);
  }
}

function openViewer(url) {
  const lb = document.createElement("div"); lb.className = "lightbox"; lb.setAttribute("role", "dialog"); lb.setAttribute("aria-label", "Photo");
  lb.innerHTML = `<div class="lb-top"><a href="${esc(cldDownload(url))}" target="_blank" rel="noopener">Download</a><button type="button" data-x>Close</button></div>
    <div class="lb-img"><img src="${esc(url)}" alt="Photo"></div>`;
  const close = () => { lb.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  lb.addEventListener("click", (e) => { if (e.target.closest("[data-x]") || e.target.classList.contains("lb-img")) close(); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(lb);
}

/* ================= PUSH NOTIFICATIONS (Firebase Cloud Messaging) ================= */
let messaging = null, pushReady = false;
isSupported().then((ok) => {
  pushReady = true;
  if (ok) {
    messaging = getMessaging(fb);
    // While the app is open, show a small banner instead of a system notification.
    onMessage(messaging, (p) => {
      const d = p.data || {};
      if (d.chatId && d.chatId === S.open && !document.hidden) return;
      toast(`${d.title || "Kaburlu"}: ${d.body || "New message"}`);
    });
  }
  updateNotifyUI();
  if (S.user) refreshPushToken();
}).catch(() => { pushReady = true; updateNotifyUI(); });

const pushPermission = () => ("Notification" in window) ? Notification.permission : "unsupported";
function notifyStatusText() {
  if (!messaging) return isIOS && !isStandalone() ? "On iPhone, install the app first" : "Not supported in this browser";
  if (!VAPID_KEY || VAPID_KEY.startsWith("PASTE")) return "Not set up yet (see README)";
  return { granted: "On", denied: "Blocked in browser settings", default: "Off. Tap to turn on" }[pushPermission()] || "Off";
}
function updateNotifyUI() {
  const show = S.user && messaging && VAPID_KEY && !VAPID_KEY.startsWith("PASTE") && pushPermission() === "default" && ls.get("notifyDismissed", 0) < Date.now();
  $("#notify-bar").hidden = !show;
}
async function saveToken() {
  const reg = await navigator.serviceWorker.ready;
  const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
  if (!token) throw new Error("no token");
  const old = ls.get("pushToken", null);
  if (old !== token || !ls.get("pushSaved", false)) {
    await setDoc(doc(db, "pushTokens", S.user.uid), { tokens: arrayUnion(token) }, { merge: true });
    if (old && old !== token) updateDoc(doc(db, "pushTokens", S.user.uid), { tokens: arrayRemove(old) }).catch(() => {});
    ls.set("pushToken", token); ls.set("pushSaved", true);
  }
}
async function refreshPushToken() {
  if (!messaging || !S.user || pushPermission() !== "granted" || !VAPID_KEY || VAPID_KEY.startsWith("PASTE")) return;
  try { await saveToken(); } catch (ex) { console.warn("push token", ex); }
}
async function enableNotifications() {
  if (!messaging) {
    if (isIOS && !isStandalone()) toast("On iPhone, first add Kaburlu to your home screen, then turn on notifications from the app.");
    else toast("This browser doesn't support notifications. Try Chrome.");
    return;
  }
  if (!VAPID_KEY || VAPID_KEY.startsWith("PASTE")) { toast("Notifications aren't set up yet. Add the VAPID key (see README)."); return; }
  if (pushPermission() === "denied") { toast("Notifications are blocked. Allow them in your browser's site settings, then try again."); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("Notifications stay off."); updateNotifyUI(); return; }
    ls.set("pushSaved", false);
    await saveToken();
    toast("Notifications are on");
  } catch (ex) { console.error(ex); toast("Couldn't turn on notifications. Try again."); }
  updateNotifyUI();
}
$("#b-notify").onclick = enableNotifications;
$("#b-notify-x").onclick = () => { ls.set("notifyDismissed", Date.now() + 7 * 864e5); updateNotifyUI(); };

// Ask the server to notify the other person (it reads the real message from the database).
async function notifyOther(cid) {
  try { const idToken = await S.user.getIdToken(); await api("notify", { idToken, chatId: cid }); } catch {}
}

// Stop notifications for this device on log out.
$("#b-logout").onclick = async () => {
  const token = ls.get("pushToken", null);
  if (token && S.user) {
    try { await updateDoc(doc(db, "pushTokens", S.user.uid), { tokens: arrayRemove(token) }); } catch {}
    try { if (messaging) await deleteToken(messaging); } catch {}
    ls.set("pushToken", null); ls.set("pushSaved", false);
  }
  signOut(auth);
};

// Tapping a notification opens that chat.
let pendingChat = new URLSearchParams(location.search).get("chat");
function openPendingChat() {
  if (!pendingChat || !S.user) return;
  const cid = pendingChat;
  if (!S.chats.some(c => c.id === cid)) return;
  pendingChat = null; history.replaceState(null, "", "/");
  openChat(cid);
}
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.type === "open-chat" && e.data.chatId) { pendingChat = e.data.chatId; openPendingChat(); }
});
