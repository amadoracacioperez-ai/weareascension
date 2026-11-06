/* The rise: the first scroll climbs the building up to the office, where the form is.
   The scroll through the tall .rise section picks the frame: every frame of the video (its own 24 a second) as a WebP,
   drawn on a canvas that covers the whole screen, behind the whole page. Each scene has two sets, and the screen's shape
   picks one (and swaps it when the phone turns or the window changes shape):
   - tall (9:16, assets/scenes/<scene>/001.webp …), for a screen taller than wide: phones;
   - wide (16:9, assets/scenes/<scene>/wide/001.webp …), for a screen wider than tall: computers.
   What keeps it smooth:
   - no decoding at draw time. Every frame is fetched once and kept compressed (10 to 25 MB); the frames near the
     picture are decoded ahead, off the main thread (createImageBitmap), and let go once the picture has moved on.
     Drawing a plain <img> instead made the browser decode the WebP on the main thread at every draw: that was the lag;
   - the canvas has the frames' own size, so each draw is a straight copy, and the graphics card stretches it over the
     screen (object-fit: cover in the CSS). No blurred copies, no filters;
   - the picture follows the scroll with a little inertia, so the steps of a mouse wheel turn into one glide, and each
     frame is blended with the next one that is ready;
   - an even pace: the video crawls past the top of the tower and rushes through the window, so the climb is mapped to
     the video through a pace table measured from the frames (PACE, written by `npm run ritmo`);
   - no stall when the visitor lets go: the page carries the climb on from the visitor's own speed, at a steady pace,
     brakes into the office and slides the form in. It does not wait for the scroll to stop and start again from rest.
     Lifting the finger, a trackpad glide dying out, or a still scroll is letting go. Scrolling back, a touch, a click
     or a key gives the scroll back to the visitor. Inside the climb the page itself does not move, so the scroll can
     catch up with the picture unseen; after a finger, it waits for the browser's own glide to end first (iOS ignores
     a scripted scroll during it);
   - nothing is drawn when the picture would not change.
   The Start buttons climb the same way; the Skip button and the skip link jump.
   Scenes: ?scene=burj (the default) or ?scene=empire.
   Reduced motion: no climb, no inertia and no carrying on; the first frame, and the office once the form is in view.
   Without this script: the first frame as a still picture, a one-screen hero and the form right below it. */
(function () {
  'use strict';

  var SETS = { tall: '', wide: 'wide/' };  // the folder of each set inside the scene's
  var DEFAULT_SCENE = 'burj';
  var LOADING_AT_ONCE = 8;
  var DECODING_AT_ONCE = 4;
  var AHEAD = 16, BEHIND = 6, MARGIN = 3; // frames kept decoded ahead (the way the picture moves) and behind; 3.7 MB each
  var FOLLOW = 0.2;              // share of the gap to the scroll that the picture closes in each 60 Hz frame
  var BLEND_STEPS = 24;          // a blend changes in steps this fine, so a still scroll draws nothing
  var ASSIST_FROM = 0.015;       // below this the visitor has not started climbing: no carrying on
  var CRUISE = 0.4;              // the page's own pace, in shares of the climb a second: all of it in 2.5 s
  var CRUISE_SETTLE_MS = 300;    // how soon the speed settles from the visitor's to the cruise
  var BRAKE = 1.2;               // how hard it brakes into the office, in shares of the climb a second, a second
  var LAND_FROM = 0.97;          // from here on the page slides the form in
  var IDLE_MS = 140;             // a scroll still for this long, with no finger or button down: the visitor let go
  var SYNC_AFTER_MS = 90;        // after a finger, the browser's own glide must be over this long before a scripted scroll
  var OFFICE_FROM = 0.9;         // from here on (a share of the video) the camera is in the office

  // The frames of each set (each video has its own), and its pace: for 25 evenly spaced points of the video, the share
  // of the climb at which the picture reaches them. Both come from the frames, through scripts/pace.js: run
  // `npm run ritmo` again whenever they change (`npm run fotogramas` does).
  // pace:start (npm run ritmo writes this block)
  var SCENES = {
    burj: { tall: 190, wide: 193 },
    empire: { tall: 192, wide: 192 },
  };
  var PACE = {
    burj: {
      tall: [0, 0.0142, 0.0284, 0.0425, 0.0567, 0.0738, 0.1112, 0.1546, 0.1934, 0.2268, 0.2628, 0.3023, 0.3441, 0.3924, 0.4502, 0.5127, 0.5732, 0.6287, 0.6892, 0.7628, 0.8331, 0.8828, 0.9251, 0.9635, 1],
      wide: [0, 0.0179, 0.0358, 0.0544, 0.0739, 0.0944, 0.1164, 0.1418, 0.1739, 0.2132, 0.2639, 0.3172, 0.3658, 0.4055, 0.4434, 0.4852, 0.5357, 0.5921, 0.6577, 0.7416, 0.8276, 0.8991, 0.9487, 0.977, 1],
    },
    empire: {
      tall: [0, 0.0153, 0.0352, 0.0586, 0.0844, 0.1116, 0.139, 0.1664, 0.1965, 0.2298, 0.2673, 0.308, 0.3463, 0.3787, 0.4139, 0.4545, 0.504, 0.5627, 0.6307, 0.7161, 0.8169, 0.8976, 0.9481, 0.9808, 1],
      wide: [0, 0.0181, 0.0397, 0.0651, 0.0948, 0.1281, 0.1635, 0.1995, 0.2344, 0.2715, 0.3092, 0.3465, 0.3819, 0.4181, 0.4574, 0.4979, 0.5494, 0.62, 0.7085, 0.7933, 0.8535, 0.9006, 0.9395, 0.9731, 1],
    },
  };
  // pace:end

  var html = document.documentElement;
  var canvas = document.querySelector('.scene__canvas');
  var poster = document.querySelector('.scene__poster');
  var posterWide = document.querySelector('.scene__poster-wide');
  var rise = document.querySelector('.rise');
  var contact = document.getElementById('contact');
  var skipBtn = document.querySelector('.rise__skip');
  if (!canvas || !canvas.getContext || !rise || !contact || !window.fetch) return;

  var param = new URLSearchParams(location.search).get('scene');
  var scene = Object.prototype.hasOwnProperty.call(SCENES, param) ? param : DEFAULT_SCENE;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var wideScreen = window.matchMedia('(min-aspect-ratio: 1/1)'); // the same test as the poster's <source>
  var set = wideScreen.matches ? 'wide' : 'tall';
  var count = SCENES[scene][set];
  var pace = paceOf(set);
  var ctx = canvas.getContext('2d', { alpha: false });

  // Read by the tests, and handy in the console. loaded: frames fetched; decoded: frames ready to draw right now.
  // flying: the page is carrying the climb on or scrolling to the form. assist: whether it carries the climb on when
  // the visitor lets go; the tests turn it off to stand still half way up. frameAt(p): the frame at p of the climb.
  var state = window.__rise = {
    scene: scene, set: set, frames: count, loaded: 0, decoded: 0, drawn: -1, draws: 0, progress: 0, shown: 0,
    phase: 'start', flying: false, assist: true, frameAt: frameAt
  };
  html.dataset.scene = scene;

  function src(i, which) {
    return 'assets/scenes/' + scene + '/' + SETS[which || set] + String(i + 1).padStart(3, '0') + '.webp';
  }
  // The poster is a <picture>: the browser itself picks the tall or the wide first frame, even without this script.
  if (poster && poster.getAttribute('src') !== src(0, 'tall')) poster.setAttribute('src', src(0, 'tall'));
  if (posterWide && posterWide.getAttribute('srcset') !== src(0, 'wide')) posterWide.setAttribute('srcset', src(0, 'wide'));

  /* ---------- the pace: from the climb to the video ---------- */

  function paceOf(which) {
    var knots = PACE[scene] && PACE[scene][which];
    return knots && knots.length > 1 ? knots : [0, 1];
  }

  // The share of the video shown at p of the climb (both from 0 to 1).
  function videoAt(p) {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    var n = pace.length - 1;
    var j = 0;
    while (j < n - 1 && pace[j + 1] < p) j++;
    return (j + (p - pace[j]) / (pace[j + 1] - pace[j])) / n;
  }

  function frameAt(p) { return videoAt(p) * (count - 1); }

  /* ---------- fetching: the ends, then halving the gaps (so a rough climb works early), and what is just ahead ---------- */

  function loadingOrder(n) {
    var out = [0, n - 1];
    var taken = {};
    taken[0] = taken[n - 1] = true;
    for (var step = Math.pow(2, Math.ceil(Math.log(n) / Math.LN2)); step >= 1; step /= 2) {
      for (var i = 0; i < n; i += step) {
        if (!taken[i]) { taken[i] = true; out.push(i); }
      }
    }
    return out;
  }

  var queue, active, asked, blobs, bitmaps, pending, decoding, aheadTurn;
  var generation = 0; // goes up when the set changes, so what was still arriving for the old set is dropped

  function startSet() {
    queue = reduced ? [0, count - 1] : loadingOrder(count);
    active = 0;
    asked = [];    // frames requested
    blobs = [];    // the compressed frames: all of them, once they arrive
    bitmaps = [];  // the decoded frames: only those near the picture
    pending = [];  // frames being decoded right now
    decoding = 0;
    aheadTurn = false;
    state.loaded = 0;
    state.decoded = 0;
  }
  startSet();

  // The screen changed shape: the other set. The poster (already the right one) shows until its frames are ready.
  function useSet(which) {
    if (which === set) return;
    generation++;
    for (var i = 0; i < count; i++) if (bitmaps[i] && bitmaps[i].close) bitmaps[i].close();
    set = state.set = which;
    count = state.frames = SCENES[scene][set];
    pace = paceOf(set);
    startSet();
    lastDrawn = '';
    keptAround = -1;
    canvas.dataset.state = '';
    pump();
  }

  // The first frame not yet asked for just ahead of the picture.
  function missingAhead() {
    var c = centre();
    for (var d = 0; d <= AHEAD; d++) {
      var i = c + dir * d;
      if (i >= 0 && i < count && !asked[i]) return i;
    }
    return -1;
  }

  // Turn about: a frame just ahead of the picture, then the next one of the loading order.
  function nextToLoad() {
    if (!reduced && aheadTurn) {
      var a = missingAhead();
      if (a >= 0) { aheadTurn = false; return a; }
    }
    aheadTurn = true;
    while (queue.length) {
      var q = queue.shift();
      if (!asked[q]) return q;
    }
    return reduced ? -1 : missingAhead();
  }

  function pump() {
    while (active < LOADING_AT_ONCE) {
      var i = nextToLoad();
      if (i < 0) return;
      load(i);
    }
  }

  function load(i) {
    var gen = generation;
    asked[i] = true;
    active++;
    fetch(src(i)).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.blob();
    }).then(function (blob) {
      if (gen !== generation) return;
      blobs[i] = blob;
      state.loaded++;
      active--;
      keepNear();
      pump();
    }, function () {
      if (gen !== generation) return;
      active--;
      pump();
    });
  }

  /* ---------- decoding: off the main thread, only near the picture ---------- */

  function decode(blob) {
    if (window.createImageBitmap) return createImageBitmap(blob);
    return new Promise(function (resolve, reject) { // older browsers: an image, decoded ahead as well as they can
      var img = new Image();
      var url = URL.createObjectURL(blob);
      img.onload = function () {
        URL.revokeObjectURL(url);
        if (img.decode) img.decode().then(function () { resolve(img); }, function () { resolve(img); }); else resolve(img);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  var dir = 1; // the way the picture last moved: 1 up the building, -1 back down

  function centre() { return Math.round(frameAt(shown)); }

  // The first and last frames always stay: the foot of the building and the office are where jumps land.
  function wantedNear(i, c) {
    if (i === 0 || i === count - 1) return true;
    var d = (i - c) * dir;
    return d >= -(BEHIND + MARGIN) && d <= AHEAD + MARGIN;
  }

  function release(i) {
    if (bitmaps[i].close) bitmaps[i].close();
    bitmaps[i] = null;
    state.decoded--;
  }

  function tryDecode(i) {
    if (i < 0 || i >= count || decoding >= DECODING_AT_ONCE) return;
    if (!blobs[i] || bitmaps[i] || pending[i]) return;
    var gen = generation;
    pending[i] = true;
    decoding++;
    decode(blobs[i]).then(function (bmp) {
      if (gen !== generation) { if (bmp.close) bmp.close(); return; }
      pending[i] = false;
      decoding--;
      if (!wantedNear(i, centre())) {
        if (bmp.close) bmp.close(); // the picture moved on while this one decoded
      } else {
        // The canvas takes the frames' own size, so drawing is a copy and never a resize.
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        bitmaps[i] = bmp;
        state.decoded++;
        lastDrawn = ''; // a closer frame may be ready now
        schedule();
      }
      keepNear();
    }, function () {
      if (gen !== generation) return;
      pending[i] = false;
      decoding--;
    });
  }

  var keptAround = -1;
  function keepNear() {
    var c = centre();
    if (c !== keptAround) {
      if (keptAround >= 0) dir = c > keptAround ? 1 : -1;
      keptAround = c;
      for (var i = 0; i < count; i++) if (bitmaps[i] && !wantedNear(i, c)) release(i);
    }
    // The frame on screen and the next; then every other frame ahead (a fast climb only shows some of them anyway),
    // the rest ahead, and those behind. The two ends last.
    var d;
    tryDecode(c);
    tryDecode(c + dir);
    for (d = 2; d <= AHEAD; d += 2) tryDecode(c + dir * d);
    for (d = 3; d <= AHEAD; d += 2) tryDecode(c + dir * d);
    for (d = 1; d <= BEHIND; d++) tryDecode(c - dir * d);
    tryDecode(0);
    tryDecode(count - 1);
  }

  /* ---------- drawing ---------- */

  var lastDrawn = '';

  function below(i) { for (var j = i; j >= 0; j--) if (bitmaps[j]) return j; return -1; }
  function above(i) { for (var j = i; j < count; j++) if (bitmaps[j]) return j; return -1; }

  // Draws the climb at p (0 at the foot of the building, 1 in the office): the nearest decoded frame on each side,
  // blended by how close the picture is to each.
  function draw(p) {
    var f = frameAt(p);
    var a = Math.floor(f);
    var A = below(a);
    var B = above(Math.min(count - 1, a + 1));
    if (A < 0 && B < 0) return; // nothing ready yet: the poster stays
    if (A < 0) A = B;
    if (B < 0) B = A;
    var t = B === A ? 0 : Math.round(Math.min(1, Math.max(0, (f - A) / (B - A))) * BLEND_STEPS) / BLEND_STEPS;
    if (t >= 1) { A = B; t = 0; }
    if (t === 0) B = A;
    var key = A + ':' + B + ':' + t;
    if (key === lastDrawn) return;
    lastDrawn = key;
    ctx.globalAlpha = 1;
    ctx.drawImage(bitmaps[A], 0, 0);
    if (t > 0) {
      ctx.globalAlpha = t;
      ctx.drawImage(bitmaps[B], 0, 0);
      ctx.globalAlpha = 1;
    }
    state.drawn = t >= 0.5 ? B : A;
    state.draws++;
    if (canvas.dataset.state !== 'ready') canvas.dataset.state = 'ready';
  }

  /* ---------- the hero steps back as the climb starts ---------- */

  var texts = Array.prototype.slice.call(document.querySelectorAll('.rise [data-from]')).map(function (el) {
    return { el: el, from: Number(el.dataset.from), to: Number(el.dataset.to), o: '' };
  });

  function smooth(a, b, x) {
    var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  function overlays(p) {
    texts.forEach(function (it) {
      var fade = 0.05;
      var o = it.from <= 0
        ? 1 - smooth(it.to - fade, it.to, p)
        : Math.min(smooth(it.from, it.from + fade, p), 1 - smooth(it.to - fade, it.to, p));
      var os = o.toFixed(3);
      if (os === it.o) return; // nothing to change: no style work
      it.o = os;
      it.el.style.opacity = os;
      it.el.style.transform = 'translate3d(0,' + ((1 - o) * (p < it.from + fade ? 16 : -16)).toFixed(1) + 'px,0)';
      it.el.style.visibility = o < 0.01 ? 'hidden' : 'visible';
    });
  }

  /* ---------- the scroll: where we are on the climb ---------- */

  var start = 0, end = 1;
  var wanted = 0;    // where the scroll is on the climb
  var shown = 0;     // where the picture is: it follows wanted with a little inertia, or the page carries it on
  var speed = 0;     // how fast the picture moves, in shares of the climb a second
  var scrollSpeed = 0, lastScrollY = window.scrollY; // how fast the page scrolls, in pixels a second
  var req = 0, lastTime = 0;
  var carry = null;  // the page carrying the climb on: { speed, landing, arrive }
  var flight = 0;    // the page scrolling on its own (to the form)

  function setPhase(phase) {
    if (state.phase === phase) return;
    state.phase = phase;
    html.dataset.phase = phase;
  }

  function climbY(p) { return start + (end - start) * p; }

  function tick(now) {
    req = 0;
    var dt = lastTime ? Math.min(100, Math.max(1, now - lastTime)) : 16.7;
    lastTime = now;
    var before = shown;
    var gap = wanted - shown;
    var next = reduced || Math.abs(gap) < 0.0004 ? wanted : shown + gap * (1 - Math.pow(1 - FOLLOW, dt / 16.7));
    if (carry && shown < 1) {
      // The visitor's own glide leads while it is faster; then the page keeps the pace and brakes into the office.
      carry.speed += (CRUISE - carry.speed) * (1 - Math.exp(-dt / CRUISE_SETTLE_MS));
      carry.speed = Math.min(carry.speed, Math.sqrt(2 * BRAKE * (1 - shown)) + 0.02);
      next = Math.min(1, Math.max(next, shown + carry.speed * dt / 1000));
      if (1 - next < 0.0004) next = 1;
      carry.speed = Math.max(carry.speed, (next - shown) * 1000 / dt);
    }
    shown = state.shown = next;
    speed = (shown - before) * 1000 / dt;
    var y = window.scrollY;
    scrollSpeed = 0.5 * scrollSpeed + 0.5 * (y - lastScrollY) * 1000 / dt;
    lastScrollY = y;
    if (carry) followPicture(now);
    else maybeCarry(now);
    keepNear();
    draw(shown);
    if (!reduced) overlays(shown);
    html.classList.toggle('at-top', videoAt(shown) >= OFFICE_FROM);
    // Starting to carry the climb on, or a flight, may have asked for the next frame already: ask only once.
    if (shown !== wanted || carry || flight || Math.abs(scrollSpeed) > 1) { if (!req) req = requestAnimationFrame(tick); }
    else if (!req) { lastTime = 0; speed = 0; scrollSpeed = 0; }
  }

  function schedule() {
    if (!req) req = requestAnimationFrame(tick);
  }

  function measure() {
    start = rise.getBoundingClientRect().top + window.scrollY;
    end = Math.max(start + 1, start + rise.offsetHeight - window.innerHeight);
    update();
  }

  function update() {
    var p;
    if (reduced) {
      // No climb: the office once the form is half way up the screen.
      p = contact.getBoundingClientRect().top < window.innerHeight * 0.5 ? 1 : 0;
    } else {
      p = Math.min(1, Math.max(0, (window.scrollY - start) / (end - start)));
    }
    state.progress = p;
    wanted = p;
    setPhase(p < ASSIST_FROM ? 'start' : p >= 0.995 ? 'top' : 'rising');
    schedule();
  }

  /* ---------- the visitor: fingers, wheels, buttons and keys ---------- */

  var touching = false, mouseHeld = false, lastInput = '';
  var released = false;        // the visitor let go: lifted the finger, or a wheel glide is dying out
  var lastVisitorScroll = 0;   // when the visitor last moved the scroll
  var cancelledAt = 0;         // when the visitor last took the scroll back
  var lastDir = 0;             // the way the visitor last scrolled: 1 down the page (up the building), -1 back
  var ownY = -1;               // where the page's own last scroll put it: its scroll event is not the visitor's
  var lastWheel = 0, wheelDecay = 0, idle = 0;

  function contactTop() {
    return contact.getBoundingClientRect().top + window.scrollY;
  }

  function scrollOwn(y) {
    window.scrollTo({ top: y, behavior: 'instant' });
    ownY = window.scrollY;
  }

  // The visitor takes the scroll back. If the picture was ahead of the scroll (a finger's glide was still on), the scroll
  // goes where the picture is first, so nothing jumps back.
  function cancel() {
    clearTimeout(idle);
    if (flight) cancelAnimationFrame(flight);
    flight = 0;
    if (carry && shown < 1 && climbY(shown) > window.scrollY + 1) scrollOwn(climbY(shown));
    carry = null;
    released = false;
    wheelDecay = 0;
    cancelledAt = performance.now();
    state.flying = false;
  }

  function letGo(now) {
    if (touching || mouseHeld) return false;
    return released || now - lastVisitorScroll >= IDLE_MS;
  }

  // Carry the climb on once the visitor has let go on the way up and the picture is slower than the page's own pace.
  function maybeCarry(now) {
    if (carry || flight || reduced || !state.assist) return;
    if (lastDir <= 0 || lastVisitorScroll <= cancelledAt || state.progress <= ASSIST_FROM) return;
    if (!letGo(now)) return;
    if (shown < 1) {
      if (speed < CRUISE) startCarry(Math.max(0, speed), false);
    } else if (now - lastVisitorScroll >= IDLE_MS) {
      // Let go between the office and the form: slide the form the rest of the way in.
      var y = contactTop();
      if (window.scrollY < y - 2) flyTo(y, 500 + 0.4 * (y - window.scrollY), Math.max(0, scrollSpeed));
    }
  }

  function startCarry(from, arriveAfter) {
    if (flight) cancelAnimationFrame(flight);
    flight = 0;
    clearTimeout(idle);
    carry = { speed: from, landing: false, arrive: arriveAfter };
    state.flying = true;
    schedule();
  }

  // While the page carries the climb on: the scroll keeps up with the picture (unseen: the page does not move inside the
  // climb), and near the office the form slides in.
  function followPicture(now) {
    if (carry.landing || touching || mouseHeld) return;
    if (lastInput === 'touch' && now - lastVisitorScroll < SYNC_AFTER_MS) return; // the browser's own glide is still on
    var y = climbY(shown);
    if (y > window.scrollY + 0.5) scrollOwn(y);
    if (shown < LAND_FROM || window.scrollY < climbY(LAND_FROM) - 2) return;
    var to = contactTop();
    if (window.scrollY >= to - 2) { carry = null; state.flying = false; return; } // the visitor went past the form
    carry.landing = true;
    var then = carry.arrive ? arrive : null;
    flyTo(to, 500 + 0.4 * (to - window.scrollY), Math.max(0, scrollSpeed), function () {
      carry = null;
      if (then) then();
    });
  }

  // Scrolls to y in ms, starting at v0 pixels a second and coming to rest there (a cubic Hermite curve, which never
  // overshoots with the starting speed capped).
  function flyTo(y, ms, v0, then) {
    if (flight) cancelAnimationFrame(flight);
    var from = window.scrollY;
    var dist = y - from;
    var m = dist > 0 ? Math.min(3 * dist, Math.max(0, (v0 || 0) * ms / 1000)) : 0;
    var t0 = performance.now();
    state.flying = true;
    function step(now) {
      var s = Math.min(1, (now - t0) / ms);
      scrollOwn(from + (s * s * s - 2 * s * s + s) * m + (3 * s * s - 2 * s * s * s) * dist);
      if (s < 1) {
        flight = requestAnimationFrame(step);
        return;
      }
      flight = 0;
      if (then) then();
      if (!carry) state.flying = false;
    }
    flight = requestAnimationFrame(step);
    schedule();
  }

  function arrive() {
    var title = document.getElementById('contact-title');
    if (title) title.focus({ preventScroll: true });
  }

  function jump() {
    cancel();
    scrollOwn(contactTop());
    arrive();
  }

  window.addEventListener('touchstart', function (event) {
    touching = true;
    lastInput = 'touch';
    if (event.touches.length) cancel();
  }, { passive: true });
  function touchOver(event) {
    if (event.touches.length) return;
    touching = false;
    if (lastDir > 0) released = true;
    schedule();
  }
  window.addEventListener('touchend', touchOver, { passive: true });
  window.addEventListener('touchcancel', touchOver, { passive: true });

  // A trackpad's glide sends shrinking steps: a few in a row and the visitor has let go. A step back is taking over.
  window.addEventListener('wheel', function (event) {
    lastInput = 'wheel';
    var d = event.deltaY;
    if (d < 0) { cancel(); lastWheel = 0; return; }
    if (d < lastWheel - 0.01) wheelDecay++;
    else if (d > lastWheel + 0.01) wheelDecay = 0;
    lastWheel = d;
    released = wheelDecay >= 4;
  }, { passive: true });

  window.addEventListener('mousedown', function () { mouseHeld = true; lastInput = 'mouse'; cancel(); }, { passive: true });
  window.addEventListener('mouseup', function () { mouseHeld = false; schedule(); }, { passive: true });
  window.addEventListener('keydown', function () { lastInput = 'key'; cancel(); }, { passive: true });

  window.addEventListener('scroll', function () {
    var y = window.scrollY;
    var mine = Math.abs(y - ownY) < 1;
    if (!mine) {
      ownY = -1;
      if (y > lastY + 0.5) lastDir = 1;
      else if (y < lastY - 0.5) lastDir = -1;
      lastVisitorScroll = performance.now();
      clearTimeout(idle);
      if (!reduced) idle = setTimeout(function () { maybeCarry(performance.now()); }, IDLE_MS + 10);
    }
    lastY = y;
    update();
  }, { passive: true });
  var lastY = window.scrollY;

  // Links to the form climb there. The skip link (and every link under reduced motion) jumps at once, as it should.
  document.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('a[href="#contact"]');
    if (!link) return;
    event.preventDefault();
    if (link.classList.contains('skip') || reduced) { jump(); return; }
    if (shown < LAND_FROM && window.scrollY < end) { startCarry(0, true); return; }
    var y = contactTop();
    flyTo(y, Math.min(1800, 600 + 0.5 * Math.abs(y - window.scrollY)), 0, arrive);
  });

  if (skipBtn) skipBtn.addEventListener('click', jump);

  window.addEventListener('resize', measure);
  function onShape() { useSet(wideScreen.matches ? 'wide' : 'tall'); }
  if (wideScreen.addEventListener) wideScreen.addEventListener('change', onShape);
  else if (wideScreen.addListener) wideScreen.addListener(onShape);
  window.addEventListener('load', measure);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);

  measure();
  pump();
  window.__riseReady = true; // tells the inline fail-open check in <head> that this script ran
}());
