// sw.js - lets the portal be installed to a phone's home screen and still open
// (read-only) when the connection drops.
//
// Strategy: "network first" for the portal's own files, so every visit gets the
// latest deployed version; the cached copy is only used when offline.
// Supabase requests (other origins) are never touched or cached.
"use strict";

const CACHE = "mmp-shell-v2";   // bump when deploying to drop old copies
const SHELL = ["./", "index.html", "styles.css", "app.js", "api.js", "config.js", "env.js",
    "vendor/qrcode.js", "manifest.webmanifest", "icons/icon-192.png"];

self.addEventListener("install", function (event) {
    event.waitUntil(caches.open(CACHE)
        .then(function (cache) { return cache.addAll(SHELL); })
        .catch(function () { /* first install offline: fine */ })
        .then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (event) {
    event.waitUntil(caches.keys().then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; })
            .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (event) {
    const req = event.request;
    if (req.method !== "GET") { return; }
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) { return; }      // Supabase, CDN: browser handles normally
    event.respondWith(
        // cache: "no-cache" makes the browser check the server every time instead
        // of reusing its own HTTP-cached copy, so a new deploy shows up right away.
        fetch(req, { cache: "no-cache" }).then(function (res) {
            if (res && res.ok) {
                const copy = res.clone();
                caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
            }
            return res;
        }).catch(function () {
            return caches.match(req, { ignoreSearch: true }).then(function (hit) {
                return hit || caches.match("index.html");
            });
        })
    );
});
