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

const CONFIG = Object.freeze({
    SUPABASE_URL: SUPABASE_ENV.url || "",
    SUPABASE_PUBLISHABLE_KEY: SUPABASE_ENV.publishableKey || ""
});

// Your organization's branding + contact info (shown in the header and the
// "About" panel). Leave a field as "" to hide that line. logo_url can be a
// full URL or a path to a file you add alongside index.html (e.g. "logo.png").
    //name:    "Your Organization",
    //logo_url: "",                       // e.g. "logo.png" or "https://.../logo.svg"
    //address: "123 Main St, Springfield, IL 62701",
    //phone:   "555-123-4567",
    //email:   "info@example.org",
    //website: "https://example.org"
const ORG = Object.freeze({
    name:    "Arkansas Climbers Coalition - User Portal",
    logo_url: "",                       // e.g. "logo.png" or "https://.../logo.svg"
    address: "Arkansas",
    phone:   "000-000-00000",
    email:   "contact@arkansasclimbers.org",
    website: "https://arkansasclimbers.org"
});
