// config.js - deployment configuration.
//
// The Supabase Project URL and publishable key are NOT stored in this file.
// They are loaded from env.js, which is:
//   - generated automatically by the GitHub Actions workflow from repository
//     secrets at deploy time (see .github/workflows/deploy-pages.yml), or
//   - created by you for local testing by copying env.example.js -> env.js.
// env.js is listed in .gitignore so it never gets committed.
//
// The publishable key (sb_publishable_...) is designed to be used in the
// browser; Row Level Security enforces access. NEVER place the secret key
// (sb_secret_...) or the legacy service_role key in any file served to the browser.
"use strict";

const SUPABASE_ENV = window.SUPABASE_ENV || {};

if (!SUPABASE_ENV.url || !SUPABASE_ENV.publishableKey) {
    console.error("Supabase settings missing: env.js was not found or is incomplete. " +
        "For local testing copy public/env.example.js to public/env.js; for GitHub Pages " +
        "add the SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY repository secrets.");
}

// Keep only "https://<project>.supabase.co". This strips extra pieces that
// commonly get pasted in by accident, such as a trailing "/", "/rest/v1/",
// or "/auth/v1", which would otherwise make Supabase reply
// "Invalid path specified in request URL".
function normalizeSupabaseUrl(raw) {
    const text = String(raw || "").trim();
    if (text === "") { return ""; }
    try {
        return new URL(text).origin;
    } catch (err) {
        console.error("SUPABASE_URL is not a valid URL: " + text);
        return "";
    }
}

const CONFIG = Object.freeze({
    SUPABASE_URL: normalizeSupabaseUrl(SUPABASE_ENV.url),
    SUPABASE_PUBLISHABLE_KEY: String(SUPABASE_ENV.publishableKey || "").trim()
});

// Your organization's branding + contact info (shown in the header and the
// "About" panel). Leave a field as "" to hide that line. logo_url can be a
// full URL or a path to a file you add alongside index.html (e.g. "logo.png").
const ORG = Object.freeze({
    //name:    "Your Organization",
    //logo_url: "",                       // e.g. "logo.png" or "https://.../logo.svg"
    //address: "123 Main St, Springfield, IL 62701",
    //phone:   "555-123-4567",
    //email:   "info@example.org",
    //website: "https://example.org",
    name:    "Arkansas Climbers Coalition",
    logo_url: "",                       // e.g. "logo.png" or "https://.../logo.svg"
    address: "Arkansas",
    phone:   "000-000-0000",
    email:   "contact@arkansasclimbers.org",
    website: "https://arkansasclimbers.org",
    // Time zone your events take place in. Everyone sees event times in this
    // zone, and admins enter times in it, regardless of their device's setting.
    // Use an IANA name, e.g. "America/New_York", "America/Chicago",
    // "America/Denver", "America/Phoenix", "America/Los_Angeles",
    // "America/Anchorage", "Pacific/Honolulu", "America/Puerto_Rico".
    // Leave "" to use each viewer's own device time zone.
    timezone: "America/Chicago"
});
