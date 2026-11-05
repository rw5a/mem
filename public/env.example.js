// env.example.js - template for local testing.
//
// 1. Copy this file to env.js (same folder).
// 2. Fill in your values from Supabase -> Project Settings -> API Keys.
// 3. Do NOT commit env.js; it is already listed in .gitignore.
//
// On GitHub Pages you don't need this: the deploy workflow writes env.js
// from the SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY repository secrets.
"use strict";

window.SUPABASE_ENV = Object.freeze({
    url: "https://YOUR-PROJECT.supabase.co",
    publishableKey: "sb_publishable_YOUR-KEY"
});
