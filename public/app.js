// app.js - Single-portal logic (person/member view + admin console).
"use strict";

const MAX_RENDER_ROWS = 500;
const MAX_ROWS   = 5000;
const PAGE_SIZE  = 25;
const MAX_IMPORT = 5000;

let me = null;
let myMemberId = null;
let attendanceMap = {};
let rsvpMap = {};
let adminLoaded = false;

let selectedMemberId = null;
let selectedEventId  = null;
let allMembers = [];
let viewMembers = [];
let eventsCache = [];
let bulkRows = [];
let memberFilter = "all";
let summaryRows = [];
const memberStats = { rows: [], allRows: [], upcoming: 0 };
let memberEvents = [];
const charts = {};
let pageIndex = 0, searchTerm = "", sortKey = "full_name", sortDir = "asc", showArchived = false;

// ---- Shared helpers ------------------------------------------------
function $(id) { return document.getElementById(id); }
function setStatus(id, message, isError) {
    const el = $(id);
    if (!el) { return; }
    el.textContent = message || "";
    el.className = isError ? "status error" : "status ok";
}
function show(id) { const el = $(id); if (el) { el.hidden = false; } }
function hide(id) { const el = $(id); if (el) { el.hidden = true; } }
function addCell(row, text) {
    const td = document.createElement("td");
    td.textContent = text;
    row.appendChild(td);
}
// ---- Event times: one fixed time zone for everyone ------------------
// Events happen at a physical place, so every viewer sees the event's local
// time (ORG.timezone in config.js), no matter what time zone their own phone
// or computer is set to. If ORG.timezone is blank or invalid, the viewer's
// device time zone is used as a fallback.
const EVENT_TZ = (function () {
    const wanted = (typeof ORG !== "undefined" && ORG.timezone) ? String(ORG.timezone).trim() : "";
    if (wanted) {
        try { new Intl.DateTimeFormat("en-US", { timeZone: wanted }); return wanted; }
        catch (err) { console.error("ORG.timezone is not a valid IANA time zone: " + wanted); }
    }
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
})();
const TZ_PARTS_FMT = new Intl.DateTimeFormat("en-US", {
    timeZone: EVENT_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
});
// Wall-clock pieces of an instant, as seen in EVENT_TZ.
function tzParts(ms) {
    const out = {};
    TZ_PARTS_FMT.formatToParts(new Date(ms)).forEach(function (p) { out[p.type] = p.value; });
    return { y: +out.year, mo: +out.month, d: +out.day, h: +out.hour % 24, mi: +out.minute, s: +out.second };
}
// How far EVENT_TZ is ahead of UTC at a given instant, in ms (handles DST).
function tzOffsetMs(ms) {
    const p = tzParts(ms);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - (ms - (ms % 1000));
}
function fmtDT(s) {
    if (!s) { return "\u2014"; }
    const d = new Date(s);
    if (isNaN(d.getTime())) { return s; }
    return d.toLocaleString(undefined, {
        timeZone: EVENT_TZ, timeZoneName: "short",
        month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
    });
}
// Stored UTC timestamp -> "YYYY-MM-DDTHH:MM" in EVENT_TZ for <input type="datetime-local">.
function toLocalInput(iso) {
    if (!iso) { return ""; }
    const ms = new Date(iso).getTime();
    if (isNaN(ms)) { return ""; }
    const p = tzParts(ms);
    const pad = function (n) { return String(n).padStart(2, "0"); };
    return p.y + "-" + pad(p.mo) + "-" + pad(p.d) + "T" + pad(p.h) + ":" + pad(p.mi);
}
// "YYYY-MM-DDTHH:MM" typed in EVENT_TZ -> full ISO timestamp in UTC for the database.
// (Sending the bare input value made Postgres treat it as UTC, shifting every event.)
function fromLocalInput(value) {
    if (!value) { return null; }
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
    if (!m) { return null; }
    const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    let ms = asUtc - tzOffsetMs(asUtc);
    const recheck = asUtc - tzOffsetMs(ms);       // correct guesses near a DST change
    if (recheck !== ms) { ms = recheck; }
    return new Date(ms).toISOString();
}
// CSV-friendly "YYYY-MM-DD HH:MM" in EVENT_TZ.
function fmtCsvDT(iso) {
    const v = toLocalInput(iso);
    return v ? v.replace("T", " ") : "";
}
function formatPhone(value) {
    const d = (value || "").replace(/\D/g, "").slice(0, 10);
    if (d.length <= 3) { return d; }
    if (d.length <= 6) { return d.slice(0, 3) + "-" + d.slice(3); }
    return d.slice(0, 3) + "-" + d.slice(3, 6) + "-" + d.slice(6);
}
function onPhoneInput(e) { e.target.value = formatPhone(e.target.value); }
function syncRenewal(typeId, renewalId) {
    const type = $(typeId).value, renewal = $(renewalId);
    if (type === "non-recurring") { renewal.value = ""; renewal.disabled = true; }
    else { renewal.disabled = false; }
}
function syncShirtDate(tierId, dateId) {
    const tier = $(tierId).value, date = $(dateId);
    if (tier === "No Shirt") { date.value = ""; date.disabled = true; }
    else { date.disabled = false; }
}

// ---- Login + single entry ------------------------------------------
// Show that a button was clicked and work is in progress: disables it,
// adds a spinner, and swaps its label (e.g. "Sending code..."). Returns a
// function that puts the button back (optionally with a new label).
function setBusy(button, busyLabel) {
    if (!button) { return function () {}; }
    const original = button.textContent;
    button.disabled = true;
    button.classList.add("busy");
    button.setAttribute("aria-busy", "true");
    button.textContent = "";
    const spin = document.createElement("span"); spin.className = "spinner"; spin.setAttribute("aria-hidden", "true");
    button.appendChild(spin);
    button.appendChild(document.createTextNode(busyLabel));
    return function (newLabel) {
        button.disabled = false;
        button.classList.remove("busy");
        button.removeAttribute("aria-busy");
        button.textContent = newLabel || original;
    };
}
function setInfo(id, message) {
    const el = $(id);
    if (el) { el.textContent = message; el.className = "status info"; }
}
async function onRequestCode(event) {
    event.preventDefault();
    const email = $("login-email").value.trim();
    const button = event.submitter || document.querySelector("#request-code-form button[type=submit]");
    const done = setBusy(button, "Sending code\u2026");
    setInfo("login-status", "Sending a sign-in code to " + email + "\u2026");
    try {
        await requestLoginCode(email);
        done("Resend code");
        if (button) { button.classList.add("secondary"); }   // the code box is now the main step
        show("verify-section");
        setStatus("login-status", "Code sent to " + email + ". Check your email (and spam folder) for the 8-digit code.", false);
        $("login-code").focus();
    } catch (err) {
        done();
        setStatus("login-status", err.message, true);
    }
}
async function onVerifyCode(event) {
    event.preventDefault();
    const button = event.submitter || document.querySelector("#verify-code-form button[type=submit]");
    const done = setBusy(button, "Signing in\u2026");
    setInfo("login-status", "Checking your code\u2026");
    try {
        setRememberDevice($("remember-me").checked);
        await verifyLoginCode($("login-email").value.trim(), $("login-code").value.trim());
        await enterApp();
        done();
    } catch (err) {
        done();
        setStatus("login-status", err.message, true);
    }
}
async function enterApp() {
    let profile;
    try { profile = await getMyProfile(); }
    catch (err) { setStatus("login-status", err.message, true); return; }
    if (!profile) {
        // Brief window right after first signup before the row is visible.
        await new Promise(function (r) { setTimeout(r, 1200); });
        try { profile = await getMyProfile(); } catch (err) { /* fall through */ }
    }
    if (!profile) {
        setStatus("login-status",
            "Your account is being set up — please sign in again in a moment.", true);
        return;
    }
    me = profile; myMemberId = me.id;
    hide("auth-view"); show("app-view"); show("app-nav"); show("header-user");
    $("who").textContent = me.full_name || me.email;
    if (me.is_admin) { show("tab-admin"); } else { hide("tab-admin"); }
    fillMemberProfile(me);
    showMemberView();
    await Promise.all([loadMemberEvents(), loadHours()]);
    renderMemberDash();
    await processPendingCheckin();
}
function showMemberView() {
    show("member-view"); hide("admin-view");
    $("tab-member").classList.add("active");
    $("tab-admin").classList.remove("active");
    $("tab-member").setAttribute("aria-current", "page");
    $("tab-admin").removeAttribute("aria-current");
    renderMemberDash();
}
async function showAdminView() {
    if (!me || !me.is_admin) { return; }
    hide("member-view"); show("admin-view");
    $("tab-admin").classList.add("active");
    $("tab-member").classList.remove("active");
    $("tab-admin").setAttribute("aria-current", "page");
    $("tab-member").removeAttribute("aria-current");
    if (!adminLoaded) {
        await loadAdminEvents();
        await Promise.all([loadMembers(), loadSummary(), loadTools()]);
        adminLoaded = true;
    }
    renderAdminDash();
}
// ---- Org branding + About panel (driven by ORG in config.js) -------
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
}
function initOrg() {
    if (typeof ORG === "undefined") { return; }
    if (ORG.name) { $("org-name").textContent = ORG.name; }
    if (ORG.logo_url) {
        const img = $("org-logo");
        img.src = ORG.logo_url; img.alt = (ORG.name || "Logo");
        img.hidden = false;
    }
    $("about-name").textContent = ORG.name || "About";
    const rows = [];
    if (ORG.address) { rows.push("<div class='about-row'>" + escapeHtml(ORG.address) + "</div>"); }
    if (ORG.phone) {
        rows.push("<div class='about-row'>Phone: <a href='tel:" + escapeHtml(ORG.phone.replace(/[^\d+]/g, ""))
            + "'>" + escapeHtml(ORG.phone) + "</a></div>");
    }
    if (ORG.email) {
        rows.push("<div class='about-row'>Email: <a href='mailto:" + escapeHtml(ORG.email)
            + "'>" + escapeHtml(ORG.email) + "</a></div>");
    }
    if (ORG.website) {
        const safe = escapeHtml(ORG.website);
        rows.push("<div class='about-row'>Web: <a href='" + safe + "' target='_blank' rel='noopener'>"
            + safe + "</a></div>");
    }
    $("about-body").innerHTML = rows.join("");
    $("about-btn").addEventListener("click", function () {
        const p = $("about-panel"); p.hidden = !p.hidden;
        $("about-btn").setAttribute("aria-expanded", String(!p.hidden));
    });
}

// =====================================================================
// PERSON / MEMBER VIEW
// =====================================================================
// Map each membership value to a semantic pill variant (color = meaning).
function statusVariant(s) {
    return { active: "success", pending: "neutral", lapsed: "warning", suspended: "danger" }[s] || "neutral";
}
function typeVariant(t) { return t === "recurring" ? "info" : "neutral"; }
function tierVariant(t) {
    return { "No Shirt": "neutral", "Shirt": "info", "Sponsor": "success" }[t] || "neutral";
}
// Show a fresh/incomplete profile first (hiding events + hour logging via
// the .needs-profile CSS) until first name, last name, and phone are saved.
function applyProfileGate() {
    const mv = $("member-view");
    if (!mv) { return; }
    const incomplete = !profileComplete(me);
    mv.classList.toggle("needs-profile", incomplete);

    // Header shows the person's name; read-only email in the form.
    const nameEl = $("profile-name");
    if (nameEl) { nameEl.textContent = (me && me.full_name) ? me.full_name : "My profile"; }
    if ($("f_email")) { $("f_email").value = me ? (me.email || "") : ""; }
    // Complete profiles collapse to a "View profile" summary; incomplete
    // ones stay open with no collapse control (they must finish it).
    const toggle = $("profile-toggle");
    const form = $("profile-form");
    if (toggle && form) {
        toggle.hidden = incomplete;
        toggle.textContent = "View profile";
        form.hidden = !incomplete;
    }

    let hint = $("profile-gate-hint");
    if (incomplete) {
        if (!hint) {
            hint = document.createElement("div");
            hint.id = "profile-gate-hint";
            hint.className = "notice";
            hint.textContent = "Welcome! Complete your profile below and press "
                + "Save to unlock events and volunteer-hour logging.";
            mv.insertBefore(hint, mv.firstChild);
        }
        hint.hidden = false;
    } else if (hint) { hint.hidden = true; }
    renderMemberDash();
}
function fillMemberProfile(p) {
    applyProfileGate();
    // Membership panel only for actual members; note for non-members.
    if (p.is_member) {
        hide("sec-nonmember");
        show("membership-panel");
        $("status-badge").textContent = p.membership_status;
        $("status-badge").className = "pill pill-" + statusVariant(p.membership_status);
        $("type-badge").textContent = p.membership_type;
        $("type-badge").className = "pill pill-" + typeVariant(p.membership_type);
        $("tier-badge").textContent = p.tier;
        $("tier-badge").className = "pill pill-" + tierVariant(p.tier);
        if (p.membership_type === "recurring" && p.next_renewal_date) {
            $("renewal-date").textContent = p.next_renewal_date; show("renewal-line");
        } else { hide("renewal-line"); }
        if (p.date_shirt_sent) {
            $("shirt-sent-date").textContent = p.date_shirt_sent; show("shirt-sent-line");
        } else { hide("shirt-sent-line"); }
    } else {
        hide("membership-panel");
        show("sec-nonmember");
    }
    $("f_first_name").value    = p.first_name    || "";
    $("f_last_name").value     = p.last_name     || "";
    $("f_phone").value         = p.phone         || "";
    $("f_address_line1").value = p.address_line1 || "";
    $("f_address_line2").value = p.address_line2 || "";
    $("f_city").value          = p.city          || "";
    $("f_state").value         = p.state         || "";
    $("f_postal_code").value   = p.postal_code   || "";
    $("f_shirt_size").value    = p.shirt_size    || "";
}
async function onSaveProfile(event) {
    event.preventDefault();
    const profile = {
        first_name: $("f_first_name").value.trim(), last_name: $("f_last_name").value.trim(),
        phone: $("f_phone").value.trim(), address_line1: $("f_address_line1").value.trim(),
        address_line2: $("f_address_line2").value.trim(), city: $("f_city").value.trim(),
        state: $("f_state").value.trim(), postal_code: $("f_postal_code").value.trim(),
        shirt_size: $("f_shirt_size").value
    };
    try {
        me = await updateMyProfile(profile);
        $("who").textContent = me.full_name || me.email;
        setStatus("profile-status", "Profile saved.", false);
        fillMemberProfile(me);      // re-run the gate: reveal events + hours once complete
        await loadMemberEvents();
        await processPendingCheckin();
    } catch (err) { setStatus("profile-status", err.message, true); }
}
async function loadMemberEvents() {
    try {
        const events = await listEvents();
        memberEvents = events;
        try {
            const att = await getMemberAttendance(myMemberId);
            attendanceMap = {};
            for (let i = 0; i < att.length; i += 1) { attendanceMap[att[i].event_id] = att[i].attended; }
            const rs = await getMemberRsvp(myMemberId);
            rsvpMap = {};
            for (let i = 0; i < rs.length; i += 1) { rsvpMap[rs[i].event_id] = rs[i].rsvp; }
        } catch (err) { /* best-effort */ }
        const now = Date.now();
        const upcoming = [], past = [];
        const limit = Math.min(events.length, MAX_RENDER_ROWS);
        for (let i = 0; i < limit; i += 1) {
            const t = new Date(events[i].start_at).getTime();
            if (!isNaN(t) && t >= now) { upcoming.push(events[i]); } else { past.push(events[i]); }
        }
        past.reverse();
        memberStats.upcoming = upcoming.length;
        const list = $("events-list"); list.innerHTML = "";
        renderEventGroup(list, "Upcoming", upcoming, true);
        renderPastList(list, past);
        const select = $("event-select"); select.innerHTML = "";
        const ordered = upcoming.concat(past);
        for (let i = 0; i < ordered.length; i += 1) {
            const opt = document.createElement("option");
            opt.value = ordered[i].id;
            opt.textContent = ordered[i].name + " (" + fmtDT(ordered[i].start_at) + ")";
            select.appendChild(opt);
        }
    } catch (err) { setStatus("hours-status", err.message, true); }
    renderMemberDash();
}
// upcoming = true  -> "I'm planning to attend" (RSVP) checkbox
// upcoming = false -> "I attended this event" checkbox (past events)
function renderEventGroup(container, heading, events, upcoming) {
    if (events.length === 0) { return; }
    if (heading) {
        const h = document.createElement("h3"); h.textContent = heading; container.appendChild(h);
    }
    const n = Math.min(events.length, MAX_RENDER_ROWS);
    for (let i = 0; i < n; i += 1) {
        const ev = events[i];
        const card = document.createElement("div"); card.className = "event-card";
        const title = document.createElement("div");
        title.textContent = ev.name; title.className = "event-title"; card.appendChild(title);
        const meta = document.createElement("div"); meta.className = "event-meta";
        meta.textContent = fmtDT(ev.start_at) + " \u2192 " + fmtDT(ev.end_at)
            + "  \u00b7  " + (ev.location || "\u2014");
        card.appendChild(meta);
        if (ev.description) {
            const d = document.createElement("div"); d.className = "event-meta";
            d.textContent = ev.description; card.appendChild(d);
        }
        const wrap = document.createElement("label"); wrap.className = "attend";
        const cb = document.createElement("input"); cb.type = "checkbox";
        const span = document.createElement("span");
        const note = document.createElement("span");
        note.className = "save-note";
        note.setAttribute("role", "status");
        note.setAttribute("aria-live", "polite");
        if (upcoming) {
            cb.checked = !!rsvpMap[ev.id];
            cb.addEventListener("change", function () { onToggleRsvp(ev.id, cb, note); });
            span.textContent = "I\u2019m planning to attend";
        } else {
            cb.checked = !!attendanceMap[ev.id];
            cb.addEventListener("change", function () { onToggleAttendance(ev.id, cb, note); });
            span.textContent = "I attended this event";
        }
        wrap.appendChild(cb); wrap.appendChild(span);
        const row = document.createElement("div"); row.className = "attend-row";
        row.appendChild(wrap); row.appendChild(note); card.appendChild(row);
        if (!profileComplete(me)) {
            const hint = document.createElement("div");
            hint.className = "event-meta hint-warn";
            hint.textContent = upcoming
                ? "Complete your profile to RSVP."
                : "Complete your profile to log hours or attendance.";
            card.appendChild(hint);
        }
        container.appendChild(card);
    }
}
// Past events: a collapsible "Past events (N)" section that lists the same
// cards as Upcoming, newest first, a page at a time. (Replaces the earlier
// <select> dropdown, which could size itself to its longest option and run
// off the side of narrow phone screens.)
const PAST_PAGE_SIZE = 10;
function renderPastList(container, events) {
    if (events.length === 0) { return; }
    const total = Math.min(events.length, MAX_RENDER_ROWS);
    const details = document.createElement("details");
    details.className = "past-events";
    const summary = document.createElement("summary");
    summary.textContent = "Past events (" + total + ")";
    details.appendChild(summary);
    const list = document.createElement("div");
    list.className = "past-list";
    details.appendChild(list);
    const more = document.createElement("button");
    more.type = "button"; more.className = "secondary small past-more";
    details.appendChild(more);
    let shown = 0;
    function showNext() {
        const next = Math.min(shown + PAST_PAGE_SIZE, total);
        renderEventGroup(list, null, events.slice(shown, next), false);
        shown = next;
        more.hidden = shown >= total;
        more.textContent = "Show more (" + (total - shown) + " remaining)";
    }
    more.addEventListener("click", showNext);
    showNext();
    container.appendChild(details);
}
// Small inline "Saving... / Saved / Couldn't save" note beside a checkbox.
function showSaveNote(note, state, message) {
    if (!note) { return; }
    clearTimeout(note._timer);
    note.className = "save-note " + state;
    note.textContent = message;
    if (state === "saved") {
        note._timer = setTimeout(function () {
            note.classList.add("fade");
            note._timer = setTimeout(function () { note.textContent = ""; note.className = "save-note"; }, 400);
        }, 2000);
    }
}
async function saveToggle(checkbox, note, needsProfileMsg, saveFn, map, eventId) {
    const desired = checkbox.checked;
    if (!profileComplete(me)) {
        checkbox.checked = !desired;
        showSaveNote(note, "error", needsProfileMsg);
        return;
    }
    checkbox.disabled = true;
    showSaveNote(note, "saving", "Saving\u2026");
    try {
        await saveFn(eventId, desired);
        map[eventId] = desired;
        showSaveNote(note, "saved", desired ? "Saved" : "Removed");
    } catch (err) {
        checkbox.checked = !desired;
        showSaveNote(note, "error", "Couldn\u2019t save: " + err.message);
    } finally {
        checkbox.disabled = false;
    }
}
function onToggleRsvp(eventId, checkbox, note) {
    return saveToggle(checkbox, note,
        "Complete My profile (first name, last name, phone) and Save before you RSVP.",
        setMyRsvp, rsvpMap, eventId);
}
function onToggleAttendance(eventId, checkbox, note) {
    return saveToggle(checkbox, note,
        "Complete My profile (first name, last name, phone) and Save before marking attendance.",
        setMyAttendance, attendanceMap, eventId);
}
function updateTotalPreview() {
    const h = Number($("hours-input").value) || 0;
    const t = Number($("travel-input").value) || 0;
    $("total-preview").textContent = String(h + t);
}
function profileComplete(p) {
    if (!p) { return false; }
    const digits = (p.phone || "").replace(/\D/g, "");
    return !!(p.first_name && p.first_name.trim()
        && p.last_name && p.last_name.trim() && digits.length === 10);
}
function requireCompleteProfile(statusId, action) {
    if (profileComplete(me)) { return true; }
    setStatus(statusId,
        "Add your first name, last name, and phone in My profile (then Save) before "
            + action + ".", true);
    return false;
}
async function onLogHours(event) {
    event.preventDefault();
    if (!requireCompleteProfile("hours-status", "logging hours")) { return; }
    const eventId = $("event-select").value;
    const hours = Number($("hours-input").value);
    const travel = Number($("travel-input").value || 0);
    const notes = $("hours-notes").value.trim();
    if (!(hours > 0 && hours <= 24)) { setStatus("hours-status", "Event hours must be between 0 and 24.", true); return; }
    if (travel < 0 || travel > 24) { setStatus("hours-status", "Travel hours must be between 0 and 24.", true); return; }
    try {
        await logVolunteerHours(eventId, hours, travel, notes);
        setStatus("hours-status", "Hours logged.", false);
        await loadHours();
    } catch (err) { setStatus("hours-status", err.message, true); }
}
async function loadHours() {
    if (!myMemberId) { return; }
    try {
        memberStats.allRows = await getMemberVolunteerHours(myMemberId);
        fillRangeOptions($("hours-range"), yearsOf(memberStats.allRows), true, hoursRange);
        renderHoursView();
    } catch (err) { setStatus("hours-status", err.message, true); }
}
// Re-draws "My logged hours", the summary cards and charts for the chosen period.
function renderHoursView() {
    const rows = sortByEventDate(rowsInRange(memberStats.allRows || [], hoursRange), true);
    memberStats.rows = rows;
    const tbody = $("hours-body"); tbody.innerHTML = "";
    const limit = Math.min(rows.length, MAX_RENDER_ROWS);
    for (let i = 0; i < limit; i += 1) {
        const r = rows[i];
        const tr = document.createElement("tr");
        tr.dataset.travel = String(Number(r.travel_time) > 0 ? 1 : 0);
        tr.dataset.notes = r.notes ? "1" : "0";
        addCell(tr, r.events ? fmtDate(r.events.start_at) : "");
        addCell(tr, r.events ? r.events.name : "");
        addCell(tr, String(r.hours));
        addCell(tr, String(r.travel_time));
        addCell(tr, String(r.total_hours));
        addCell(tr, r.notes || "");
        tbody.appendChild(tr);
    }
    tfRefresh("hours");
    renderMilestones();
    renderMemberDash();
}

// =====================================================================
// ADMIN VIEW
// =====================================================================
async function loadMembers() {
    try { allMembers = await adminFetchAllMembers(); applyView(); renderAdminDash(); }
    catch (err) { setStatus("members-status", err.message, true); }
}
function applyView() {
    const term = searchTerm.trim().toLowerCase();
    viewMembers = allMembers.filter(function (m) {
        if (!showArchived && m.archived) { return false; }   // hide archived by default
        if (!MEMBER_FILTERS[memberFilter].test(m)) { return false; }
        if (!term) { return true; }
        const hay = [m.email, m.full_name, m.phone, m.city, m.state,
            m.membership_status, m.tier].join(" ").toLowerCase();
        return hay.indexOf(term) >= 0;
    });
    const dir = sortDir === "desc" ? -1 : 1;
    viewMembers.sort(function (a, b) {
        let av = a[sortKey], bv = b[sortKey];
        if (sortKey === "total_hours") { return ((Number(av) || 0) - (Number(bv) || 0)) * dir; }
        if (sortKey === "is_member" || sortKey === "is_admin") {
            return ((av ? 1 : 0) - (bv ? 1 : 0)) * dir;
        }
        av = (av === null || av === undefined) ? "" : String(av).toLowerCase();
        bv = (bv === null || bv === undefined) ? "" : String(bv).toLowerCase();
        if (av < bv) { return -1 * dir; }
        if (av > bv) { return 1 * dir; }
        return 0;
    });
    const pages = Math.max(1, Math.ceil(viewMembers.length / PAGE_SIZE));
    if (pageIndex > pages - 1) { pageIndex = pages - 1; }
    if (pageIndex < 0) { pageIndex = 0; }
    renderMembers(); renderPager(); updateSortIndicators(); renderMemberFilters();
}
function needsAttention(m) {
    return !!m.is_member && (m.membership_status === "lapsed" || m.membership_status === "suspended");
}
const MEMBER_FILTERS = {
    all:       { label: "All",             test: function () { return true; } },
    members:   { label: "Members",         test: function (m) { return !!m.is_member; } },
    nonmember: { label: "Non-members",     test: function (m) { return !m.is_member; } },
    active:    { label: "Active",          test: function (m) { return !!m.is_member && m.membership_status === "active"; } },
    attention: { label: "Needs attention", test: needsAttention }
};
function renderMemberFilters() {
    const host = $("members-filters");
    if (!host) { return; }
    const base = allMembers.filter(function (m) { return showArchived || !m.archived; });
    host.innerHTML = "";
    Object.keys(MEMBER_FILTERS).forEach(function (key) {
        const f = MEMBER_FILTERS[key];
        const n = base.filter(f.test).length;
        const b = document.createElement("button");
        b.type = "button"; b.textContent = f.label + " (" + n + ")";
        b.setAttribute("aria-pressed", String(memberFilter === key));
        b.addEventListener("click", function () { memberFilter = key; pageIndex = 0; applyView(); });
        host.appendChild(b);
    });
    $("members-count").textContent = viewMembers.length + " of " + base.length + " shown";
}
function addBadge(row, text, variant) {
    const td = document.createElement("td");
    const sp = document.createElement("span");
    sp.className = "pill pill-" + variant; sp.textContent = text;
    td.appendChild(sp); row.appendChild(td);
}
function renderMembers() {
    const tbody = $("members-body"); tbody.innerHTML = "";
    const start = pageIndex * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, viewMembers.length, start + MAX_ROWS);
    for (let i = start; i < end; i += 1) {
        const m = viewMembers[i];
        const tr = document.createElement("tr"); tr.className = "clickable";
        tr.tabIndex = 0;
        if (needsAttention(m)) { tr.classList.add("flag"); }
        addCell(tr, m.email);
        addCell(tr, m.full_name || "");
        addCell(tr, m.is_member ? "yes" : "no");
        if (m.is_member) { addBadge(tr, m.membership_status, statusVariant(m.membership_status)); }
        else { addCell(tr, "\u2014"); }
        if (m.is_member) { addBadge(tr, m.tier, tierVariant(m.tier)); } else { addCell(tr, "\u2014"); }
        addCell(tr, String(m.total_hours));
        addCell(tr, m.is_admin ? "yes" : "no");
        tr.addEventListener("click", function () { selectMember(m); });
        tr.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectMember(m); }
        });
        tbody.appendChild(tr);
    }
}
function renderPager() {
    const pages = Math.max(1, Math.ceil(viewMembers.length / PAGE_SIZE));
    $("page-label").textContent = "Page " + (pageIndex + 1) + " of " + pages
        + " (" + viewMembers.length + " shown)";
    $("prev-page").disabled = pageIndex <= 0;
    $("next-page").disabled = pageIndex >= pages - 1;
}
function onPrevPage() { if (pageIndex > 0) { pageIndex -= 1; renderMembers(); renderPager(); } }
function onNextPage() {
    const pages = Math.ceil(viewMembers.length / PAGE_SIZE);
    if (pageIndex < pages - 1) { pageIndex += 1; renderMembers(); renderPager(); }
}
function onSearch(e) { searchTerm = e.target.value; pageIndex = 0; applyView(); }
function onSortHeader(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) { return; }
    if (sortKey === key) { sortDir = sortDir === "asc" ? "desc" : "asc"; }
    else { sortKey = key; sortDir = "asc"; }
    pageIndex = 0; applyView();
}
function updateSortIndicators() {
    const heads = document.querySelectorAll("#members-head th.sortable");
    for (let i = 0; i < heads.length; i += 1) {
        const th = heads[i], base = th.dataset.label;
        th.textContent = (th.dataset.key === sortKey)
            ? base + (sortDir === "asc" ? " \u25B2" : " \u25BC") : base;
    }
}

// ---- Create person/member ------------------------------------------
function toggleCreateMember() {
    const el = $("create-member-form");
    el.hidden = !el.hidden;
    hide("edit-form");
    syncRenewal("c_type", "c_renewal");
    syncShirtDate("c_tier", "c_shirt_sent");
}
async function onCreateMember(event) {
    event.preventDefault();
    const type = $("c_type").value, tier = $("c_tier").value;
    const fields = {
        email: $("c_email").value.trim(), first_name: $("c_first_name").value.trim(),
        last_name: $("c_last_name").value.trim(), phone: $("c_phone").value.trim(),
        is_member: $("c_is_member").checked,
        membership_status: $("c_status").value, membership_type: type,
        next_renewal_date: type === "recurring" ? ($("c_renewal").value || null) : null,
        tier: tier, date_shirt_sent: tier !== "No Shirt" ? ($("c_shirt_sent").value || null) : null,
        shirt_size: $("c_shirt_size").value, city: $("c_city").value.trim(),
        state: $("c_state").value.trim(), postal_code: $("c_postal_code").value.trim(),
        is_admin: $("c_is_admin").checked
    };
    if (!fields.email || !fields.first_name) {
        setStatus("create-status", "Email and first name are required.", true); return;
    }
    try {
        await adminCreateMember(fields);
        setStatus("create-status", "Person created.", false);
        $("create-member-form").reset();
        syncRenewal("c_type", "c_renewal"); syncShirtDate("c_tier", "c_shirt_sent");
        await Promise.all([loadMembers(), loadTools()]);
    } catch (err) { setStatus("create-status", err.message, true); }
}

// ---- CSV import ----------------------------------------------------
const IMPORT_COLS = ["email", "first_name", "last_name", "phone", "is_member",
    "membership_status", "membership_type", "next_renewal_date", "tier",
    "date_shirt_sent", "shirt_size", "city", "state", "postal_code", "is_admin"];

function parseCsv(text) {
    const rows = []; let row = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; } }
            else { field += c; }
        } else if (c === '"') { inQuotes = true; }
        else if (c === ",") { row.push(field); field = ""; }
        else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
        else if (c === "\r") { /* ignore */ }
        else { field += c; }
    }
    if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
}
function truthy(v) {
    const s = String(v || "").trim().toLowerCase();
    return s === "true" || s === "yes" || s === "1" || s === "y";
}
function downloadTemplate() {
    const ex1 = ["jane@example.org", "Jane", "Doe", "555-123-4567", "true", "active", "recurring",
        "2027-01-15", "Shirt", "2026-03-01", "M", "Springfield", "IL", "62701", "false"];
    const ex2 = ["sam@example.org", "Sam", "Volunteer", "", "false", "pending", "non-recurring",
        "", "No Shirt", "", "", "Chicago", "IL", "60601", "false"];
    const csv = [IMPORT_COLS.join(","), ex1.join(","), ex2.join(",")].join("\r\n");
    downloadFile("members-template.csv", csv);
}
async function onImportFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) { return; }
    setStatus("import-status", "Reading file...", false);
    $("import-log").textContent = "";
    let text;
    try { text = await file.text(); }
    catch (err) { setStatus("import-status", "Could not read file.", true); return; }
    const rows = parseCsv(text);
    if (rows.length < 2) { setStatus("import-status", "File has no data rows.", true); return; }
    const header = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    const idx = {};
    for (let c = 0; c < IMPORT_COLS.length; c += 1) { idx[IMPORT_COLS[c]] = header.indexOf(IMPORT_COLS[c]); }
    if (idx.email < 0) { setStatus("import-status", "Template must include an 'email' column.", true); return; }
    let imported = 0, skipped = 0;
    const errors = [];
    const limit = Math.min(rows.length, MAX_IMPORT + 1);
    for (let r = 1; r < limit; r += 1) {
        const cells = rows[r];
        if (cells.length === 1 && cells[0].trim() === "") { continue; }
        const get = function (key) {
            const at = idx[key];
            return at >= 0 && at < cells.length ? cells[at].trim() : "";
        };
        const fields = {
            email: get("email"), first_name: get("first_name"), last_name: get("last_name"),
            phone: get("phone"), is_member: truthy(get("is_member")),
            membership_status: get("membership_status") || "pending",
            membership_type: get("membership_type") || "non-recurring",
            next_renewal_date: get("next_renewal_date") || null, tier: get("tier") || "No Shirt",
            date_shirt_sent: get("date_shirt_sent") || null, shirt_size: get("shirt_size"),
            city: get("city"), state: get("state"), postal_code: get("postal_code"),
            is_admin: truthy(get("is_admin"))
        };
        if (!fields.email) { skipped += 1; errors.push("Row " + r + ": missing email"); continue; }
        try { await adminCreateMember(fields); imported += 1; }
        catch (err) { skipped += 1; errors.push("Row " + r + " (" + fields.email + "): " + err.message); }
    }
    setStatus("import-status", "Imported " + imported + ", skipped " + skipped + ".", skipped > 0);
    if (errors.length > 0) {
        const shown = errors.slice(0, 15).join("\n");
        $("import-log").textContent = shown
            + (errors.length > 15 ? "\n\u2026 and " + (errors.length - 15) + " more" : "");
    }
    event.target.value = "";
    await Promise.all([loadMembers(), loadTools()]);
}

// ---- CSV exports ---------------------------------------------------
function csvCell(value) {
    const s = (value === null || value === undefined) ? "" : String(value);
    if (/[",\n]/.test(s)) { return '"' + s.replace(/"/g, '""') + '"'; }
    return s;
}
function rowsToCsv(cols, rows, pick) {
    const lines = [cols.join(",")];
    const n = Math.min(rows.length, MAX_ROWS);
    for (let i = 0; i < n; i += 1) {
        const values = pick(rows[i]); const cells = [];
        for (let c = 0; c < values.length; c += 1) { cells.push(csvCell(values[c])); }
        lines.push(cells.join(","));
    }
    return lines.join("\r\n");
}
function downloadFile(filename, text) {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
async function onExportMembers() {
    try {
        const rows = await adminFetchAllMembers();
        const cols = ["email", "first_name", "last_name", "phone", "is_member",
            "membership_status", "membership_type", "next_renewal_date", "tier",
            "date_shirt_sent", "address_line1", "address_line2", "city", "state",
            "postal_code", "shirt_size", "total_hours", "is_admin"];
        downloadFile("members.csv", rowsToCsv(cols, rows, function (m) {
            return cols.map(function (c) { return m[c]; });
        }));
        setStatus("members-status", "Exported " + rows.length + " people.", false);
    } catch (err) { setStatus("members-status", err.message, true); }
}
async function onExportHours() {
    try {
        const rows = await adminFetchAllHours();
        const cols = ["name", "email", "is_member", "event", "event_start (" + EVENT_TZ + ")",
            "event_location", "event_hours", "travel_hours", "total_hours", "notes"];
        downloadFile("hours.csv", rowsToCsv(cols, rows, function (r) {
            const m = r.members || {}, e = r.events || {};
            const name = [m.first_name, m.last_name].filter(Boolean).join(" ");
            return [name, m.email || "", m.is_member ? "yes" : "no", e.name || "",
                fmtCsvDT(e.start_at), e.location || "", r.hours, r.travel_time, r.total_hours, r.notes || ""];
        }));
        setStatus("members-status", "Exported " + rows.length + " hour entries.", false);
    } catch (err) { setStatus("members-status", err.message, true); }
}

// ---- Person editing ------------------------------------------------
function selectMember(m) {
    hide("create-member-form");
    selectedMemberId = m.id;
    $("e_email").value             = m.email;
    $("e_first_name").value        = m.first_name    || "";
    $("e_last_name").value         = m.last_name     || "";
    $("e_phone").value             = m.phone         || "";
    $("e_is_member").checked        = m.is_member;
    $("e_membership_status").value = m.membership_status;
    $("e_type").value              = m.membership_type || "non-recurring";
    $("e_renewal").value           = m.next_renewal_date || "";
    $("e_tier").value              = m.tier || "No Shirt";
    $("e_shirt_sent").value        = m.date_shirt_sent || "";
    $("e_address_line1").value     = m.address_line1 || "";
    $("e_address_line2").value     = m.address_line2 || "";
    $("e_city").value              = m.city          || "";
    $("e_state").value             = m.state         || "";
    $("e_postal_code").value       = m.postal_code   || "";
    $("e_shirt_size").value        = m.shirt_size    || "";
    $("e_is_admin").checked        = m.is_admin;
    $("archive-btn").textContent = m.archived ? "Unarchive" : "Archive";
    $("archive-btn").dataset.archived = m.archived ? "1" : "";
    hide("archive-confirm");
    if ($("merge-search")) { $("merge-search").value = ""; }
    if ($("merge-results")) { $("merge-results").innerHTML = ""; }
    hide("merge-confirm"); mergeSourceId = null;
    setStatus("merge-status", "", false);
    syncRenewal("e_type", "e_renewal");
    syncShirtDate("e_tier", "e_shirt_sent");
    fillRangeOptions($("e_print_range"), yearsOf(eventsCache.map(function (e) { return { events: e }; })), false, null);
    setStatus("e_print_status", "", false);
    show("edit-form");
}
// Merge: search for the profile to merge INTO the one being edited.
let mergeSourceId = null;
function onMergeSearch() {
    const results = $("merge-results");
    if (!results) { return; }
    results.innerHTML = "";
    hide("merge-confirm"); mergeSourceId = null;
    const term = ($("merge-search").value || "").trim().toLowerCase();
    if (!term || !selectedMemberId) { return; }
    let shown = 0;
    for (let i = 0; i < allMembers.length && shown < 8; i += 1) {
        const m = allMembers[i];
        if (m.id === selectedMemberId) { continue; }    // can't merge into itself
        const hay = ((m.full_name || "") + " " + m.email).toLowerCase();
        if (hay.indexOf(term) < 0) { continue; }
        const div = document.createElement("div");
        div.textContent = (m.full_name ? m.full_name + " " : "") + "<" + m.email + ">";
        div.addEventListener("click", function () { onMergeArm(m); });
        results.appendChild(div);
        shown += 1;
    }
    if (shown === 0) {
        const div = document.createElement("div");
        div.textContent = "No match."; div.style.color = "var(--muted)"; div.style.cursor = "default";
        results.appendChild(div);
    }
}
// Clicking a result arms an inline confirm (no blocking dialog).
function onMergeArm(source) {
    if (!selectedMemberId) { return; }
    mergeSourceId = source.id;
    const target = allMembers.find(function (x) { return x.id === selectedMemberId; });
    const tgtName = target ? (target.full_name || target.email) : "this profile";
    const srcName = source.full_name || source.email;
    $("merge-results").innerHTML = "";
    $("merge-confirm-text").textContent = "Merge \u201c" + srcName + "\u201d into \u201c"
        + tgtName + "\u201d? Their hours and attendance move over, then \u201c" + srcName
        + "\u201d is deleted. This cannot be undone.";
    show("merge-confirm");
}
async function onMergeConfirm() {
    if (!selectedMemberId || !mergeSourceId) { return; }
    try {
        await adminMergeMembers(selectedMemberId, mergeSourceId);
        setStatus("merge-status", "Merged in.", false);
        mergeSourceId = null;
        $("merge-search").value = ""; $("merge-results").innerHTML = ""; hide("merge-confirm");
        hide("edit-form"); selectedMemberId = null;
        await loadMembers(); await loadTools();
    } catch (err) { setStatus("merge-status", err.message, true); }
}
function onMergeCancel() { mergeSourceId = null; hide("merge-confirm"); }
async function doArchive(next) {
    if (!selectedMemberId) { return; }
    try {
        await adminSetArchived(selectedMemberId, next);
        setStatus("members-status", next ? "Archived." : "Unarchived.", false);
        hide("edit-form"); selectedMemberId = null;
        await loadMembers(); await loadTools();
    } catch (err) { setStatus("members-status", err.message, true); }
}
function onArchiveToggle() {
    if (!selectedMemberId) { return; }
    const currentlyArchived = $("archive-btn").dataset.archived === "1";
    if (currentlyArchived) { doArchive(false); return; }   // unarchive is instant
    show("archive-confirm");                                 // archiving asks inline first
}
function onArchiveCancel() { hide("archive-confirm"); }
async function onSaveMember(event) {
    event.preventDefault();
    if (!selectedMemberId) { return; }
    const type = $("e_type").value, tier = $("e_tier").value;
    const fields = {
        first_name: $("e_first_name").value.trim() || null,
        last_name: $("e_last_name").value.trim() || null,
        phone: $("e_phone").value.trim() || null,
        is_member: $("e_is_member").checked,
        membership_status: $("e_membership_status").value, membership_type: type,
        next_renewal_date: type === "recurring" ? ($("e_renewal").value || null) : null,
        tier: tier, date_shirt_sent: tier !== "No Shirt" ? ($("e_shirt_sent").value || null) : null,
        address_line1: $("e_address_line1").value.trim() || null,
        address_line2: $("e_address_line2").value.trim() || null,
        city: $("e_city").value.trim() || null, state: $("e_state").value.trim() || null,
        postal_code: $("e_postal_code").value.trim() || null,
        shirt_size: $("e_shirt_size").value || null, is_admin: $("e_is_admin").checked
    };
    try {
        await adminUpdateMember(selectedMemberId, fields);
        setStatus("members-status", "Saved.", false);
        await loadMembers(); await loadTools();
    } catch (err) { setStatus("members-status", err.message, true); }
}

// ---- Events (admin): create + edit ---------------------------------
async function loadAdminEvents() {
    try {
        eventsCache = await listEvents();
        renderEventsTable(eventsCache);
        populateEventSelects(eventsCache);
    } catch (err) { setStatus("events-status", err.message, true); }
}
function renderEventsTable(events) {
    const tbody = $("events-body"); tbody.innerHTML = "";
    const n = Math.min(events.length, MAX_ROWS);
    for (let i = 0; i < n; i += 1) {
        const ev = events[i];
        const tr = document.createElement("tr"); tr.className = "clickable"; tr.tabIndex = 0;
        tr.dataset.start = String(new Date(ev.start_at).getTime());
        addCell(tr, ev.name); addCell(tr, fmtDT(ev.start_at));
        addCell(tr, fmtDT(ev.end_at)); addCell(tr, ev.location || "");
        tr.addEventListener("click", function () { selectEvent(ev); });
        tr.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectEvent(ev); }
        });
        tbody.appendChild(tr);
    }
    tfRefresh("events");
}
function populateEventSelects(events) {
    const targets = ["log-event-select", "bulk-event-select", "manage-event-select"];
    for (let t = 0; t < targets.length; t += 1) {
        const sel = $(targets[t]);
        if (!sel) { continue; }
        sel.innerHTML = "";
        const n = Math.min(events.length, MAX_ROWS);
        for (let i = 0; i < n; i += 1) {
            const opt = document.createElement("option");
            opt.value = events[i].id;
            opt.textContent = events[i].name + " (" + fmtDT(events[i].start_at) + ")";
            sel.appendChild(opt);
        }
    }
}
async function onCreateEvent(event) {
    event.preventDefault();
    const start = $("ev_start").value, end = $("ev_end").value;
    if (!$("ev_name").value.trim() || !start) {
        setStatus("events-status", "Name and start time are required.", true); return; }
    if (end && end < start) { setStatus("events-status", "End time must be after start time.", true); return; }
    try {
        await adminCreateEvent({ name: $("ev_name").value.trim(), start_at: fromLocalInput(start),
            end_at: fromLocalInput(end), location: $("ev_location").value.trim(),
            description: $("ev_desc").value.trim() });
        setStatus("events-status", "Event created.", false);
        $("create-event-form").reset();
        await loadAdminEvents();
    } catch (err) { setStatus("events-status", err.message, true); }
}
function selectEvent(ev) {
    selectedEventId = ev.id;
    $("ee_name").value = ev.name || ""; $("ee_location").value = ev.location || "";
    $("ee_start").value = toLocalInput(ev.start_at); $("ee_end").value = toLocalInput(ev.end_at);
    $("ee_desc").value = ev.description || "";
    hide("qr-panel"); hide("delete-event-confirm");
    setStatus("edit-event-status", "", false);
    show("edit-event-form");
}
async function onSaveEvent(event) {
    event.preventDefault();
    if (!selectedEventId) { return; }
    const start = $("ee_start").value, end = $("ee_end").value;
    if (!$("ee_name").value.trim() || !start) {
        setStatus("edit-event-status", "Name and start time are required.", true); return; }
    if (end && end < start) { setStatus("edit-event-status", "End time must be after start time.", true); return; }
    try {
        await adminUpdateEvent(selectedEventId, { name: $("ee_name").value.trim(),
            start_at: fromLocalInput(start), end_at: fromLocalInput(end), location: $("ee_location").value.trim(),
            description: $("ee_desc").value.trim() });
        setStatus("edit-event-status", "Event updated.", false);
        await loadAdminEvents(); await loadSummary();
    } catch (err) { setStatus("edit-event-status", err.message, true); }
}
function onCancelEditEvent() {
    selectedEventId = null; hide("edit-event-form"); hide("qr-panel"); hide("delete-event-confirm");
}

// ---- Delete event (with everything linked to it) -------------------
// Step 1: show an inline "Are you sure?" box that spells out what goes with it.
function onDeleteEventClick() {
    if (!selectedEventId) { return; }
    const ev = eventsCache.filter(function (e) { return e.id === selectedEventId; })[0] || {};
    const sum = summaryRows.filter(function (r) { return r.event_id === selectedEventId; })[0];
    let text = "\u201c" + (ev.name || "This event") + "\u201d"
        + (ev.start_at ? " (" + fmtDT(ev.start_at) + ")" : "")
        + " and everything linked to it will be permanently removed";
    if (sum) {
        const n = Number(sum.member_count) || 0, a = Number(sum.attended_count) || 0, r = Number(sum.rsvp_count) || 0;
        text += ": " + n + (n === 1 ? " hours entry" : " hours entries")
            + " (" + fmtNum(sum.total_hours) + " total hours), "
            + a + (a === 1 ? " check-in" : " check-ins") + ", and "
            + r + (r === 1 ? " RSVP" : " RSVPs");
    } else {
        text += ", including all logged hours, check-ins, and RSVPs";
    }
    text += ". This cannot be undone. (The change history keeps a record of what was deleted.)";
    $("delete-event-confirm-text").textContent = text;
    hide("qr-panel");
    show("delete-event-confirm");
    $("delete-event-cancel-btn").focus();     // safe default for keyboard users
}
function onDeleteEventCancel() { hide("delete-event-confirm"); $("delete-event-btn").focus(); }
// Step 2: actually delete, then refresh every view that showed this event.
async function onDeleteEventConfirm() {
    if (!selectedEventId) { return; }
    const btn = $("delete-event-confirm-btn");
    btn.disabled = true;
    try {
        const gone = await adminDeleteEvent(selectedEventId);
        onCancelEditEvent();
        $("manage-body").innerHTML = ""; setStatus("manage-status", "", false); tfRefresh("manage");
        setStatus("events-status", "Deleted \u201c" + (gone.name || "event") + "\u201d and its hours, check-ins, and RSVPs.", false);
        await loadAdminEvents();
        await Promise.all([refreshDerived(), loadMemberEvents(), loadHours()]);
        renderMemberDash();
    } catch (err) {
        setStatus("edit-event-status", err.message, true);
    } finally { btn.disabled = false; }
}

// ---- Summary -------------------------------------------------------
async function loadSummary() {
    try {
        const rows = await adminEventHoursSummary();
        const tbody = $("summary-body"); tbody.innerHTML = "";
        summaryRows = rows;
        const n = Math.min(rows.length, MAX_ROWS);
        for (let i = 0; i < n; i += 1) {
            const r = rows[i];
            const tr = document.createElement("tr");
            const flagged = Number(r.attended_count) > 0 && !(Number(r.total_hours) > 0);
            tr.dataset.flag = flagged ? "1" : "0";
            tr.dataset.hours = String(Number(r.total_hours) > 0 ? 1 : 0);
            if (flagged) { tr.classList.add("flag"); }
            addCell(tr, r.event_name); addCell(tr, fmtDT(r.start_at));
            addCell(tr, r.location || ""); addCell(tr, String(r.rsvp_count || 0));
            addCell(tr, String(r.attended_count));
            addCell(tr, String(r.member_count)); addCell(tr, String(r.total_hours));
            tbody.appendChild(tr);
        }
        tfRefresh("summary");
        renderAdminDash();
    } catch (err) { setStatus("summary-status", err.message, true); }
}
async function refreshDerived() { await Promise.all([loadSummary(), loadMembers()]); }

// ---- Tools: single log + bulk (type-ahead) -------------------------
async function loadTools() {
    try {
        if (!allMembers.length) { allMembers = await adminFetchAllMembers(); }
        const active = allMembers.filter(function (m) { return !m.archived; });  // no archived in logging tools
        populateMemberSelect("log-member-select", active);
        renderBulkRows();
    } catch (err) { setStatus("bulk-status", err.message, true); }
}
function memberLabel(m) {
    const name = m.full_name ? m.full_name + " " : "";
    return name + "<" + m.email + ">" + (m.is_member ? "" : " (non-member)");
}
function populateMemberSelect(selectId, members) {
    const sel = $(selectId);
    if (!sel) { return; }
    sel.innerHTML = "";
    const n = Math.min(members.length, MAX_ROWS);
    for (let i = 0; i < n; i += 1) {
        const opt = document.createElement("option");
        opt.value = members[i].id; opt.textContent = memberLabel(members[i]);
        sel.appendChild(opt);
    }
}
function updateLogTotalPreview() {
    const h = Number($("log-hours-input").value) || 0;
    const t = Number($("log-travel-input").value) || 0;
    $("log-total-preview").textContent = String(h + t);
}
async function onLogForMember(event) {
    event.preventDefault();
    const memberId = $("log-member-select").value, eventId = $("log-event-select").value;
    const hours = Number($("log-hours-input").value);
    const travel = Number($("log-travel-input").value || 0);
    const notes = $("log-notes-input").value.trim();
    if (!memberId || !eventId) { setStatus("log-status", "Select a person and an event.", true); return; }
    if (!(hours > 0 && hours <= 24)) { setStatus("log-status", "Event hours must be between 0 and 24.", true); return; }
    if (travel < 0 || travel > 24) { setStatus("log-status", "Travel hours must be between 0 and 24.", true); return; }
    try {
        await adminLogHoursFor(memberId, eventId, hours, travel, notes);
        setStatus("log-status", "Hours saved.", false);
        await refreshDerived();
    } catch (err) { setStatus("log-status", err.message, true); }
}
function onBulkSearch() {
    const term = $("bulk-search").value.trim().toLowerCase();
    const results = $("bulk-search-results");
    results.innerHTML = "";
    if (!term) { return; }
    const added = {};
    for (let i = 0; i < bulkRows.length; i += 1) { added[bulkRows[i].member_id] = true; }
    let shown = 0;
    for (let i = 0; i < allMembers.length && shown < 8; i += 1) {
        const m = allMembers[i];
        if (added[m.id]) { continue; }
        if (m.archived) { continue; }        // archived people aren't logged against
        const hay = ((m.full_name || "") + " " + m.email).toLowerCase();
        if (hay.indexOf(term) < 0) { continue; }
        const div = document.createElement("div");
        div.textContent = memberLabel(m);
        div.addEventListener("click", function () { addBulkMember(m.id); });
        results.appendChild(div);
        shown += 1;
    }
    if (shown === 0) {
        const div = document.createElement("div");
        div.textContent = "No matches"; div.style.color = "var(--muted)"; div.style.cursor = "default";
        results.appendChild(div);
    }
}
function addBulkMember(mid) {
    if (bulkRows.some(function (r) { return r.member_id === mid; })) { return; }
    bulkRows.push({ member_id: mid });
    $("bulk-search").value = "";
    $("bulk-search-results").innerHTML = "";
    renderBulkRows();
    setStatus("bulk-status", "", false);
}
function memberName(mid) {
    const m = allMembers.find(function (x) { return x.id === mid; });
    return m ? (m.full_name || m.email) : mid;
}
function renderBulkRows() {
    const tbody = $("bulk-body"); tbody.innerHTML = "";
    const n = Math.min(bulkRows.length, MAX_ROWS);
    for (let i = 0; i < n; i += 1) {
        const mid = bulkRows[i].member_id;
        const tr = document.createElement("tr"); tr.dataset.memberId = mid;
        addCell(tr, memberName(mid));
        const hTd = document.createElement("td");
        const hIn = document.createElement("input");
        hIn.type = "number"; hIn.step = "0.25"; hIn.min = "0"; hIn.max = "24"; hIn.className = "bulk-hours";
        hTd.appendChild(hIn); tr.appendChild(hTd);
        const tTd = document.createElement("td");
        const tIn = document.createElement("input");
        tIn.type = "number"; tIn.step = "0.25"; tIn.min = "0"; tIn.max = "24"; tIn.className = "bulk-travel";
        tTd.appendChild(tIn); tr.appendChild(tTd);
        const nTd = document.createElement("td");
        const nIn = document.createElement("input"); nIn.type = "text"; nIn.className = "bulk-notes";
        nTd.appendChild(nIn); tr.appendChild(nTd);
        const aTd = document.createElement("td");
        const del = document.createElement("button");
        del.type = "button"; del.className = "small danger"; del.textContent = "Remove";
        del.addEventListener("click", function () {
            bulkRows = bulkRows.filter(function (r) { return r.member_id !== mid; });
            renderBulkRows();
        });
        aTd.appendChild(del); tr.appendChild(aTd);
        tbody.appendChild(tr);
    }
}
async function onBulkSubmit(event) {
    event.preventDefault();
    const eventId = $("bulk-event-select").value;
    if (!eventId) { setStatus("bulk-status", "Select an event.", true); return; }
    if (bulkRows.length === 0) { setStatus("bulk-status", "Add at least one person.", true); return; }
    const rows = $("bulk-body").querySelectorAll("tr");
    const entries = [];
    const limit = Math.min(rows.length, MAX_ROWS);
    for (let i = 0; i < limit; i += 1) {
        const hours = Number(rows[i].querySelector(".bulk-hours").value);
        const travel = Number(rows[i].querySelector(".bulk-travel").value || 0);
        const notesEl = rows[i].querySelector(".bulk-notes");
        if (!(hours > 0 && hours <= 24)) { setStatus("bulk-status", "Row " + (i + 1) + ": event hours must be 0-24.", true); return; }
        if (travel < 0 || travel > 24) { setStatus("bulk-status", "Row " + (i + 1) + ": travel must be 0-24.", true); return; }
        entries.push({ member_id: rows[i].dataset.memberId, hours: hours, travel: travel,
            notes: notesEl ? notesEl.value.trim() : "" });
    }
    try {
        const count = await adminBulkLogHours(eventId, entries);
        setStatus("bulk-status", "Saved " + count + " entries.", false);
        bulkRows = []; renderBulkRows();
        await refreshDerived();
    } catch (err) { setStatus("bulk-status", err.message, true); }
}

// ---- Manage existing hours entries ---------------------------------
async function onLoadEntries(event) {
    event.preventDefault();
    const eventId = $("manage-event-select").value;
    if (!eventId) { setStatus("manage-status", "Select an event.", true); return; }
    try {
        const rows = await adminListHoursForEvent(eventId);
        renderEntries(rows);
        setStatus("manage-status", rows.length + " entries loaded.", false);
    } catch (err) { setStatus("manage-status", err.message, true); }
}
function renderEntries(rows) {
    const tbody = $("manage-body"); tbody.innerHTML = "";
    const n = Math.min(rows.length, MAX_ROWS);
    for (let i = 0; i < n; i += 1) {
        const r = rows[i], who = r.members || {};
        const tr = document.createElement("tr");
        tr.dataset.notes = r.notes ? "1" : "0";
        addCell(tr, who.full_name || ""); addCell(tr, who.email || "");
        const hTd = document.createElement("td");
        const hIn = document.createElement("input");
        hIn.type = "number"; hIn.step = "0.25"; hIn.min = "0"; hIn.max = "24";
        hIn.value = String(r.hours); hIn.className = "entry-hours"; hIn.setAttribute("aria-label", "Event hours for " + (who.full_name || who.email || "entry"));
        hTd.appendChild(hIn); tr.appendChild(hTd);
        const tTd = document.createElement("td");
        const tIn = document.createElement("input");
        tIn.type = "number"; tIn.step = "0.25"; tIn.min = "0"; tIn.max = "24";
        tIn.value = String(r.travel_time); tIn.className = "entry-travel"; tIn.setAttribute("aria-label", "Travel hours for " + (who.full_name || who.email || "entry"));
        tTd.appendChild(tIn); tr.appendChild(tTd);
        const totalTd = document.createElement("td");
        totalTd.textContent = String(r.total_hours); tr.appendChild(totalTd);
        const nTd = document.createElement("td");
        const nIn = document.createElement("input");
        nIn.type = "text"; nIn.value = r.notes || ""; nIn.className = "entry-notes"; nIn.setAttribute("aria-label", "Notes for " + (who.full_name || who.email || "entry"));
        nTd.appendChild(nIn); tr.appendChild(nTd);
        const aTd = document.createElement("td");
        const wrap = document.createElement("div"); wrap.className = "row-actions";
        const saveBtn = document.createElement("button");
        saveBtn.type = "button"; saveBtn.className = "small"; saveBtn.textContent = "Save";
        saveBtn.addEventListener("click", function () { onSaveEntry(r.id, hIn, tIn, nIn); });
        const delBtn = document.createElement("button");
        delBtn.type = "button"; delBtn.className = "small danger"; delBtn.textContent = "Delete";
        delBtn.addEventListener("click", function () { onDeleteEntry(r.id, tr); });
        wrap.appendChild(saveBtn); wrap.appendChild(delBtn);
        aTd.appendChild(wrap); tr.appendChild(aTd);
        tbody.appendChild(tr);
    }
    tfRefresh("manage");
}
async function onSaveEntry(entryId, hoursInput, travelInput, notesInput) {
    const hours = Number(hoursInput.value), travel = Number(travelInput.value || 0);
    if (!(hours > 0 && hours <= 24)) { setStatus("manage-status", "Event hours must be between 0 and 24.", true); return; }
    if (travel < 0 || travel > 24) { setStatus("manage-status", "Travel hours must be between 0 and 24.", true); return; }
    try {
        await adminUpdateHoursEntry(entryId, { hours: hours, travel_time: travel,
            notes: notesInput.value.trim() || null });
        setStatus("manage-status", "Entry updated.", false);
        await refreshDerived();
        await onLoadEntries({ preventDefault: function () {} });
    } catch (err) { setStatus("manage-status", err.message, true); }
}
async function onDeleteEntry(entryId, rowEl) {
    if (!window.confirm("Delete this hours entry? This cannot be undone.")) { return; }
    try {
        await adminDeleteHoursEntry(entryId);
        if (rowEl && rowEl.parentNode) { rowEl.parentNode.removeChild(rowEl); }
        setStatus("manage-status", "Entry deleted.", false);
        await refreshDerived();
    } catch (err) { setStatus("manage-status", err.message, true); }
}

async function onLogout() {
    await logout();
    window.location.reload();
}
// If the sign-in can no longer be renewed (e.g. signed out on another device,
// or revoked), return to the sign-in screen with an explanation.
window.addEventListener("mmp:session-ended", function () {
    if (!me) { return; }              // already on the sign-in screen
    try { sessionStorage.setItem("mmp.notice", "Your sign-in has ended. Please sign in again."); } catch (e) { /* ignore */ }
    window.location.reload();
});


// =====================================================================
// VA UI MODULE: in-page tabs, table search/filters, metric cards, charts
// =====================================================================
const VA = { ok: "#008300", warn: "#eda100", bad: "#e34948", link: "#2a78d6", brand: "#003e73", unknown: "#898781" };

// ---- Light / dark theme toggle (saved in localStorage) ---------------
function currentTheme() { return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"; }
function initThemeToggle() {
    const btn = $("theme-toggle");
    function sync() {
        const dark = currentTheme() === "dark";
        btn.setAttribute("aria-pressed", String(dark));
        btn.textContent = "Dark theme";
    }
    sync();
    btn.addEventListener("click", function () {
        const next = currentTheme() === "dark" ? "light" : "dark";
        if (next === "dark") { document.documentElement.setAttribute("data-theme", "dark"); }
        else { document.documentElement.removeAttribute("data-theme"); }
        try { localStorage.setItem("mmp.theme", next); } catch (e) { /* ignore */ }
        sync();
        if (me) { renderMemberDash(); if (!$("admin-view").hidden) { renderAdminDash(); } }   // redraw charts in new colors
    });
}
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// ---- In-page tabs (role=tablist; roving tabindex; arrow keys) --------
function initTabs() {
    const list = $("admin-tabs");
    if (!list) { return; }
    const tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    function select(tab, focus) {
        tabs.forEach(function (t) {
            const on = t === tab;
            t.setAttribute("aria-selected", String(on));
            t.tabIndex = on ? 0 : -1;
            const panel = $(t.getAttribute("aria-controls"));
            if (panel) { panel.hidden = !on; }
            if (on && t.id === "atab-audit") { loadAudit(true); }
        });
        if (focus) { tab.focus(); }
    }
    tabs.forEach(function (t, i) {
        t.addEventListener("click", function () { select(t, false); });
        t.addEventListener("keydown", function (e) {
            let next = null;
            if (e.key === "ArrowRight") { next = tabs[(i + 1) % tabs.length]; }
            else if (e.key === "ArrowLeft") { next = tabs[(i - 1 + tabs.length) % tabs.length]; }
            else if (e.key === "Home") { next = tabs[0]; }
            else if (e.key === "End") { next = tabs[tabs.length - 1]; }
            if (next) { e.preventDefault(); select(next, true); }
        });
    });
}

// ---- Table search + filter buttons + "N of M shown" ------------------
const TF_CFG = {
    hours: { tbody: "hours-body", search: "hours-search", filters: "hours-filters", count: "hours-count",
        list: [
            { key: "all", label: "All", test: function () { return true; } },
            { key: "travel", label: "With travel", test: function (tr) { return tr.dataset.travel === "1"; } },
            { key: "notes", label: "With notes", test: function (tr) { return tr.dataset.notes === "1"; } }] },
    events: { tbody: "events-body", search: "events-search", filters: "events-filters", count: "events-count",
        list: [
            { key: "all", label: "All", test: function () { return true; } },
            { key: "upcoming", label: "Upcoming", test: function (tr) { return Number(tr.dataset.start) >= Date.now(); } },
            { key: "past", label: "Past", test: function (tr) { return Number(tr.dataset.start) < Date.now(); } }] },
    summary: { tbody: "summary-body", search: "summary-search", filters: "summary-filters", count: "summary-count",
        list: [
            { key: "all", label: "All", test: function () { return true; } },
            { key: "attention", label: "Needs attention", test: function (tr) { return tr.dataset.flag === "1"; } },
            { key: "hours", label: "Has hours", test: function (tr) { return tr.dataset.hours === "1"; } }] },
    audit: { tbody: "audit-body", search: "audit-search", filters: "audit-filters", count: "audit-count",
        list: [
            { key: "all", label: "All", test: function () { return true; } },
            { key: "members", label: "People", test: function (tr) { return tr.dataset.table === "members"; } },
            { key: "events", label: "Events", test: function (tr) { return tr.dataset.table === "events"; } },
            { key: "hours", label: "Hours", test: function (tr) { return tr.dataset.table === "volunteer_hours"; } },
            { key: "important", label: "Important", test: function (tr) { return tr.dataset.important === "1"; } }] },
    manage: { tbody: "manage-body", search: "manage-search", filters: "manage-filters", count: "manage-count",
        list: [
            { key: "all", label: "All", test: function () { return true; } },
            { key: "notes", label: "With notes", test: function (tr) { return tr.dataset.notes === "1"; } }] }
};
function initTableFilters() {
    Object.keys(TF_CFG).forEach(function (id) {
        const c = TF_CFG[id];
        c.active = "all";
        $(c.search).addEventListener("input", function () { tfRefresh(id); });
        tfRefresh(id);
    });
}
function tfRefresh(id) {
    const c = TF_CFG[id];
    if (!c) { return; }
    const rows = Array.prototype.slice.call($(c.tbody).rows);
    const term = ($(c.search).value || "").trim().toLowerCase();
    const current = c.list.filter(function (f) { return f.key === c.active; })[0] || c.list[0];
    let shown = 0;
    rows.forEach(function (tr) {
        const ok = current.test(tr) && (!term || tr.textContent.toLowerCase().indexOf(term) >= 0);
        tr.hidden = !ok;
        if (ok) { shown += 1; }
    });
    const host = $(c.filters);
    host.innerHTML = "";
    c.list.forEach(function (f) {
        const n = rows.filter(function (tr) { return f.test(tr); }).length;
        const b = document.createElement("button");
        b.type = "button"; b.textContent = f.label + " (" + n + ")";
        b.setAttribute("aria-pressed", String(f.key === current.key));
        b.addEventListener("click", function () { c.active = f.key; tfRefresh(id); });
        host.appendChild(b);
    });
    $(c.count).textContent = shown + " of " + rows.length + " shown";
}

// ---- Metric cards ----------------------------------------------------
function renderMetrics(hostId, items) {
    const host = $(hostId);
    host.innerHTML = "";
    items.forEach(function (it) {
        const d = document.createElement("div");
        d.className = "metric" + (it.tone ? " " + it.tone : "");
        const l = document.createElement("div"); l.className = "m-label"; l.textContent = it.label;
        const v = document.createElement("div"); v.className = "m-value"; v.textContent = it.value;
        d.appendChild(l); d.appendChild(v);
        if (it.sub) { const s2 = document.createElement("div"); s2.className = "m-sub"; s2.textContent = it.sub; d.appendChild(s2); }
        host.appendChild(d);
    });
}
function fmtNum(n) { return String(Math.round((Number(n) || 0) * 100) / 100); }
function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }

// ---- Charts (Chart.js; accessible via aria-label + hidden data table) -
function drawChart(key, canvasId, type, labels, values, colors, dataHostId, caption, valueHeader) {
    const canvas = $(canvasId);
    if (charts[key]) { charts[key].destroy(); charts[key] = null; }
    // Hidden data table for screen readers
    const host = $(dataHostId);
    host.innerHTML = "";
    const tbl = document.createElement("table");
    const cap2 = document.createElement("caption"); cap2.textContent = caption; tbl.appendChild(cap2);
    const hr = document.createElement("tr");
    ["Category", valueHeader].forEach(function (h) {
        const th = document.createElement("th"); th.scope = "col"; th.textContent = h; hr.appendChild(th);
    });
    const thead = document.createElement("thead"); thead.appendChild(hr); tbl.appendChild(thead);
    const tb = document.createElement("tbody");
    labels.forEach(function (lb, i) {
        const tr = document.createElement("tr");
        addCell(tr, lb); addCell(tr, fmtNum(values[i])); tb.appendChild(tr);
    });
    tbl.appendChild(tb); host.appendChild(tbl);
    canvas.setAttribute("aria-label", caption + ": " + labels.map(function (lb, i) { return lb + " " + fmtNum(values[i]); }).join(", "));
    if (typeof Chart === "undefined" || canvas.offsetParent === null) { return; }   // not visible yet
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isDonut = type === "doughnut";
    const options = {
        responsive: true, maintainAspectRatio: false,
        animation: reduce ? false : undefined,
        plugins: { legend: { display: isDonut, position: "bottom" } }
    };
    if (!isDonut) {
        options.scales = {
            y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: cssVar("--grid") } },
            x: { grid: { display: false } }
        };
    }
    Chart.defaults.color = cssVar("--muted");
    Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Source Sans Pro', 'Segoe UI', sans-serif";
    charts[key] = new Chart(canvas, {
        type: type,
        data: { labels: labels, datasets: [{ label: valueHeader, data: values, backgroundColor: colors, borderWidth: isDonut ? 2 : 0, borderColor: cssVar("--surface") }] },
        options: options
    });
}

function renderMemberDash() {
    if (!$("member-metrics") || !me) { return; }
    const rows = memberStats.rows || [];
    let total = 0, travel = 0, evHours = 0;
    rows.forEach(function (r) {
        total += Number(r.total_hours) || 0; travel += Number(r.travel_time) || 0; evHours += Number(r.hours) || 0;
    });
    const attended = Object.keys(attendanceMap).filter(function (k) { return attendanceMap[k]; }).length;
    const status = me.is_member ? me.membership_status : null;
    renderMetrics("member-metrics", [
        { label: "Membership", value: me.is_member ? cap(status) : "Not a member",
          sub: me.is_member ? (me.tier + " tier") : "Ask an administrator to add one",
          tone: status === "active" ? "ok" : (status === "lapsed" || status === "suspended") ? "warn" : "" },
        { label: hoursRange.kind === "all" ? "Total hours logged" : "Hours logged \u00b7 " + rangeLabel(hoursRange),
          value: fmtNum(total), sub: rows.length + (rows.length === 1 ? " entry" : " entries") },
        { label: "Events attended", value: String(attended) },
        { label: "Upcoming events", value: String(memberStats.upcoming || 0) }
    ]);
    // Chart 1: hours per event (chronological, latest 10)
    const byEvent = {};
    rows.forEach(function (r) {
        const nm = r.events ? r.events.name : "Event";
        byEvent[nm] = (byEvent[nm] || 0) + (Number(r.total_hours) || 0);
    });
    const names = Object.keys(byEvent).slice(0, 10);
    const empty1 = $("chart-my-hours-empty"), empty2 = $("chart-my-split-empty");
    empty1.hidden = names.length > 0; empty2.hidden = total > 0;
    $("chart-my-hours-box").hidden = names.length === 0;
    $("chart-my-split-box").hidden = !(total > 0);
    if (names.length) {
        drawChart("myHours", "chart-my-hours", "bar", names, names.map(function (n) { return byEvent[n]; }),
            VA.link, "chart-my-hours-data", "My volunteer hours by event", "Hours");
    }
    if (total > 0) {
        drawChart("mySplit", "chart-my-split", "doughnut", ["Event hours", "Travel hours"], [evHours, travel],
            [currentTheme() === "dark" ? "#8fc1ff" : VA.brand, VA.link], "chart-my-split-data", "Event hours versus travel hours", "Hours");
    }
}

function renderAdminDash() {
    if (!$("admin-metrics")) { return; }
    const people = allMembers.filter(function (m) { return !m.archived; });
    const members = people.filter(function (m) { return m.is_member; });
    const active = members.filter(function (m) { return m.membership_status === "active"; });
    const attention = members.filter(needsAttention);
    let hours = 0;
    if (summaryRows.length) { summaryRows.forEach(function (r) { hours += Number(r.total_hours) || 0; }); }
    else { people.forEach(function (m) { hours += Number(m.total_hours) || 0; }); }
    renderMetrics("admin-metrics", [
        { label: "People", value: String(people.length), sub: "Excludes archived" },
        { label: "Members", value: String(members.length), sub: active.length + " active", tone: "ok" },
        { label: "Needs attention", value: String(attention.length), sub: "Lapsed or suspended",
          tone: attention.length ? "warn" : "ok" },
        { label: "Volunteer hours", value: fmtNum(hours), sub: "All events" },
        { label: "Events", value: String(summaryRows.length) }
    ]);
    const counts = { active: 0, pending: 0, lapsed: 0, suspended: 0 };
    members.forEach(function (m) { if (counts[m.membership_status] !== undefined) { counts[m.membership_status] += 1; } });
    const labels = ["Active", "Pending", "Lapsed", "Suspended", "Non-member"];
    const vals = [counts.active, counts.pending, counts.lapsed, counts.suspended, people.length - members.length];
    drawChart("status", "chart-status", "doughnut", labels, vals,
        [VA.ok, VA.unknown, VA.warn, VA.bad, VA.link], "chart-status-data", "People by membership status", "People");
    const evs = summaryRows.slice().sort(function (a, b) { return new Date(a.start_at) - new Date(b.start_at); }).slice(-10);
    $("chart-event-hours-empty").hidden = evs.length > 0;
    $("chart-event-hours").parentNode.hidden = evs.length === 0;
    if (evs.length) {
        drawChart("eventHours", "chart-event-hours", "bar", evs.map(function (r) { return r.event_name; }),
            evs.map(function (r) { return Number(r.total_hours) || 0; }), VA.link,
            "chart-event-hours-data", "Volunteer hours by event", "Hours");
    }
}

// ---- Wire up -------------------------------------------------------
// =====================================================================
// HOURS PERIODS, MILESTONES, PRINTABLE SUMMARY
// =====================================================================
const hoursRange = { kind: "all", year: null, from: "", to: "" };
const MILESTONES = [10, 25, 50, 100, 250, 500, 1000, 2500];

// "YYYY-MM-DD" for an instant, as a calendar date in the event time zone.
function dateKey(iso) {
    const v = toLocalInput(iso);
    return v ? v.slice(0, 10) : "";
}
function fmtDate(iso) {
    if (!iso) { return ""; }
    const d = new Date(iso);
    if (isNaN(d.getTime())) { return ""; }
    return d.toLocaleDateString(undefined, { timeZone: EVENT_TZ, month: "short", day: "numeric", year: "numeric" });
}
function fmtDayKey(key) {          // "2026-03-01" -> "Mar 1, 2026" (no time-zone shifting)
    if (!key) { return ""; }
    const p = key.split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)).toLocaleDateString(undefined,
        { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}
function rowDateKey(r) {
    return dateKey((r.events && r.events.start_at) || r.logged_at);
}
function yearsOf(rows) {
    const set = {};
    set[String(tzParts(Date.now()).y)] = true;
    rows.forEach(function (r) { const k = rowDateKey(r); if (k) { set[k.slice(0, 4)] = true; } });
    return Object.keys(set).sort().reverse();
}
// Fills a period <select>: All time, each year, and optionally "Custom range...".
function fillRangeOptions(select, years, withCustom, state) {
    if (!select) { return; }
    const current = select.value;
    select.innerHTML = "";
    const add = function (value, text) {
        const o = document.createElement("option"); o.value = value; o.textContent = text; select.appendChild(o);
    };
    add("all", "All time");
    years.forEach(function (y) { add("y:" + y, y); });
    if (withCustom) { add("custom", "Custom range…"); }
    const wanted = state ? rangeToValue(state) : current;
    select.value = Array.prototype.some.call(select.options, function (o) { return o.value === wanted; }) ? wanted : "all";
}
function rangeToValue(r) {
    return r.kind === "year" ? "y:" + r.year : r.kind;
}
function rangeFromSelect(value, from, to) {
    if (value && value.indexOf("y:") === 0) { return { kind: "year", year: value.slice(2), from: "", to: "" }; }
    if (value === "custom") { return { kind: "custom", year: null, from: from || "", to: to || "" }; }
    return { kind: "all", year: null, from: "", to: "" };
}
function rowsInRange(rows, range) {
    if (range.kind === "all") { return rows.slice(); }
    return rows.filter(function (r) {
        const k = rowDateKey(r);
        if (!k) { return false; }
        if (range.kind === "year") { return k.slice(0, 4) === range.year; }
        if (range.from && k < range.from) { return false; }
        if (range.to && k > range.to) { return false; }
        return true;
    });
}
function rangeLabel(range) {
    if (range.kind === "year") { return range.year; }
    if (range.kind === "custom") {
        if (range.from && range.to) { return fmtDayKey(range.from) + " – " + fmtDayKey(range.to); }
        if (range.from) { return "From " + fmtDayKey(range.from); }
        if (range.to) { return "Through " + fmtDayKey(range.to); }
    }
    return "All time";
}
function sortByEventDate(rows, newestFirst) {
    return rows.slice().sort(function (a, b) {
        const ka = rowDateKey(a), kb = rowDateKey(b);
        return newestFirst ? (kb < ka ? -1 : kb > ka ? 1 : 0) : (ka < kb ? -1 : ka > kb ? 1 : 0);
    });
}
function onHoursRangeChange() {
    const sel = $("hours-range");
    $("custom-range").hidden = sel.value !== "custom";
    if (sel.value === "custom" && !$("range-from").value && !$("range-to").value) {
        // Sensible default for a custom range: Jan 1 of this year through today.
        const today = dateKey(new Date().toISOString());
        $("range-from").value = today.slice(0, 4) + "-01-01";
        $("range-to").value = today;
    }
    const r = rangeFromSelect(sel.value, $("range-from").value, $("range-to").value);
    hoursRange.kind = r.kind; hoursRange.year = r.year; hoursRange.from = r.from; hoursRange.to = r.to;
    renderHoursView();
}

// ---- Milestones (all-time total hours, including travel) ------------
function renderMilestones() {
    const host = $("milestone-body");
    if (!host) { return; }
    let total = 0;
    (memberStats.allRows || []).forEach(function (r) { total += Number(r.total_hours) || 0; });
    total = Math.round(total * 100) / 100;
    host.innerHTML = "";
    const earned = MILESTONES.filter(function (m) { return total >= m; });
    const next = MILESTONES.filter(function (m) { return total < m; })[0];
    const badges = document.createElement("div"); badges.className = "badges";
    MILESTONES.forEach(function (m) {
        const b = document.createElement("span");
        const got = total >= m;
        b.className = "milestone" + (got ? " earned" : "");
        b.textContent = (got ? "★ " : "") + m + " hrs";
        b.setAttribute("aria-label", m + " hours milestone, " + (got ? "earned" : "not yet earned"));
        badges.appendChild(b);
    });
    host.appendChild(badges);
    const p = document.createElement("p"); p.className = "milestone-next";
    if (total === 0) {
        p.textContent = "Log your first volunteer hours to start earning milestones.";
        host.appendChild(p);
    } else if (!next) {
        p.textContent = "You've reached every milestone — " + fmtNum(total) + " hours. Thank you!";
        host.appendChild(p);
    } else {
        const prev = earned.length ? earned[earned.length - 1] : 0;
        p.textContent = fmtNum(total) + " hours so far · " + fmtNum(next - total) + " to go until " + next + " hours";
        host.appendChild(p);
        const bar = document.createElement("progress");
        bar.className = "milestone-bar";
        bar.max = next - prev; bar.value = total - prev;
        bar.setAttribute("aria-label", "Progress toward the " + next + " hour milestone");
        host.appendChild(bar);
    }
}

// ---- Printing (hours summary or QR code) -----------------------------
// Puts content into #print-area, prints only that, then cleans up.
function printContent(html, kind) {
    const area = $("print-area");
    area.innerHTML = html;
    area.className = "print-" + kind;
    document.body.classList.add("printing");
    let cleaned = false;
    const cleanup = function () {
        if (cleaned) { return; }
        cleaned = true;
        document.body.classList.remove("printing");
        area.innerHTML = ""; area.className = "";
        window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    // Let images (logo) load before opening the print dialog.
    const imgs = Array.prototype.slice.call(area.querySelectorAll("img"));
    Promise.all(imgs.map(function (img) {
        return img.complete ? null : new Promise(function (res) { img.onload = img.onerror = res; setTimeout(res, 1500); });
    })).then(function () {
        window.print();
        setTimeout(cleanup, 1000);   // some mobile browsers never fire afterprint
    });
}
function orgHeaderHtml() {
    if (typeof ORG === "undefined") { return ""; }
    const lines = [ORG.address, ORG.phone, ORG.email, ORG.website].filter(Boolean).map(escapeHtml);
    return "<div class='doc-org'>"
        + (ORG.logo_url ? "<img class='doc-logo' src='" + escapeHtml(ORG.logo_url) + "' alt=''>" : "")
        + "<div><div class='doc-org-name'>" + escapeHtml(ORG.name || "") + "</div>"
        + (lines.length ? "<div class='doc-org-lines'>" + lines.join(" · ") + "</div>" : "")
        + "</div></div>";
}
function printHoursSummary(person, rows, range) {
    const list = sortByEventDate(rowsInRange(rows, range), false);
    let ev = 0, tr = 0, tot = 0;
    const body = list.map(function (r) {
        ev += Number(r.hours) || 0; tr += Number(r.travel_time) || 0; tot += Number(r.total_hours) || 0;
        const e = r.events || {};
        return "<tr><td>" + escapeHtml(fmtDate(e.start_at)) + "</td><td>" + escapeHtml(e.name || "")
            + "</td><td>" + escapeHtml(e.location || "") + "</td><td class='num'>" + fmtNum(r.hours)
            + "</td><td class='num'>" + fmtNum(r.travel_time) + "</td><td class='num'>" + fmtNum(r.total_hours) + "</td></tr>";
    }).join("");
    const name = person.full_name || [person.first_name, person.last_name].filter(Boolean).join(" ") || person.email;
    const generated = new Date().toLocaleDateString(undefined, { timeZone: EVENT_TZ, month: "long", day: "numeric", year: "numeric" });
    const html = "<div class='doc'>" + orgHeaderHtml()
        + "<h1>Volunteer Hours Summary</h1>"
        + "<table class='doc-facts'><tbody>"
        + "<tr><th>Name</th><td>" + escapeHtml(name) + "</td></tr>"
        + "<tr><th>Email</th><td>" + escapeHtml(person.email || "") + "</td></tr>"
        + "<tr><th>Period</th><td>" + escapeHtml(rangeLabel(range)) + "</td></tr>"
        + "<tr><th>Total hours</th><td><strong>" + fmtNum(tot) + "</strong> (" + fmtNum(ev) + " event + " + fmtNum(tr) + " travel)</td></tr>"
        + "</tbody></table>"
        + (list.length
            ? "<table class='doc-table'><thead><tr><th>Date</th><th>Event</th><th>Location</th><th class='num'>Event hrs</th><th class='num'>Travel</th><th class='num'>Total</th></tr></thead><tbody>"
              + body + "</tbody><tfoot><tr><th colspan='3'>Total (" + list.length + (list.length === 1 ? " event" : " events") + ")</th><th class='num'>"
              + fmtNum(ev) + "</th><th class='num'>" + fmtNum(tr) + "</th><th class='num'>" + fmtNum(tot) + "</th></tr></tfoot></table>"
            : "<p>No volunteer hours were recorded for this period.</p>")
        + "<div class='doc-sign'><div><span></span>Verified by (name and title)</div><div><span></span>Signature</div><div><span></span>Date</div></div>"
        + "<p class='doc-foot'>Generated " + escapeHtml(generated) + " from the "
        + escapeHtml((typeof ORG !== "undefined" && ORG.name) ? ORG.name + " " : "")
        + "membership portal. Dates are in " + escapeHtml(EVENT_TZ.replace(/_/g, " ")) + " time.</p></div>";
    printContent(html, "doc");
}
function onPrintMyHours() {
    if (!me) { return; }
    printHoursSummary(me, memberStats.allRows || [], hoursRange);
}
async function onPrintPersonHours() {
    const person = allMembers.filter(function (m) { return m.id === selectedMemberId; })[0];
    if (!person) { return; }
    const button = $("e_print_hours");
    const done = setBusy(button, "Preparing…");
    try {
        const rows = await getMemberVolunteerHours(person.id);
        done();
        printHoursSummary(person, rows, rangeFromSelect($("e_print_range").value));
    } catch (err) { done(); setStatus("e_print_status", err.message, true); }
}

// =====================================================================
// EVENT CHECK-IN BY QR CODE
// =====================================================================
const CHECKIN_KEY = "mmp.checkin";
const CHECKIN_OPENS_HOURS_BEFORE = 2;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkinUrl(eventId) {
    return location.origin + location.pathname + "?checkin=" + encodeURIComponent(eventId);
}
function qrSvg(text) {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 8, margin: 4, scalable: true });
}
function qrCardHtml(ev) {
    const url = checkinUrl(ev.id);
    return "<div class='qr-event'>" + escapeHtml(ev.name) + "</div>"
        + "<div class='qr-when'>" + escapeHtml(fmtDT(ev.start_at)) + (ev.location ? " · " + escapeHtml(ev.location) : "") + "</div>"
        + "<div class='qr-img' role='img' aria-label='QR code to check in to " + escapeHtml(ev.name) + "'>" + qrSvg(url) + "</div>"
        + "<div class='qr-cta'>Scan with your phone camera to check in</div>"
        + "<div class='qr-url'>" + escapeHtml(url) + "</div>";
}
function selectedAdminEvent() {
    return eventsCache.filter(function (e) { return e.id === selectedEventId; })[0];
}
function onShowQr() {
    const ev = selectedAdminEvent();
    if (!ev) { return; }
    $("qr-card").innerHTML = qrCardHtml(ev);
    setStatus("qr-status", "", false);
    show("qr-panel");
    $("qr-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}
function onPrintQr() {
    const ev = selectedAdminEvent();
    if (!ev) { return; }
    printContent("<div class='qr-print-card'>" + orgHeaderHtml() + qrCardHtml(ev) + "</div>", "qr");
}
async function onCopyQrLink() {
    const ev = selectedAdminEvent();
    if (!ev) { return; }
    try { await navigator.clipboard.writeText(checkinUrl(ev.id)); setStatus("qr-status", "Check-in link copied.", false); }
    catch (err) { setStatus("qr-status", "Couldn't copy automatically. Link: " + checkinUrl(ev.id), true); }
}

// On page load: remember a ?checkin=<event id> from a scanned QR code, then
// tidy the address bar so a refresh doesn't repeat it.
function captureCheckinParam() {
    let id = null;
    try { id = new URLSearchParams(location.search).get("checkin"); } catch (e) { id = null; }
    if (!id) { return; }
    if (UUID_RE.test(id)) { try { sessionStorage.setItem(CHECKIN_KEY, id); } catch (e) { /* ignore */ } }
    try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) { /* ignore */ }
    if (loadSession() === null) {
        setInfo("login-status", "Sign in to finish checking in to your event.");
    }
}
function showCheckinBanner(state, message, actions) {
    const banner = $("checkin-banner");
    banner.className = "checkin-banner " + state;
    $("checkin-text").textContent = message;
    const host = $("checkin-actions"); host.innerHTML = "";
    (actions || []).concat([{ label: "Dismiss", secondary: true, run: function () { banner.hidden = true; } }])
        .forEach(function (a) {
            const b = document.createElement("button");
            b.type = "button"; b.textContent = a.label;
            b.className = a.secondary ? "secondary small" : "small";
            b.addEventListener("click", a.run);
            host.appendChild(b);
        });
    banner.hidden = false;
    banner.scrollIntoView({ behavior: "smooth", block: "start" });
}
function endOfEventDayMs(ev) {
    const key = dateKey(ev.end_at || ev.start_at);
    const iso = fromLocalInput(key + "T23:59");
    return iso ? new Date(iso).getTime() + 59999 : 0;
}
async function processPendingCheckin() {
    let id = null;
    try { id = sessionStorage.getItem(CHECKIN_KEY); } catch (e) { id = null; }
    if (!id || !me) { return; }
    const clear = function () { try { sessionStorage.removeItem(CHECKIN_KEY); } catch (e) { /* ignore */ } };
    const ev = memberEvents.filter(function (e) { return e.id === id; })[0];
    if (!ev) { clear(); showCheckinBanner("error", "We couldn't find the event from that QR code. Ask the organizer for help."); return; }
    const now = Date.now();
    const opens = new Date(ev.start_at).getTime() - CHECKIN_OPENS_HOURS_BEFORE * 3600 * 1000;
    if (now < opens) {
        clear();
        showCheckinBanner("info", "Check-in for " + ev.name + " opens " + fmtDT(new Date(opens).toISOString())
            + ". Scan the code again then. You can RSVP below in the meantime.");
        return;
    }
    if (now > endOfEventDayMs(ev)) {
        clear();
        showCheckinBanner("info", ev.name + " has ended, so QR check-in is closed. You can still mark attendance under Past events.");
        return;
    }
    if (!profileComplete(me)) {   // keep it pending; finishes automatically after Save profile
        showCheckinBanner("warn", "Almost there: add your first name, last name, and phone in My profile below, then Save, to finish checking in to " + ev.name + ".");
        return;
    }
    clear();
    const logHours = {
        label: "Log hours for this event",
        run: function () {
            $("event-select").value = ev.id;
            $("sec-log").scrollIntoView({ behavior: "smooth", block: "start" });
            setTimeout(function () { $("hours-input").focus(); }, 400);
        }
    };
    if (attendanceMap[ev.id]) {
        showCheckinBanner("ok", "You're already checked in to " + ev.name + ".", [logHours]);
        return;
    }
    try {
        await setMyAttendance(ev.id, true);
        attendanceMap[ev.id] = true;
        await loadMemberEvents();
        showCheckinBanner("ok", "✓ You're checked in to " + ev.name + ". Thanks for coming!", [logHours]);
    } catch (err) {
        showCheckinBanner("error", "Couldn't check you in: " + err.message);
    }
}

// =====================================================================
// INSTALL AS AN APP (home screen)
// =====================================================================
let installPrompt = null;
function initInstall() {
    if ("serviceWorker" in navigator && (location.protocol === "https:"
            || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
        navigator.serviceWorker.register("sw.js").catch(function () { /* optional */ });
    }
    const ua = navigator.userAgent || "";
    const isIos = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/.test(ua);
    const standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
        || window.navigator.standalone === true;
    if (standalone) {
        hide("install-ios"); hide("install-android"); show("install-done");
    } else if (isIos) { hide("install-android"); }
    else if (isAndroid) { hide("install-ios"); }
    window.addEventListener("beforeinstallprompt", function (e) {
        e.preventDefault();
        installPrompt = e;
        show("install-btn");
    });
    $("install-btn").addEventListener("click", async function () {
        if (!installPrompt) { return; }
        installPrompt.prompt();
        try { await installPrompt.userChoice; } catch (e) { /* ignore */ }
        installPrompt = null;
        hide("install-btn");
    });
    window.addEventListener("appinstalled", function () { hide("install-btn"); });
}

// =====================================================================
// ADMIN: CHANGE HISTORY
// =====================================================================
const AUDIT_PAGE = 100;
let auditOffset = 0;
let auditBusy = false;
const AUDIT_FIELDS = {
    first_name: "First name", last_name: "Last name", email: "Email", phone: "Phone",
    is_member: "Is member", membership_status: "Membership status", membership_type: "Membership type",
    next_renewal_date: "Next renewal date", tier: "Tier", date_shirt_sent: "Date shirt sent",
    address_line1: "Address line 1", address_line2: "Address line 2", city: "City", state: "State",
    postal_code: "Postal code", shirt_size: "Shirt size", is_admin: "Admin", archived: "Archived",
    auth_user_id: "Sign-in account", name: "Name", description: "Description", start_at: "Start",
    end_at: "End", location: "Location", hours: "Event hours", travel_time: "Travel hours", notes: "Notes"
};
const AUDIT_HIDDEN = ["member_id", "event_id", "created_by"];
const AUDIT_NOUN = { members: "person", events: "event", volunteer_hours: "hours" };

function auditValue(field, v) {
    if (v === null || v === undefined || v === "") { return "—"; }
    if (field === "auth_user_id") { return "linked"; }
    if (typeof v === "boolean") { return v ? "Yes" : "No"; }
    if (field === "start_at" || field === "end_at") { return fmtDT(v); }
    const text = String(v);
    return text.length > 80 ? text.slice(0, 77) + "…" : text;
}
function auditWhat(row) {
    const noun = AUDIT_NOUN[row.table_name] || row.table_name;
    if (row.table_name === "volunteer_hours") {
        return { insert: "Logged hours", update: "Changed hours", delete: "Removed hours" }[row.action];
    }
    return { insert: "Created ", update: "Updated ", delete: "Deleted " }[row.action] + noun;
}
function renderAuditRow(row) {
    const tr = document.createElement("tr");
    const changes = row.changes || {};
    const fields = Object.keys(changes).filter(function (f) { return AUDIT_HIDDEN.indexOf(f) < 0; });
    const important = row.action === "delete" || "is_admin" in changes || "archived" in changes
        || (row.table_name === "members" && "membership_status" in changes && row.action === "update");
    tr.dataset.table = row.table_name;
    tr.dataset.important = important ? "1" : "0";
    if (important) { tr.className = "flag"; }
    addCell(tr, fmtDT(row.at));
    addCell(tr, row.actor_label || "System");
    addCell(tr, auditWhat(row));
    addCell(tr, row.record_label || "");
    ["When", "Changed by", "What", "Record"].forEach(function (l, i) { tr.cells[i].dataset.label = l; });
    const td = document.createElement("td"); td.className = "audit-details"; td.dataset.label = "Details";
    fields.forEach(function (f) {
        const c = changes[f] || {};
        const line = document.createElement("div");
        const label = document.createElement("strong"); label.textContent = (AUDIT_FIELDS[f] || f) + ": ";
        line.appendChild(label);
        let text;
        if (row.action === "update") { text = auditValue(f, c.old) + " → " + auditValue(f, c.new); }
        else if (row.action === "insert") { text = auditValue(f, c.new); }
        else { text = auditValue(f, c.old); }
        line.appendChild(document.createTextNode(text));
        td.appendChild(line);
    });
    if (!fields.length) { td.textContent = "—"; }
    tr.appendChild(td);
    return tr;
}
async function loadAudit(reset) {
    if (auditBusy) { return; }
    auditBusy = true;
    if (reset) { auditOffset = 0; $("audit-body").innerHTML = ""; }
    setInfo("audit-status", "Loading…");
    try {
        const rows = await adminFetchAudit(auditOffset, AUDIT_PAGE);
        const tbody = $("audit-body");
        rows.forEach(function (r) { tbody.appendChild(renderAuditRow(r)); });
        auditOffset += rows.length;
        $("audit-more").hidden = rows.length < AUDIT_PAGE;
        setStatus("audit-status", "", false);
        $("audit-status").className = "status";
        if (!auditOffset) { setInfo("audit-status", "No changes recorded yet."); }
        tfRefresh("audit");
    } catch (err) {
        const missing = /audit_log/.test(err.message) && /(does not exist|schema cache|not find)/i.test(err.message);
        setStatus("audit-status", missing
            ? "Change history isn't set up in the database yet. Run supabase/migrations/2026-11-change-history.sql in the Supabase SQL Editor."
            : err.message, true);
    } finally { auditBusy = false; }
}

// Shows a plain-English message on the sign-in screen when setup files are
// missing or broken, instead of a confusing JavaScript error later on.
function checkStartupConfig() {
    let problem = "";
    if (typeof CONFIG === "undefined") {
        problem = "Setup problem: config.js didn't load or has a typo (often a missing comma or quote "
            + "after editing it). Open the browser console (F12) to see the line number.";
    } else if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_PUBLISHABLE_KEY) {
        problem = "Setup problem: the Supabase URL or publishable key is missing. On GitHub Pages, check "
            + "the SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY repository secrets and that the latest "
            + "Actions deploy succeeded. For local testing, create public/env.js from env.example.js.";
    }
    if (problem) { setStatus("login-status", problem, true); }
    return problem === "";
}
window.addEventListener("DOMContentLoaded", function () {
    if (!checkStartupConfig()) {
        const btn = document.querySelector("#request-code-form button[type=submit]");
        if (btn) { btn.disabled = true; }
    }
    initOrg();
    document.querySelectorAll(".tz-note").forEach(function (el) {
        el.textContent = "Start and end times are in " + EVENT_TZ.replace(/_/g, " ")
            + " time (set by ORG.timezone in config.js).";
    });
    initTabs();
    initThemeToggle();
    initTableFilters();
    $("request-code-form").addEventListener("submit", onRequestCode);
    $("verify-code-form").addEventListener("submit", onVerifyCode);
    $("logout-btn").addEventListener("click", onLogout);
    $("tab-member").addEventListener("click", showMemberView);
    $("tab-admin").addEventListener("click", showAdminView);

    // Member view
    $("profile-form").addEventListener("submit", onSaveProfile);
    $("profile-toggle").addEventListener("click", function () {
        const form = $("profile-form");
        form.hidden = !form.hidden;
        $("profile-toggle").textContent = form.hidden ? "View profile" : "Hide profile";
    });
    $("hours-form").addEventListener("submit", onLogHours);
    $("hours-input").addEventListener("input", updateTotalPreview);
    $("travel-input").addEventListener("input", updateTotalPreview);
    $("f_phone").addEventListener("input", onPhoneInput);

    // Admin: people
    $("edit-form").addEventListener("submit", onSaveMember);
    $("archive-btn").addEventListener("click", onArchiveToggle);
    $("archive-confirm-btn").addEventListener("click", function () { doArchive(true); });
    $("archive-cancel-btn").addEventListener("click", onArchiveCancel);
    $("show-archived").addEventListener("change", function (e) {
        showArchived = e.target.checked; pageIndex = 0; applyView();
    });
    $("merge-search").addEventListener("input", onMergeSearch);
    $("merge-confirm-btn").addEventListener("click", onMergeConfirm);
    $("merge-cancel-btn").addEventListener("click", onMergeCancel);
    $("create-member-form").addEventListener("submit", onCreateMember);
    $("new-member-btn").addEventListener("click", toggleCreateMember);
    $("c_phone").addEventListener("input", onPhoneInput);
    $("e_phone").addEventListener("input", onPhoneInput);
    $("c_type").addEventListener("change", function () { syncRenewal("c_type", "c_renewal"); });
    $("e_type").addEventListener("change", function () { syncRenewal("e_type", "e_renewal"); });
    $("c_tier").addEventListener("change", function () { syncShirtDate("c_tier", "c_shirt_sent"); });
    $("e_tier").addEventListener("change", function () { syncShirtDate("e_tier", "e_shirt_sent"); });
    $("member-search").addEventListener("input", onSearch);
    $("import-file").addEventListener("change", onImportFile);
    $("download-template").addEventListener("click", downloadTemplate);
    const heads = document.querySelectorAll("#members-head th.sortable");
    for (let i = 0; i < heads.length; i += 1) { heads[i].addEventListener("click", onSortHeader); }

    // Admin: events / hours
    $("create-event-form").addEventListener("submit", onCreateEvent);
    $("edit-event-form").addEventListener("submit", onSaveEvent);
    $("cancel-edit-event").addEventListener("click", onCancelEditEvent);
    $("delete-event-btn").addEventListener("click", onDeleteEventClick);
    $("delete-event-confirm-btn").addEventListener("click", onDeleteEventConfirm);
    $("delete-event-cancel-btn").addEventListener("click", onDeleteEventCancel);
    $("log-form").addEventListener("submit", onLogForMember);
    $("log-hours-input").addEventListener("input", updateLogTotalPreview);
    $("log-travel-input").addEventListener("input", updateLogTotalPreview);
    $("bulk-search").addEventListener("input", onBulkSearch);
    $("bulk-form").addEventListener("submit", onBulkSubmit);
    $("manage-form").addEventListener("submit", onLoadEntries);
    $("prev-page").addEventListener("click", onPrevPage);
    $("next-page").addEventListener("click", onNextPage);
    $("export-members").addEventListener("click", onExportMembers);
    $("export-hours").addEventListener("click", onExportHours);

    $("remember-me").checked = rememberDevice();
    initInstall();
    captureCheckinParam();
    $("hours-range").addEventListener("change", onHoursRangeChange);
    $("range-from").addEventListener("change", onHoursRangeChange);
    $("range-to").addEventListener("change", onHoursRangeChange);
    $("print-hours").addEventListener("click", onPrintMyHours);
    $("e_print_hours").addEventListener("click", onPrintPersonHours);
    $("qr-btn").addEventListener("click", onShowQr);
    $("qr-print").addEventListener("click", onPrintQr);
    $("qr-copy").addEventListener("click", onCopyQrLink);
    $("qr-close").addEventListener("click", function () { hide("qr-panel"); });
    $("audit-more").addEventListener("click", function () { loadAudit(false); });
    fillRangeOptions($("hours-range"), yearsOf([]), true, hoursRange);
    try {
        const notice = sessionStorage.getItem("mmp.notice");
        if (notice) { sessionStorage.removeItem("mmp.notice"); setStatus("login-status", notice, true); }
    } catch (e) { /* ignore */ }
    if (loadSession() !== null && typeof CONFIG !== "undefined") { enterApp(); }
});
