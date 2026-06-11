/* app.js — The Monkey Tree  v2
 * Live AR sky viewer. All astronomy uses the FIXED home coordinates.
 * GPS is used ONLY for the 30-foot geofence (the status line), never for sky math.
 */

"use strict";

/* ===================== CONFIG ===================== */
const HOME = {
  lat: 38.9636,      // degrees North
  lon: -76.4825,     // degrees West (negative)
  elevationM: 3,     // meters (~10 ft)
  label: "The Monkey Tree"
};
const GEOFENCE_M = 9.14; // 30 feet in meters

// TLE API (tle.ivanstanojevic.me): free, no account, no key — and unlike
// CelesTrak it sends CORS headers, so browsers are actually allowed to fetch it.
// (CelesTrak's endpoint has no Access-Control-Allow-Origin header, which made
// the in-browser satellite fetch fail silently.) First page = the most popular
// satellites: ISS, Tiangong, NOAA weather birds, etc.
const TLE_URL = "https://tle.ivanstanojevic.me/api/tle/?page-size=100";
const SAT_LIMIT = 60; // how many satellites to track

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/* ===================== STATE ===================== */
const state = {
  // Camera orientation is now stored as a full 3D basis (three world-space unit
  // vectors in East-North-Up coords), derived from the device rotation matrix.
  // This replaces the old heading/pitch/roll Euler angles, which couldn't
  // represent tilted poses correctly and made the horizon "tip over".
  camForward: { x: 0, y: 1, z: 0 }, // where the camera looks (default: north horizon)
  camRight:   { x: 1, y: 0, z: 0 }, // screen-right direction in the world
  camUp:      { x: 0, y: 0, z: 1 }, // screen-up direction in the world

  fov: 65,          // vertical field of view in degrees
  timeOffsetMin: 0, // time scrubber offset in minutes (0 = live)
  showLines: true,
  showLabels: true,

  satellites: [],   // {name, satrec}
  screenObjects: [] // objects currently drawn, for tap hit-testing
};

// FIX #1: manualLook is now properly checked in handleOrientation.
// When centerOn() sets this, handleOrientation() ignores sensor input until .until.
let manualLook = null;

/* ===================== DOM ===================== */
const canvas = document.getElementById("sky");
const ctx = canvas.getContext("2d");
const statusEl   = document.getElementById("status");
const titleEl    = document.getElementById("title");     // Change 1: dynamic header text
const greetingEl = document.getElementById("greeting");  // Change 2: time-aware greeting
const awayMsgEl  = document.getElementById("awayMsg");   // Change 3: "Come home" line
const moonLineEl = document.getElementById("moonLine");  // Change 4: moon info
const dockEl     = document.getElementById("dock");      // bottom control dock
let W = 0, H = 0, DPR = 1;
let dockHeight = 150; // height of the bottom dock, so the railing sits just above it

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2.5);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  dockHeight = (dockEl && dockEl.offsetHeight) || 150;
}
window.addEventListener("resize", resize);
resize();

/* ===================== TIME ===================== */
function currentDate() {
  return new Date(Date.now() + state.timeOffsetMin * 60000);
}

/* ===================== ASTRO HELPERS ===================== */
const observer = new Astronomy.Observer(HOME.lat, HOME.lon, HOME.elevationM);

function raDecToAltAz(raHours, decDeg, date) {
  const hor = Astronomy.Horizon(date, observer, raHours, decDeg, "normal");
  return { alt: hor.altitude, az: hor.azimuth };
}

// FIX #4: include name in the return value so showCard() can read it reliably.
function bodyAltAz(body, date) {
  const eq = Astronomy.Equator(body, date, observer, true, true);
  const hor = Astronomy.Horizon(date, observer, eq.ra, eq.dec, "normal");
  return { name: body, alt: hor.altitude, az: hor.azimuth, ra: eq.ra, dec: eq.dec, distAU: eq.dist };
}

/* ===================== ALT/AZ CACHE =====================
 * The star field is now ~2,900 real stars (HYG catalog) plus all 88
 * constellations and the real Milky Way outline — ~4,800 sky points total.
 * Calling Astronomy.Horizon() for each would stutter, so the cache converts
 * RA/Dec -> alt/az with direct sidereal-time math (pure trig, ~5 ms for all,
 * validated against Astronomy Engine to within 0.13° above the horizon) and
 * stores each point as a world-space unit VECTOR. Drawing then only needs
 * three dot products per point per frame — no trig at 60 fps.
 * Planets, Moon, Sun, and satellites still use the full-precision engine
 * every frame because they move visibly.
 */
const SLOW_CACHE = {
  lastUpdate: 0,
  intervalMs: 20000, // recompute slow objects every 20 seconds
  stars: [],         // [{v, alt}] world unit vector + altitude, parallel to STARS
  conLines: [],      // [{a:{v,alt}, b:{v,alt}}] per flattened constellation segment
  conLabels: [],     // [{v, alt}] parallel to CONSTELLATIONS
  milkyWay: []       // [[{v, alt}, ...]] one array per Milky Way contour ring
};

// alt/az + world unit vector from RA/Dec via local sidereal time.
// Includes Bennett refraction so stars sit exactly where Astronomy.Horizon puts
// the planets (both are displayed together — they must agree).
function fastSky(raH, decD, gastH) {
  const lstDeg = (gastH * 15 + HOME.lon) % 360;
  const Ha = (lstDeg - raH * 15) * DEG;
  const dec = decD * DEG, phi = HOME.lat * DEG;
  const sinD = Math.sin(dec), cosD = Math.cos(dec);
  const sinP = Math.sin(phi), cosP = Math.cos(phi);
  const E = -cosD * Math.sin(Ha);
  const N = sinD * cosP - cosD * Math.cos(Ha) * sinP;
  let  U = sinD * sinP + cosD * Math.cos(Ha) * cosP;
  let alt = Math.asin(Math.max(-1, Math.min(1, U))) * RAD;
  if (alt > -1) { // Bennett atmospheric refraction (arc-minutes -> degrees)
    alt += (1 / Math.tan((alt + 7.31 / (alt + 4.4)) * DEG)) / 60;
  }
  const az = Math.atan2(E, N); // radians, 0=N clockwise via atan2(E,N)
  const cosA = Math.cos(alt * DEG);
  return {
    alt,
    v: { x: cosA * Math.sin(az), y: cosA * Math.cos(az), z: Math.sin(alt * DEG) }
  };
}

function refreshSlowCache(date) {
  const now = Date.now();
  if (now - SLOW_CACHE.lastUpdate < SLOW_CACHE.intervalMs) return;
  SLOW_CACHE.lastUpdate = now;

  const gast = Astronomy.SiderealTime(date);

  // Stars (HYG catalog)
  SLOW_CACHE.stars = STARS.map(s => fastSky(s.ra, s.dec, gast));

  // Constellation line endpoints AND label positions
  SLOW_CACHE.conLines  = [];
  SLOW_CACHE.conLabels = [];
  for (const c of CONSTELLATIONS) {
    for (const seg of c.lines) {
      SLOW_CACHE.conLines.push({
        a: fastSky(seg[0][0], seg[0][1], gast),
        b: fastSky(seg[1][0], seg[1][1], gast)
      });
    }
    SLOW_CACHE.conLabels.push(fastSky(c.label[0], c.label[1], gast));
  }

  // Milky Way contour rings (real outline data)
  SLOW_CACHE.milkyWay = MILKYWAY.map(ring => ring.map(pt => fastSky(pt[0], pt[1], gast)));
}

// Project a cached world unit vector — three dot products, no trig.
function projectVec(v, allowOffscreen) {
  const xCam = dot(v, state.camRight);
  const yCam = dot(v, state.camUp);
  const zCam = dot(v, state.camForward);
  if (zCam <= 0.04) return null;
  const f = (H / 2) / Math.tan((state.fov * DEG) / 2);
  const px = W / 2 + (xCam / zCam) * f;
  const py = H / 2 - (yCam / zCam) * f;
  if (!allowOffscreen && (px < -80 || px > W + 80 || py < -80 || py > H + 80)) return null;
  return { x: px, y: py, depth: zCam };
}

/* ===================== PROJECTION =====================
 * Projects a sky direction (azimuth/altitude) onto the screen using the camera
 * basis in `state`. Roll is built into the basis, so there's no separate 2D
 * rotation and no zenith gimbal special-case any more.
 * allowOffscreen=true keeps points that fall just outside the screen (needed so
 * the horizon line and the foreground silhouette stay continuous at the edges).
 */
function project(az, alt, allowOffscreen) {
  const ta = az * DEG, te = alt * DEG;
  const tv = {
    x: Math.cos(te) * Math.sin(ta),
    y: Math.cos(te) * Math.cos(ta),
    z: Math.sin(te)
  };
  const xCam = dot(tv, state.camRight);
  const yCam = dot(tv, state.camUp);
  const zCam = dot(tv, state.camForward);

  if (zCam <= 0.04) return null; // behind the camera

  const f = (H / 2) / Math.tan((state.fov * DEG) / 2);
  const px = W / 2 + (xCam / zCam) * f;
  const py = H / 2 - (yCam / zCam) * f;

  if (!allowOffscreen && (px < -80 || px > W + 80 || py < -80 || py > H + 80)) return null;
  return { x: px, y: py, depth: zCam };
}

/* ---- Vector helpers ---- */
function cross(a, b) { return { x: a.y*b.z - a.z*b.y, y: a.z*b.x - a.x*b.z, z: a.x*b.y - a.y*b.x }; }
function dot(a, b)   { return a.x*b.x + a.y*b.y + a.z*b.z; }
function norm(a)     { return Math.sqrt(dot(a, a)); }
function normalize(a){ const n = norm(a) || 1; return { x: a.x/n, y: a.y/n, z: a.z/n }; }
function addVec(a, b){ return { x: a.x+b.x, y: a.y+b.y, z: a.z+b.z }; }
function scaleVec(a, s){ return { x: a.x*s, y: a.y*s, z: a.z*s }; }
function lerpVec(a, b, k){ return { x: a.x+(b.x-a.x)*k, y: a.y+(b.y-a.y)*k, z: a.z+(b.z-a.z)*k }; }

/* ===================== RENDER ===================== */
let _lastFrameAt = 0;
function render() {
  const now = performance.now();
  const dt = Math.min(0.1, _lastFrameAt ? (now - _lastFrameAt) / 1000 : 0.016);
  _lastFrameAt = now;
  applySmoothing(dt); // pull the camera toward the latest sensor reading

  const date = currentDate();
  ctx.clearRect(0, 0, W, H);

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#01030a");
  bg.addColorStop(1, "#04060f");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  state.screenObjects = [];

  // Refresh the slow cache (no-ops most frames; only recomputes every 20s)
  refreshSlowCache(date);

  drawHorizonGlow(); // soft glow at the horizon so the tree silhouette reads
  drawMilkyWay();
  if (state.showLines) drawConstellations();
  drawStars();
  drawPlanets(date);
  drawMoonAndSun(date);
  drawSatellites(date);
  drawForeground(); // tree silhouette (east-anchored) — drawn over low objects
  drawHorizon();    // horizon line + cardinal letters stay readable on top

  requestAnimationFrame(render);
}

/* ---- Stars (HYG catalog, vector cache, real B-V colors) ---- */
function drawStars() {
  const cache = SLOW_CACHE.stars;
  for (let i = 0; i < cache.length; i++) {
    const c = cache[i];
    if (c.alt < -1) continue;
    const p = projectVec(c.v);
    if (!p) continue;
    const s = STARS[i];

    // Size and brightness scale with magnitude (mag 0 ≈ 3px, mag 5.5 ≈ 0.55px)
    const r = Math.max(0.55, Math.min(3.6, 2.9 - s.mag * 0.46));
    const a = Math.max(0.22, Math.min(1, 1.18 - s.mag * 0.155));
    ctx.beginPath();
    ctx.fillStyle = s.col;          // real star tint from its B-V color index
    ctx.globalAlpha = a;
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    // Soft glow on the brightest stars so they pop like the real sky
    if (s.mag < 1.2) {
      ctx.globalAlpha = 0.16;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (s.name) {
      if (state.showLabels && s.mag < 2.5) {
        label(p.x + r + 3, p.y + 3, s.name, "rgba(244,244,246,0.82)", 11);
      }
      state.screenObjects.push({
        x: p.x, y: p.y, r: Math.max(r, 9), kind: "star", data: s,
        alt: c.alt, az: (Math.atan2(c.v.x, c.v.y) * RAD + 360) % 360
      });
    }
  }
}

/* ---- Constellation lines + labels (all 88, fully vector-cached) ---- */
function drawConstellations() {
  ctx.strokeStyle = "rgba(110,150,210,0.26)";
  ctx.lineWidth = 1;
  ctx.beginPath(); // one path for every segment — single stroke call
  let lineIdx = 0;
  for (let ci = 0; ci < CONSTELLATIONS.length; ci++) {
    const c = CONSTELLATIONS[ci];
    for (let si = 0; si < c.lines.length; si++) {
      const cached = SLOW_CACHE.conLines[lineIdx++];
      if (!cached) continue;
      const { a, b } = cached;
      if (a.alt < -5 && b.alt < -5) continue;
      const pa = projectVec(a.v);
      const pb = projectVec(b.v);
      if (!pa || !pb) continue;
      if (Math.hypot(pa.x - pb.x, pa.y - pb.y) > W * 0.9) continue;
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
    }
  }
  ctx.stroke();

  if (state.showLabels) {
    for (let ci = 0; ci < CONSTELLATIONS.length; ci++) {
      const lp = SLOW_CACHE.conLabels[ci];
      if (lp && lp.alt > 2) {
        const p = projectVec(lp.v);
        if (p) label(p.x, p.y, CONSTELLATIONS[ci].name, "rgba(150,180,235,0.62)", 11, true);
      }
    }
  }
}

/* ---- Planets ---- */
const PLANETS = [
  { body: "Mercury", color: "#c8b08a" },
  { body: "Venus",   color: "#fff2c2" },
  { body: "Mars",    color: "#ff8159" },
  { body: "Jupiter", color: "#ffd9a0" },
  { body: "Saturn",  color: "#f7e3a1" },
  { body: "Uranus",  color: "#aef0ff" },
  { body: "Neptune", color: "#9db9ff" }
];
function drawPlanets(date) {
  for (const pl of PLANETS) {
    const info = bodyAltAz(pl.body, date);
    if (info.alt < -2) continue;
    const p = project(info.az, info.alt);
    if (!p) continue;
    ctx.beginPath();
    ctx.fillStyle = pl.color;
    ctx.shadowColor = pl.color; ctx.shadowBlur = 8;
    ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    if (state.showLabels) label(p.x + 6, p.y + 4, pl.body, "var(--gold)", 12);
    state.screenObjects.push({
      x: p.x, y: p.y, r: 14, kind: "planet",
      data: info, alt: info.alt, az: info.az
    });
  }
}

/* ---- Moon + Sun ---- */
function drawMoonAndSun(date) {
  const m = bodyAltAz("Moon", date);
  if (m.alt > -3) {
    const p = project(m.az, m.alt);
    if (p) {
      ctx.beginPath();
      ctx.fillStyle = "#ececf2";
      ctx.shadowColor = "#dfe2ff"; ctx.shadowBlur = 14;
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (state.showLabels) label(p.x + 11, p.y + 4, "Moon", "var(--gold)", 12);
      state.screenObjects.push({ x: p.x, y: p.y, r: 18, kind: "moon", data: m, alt: m.alt, az: m.az });
    }
  }
  const s = bodyAltAz("Sun", date);
  if (s.alt > -3) {
    const p = project(s.az, s.alt);
    if (p) {
      ctx.beginPath();
      ctx.fillStyle = "#ffd86b";
      ctx.shadowColor = "#ffcf4d"; ctx.shadowBlur = 22;
      ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (state.showLabels) label(p.x + 13, p.y + 4, "Sun", "var(--gold)", 12);
      state.screenObjects.push({ x: p.x, y: p.y, r: 20, kind: "sun", data: s, alt: s.alt, az: s.az });
    }
  }
}

/* ---- Satellites ---- */
function drawSatellites(date) {
  if (!state.satellites.length || !window.satellite) return;
  const gmst = satellite.gstime(date);
  for (const sat of state.satellites) {
    let pv;
    try { pv = satellite.propagate(sat.satrec, date); } catch (e) { continue; }
    if (!pv || !pv.position) continue;
    const gd = satellite.eciToGeodetic(pv.position, gmst);
    const obsGd = {
      longitude: HOME.lon * DEG,
      latitude:  HOME.lat * DEG,
      height:    HOME.elevationM / 1000
    };
    const look = satellite.ecfToLookAngles(obsGd, satellite.eciToEcf(pv.position, gmst));
    const altDeg = look.elevation * RAD;
    const azDeg  = (look.azimuth * RAD + 360) % 360;
    if (altDeg < 0) continue;
    const p = project(azDeg, altDeg);
    if (!p) continue;
    const isISS = /ISS|ZARYA/i.test(sat.name);
    ctx.beginPath();
    ctx.fillStyle = isISS ? "#7CFC8A" : "#9fe3ff";
    ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = isISS ? 12 : 6;
    ctx.arc(p.x, p.y, isISS ? 4 : 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    const nm = isISS ? "ISS" : sat.name;
    if (state.showLabels && (isISS || altDeg > 25)) {
      label(p.x + 7, p.y + 4, nm, isISS ? "#7CFC8A" : "rgba(159,227,255,0.85)", isISS ? 12 : 10);
    }
    state.screenObjects.push({
      x: p.x, y: p.y, r: 14, kind: "satellite",
      data: { name: nm, alt: altDeg, az: azDeg, rangeKm: look.rangeSat, heightKm: gd.height },
      alt: altDeg, az: azDeg
    });
  }
}

/* ---- Milky Way band (uses cache) ---- */
/* ---- Milky Way: real outline contours (d3-celestial data) ----
 * MILKYWAY holds nested brightness contours of the actual galactic band.
 * Each ring is filled at low alpha; where contours nest (the dense core in
 * Sagittarius, the Cygnus rift edges) the fills stack into a brighter glow —
 * the same technique desktop planetarium software uses. */
function drawMilkyWay() {
  ctx.save();
  ctx.fillStyle = "rgba(165,180,225,0.040)";
  for (const ring of SLOW_CACHE.milkyWay) {
    // Skip rings entirely below the horizon or behind the camera
    let anyVisible = false;
    for (const pt of ring) {
      if (pt.alt > -2 && dot(pt.v, state.camForward) > 0.04) { anyVisible = true; break; }
    }
    if (!anyVisible) continue;

    ctx.beginPath();
    let started = false;
    for (const pt of ring) {
      const p = projectVec(pt.v, true);
      if (!p) { started = false; continue; } // behind camera → break the path
      if (!started) { ctx.moveTo(p.x, p.y); started = true; }
      else ctx.lineTo(p.x, p.y);
    }
    ctx.fill();
  }
  ctx.restore();
}

/* ---- Horizon + cardinal directions (precomputed vectors) ---- */
function drawHorizon() {
  ctx.strokeStyle = "rgba(120,140,170,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  let started = false;
  for (const v of HORIZON_PTS) {
    const p = projectVec(v, true); // allowOffscreen → continuous line at edges
    if (!p) { started = false; continue; }
    if (!started) { ctx.moveTo(p.x, p.y); started = true; }
    else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();

  for (const c of CARDINALS) {
    const p = projectVec(c.v);
    if (p) label(p.x, p.y - 4, c.name, "rgba(150,170,200,0.8)", 12, true);
  }
}

/* ===================== FOREGROUND (Option A overlay) =====================
 * A world-locked silhouette of Amanda's actual view: the real treeline anchored
 * due EAST (azimuth 90°) — two tree masses framing a low gap over the water —
 * cross-fading to a soft generic treeline in every other direction. Plus the
 * lit balcony railing along the bottom (you're behind it whichever way you face).
 */
const EAST_AZ = 90; // the balcony faces due east

/* ---- The REAL balcony photo, world-anchored at east ----
 * balcony.webp is the actual 9pm photo from the balcony (IMG_0265), night-graded,
 * with the sky cut to transparency above the far-shore treeline. It is rendered
 * as a cylindrical billboard: vertical strips pinned to fixed azimuth/altitude,
 * so the trees, marina and railing stay glued to their true compass positions
 * while the live stars rise through the transparent sky above them. */
const BALCONY = { az0: 52, az1: 128, altTop: 26, altBot: -30, strips: 14 };
const balconyImg = new Image();
let balconyReady = false;
balconyImg.onload = () => { balconyReady = true; };
balconyImg.src = "balcony.webp";

// Generic gentle treeline for every direction outside the photo span.
function horizonTopAlt(az) {
  return 2.5 + 1.1 * Math.sin(az * DEG * 3 + 0.7);
}

// True if an azimuth falls inside the photo's span (so the procedural
// silhouette must not double-draw behind the photo's transparent sky).
function inBalconySpan(az) {
  const d = ((az - EAST_AZ + 540) % 360) - 180;
  return Math.abs(d) <= (BALCONY.az1 - BALCONY.az0) / 2;
}

/* ---- Precomputed static world geometry ----
 * The silhouette ridge, horizon glow, horizon line, cardinal points and the
 * photo strip corners NEVER move in world space. They used to be re-derived
 * with ~1,500 trig-heavy project(az,alt) calls per frame — a real cause of
 * dropped frames on the phone. Now each is a unit vector computed once at
 * startup; per frame they cost three dot products through projectVec(). */
function vecAA(az, alt) {
  const a = az * DEG, e = alt * DEG, c = Math.cos(e);
  return { x: c * Math.sin(a), y: c * Math.cos(a), z: Math.sin(e) };
}
const FG_STEP = 1.5;
const FG_COLS = [];      // silhouette columns (skipping the photo span)
const GLOW_COLS = [];    // horizon glow columns
const HORIZON_PTS = [];  // horizon line points
const CARDINALS = [];    // compass letters
const BAL_STRIPS = [];   // photo strip corner vectors + source x ranges
(function precomputeStatics() {
  for (let az = 0; az < 360; az += FG_STEP) {
    FG_COLS.push({
      skip: inBalconySpan(az) || inBalconySpan(az + FG_STEP),
      tl: vecAA(az, horizonTopAlt(az)), tr: vecAA(az + FG_STEP, horizonTopAlt(az + FG_STEP)),
      bl: vecAA(az, -25), br: vecAA(az + FG_STEP, -25)
    });
  }
  for (let az = 0; az < 360; az += 3) {
    const d = ((az - EAST_AZ + 540) % 360) - 180;
    const warm = Math.max(0, 1 - Math.abs(d) / 70);
    GLOW_COLS.push({
      warm,
      tl: vecAA(az, 14), tr: vecAA(az + 3, 14),
      bl: vecAA(az, -2), br: vecAA(az + 3, -2)
    });
  }
  for (let az = 0; az <= 360; az += 2) HORIZON_PTS.push(vecAA(az, 0));
  for (const [name, az] of [["N",0],["E",90],["S",180],["W",270],["NE",45],["SE",135],["SW",225],["NW",315]]) {
    CARDINALS.push({ name, v: vecAA(az, 0) });
  }
  const { az0, az1, altTop, altBot, strips } = BALCONY;
  for (let i = 0; i < strips; i++) {
    const a0 = az0 + (az1 - az0) * i / strips;
    const a1 = az0 + (az1 - az0) * (i + 1) / strips;
    BAL_STRIPS.push({
      u0: i / strips, u1: (i + 1) / strips,
      tl: vecAA(a0, altTop), tr: vecAA(a1, altTop), bl: vecAA(a0, altBot)
    });
  }
})();

// Soft glow hugging the horizon: dim & cool most places, warmer toward the east
// (the marina's lights). Drawn before the stars so the dark trees sit against it.
function drawHorizonGlow() {
  for (const col of GLOW_COLS) {
    const top  = projectVec(col.tl, true);
    const top2 = projectVec(col.tr, true);
    const bot  = projectVec(col.bl, true);
    const bot2 = projectVec(col.br, true);
    if (!top || !top2 || !bot || !bot2) continue;
    const warm = col.warm;
    const r = Math.round(58 + warm * 46);
    const g = Math.round(68 + warm * 22);
    const b = Math.round(96 - warm * 34);
    const aHor = (0.24 + warm * 0.12).toFixed(3);
    const grad = ctx.createLinearGradient(bot.x, bot.y, top.x, top.y);
    grad.addColorStop(0, `rgba(${r},${g},${b},${aHor})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(top2.x, top2.y);
    ctx.lineTo(bot2.x, bot2.y);
    ctx.lineTo(bot.x, bot.y);
    ctx.closePath();
    ctx.fill();
  }
}

function drawForeground() {
  // --- Generic dark treeline everywhere EXCEPT under the photo ---
  ctx.fillStyle = "#020308";
  for (const col of FG_COLS) {
    if (col.skip && balconyReady) continue; // photo owns this span
    const pTL = projectVec(col.tl, true);
    const pTR = projectVec(col.tr, true);
    const pBL = projectVec(col.bl, true);
    const pBR = projectVec(col.br, true);
    if (!pTL || !pTR || !pBL || !pBR) continue;
    ctx.beginPath();
    ctx.moveTo(pTL.x, pTL.y);
    ctx.lineTo(pTR.x, pTR.y);
    ctx.lineTo(pBR.x, pBR.y);
    ctx.lineTo(pBL.x, pBL.y);
    ctx.closePath();
    ctx.fill();
  }

  drawBalcony();
  drawRailing();
}

/* ---- The photo itself: cylindrical strip billboard ---- */
function drawBalcony() {
  if (!balconyReady) return;
  const iw = balconyImg.naturalWidth, ih = balconyImg.naturalHeight;
  for (const s of BAL_STRIPS) {
    const pTL = projectVec(s.tl, true);
    const pTR = projectVec(s.tr, true);
    const pBL = projectVec(s.bl, true);
    if (!pTL || !pTR || !pBL) continue; // strip behind the camera
    const sx = s.u0 * iw, sw = (s.u1 - s.u0) * iw;
    // Affine map: image-pixel coords -> screen (composed with the DPR base scale)
    const m11 = (pTR.x - pTL.x) / sw, m12 = (pTR.y - pTL.y) / sw;
    const m21 = (pBL.x - pTL.x) / ih, m22 = (pBL.y - pTL.y) / ih;
    const dx = pTL.x - m11 * sx, dy = pTL.y - m12 * sx;
    ctx.setTransform(DPR * m11, DPR * m12, DPR * m21, DPR * m22, DPR * dx, DPR * dy);
    // 0.75px source overlap hides the seam between adjacent strips
    ctx.drawImage(balconyImg, sx, 0, sw + 0.75, ih, sx, 0, sw + 0.75, ih);
  }
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0); // restore the base transform
}

// Screen-locked lit railing along the bottom — fades out as you look upward.
function drawRailing() {
  const elev = Math.asin(Math.max(-1, Math.min(1, state.camForward.z))) * RAD;
  let a = elev < 0 ? 1 : 1 - elev / 26; // full at/below horizon, gone by ~26° up
  a = Math.max(0, Math.min(1, a));
  if (a <= 0.02) return;

  ctx.save();
  ctx.globalAlpha = a;

  const topY = H - dockHeight - 16;    // sit just above the control dock so it's visible
  // Top rail
  ctx.strokeStyle = "rgba(22,26,34,0.96)";
  ctx.lineWidth = 9;
  ctx.beginPath(); ctx.moveTo(0, topY); ctx.lineTo(W, topY); ctx.stroke();

  // Balusters + warm glowing post caps
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(18,22,30,0.96)";
  const spacing = 30;
  const n = Math.ceil(W / spacing);
  const offset = (W - n * spacing) / 2;
  for (let i = 0; i <= n; i++) {
    const x = offset + i * spacing;
    ctx.beginPath(); ctx.moveTo(x, topY); ctx.lineTo(x, H); ctx.stroke();
    const cap = ctx.createRadialGradient(x, topY - 2, 0, x, topY - 2, 8);
    cap.addColorStop(0, "rgba(255,206,130,0.95)");
    cap.addColorStop(1, "rgba(255,206,130,0)");
    ctx.fillStyle = cap;
    ctx.beginPath(); ctx.arc(x, topY - 2, 8, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/* ---- Label helper ---- */
function label(x, y, text, color, size, center) {
  ctx.font = `${size}px -apple-system, Helvetica, Arial, sans-serif`;
  ctx.fillStyle = color === "var(--gold)" ? "#ffd479" : color;
  ctx.textAlign = center ? "center" : "left";
  ctx.textBaseline = "alphabetic";
  ctx.shadowColor = "rgba(0,0,0,0.9)"; ctx.shadowBlur = 3;
  ctx.fillText(text, x, y);
  ctx.shadowBlur = 0;
  ctx.textAlign = "left";
}

/* ===================== DEVICE ORIENTATION ===================== */
// Timestamp of the first valid compass reading, used to dismiss the hint overlay.
let _firstOrientationAt = Infinity;

// COMPASS FIX #2 (jitter): the magnetometer (webkitCompassHeading) is accurate
// but noisy; the gyroscope (alpha) is silky-smooth but has an arbitrary zero.
// Professional AR apps therefore use the gyro for motion and the compass only
// to slowly calibrate the gyro's north offset. We keep a smoothed offset:
//   offset ≈ (alpha + compassHeading), which is constant apart from gyro drift.
let _compassOffset = null;

function circularLerp(cur, target, k) {
  const d = ((target - cur + 540) % 360) - 180;
  return (cur + d * k + 360) % 360;
}

function handleOrientation(e) {
  // Honour the manual-look freeze set by centerOn() (search "center on").
  if (manualLook && Date.now() < manualLook.until) return;
  manualLook = null;

  // --- Yaw: smooth gyro alpha + slowly-calibrated compass offset ---
  let alphaDeg;
  if (e.alpha != null &&
      typeof e.webkitCompassHeading === "number" && !isNaN(e.webkitCompassHeading)) {
    const inst = ((e.alpha + e.webkitCompassHeading) % 360 + 360) % 360;
    // First reading locks on instantly; afterwards drift in gently (k=0.04)
    _compassOffset = (_compassOffset === null) ? inst : circularLerp(_compassOffset, inst, 0.04);
    alphaDeg = e.alpha - _compassOffset;
  } else if (typeof e.webkitCompassHeading === "number" && !isNaN(e.webkitCompassHeading)) {
    alphaDeg = 360 - e.webkitCompassHeading; // compass only (no gyro alpha)
  } else if (e.alpha != null) {
    alphaDeg = e.alpha;                      // non-iOS fallback (relative)
  } else {
    return;
  }
  const betaDeg  = e.beta  || 0;
  const gammaDeg = e.gamma || 0;

  // Just record the raw target — the render loop owns the smoothing.
  // (Smoothing per-event with a fixed factor was frame-rate dependent: laggy
  // during fast sweeps, shimmery at rest. The render loop now applies a
  // time-based adaptive filter instead — see applySmoothing().)
  targetBasis = basisFromOrientation(alphaDeg, betaDeg, gammaDeg, screenAngleDeg());

  if (_firstOrientationAt === Infinity) _firstOrientationAt = Date.now();
}

// Smoothly pull the camera toward the latest sensor reading, called once per
// rendered frame. The smoothing constant adapts to how far we are from the
// target: big sweep → snappy (rate up to ~28/s, barely any lag); holding
// still → heavy damping (rate ~5/s) so sensor tremor never reaches the screen.
// Time-based (dt) so it behaves the same at 30, 60 or 120 fps.
let targetBasis = null;
function applySmoothing(dt) {
  if (!targetBasis) return;
  const t = targetBasis;
  const errDot = Math.max(-1, Math.min(1, dot(state.camForward, t.f)));
  const errDeg = Math.acos(errDot) * RAD;
  if (errDeg < 0.04 && Math.acos(Math.max(-1, Math.min(1, dot(state.camUp, t.u)))) * RAD < 0.04) {
    return; // deadband: target reached — stop drifting, kill micro-shimmer
  }
  const rate = 5 + Math.min(23, errDeg * 1.6); // adaptive responsiveness
  const k = 1 - Math.exp(-rate * dt);
  const f = normalize(lerpVec(state.camForward, t.f, k));
  let   r = normalize(lerpVec(state.camRight,   t.r, k));
  const u = normalize(cross(r, f));   // up   = right × forward
  r       = normalize(cross(f, u));   // right = forward × up (re-orthogonalise)
  state.camForward = f;
  state.camRight   = r;
  state.camUp      = u;
}

// COMPASS FIX #1 (iPad sideways horizon): screen rotation in degrees.
// The motion sensors' beta/gamma axes are defined relative to PORTRAIT on all
// Apple devices, and the legacy window.orientation is portrait-relative too.
// But iPadOS reports screen.orientation.angle relative to a LANDSCAPE-natural
// screen, so trusting it first applied a phantom 90° roll on iPads (the
// vertical-horizon bug). Prefer window.orientation; it matches the sensors.
function screenAngleDeg() {
  if (typeof window.orientation === "number") return window.orientation;
  if (screen.orientation && typeof screen.orientation.angle === "number") return screen.orientation.angle;
  return 0;
}

/* Build a camera basis (forward/right/up, world East-North-Up) from the device
 * orientation. Uses the W3C Z-X'-Y'' rotation matrix. The camera looks out the
 * BACK of the phone (aim/camera style), so you point the phone at a star like a
 * viewfinder. Verified: phone vertical facing north → looks north, up = zenith. */
function basisFromOrientation(alphaDeg, betaDeg, gammaDeg, orientDeg) {
  const a = alphaDeg * DEG, b = betaDeg * DEG, g = gammaDeg * DEG;
  const ca = Math.cos(a), sa = Math.sin(a);
  const cb = Math.cos(b), sb = Math.sin(b);
  const cg = Math.cos(g), sg = Math.sin(g);

  // R maps device axes -> world (X=East, Y=North, Z=Up)
  const R00 = ca*cg - sa*sb*sg, R01 = -sa*cb, R02 = ca*sg + sa*sb*cg;
  const R10 = sa*cg + ca*sb*sg, R11 =  ca*cb, R12 = sa*sg - ca*sb*cg;
  const R20 = -cb*sg,           R21 =  sb,    R22 = cb*cg;

  // Camera looks out the back = device -Z; screen-right = device +X; screen-up = device +Y
  let f = { x: -R02, y: -R12, z: -R22 };
  let r = { x:  R00, y:  R10, z:  R20 };
  let u = { x:  R01, y:  R11, z:  R21 };

  // Compensate for screen rotation (portrait→landscape) by rolling the basis
  // about the view axis. No-op in portrait (orientDeg = 0).
  if (orientDeg) {
    const o = -orientDeg * DEG, c = Math.cos(o), s = Math.sin(o);
    r = addVec(scaleVec(r, c), scaleVec(cross(f, r), s));
    u = addVec(scaleVec(u, c), scaleVec(cross(f, u), s));
  }
  return { f: normalize(f), r: normalize(r), u: normalize(u) };
}

// Point the camera at a specific azimuth/altitude (used by search "center on").
function setLookDirection(az, alt) {
  const ta = az * DEG, te = alt * DEG;
  const f = { x: Math.cos(te)*Math.sin(ta), y: Math.cos(te)*Math.cos(ta), z: Math.sin(te) };
  let r = cross(f, { x: 0, y: 0, z: 1 });
  if (norm(r) < 1e-6) r = { x: 1, y: 0, z: 0 };
  r = normalize(r);
  state.camForward = normalize(f);
  state.camRight   = r;
  state.camUp      = normalize(cross(r, f));
}

/* ===================== GEOFENCE (status only) ===================== */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat/2) ** 2 +
            Math.cos(lat1*DEG) * Math.cos(lat2*DEG) * Math.sin(dLon/2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function startGeofence() {
  if (!navigator.geolocation) { setStatus(false); return; }
  navigator.geolocation.watchPosition(
    pos => {
      const d = haversine(HOME.lat, HOME.lon, pos.coords.latitude, pos.coords.longitude);
      setStatus(d <= GEOFENCE_M);
    },
    () => setStatus(false),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function setStatus(isHome) {
  // Change 3: keep the existing 📍 status line exactly as before.
  statusEl.textContent = isHome ? "📍 Home" : "📍 Viewing from home";

  // Change 1: header text depends on home/away.
  titleEl.textContent = isHome ? "Amanda's Monkey Tree" : "Live from Amanda's Monkey Tree";

  // Change 3: the "Come home" line appears ONLY when not home.
  awayMsgEl.style.display = isHome ? "none" : "block";
}

/* ===================== SATELLITES LOAD ===================== */
async function loadSatellites() {
  try {
    const res  = await fetch(TLE_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("TLE fetch " + res.status);
    const json = await res.json();
    const sats = parseTLEJson(json, SAT_LIMIT);
    if (!sats.length) throw new Error("no TLEs parsed");
    state.satellites = sats;
    localStorage.setItem("tleCacheV2", JSON.stringify({ t: Date.now(), json }));
  } catch (e) {
    // Offline (or API down): use the last successful fetch
    const cached = localStorage.getItem("tleCacheV2");
    if (cached) {
      try {
        state.satellites = parseTLEJson(JSON.parse(cached).json, SAT_LIMIT);
      } catch (e2) {}
    }
  }
}

// TLE API returns JSON: { member: [{ name, line1, line2, ... }, ...] }
function parseTLEJson(json, limit) {
  const sats = [];
  for (const m of (json.member || [])) {
    if (!m.line1 || !m.line2) continue;
    try {
      sats.push({ name: m.name, satrec: satellite.twoline2satrec(m.line1, m.line2) });
    } catch (e) { /* skip bad TLE */ }
    if (sats.length >= limit) break;
  }
  // Guarantee the ISS is included even if the limit was hit before it appeared
  if (!sats.some(s => /ISS|ZARYA/i.test(s.name))) {
    const iss = (json.member || []).find(m => /ISS|ZARYA/i.test(m.name));
    if (iss) {
      try { sats.push({ name: iss.name, satrec: satellite.twoline2satrec(iss.line1, iss.line2) }); }
      catch (e) {}
    }
  }
  return sats;
}

/* ===================== INFO CARD ===================== */
const card = document.getElementById("card");
const FACTS = {
  Sun:     "Our home star — about 109 Earths wide and 93 million miles away.",
  Moon:    "Earth's only natural satellite; it drifts ~3.8 cm farther from us each year.",
  Mercury: "The smallest planet and the fastest, orbiting the Sun in just 88 days.",
  Venus:   "The hottest planet, with a runaway greenhouse atmosphere near 470 °C.",
  Mars:    "The Red Planet; its rust-colored soil is rich in iron oxide.",
  Jupiter: "The largest planet — its Great Red Spot is a storm wider than Earth.",
  Saturn:  "Famous for its spectacular rings made of ice and rock.",
  Uranus:  "An ice giant tipped on its side, rolling around the Sun.",
  Neptune: "The windiest planet, with gusts over 2,000 km/h.",
  ISS:     "The International Space Station orbits ~400 km up at 28,000 km/h — a lab the size of a football field."
};

function bodyFact(name) {
  return FACTS[name] || "A point of light in the night sky over the Monkey Tree.";
}

function showCard(obj) {
  const date = currentDate();
  const g = document.getElementById("cardGrid");
  let name = "", type = "", rows = [], fact = "";

  if (obj.kind === "star") {
    const s = obj.data;
    name = s.name;
    type = s.con ? `Star · ${s.con}` : "Star";
    const distTxt = s.dist ? s.dist.toLocaleString() + " light-years" : "unknown";
    rows = [
      ["Type",       "Star"],
      ["Magnitude",  s.mag.toFixed(2)],
      ["Altitude",   obj.alt.toFixed(1) + "°"],
      ["Azimuth",    obj.az.toFixed(0) + "°"],
      ["Distance",   distTxt]
    ];
    fact = s.dist
      ? `The light you see from ${s.name} left it ${s.dist.toLocaleString()} years ago.`
      : `${s.name} shines at magnitude ${s.mag.toFixed(2)} in the constellation ${s.con}.`;

  } else if (obj.kind === "planet" || obj.kind === "sun" || obj.kind === "moon") {
    // FIX #4: obj.data.name is now always set (bodyAltAz includes it)
    name = obj.data.name;
    type = obj.kind === "moon" ? "The Moon" : obj.kind === "sun" ? "The Sun" : "Planet";
    rows = [
      ["Type",     type],
      ["Altitude", obj.alt.toFixed(1) + "°"],
      ["Azimuth",  obj.az.toFixed(0) + "°"]
    ];
    if (obj.data.distAU) rows.push(["Distance", obj.data.distAU.toFixed(3) + " AU"]);
    if (obj.kind === "moon") {
      const illum = Astronomy.Illumination("Moon", date);
      const phase = Astronomy.MoonPhase(date);
      rows.push(["Illumination", (illum.phase_fraction * 100).toFixed(0) + "%"]);
      rows.push(["Phase", phaseName(phase)]);
      const rise = Astronomy.SearchRiseSet("Moon", observer, +1, date, 1);
      const set  = Astronomy.SearchRiseSet("Moon", observer, -1, date, 1);
      if (rise) rows.push(["Rise", rise.date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })]);
      if (set)  rows.push(["Set",  set.date.toLocaleTimeString([],  { hour: "2-digit", minute: "2-digit" })]);
    }
    fact = bodyFact(name);

  } else if (obj.kind === "satellite") {
    name = obj.data.name;
    type = "Satellite";
    rows = [
      ["Type",         "Man-made satellite"],
      ["Altitude",     obj.alt.toFixed(1) + "°"],
      ["Azimuth",      obj.az.toFixed(0) + "°"],
      ["Range",        Math.round(obj.data.rangeKm) + " km"],
      ["Orbit height", Math.round(obj.data.heightKm) + " km"]
    ];
    fact = bodyFact(/ISS/i.test(name) ? "ISS" : name);
  }

  document.getElementById("cardName").textContent = name;
  document.getElementById("cardType").textContent = type;
  g.innerHTML = rows.map(r => `<div class="k">${r[0]}</div><div class="v">${r[1]}</div>`).join("");
  document.getElementById("cardFact").textContent = fact;
  card.style.display = "block";
}

function phaseName(deg) {
  const d = (deg + 360) % 360;
  if (d < 22.5 || d >= 337.5) return "New Moon";
  if (d < 67.5)  return "Waxing Crescent";
  if (d < 112.5) return "First Quarter";
  if (d < 157.5) return "Waxing Gibbous";
  if (d < 202.5) return "Full Moon";
  if (d < 247.5) return "Waning Gibbous";
  if (d < 292.5) return "Last Quarter";
  return "Waning Crescent";
}

/* ===================== PERSONAL UI (Changes 2 & 4) =====================
 * Greeting line + moon info. All time-based logic uses currentDate(), so it
 * respects the time scrubber too. None of this touches the sky rendering.
 */

// Is there a full moon "tonight" (within ~18 hours of the given moment)?
function fullMoonTonight(date) {
  // Search from 24h before now so a full moon earlier today is still caught.
  const start = new Date(date.getTime() - 24 * 3600000);
  const fm = Astronomy.SearchMoonPhase(180, start, 3); // 180° = full moon
  if (!fm) return false;
  const diffHrs = Math.abs(fm.date.getTime() - date.getTime()) / 3600000;
  return diffHrs <= 18;
}

// Change 4 easter egg: is a date within 3 calendar days of June 18 (year ignored)?
function nearJune18(d) {
  const y = d.getFullYear();
  const thisDay = Date.UTC(y, d.getMonth(), d.getDate());
  const june18  = Date.UTC(y, 5, 18); // month 5 = June
  const diffDays = Math.round((thisDay - june18) / 86400000);
  return Math.abs(diffDays) <= 3;
}

// Change 2: pick the right warm greeting for the current time / sky.
function greetingFor(date) {
  // Full moon takes priority over everything else.
  if (fullMoonTonight(date)) return "There's a full moon tonight, Amanda";

  const h = date.getHours();
  if (h < 5) return "Still up, Amanda? The sky's all yours";

  // Compute today's sunset at the home coordinates.
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
  const sunset = Astronomy.SearchRiseSet("Sun", observer, -1, dayStart, 1);
  if (sunset && date < sunset.date) return "Tonight's sky is getting ready for you, Amanda";
  return "The stars are out, Amanda";
}

// Writes both the greeting and the moon info line. Cheap enough to call on a timer.
function updatePersonalUI() {
  const date = currentDate();

  // --- Greeting (Change 2) ---
  greetingEl.textContent = greetingFor(date);

  // --- Moon info (Change 4) ---
  const illum = Astronomy.Illumination("Moon", date);
  const pct   = Math.round(illum.phase_fraction * 100);
  const phase = phaseName(Astronomy.MoonPhase(date));

  const fm = Astronomy.SearchMoonPhase(180, date, 40); // next full moon within ~40 days
  let nextLine;
  if (fm && nearJune18(fm.date)) {
    nextLine = "Full moon near the day we met 🌕";
  } else if (fm) {
    nextLine = "Next full moon: " +
      fm.date.toLocaleDateString([], { month: "short", day: "numeric" });
  } else {
    nextLine = "";
  }

  moonLineEl.innerHTML =
    `🌙 ${phase} · ${pct}% lit<br><span class="moonNext">${nextLine}</span>`;
}

document.getElementById("cardClose").onclick = () => card.style.display = "none";

/* ===================== TAP HIT TEST ===================== */
canvas.addEventListener("click", (ev) => {
  const x = ev.clientX, y = ev.clientY;
  let best = null, bestD = 22;
  for (const o of state.screenObjects) {
    const d = Math.hypot(o.x - x, o.y - y);
    if (d < Math.max(bestD, o.r)) {
      if (!best || d < best._d) { best = o; best._d = d; }
    }
  }
  if (best) showCard(best);
});

/* ===================== SEARCH ===================== */
const searchInput = document.getElementById("searchInput");
const results     = document.getElementById("results");

function buildSearchIndex() {
  const list = [];
  // Only named stars are searchable (465 of the 2,890 have proper names)
  for (const s of STARS) {
    if (s.name) list.push({ name: s.name, type: "Star (" + (s.con || "—") + ")", kind: "star", ref: s });
  }
  for (const p of PLANETS)      list.push({ name: p.body,  type: "Planet",               kind: "planet"           });
  list.push({ name: "Moon", type: "The Moon",  kind: "moon" });
  list.push({ name: "Sun",  type: "The Sun",   kind: "sun"  });
  for (const c of CONSTELLATIONS) list.push({ name: c.name, type: "Constellation", kind: "const", ref: c });
  // FIX #6: include all loaded satellites in the search index, not just ISS.
  // We rebuild a small satellite sub-index whenever satellites are loaded.
  return list;
}
const SEARCH_BASE = buildSearchIndex();

function currentSearchIndex() {
  // Merge the static base with whatever satellites are currently loaded
  const satEntries = state.satellites.map(s => ({
    name: /ISS|ZARYA/i.test(s.name) ? "ISS" : s.name,
    type: "Satellite",
    kind: "satellite",
    satRef: s
  }));
  // Deduplicate by name
  const seen = new Set(SEARCH_BASE.map(e => e.name.toLowerCase()));
  const fresh = satEntries.filter(e => !seen.has(e.name.toLowerCase()));
  return SEARCH_BASE.concat(fresh);
}

searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) { results.style.display = "none"; return; }
  const idx = currentSearchIndex();
  const matches = idx.filter(o => o.name.toLowerCase().includes(q)).slice(0, 8);
  if (!matches.length) { results.style.display = "none"; return; }
  results.innerHTML = matches.map((m, i) =>
    `<div class="row" data-i="${i}">${m.name} <small>· ${m.type}</small></div>`).join("");
  results._matches = matches;
  results.style.display = "block";
});

results.addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  const m = results._matches[+row.dataset.i];
  results.style.display = "none";
  searchInput.blur();
  centerOn(m);
});

document.getElementById("searchClear").onclick = () => {
  searchInput.value = "";
  results.style.display = "none";
};

/* ---- Center view on a search result ---- */
function centerOn(m) {
  const date = currentDate();
  let altaz = null;

  if (m.kind === "star" && m.ref) {
    altaz = raDecToAltAz(m.ref.ra, m.ref.dec, date);
  } else if (m.kind === "const" && m.ref) {
    altaz = raDecToAltAz(m.ref.label[0], m.ref.label[1], date);
  } else if (m.kind === "moon") {
    altaz = bodyAltAz("Moon", date);
  } else if (m.kind === "sun") {
    altaz = bodyAltAz("Sun", date);
  } else if (m.kind === "planet") {
    altaz = bodyAltAz(m.name, date);
  } else if (m.kind === "satellite") {
    // FIX #6: use the specific satellite from the search result, not always the ISS.
    const sat = m.satRef || state.satellites.find(s => /ISS|ZARYA/i.test(s.name));
    if (sat) {
      const gmst = satellite.gstime(date);
      const pv   = satellite.propagate(sat.satrec, date);
      if (pv && pv.position) {
        const look = satellite.ecfToLookAngles(
          { longitude: HOME.lon * DEG, latitude: HOME.lat * DEG, height: HOME.elevationM / 1000 },
          satellite.eciToEcf(pv.position, gmst)
        );
        altaz = { alt: look.elevation * RAD, az: (look.azimuth * RAD + 360) % 360 };
      }
    }
  }

  if (!altaz || altaz.alt < 0) {
    flash(`${m.name} is below the horizon right now`);
    return;
  }

  // Set the freeze window; handleOrientation() will respect it, then point the camera.
  manualLook = { az: altaz.az, alt: altaz.alt, until: Date.now() + 6000 };
  targetBasis = null; // drop the stale sensor target so smoothing doesn't pull us back
  setLookDirection(altaz.az, altaz.alt);
}

/* FIX #2: flash() now saves the previous text and restores it after 2.5 s.
 * The original had an empty setTimeout callback so messages stuck forever. */
function flash(msg) {
  const prev = statusEl.textContent;
  statusEl.textContent = msg;
  setTimeout(() => { statusEl.textContent = prev; }, 2500);
}

/* ===================== CONTROLS ===================== */
const slider    = document.getElementById("timeSlider");
const timeLabel = document.getElementById("timeLabel");

slider.addEventListener("input", () => {
  state.timeOffsetMin = +slider.value;
  // Force the slow cache to refresh immediately when time is scrubbed
  SLOW_CACHE.lastUpdate = 0;
  updateTimeLabel();
  updatePersonalUI(); // greeting + moon line follow the scrubbed time too
});

function updateTimeLabel() {
  const m = state.timeOffsetMin;
  if (m === 0) {
    timeLabel.textContent = "Live";
    document.getElementById("btnLive").classList.add("on");
    return;
  }
  document.getElementById("btnLive").classList.remove("on");
  const sign = m > 0 ? "+" : "−";
  const abs  = Math.abs(m);
  const h    = Math.floor(abs / 60), mm = abs % 60;
  const when = currentDate();
  timeLabel.textContent =
    `${sign}${h}h ${mm}m · ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

document.getElementById("btnLive").onclick = () => {
  state.timeOffsetMin = 0;
  slider.value = 0;
  SLOW_CACHE.lastUpdate = 0;
  updateTimeLabel();
};
document.getElementById("btnConst").onclick = (e) => {
  state.showLines = !state.showLines;
  e.target.classList.toggle("on", state.showLines);
};
document.getElementById("btnLabels").onclick = (e) => {
  state.showLabels = !state.showLabels;
  e.target.classList.toggle("on", state.showLabels);
};
document.getElementById("btnRecenter").onclick = () => {
  manualLook = null; // clears the freeze so sensors take over immediately
};

/* ===================== START / PERMISSIONS ===================== */
const startOverlay = document.getElementById("startOverlay");
document.getElementById("startBtn").addEventListener("click", async () => {
  try {
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== "granted") flash("Motion access denied — use the time scrubber to explore");
    }
    if (typeof DeviceMotionEvent !== "undefined" &&
        typeof DeviceMotionEvent.requestPermission === "function") {
      try { await DeviceMotionEvent.requestPermission(); } catch (e) {}
    }
  } catch (e) {}

  window.addEventListener("deviceorientation", handleOrientation, true);
  startGeofence();
  loadSatellites();
  setInterval(loadSatellites, 6 * 60 * 1000); // refresh TLEs every 6 min

  startOverlay.classList.add("hidden");

  // Pre-warm the slow cache immediately so stars appear on the very first frame
  // instead of waiting up to 20 seconds for the first cache tick.
  refreshSlowCache(currentDate());

  // Show a brief "point your phone at the sky" hint until the first compass reading
  // arrives. Prevents the user staring at a default north-horizon view wondering
  // if the app is working.
  const hint = document.getElementById("orientHint");
  const hintTimer = setInterval(() => {
    if (manualLook || Date.now() - _firstOrientationAt < 500) return;
    hint.classList.add("hidden");
    clearInterval(hintTimer);
  }, 300);

  // Keep the greeting current as time passes (e.g. day → evening).
  setInterval(updatePersonalUI, 30000);

  // Start the render loop NOW (not at page load) so it only runs when needed.
  render();

  // Easter egg: ghost the faint Kouri image + text over the live sky for 2s.
  playIntroEasterEgg();
});

/* ===================== SERVICE WORKER ===================== */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

/* ===================== GO ===================== */
// Initialise the time label on load (so "Live" text appears in the dock right away).
// The render loop itself starts inside the startBtn click handler — not here —
// so no CPU is used until the user taps Begin.
updateTimeLabel();
updatePersonalUI(); // populate greeting + moon line right away (visible behind overlay)

/* ===================== INTRO EASTER EGG =====================
 * Plays AFTER the Begin button is pressed (called from the start handler): the
 * faint (10%) Kouri image + text ghosts over the LIVE sky for 2 seconds, then
 * fades out and is removed completely so it never blocks taps. */
function playIntroEasterEgg() {
  const intro = document.getElementById("introOverlay");
  if (!intro) return;
  intro.classList.remove("hidden");              // reveal it over the live sky
  setTimeout(() => {
    intro.classList.add("introHide");            // start the 0.6s CSS fade
    setTimeout(() => { intro.remove(); }, 700);   // remove from the page after it fades
  }, 2000);
}
