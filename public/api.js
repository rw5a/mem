// api.js - Minimal Supabase client built on the browser Fetch API only.
"use strict";

// If config.js failed to load or has a typo, CONFIG won't exist. Guard here so
// that problem is reported clearly (see checkStartupConfig in app.js) instead of
// surfacing later as "Cannot access 'AUTH_BASE' before initialization".
const SUPABASE_BASE = (typeof CONFIG !== "undefined" && CONFIG.SUPABASE_URL) ? CONFIG.SUPABASE_URL : "";
const AUTH_BASE   = SUPABASE_BASE + "/auth/v1";
const REST_BASE   = SUPABASE_BASE + "/rest/v1";
const SESSION_KEY  = "mmp.session";
const REMEMBER_KEY = "mmp.remember";     // "1" = keep signed in on this device

// ---- Where the sign-in is stored ------------------------------------
// "Keep me signed in" -> localStorage (survives closing the tab/browser).
// Otherwise          -> sessionStorage (cleared when the tab closes).
function rememberDevice() {
    try { return localStorage.getItem(REMEMBER_KEY) === "1"; } catch (err) { return false; }
}
function setRememberDevice(on) {
    try {
        if (on) { localStorage.setItem(REMEMBER_KEY, "1"); }
        else { localStorage.removeItem(REMEMBER_KEY); }
    } catch (err) { /* storage blocked; falls back to tab-only */ }
}
function sessionStore() {
    try { return rememberDevice() ? localStorage : sessionStorage; } catch (err) { return sessionStorage; }
}
function saveSession(session) {
    if (session && !session.expires_at && session.expires_in) {
        session.expires_at = Math.floor(Date.now() / 1000) + Number(session.expires_in);
    }
    clearSession();
    sessionStore().setItem(SESSION_KEY, JSON.stringify(session));
}
function loadSession() {
    let raw = null;
    try { raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY); }
    catch (err) { raw = null; }
    if (!raw) { return null; }
    try { return JSON.parse(raw); } catch (err) { return null; }
}
function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (err) { /* ignore */ }
    try { localStorage.removeItem(SESSION_KEY); } catch (err) { /* ignore */ }
}

// ---- Automatic sign-in renewal ---------------------------------------
// Supabase access tokens expire after about an hour. Before each signed-in
// request we renew the token if it's about to expire, and if a request is
// still rejected as expired we renew once and retry. Only one renewal runs
// at a time (refresh tokens are single-use).
const REFRESH_MARGIN_SECONDS = 90;
let refreshInFlight = null;

function tokenExpiringSoon(session) {
    if (!session || !session.expires_at) { return false; }
    return session.expires_at - Math.floor(Date.now() / 1000) < REFRESH_MARGIN_SECONDS;
}
function refreshSession() {
    if (refreshInFlight) { return refreshInFlight; }
    refreshInFlight = (async function () {
        const session = loadSession();
        if (!session || !session.refresh_token) { throw sessionEndedError(); }
        const response = await fetch(AUTH_BASE + "/token?grant_type=refresh_token", {
            method: "POST", headers: anonHeaders(),
            body: JSON.stringify({ refresh_token: session.refresh_token })
        });
        const text = await response.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch (err) { body = null; }
        if (!response.ok) {
            // 400/401 = the refresh token is no longer valid -> truly signed out.
            // Anything else (offline, server hiccup) -> keep the session and let the user retry.
            if (response.status === 400 || response.status === 401) {
                clearSession();
                throw sessionEndedError();
            }
            throw new Error((body && (body.msg || body.error_description)) || "Couldn't reach the server. Please try again.");
        }
        saveSession(body);
        return body;
    })();
    refreshInFlight.finally(function () { refreshInFlight = null; }).catch(function () {});
    return refreshInFlight;
}
function sessionEndedError() {
    const err = new Error("Your sign-in has ended. Please sign in again.");
    err.sessionEnded = true;
    try { window.dispatchEvent(new CustomEvent("mmp:session-ended")); } catch (e) { /* ignore */ }
    return err;
}
function hasBearer(options) {
    return !!(options && options.headers && options.headers["Authorization"]);
}
function looksExpired(status, body) {
    if (status !== 401 && status !== 403) { return false; }
    const msg = String((body && (body.message || body.msg || body.code)) || "").toLowerCase();
    return status === 401 || msg.indexOf("jwt") >= 0 || msg.indexOf("expired") >= 0;
}

async function apiFetch(url, options) {
    const result = await apiFetchFull(url, options);
    return result.body;
}
async function apiFetchFull(url, options) {
    if (hasBearer(options) && tokenExpiringSoon(loadSession())) {
        const fresh = await refreshSession();
        options.headers["Authorization"] = "Bearer " + fresh.access_token;
    }
    let response = await fetch(url, options);
    let text = await response.text();
    let body = null;
    if (text.length > 0) {
        try { body = JSON.parse(text); } catch (err) { body = text; }
    }
    if (!response.ok && hasBearer(options) && looksExpired(response.status, body)) {
        const fresh = await refreshSession();
        options.headers["Authorization"] = "Bearer " + fresh.access_token;
        response = await fetch(url, options);
        text = await response.text();
        body = null;
        if (text.length > 0) {
            try { body = JSON.parse(text); } catch (err) { body = text; }
        }
    }
    if (!response.ok) {
        const message = (body && (body.msg || body.message || body.error_description))
            || response.statusText;
        const err = new Error(message);
        err.status = response.status;
        throw err;
    }
    return { body: body, headers: response.headers };
}
function anonHeaders() {
    return { "Content-Type": "application/json", "apikey": (typeof CONFIG !== "undefined" ? CONFIG.SUPABASE_PUBLISHABLE_KEY : "") };
}
function authHeaders() {
    const session = loadSession();
    const headers = anonHeaders();
    if (session && session.access_token) {
        headers["Authorization"] = "Bearer " + session.access_token;
    }
    return headers;
}

async function requestLoginCode(email) {
    if (!email || email.indexOf("@") < 1) { throw new Error("A valid email address is required"); }
    return apiFetch(AUTH_BASE + "/otp", {
        method: "POST", headers: anonHeaders(),
        body: JSON.stringify({ email: email, create_user: true })
    });
}
async function verifyLoginCode(email, code) {
    if (!email || !code) { throw new Error("Email and code are required"); }
    const session = await apiFetch(AUTH_BASE + "/verify", {
        method: "POST", headers: anonHeaders(),
        body: JSON.stringify({ email: email, token: code, type: "email" })
    });
    saveSession(session);
    return session;
}
// Signs out: tells Supabase to revoke the refresh token (best-effort, so a
// remembered device can't be reused), then clears the local copy.
async function logout() {
    const session = loadSession();
    if (session && session.access_token) {
        try {
            await fetch(AUTH_BASE + "/logout", {
                method: "POST",
                headers: Object.assign(anonHeaders(), { "Authorization": "Bearer " + session.access_token })
            });
        } catch (err) { /* offline: still clear locally */ }
    }
    clearSession();
}
function sessionEmail() {
    const s = loadSession();
    return s && s.user ? s.user.email : "";
}

// Returns the person row for the current login. A row is auto-created at
// signup, so this normally exists; returns null only in the brief window
// right after first signup before the row is visible.
async function getMyProfile() {
    const session = loadSession();
    if (!session) { throw new Error("Not signed in"); }
    const rows = await apiFetch(
        REST_BASE + "/members?select=*&auth_user_id=eq." + encodeURIComponent(session.user.id),
        { method: "GET", headers: authHeaders() });
    if (!Array.isArray(rows) || rows.length === 0) { return null; }
    return rows[0];
}
async function updateMyProfile(profile) {
    return apiFetch(REST_BASE + "/rpc/update_my_profile", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({
            p_first_name: profile.first_name || null,
            p_last_name: profile.last_name || null,
            p_phone: profile.phone || null,
            p_address_line1: profile.address_line1 || null,
            p_address_line2: profile.address_line2 || null,
            p_city: profile.city || null,
            p_state: profile.state || null,
            p_postal_code: profile.postal_code || null,
            p_shirt_size: profile.shirt_size || null
        })
    });
}
async function listEvents() {
    return apiFetch(REST_BASE + "/events?select=*&order=start_at.asc",
        { method: "GET", headers: authHeaders() });
}
async function getMemberAttendance(memberId) {
    return apiFetch(REST_BASE + "/event_attendance?select=event_id,attended&member_id=eq."
        + encodeURIComponent(memberId), { method: "GET", headers: authHeaders() });
}
async function setMyAttendance(eventId, attended) {
    return apiFetch(REST_BASE + "/rpc/set_my_attendance", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ p_event_id: eventId, p_attended: !!attended })
    });
}
async function getMemberRsvp(memberId) {
    return apiFetch(REST_BASE + "/event_rsvp?select=event_id,rsvp&member_id=eq."
        + encodeURIComponent(memberId), { method: "GET", headers: authHeaders() });
}
async function setMyRsvp(eventId, rsvp) {
    return apiFetch(REST_BASE + "/rpc/set_my_rsvp", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ p_event_id: eventId, p_rsvp: !!rsvp })
    });
}
async function logVolunteerHours(eventId, hours, travel, notes) {
    return apiFetch(REST_BASE + "/rpc/log_volunteer_hours", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ p_event_id: eventId, p_hours: hours,
            p_travel: travel || 0, p_notes: notes || null })
    });
}
async function getMemberVolunteerHours(memberId) {
    return apiFetch(REST_BASE + "/volunteer_hours?select=*,events(name,start_at)&member_id=eq."
        + encodeURIComponent(memberId) + "&order=logged_at.desc",
        { method: "GET", headers: authHeaders() });
}

// ---- Admin ---------------------------------------------------------
async function adminFetchAllMembers() {
    const BATCH_SIZE = 500, MAX_BATCHES = 200;
    const all = []; let cursor = null;
    for (let b = 0; b < MAX_BATCHES; b += 1) {
        let url = REST_BASE + "/member_roster?select=*&order=created_at.desc,id.desc&limit=" + BATCH_SIZE;
        if (cursor && cursor.ts && cursor.id) {
            const ts = encodeURIComponent(cursor.ts), id = encodeURIComponent(cursor.id);
            url += "&or=(created_at.lt." + ts + ",and(created_at.eq." + ts + ",id.lt." + id + "))";
        }
        const rows = await apiFetch(url, { method: "GET", headers: authHeaders() });
        if (!Array.isArray(rows) || rows.length === 0) { break; }
        for (let i = 0; i < rows.length; i += 1) { all.push(rows[i]); }
        if (rows.length < BATCH_SIZE) { break; }
        const last = rows[rows.length - 1];
        cursor = { ts: last.created_at, id: last.id };
    }
    return all;
}
async function adminFetchAllHours() {
    const BATCH_SIZE = 500, MAX_BATCHES = 2000;
    const select = "id,logged_at,hours,travel_time,total_hours,notes,"
        + "members(first_name,last_name,email,is_member),events(name,start_at,location)";
    const all = []; let cursor = null;
    for (let b = 0; b < MAX_BATCHES; b += 1) {
        let url = REST_BASE + "/volunteer_hours?select=" + select
            + "&order=logged_at.desc,id.desc&limit=" + BATCH_SIZE;
        if (cursor && cursor.ts && cursor.id) {
            const ts = encodeURIComponent(cursor.ts), id = encodeURIComponent(cursor.id);
            url += "&or=(logged_at.lt." + ts + ",and(logged_at.eq." + ts + ",id.lt." + id + "))";
        }
        const rows = await apiFetch(url, { method: "GET", headers: authHeaders() });
        if (!Array.isArray(rows) || rows.length === 0) { break; }
        for (let i = 0; i < rows.length; i += 1) { all.push(rows[i]); }
        if (rows.length < BATCH_SIZE) { break; }
        const last = rows[rows.length - 1];
        cursor = { ts: last.logged_at, id: last.id };
    }
    return all;
}
async function adminUpdateMember(memberId, fields) {
    return apiFetch(REST_BASE + "/members?id=eq." + encodeURIComponent(memberId), {
        method: "PATCH",
        headers: Object.assign(authHeaders(), { "Prefer": "return=representation" }),
        body: JSON.stringify(fields)
    });
}
async function adminCreateMember(fields) {
    return apiFetch(REST_BASE + "/rpc/admin_create_member", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({
            p_email: fields.email, p_first_name: fields.first_name || null,
            p_last_name: fields.last_name || null, p_phone: fields.phone || null,
            p_is_member: !!fields.is_member,
            p_membership_status: fields.membership_status || "pending",
            p_membership_type: fields.membership_type || "non-recurring",
            p_next_renewal_date: fields.next_renewal_date || null,
            p_tier: fields.tier || "No Shirt",
            p_date_shirt_sent: fields.date_shirt_sent || null,
            p_shirt_size: fields.shirt_size || null, p_city: fields.city || null,
            p_state: fields.state || null, p_postal_code: fields.postal_code || null,
            p_is_admin: !!fields.is_admin
        })
    });
}
async function adminMergeMembers(targetId, sourceId) {
    return apiFetch(REST_BASE + "/rpc/admin_merge_members", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ p_target_id: targetId, p_source_id: sourceId })
    });
}
async function adminSetArchived(memberId, archived) {
    return apiFetch(REST_BASE + "/rpc/admin_set_archived", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ p_member_id: memberId, p_archived: !!archived })
    });
}
async function adminCreateEvent(event) {
    return apiFetch(REST_BASE + "/events", {
        method: "POST",
        headers: Object.assign(authHeaders(), { "Prefer": "return=representation" }),
        body: JSON.stringify({ name: event.name, description: event.description || null,
            start_at: event.start_at, end_at: event.end_at || null, location: event.location || null })
    });
}
async function adminUpdateEvent(eventId, fields) {
    return apiFetch(REST_BASE + "/events?id=eq." + encodeURIComponent(eventId), {
        method: "PATCH",
        headers: Object.assign(authHeaders(), { "Prefer": "return=representation" }),
        body: JSON.stringify({ name: fields.name, description: fields.description || null,
            start_at: fields.start_at, end_at: fields.end_at || null, location: fields.location || null })
    });
}
async function adminLogHoursFor(memberId, eventId, hours, travel, notes) {
    return apiFetch(REST_BASE + "/rpc/admin_log_hours", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ p_member_id: memberId, p_event_id: eventId, p_hours: hours,
            p_travel: travel || 0, p_notes: notes || null })
    });
}
async function adminBulkLogHours(eventId, entries) {
    return apiFetch(REST_BASE + "/rpc/admin_bulk_log_hours", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ p_event_id: eventId, p_entries: entries })
    });
}
async function adminEventHoursSummary() {
    return apiFetch(REST_BASE + "/rpc/admin_event_hours_summary", {
        method: "POST", headers: authHeaders(), body: JSON.stringify({}) });
}
async function adminListHoursForEvent(eventId) {
    return apiFetch(REST_BASE + "/volunteer_hours"
        + "?select=id,hours,travel_time,total_hours,notes,member_id,members(full_name,email)"
        + "&event_id=eq." + encodeURIComponent(eventId) + "&order=logged_at.desc",
        { method: "GET", headers: authHeaders() });
}
async function adminUpdateHoursEntry(entryId, fields) {
    return apiFetch(REST_BASE + "/volunteer_hours?id=eq." + encodeURIComponent(entryId), {
        method: "PATCH",
        headers: Object.assign(authHeaders(), { "Prefer": "return=representation" }),
        body: JSON.stringify(fields)
    });
}
async function adminDeleteHoursEntry(entryId) {
    return apiFetch(REST_BASE + "/volunteer_hours?id=eq." + encodeURIComponent(entryId), {
        method: "DELETE", headers: authHeaders() });
}
