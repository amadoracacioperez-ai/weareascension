/* The rise: the first scroll climbs the building up to the office, where the form is.
   The scroll through the tall .rise section picks the frame: 96 WebP frames a scene, drawn on a canvas that covers the
   whole screen, behind the whole page. Each scene has two sets, and the screen's shape picks one (and swaps it when
   the phone turns or the window changes shape):
   - tall (9:16, assets/scenes/<scene>/001.webp …), for a screen taller than wide: phones;
   - wide (16:9, assets/scenes/<scene>/wide/001.webp …), for a screen wider than tall: computers.
   What keeps it smooth:
   - no decoding at draw time. Every frame is fetched once and kept compressed (about 5 MB); the frames near the picture
     are decoded ahead, off the main thread (createImageBitmap), and let go once the picture has moved on. Drawing a
     plain <img> instead made the browser decode the WebP on the main thread at every draw: that was the lag;
   - the canvas has the frames' own size, so each draw is a straight copy, and the graphics card stretches it over the
     screen (object-fit: cover in the CSS). No blurred copies, no filters;
   - the picture follows the scroll with a little inertia, so the steps of a mouse wheel turn into one glide;
   - each frame is blended with the next one that is ready, so 12 frames a second move like a film;
   - nothing is drawn when the picture would not change.
   If the visitor lets go on the way up, the page finishes the climb on its own: a short eased flight, cancelled by any
   wheel, touch, click or key. The header and hero buttons fly to the form too; the Skip button and the skip link jump.
   Scenes: ?scene=burj (the default) or ?scene=empire.
   Reduced motion: no climb, no inertia and no flight; the first frame, and the office once the form is in view.
   Without this script: the first frame as a still picture, a one-screen hero and the form right below it. */
(function () {
  'use strict';

  var SCENES = { burj: 96, empire: 96 }; // frames in each set of assets/scenes/<scene>/
  var SETS = { tall: '', wide: 'wide/' }; // the folder of each set inside the scene's
  var DEFAULT_SCENE = 'burj';
  var LOADING_AT_ONCE = 6;
  var DECODING_AT_ONCE = 4;
  var KEEP = 10;                         // frames kept decoded on each side of the picture (about 3.7 MB each)
  var FOLLOW = 0.16;                     // share of the gap to the scroll that the picture closes in each 60 Hz frame
  var BLEND_STEPS = 24;                  // a blend changes in steps this fine, so a still scroll draws nothing
  var ASSIST_AFTER_MS = 160;             // the scroll is still for this long: the visitor has let go
  var ASSIST_FROM = 0.015, ASSIST_TO = 0.97;
  var OFFICE_FROM = 0.9;                 // from here on the camera is in the office

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
  var count = SCENES[scene];
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var wideScreen = window.matchMedia('(min-aspect-ratio: 1/1)'); // the same test as the poster's <source>
  var set = wideScreen.matches ? 'wide' : 'tall';
  var ctx = canvas.getContext('2d', { alpha: false });

  // Read by the tests, and handy in the console. loaded: frames fetched; decoded: frames ready to draw right now.
  // assist: whether the page finishes the climb on its own; the tests turn it off to stand still half way up.
  var state = window.__rise = {
    scene: scene, set: set, frames: count, loaded: 0, decoded: 0, drawn: -1, draws: 0, progress: 0, shown: 0,
    phase: 'start', flying: false, assist: true
  };
  html.dataset.scene = scene;

  function src(i, which) {
    return 'assets/scenes/' + scene + '/' + SETS[which || set] + String(i + 1).padStart(3, '0') + '.webp';
  }
  // The poster is a <picture>: the browser itself picks the tall or the wide first frame, even without this script.
  if (poster && poster.getAttribute('src') !== src(0, 'tall')) poster.setAttribute('src', src(0, 'tall'));
  if (posterWide && posterWide.getAttribute('srcset') !== src(0, 'wide')) posterWide.setAttribute('srcset', src(0, 'wide'));

  /* ---------- fetching: the first and last frames, then halving the gaps, so a rough climb works early ---------- */

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

  var queue, active, blobs, bitmaps, pending, decoding;
  var generation = 0; // goes up when the set changes, so what was still arriving for the old set is dropped

  function startSet() {
    queue = reduced ? [0, count - 1] : loadingOrder(count);
    active = 0;
    blobs = [];    // the compressed frames: all of them, once they arrive
    bitmaps = [];  // the decoded frames: only those near the picture
    pending = [];  // frames being decoded right now
    decoding = 0;
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
    startSet();
    lastDrawn = '';
    keptAround = -1;
    canvas.dataset.state = '';
    pump();
  }

  function pump() {
    while (active < LOADING_AT_ONCE && queue.length) load(queue.shift());
  }

  function load(i) {
    var gen = generation;
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

  function centre() { return Math.round(shown * (count - 1)); }

  // The first and last frames always stay: the foot of the building and the office are where jumps land.
  function wantedNear(i, c, reach) {
    return i === 0 || i === count - 1 || Math.abs(i - c) <= reach;
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
      if (!wantedNear(i, centre(), KEEP + 3)) {
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
      keptAround = c;
      for (var i = 0; i < count; i++) if (bitmaps[i] && !wantedNear(i, c, KEEP + 3)) release(i);
    }
    // The nearest first, then outwards; the two ends last.
    for (var d = 0; d <= KEEP && decoding < DECODING_AT_ONCE; d++) {
      tryDecode(c + d);
      if (d) tryDecode(c - d);
    }
    tryDecode(0);
    tryDecode(count - 1);
  }

  /* ---------- drawing ---------- */

  var lastDrawn = '';

  function below(i) { for (var j = i; j >= 0; j--) if (bitmaps[j]) return j; return -1; }
  function above(i) { for (var j = i; j < count; j++) if (bitmaps[j]) return j; return -1; }

  // Draws the climb at p (0 at the foot of the building, 1 in the office): the nearest decoded frame on each side,
  // blended by how close p is to each.
  function draw(p) {
    var f = p * (count - 1);
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

  /* ---------- the texts on the way up ---------- */

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
      // 'visible', not '': the lines start hidden in the CSS, and clearing the style would hide them again.
      it.el.style.visibility = o < 0.01 ? 'hidden' : 'visible';
    });
  }

  /* ---------- the scroll: where we are on the climb ---------- */

  var start = 0, end = 1;
  var wanted = 0;   // where the scroll is on the climb
  var shown = 0;    // where the picture is: it follows wanted with a little inertia
  var req = 0, lastTime = 0;

  function setPhase(phase) {
    if (state.phase === phase) return;
    state.phase = phase;
    html.dataset.phase = phase;
  }

  function tick(now) {
    req = 0;
    var dt = lastTime ? Math.min(100, now - lastTime) : 16.7;
    lastTime = now;
    var gap = wanted - shown;
    if (reduced || Math.abs(gap) < 0.0004) shown = wanted;
    else shown += gap * (1 - Math.pow(1 - FOLLOW, dt / 16.7));
    state.shown = shown;
    keepNear();
    draw(shown);
    if (!reduced) overlays(shown);
    html.classList.toggle('at-top', shown >= OFFICE_FROM);
    if (shown !== wanted) req = requestAnimationFrame(tick);
    else lastTime = 0;
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

  /* ---------- flights: finishing the climb, and the buttons that lead to the form ---------- */

  var flight = 0;
  var idle = 0;
  var lastY = window.scrollY;
  var flownTo = -1; // where the last flight step put the page: its scroll event must not start another flight

  function contactTop() {
    return contact.getBoundingClientRect().top + window.scrollY;
  }

  function ease(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function flyTo(y, ms, then) {
    cancelFlight();
    var from = window.scrollY;
    var t0 = performance.now();
    state.flying = true;
    function step(now) {
      var t = Math.min(1, (now - t0) / ms);
      window.scrollTo({ top: from + (y - from) * ease(t), behavior: 'instant' });
      flownTo = window.scrollY;
      if (t < 1) {
        flight = requestAnimationFrame(step);
      } else {
        flight = 0;
        state.flying = false;
        if (then) then();
      }
    }
    flight = requestAnimationFrame(step);
  }

  function cancelFlight() {
    clearTimeout(idle);
    if (flight) cancelAnimationFrame(flight);
    flight = 0;
    state.flying = false;
  }

  ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(function (type) {
    window.addEventListener(type, cancelFlight, { passive: true });
  });

  function arrive() {
    var title = document.getElementById('contact-title');
    if (title) title.focus({ preventScroll: true });
  }

  function jump() {
    cancelFlight();
    window.scrollTo({ top: contactTop(), behavior: 'instant' });
    arrive();
  }

  window.addEventListener('scroll', function () {
    var y = window.scrollY;
    var down = y > lastY;
    lastY = y;
    update();
    if (flight || reduced) return;
    // The page's own flight, landing after a click stopped it: not the visitor scrolling.
    if (Math.abs(y - flownTo) < 1) return;
    flownTo = -1;
    clearTimeout(idle);
    if (down && state.assist && state.progress > ASSIST_FROM && state.progress < ASSIST_TO) {
      idle = setTimeout(function () {
        if (flight) return;
        flyTo(contactTop(), 700 + 3000 * (1 - state.progress));
      }, ASSIST_AFTER_MS);
    }
  }, { passive: true });

  // Links to the form fly there. The skip link (and every link under reduced motion) jumps at once, as it should.
  document.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('a[href="#contact"]');
    if (!link) return;
    event.preventDefault();
    if (link.classList.contains('skip') || reduced) { jump(); return; }
    var distance = Math.abs(contactTop() - window.scrollY);
    flyTo(contactTop(), Math.min(4200, 900 + distance * 0.9), arrive);
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
