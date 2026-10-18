// ==UserScript==
// @name         Instagram Web Data Saver
// @namespace    https://github.com/zyl-fx
// @version      1.0.0
// @description  Save data on Instagram web: pick a video quality (Auto, Best, Worst or a resolution cap) and optionally click to load videos instead of auto-loading them.
// @author       Zyl
// @license      MIT
// @homepageURL  https://github.com/zyl-fx/Instagram-web-data-saver
// @supportURL   https://github.com/zyl-fx/Instagram-web-data-saver/issues
// @updateURL    https://github.com/zyl-fx/Instagram-web-data-saver/releases/latest/download/Instagram-Web-Data-Saver.user.js
// @downloadURL  https://github.com/zyl-fx/Instagram-web-data-saver/releases/latest/download/Instagram-Web-Data-Saver.user.js
// @match        https://www.instagram.com/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

/*!
 * Instagram Web Data Saver
 *
 * - Video quality: rewrites the list of video renditions Instagram sends to the
 *   page, so the player can only choose from the renditions you allow.
 *   "Auto" never touches anything and leaves Instagram's adaptive streaming alone.
 * - Click to load: when Auto-load is off, videos are held back until you click
 *   "Load video" (like Twitter/X data saver).
 *
 * No network requests of its own, no tracking. Settings live in localStorage.
 * Enable console logging with:  localStorage.setItem('igds:debug', '1')
 */

(function () {
  'use strict';

  /* ====================================================================== *
   *  Core state & helpers
   * ====================================================================== */

  const STORE_KEY = 'igds:v1';
  const DEBUG_KEY = 'igds:debug';
  const STANDARD_TIERS = [144, 240, 360, 480, 540, 720, 1080, 1440, 2160];

  const nativeParse = JSON.parse; // never use the hooked version internally
  const noop = () => {};

  let debugOn = false;
  try {
    debugOn = localStorage.getItem(DEBUG_KEY) === '1';
  } catch (_) {}
  const log = (...a) => {
    if (debugOn) console.log('[IGDS]', ...a);
  };

  const state = {
    quality: 'auto', // 'auto' | 'best' | 'worst' | 'cap:<height>'
    autoLoad: true, // false = click to load videos
    tiers: [], // resolutions (short side, px) seen so far, descending
  };
  const stats = { adjusted: 0 };
  let dirty = false; // quality changed since this page loaded
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => {
    try {
      fn();
    } catch (_) {}
  });
  let emitQueued = false;
  const emitSoon = () => {
    if (emitQueued) return;
    emitQueued = true;
    requestAnimationFrame(() => {
      emitQueued = false;
      emit();
    });
  };

  const isValidQuality = (q) => q === 'auto' || q === 'best' || q === 'worst' || /^cap:\d{3,4}$/.test(q);
  const isActive = () => state.quality !== 'auto';
  const capOf = (q) => Number(q.slice(4));

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const o = nativeParse(raw);
      if (!o) return;
      if (isValidQuality(o.quality)) state.quality = o.quality;
      if (typeof o.autoLoad === 'boolean') state.autoLoad = o.autoLoad;
      if (Array.isArray(o.tiers)) {
        state.tiers = o.tiers.filter((n) => Number.isFinite(n) && n >= 144).sort((a, b) => b - a);
      }
    } catch (_) {}
  }

  function saveState() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ quality: state.quality, autoLoad: state.autoLoad, tiers: state.tiers })
      );
    } catch (_) {}
  }

  loadState();

  /* ====================================================================== *
   *  Video quality
   *
   *  Instagram streams video with DASH. The page receives a manifest that lists
   *  several renditions (often multiple bitrates at the same resolution plus a
   *  higher-resolution one). We filter that list before the player sees it.
   *  "Quality" below = the short side of the frame (720x1280 reel -> 720).
   * ====================================================================== */

  const snap = (v) => {
    for (const s of STANDARD_TIERS) if (Math.abs(v - s) / s <= 0.06) return s;
    return v;
  };

  function noteTier(q) {
    if (q < 144 || state.tiers.includes(q)) return;
    state.tiers.push(q);
    state.tiers.sort((a, b) => b - a);
    saveState();
    emit();
    log('new resolution seen:', q + 'p');
  }

  // items: [{ q, bw }] -> the subset to keep, according to the chosen quality.
  function choose(items) {
    const sorted = items.slice().sort((a, b) => a.q - b.q || a.bw - b.bw);
    const mode = state.quality;
    if (mode === 'worst') return [sorted[0]];
    if (mode === 'best') return [sorted[sorted.length - 1]];
    const cap = capOf(mode);
    const ok = sorted.filter((r) => r.q <= cap);
    return ok.length ? ok : [sorted[0]]; // adaptive below the cap
  }

  const num = (re, s) => {
    const m = re.exec(s);
    return m ? Number(m[1]) : 0;
  };

  // DASH manifest (XML string). Regex-based on purpose: no DOMParser, so no
  // Trusted Types trouble. Audio representations have no width/height and are
  // never touched.
  function processManifest(xml) {
    const apply = isActive();
    let changed = false;
    const out = xml.replace(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g, (set) => {
      const reps = [];
      const re = /<Representation\b(?:[^>]*\/>|[\s\S]*?<\/Representation>)/g;
      let m;
      while ((m = re.exec(set))) {
        const tag = m[0];
        const open = tag.slice(0, tag.indexOf('>') + 1);
        const w = num(/\bwidth="(\d+)"/, open);
        const h = num(/\bheight="(\d+)"/, open);
        if (w && h) reps.push({ text: tag, q: snap(Math.min(w, h)), bw: num(/\bbandwidth="(\d+)"/, open) });
      }
      reps.forEach((r) => noteTier(r.q));
      if (!apply || reps.length < 2) return set;
      const keep = choose(reps);
      if (keep.length === reps.length) return set;
      let res = set;
      for (const r of reps) if (!keep.includes(r)) res = res.replace(r.text, '');
      changed = true;
      log('manifest', reps.map((r) => r.q + 'p/' + Math.round(r.bw / 1000) + 'k').join(' '), '->',
        keep.map((r) => r.q + 'p/' + Math.round(r.bw / 1000) + 'k').join(' '));
      return res;
    });
    if (!changed) return xml;
    stats.adjusted++;
    emit();
    return out;
  }

  // Progressive MP4 list (usually a single fixed rendition; handled for completeness).
  function filterVersions(parent, key) {
    const arr = parent[key];
    if (arr.length < 2) return;
    const items = arr
      .filter((x) => x && x.url && x.width && x.height)
      .map((x) => ({ x, q: snap(Math.min(x.width, x.height)), bw: 0 }));
    if (items.length < 2) return;
    const keep = choose(items);
    if (keep.length === items.length) return;
    parent[key] = keep.map((i) => i.x);
    stats.adjusted++;
    emit();
  }

  function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 64) return;
    const isArr = Array.isArray(node);
    const keys = isArr ? null : Object.keys(node);
    const n = isArr ? node.length : keys.length;
    for (let i = 0; i < n; i++) {
      const k = isArr ? i : keys[i];
      const v = node[k];
      if (typeof v === 'string') {
        if (v.length > 200 && v.indexOf('<MPD') !== -1) {
          const next = processManifest(v);
          if (next !== v) node[k] = next;
        }
      } else if (v && typeof v === 'object') {
        if (k === 'video_versions' && Array.isArray(v)) {
          if (isActive()) filterVersions(node, k);
        } else walk(v, depth + 1);
      }
    }
  }

  const hasHint = (t) => t.includes('MPD') || t.includes('video_versions');

  // Returns the rewritten text, or null when nothing changed.
  function transformText(text) {
    const prefix = text.startsWith('for (;;);') ? 'for (;;);' : '';
    const body = prefix ? text.slice(prefix.length) : text;
    const before = stats.adjusted;
    let out;
    try {
      const obj = nativeParse(body);
      walk(obj, 0);
      out = JSON.stringify(obj);
    } catch (_) {
      // maybe newline-delimited JSON (deferred GraphQL)
      let any = false;
      out = body
        .split('\n')
        .map((line) => {
          if (!line.trim()) return line;
          try {
            const o = nativeParse(line);
            walk(o, 0);
            any = true;
            return JSON.stringify(o);
          } catch (_) {
            return line;
          }
        })
        .join('\n');
      if (!any) return null;
    }
    return stats.adjusted !== before ? prefix + out : null;
  }

  /* ---- Hooks: JSON.parse (page-embedded data) and fetch (API responses) ---- */

  JSON.parse = function (text) {
    const out = nativeParse.apply(this, arguments);
    try {
      if (typeof text === 'string' && hasHint(text)) walk(out, 0);
    } catch (e) {
      log('JSON.parse hook error', e);
    }
    return out;
  };

  const API_RE = /\/(?:api|graphql|ajax)\b/;
  const urlOf = (input) => {
    try {
      return typeof input === 'string' ? input : (input && input.url) || String(input);
    } catch (_) {
      return '';
    }
  };

  function handleResponse(res) {
    try {
      const ct = res.headers.get('content-type') || '';
      if (!/json|javascript|text\/plain/i.test(ct)) return res;

      if (!isActive()) {
        // Auto: never modify. Only learn which resolutions exist, off the critical path.
        res.clone().text().then((t) => {
          if (hasHint(t)) transformText(t);
        }).catch(noop);
        return res;
      }

      return res.clone().text().then((text) => {
        if (!hasHint(text)) return res;
        const out = transformText(text);
        if (out === null) return res;
        const headers = new Headers(res.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        const fixed = new Response(out, { status: res.status, statusText: res.statusText, headers });
        try {
          Object.defineProperty(fixed, 'url', { value: res.url });
        } catch (_) {}
        return fixed;
      }).catch(() => res);
    } catch (e) {
      log('fetch hook error', e);
      return res;
    }
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input) {
      const p = nativeFetch.apply(this, arguments);
      return API_RE.test(urlOf(input)) ? p.then(handleResponse) : p;
    };
  }

  /* ====================================================================== *
   *  Click to load (Auto-load: false)
   *
   *  When Auto-load is off, video playback and data streaming are held back
   *  until the user explicitly clicks "Load video".
   *
   *  How it works:
   *  1. A <video>'s source assignment is intercepted and held (no source, no
   *     streaming) until the user clicks "Load video".
   *  2. URL.revokeObjectURL is deferred for held streams so the blob URL is
   *     still valid when the video is finally attached.
   *  3. The overlay is attached to the outermost media container (above poster
   *     images in Feed, gesture layers in Reels, navigation layers in Stories).
   *  4. Clicks are stopped at the CAPTURE phase on the overlay.
   *  5. nativePlay runs synchronously inside the click, with a muted fallback.
   *  6. Instagram's own spinner / centre play icon are hidden under the overlay.
   * ====================================================================== */

  const gate = { recs: new WeakMap(), active: new Set(), allow: 0 };
  const unlockedVideos = new WeakSet();
  const msUrls = new Set();
  const deferredRevokes = new Set();

  const Media = HTMLMediaElement.prototype;
  const srcDesc = Object.getOwnPropertyDescriptor(Media, 'src');
  const nativePlay = Media.play;
  const nativePause = Media.pause;
  const nativeLoad = Media.load;
  const nativeSetAttr = Element.prototype.setAttribute;
  const nativeRemoveAttr = Element.prototype.removeAttribute;
  const nativeCreateURL = URL.createObjectURL;
  const nativeRevokeURL = URL.revokeObjectURL;

  const isMediaSource = (o) =>
    (typeof MediaSource !== 'undefined' && o instanceof MediaSource) ||
    (typeof ManagedMediaSource !== 'undefined' && o instanceof ManagedMediaSource);

  function isGateable(video, value) {
    if (state.autoLoad || gate.allow > 0) return false;
    if (!video || unlockedVideos.has(video)) return false;
    if (typeof value !== 'string' || !value) return false;
    if (value.startsWith('data:')) return false;
    // Don't gate user-selected file upload previews (which are Blobs/Files, not MediaSource)
    if (value.startsWith('blob:') && !msUrls.has(value)) return false;
    return true;
  }

  function isVideoInViewport(video) {
    if (!video || !video.isConnected) return false;
    const r = video.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    if (r.width <= 0 || r.height <= 0) return false;
    const visibleH = Math.max(0, Math.min(vh, r.bottom) - Math.max(0, r.top));
    const visibleW = Math.max(0, Math.min(vw, r.right) - Math.max(0, r.left));
    return visibleH >= Math.min(r.height * 0.4, 180) && visibleW >= Math.min(r.width * 0.4, 180);
  }

  function pauseOtherVideos(currentVideo) {
    try {
      document.querySelectorAll('video').forEach((v) => {
        if (v !== currentVideo && !v.paused) {
          try {
            nativePause.call(v);
          } catch (_) {}
        }
      });
    } catch (_) {}
  }

  function intercept(video, value) {
    let rec = gate.recs.get(video);
    if (rec) {
      rec.src = value;
    } else {
      rec = {
        src: value,
        plays: [],
        overlay: null,
        host: null,
        hostRestore: null,
        t: Date.now(),
      };
      gate.recs.set(video, rec);
      gate.active.add(video);
    }
    schedule();
    emitSoon();
  }

  function detachOverlay(rec) {
    if (rec.overlay) {
      rec.overlay.remove();
      rec.overlay = null;
    }
    if (rec.host) {
      rec.host.removeAttribute('data-igds-gated');
      if (rec.hostRestore && rec.hostRestore.position !== undefined) {
        rec.host.style.position = rec.hostRestore.position;
      }
    }
    rec.host = null;
    rec.hostRestore = null;
  }

  const heldCount = () =>
    Array.from(gate.active).filter((v) => v.isConnected && gate.recs.has(v)).length;

  function dropGate(video) {
    const rec = gate.recs.get(video);
    if (!rec) return;
    detachOverlay(rec);
    gate.recs.delete(video);
    gate.active.delete(video);
    emitSoon();
    if (deferredRevokes.delete(rec.src)) {
      msUrls.delete(rec.src);
      try {
        nativeRevokeURL.call(URL, rec.src);
      } catch (_) {}
    }
  }

  function release(video, userInitiated) {
    const rec = gate.recs.get(video);
    if (!rec) return;

    log('Releasing video:', rec.src, 'userInitiated:', userInitiated);
    unlockedVideos.add(video);

    detachOverlay(rec);
    gate.recs.delete(video);
    gate.active.delete(video);
    emitSoon();

    gate.allow++;
    try {
      srcDesc.set.call(video, rec.src);
      nativeSetAttr.call(video, 'src', rec.src);
    } finally {
      gate.allow--;
    }

    try {
      nativeLoad.call(video);
    } catch (_) {}

    // Clean up deferred blob URL revokes after playback is well underway
    if (deferredRevokes.delete(rec.src)) {
      setTimeout(() => {
        msUrls.delete(rec.src);
        try {
          nativeRevokeURL.call(URL, rec.src);
        } catch (_) {}
      }, 15000);
    }

    if (userInitiated) {
      pauseOtherVideos(video);
      // Call nativePlay synchronously during the user gesture to preserve browser activation
      try {
        const playPromise = nativePlay.call(video);
        if (playPromise && typeof playPromise.then === 'function') {
          playPromise
            .then(() => {
              log('Playback started successfully');
              if (rec.plays && rec.plays.length) {
                rec.plays.forEach((p) => p.resolve());
              }
            })
            .catch((err) => {
              log('Play rejected:', err);
              if (rec.plays && rec.plays.length) {
                rec.plays.forEach((p) => p.reject(err));
              }
              // If browser blocks unmuted playback, mute and retry
              if (err && err.name === 'NotAllowedError') {
                video.muted = true;
                nativePlay.call(video).catch(noop);
              }
            });
        }
      } catch (err) {
        log('Direct play error:', err);
      }
    } else {
      // Automatic/background release (e.g. enabling Auto-load): keep off-screen videos PAUSED
      try {
        nativePause.call(video);
      } catch (_) {}
      if (rec.plays && rec.plays.length) {
        rec.plays.forEach((p) => {
          try {
            p.reject(new DOMException('Gated release while inactive', 'AbortError'));
          } catch (_) {}
        });
      }
    }
  }

  // Release every held video (Auto-load switched on, or "Load N held videos").
  // - Videos that are no longer part of the page (reels you scrolled past) are
  //   dropped: they are never loaded and never played. A detached <video> can
  //   still play sound, which is what made old reels all talk at once.
  // - Of the rest, only the one on screen starts playing; the others are loaded
  //   paused, so Instagram's own player decides when they play.
  function releaseAll() {
    const activeList = Array.from(gate.active);
    const visible = activeList.find((v) => isVideoInViewport(v));
    activeList.forEach((v) => {
      if (!v.isConnected) {
        const rec = gate.recs.get(v);
        if (rec) {
          rec.plays.forEach((p) => {
            try {
              p.reject(new DOMException('Video left the page', 'AbortError'));
            } catch (_) {}
          });
          rec.plays = [];
        }
        dropGate(v);
      } else {
        release(v, v === visible);
      }
    });
  }

  // --- intercepts -----------------------------------------------------------

  if (srcDesc && srcDesc.set) {
    Object.defineProperty(Media, 'src', {
      configurable: true,
      enumerable: srcDesc.enumerable,
      get() {
        const rec = gate.recs.get(this);
        return rec ? rec.src : srcDesc.get.call(this);
      },
      set(v) {
        if (this instanceof HTMLVideoElement) {
          const strVal = v == null ? '' : String(v);
          if (isGateable(this, strVal)) {
            intercept(this, strVal);
            return;
          }
          if (gate.allow === 0 && gate.recs.has(this)) dropGate(this);
        }
        srcDesc.set.call(this, v);
      },
    });

    Element.prototype.setAttribute = function (name, value) {
      if (
        typeof name === 'string' &&
        name.length === 3 &&
        name.toLowerCase() === 'src' &&
        this instanceof HTMLVideoElement
      ) {
        const strVal = String(value);
        if (isGateable(this, strVal)) {
          intercept(this, strVal);
          return;
        }
        if (gate.allow === 0 && gate.recs.has(this)) dropGate(this);
      }
      return nativeSetAttr.apply(this, arguments);
    };

    Element.prototype.removeAttribute = function (name) {
      if (
        typeof name === 'string' &&
        name.length === 3 &&
        name.toLowerCase() === 'src' &&
        gate.recs.has(this)
      ) {
        dropGate(this);
      }
      return nativeRemoveAttr.apply(this, arguments);
    };

    Media.play = function () {
      const rec = gate.recs.get(this);
      if (rec) return new Promise((resolve, reject) => rec.plays.push({ resolve, reject }));
      return nativePlay.apply(this, arguments);
    };

    Media.load = function () {
      if (gate.recs.has(this)) return undefined;
      return nativeLoad.apply(this, arguments);
    };

    URL.createObjectURL = function (obj) {
      const u = nativeCreateURL.apply(this, arguments);
      try {
        if (isMediaSource(obj)) msUrls.add(u);
      } catch (_) {}
      return u;
    };

    // Keep a held stream's blob URL alive until it has actually been attached.
    // Any other URL is revoked normally (and forgotten), so nothing piles up.
    URL.revokeObjectURL = function (u) {
      if (typeof u === 'string') {
        for (const v of gate.active) {
          const rec = gate.recs.get(v);
          if (rec && rec.src === u) {
            deferredRevokes.add(u);
            return undefined;
          }
        }
        msUrls.delete(u);
      }
      return nativeRevokeURL.apply(this, arguments);
    };
  }

  // --- overlay & host discovery ---------------------------------------------

  let raf = 0;
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      mountOverlays();
    });
  }

  // Finds the outermost matching media container so the overlay sits ABOVE
  // Feed poster images, Reels central play buttons, and Stories navigation layers.
  function findHost(video) {
    const vr = video.getBoundingClientRect();
    if (vr.width < 30 || vr.height < 30) return null;

    let curr = video.parentElement;
    let best = curr;
    let depth = 0;

    // In feed posts, stop at the article element
    const article = video.closest('article');
    const stopAt = article || document.body;

    while (curr && curr !== stopAt && depth < 8) {
      const cr = curr.getBoundingClientRect();
      if (
        cr.width >= vr.width * 0.82 &&
        cr.width <= vr.width * 1.25 &&
        cr.height >= vr.height * 0.82 &&
        cr.height <= vr.height * 1.25
      ) {
        best = curr;
      }
      curr = curr.parentElement;
      depth++;
    }
    return best || video.parentElement;
  }

  function playIcon(size) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M8 5v14l11-7z');
    svg.appendChild(path);
    return svg;
  }

  function attachOverlay(video, rec, host, rect) {
    rec.hostRestore = { position: host.style.position };
    if (getComputedStyle(host).position === 'static') {
      host.style.position = 'relative';
    }
    host.setAttribute('data-igds-gated', 'true');
    rec.host = host;

    const compact = rect.width < 200 || rect.height < 140;

    const ov = document.createElement('div');
    ov.setAttribute('data-igds-overlay', '');
    Object.assign(ov.style, {
      position: 'absolute',
      top: '0',
      right: '0',
      bottom: '0',
      left: '0',
      zIndex: '2147483640',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer',
      background: 'rgba(0,0,0,0.42)',
      backdropFilter: 'blur(10px)',
      webkitBackdropFilter: 'blur(10px)',
      userSelect: 'none',
      pointerEvents: 'auto',
    });

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Load video');
    Object.assign(btn.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '8px',
      border: '1px solid rgba(255,255,255,0.22)',
      cursor: 'pointer',
      color: '#ffffff',
      background: 'rgba(15, 20, 25, 0.88)',
      borderRadius: '999px',
      boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
      font: '700 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      padding: compact ? '10px' : '10px 20px',
      pointerEvents: 'auto',
      transform: 'translateZ(0)',
      transition: 'background 0.15s, transform 0.15s',
    });

    btn.appendChild(playIcon(compact ? 20 : 16));
    if (!compact) {
      const span = document.createElement('span');
      span.textContent = 'Load video';
      btn.appendChild(span);
    }

    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'rgba(35, 45, 55, 0.96)';
      btn.style.transform = 'scale(1.04)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'rgba(15, 20, 25, 0.88)';
      btn.style.transform = 'none';
    });

    ov.appendChild(btn);

    // Stop pointer events at capture phase so Instagram navigation / gesture layers cannot steal them
    const stopAll = (e) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    [
      'pointerdown',
      'pointerup',
      'mousedown',
      'mouseup',
      'touchstart',
      'touchend',
      'dblclick',
      'contextmenu',
    ].forEach((t) => ov.addEventListener(t, stopAll, { capture: true, passive: false }));

    ov.addEventListener(
      'click',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        release(video, true);
      },
      { capture: true }
    );

    host.appendChild(ov);
    rec.overlay = ov;
  }

  function mountOverlays() {
    if (state.autoLoad) return;
    const now = Date.now();
    for (const video of Array.from(gate.active)) {
      const rec = gate.recs.get(video);
      if (!rec) {
        gate.active.delete(video);
        continue;
      }
      if (!video.isConnected) {
        if (rec.overlay) detachOverlay(rec);
        if (now - rec.t > 60000) gate.active.delete(video);
        continue;
      }
      rec.t = now;
      if (rec.overlay && rec.overlay.isConnected) {
        continue;
      }
      if (rec.overlay) {
        detachOverlay(rec);
      }
      const host = findHost(video);
      if (!host) continue;
      const rect = host.getBoundingClientRect();
      if (rect.width < 30 || rect.height < 30) continue;
      attachOverlay(video, rec, host, rect);
    }
  }

  /* ====================================================================== *
   *  Widget (top-right, Shadow DOM)
   * ====================================================================== */

  function setQuality(id) {
    if (state.quality === id || !isValidQuality(id)) return;
    state.quality = id;
    dirty = true;
    saveState();
    emit();
  }

  function setAutoLoad(on) {
    if (state.autoLoad === on) return;
    state.autoLoad = on;
    saveState();
    if (on) releaseAll();
    emit();
  }

  function labelFor(q, long) {
    if (q === 'auto') return 'Auto';
    if (q === 'best') return 'Best';
    if (q === 'worst') return 'Worst';
    return (long ? 'Up to ' : '\u2264') + capOf(q) + 'p';
  }

  // Auto, Best, [resolution caps], Worst. Caps only appear once Instagram has
  // shown us at least three different resolutions.
  function qualityOptions() {
    const mid = state.tiers.length > 2 ? state.tiers.slice(1, -1) : [];
    const list = [
      { id: 'auto', label: 'Auto', hint: 'Instagram chooses and adapts to your connection (default).' },
      { id: 'best', label: 'Best', hint: 'Always the highest quality available.' },
    ];
    mid.forEach((t) => list.push({
      id: 'cap:' + t,
      label: labelFor('cap:' + t, true),
      hint: 'Never above ' + t + 'p. Still adapts to your connection below that.',
    }));
    if (state.quality.startsWith('cap:') && !list.some((o) => o.id === state.quality)) {
      list.push({ id: state.quality, label: labelFor(state.quality, true), hint: '' });
    }
    list.push({ id: 'worst', label: 'Worst', hint: 'Always the lowest quality available (least data).' });
    return list;
  }

  const WIDGET_CSS = `
:host{all:initial;position:fixed;top:8px;right:12px;z-index:2147483647;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#f5f5f5}
*{box-sizing:border-box}
.root{display:flex;flex-direction:column;align-items:flex-end}
.pill{appearance:none;border:1px solid rgba(255,255,255,.12);background:rgba(18,18,18,.78);color:inherit;font:inherit;font-weight:600;padding:3px 11px;border-radius:999px;cursor:pointer;opacity:.6;transition:opacity .15s;white-space:nowrap}
.root:hover .pill,.root:focus-within .pill,.root.open .pill{opacity:1}
.panel{display:none;margin-top:6px;width:212px;padding:10px 10px 8px;border-radius:12px;background:rgba(18,18,18,.96);border:1px solid rgba(255,255,255,.1);box-shadow:0 10px 32px rgba(0,0,0,.45);animation:in .12s ease-out}
.root:hover .panel,.root:focus-within .panel,.root.open .panel{display:block}
@keyframes in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.title{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:#9a9a9a;margin:0 2px 4px}
.opt{display:flex;align-items:center;gap:9px;width:100%;appearance:none;border:0;background:transparent;color:inherit;font:inherit;text-align:left;padding:5px 6px;border-radius:7px;cursor:pointer}
.opt:hover,.opt:focus-visible{background:rgba(255,255,255,.09);outline:none}
.opt[aria-checked=true]{font-weight:600}
.dot{flex:none;width:12px;height:12px;border-radius:50%;border:2px solid #7a7a7a}
.opt[aria-checked=true] .dot{border-color:#0095f6;background:radial-gradient(#0095f6 0 45%,transparent 50%)}
.sep{height:1px;background:rgba(255,255,255,.1);margin:7px 0}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:2px 6px}
.sw{flex:none;position:relative;width:34px;height:20px;border-radius:999px;border:0;background:#4a4a4a;cursor:pointer;transition:background .15s;padding:0}
.sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}
.sw[aria-checked=true]{background:#0095f6}
.sw[aria-checked=true]::after{transform:translateX(14px)}
.foot{font-size:11px;color:#9a9a9a;padding:0 6px;line-height:1.5}
.reload{display:block;width:100%;margin-top:7px;appearance:none;border:0;border-radius:8px;background:#0095f6;color:#fff;font:inherit;font-weight:600;padding:6px 10px;cursor:pointer}
.reload:hover{background:#1aa3ff}
.held{display:none;width:100%;margin-top:6px;appearance:none;border:0;border-radius:8px;background:rgba(255,255,255,.12);color:#fff;font:inherit;font-weight:600;padding:6px 10px;cursor:pointer}
.held:hover{background:rgba(255,255,255,.2)}
`;

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v);
      }
    }
    kids.forEach((kid) => kid && el.append(kid));
    return el;
  }

  function buildWidget() {
    if (!document.documentElement || document.getElementById('igds-root')) return;

    const host = document.createElement('div');
    host.id = 'igds-root';
    const shadow = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(WIDGET_CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch (_) {
      shadow.appendChild(h('style', { text: WIDGET_CSS }));
    }

    const pill = h('button', { class: 'pill', type: 'button', title: 'Instagram Data Saver' });
    const opts = h('div', { role: 'radiogroup', 'aria-label': 'Video quality' });
    const sw = h('button', {
      class: 'sw', type: 'button', role: 'switch',
      title: 'On: videos load automatically. Off: click "Load video" on each one.',
      onclick: (e) => {
        e.currentTarget.blur();
        setAutoLoad(!state.autoLoad);
      },
    });
    const seen = h('div', { class: 'foot' });
    const stat = h('div', { class: 'foot' });
    const reload = h('button', { class: 'reload', type: 'button', text: 'Reload to apply', onclick: () => location.reload() });
    const held = h('button', { class: 'held', type: 'button', title: 'Load every video currently held back', onclick: () => releaseAll() });

    const panel = h('div', { class: 'panel' },
      h('div', { class: 'title', text: 'Video quality' }),
      opts,
      h('div', { class: 'sep' }),
      h('div', { class: 'row' }, h('span', { text: 'Auto-load videos' }), sw),
      held,
      h('div', { class: 'sep' }),
      seen, stat, reload);
    const root = h('div', { class: 'root' }, pill, panel);
    shadow.appendChild(root);

    pill.addEventListener('click', () => root.classList.toggle('open'));
    document.addEventListener('click', (e) => {
      if (!e.composedPath().includes(host)) root.classList.remove('open');
    });

    function render() {
      pill.textContent = labelFor(state.quality, false) + (state.autoLoad ? '' : ' \u00b7 Manual');
      opts.textContent = '';
      qualityOptions().forEach((o) => {
        const checked = o.id === state.quality;
        opts.append(h('button', {
          class: 'opt', type: 'button', role: 'radio', 'aria-checked': String(checked), title: o.hint,
          onclick: (e) => {
            e.currentTarget.blur();
            setQuality(o.id);
          },
        }, h('span', { class: 'dot' }), h('span', { text: o.label })));
      });
      sw.setAttribute('aria-checked', String(state.autoLoad));
      seen.textContent = state.tiers.length
        ? 'Seen: ' + state.tiers.map((t) => t + 'p').join(' \u00b7 ')
        : 'Seen: no videos yet';
      stat.textContent = isActive() && stats.adjusted ? stats.adjusted + ' filtered this session' : '';
      stat.style.display = stat.textContent ? 'block' : 'none';
      const n = state.autoLoad ? 0 : heldCount();
      held.textContent = 'Load ' + n + ' held video' + (n === 1 ? '' : 's');
      held.style.display = n ? 'block' : 'none';
      reload.style.display = dirty ? 'block' : 'none';
    }

    listeners.add(render);
    render();
    document.documentElement.appendChild(host);
  }

  /* ====================================================================== *
   *  Boot
   * ====================================================================== */

  function whenRoot(fn) {
    if (document.documentElement) return fn();
    new MutationObserver((_, obs) => {
      if (document.documentElement) {
        obs.disconnect();
        fn();
      }
    }).observe(document, { childList: true });
  }

  function injectGatedStyles() {
    if (document.getElementById('igds-gated-style')) return;
    const s = document.createElement('style');
    s.id = 'igds-gated-style';
    s.textContent = `
      [data-igds-gated] [aria-label*="Play" i],
      [data-igds-gated] [aria-label*="play" i],
      [data-igds-gated] svg[aria-label*="Play" i],
      [data-igds-gated] [data-visualcompletion="loading-state"] {
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  whenRoot(() => {
    buildWidget();
    injectGatedStyles();
    new MutationObserver(() => {
      if (gate.active.size) schedule();
    }).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    window.addEventListener('resize', schedule, { passive: true });
  });

  setInterval(() => {
    buildWidget(); // re-attach if the page ever drops it
    injectGatedStyles();
    if (gate.active.size) mountOverlays();
  }, 600);

  // Keep several tabs in sync.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORE_KEY) return;
    const prevQuality = state.quality;
    const prevAuto = state.autoLoad;
    loadState();
    if (state.quality !== prevQuality) dirty = true;
    if (!prevAuto && state.autoLoad) releaseAll();
    emit();
  });

  log('loaded', JSON.stringify(state));
})();
