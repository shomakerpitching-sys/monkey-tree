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

// CelesTrak: free, no account, no API key. "visual" group = bright/famous satellites.
const TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle";
const SAT_LIMIT = 60; // how many satellites to track from the visual list

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/* ===================== STATE ===================== */
const state = {
  heading: 0,       // compass azimuth, degrees (0=N, 90=E)
  pitch: 0,         // up/down tilt, degrees (0=horizon, +90=straight up)
  roll: 0,          // screen rotation, degrees

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
const statusEl = document.getElementById("status");
let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2.5);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
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
 * FIX #3: Stars, constellation points, and the Milky Way band change extremely
 * slowly (< 0.25° per minute). Recomputing them every animation frame at 60 fps
 * was burning ~30,000 Astronomy Engine calls per second for no benefit.
 * We now recompute them at most once every 20 seconds. Planets, Moon, Sun, and
 * satellites are still computed every frame because they move visibly.
 */
const SLOW_CACHE = {
  lastUpdate: 0,
  intervalMs: 20000, // recompute slow objects every 20 seconds
  stars: [],         // [{alt, az}] parallel to STARS array
  conLines: [],      // [{a:{alt,az}, b:{alt,az}}] parallel to flattened constellation segments
  conLabels: [],     // [{alt, az}] parallel to CONSTELLATIONS array
  milkyWay: []       // [{alt, az}] one per 3° step along galactic equator
};

function refreshSlowCache(date) {
  const now = Date.now();
  if (now - SLOW_CACHE.lastUpdate < SLOW_CACHE.intervalMs) return;
  SLOW_CACHE.lastUpdate = now;

  // Stars
  SLOW_CACHE.stars = STARS.map(s => raDecToAltAz(s.ra, s.dec, date));

  // Constellation line endpoints AND label positions (both move at stellar rate)
  SLOW_CACHE.conLines  = [];
  SLOW_CACHE.conLabels = [];
  for (const c of CONSTELLATIONS) {
    for (const seg of c.lines) {
      SLOW_CACHE.conLines.push({
        a: raDecToAltAz(seg[0][0], seg[0][1], date),
        b: raDecToAltAz(seg[1][0], seg[1][1], date)
      });
    }
    SLOW_CACHE.conLabels.push(raDecToAltAz(c.label[0], c.label[1], date));
  }

  // Milky Way band (120 points, one per 3°)
  SLOW_CACHE.milkyWay = [];
  for (let l = 0; l < 360; l += 3) {
    const eq = galacticToEquatorial(l, 0);
    SLOW_CACHE.milkyWay.push(raDecToAltAz(eq.ra, eq.dec, date));
  }
}

/* ===================== PROJECTION ===================== */
function project(az, alt) {
  const ch = state.heading, cp = state.pitch;
  const ta = az * DEG, te = alt * DEG;
  const tv = {
    x: Math.cos(te) * Math.sin(ta),
    y: Math.cos(te) * Math.cos(ta),
    z: Math.sin(te)
  };
  const fa = ch * DEG, fe = cp * DEG;
  const fwd = {
    x: Math.cos(fe) * Math.sin(fa),
    y: Math.cos(fe) * Math.cos(fa),
    z: Math.sin(fe)
  };
  const up0 = { x: 0, y: 0, z: 1 };
  let right = cross(fwd, up0);
  if (norm(right) < 1e-6) right = { x: 1, y: 0, z: 0 };
  right = normalize(right);
  const up = normalize(cross(right, fwd));

  const xCam = dot(tv, right);
  const yCam = dot(tv, up);
  const zCam = dot(tv, fwd);

  if (zCam <= 0.04) return null;

  const f = (H / 2) / Math.tan((state.fov * DEG) / 2);
  let px = W / 2 + (xCam / zCam) * f;
  let py = H / 2 - (yCam / zCam) * f;

  if (state.roll) {
    const r = -state.roll * DEG;
    const dx = px - W / 2, dy = py - H / 2;
    px = W / 2 + dx * Math.cos(r) - dy * Math.sin(r);
    py = H / 2 + dx * Math.sin(r) + dy * Math.cos(r);
  }

  if (px < -80 || px > W + 80 || py < -80 || py > H + 80) return null;
  return { x: px, y: py, depth: zCam };
}

function cross(a, b) { return { x: a.y*b.z - a.z*b.y, y: a.z*b.x - a.x*b.z, z: a.x*b.y - a.y*b.x }; }
function dot(a, b)   { return a.x*b.x + a.y*b.y + a.z*b.z; }
function norm(a)     { return Math.sqrt(dot(a, a)); }
function normalize(a){ const n = norm(a) || 1; return { x: a.x/n, y: a.y/n, z: a.z/n }; }

function starRadius(mag) {
  const r = 2.6 - mag * 0.42;
  return Math.max(0.6, Math.min(3.6, r));
}

/* ===================== RENDER ===================== */
function render() {
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

  drawMilkyWay();
  if (state.showLines) drawConstellations();
  drawStars();
  drawPlanets(date);
  drawMoonAndSun(date);
  drawSatellites(date);
  drawHorizon();

  requestAnimationFrame(render);
}

/* ---- Stars (uses cache) ---- */
function drawStars() {
  for (let i = 0; i < STARS.length; i++) {
    const s = STARS[i];
    const { alt, az } = SLOW_CACHE.stars[i] || { alt: -99, az: 0 };
    if (alt < -2) continue;
    const p = project(az, alt);
    if (!p) continue;
    const r = starRadius(s.mag);
    ctx.beginPath();
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = Math.max(0.4, Math.min(1, 1.2 - s.mag * 0.18));
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    if (state.showLabels && s.mag < 2.3) {
      label(p.x + r + 3, p.y + 3, s.name, "rgba(244,244,246,0.82)", 11);
    }
    state.screenObjects.push({ x: p.x, y: p.y, r: Math.max(r, 9), kind: "star", data: s, alt, az });
  }
}

/* ---- Constellation lines + labels (fully cached — no live raDecToAltAz calls) ---- */
function drawConstellations() {
  ctx.strokeStyle = "rgba(120,160,220,0.32)";
  ctx.lineWidth = 1;
  let lineIdx = 0;
  for (let ci = 0; ci < CONSTELLATIONS.length; ci++) {
    const c = CONSTELLATIONS[ci];
    for (const seg of c.lines) {
      const cached = SLOW_CACHE.conLines[lineIdx++];
      if (!cached) continue;
      const { a, b } = cached;
      if (a.alt < -5 && b.alt < -5) continue;
      const pa = project(a.az, a.alt);
      const pb = project(b.az, b.alt);
      if (!pa || !pb) continue;
      if (Math.hypot(pa.x - pb.x, pa.y - pb.y) > W * 0.9) continue;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    if (state.showLabels) {
      const lp = SLOW_CACHE.conLabels[ci];
      if (lp && lp.alt > 0) {
        const p = project(lp.az, lp.alt);
        if (p) label(p.x, p.y, c.name, "rgba(150,180,235,0.7)", 11, true);
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
function drawMilkyWay() {
  ctx.save();
  for (const { alt, az } of SLOW_CACHE.milkyWay) {
    if (alt < 0) continue;
    const p = project(az, alt);
    if (!p) continue;
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 46);
    grad.addColorStop(0, "rgba(180,190,230,0.05)");
    grad.addColorStop(1, "rgba(180,190,230,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 46, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function galacticToEquatorial(l, b) {
  const lr = l * DEG, br = b * DEG;
  const ragp = 192.85948 * DEG, decgp = 27.12825 * DEG, lcp = 122.93192 * DEG;
  const sinb = Math.sin(br), cosb = Math.cos(br);
  const sinDec = Math.sin(decgp) * sinb + Math.cos(decgp) * cosb * Math.cos(lcp - lr);
  const dec = Math.asin(sinDec);
  const y = cosb * Math.sin(lcp - lr);
  const x = Math.cos(decgp) * sinb - Math.sin(decgp) * cosb * Math.cos(lcp - lr);
  let ra = ragp + Math.atan2(y, x);
  ra = ((ra * RAD) % 360 + 360) % 360;
  return { ra: ra / 15, dec: dec * RAD };
}

/* ---- Horizon + cardinal directions ---- */
function drawHorizon() {
  ctx.strokeStyle = "rgba(120,140,170,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  let started = false;
  for (let az = 0; az <= 360; az += 2) {
    const p = project(az, 0);
    if (!p) { started = false; continue; }
    if (!started) { ctx.moveTo(p.x, p.y); started = true; }
    else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();

  const dirs = [["N",0],["E",90],["S",180],["W",270],["NE",45],["SE",135],["SW",225],["NW",315]];
  for (const [name, az] of dirs) {
    const p = project(az, 0);
    if (p) label(p.x, p.y - 4, name, "rgba(150,170,200,0.8)", 12, true);
  }
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

function handleOrientation(e) {
  // FIX #1: Honour the manual-look freeze set by centerOn().
  // If the user just searched for an object, ignore compass input for 6 seconds
  // so the view actually stays pointed where centerOn() put it.
  if (manualLook && Date.now() < manualLook.until) return;
  manualLook = null; // freeze expired — sensors take over again

  let heading;
  if (typeof e.webkitCompassHeading === "number" && !isNaN(e.webkitCompassHeading)) {
    heading = e.webkitCompassHeading;
  } else if (e.alpha != null) {
    heading = (360 - e.alpha) % 360;
  } else {
    return;
  }

  const beta  = e.beta  || 0;
  const gamma = e.gamma || 0;

  let pitch = 90 - beta;
  pitch = Math.max(-90, Math.min(90, pitch));

  state.heading = smoothAngle(state.heading, heading, 0.25);
  state.pitch   = state.pitch + (pitch - state.pitch) * 0.25;
  state.roll    = state.roll  + (gamma - state.roll)  * 0.2;

  // Record when the first real compass reading arrived so the hint can be cleared.
  if (_firstOrientationAt === Infinity) _firstOrientationAt = Date.now();
}

function smoothAngle(cur, target, k) {
  let d = ((target - cur + 540) % 360) - 180;
  return (cur + d * k + 360) % 360;
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
  statusEl.textContent = isHome ? "📍 Home" : "📍 Viewing from home";
}

/* ===================== SATELLITES LOAD ===================== */
async function loadSatellites() {
  try {
    const res  = await fetch(TLE_URL, { cache: "no-store" });
    const text = await res.text();
    const sats = parseTLE(text, SAT_LIMIT);
    state.satellites = sats;
    localStorage.setItem("tleCache", JSON.stringify({ t: Date.now(), text }));
  } catch (e) {
    // Offline: use cached TLEs
    const cached = localStorage.getItem("tleCache");
    if (cached) {
      try {
        const text = JSON.parse(cached).text;
        state.satellites = parseTLE(text, SAT_LIMIT);
      } catch (e2) {}
    }
  }
}

function parseTLE(text, limit) {
  const lines = text.trim().split(/\r?\n/);
  const sats = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = lines[i].trim();
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!l1 || !l2 || l1[0] !== "1") continue;
    try {
      sats.push({ name, satrec: satellite.twoline2satrec(l1, l2) });
    } catch (e) {}
    if (sats.length >= limit) break;
  }
  // Guarantee the ISS is included even if the limit was hit before it appeared
  if (!sats.some(s => /ISS|ZARYA/i.test(s.name))) {
    const idx = lines.findIndex(l => /ISS|ZARYA/i.test(l));
    if (idx >= 0 && lines[idx+1] && lines[idx+2]) {
      try {
        sats.push({ name: lines[idx].trim(),
          satrec: satellite.twoline2satrec(lines[idx+1], lines[idx+2]) });
      } catch (e) {}
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
    type = `Star · ${s.con}`;
    rows = [
      ["Type",       "Star"],
      ["Magnitude",  s.mag.toFixed(2)],
      ["Altitude",   obj.alt.toFixed(1) + "°"],
      ["Azimuth",    obj.az.toFixed(0) + "°"],
      ["Distance",   "many light-years"]
    ];
    fact = `${s.name} shines at magnitude ${s.mag.toFixed(2)} in the constellation ${s.con}.`;

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
  for (const s of STARS)        list.push({ name: s.name,  type: "Star (" + s.con + ")", kind: "star",    ref: s });
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

  // FIX #1: set the freeze window; handleOrientation() will respect it.
  manualLook = { az: altaz.az, alt: altaz.alt, until: Date.now() + 6000 };
  state.heading = altaz.az;
  state.pitch   = altaz.alt;
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

  // Start the render loop NOW (not at page load) so it only runs when needed.
  render();
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
