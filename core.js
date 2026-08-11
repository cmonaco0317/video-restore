/* ------------------------------------------------------------------------
 * Video Upscaler — GPU core (engine v2)
 *
 * Pure WebGL2. No chrome.* APIs in here on purpose, so this file can be
 * loaded standalone by test/harness.html and verified outside the extension.
 *
 * Pipeline, per presented video frame:
 *
 *   A0. restore (source res)  deblock + dering                [skipped if both 0]
 *   A. clean    (source res)  bilateral denoise + deband      [skipped if both 0]
 *   B. upscale  (output res)  FSR-1 EASU, edge-adaptive, 1 pass
 *                             or separable Lanczos-3, 2 passes
 *   C. finish   (output res)  RCAS sharpen + grade + dither
 *
 * Why each piece:
 *  - Restore is the only stage that repairs COMPRESSION damage rather than
 *    scaling damage. On real footage that is the dominant problem, and it must
 *    run before everything else or the rest of the chain amplifies it.
 *  - EASU orients its kernel along the local edge, so diagonals stop
 *    staircasing the way a direction-blind kernel like Lanczos leaves them.
 *  - Denoise/deband run at SOURCE resolution: fewer pixels, and cleaning
 *    before magnification beats trying to clean up afterwards.
 *  - Deband targets the artifact that actually ruins low-bitrate streams on a
 *    big panel — flat gradients breaking into visible steps.
 *  - Intermediates are RGBA16F where supported, so four passes don't quantize
 *    to 8 bits four times; the final pass dithers on the way back down.
 *
 * EASU/RCAS implement AMD's FidelityFX FSR 1.0 (MIT). CAS is retained as the
 * alternate sharpener.
 * --------------------------------------------------------------------- */
(() => {
  'use strict';
  if (window.VUCore) return;

  const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main(){ vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`;

  const COMMON = `
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

  /* ---- A0. deblock + dering, at source resolution -----------------------
   * The stage that was missing. Everything else in this file repairs SCALING
   * damage; this one repairs COMPRESSION damage, which is the dominant visual
   * problem in real footage and the reason a bad rip still looks bad after a
   * good upscale.
   *
   * Two artifacts, two mechanisms:
   *
   *  - BLOCKING. The codec transforms 8x8 tiles independently, so at low
   *    bitrate each tile is quantised toward its own DC and the tile edges stop
   *    lining up. The result is a visible step on the 8-pixel grid. A bilateral
   *    denoise cannot touch this: the step IS an edge, and an edge-preserving
   *    filter preserves it. It has to be attacked on the grid, by asking
   *    whether a step that lands exactly on a block boundary is bigger than the
   *    detail inside the two blocks it separates. If it is, it was manufactured
   *    by the quantiser and gets ramped out over 6 pixels.
   *
   *  - RINGING / MOSQUITO NOISE. Truncating high-frequency coefficients rings
   *    (Gibbs), so strong edges are surrounded by a skirt of oscillation that
   *    shimmers frame to frame. It is found by its position, not its shape:
   *    moderate roughness sitting NEXT TO a strong edge but not ON it. Only
   *    that skirt is smoothed, so open texture elsewhere is never touched.
   *
   * Why this pays for itself twice: local contrast (`detail`) amplifies the
   * 8-64 px band, which is exactly where both of these live. That is why
   * `detail` measured as the single most destructive stage on a compressed
   * source and has to ship at 0.12. Remove the artifacts first and the same
   * slider stops amplifying garbage, so it can run several times harder. The
   * cleanup is the thing that unlocks the look.
   * --------------------------------------------------------------------- */
  const FRAG_RESTORE = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2  uSrcSize;
uniform float uDeblock;
uniform float uDering;
uniform vec2  uGridPhase;    // where the transform grid actually sits, per axis (0..7)
uniform float uGridPeriod;   // 8 for the MPEG family, 4 for AV1/HEVC small transforms
in  vec2 vUV;
out vec4 fragColor;
${COMMON}

// One block boundary, one axis.
//
// pcoord is this pixel's position along the axis IN PICTURE COORDINATES, and
// dir converts a step of +1 picture pixel into a texture-space offset. The
// two differ on the vertical axis because the frame is uploaded with
// UNPACK_FLIP_Y_WEBGL, so texture row 0 is the BOTTOM picture row. The DCT grid
// is anchored at the top-left of the picture, so a filter that walks the grid in
// texture space is off by (height mod 8) rows — invisible on a 1080-high frame,
// wrong on anything else. Walk it in picture space and convert.
vec3 deblockAxis(vec2 uv, float pcoord, float gphase, vec2 dir, vec2 along, float k) {
  // Pixels 0..3 of a block sit against the boundary on its far side (q side);
  // 4..7 sit against the next boundary (p side). Either way dist is the
  // distance to our own nearest boundary and toB points one pixel at it.
  float P     = uGridPeriod;
  float phase = mod(floor(pcoord) - gphase, P);
  float qside = step(phase, P * 0.5 - 0.5);
  float dist  = mix(P - 1.0 - phase, phase, qside);
  vec2  toB   = dir * mix(1.0, -1.0, qside);   // one pixel toward the boundary

  // Ramp the correction down over three pixels, so a hard step becomes a
  // gradient instead of moving to a new place.
  float w = (dist < 0.5) ? 0.50 : (dist < 1.5) ? 0.25 : (dist < 2.5) ? 0.10 : 0.0;
  if (w <= 0.0) return vec3(0.0);

  // THE DISCRIMINATOR: average the step ALONG the boundary, not just across it.
  // Quantisation shifts a whole tile, so the false step points the same way for
  // the length of the block edge and survives averaging. Noise and real texture
  // crossing the boundary point every which way and cancel. A single-pixel
  // measurement cannot tell these apart at all — it was measured doing almost
  // nothing (blockiness 1.74 -> 1.58) precisely because per-pixel noise kept
  // the gate shut.
  //
  // A = our block's edge pixel, B = theirs; Ai / Bi sit one deeper into each
  // block and say how much real detail the two blocks actually carry.
  vec3  sum = vec3(0.0);
  float raw = 0.0, inner = 0.0;
  for (int i = -1; i <= 1; i++) {
    vec2 o = along * float(i);
    vec3 A  = texture(uTex, uv + o + toB *  dist).rgb;
    vec3 B  = texture(uTex, uv + o + toB * (dist + 1.0)).rgb;
    vec3 Ai = texture(uTex, uv + o + toB * (dist - 1.0)).rgb;
    vec3 Bi = texture(uTex, uv + o + toB * (dist + 2.0)).rgb;
    sum   += B - A;
    raw   += abs(luma(B) - luma(A));
    inner += abs(luma(A) - luma(Ai)) + abs(luma(Bi) - luma(B));
  }
  vec3  mean = sum / 3.0;              // the coherent part of the step
  float coh  = abs(luma(mean));
  float rawL = raw / 3.0;              // average magnitude of the step
  float innL = inner / 6.0;            // average activity just inside the blocks

  // Three independent reasons to leave a boundary alone: the step is big enough
  // to be a real edge, the blocks are busy enough that the step is plausibly
  // their own detail, or the step is not coherent along the edge.
  float thr     = mix(8.0, 30.0, k) / 255.0;
  float notEdge = 1.0 - smoothstep(thr * 0.7, thr * 1.3, coh);
  float domin   = clamp((coh - 0.9 * innL) / max(thr * 0.4, 1e-5), 0.0, 1.0);
  float cohGate = smoothstep(0.35, 0.70, coh / max(rawL, 1e-5));

  // Only the coherent component is removed. Whatever genuine variation ran
  // along that boundary is left exactly where it was.
  return mean * (w * k * notEdge * domin * cohGate);
}

void main(){
  vec2 texel = 1.0 / uSrcSize;
  vec3 c = texture(uTex, vUV).rgb;

  // --- deblocking on the measured transform grid ---------------------------
  if (uDeblock > 0.0) {
    float k  = clamp(uDeblock, 0.0, 1.0);
    float px = floor(gl_FragCoord.x);
    float py = uSrcSize.y - 1.0 - floor(gl_FragCoord.y);   // picture row, unflipped
    c += deblockAxis(vUV, px, uGridPhase.x, vec2(texel.x, 0.0),  vec2(0.0, texel.y), k);
    c += deblockAxis(vUV, py, uGridPhase.y, vec2(0.0, -texel.y), vec2(texel.x, 0.0), k);  // +1 picture row = -1 texture row
  }

  // --- deringing: the skirt around a strong edge ---------------------------
  if (uDering > 0.0) {
    float k  = clamp(uDering, 0.0, 1.0);
    float y0 = luma(c);

    // Sigma is chosen to sit BETWEEN the two amplitudes: wide enough to pool
    // the ringing (which oscillates by a few levels) and narrow enough to
    // exclude the edge itself (which jumps by tens), so the edge never bleeds.
    float sigma = mix(0.055, 0.130, k);
    float t2    = 2.0 * sigma * sigma;
    vec3  acc   = c;
    float wacc  = 1.0;
    float own   = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        if (x == 0 && y == 0) continue;
        vec3  s  = texture(uTex, vUV + vec2(float(x), float(y)) * texel).rgb;
        float dy = abs(luma(s) - y0);
        own = max(own, dy);
        float w = exp(-(dy * dy) / t2) * ((x != 0 && y != 0) ? 0.7071 : 1.0);
        acc += s * w; wacc += w;
      }
    }

    // Is there a strong edge NEARBY? Eight taps at radius 3 — far enough to be
    // off the ringing skirt and onto the edge that caused it.
    float near = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7853982;
      vec3  s = texture(uTex, vUV + vec2(cos(a), sin(a)) * 3.0 * texel).rgb;
      near = max(near, abs(luma(s) - y0));
    }

    // Fire only in the skirt: strong edge close by, but this pixel is not the
    // edge. Being ON the edge (own roughness large) switches it off, which is
    // what keeps this from softening the picture.
    float isNear = smoothstep(0.09, 0.19, near);
    float notOn  = 1.0 - smoothstep(0.10, 0.24, own);

    // Hard amplitude limit. Ringing is a small-amplitude oscillation, so a few
    // levels is all this ever needs; capping the correction means that when the
    // detector is wrong — and beside a real edge in CLEAN footage it will be —
    // the most it can do is nudge. Without the cap this measured -5.5 dB on a
    // clean source, which is a real picture being softened for no reason.
    float lim = mix(2.0, 8.0, k) / 255.0;
    vec3  d   = clamp(acc / wacc - c, vec3(-lim), vec3(lim));
    c += d * clamp(k * isNear * notOn, 0.0, 1.0);
  }

  fragColor = vec4(c, 1.0);
}
`;

  /* ---- A0b. grid measurement -------------------------------------------
   * Answers three questions about the source that the restore stage was
   * previously just assuming:
   *
   *   HOW BAD is it?  The strength that helps most moves with the damage —
   *     measured optima ran 0 on a clean plate, ~0.6 on a crf45 rip, 0.85 on a
   *     badly blocked one. A single fixed number is wrong for two of those.
   *   WHERE is the grid?  Anchored at the picture origin for the MPEG family,
   *     but a cropped or re-encoded stream can sit at any phase, and filtering
   *     the wrong phase smooths real detail while leaving the artifact.
   *   HOW WIDE is it?  AV1 and HEVC also use 4x4 transforms, whose boundaries
   *     an 8-only filter never touches.
   *
   * Method: bin the gradient magnitude by its position modulo 8. A grid shows
   * up as one bin standing above the rest — the phase is which bin, the damage
   * is how far above, and a 4-px grid lights up two bins four apart. Each
   * output texel covers a tile of the frame and carries four bins, so this is
   * one small pass and one periodic readback rather than anything per-frame.
   *
   * The two axes are binned SEPARATELY (four sub-texels per tile: x-bins 0-3,
   * x-bins 4-7, y-bins 0-3, y-bins 4-7). Sharing one set of bins across both
   * axes seems safe — the grid is anchored at the picture origin, so the phases
   * normally agree — but when they disagree the two axes fight over the single
   * peak and the loser silently gets filtered at the wrong phase. Measured: a
   * frame shifted 5px horizontally reported the vertical phase and would have
   * smoothed real detail on every wrong column.
   * --------------------------------------------------------------------- */
  const FRAG_MEASURE = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2  uSrcSize;
uniform vec2  uTiles;
in  vec2 vUV;
out vec4 fragColor;
${COMMON}

// Fetch by PICTURE coordinate. Frames upload flipped, so picture row r lives at
// texture row (h-1-r); binning in texture space would report a phase the
// deblocker cannot use.
vec3 pic(vec2 p, vec2 sz){
  return texture(uTex, vec2((p.x + 0.5) / sz.x, (sz.y - 1.0 - p.y + 0.5) / sz.y)).rgb;
}

void main(){
  vec2  sz = uSrcSize;
  ivec2 fc = ivec2(gl_FragCoord.xy);
  int   sub  = fc.x & 3;                     // 0,1 = x-axis bins · 2,3 = y-axis bins
  bool  yAxis = sub >= 2;
  bool  upper = (sub & 1) == 1;              // bins 4-7 rather than 0-3
  vec2  tile = vec2(float(fc.x >> 2), float(fc.y));
  vec2  tsz  = sz / uTiles;

  float bins[8];
  for (int i = 0; i < 8; i++) bins[i] = 0.0;

  // Two lines per tile, 16 gradients each: every phase is sampled at least
  // twice per line, and there are hundreds of tiles.
  vec2 o = floor(tile * tsz);
  for (int line = 0; line < 2; line++) {
    vec2 c = o + floor(tsz * (line == 0 ? 0.33 : 0.66));
    c = clamp(c, vec2(1.0), sz - vec2(18.0));
    for (int i = 1; i <= 16; i++) {
      float t = float(i);
      vec2  a = yAxis ? vec2(c.x, c.y + t) : vec2(c.x + t, c.y);
      vec2  b = yAxis ? vec2(c.x, c.y + t - 1.0) : vec2(c.x + t - 1.0, c.y);
      float g = abs(luma(pic(a, sz)) - luma(pic(b, sz)));
      bins[int(mod(yAxis ? a.y : a.x, 8.0))] += g;
    }
  }

  // All four channels carry data, alpha included; blending is off for this pass.
  fragColor = (upper ? vec4(bins[4], bins[5], bins[6], bins[7])
                     : vec4(bins[0], bins[1], bins[2], bins[3])) / 8.0;
}
`;

  /* ---- A. denoise + deband, at source resolution ----------------------- */
  const FRAG_CLEAN = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2  uSrcSize;
uniform float uDenoise;
uniform float uDeband;
uniform float uChroma;
in  vec2 vUV;
out vec4 fragColor;
${COMMON}

// BT.709 luma/chroma split
vec3 toYCbCr(vec3 c){
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return vec3(y, (c.b - y) / 1.8556, (c.r - y) / 1.5748);
}
vec3 toRGB(vec3 v){
  return vec3(v.x + 1.5748 * v.z,
              v.x - 0.1873 * v.y - 0.4681 * v.z,
              v.x + 1.8556 * v.y);
}

void main(){
  vec2 texel = 1.0 / uSrcSize;
  vec3 e0 = texture(uTex, vUV).rgb;
  vec3 c  = e0;

  // --- edge-preserving denoise (3x3 bilateral) ---------------------------
  if (uDenoise > 0.0) {
    float sigma = mix(0.012, 0.090, clamp(uDenoise, 0.0, 1.0));
    float t2    = 2.0 * sigma * sigma;
    vec3  acc   = e0;
    float wacc  = 1.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        if (x == 0 && y == 0) continue;
        vec3  s = texture(uTex, vUV + vec2(float(x), float(y)) * texel).rgb;
        float d = length(s - e0);
        float w = exp(-(d * d) / t2) * ((x != 0 && y != 0) ? 0.7071 : 1.0);
        acc += s * w;
        wacc += w;
      }
    }
    c = mix(e0, acc / wacc, clamp(uDenoise, 0.0, 1.0));
  }

  // --- chroma reconstruction ---------------------------------------------
  // 4:2:0 video carries colour at quarter resolution. By the time a frame
  // reaches us the browser has already upsampled it, so colour edges are soft
  // and bleed past the luma edge they belong to — the coloured fringe you see
  // on saturated edges. Luma survives at full resolution, so use it as a guide:
  // rebuild each pixel's chroma from neighbours weighted by how closely their
  // LUMA matches ours. Colour then snaps back onto the structure it belongs to.
  if (uChroma > 0.0) {
    // Guided filter (chroma-from-luma). Averaging chroma cannot undo the blur,
    // because contaminated and clean pixels on the same side of an edge share
    // the same luma and are therefore indistinguishable to a similarity weight
    // — it just spreads the fringe outwards. Instead, fit chroma as a local
    // linear function of luma, C ~= a*Y + b, and evaluate it at this pixel's
    // FULL-RESOLUTION luma. Luma's sharp edge is then transferred into chroma.
    // Where chroma genuinely does not track luma, the slope collapses to zero
    // and this degrades to a plain local average, which is safe.
    float yc = luma(c);
    float sY = 0.0, sY2 = 0.0, n = 0.0;
    vec2  sC = vec2(0.0), sYC = vec2(0.0);
    for (int y = -2; y <= 2; y++) {
      for (int x = -2; x <= 2; x++) {
        vec3  sm = texture(uTex, vUV + vec2(float(x), float(y)) * 2.0 * texel).rgb;
        float Y  = luma(sm);
        vec2  C  = toYCbCr(sm).yz;
        sY += Y; sY2 += Y * Y; sC += C; sYC += Y * C; n += 1.0;
      }
    }
    float mY   = sY / n;
    vec2  mC   = sC / n;
    float varY = max(sY2 / n - mY * mY, 0.0);
    vec2  cov  = sYC / n - mY * mC;
    vec2  a    = cov / (varY + 0.0015);      // eps: how hard chroma follows luma
    vec2  b    = mC - a * mY;

    vec3 ycc = toYCbCr(c);
    ycc.yz = mix(ycc.yz, a * yc + b, clamp(uChroma, 0.0, 1.0));
    c = toRGB(ycc);
  }

  // --- deband -------------------------------------------------------------
  // Sample a ring of 4 at a pseudo-random orientation. Where the whole ring
  // sits within a hair of the centre we are inside a flat gradient that has
  // quantised into steps, so replace with the ring average. Where anything on
  // the ring differs we are on real detail and must not touch it.
  if (uDeband > 0.0) {
    float k   = clamp(uDeband, 0.0, 1.0);
    float ang = hash12(floor(gl_FragCoord.xy)) * 6.2831853;
    // The ring has to be WIDER than the plateau it is trying to dissolve. A
    // radius comparable to the band width just averages a linear ramp back to
    // its own centre value and achieves nothing.
    float rad = mix(12.0, 48.0, k);
    vec3  avg  = vec3(0.0);
    vec3  dmax = vec3(0.0);

    // two rings of four, so the estimate carries ~8x finer precision than the
    // 8-bit centre sample and therefore varies across a plateau
    for (int ring = 1; ring <= 2; ring++) {
      float r = rad * (ring == 1 ? 1.0 : 0.5);
      float a = ang + (ring == 1 ? 0.0 : 0.7853982);
      vec2 o1 = vec2(cos(a), sin(a)) * r * texel;
      vec2 o2 = vec2(-o1.y, o1.x);
      vec3 s1 = texture(uTex, vUV + o1).rgb;
      vec3 s2 = texture(uTex, vUV - o1).rgb;
      vec3 s3 = texture(uTex, vUV + o2).rgb;
      vec3 s4 = texture(uTex, vUV - o2).rgb;
      avg  += (s1 + s2 + s3 + s4) * 0.125;
      dmax  = max(dmax, max(max(abs(s1 - e0), abs(s2 - e0)), max(abs(s3 - e0), abs(s4 - e0))));
    }

    // Threshold scales with the ring, since a wider ring legitimately spans
    // more of a gradient. Anything busier than this is real detail: hands off.
    float thr = mix(3.0, 12.0, k) / 255.0;
    vec3  isFlat   = step(dmax, vec3(thr));
    vec3  debanded = mix(e0, avg, isFlat * k);
    c += debanded - e0;              // apply the correction on top of denoise
  }

  fragColor = vec4(c, 1.0);
}
`;

  /* ---- B1. FSR 1.0 EASU — edge-adaptive upscale, single pass ------------ */
  const FRAG_EASU = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uSrcSize;
uniform vec2 uSrcOff;
uniform vec2 uSrcScl;
in  vec2 vUV;
out vec4 fragColor;
${COMMON}

void easuSet(inout vec2 dir, inout float len, vec2 pp,
             bool biS, bool biT, bool biU, bool biV,
             float lA, float lB, float lC, float lD, float lE) {
  float w = 0.0;
  if (biS) w = (1.0 - pp.x) * (1.0 - pp.y);
  if (biT) w =        pp.x  * (1.0 - pp.y);
  if (biU) w = (1.0 - pp.x) *        pp.y;
  if (biV) w =        pp.x  *        pp.y;

  float lenX = 1.0 / max(max(abs(lD - lC), abs(lC - lB)), 1e-6);
  float dirX = lD - lB;
  dir.x += dirX * w;
  lenX   = clamp(abs(dirX) * lenX, 0.0, 1.0);
  len   += lenX * lenX * w;

  float lenY = 1.0 / max(max(abs(lE - lC), abs(lC - lA)), 1e-6);
  float dirY = lE - lA;
  dir.y += dirY * w;
  lenY   = clamp(abs(dirY) * lenY, 0.0, 1.0);
  len   += lenY * lenY * w;
}

void easuTap(inout vec3 aC, inout float aW, vec2 off, vec2 dir,
             vec2 len2, float lob, float clp, vec3 c) {
  vec2 v = vec2(dot(off, dir), dot(off, vec2(-dir.y, dir.x)));
  v *= len2;
  float d2 = min(dot(v, v), clp);
  float wB = 0.4 * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB  = 1.5625 * wB - 0.5625;
  float w = wB * wA;
  aC += c * w;
  aW += w;
}

void main(){
  vec2 texel = 1.0 / uSrcSize;
  vec2 pp    = (uSrcOff + vUV * uSrcScl) * uSrcSize - 0.5;
  vec2 fp    = floor(pp);
  vec2 f     = pp - fp;
  vec2 base  = (fp + 0.5) * texel;

  #define T(dx, dy) texture(uTex, base + vec2(float(dx), float(dy)) * texel).rgb
  vec3 cB = T(0,-1), cC = T(1,-1);
  vec3 cE = T(-1,0), cF = T(0,0), cG = T(1,0), cH = T(2,0);
  vec3 cI = T(-1,1), cJ = T(0,1), cK = T(1,1), cL = T(2,1);
  vec3 cN = T(0, 2), cO = T(1, 2);
  #undef T

  float lB=luma(cB), lC=luma(cC), lE=luma(cE), lF=luma(cF), lG=luma(cG), lH=luma(cH);
  float lI=luma(cI), lJ=luma(cJ), lK=luma(cK), lL=luma(cL), lN=luma(cN), lO=luma(cO);

  vec2  dir = vec2(0.0);
  float len = 0.0;
  easuSet(dir, len, f, true,  false, false, false, lB, lE, lF, lG, lJ);
  easuSet(dir, len, f, false, true,  false, false, lC, lF, lG, lH, lK);
  easuSet(dir, len, f, false, false, true,  false, lF, lI, lJ, lK, lN);
  easuSet(dir, len, f, false, false, false, true,  lG, lJ, lK, lL, lO);

  // normalise the direction; a flat neighbourhood degenerates to axis-aligned
  float dirR = dot(dir, dir);
  bool  zro  = dirR < (1.0 / 32768.0);
  dirR = zro ? 1.0 : inversesqrt(max(dirR, 1e-12));
  dir.x = zro ? 1.0 : dir.x;
  dir.y = zro ? 0.0 : dir.y;
  dir *= dirR;

  len = len * 0.5;
  len *= len;

  // stretch the kernel along the edge, squash it across
  float stretch = 1.0 / max(max(abs(dir.x), abs(dir.y)), 1e-6);
  vec2  len2    = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob     = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
  float clp     = 1.0 / lob;

  vec3  aC = vec3(0.0);
  float aW = 0.0;
  easuTap(aC, aW, vec2( 0.0,-1.0) - f, dir, len2, lob, clp, cB);
  easuTap(aC, aW, vec2( 1.0,-1.0) - f, dir, len2, lob, clp, cC);
  easuTap(aC, aW, vec2(-1.0, 0.0) - f, dir, len2, lob, clp, cE);
  easuTap(aC, aW, vec2( 0.0, 0.0) - f, dir, len2, lob, clp, cF);
  easuTap(aC, aW, vec2( 1.0, 0.0) - f, dir, len2, lob, clp, cG);
  easuTap(aC, aW, vec2( 2.0, 0.0) - f, dir, len2, lob, clp, cH);
  easuTap(aC, aW, vec2(-1.0, 1.0) - f, dir, len2, lob, clp, cI);
  easuTap(aC, aW, vec2( 0.0, 1.0) - f, dir, len2, lob, clp, cJ);
  easuTap(aC, aW, vec2( 1.0, 1.0) - f, dir, len2, lob, clp, cK);
  easuTap(aC, aW, vec2( 2.0, 1.0) - f, dir, len2, lob, clp, cL);
  easuTap(aC, aW, vec2( 0.0, 2.0) - f, dir, len2, lob, clp, cN);
  easuTap(aC, aW, vec2( 1.0, 2.0) - f, dir, len2, lob, clp, cO);

  // deringing: never leave the range of the inner 2x2
  vec3 mn4 = min(min(cF, cG), min(cJ, cK));
  vec3 mx4 = max(max(cF, cG), max(cJ, cK));
  vec3 pix = aC / (abs(aW) < 1e-5 ? 1.0 : aW);
  fragColor = vec4(clamp(pix, mn4, mx4), 1.0);
}
`;

  /* ---- B2. separable Lanczos-3, kept as the alternate upscaler ---------- */
  const FRAG_RESAMPLE = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2  uSrcSize;
uniform vec2  uSrcOff;
uniform vec2  uSrcScl;
uniform float uHoriz;
uniform float uAntiring;
uniform float uFilterScale;
in  vec2 vUV;
out vec4 fragColor;

const float PI = 3.141592653589793;
float sinc(float x){ return x == 0.0 ? 1.0 : sin(PI * x) / (PI * x); }
float lanczos(float x){ x = abs(x); return x >= 3.0 ? 0.0 : sinc(x) * sinc(x / 3.0); }

void main(){
  vec2  sc    = (uSrcOff + vUV * uSrcScl) * uSrcSize;
  bool  horiz = uHoriz > 0.5;
  float c     = horiz ? sc.x : sc.y;

  // A resampling kernel has to widen when MINIFYING. With a fixed 6-tap support
  // in source space, an output pixel covering 3 source pixels only ever reads 6
  // of them and skips the rest — that is aliasing, not filtering, and it is what
  // windowed playback was getting. Widen the support by 1/scale and evaluate the
  // kernel in output space. At scale >= 1 this collapses back to plain Lanczos-3.
  float fs      = clamp(uFilterScale, 0.04, 1.0);
  float support = 3.0 / fs;
  int   first   = int(floor(c - support - 0.5));
  int   last    = int(ceil (c + support - 0.5));
  int   nearest = int(floor(c - 0.5));

  vec3  sum  = vec3(0.0);
  float wsum = 0.0;
  vec3  lo   = vec3(1.0);
  vec3  hi   = vec3(0.0);

  for (int k = 0; k < 96; k++) {
    int i = first + k;
    if (i > last) break;
    float s  = float(i) + 0.5;
    float w  = lanczos((c - s) * fs);
    vec2  uv = (horiz ? vec2(s, sc.y) : vec2(sc.x, s)) / uSrcSize;
    vec3  t  = texture(uTex, uv).rgb;
    sum  += t * w;
    wsum += w;
    if (i == nearest || i == nearest + 1) { lo = min(lo, t); hi = max(hi, t); }
  }

  vec3 res = sum / max(wsum, 1e-5);
  fragColor = vec4(mix(res, clamp(res, lo, hi), uAntiring), 1.0);
}
`;


  /* ---- B3. temporal accumulation ---------------------------------------
   * The only change here that recovers real information rather than inferring
   * it. Consecutive frames of the same scene carry slightly different sub-pixel
   * samples (camera drift, grain, encoder noise), so averaging them across time
   * genuinely adds detail and kills noise — where the scene is actually static.
   *
   * With no motion vectors available we cannot follow moving content, so this
   * uses neighbourhood clamping (the standard TAA defence): history is clipped
   * to the local colour box of the current frame. Anything that moved falls
   * outside that box, gets clipped hard, and is then rejected by the feedback
   * term. Net effect: strong gain on static and slow content, gracefully
   * nothing on fast motion, and no ghosting either way.
   */
  /* ---- B2b. optical flow, for multi-frame detail recovery ---------------
   *
   * The one mechanism in this engine that can ADD detail rather than
   * redistribute it. Everything else works from a single frame and therefore
   * cannot know anything the encoder did not send. Consecutive frames of moving
   * footage sample the same scene at DIFFERENT sub-pixel offsets, so fusing
   * aligned frames on the output grid integrates several samplings of the same
   * surface — the same principle that makes temporal supersampling sharper than
   * any single-frame filter.
   *
   * "Aligned" is the whole difficulty. Accumulating at the same UV, which is
   * what this engine did before, fuses a pixel with whatever has since moved
   * into its place; the colour-box clamp then correctly rejects it, so motion
   * simply switched accumulation off. The detail was never being recovered —
   * only noise was being averaged on still parts of the frame.
   *
   * Lucas-Kanade rather than block matching: it returns a SUB-PIXEL
   * displacement directly from a least-squares fit, and sub-pixel is precisely
   * the regime that carries new information. Whole-pixel alignment fuses
   * samples that already agree and adds nothing. It only resolves small
   * motions, which is the right trade — large motion is handled by the
   * rejection clamp downstream, exactly as before.
   *
   * Solved at a quarter of the output resolution but reading FULL-resolution
   * texels, so the gradients keep their precision while costing 16x fewer
   * solves. Flow is smooth; sampling it back with LINEAR is free interpolation.
   */
  const FRAG_FLOW = `#version 300 es
precision highp float;
uniform sampler2D uCur;
uniform sampler2D uHist;
uniform vec2  uTexSize;      // FULL output resolution, not the flow target's
uniform float uMaxFlow;
in  vec2 vUV;
out vec4 fragColor;
${COMMON}

void main(){
  vec2 texel = 1.0 / uTexSize;

  // 7x7 of current (so the inner 5x5 has central differences) and 5x5 of
  // history, gathered once and reused rather than re-fetched per tap.
  float c[49];
  for (int y = 0; y < 7; y++) {
    for (int x = 0; x < 7; x++) {
      c[y * 7 + x] = luma(texture(uCur, vUV + vec2(float(x - 3), float(y - 3)) * texel).rgb);
    }
  }

  float sxx = 0.0, sxy = 0.0, syy = 0.0, sxt = 0.0, syt = 0.0;
  for (int y = 1; y <= 5; y++) {
    for (int x = 1; x <= 5; x++) {
      float gx = (c[y * 7 + x + 1] - c[y * 7 + x - 1]) * 0.5;
      float gy = (c[(y + 1) * 7 + x] - c[(y - 1) * 7 + x]) * 0.5;
      float h  = luma(texture(uHist, vUV + vec2(float(x - 3), float(y - 3)) * texel).rgb);
      float it = h - c[y * 7 + x];
      sxx += gx * gx; sxy += gx * gy; syy += gy * gy;
      sxt += gx * it; syt += gy * it;
    }
  }

  // A flat or one-dimensional patch leaves the system singular or nearly so —
  // the aperture problem. Refusing to answer there is correct: a confident
  // wrong displacement drags unrelated pixels together and invents detail,
  // which is the exact failure this stage exists to avoid.
  float det = sxx * syy - sxy * sxy;
  float tr  = sxx + syy;
  vec2  flow = vec2(0.0);
  float conf = 0.0;
  if (det > 1e-7 && tr > 1e-4) {
    // d = -A^-1 b. Minimising sum (grad.d + It)^2 with It = hist - cur gives
    // A d = -b, so the NEGATIVE matters: with the sign flipped the warp moves
    // history away from the match instead of toward it, which measured as
    // -5.8 dB against doing nothing at all — worse than no alignment, and in a
    // way that looks like "the idea does not work" rather than "the sign is
    // wrong".
    flow = -vec2(syy * sxt - sxy * syt, sxx * syt - sxy * sxt) / det;
    // Trust it only while it is small AND the patch had structure in both
    // directions. det/tr is the smaller eigenvalue's scale — the standard
    // corner test — and it is what separates a trackable patch from an edge.
    float len = length(flow);
    conf = smoothstep(0.0, 0.002, det / max(tr, 1e-6)) *
           (1.0 - smoothstep(uMaxFlow * 0.6, uMaxFlow, len));
  }
  fragColor = vec4(clamp(flow, vec2(-uMaxFlow), vec2(uMaxFlow)), conf, 1.0);
}
`;

  const FRAG_TEMPORAL = `#version 300 es
precision highp float;
uniform sampler2D uCur;
uniform sampler2D uHist;
uniform sampler2D uFlow;
uniform vec2  uTexSize;
uniform float uFeedback;
uniform float uHasHist;
uniform float uAlign;        // 0 = accumulate in place, 1 = follow the flow
in  vec2 vUV;
out vec4 fragColor;

void main(){
  vec3 c = texture(uCur, vUV).rgb;
  if (uFeedback <= 0.0 || uHasHist < 0.5) { fragColor = vec4(c, 1.0); return; }

  // colour box of the 3x3 neighbourhood in the CURRENT frame
  vec3 mn = c, mx = c;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 s = texture(uCur, vUV + vec2(float(x), float(y)) / uTexSize).rgb;
      mn = min(mn, s);
      mx = max(mx, s);
    }
  }

  // Follow the motion before fusing. Without this the accumulation pairs a
  // pixel with whatever has since moved into its place, the clamp below
  // correctly rejects it, and the whole stage quietly degrades to "averages
  // noise on the parts of the frame that were not moving".
  vec2 off = vec2(0.0);
  float conf = 1.0;
  if (uAlign > 0.5) {
    vec3 f = texture(uFlow, vUV).rgb;
    conf = f.z;
    off  = f.xy * conf / uTexSize;
  }

  vec3 h  = texture(uHist, vUV + off).rgb;
  vec3 hc = clamp(h, mn, mx);

  // How far the clamp had to move history is our motion signal: a large move
  // means this pixel is not what it was, so stop trusting the past.
  //
  // NB: measured per-channel, NOT as length() of the RGB difference. length()
  // multiplies a grey-scale deviation by sqrt(3), which tripped the rejection
  // on ordinary sensor noise and throttled accumulation to about a third of the
  // requested feedback.
  vec3  d   = abs(hc - h);
  float rej = max(max(d.r, d.g), d.b);
  float fb  = uFeedback * (1.0 - smoothstep(0.030, 0.200, rej));
  fragColor = vec4(mix(c, hc, fb), 1.0);
}
`;


  /* ---- B3b. iterative back-projection -----------------------------------
   *
   * The step that makes multi-frame actually reconstruct instead of average.
   *
   * Weighted accumulation cannot add detail, and the reason is structural: every
   * source pixel is an AREA AVERAGE of the scene, and the mean of aligned area
   * averages is just another area average. Measured, real sub-pixel-shifted
   * frames scored no better than copies of one frame.
   *
   * Back-projection asks a different question. Instead of blending estimates, it
   * takes the current high-resolution estimate, SIMULATES the camera — averages
   * it back down over each source pixel's footprint — and compares that against
   * what was actually observed. Where the simulation disagrees with the
   * observation, the estimate is wrong, and the disagreement is added back.
   *
   * With one frame this is deconvolution: it undoes the blur of magnifying and
   * nothing more. Its value is that the accumulated estimate carries content
   * from SEVERAL frames at different sub-pixel offsets, so the constraint from
   * each new observation is a genuinely new equation about the same surface.
   * That is what recovers detail rather than sharpening.
   *
   * Whether that works is a measurement, not an argument: the suite runs the
   * copies-versus-real-frames ablation, and if back-projection helps copies just
   * as much then it is sharpening and should be called sharpening.
   */
  const FRAG_BACKPROJ = `#version 300 es
precision highp float;
uniform sampler2D uEst;      // current estimate, output resolution
uniform sampler2D uObs;      // what was actually observed, source resolution
uniform vec2  uSrcSize;
uniform vec2  uSrcOff;
uniform vec2  uSrcScl;
uniform float uGain;
in  vec2 vUV;
out vec4 fragColor;

void main(){
  vec3 est = texture(uEst, vUV).rgb;

  // Which source pixel does this output pixel fall inside, and where is its
  // centre back in output space?
  vec2 srcUV = uSrcOff + vUV * uSrcScl;
  vec2 sp    = srcUV * uSrcSize;
  vec2 base  = (floor(sp) + 0.5) / uSrcSize;
  vec2 outUV = (base - uSrcOff) / max(uSrcScl, vec2(1e-6));

  // Simulate the observation: average the estimate over that pixel's footprint.
  // Four taps at the quarter points is a box average good enough for the 2x
  // regime this runs in, and the whole pass stays at six fetches.
  vec2 q = 0.25 / (uSrcSize * uSrcScl);
  vec3 avg = 0.25 * (texture(uEst, outUV + vec2(-q.x, -q.y)).rgb +
                     texture(uEst, outUV + vec2( q.x, -q.y)).rgb +
                     texture(uEst, outUV + vec2(-q.x,  q.y)).rgb +
                     texture(uEst, outUV + vec2( q.x,  q.y)).rgb);

  vec3 obs   = texture(uObs, base).rgb;
  vec3 resid = obs - avg;

  // Clamp the correction. Where the estimate is wrong for reasons back-
  // projection cannot fix — occlusion, a scene cut, a bad flow vector — the
  // residual is large and meaningless, and letting it through would print the
  // error into the picture at full strength.
  resid = clamp(resid, vec3(-0.25), vec3(0.25));
  fragColor = vec4(est + uGain * resid, 1.0);
}
`;

  /* ---- B4. cheap multi-scale base -------------------------------------
   * Local contrast needs blurred copies of the image at a couple of scales.
   * Doing that with wide taps at output resolution would cost more than the
   * whole rest of the chain, so instead downsample twice with a 4x4 box. The
   * first target is 1/16 the pixels and the second 1/256, which makes both
   * passes near-free, and sampling them back with LINEAR gives a smooth
   * large-radius blur for nothing.
   */
  const FRAG_DOWN = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexel;
in  vec2 vUV;
out vec4 fragColor;
void main(){
  vec3 sum = vec3(0.0);
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      vec2 o = (vec2(float(x), float(y)) - 1.5) * uTexel;
      sum += texture(uTex, vUV + o).rgb;
    }
  }
  fragColor = vec4(sum / 16.0, 1.0);
}
`;

  /* ---- C. RCAS / CAS sharpen + grade + dither --------------------------- */
  const FRAG_FINISH = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform sampler2D uRaw;
uniform vec2  uTexSize;
uniform float uSharp;
uniform float uSat;
uniform float uContrast;
uniform float uGain;
uniform float uSplit;
uniform float uLegacyCas;
uniform vec2  uRawOff;
uniform vec2  uRawScl;
uniform sampler2D uBase1;
uniform sampler2D uBase2;
uniform float uDetail;
uniform float uVibrance;
uniform float uShadow;
in  vec2 vUV;
out vec4 fragColor;
${COMMON}

vec3 fetch(vec2 o){ return texture(uTex, vUV + o / uTexSize).rgb; }

void main(){
  if (uSplit > 0.0 && vUV.x < uSplit) {
    vec3  raw  = texture(uRaw, uRawOff + vUV * uRawScl).rgb;
    float dist = abs(vUV.x - uSplit) * uTexSize.x;
    fragColor  = vec4(dist < 1.5 ? vec3(1.0, 0.82, 0.16) : raw, 1.0);
    return;
  }

  vec3 b = fetch(vec2( 0.0, -1.0));
  vec3 d = fetch(vec2(-1.0,  0.0));
  vec3 e = fetch(vec2( 0.0,  0.0));
  vec3 f = fetch(vec2( 1.0,  0.0));
  vec3 h = fetch(vec2( 0.0,  1.0));
  float s = clamp(uSharp, 0.0, 1.0);
  vec3 outc;

  if (uLegacyCas > 0.5) {
    // --- CAS: 9-tap, scales sharpening by local contrast -----------------
    vec3 a = fetch(vec2(-1.0,-1.0)), c = fetch(vec2(1.0,-1.0));
    vec3 g = fetch(vec2(-1.0, 1.0)), i = fetch(vec2(1.0, 1.0));
    vec3 mn = min(min(min(d,e), min(f,b)), h);
    mn += min(mn, min(min(a,c), min(g,i)));
    vec3 mx = max(max(max(d,e), max(f,b)), h);
    mx += max(mx, max(max(a,c), max(g,i)));
    vec3  amp  = sqrt(clamp(min(mn, 2.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
    float peak = -1.0 / mix(8.0, 5.0, s);
    vec3  w    = amp * peak * s;
    outc = (b * w + d * w + f * w + h * w + e) / (4.0 * w + 1.0);
  } else {
    // --- RCAS: 5-tap cross, limiter derived from the local extremes so the
    // sharpening lobe can never overshoot into a ring ---------------------
    vec3 mn4 = min(min(b, d), min(f, h));
    vec3 mx4 = max(max(b, d), max(f, h));
    vec3 hitMin = mn4 / max(4.0 * mx4, vec3(1e-5));
    vec3 hitMax = (1.0 - mx4) / min(4.0 * mn4 - 4.0, vec3(-1e-5));
    vec3 lobeRGB = max(-hitMin, hitMax);
    float lobe = max(-0.1875, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * s;
    outc = (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);
  }

  outc = clamp(outc, 0.0, 1.0);

  // --- local contrast ------------------------------------------------------
  // The single biggest lever on PERCEIVED quality, and a different thing from
  // sharpening: sharpening works at the pixel scale, this works at the tens-of-
  // pixels scale and is what reads as depth and "pop". Boost the band between
  // two blur radii, clamped so it cannot turn into a halo.
  if (uDetail > 0.0) {
    vec3 b1 = texture(uBase1, vUV).rgb;
    vec3 b2 = texture(uBase2, vUV).rgb;
    vec3 add = (b1 - b2) * (uDetail * 1.8);
    outc = clamp(outc + clamp(add, -0.16, 0.16), 0.0, 1.0);
  }

  // --- shadow lift ---------------------------------------------------------
  // Opens up dark scenes without crushing black or clipping: the term vanishes
  // at both ends and peaks in the low mids.
  if (uShadow > 0.0) {
    float L = luma(outc);
    outc += uShadow * (1.0 - L) * (1.0 - L) * (1.0 - outc) * 0.55;
  }

  float lum = luma(outc);
  outc = mix(vec3(lum), outc, uSat);

  // --- vibrance ------------------------------------------------------------
  // Saturation that knows when to stop: pushes muted colour hard, already-
  // saturated colour barely at all, and backs off on skin tones (Cr high with
  // Cb low) so faces do not go orange.
  if (uVibrance > 0.0) {
    float mx = max(outc.r, max(outc.g, outc.b));
    float mn = min(outc.r, min(outc.g, outc.b));
    float sat = mx - mn;
    vec3  yc  = vec3(lum, (outc.b - lum) / 1.8556, (outc.r - lum) / 1.5748);
    float skin = smoothstep(0.02, 0.16, yc.z) * smoothstep(0.02, -0.10, yc.y);
    float amt = uVibrance * (1.0 - smoothstep(0.15, 0.75, sat)) * (1.0 - 0.75 * skin);
    outc = mix(vec3(lum), outc, 1.0 + amt);
  }

  outc = (outc - 0.5) * uContrast + 0.5;
  outc = outc * uGain;

  // triangular dither, so the trip back to 8 bits does not re-introduce the
  // banding the deband pass just removed
  float n1 = hash12(floor(gl_FragCoord.xy));
  float n2 = hash12(floor(gl_FragCoord.xy) + 17.0);
  outc += (n1 + n2 - 1.0) / 255.0;

  fragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}
`;

  function compile(gl, type, src, label) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`[VideoUpscaler] ${label} shader failed to compile:\n${log}`);
    }
    return sh;
  }

  function program(gl, fragSrc, label) {
    const p = gl.createProgram();
    const vs = compile(gl, gl.VERTEX_SHADER, VERT, label + ':vert');
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc, label + ':frag');
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error(`[VideoUpscaler] ${label} program failed to link:\n${log}`);
    }
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let k = 0; k < n; k++) {
      const name = gl.getActiveUniform(p, k).name;
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  function createEngine(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false,
      // desynchronized is deliberately OFF: the low-latency path can put the
      // canvas on a scanout overlay that screen-capture does not see, which is
      // precisely the thing this extension exists to avoid.
      desynchronized: false,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });
    if (!gl) return null;

    // 16-bit float intermediates where the GPU can render to them, so four
    // passes do not quantise to 8 bits four times over.
    const extF = gl.getExtension('EXT_color_buffer_float');
    const hf = gl.getExtension('EXT_color_buffer_half_float') || extF;
    const IFMT = hf ? gl.RGBA16F : gl.RGBA;
    const ITYP = hf ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    // The CNN accumulates ~72 weighted terms per output channel per layer, over
    // four layers. Half-float loses enough across that chain to be visible, so
    // feature maps get full float32 where the GPU can render to it.
    const NFMT = extF ? gl.RGBA32F : IFMT;
    const NTYP = extF ? gl.FLOAT : ITYP;

    /** n textures sharing one framebuffer, so a pass can write all of them. */
    function makeMRT(w, h, n) {
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      const texs = [], bufs = [];
      for (let i = 0; i < n; i++) {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, NFMT, w, h, 0, gl.RGBA, NTYP, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
        texs.push(t);
        bufs.push(gl.COLOR_ATTACHMENT0 + i);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { texs, fb, bufs, w, h, mrt: true };
    }

    function makeTarget(w, h) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, IFMT, w, h, 0, gl.RGBA, ITYP, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex, fb, w, h };
    }

    const progMeasure  = program(gl, FRAG_MEASURE,  'measure');
    const progRestore  = program(gl, FRAG_RESTORE,  'restore');
    const progClean    = program(gl, FRAG_CLEAN,    'clean');
    const progEasu     = program(gl, FRAG_EASU,     'easu');
    const progFlow     = program(gl, FRAG_FLOW,     'flow');
    const progBackproj = program(gl, FRAG_BACKPROJ, 'backproj');
    const progTemporal = program(gl, FRAG_TEMPORAL, 'temporal');
    const progDown     = program(gl, FRAG_DOWN,     'down');
    const progResample = program(gl, FRAG_RESAMPLE, 'resample');
    const progFinish   = program(gl, FRAG_FINISH,   'finish');

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    // The measurement target is deliberately 8-bit: readPixels of FLOAT needs a
    // float-renderable framebuffer and the right extension, and the values here
    // are sums of a few dozen gradients averaged over hundreds of tiles, so
    // 8-bit quantisation is far below the noise of the estimate.
    const MEAS_TILES = [32, 16];
    const MEAS_SCALE = 8;      // shader divides by this so sums land inside 0..1
    function makeTarget8(w, h) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex, fb, w, h };
    }

    let tMeasure = null, tFlow = null, tBP = null;
    let tRestore = null, tClean = null, tMid = null, tUp = null;
    let tHist = [null, null];
    let tBase1 = null, tBase2 = null;
    let cnn = null, cnnFailed = false;
    let featA = null, featB = null, tRes = null, tNeural = null;
    let histIndex = 0, histValid = false;
    let srcW = 0, srcH = 0;
    let disposed = false;

    const fit = (t, w, h) => {
      if (t && t.w === w && t.h === h) return t;
      if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
      return makeTarget(w, h);
    };

    function blit(prog, target, setUniforms) {
      gl.useProgram(prog.p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
      if (target && target.mrt) gl.drawBuffers(target.bufs);
      else if (target) gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.viewport(0, 0, target ? target.w : canvas.width, target ? target.h : canvas.height);
      setUniforms(prog.u);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /* ---- neural 2x luma doubler -------------------------------------------
     * A small CNN (see cnn/train.py) trained on live-action video. Feature maps
     * are RGBA textures, so 8 filters = 2 textures written together via MRT;
     * ReLU is applied on read. The net predicts a residual which is added to a
     * bilinear 2x base — the same base it was trained against.
     */
    function ensureCnn() {
      if (cnn || cnnFailed) return cnn;
      const W = window.VUCNNWeights;
      if (!W) { cnnFailed = true; return null; }
      try {
        cnn = {
          groups: W.groups,
          l1: program(gl, W.L1, 'cnn:l1'),
          mid: W.MID.map((src, i) => program(gl, src, 'cnn:mid' + i)),
          out: program(gl, W.OUT, 'cnn:out'),
          combine: program(gl, W.COMBINE, 'cnn:combine'),
        };
      } catch (e) {
        console.warn('[VideoUpscaler] neural upscaler unavailable:', e.message);
        cnnFailed = true;
        cnn = null;
      }
      return cnn;
    }

    /** Runs the net on `srcTex` and returns a 2x target, or null if unavailable. */
    function runCnn(srcTex, w, h) {
      const P = ensureCnn();
      if (!P) return null;
      const G = P.groups;
      if (!featA || featA.w !== w || featA.h !== h || featA.texs.length !== G) {
        for (const t of [featA, featB]) {
          if (t) { t.texs.forEach((x) => gl.deleteTexture(x)); gl.deleteFramebuffer(t.fb); }
        }
        featA = makeMRT(w, h, G);
        featB = makeMRT(w, h, G);
      }
      if (!tRes || tRes.w !== w || tRes.h !== h) {
        if (tRes) { gl.deleteTexture(tRes.tex); gl.deleteFramebuffer(tRes.fb); }
        tRes = makeMRT(w, h, 1);
        tRes.tex = tRes.texs[0];
      }
      tNeural = fit(tNeural, w * 2, h * 2);
      const texel = [1 / w, 1 / h];

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      blit(P.l1, featA, (u) => {
        gl.uniform1i(u.uSrc, 0);
        gl.uniform2f(u.uTexel, texel[0], texel[1]);
      });

      let cur = featA, nxt = featB;
      for (const prog of P.mid) {
        for (let i = 0; i < G; i++) {
          gl.activeTexture(gl.TEXTURE0 + i);
          gl.bindTexture(gl.TEXTURE_2D, cur.texs[i]);
        }
        blit(prog, nxt, (u) => {
          for (let i = 0; i < G; i++) gl.uniform1i(u['uIn' + i], i);
          gl.uniform2f(u.uTexel, texel[0], texel[1]);
        });
        const t = cur; cur = nxt; nxt = t;
      }

      for (let i = 0; i < G; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, cur.texs[i]);
      }
      blit(P.out, tRes, (u) => {
        for (let i = 0; i < G; i++) gl.uniform1i(u['uIn' + i], i);
        gl.uniform2f(u.uTexel, texel[0], texel[1]);
      });

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, tRes.tex);
      blit(P.combine, tNeural, (u) => {
        gl.uniform1i(u.uSrc, 0);
        gl.uniform1i(u.uRes, 1);
        gl.uniform2f(u.uOutSize, w * 2, h * 2);
      });
      return tNeural;
    }

    return {
      gl,
      get lost() { return disposed || gl.isContextLost(); },
      get neuralAvailable() { return !!ensureCnn(); },
      runCnnFor(source, w, h) {   // test hook: run the net standalone
        gl.bindTexture(gl.TEXTURE_2D, srcTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        srcW = w; srcH = h;
        return runCnn(srcTex, w, h);
      },
      get precision() { return hf ? 'half-float' : '8-bit'; },

      upload(source) {
        gl.bindTexture(gl.TEXTURE_2D, srcTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        srcW = source.videoWidth || source.width || 0;
        srcH = source.videoHeight || source.height || 0;
      },

      render(o) {
        if (!srcW || !srcH) return false;
        const outW = canvas.width, outH = canvas.height;
        if (!outW || !outH) return false;

        const denoise = Math.max(0, Math.min(1, o.denoise ?? 0));
        const deband  = Math.max(0, Math.min(1, o.deband ?? 0));
        const chroma  = Math.max(0, Math.min(1, o.chroma ?? 0));
        const deblock = Math.max(0, Math.min(1, o.deblock ?? 0));
        const dering  = Math.max(0, Math.min(1, o.dering ?? 0));
        const ar      = Math.max(0, Math.min(1, o.antiring ?? 0.55));
        const scale   = outW / srcW;
        // EASU is a magnification filter; at or below 1:1 the separable path is
        // both cheaper and exactly identity, so use it there.
        const useEasu = (o.upscaler ?? 'fsr') === 'fsr' && scale > 1.0001;
        // Which part of the source is actually on screen. object-fit: cover and
        // none crop; contain and fill do not. Defaults to the whole frame.
        const r = o.srcRect || [0, 0, 1, 1];

        gl.bindVertexArray(vao);
        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);

        // --- A0. restore: undo compression damage ---------------------------
        // Runs FIRST, on the raw decoded pixels: the block grid is crisp there,
        // and every later stage (denoise, deband, upscale, local contrast) is
        // better off not being handed the artifacts in the first place.
        let stage = srcTex;
        if (deblock > 0 || dering > 0) {
          tRestore = fit(tRestore, srcW, srcH);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, srcTex);
          blit(progRestore, tRestore, (u) => {
            gl.uniform1i(u.uTex, 0);
            gl.uniform2f(u.uSrcSize, srcW, srcH);
            gl.uniform1f(u.uDeblock, deblock);
            gl.uniform1f(u.uDering, dering);
            gl.uniform2f(u.uGridPhase, o.gridPhaseX ?? 0, o.gridPhaseY ?? 0);
            gl.uniform1f(u.uGridPeriod, (o.gridPeriod === 4) ? 4 : 8);
          });
          stage = tRestore.tex;
        }

        // --- A. clean -------------------------------------------------------
        if (denoise > 0 || deband > 0 || chroma > 0) {
          tClean = fit(tClean, srcW, srcH);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, stage);
          blit(progClean, tClean, (u) => {
            gl.uniform1i(u.uTex, 0);
            gl.uniform2f(u.uSrcSize, srcW, srcH);
            gl.uniform1f(u.uDenoise, denoise);
            gl.uniform1f(u.uDeband, deband);
            gl.uniform1f(u.uChroma, chroma);
          });
          stage = tClean.tex;
        }

        // --- A2. neural 2x doubler ------------------------------------------
        // Only worth running when actually magnifying; below ~1.3x the classical
        // path is already at or past the display's pixel count.
        let stageW = srcW, stageH = srcH;
        if ((o.neural ?? 0) > 0 && scale > 1.3) {
          const nt = runCnn(stage, srcW, srcH);
          if (nt) { stage = nt.tex; stageW = nt.w; stageH = nt.h; }
        }

        // --- B. upscale -----------------------------------------------------
        tUp = fit(tUp, outW, outH);
        if (useEasu) {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, stage);
          blit(progEasu, tUp, (u) => {
            gl.uniform1i(u.uTex, 0);
            gl.uniform2f(u.uSrcSize, stageW, stageH);
            gl.uniform2f(u.uSrcOff, r[0], r[1]);
            gl.uniform2f(u.uSrcScl, r[2], r[3]);
          });
        } else {
          tMid = fit(tMid, outW, stageH);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, stage);
          blit(progResample, tMid, (u) => {
            gl.uniform1i(u.uTex, 0);
            gl.uniform2f(u.uSrcSize, stageW, stageH);
            gl.uniform2f(u.uSrcOff, r[0], 0);
            gl.uniform2f(u.uSrcScl, r[2], 1);
            gl.uniform1f(u.uFilterScale, Math.min(1, outW / Math.max(1, stageW * r[2])));
            gl.uniform1f(u.uHoriz, 1);
            gl.uniform1f(u.uAntiring, ar);
          });
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, tMid.tex);
          blit(progResample, tUp, (u) => {
            gl.uniform1i(u.uTex, 0);
            gl.uniform2f(u.uSrcSize, tMid.w, tMid.h);
            gl.uniform2f(u.uSrcOff, 0, r[1]);
            gl.uniform2f(u.uSrcScl, 1, r[3]);
            gl.uniform1f(u.uFilterScale, Math.min(1, outH / Math.max(1, stageH * r[3])));
            gl.uniform1f(u.uHoriz, 0);
            gl.uniform1f(u.uAntiring, ar);
          });
        }

        // --- B3. temporal accumulation --------------------------------------
        let shown = tUp;
        const temporal = Math.max(0, Math.min(0.95, o.temporal ?? 0));
        if (temporal > 0) {
          const prev = tHist[histIndex];
          const next = tHist[histIndex = 1 - histIndex] = fit(tHist[histIndex], outW, outH);
          const ok = histValid && prev && prev.w === outW && prev.h === outH;

          // Estimate motion before fusing. Quarter resolution, full-resolution
          // taps: 16x fewer least-squares solves with no loss of gradient
          // precision, and the flow field is smooth enough that reading it back
          // with LINEAR is all the interpolation it needs.
          const align = (o.align ?? 1) > 0 && ok;
          if (align) {
            const fw = Math.max(2, outW >> 2), fh = Math.max(2, outH >> 2);
            tFlow = fit(tFlow, fw, fh);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tUp.tex);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, prev.tex);
            blit(progFlow, tFlow, (u) => {
              gl.uniform1i(u.uCur, 0);
              gl.uniform1i(u.uHist, 1);
              gl.uniform2f(u.uTexSize, outW, outH);
              gl.uniform1f(u.uMaxFlow, o.maxFlow ?? 3.0);
            });
          }

          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, tUp.tex);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, ok ? prev.tex : tUp.tex);
          if (align) {
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, tFlow.tex);
          }
          blit(progTemporal, next, (u) => {
            gl.uniform1i(u.uCur, 0);
            gl.uniform1i(u.uHist, 1);
            gl.uniform1i(u.uFlow, 2);
            gl.uniform2f(u.uTexSize, outW, outH);
            gl.uniform1f(u.uFeedback, temporal);
            gl.uniform1f(u.uHasHist, ok ? 1 : 0);
            gl.uniform1f(u.uAlign, align ? 1 : 0);
          });
          histValid = true;
          shown = next;
        } else {
          histValid = false;
        }

        // --- B3b. back-projection -------------------------------------------
        // Enforce consistency with what was actually observed. Only meaningful
        // once history holds more than one frame — on the first frame the
        // estimate is a single upscale and this degrades to plain sharpening.
        const bp = Math.max(0, Math.min(1, o.backproject ?? 0));
        if (bp > 0) {
          tBP = fit(tBP, outW, outH);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, shown.tex);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, stage);      // post-restore observation
          blit(progBackproj, tBP, (u) => {
            gl.uniform1i(u.uEst, 0);
            gl.uniform1i(u.uObs, 1);
            gl.uniform2f(u.uSrcSize, stageW, stageH);
            gl.uniform2f(u.uSrcOff, r[0], r[1]);
            gl.uniform2f(u.uSrcScl, r[2], r[3]);
            gl.uniform1f(u.uGain, bp);
          });
          shown = tBP;
        }

        // --- B4. multi-scale base for local contrast ------------------------
        const detail = Math.max(0, Math.min(1, o.detail ?? 0));
        if (detail > 0) {
          const w1 = Math.max(2, outW >> 2), h1 = Math.max(2, outH >> 2);
          const w2 = Math.max(2, outW >> 5), h2 = Math.max(2, outH >> 5);
          tBase1 = fit(tBase1, w1, h1);
          tBase2 = fit(tBase2, w2, h2);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, shown.tex);
          blit(progDown, tBase1, (u) => {
            gl.uniform1i(u.uTex, 0);
            gl.uniform2f(u.uTexel, 1 / outW, 1 / outH);
          });
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, tBase1.tex);
          blit(progDown, tBase2, (u) => {
            gl.uniform1i(u.uTex, 0);
            gl.uniform2f(u.uTexel, 1 / w1, 1 / h1);
          });
        }

        // --- C. finish ------------------------------------------------------
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, shown.tex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, srcTex);
        blit(progFinish, null, (u) => {
          gl.uniform1i(u.uTex, 0);
          gl.uniform1i(u.uRaw, 1);
          gl.uniform2f(u.uTexSize, outW, outH);
          gl.uniform1f(u.uSharp,     o.sharpen ?? 0.5);
          gl.uniform1f(u.uSat,       o.saturation ?? 1);
          gl.uniform1f(u.uContrast,  o.contrast ?? 1);
          gl.uniform1f(u.uGain,      o.gain ?? 1);
          gl.uniform1f(u.uSplit,     o.split ?? 0);
          gl.uniform1f(u.uLegacyCas, (o.sharpener === 'cas') ? 1 : 0);
          gl.uniform2f(u.uRawOff, r[0], r[1]);
          gl.uniform2f(u.uRawScl, r[2], r[3]);
          gl.uniform1f(u.uDetail, detail);
          gl.uniform1f(u.uVibrance, o.vibrance ?? 0);
          gl.uniform1f(u.uShadow, o.shadow ?? 0);
          if (detail > 0) {
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, tBase1.tex);
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D, tBase2.tex);
            gl.uniform1i(u.uBase1, 2);
            gl.uniform1i(u.uBase2, 3);
          }
        });
        return true;
      },

      /**
       * Measure the transform grid of whatever was last uploaded.
       *
       * Returns { blockiness, phaseX, phaseY, period } or null if there is
       * nothing to measure. `blockiness` is the average gradient on the grid
       * over the average gradient off it — 1.0 means no blocking, and it is the
       * same quantity the test suite checks, so the two are comparable.
       *
       * Costs one small pass plus a readPixels, which stalls the pipeline.
       * Call it every couple of seconds, never per frame.
       */
      measureGrid() {
        if (!srcW || !srcH) return null;
        const [tx, ty] = MEAS_TILES;
        if (!tMeasure) tMeasure = makeTarget8(tx * 4, ty);

        gl.bindVertexArray(vao);
        gl.disable(gl.BLEND);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, srcTex);
        blit(progMeasure, tMeasure, (u) => {
          gl.uniform1i(u.uTex, 0);
          gl.uniform2f(u.uSrcSize, srcW, srcH);
          gl.uniform2f(u.uTiles, tx, ty);
        });

        const px = new Uint8Array(tMeasure.w * tMeasure.h * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, tMeasure.fb);
        gl.readPixels(0, 0, tMeasure.w, tMeasure.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        const bx = new Float64Array(8), by = new Float64Array(8);
        for (let y = 0; y < tMeasure.h; y++) {
          for (let x = 0; x < tMeasure.w; x++) {
            const base = (y * tMeasure.w + x) * 4;
            const sub = x & 3;
            const bins = (sub >= 2) ? by : bx;
            const off = (sub & 1) ? 4 : 0;
            for (let c = 0; c < 4; c++) bins[off + c] += px[base + c];
          }
        }

        // One axis: which phase stands above the rest, by how much, and whether
        // a second boundary sits four away (a 4-px transform grid).
        const axis = (bins) => {
          let total = 0;
          for (let i = 0; i < 8; i++) total += bins[i];
          if (!(total > 0)) return null;
          let phase = 0;
          for (let i = 1; i < 8; i++) if (bins[i] > bins[phase]) phase = i;
          const rest = (total - bins[phase]) / 7;
          const opp = bins[(phase + 4) % 8];
          let others = 0;
          for (let i = 0; i < 8; i++) if (i !== phase && i !== (phase + 4) % 8) others += bins[i];
          others /= 6;
          return {
            phase,
            ratio: rest > 0 ? bins[phase] / rest : 1,
            half: others > 0 && opp / others > 1.30,
          };
        };
        const ax = axis(bx), ay = axis(by);
        if (!ax || !ay) return null;

        return {
          // Report the worse axis: it is the one the picture is judged by.
          blockiness: Math.max(ax.ratio, ay.ratio),
          phaseX: ax.phase,
          phaseY: ay.phase,
          period: (ax.half && ay.half) ? 4 : 8,
        };
      },

      sampleBrightness() {
        const N = 8;
        const px = new Uint8Array(N * N * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const x = Math.max(0, ((canvas.width - N) / 2) | 0);
        const y = Math.max(0, ((canvas.height - N) / 2) | 0);
        gl.readPixels(x, y, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let sum = 0;
        for (let k = 0; k < px.length; k += 4) sum += px[k] + px[k + 1] + px[k + 2];
        return sum / (N * N * 3);
      },

      sourceSize() { return { w: srcW, h: srcH }; },

      /** Forget accumulated history — call on seek, track change or resize. */
      resetTemporal() { histValid = false; },

      dispose() {
        if (disposed) return;
        disposed = true;
        try {
          for (const t of [featA, featB]) {
            if (t) { t.texs.forEach((x) => gl.deleteTexture(x)); gl.deleteFramebuffer(t.fb); }
          }
          for (const t of [tMeasure, tFlow, tBP, tRestore, tClean, tMid, tUp, tHist[0], tHist[1], tBase1, tBase2, tRes, tNeural]) {
            if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
          }
          gl.deleteTexture(srcTex);
          gl.deleteBuffer(vbo);
          gl.deleteVertexArray(vao);
          for (const p of [progMeasure, progFlow, progBackproj, progRestore, progClean, progEasu, progResample, progFinish, progTemporal, progDown]) gl.deleteProgram(p.p);
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        } catch (_) { /* teardown is best effort */ }
      },
    };
  }

  window.VUCore = { createEngine, VERT, FRAG_MEASURE, FRAG_FLOW, FRAG_BACKPROJ, FRAG_RESTORE, FRAG_CLEAN, FRAG_EASU, FRAG_RESAMPLE, FRAG_TEMPORAL, FRAG_FINISH };
})();
