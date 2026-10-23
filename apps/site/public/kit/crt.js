/* ============================================================================
   _shared/crt.js — BS.mountCRT(host, opts): the Home hero's CRT field (D37)
   ----------------------------------------------------------------------------
   A dependency-free vanilla port of React Bits' "CRT Warp"
   (react-bits, MIT licence:
   https://reactbits.dev — "CRTWarp"). Raw WebGL2, shaders
   inline, nothing fetched.

   Passes, as in the original: CONTENT (a quantised sine field with
   persistence, ping-pong textures at `columns` × rows by CELL_ASPECT) → GLOW +
   two BLUR passes (bloom) → DISPLAY (curvature, scanline beam, aperture /
   shadow / slot mask, phosphor colouring, noise, flicker, interference,
   vignette, rgb shift, corners). The 1.6 s intro reveal is the masthead
   entrance.

   NOT PORTED (D37: no interaction): mouseReact / mouseStrength / the magnet
   uniform and its spring, changeOnClick / the variation flip (FLIP_SECONDS,
   roll, tear, static), and every pointer, mouse or click listener. The
   variation is fixed from opts.variation. Nothing on the page reacts to the
   pointer.

   Palette: color = the computed --accent, backgroundColor = the computed
   --canvas (read from :root, so tokens stay the single source). The defaults
   below are the Blindseal tuning (down from the demo, measured so the hero
   text column keeps muted ≥ 4.5:1 and ink ≥ 7:1 through the shades).

     BS.mountCRT(host, opts?) → { stop(), pause(), resume(), get paused, canvas } | null
       host   the .hero__space (absolute, inset 0); the canvas fills it, under
              the .hero__shade gradients, pointer-events none
       opts   any key of BS.CRT_DEFAULTS
       null   when WebGL2 is missing — the caller falls back to the nebula
              (site.js does: BS.mountSpace(host, { intensity: "hero" }) and
              host.dataset.bg = "nebula")

   Kit discipline: the loop runs only while the host is on screen and the tab
   is visible (IntersectionObserver + visibilitychange; no rAF scheduled
   otherwise; host gets .is-paused like BS.motion.mountPause). Reduced motion
   (BS.motion.reduced()): one intro-complete still frame, then the loop stops.
   Slow-mo (?motion=slow): the clock (intro, field, noise) runs at × 0.25.
   ========================================================================== */
(function () {
  "use strict";
  var BS = (window.BS = window.BS || {});

  var MASKS = { none: 0, aperture: 1, shadow: 2, slot: 3 };
  var CELL_ASPECT = 0.56;
  var INTRO_SECONDS = 1.6;
  var TAU = Math.PI * 2;

  /* the Blindseal tuning (demo value → ours). Logged on the board (J00). */
  var DEFAULTS = {
    color: null,                 /* null = computed --accent */
    backgroundColor: null,       /* null = computed --canvas */
    lightMode: false,
    speed: 0.3,                  /* demo .5 — calmer */
    variation: 0,
    waveAmplitude: 0.3,
    waveFrequency: 2.5,
    levels: 3,
    columns: 80,
    persistence: 0.4,
    curvature: 0.2,              /* demo .25 */
    corners: 0,
    scanlineStrength: 0.5,       /* demo .6 */
    scanlineFrequency: 200,
    mask: "aperture",
    maskStrength: 0.15,          /* demo .3 — less colour fringing on blue ink */
    bloom: 0.6,                  /* demo 1.5 */
    bloomRadius: 1,
    rgbShift: 0.0012,            /* demo .003 — no coloured fringes */
    noise: 0.05,                 /* demo .1 */
    flicker: 0.04,               /* demo .15 */
    interference: 0.06,          /* demo .2 */
    vignette: 0.45,              /* demo .3 */
    brightness: 0.36,            /* demo 1 — the field stays under the text column (0.42 measured muted 4.98:1 on the eyebrow; 0.36 for margin) */
    intro: true,
    dpr: 1.5,                    /* capped at 1.5 for the mockups */
    fps: 60,
    paused: false
  };

  var VERTEX = "#version 300 es\n" +
    "in vec2 aPosition;\n" +
    "void main() {\n" +
    "  gl_Position = vec4(aPosition, 0.0, 1.0);\n" +
    "}";

  /* CONTENT — verbatim */
  var CONTENT = "#version 300 es\n" +
    "precision highp float;\n" +
    "uniform vec2 uGrid;\n" +
    "uniform float uTime;\n" +
    "uniform float uAmplitude;\n" +
    "uniform float uFrequency;\n" +
    "uniform float uLevels;\n" +
    "uniform float uDecay;\n" +
    "uniform float uReveal;\n" +
    "uniform float uRise;\n" +
    "uniform vec4 uSeed;\n" +
    "uniform sampler2D uPrevious;\n" +
    "out vec4 outColor;\n" +
    "\n" +
    "float field(vec2 uv, float t) {\n" +
    "  uv = (uv - 0.5) * uFrequency + 0.5;\n" +
    "  float f = 0.0;\n" +
    "  f += 0.7 * sin(0.5 * uv.x + t / 5.0 + uSeed.x);\n" +
    "  f += 3.0 * sin(1.6 * uv.y + t / 5.0 + uSeed.y);\n" +
    "  f += sin(10.0 * (uv.y * sin(t / 2.0 + uSeed.z) + uv.x * cos(t / 5.0)) + t / 2.0);\n" +
    "  float cx = uv.x + 0.5 * sin(t / 2.0 + uSeed.w);\n" +
    "  float cy = uv.y + 0.5 * cos(t / 4.0 + uSeed.x * 0.7);\n" +
    "  f += 0.4 * sin(sqrt(100.0 * cx * cx + 100.0 * cy * cy + 1.0) + t);\n" +
    "  f += 0.9 * sin(sqrt(75.0 * cx * cx + 25.0 * cy * cy + 1.0) + t);\n" +
    "  f -= 1.4 * sin(sqrt(256.0 * cx * cx + 25.0 * cy * cy + 1.0) + t);\n" +
    "  f += 0.3 * sin(0.5 * uv.y + uv.x + sin(t));\n" +
    "  return f;\n" +
    "}\n" +
    "\n" +
    "void main() {\n" +
    "  vec2 cell = floor(gl_FragCoord.xy);\n" +
    "  vec2 uv = (cell + 0.5) / uGrid;\n" +
    "  float s = (0.5 + 0.499 * sin(field(uv, uTime) * uAmplitude)) * mix(1.0 / uLevels, 1.0, uReveal);\n" +
    "  float level = floor(s * uLevels) / max(uLevels - 1.0, 1.0);\n" +
    "  float previous = texelFetch(uPrevious, ivec2(cell), 0).r;\n" +
    "  float lifted = min(level, previous + uRise);\n" +
    "  outColor = vec4(max(lifted, previous * uDecay - 0.004), level, 0.0, 1.0);\n" +
    "}";

  /* GLOW — verbatim */
  var GLOW = "#version 300 es\n" +
    "precision highp float;\n" +
    "uniform sampler2D uContent;\n" +
    "uniform vec2 uSize;\n" +
    "out vec4 outColor;\n" +
    "\n" +
    "void main() {\n" +
    "  float v = texture(uContent, gl_FragCoord.xy / uSize).r;\n" +
    "  outColor = vec4(v * v, 0.0, 0.0, 1.0);\n" +
    "}";

  /* BLUR — verbatim */
  var BLUR = "#version 300 es\n" +
    "precision highp float;\n" +
    "uniform sampler2D uSource;\n" +
    "uniform vec2 uSize;\n" +
    "uniform vec2 uDirection;\n" +
    "uniform float uSigma;\n" +
    "out vec4 outColor;\n" +
    "\n" +
    "void main() {\n" +
    "  vec2 uv = gl_FragCoord.xy / uSize;\n" +
    "  float stride = max(uSigma * 0.55, 0.5);\n" +
    "  float total = 0.0;\n" +
    "  float sum = 0.0;\n" +
    "  for (int i = -7; i <= 7; i++) {\n" +
    "    float x = float(i) * stride;\n" +
    "    float w = exp(-0.5 * x * x / (uSigma * uSigma));\n" +
    "    sum += texture(uSource, uv + uDirection * x / uSize).r * w;\n" +
    "    total += w;\n" +
    "  }\n" +
    "  outColor = vec4(sum / total, 0.0, 0.0, 1.0);\n" +
    "}";

  /* DISPLAY — verbatim except: the magnet (uMagnet: swirl, fall, purity
     lobes) is removed; uRoll / uTear / uStatic / uGain (the click flip) stay
     as uniforms but are always 0 / 0 / 0 / 1 */
  var DISPLAY = "#version 300 es\n" +
    "precision highp float;\n" +
    "uniform sampler2D uContent;\n" +
    "uniform sampler2D uGlow;\n" +
    "uniform vec2 uGrid;\n" +
    "uniform vec2 uResolution;\n" +
    "uniform float uPixel;\n" +
    "uniform float uTime;\n" +
    "uniform vec3 uColor;\n" +
    "uniform vec3 uBackground;\n" +
    "uniform float uOpaque;\n" +
    "uniform float uLight;\n" +
    "uniform float uLines;\n" +
    "uniform float uScanline;\n" +
    "uniform float uCurve;\n" +
    "uniform float uCorners;\n" +
    "uniform int uMaskType;\n" +
    "uniform float uMask;\n" +
    "uniform float uBloom;\n" +
    "uniform float uBrightness;\n" +
    "uniform float uNoise;\n" +
    "uniform float uFlicker;\n" +
    "uniform float uInterference;\n" +
    "uniform float uVignette;\n" +
    "uniform float uShift;\n" +
    "uniform float uWarm;\n" +
    "uniform float uFocus;\n" +
    "uniform float uStatic;\n" +
    "uniform float uRoll;\n" +
    "uniform float uTear;\n" +
    "uniform float uGain;\n" +
    "out vec4 outColor;\n" +
    "\n" +
    "float hash(vec2 p) {\n" +
    "  p = fract(p * vec2(123.34, 456.21));\n" +
    "  p += dot(p, p + 45.32);\n" +
    "  return fract(p.x * p.y);\n" +
    "}\n" +
    "\n" +
    "vec2 curve(vec2 uv) {\n" +
    "  if (uCurve <= 0.0) return uv;\n" +
    "  vec2 p = (uv - 0.5) * 2.0;\n" +
    "  float corner = uCurve / sqrt(max(uCurve * uCurve - 2.0, 0.001));\n" +
    "  p = uCurve * p / sqrt(max(uCurve * uCurve - dot(p, p), 0.001));\n" +
    "  p /= corner;\n" +
    "  return p * 0.5 + 0.5;\n" +
    "}\n" +
    "\n" +
    "float lineValue(float x, float y) {\n" +
    "  if (x < 0.0 || x > 1.0 || y < 0.0 || y > 1.0) return 0.0;\n" +
    "  float cx = x * uGrid.x - 0.5;\n" +
    "  float c0 = floor(cx);\n" +
    "  int row = int(clamp(floor(y * uGrid.y), 0.0, uGrid.y - 1.0));\n" +
    "  float a = texelFetch(uContent, ivec2(int(clamp(c0, 0.0, uGrid.x - 1.0)), row), 0).r;\n" +
    "  float b = texelFetch(uContent, ivec2(int(clamp(c0 + 1.0, 0.0, uGrid.x - 1.0)), row), 0).r;\n" +
    "  float soft = mix(0.5, 0.14, uFocus);\n" +
    "  return pow(mix(a, b, smoothstep(0.5 - soft, 0.5 + soft, cx - c0)), 1.25);\n" +
    "}\n" +
    "\n" +
    "float beam(vec2 uv) {\n" +
    "  float ly = uv.y * uLines - 0.5;\n" +
    "  float r0 = floor(ly);\n" +
    "  float f = ly - r0;\n" +
    "  float a = lineValue(uv.x, (r0 + 0.5) / uLines);\n" +
    "  float b = lineValue(uv.x, (r0 + 1.5) / uLines);\n" +
    "  float nearest = f < 0.5 ? a : b;\n" +
    "  float sa = mix(0.16, 0.34, sqrt(a));\n" +
    "  float sb = mix(0.16, 0.34, sqrt(b));\n" +
    "  float lit = a * exp(-0.5 * f * f / (sa * sa)) + b * exp(-0.5 * (1.0 - f) * (1.0 - f) / (sb * sb));\n" +
    "  return mix(nearest, lit * 1.18, uScanline * mix(0.3, 1.0, uFocus));\n" +
    "}\n" +
    "\n" +
    "vec3 maskAt(vec2 px) {\n" +
    "  if (uMaskType == 0 || uMask <= 0.0) return vec3(1.0);\n" +
    "  float size = max(1.0, floor(uPixel + 0.5));\n" +
    "  vec2 q = floor(px / size);\n" +
    "  float low = 1.0 - uMask;\n" +
    "  vec3 m = vec3(low);\n" +
    "  float column = q.x;\n" +
    "  if (uMaskType == 2) column += mod(floor(q.y / 2.0), 2.0) * 1.5;\n" +
    "  int stripe = int(mod(floor(column), 3.0));\n" +
    "  if (stripe == 0) m.r = 1.0;\n" +
    "  else if (stripe == 1) m.g = 1.0;\n" +
    "  else m.b = 1.0;\n" +
    "  if (uMaskType == 2 && mod(q.y, 2.0) > 0.5) m *= mix(1.0, 0.72, uMask);\n" +
    "  if (uMaskType == 3) {\n" +
    "    float slot = mod(q.y + mod(floor(q.x / 3.0), 2.0) * 2.0, 4.0);\n" +
    "    if (slot < 1.0) m *= mix(1.0, 0.45, uMask);\n" +
    "  }\n" +
    "  return m / sqrt((1.0 + 2.0 * low) / 3.0);\n" +
    "}\n" +
    "\n" +
    "vec3 phosphor(vec3 cov) {\n" +
    "  float peak = max(max(uColor.r, uColor.g), max(uColor.b, 0.001));\n" +
    "  vec3 weight = 1.0 - uColor / peak;\n" +
    "  return uColor * cov * pow(max(cov, vec3(0.0001)), 0.7 * weight);\n" +
    "}\n" +
    "\n" +
    "void main() {\n" +
    "  vec2 frag = gl_FragCoord.xy / uResolution;\n" +
    "  float aspect = uResolution.x / uResolution.y;\n" +
    "  vec2 uv = curve(frag);\n" +
    "  float shape = 1.0;\n" +
    "  if (uCorners > 0.0) {\n" +
    "    float margin = uCorners * 0.035;\n" +
    "    float radius = uCorners * 0.1;\n" +
    "    vec2 p = (uv - 0.5) * vec2(aspect, 1.0);\n" +
    "    vec2 box = (0.5 - margin) * vec2(aspect, 1.0);\n" +
    "    vec2 q = abs(p) - box + radius;\n" +
    "    float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;\n" +
    "    float aa = max(fwidth(sd), 0.0005);\n" +
    "    shape = (1.0 - smoothstep(-aa, aa, sd)) * mix(1.0, smoothstep(0.0, 0.06, -sd), 0.35);\n" +
    "    uv = (uv - 0.5) / (1.0 - 2.0 * margin) + 0.5;\n" +
    "  }\n" +
    "  float rolling = step(0.0001, abs(uRoll));\n" +
    "  uv.y += uRoll;\n" +
    "  float wrapped = fract(uv.y);\n" +
    "  uv.y = mix(uv.y, wrapped, rolling);\n" +
    "  float offset = fract(uRoll);\n" +
    "  float reach = smoothstep(0.0, 0.08, min(offset, 1.0 - offset));\n" +
    "  float blank = mix(1.0, smoothstep(0.0, 0.05, wrapped) * smoothstep(1.0, 0.95, wrapped), rolling * reach);\n" +
    "\n" +
    "  float line = floor(uv.y * uLines);\n" +
    "  float tick = floor(uTime * 30.0);\n" +
    "  uv.x += uTear * (sin(uv.y * 21.0 + uTime * 37.0) * 0.6 + hash(vec2(line, tick)) - 0.5) * 0.05;\n" +
    "  uv.x += uInterference * 0.003 * (hash(vec2(line * 0.37, floor(uTime * 24.0))) - 0.5);\n" +
    "\n" +
    "  vec3 level = vec3(\n" +
    "    beam(uv + vec2(uShift, 0.0)),\n" +
    "    beam(uv),\n" +
    "    beam(uv - vec2(uShift, 0.0))\n" +
    "  );\n" +
    "\n" +
    "  float glow = texture(uGlow, uv).r * uBloom;\n" +
    "  float hum = 1.0 - uInterference * 0.24 * smoothstep(0.2, 1.0, 0.5 + 0.5 * sin((frag.y - uTime * 0.09) * 6.2831853));\n" +
    "  float flick = 1.0 + uFlicker * 0.1 * (hash(vec2(floor(uTime * 60.0), 7.3)) - 0.5);\n" +
    "  float grain = hash(gl_FragCoord.xy + fract(uTime) * 173.0) - 0.5;\n" +
    "  vec2 v = frag - 0.5;\n" +
    "  float vignette = mix(1.0, smoothstep(0.0, 1.0, clamp(1.0 - dot(v, v) * 2.0, 0.0, 1.0)), uVignette);\n" +
    "  float gain = uBrightness * hum * flick * vignette * blank * uGain * uWarm;\n" +
    "\n" +
    "  float noise = hash(floor(gl_FragCoord.xy / (uPixel * 1.5)) + fract(uTime * 13.7) * 91.0);\n" +
    "  level = mix(level, vec3(noise * noise * 1.15), uStatic);\n" +
    "  level *= gain * (1.0 + grain * uNoise * 2.0);\n" +
    "  level *= maskAt(gl_FragCoord.xy);\n" +
    "  glow *= gain * shape * (1.0 + 0.6 * (1.0 - uFocus));\n" +
    "  level *= shape;\n" +
    "\n" +
    "  vec3 color;\n" +
    "  float alpha;\n" +
    "  if (uLight < 0.5) {\n" +
    "    vec3 cov = clamp(level, 0.0, 1.0);\n" +
    "    vec3 light = phosphor(cov) + uColor * glow * 0.5 * (1.0 - cov);\n" +
    "    vec3 excess = max(level - 1.1, 0.0);\n" +
    "    light += (1.0 - light) * (1.0 - exp(-excess * 0.6));\n" +
    "    light = clamp(light, 0.0, 1.0);\n" +
    "    color = uBackground + light * (1.0 - uBackground);\n" +
    "    alpha = max(max(light.r, light.g), light.b);\n" +
    "    if (uOpaque < 0.5) color = light;\n" +
    "  } else {\n" +
    "    vec3 cov = clamp(level * 0.86, 0.0, 0.88);\n" +
    "    cov += clamp(glow * 0.12, 0.0, 0.2) * (1.0 - cov);\n" +
    "    color = mix(uBackground, uColor, cov);\n" +
    "    alpha = max(max(cov.r, cov.g), cov.b);\n" +
    "    if (uOpaque < 0.5) color = uColor * cov;\n" +
    "  }\n" +
    "  outColor = uOpaque > 0.5 ? vec4(color, 1.0) : vec4(color, alpha);\n" +
    "}";

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function smooth(t) { return t * t * (3 - 2 * t); }

  /* the colour probe (as in the original): any CSS colour → [r, g, b] 0..1 */
  var probe = null;
  function parseColor(value, fallback) {
    if (!value) return fallback;
    if (value === "transparent") return null;
    if (!probe) probe = document.createElement("canvas").getContext("2d");
    if (!probe) return fallback;
    probe.fillStyle = "black";
    probe.fillStyle = value;
    var text = probe.fillStyle;
    if (text.charAt(0) === "#") {
      var hex = parseInt(text.slice(1), 16);
      return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
    }
    var m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(text);
    if (!m) return fallback;
    if (m[4] !== undefined && Number(m[4]) === 0) return null;
    return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  }
  function token(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function seedFor(channel) {
    var f = function (v) { return (v - Math.floor(v)) * TAU; };
    if (channel === 0) return [0, 0, 0, 0];
    return [f(Math.sin(channel * 12.9898 + 1.7) * 43758.5453), f(Math.sin(channel * 78.233 + 4.1) * 24634.6345),
      f(Math.sin(channel * 37.719 + 2.9) * 17431.7731), f(Math.sin(channel * 91.113 + 0.3) * 31337.1337)];
  }
  function introAt(t) {
    if (t >= INTRO_SECONDS) return [1, 1, 1];
    return [smooth(clamp(t / INTRO_SECONDS, 0, 1)), smooth(clamp(t / 0.6, 0, 1)), smooth(clamp((t - 0.15) / (INTRO_SECONDS - 0.15), 0, 1))];
  }

  function compile(gl, type, source) {
    var sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { gl.deleteShader(sh); return null; }
    return sh;
  }
  function createProgram(gl, fragment, names) {
    var vs = compile(gl, gl.VERTEX_SHADER, VERTEX), fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
    if (!vs || !fs) return null;
    var program = gl.createProgram();
    gl.attachShader(program, vs); gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, "aPosition");
    gl.linkProgram(program);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return null; }
    var uniforms = {};
    names.forEach(function (n) { uniforms[n] = gl.getUniformLocation(program, n); });
    return { program: program, uniforms: uniforms };
  }
  function createTarget(gl, width, height) {
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { texture: texture, framebuffer: framebuffer, width: width, height: height };
  }
  function deleteTarget(gl, t) { if (!t) return; gl.deleteTexture(t.texture); gl.deleteFramebuffer(t.framebuffer); }

  function settingsFrom(o) {
    var accent = parseColor(o.color || token("--accent"), [0.32, 0.42, 0.96]) || [0.32, 0.42, 0.96];   /* fallbacks = the token values as 0..1 triples (no hex literal outside tokens.css) */
    var paper = parseColor(o.backgroundColor || token("--canvas"), [0.024, 0.02, 0.063]);
    return {
      ink: accent, paper: paper, lightMode: !!o.lightMode,
      speed: o.speed, variation: o.variation | 0,
      amplitude: Math.max(0, o.waveAmplitude) / 0.28,
      frequency: Math.max(0.01, o.waveFrequency) / 2.2,
      levels: clamp(Math.round(o.levels), 2, 12),
      columns: clamp(Math.round(o.columns), 8, 400),
      persistence: clamp(o.persistence, 0, 0.98),
      curve: o.curvature > 0.001 ? 1.1 + 0.42 / o.curvature : 0,
      corners: clamp(o.corners, 0, 1),
      scanline: clamp(o.scanlineStrength, 0, 1),
      lines: clamp(o.scanlineFrequency, 20, 1200),
      mask: MASKS[o.mask] != null ? MASKS[o.mask] : 0,
      maskStrength: clamp(o.maskStrength, 0, 1),
      bloom: Math.max(0, o.bloom),
      bloomRadius: Math.max(0.05, o.bloomRadius),
      rgbShift: o.rgbShift,
      noise: Math.max(0, o.noise), flicker: Math.max(0, o.flicker), interference: Math.max(0, o.interference),
      vignette: clamp(o.vignette, 0, 1), brightness: Math.max(0, o.brightness),
      intro: o.intro !== false,
      dpr: Math.min(1.5, Math.max(0.5, o.dpr)),
      fps: Math.max(1, o.fps)
    };
  }

  function mountCRT(host, opts) {
    if (!host) return null;
    var o = {};
    Object.keys(DEFAULTS).forEach(function (k) { o[k] = DEFAULTS[k]; });
    Object.keys(opts || {}).forEach(function (k) { if (opts[k] !== undefined) o[k] = opts[k]; });
    var s = settingsFrom(o);

    var canvas = document.createElement("canvas");
    canvas.className = "crt__canvas";
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = "position:absolute;inset:0;display:block;width:100%;height:100%;pointer-events:none";
    var gl = null;
    try {
      gl = canvas.getContext("webgl2", { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, powerPreference: "high-performance" });
    } catch (e) { gl = null; }
    if (!gl) return null;

    var content = createProgram(gl, CONTENT, ["uGrid", "uTime", "uAmplitude", "uFrequency", "uLevels", "uDecay", "uReveal", "uRise", "uSeed", "uPrevious"]);
    var glowSource = createProgram(gl, GLOW, ["uContent", "uSize"]);
    var blur = createProgram(gl, BLUR, ["uSource", "uSize", "uDirection", "uSigma"]);
    var display = createProgram(gl, DISPLAY, ["uContent", "uGlow", "uGrid", "uResolution", "uPixel", "uTime", "uColor", "uBackground", "uOpaque", "uLight",
      "uLines", "uScanline", "uCurve", "uCorners", "uMaskType", "uMask", "uBloom", "uBrightness", "uNoise", "uFlicker", "uInterference", "uVignette",
      "uShift", "uWarm", "uFocus", "uStatic", "uRoll", "uTear", "uGain"]);
    if (!content || !glowSource || !blur || !display) return null;

    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    var wrap = document.createElement("div");
    wrap.className = "crt";
    wrap.setAttribute("aria-hidden", "true");
    wrap.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0";
    wrap.appendChild(canvas);
    host.insertBefore(wrap, host.firstChild);
    host.dataset.bg = "crt";

    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    var st = { width: 1, height: 1, pixel: 1, grid: [0, 0], cells: [null, null], glows: [null, null], flip: 0,
      time: 0, clock: 0, last: 0, raf: 0, onScreen: true, userPaused: !!o.paused, lost: false, introAt: -1, stopped: false, still: false };

    function M() { return BS.motion; }
    function reduced() { return M() ? M().reduced() : false; }
    function rate() { return M() && M().mode && M().mode() === "slow" ? 0.25 : 1; }

    function ensureTargets() {
      var cols = s.columns;
      var rows = clamp(Math.round((cols * CELL_ASPECT * st.height) / Math.max(st.width, 1)), 4, 300);
      if (cols !== st.grid[0] || rows !== st.grid[1]) {
        st.cells.forEach(function (t) { deleteTarget(gl, t); });
        st.cells = [createTarget(gl, cols, rows), createTarget(gl, cols, rows)];
        st.grid = [cols, rows];
      }
      var gw = Math.max(1, Math.round(st.width / 4)), gh = Math.max(1, Math.round(st.height / 4));
      var g = st.glows[0];
      if (!g || g.width !== gw || g.height !== gh) {
        st.glows.forEach(function (t) { deleteTarget(gl, t); });
        st.glows = [createTarget(gl, gw, gh), createTarget(gl, gw, gh)];
      }
    }
    function resize() {
      var ratio = Math.min(window.devicePixelRatio || 1, s.dpr);
      var w = Math.max(1, Math.round(host.clientWidth * ratio)), h = Math.max(1, Math.round(host.clientHeight * ratio));
      st.pixel = ratio;
      if (w === st.width && h === st.height) return false;
      st.width = w; st.height = h; canvas.width = w; canvas.height = h;
      return true;
    }
    function draw(target, w, h) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
      gl.viewport(0, 0, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    function bindTexture(unit, texture, loc) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture); gl.uniform1i(loc, unit); }

    function render(dt, still) {
      ensureTargets();
      var cols = st.grid[0], rows = st.grid[1];
      var seed = seedFor(s.variation);
      var introClock = st.introAt < 0 ? 0 : st.clock - st.introAt;
      var iv = s.intro && !still ? introAt(introClock) : [1, 1, 1];
      var reveal = iv[0], warm = iv[1], focus = iv[2];
      var previous = st.cells[st.flip], next = st.cells[1 - st.flip], glowA = st.glows[0], glowB = st.glows[1];
      if (!previous || !next || !glowA || !glowB) return;
      gl.useProgram(content.program);
      var cu = content.uniforms;
      gl.uniform2f(cu.uGrid, cols, rows);
      gl.uniform1f(cu.uTime, st.time);
      gl.uniform1f(cu.uAmplitude, s.amplitude);
      gl.uniform1f(cu.uFrequency, s.frequency);
      gl.uniform1f(cu.uLevels, s.levels);
      gl.uniform1f(cu.uDecay, still ? 0 : Math.pow(s.persistence, dt * 60));
      gl.uniform1f(cu.uReveal, reveal);
      gl.uniform1f(cu.uRise, reveal < 1 ? dt / 0.22 : 1);
      gl.uniform4f(cu.uSeed, seed[0], seed[1], seed[2], seed[3]);
      bindTexture(0, previous.texture, cu.uPrevious);
      draw(next, cols, rows);
      st.flip = 1 - st.flip;

      gl.useProgram(glowSource.program);
      gl.uniform2f(glowSource.uniforms.uSize, glowA.width, glowA.height);
      bindTexture(0, next.texture, glowSource.uniforms.uContent);
      draw(glowA, glowA.width, glowA.height);
      var sigma = Math.max(0.6, (glowA.height / 48) * s.bloomRadius);
      gl.useProgram(blur.program);
      gl.uniform2f(blur.uniforms.uSize, glowA.width, glowA.height);
      gl.uniform1f(blur.uniforms.uSigma, sigma);
      gl.uniform2f(blur.uniforms.uDirection, 1, 0);
      bindTexture(0, glowA.texture, blur.uniforms.uSource);
      draw(glowB, glowB.width, glowB.height);
      gl.uniform2f(blur.uniforms.uDirection, 0, 1);
      bindTexture(0, glowB.texture, blur.uniforms.uSource);
      draw(glowA, glowA.width, glowA.height);

      gl.useProgram(display.program);
      var u = display.uniforms;
      bindTexture(0, next.texture, u.uContent);
      bindTexture(1, glowA.texture, u.uGlow);
      gl.uniform2f(u.uGrid, cols, rows);
      gl.uniform2f(u.uResolution, st.width, st.height);
      gl.uniform1f(u.uPixel, st.pixel);
      gl.uniform1f(u.uTime, still ? 0 : st.clock);
      gl.uniform3f(u.uColor, s.ink[0], s.ink[1], s.ink[2]);
      var paper = s.paper || [0, 0, 0];
      gl.uniform3f(u.uBackground, paper[0], paper[1], paper[2]);
      gl.uniform1f(u.uOpaque, s.paper ? 1 : 0);
      gl.uniform1f(u.uLight, s.lightMode ? 1 : 0);
      gl.uniform1f(u.uLines, s.lines);
      gl.uniform1f(u.uScanline, s.scanline);
      gl.uniform1f(u.uCurve, s.curve);
      gl.uniform1f(u.uCorners, s.corners);
      gl.uniform1i(u.uMaskType, s.mask);
      gl.uniform1f(u.uMask, s.maskStrength);
      gl.uniform1f(u.uBloom, s.bloom);
      gl.uniform1f(u.uBrightness, s.brightness);
      gl.uniform1f(u.uNoise, still ? 0 : s.noise);
      gl.uniform1f(u.uFlicker, still ? 0 : s.flicker);
      gl.uniform1f(u.uInterference, still ? 0 : s.interference);
      gl.uniform1f(u.uVignette, s.vignette);
      gl.uniform1f(u.uShift, s.rgbShift);
      gl.uniform1f(u.uWarm, warm);
      gl.uniform1f(u.uFocus, focus);
      gl.uniform1f(u.uStatic, 0);
      gl.uniform1f(u.uRoll, 0);
      gl.uniform1f(u.uTear, 0);
      gl.uniform1f(u.uGain, 1);
      draw(null, st.width, st.height);
    }

    /* reduced motion: one intro-complete still frame (two content passes fill
       the ping-pong pair), then nothing is scheduled */
    function renderStill() {
      resize();
      render(1 / 60, true); render(1 / 60, true);
      st.still = true;
    }

    function running() { return !st.stopped && !st.userPaused && st.onScreen && !document.hidden && !st.lost && !st.still; }
    function syncPausedClass() { host.classList.toggle("is-paused", !running()); }
    function tick(now) {
      st.raf = 0;
      if (!running()) { st.last = 0; syncPausedClass(); return; }
      st.raf = requestAnimationFrame(tick);
      var interval = 1000 / s.fps;
      if (st.last && now - st.last < interval - 1) return;
      var dt = st.last ? Math.min((now - st.last) / 1000, 0.1) : 1 / 60;
      st.last = now;
      dt *= rate();
      st.clock += dt;
      if (st.introAt < 0) st.introAt = st.clock;
      st.time += dt * s.speed;
      resize();
      render(dt, false);
    }
    function schedule() {
      syncPausedClass();
      if (reduced()) { if (!st.still) renderStill(); syncPausedClass(); return; }
      st.still = false;
      if (running() && !st.raf) { st.last = 0; st.raf = requestAnimationFrame(tick); }
    }

    var io = ("IntersectionObserver" in window) ? new IntersectionObserver(function (es) {
      st.onScreen = es[es.length - 1].isIntersecting;
      schedule();
    }, { threshold: [0, 0.01] }) : null;
    if (io) io.observe(host);
    var ro = ("ResizeObserver" in window) ? new ResizeObserver(function () { if (resize() && st.still) { render(1 / 60, true); render(1 / 60, true); } }) : null;
    if (ro) ro.observe(host);
    var onVis = function () { schedule(); };
    document.addEventListener("visibilitychange", onVis);
    var onMotion = function () { schedule(); };
    document.addEventListener("bs:motion", onMotion);
    var onLost = function (e) { e.preventDefault(); st.lost = true; syncPausedClass(); };
    canvas.addEventListener("webglcontextlost", onLost);
    resize();
    schedule();

    var api = {
      canvas: canvas,
      get paused() { return !running(); },
      get options() { return o; },
      pause: function () { st.userPaused = true; if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; } syncPausedClass(); },
      resume: function () { st.userPaused = false; schedule(); },
      stop: function () {
        st.stopped = true;
        if (st.raf) cancelAnimationFrame(st.raf);
        if (io) io.disconnect(); if (ro) ro.disconnect();
        document.removeEventListener("visibilitychange", onVis);
        document.removeEventListener("bs:motion", onMotion);
        canvas.removeEventListener("webglcontextlost", onLost);
        st.cells.forEach(function (t) { deleteTarget(gl, t); });
        st.glows.forEach(function (t) { deleteTarget(gl, t); });
        [content, glowSource, blur, display].forEach(function (p) { gl.deleteProgram(p.program); });
        gl.deleteBuffer(buffer); gl.deleteVertexArray(vao);
        var lose = gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext();
        wrap.remove();
        host.classList.remove("is-paused");
      }
    };
    return api;
  }

  BS.CRT_DEFAULTS = DEFAULTS;
  BS.mountCRT = mountCRT;
})();
