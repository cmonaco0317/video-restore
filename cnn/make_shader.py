#!/usr/bin/env python3
"""
Turn weights.json into WebGL2 fragment shaders (cnn-weights.js).

Mapping the network onto WebGL2:

  * Feature maps live in RGBA16F textures, 4 channels each, so the 8-filter
    layers are two textures (A = channels 0-3, B = channels 4-7).
  * WebGL2 has Multiple Render Targets, so one pass writes BOTH halves instead
    of running twice. That is the difference between 4 passes and 8.
  * ReLU is applied when a texture is READ rather than written, so activations
    never need a pass of their own.
  * Weights become mat4 literals. GLSL mat4 is COLUMN-major and `M * v` sums
    columns weighted by v, so column ci must hold the weights of input channel
    ci across all four output channels — i.e. M[ci][co] = w[co][ci].

PyTorch Conv2d cross-correlates, so kernel index (kh, kw) is offset
(dy, dx) = (kh - 1, kw - 1) at padding 1.
"""

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
W = json.loads((HERE / "weights.json").read_text())
F = W["filters"]
GROUPS = F // 4
OFFSETS = [(dy, dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)]


def off(dy, dx):
    """Texture-space offset for a kernel tap at image-space (dy, dx).

    The engine uploads with UNPACK_FLIP_Y_WEBGL, so texture row r is image row
    H-1-r and the vertical axis runs backwards. Convolution is NOT flip
    invariant — a learned asymmetric kernel reading +dy in a flipped texture is
    reading the opposite neighbour from the one it was trained on — so the
    vertical tap must be negated here.
    """
    return f"vec2({dx}.0, {-dy}.0)"


def fmt(x):
    return repr(round(float(x), 7))


def vec4(vals):
    return "vec4(" + ", ".join(fmt(v) for v in vals) + ")"


def mat4_for(w, out_base, in_base, kh, kw):
    """Column ci holds w[out_base+co][in_base+ci][kh][kw] for co in 0..3."""
    cols = []
    for ci in range(4):
        cols += [w[out_base + co][in_base + ci][kh][kw] for co in range(4)]
    return "mat4(" + ", ".join(fmt(v) for v in cols) + ")"


HEADER = """#version 300 es
precision highp float;
in vec2 vUV;
"""


def gen_layer1():
    """Luma in (1 channel) -> F feature channels, written as GROUPS targets."""
    w, b = W["convs"][0]["w"], W["convs"][0]["b"]
    src = HEADER + "uniform sampler2D uSrc;\nuniform vec2 uTexel;\n"
    for g in range(GROUPS):
        src += f"layout(location = {g}) out vec4 o{g};\n"
    src += """
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main(){
"""
    for k, (dy, dx) in enumerate(OFFSETS):
        src += f"  float p{k} = luma(texture(uSrc, vUV + {off(dy, dx)} * uTexel).rgb);\n"
    for g in range(GROUPS):
        bias = [b[g * 4 + c] for c in range(4)]
        src += f"  vec4 a{g} = {vec4(bias)};\n"
        for k, (dy, dx) in enumerate(OFFSETS):
            kh, kw = dy + 1, dx + 1
            coef = [w[g * 4 + c][0][kh][kw] for c in range(4)]
            src += f"  a{g} += {vec4(coef)} * p{k};\n"
        src += f"  o{g} = a{g};\n"
    src += "}\n"
    return src


def gen_mid(idx):
    """F -> F. Reads previous layer through ReLU."""
    w, b = W["convs"][idx]["w"], W["convs"][idx]["b"]
    src = HEADER
    for j in range(GROUPS):
        src += f"uniform sampler2D uIn{j};\n"
    src += "uniform vec2 uTexel;\n"
    for g in range(GROUPS):
        src += f"layout(location = {g}) out vec4 o{g};\n"
    src += "\nvoid main(){\n"
    for k, (dy, dx) in enumerate(OFFSETS):
        for j in range(GROUPS):
            src += (
                f"  vec4 s{k}_{j} = max(texture(uIn{j}, vUV + "
                f"{off(dy, dx)} * uTexel), 0.0);\n"
            )
    for g in range(GROUPS):
        bias = [b[g * 4 + c] for c in range(4)]
        src += f"  vec4 a{g} = {vec4(bias)};\n"
        for k, (dy, dx) in enumerate(OFFSETS):
            kh, kw = dy + 1, dx + 1
            for j in range(GROUPS):
                src += f"  a{g} += {mat4_for(w, g * 4, j * 4, kh, kw)} * s{k}_{j};\n"
        src += f"  o{g} = a{g};\n"
    src += "}\n"
    return src


def gen_out():
    """F -> 4 channels, which the combine pass rearranges into a 2x residual."""
    w, b = W["out"]["w"], W["out"]["b"]
    src = HEADER
    for j in range(GROUPS):
        src += f"uniform sampler2D uIn{j};\n"
    src += "uniform vec2 uTexel;\nout vec4 oRes;\n\nvoid main(){\n"
    for k, (dy, dx) in enumerate(OFFSETS):
        for j in range(GROUPS):
            src += (
                f"  vec4 s{k}_{j} = max(texture(uIn{j}, vUV + "
                f"{off(dy, dx)} * uTexel), 0.0);\n"
            )
    src += f"  vec4 a = {vec4(b)};\n"
    for k, (dy, dx) in enumerate(OFFSETS):
        kh, kw = dy + 1, dx + 1
        for j in range(GROUPS):
            src += f"  a += {mat4_for(w, 0, j * 4, kh, kw)} * s{k}_{j};\n"
    src += "  oRes = a;\n}\n"
    return src


COMBINE = """#version 300 es
precision highp float;
uniform sampler2D uSrc;     // cleaned source, LINEAR filtered
uniform sampler2D uRes;     // 4-channel residual at source resolution
uniform vec2 uOutSize;
in  vec2 vUV;
out vec4 fragColor;

void main(){
  // Sampling the source with LINEAR at the output UV is EXACTLY PyTorch's
  // bilinear 2x with align_corners=False, which is the base the residual was
  // trained against. Getting this wrong would bias every output pixel.
  vec3 base = texture(uSrc, vUV).rgb;

  // pixel shuffle: channel = (y % 2) * 2 + (x % 2), matching pixel_shuffle(2).
  // texelFetch, NOT texture(): the residual is per-source-texel data, and
  // LINEAR filtering would blend neighbouring blocks into each other.
  //
  // The Y PARITY IS INVERTED on purpose. The engine uploads every texture with
  // UNPACK_FLIP_Y_WEBGL, so the whole pipeline runs vertically flipped. Every
  // other operation is indifferent to that, but pixel shuffle depends on
  // absolute row parity: framebuffer row y corresponds to true row 2H-1-y, and
  // 2H-1 is always odd, so the parity always flips. Without this the two rows
  // of every 2x2 block swap and the output is subtly, permanently wrong.
  ivec2 px = ivec2(floor(vUV * uOutSize));
  int c = (1 - (px.y & 1)) * 2 + (px.x & 1);
  vec4 r = texelFetch(uRes, px / 2, 0);
  float d = c == 0 ? r.x : (c == 1 ? r.y : (c == 2 ? r.z : r.w));

  // The net is a LUMA doubler. Adding the same delta to R, G and B shifts luma
  // by exactly d and leaves Cb/Cr untouched, so colour is preserved for free.
  fragColor = vec4(clamp(base + d, 0.0, 1.0), 1.0);
}
"""


def main():
    parts = {
        "L1": gen_layer1(),
        "MID": [gen_mid(i) for i in range(1, len(W["convs"]))],
        "OUT": gen_out(),
        "COMBINE": COMBINE,
    }
    js = (
        "/* GENERATED by cnn/make_shader.py — do not edit by hand.\n"
        f" * TinySR {F} filters x {W['layers']} layers, luma 2x doubler.\n"
        f" * Trained on Tears of Steel (CC BY 3.0, Blender Foundation).\n"
        f" * Held-out PSNR {W['psnr']:.3f} dB (bilinear {W['bilinear']:.3f} dB).\n"
        " */\n"
        "(() => {\n  window.VUCNNWeights = {\n"
        f"    filters: {F}, groups: {GROUPS}, layers: {W['layers']},\n"
        f"    psnr: {W['psnr']:.4f},\n"
        f"    L1: {json.dumps(parts['L1'])},\n"
        f"    MID: {json.dumps(parts['MID'])},\n"
        f"    OUT: {json.dumps(parts['OUT'])},\n"
        f"    COMBINE: {json.dumps(parts['COMBINE'])},\n"
        "  };\n})();\n"
    )
    out = HERE.parent / "cnn-weights.js"
    out.write_text(js)
    kb = len(js) / 1024
    print(
        f"wrote {out.name}  ({kb:.0f} KB, {GROUPS} feature textures, "
        f"{1 + len(parts['MID']) + 1} conv passes + combine)"
    )


if __name__ == "__main__":
    main()
