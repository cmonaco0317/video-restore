# Third-party material

Two things in this repository are not mine, and both carry obligations that
travel with any copy of it.

---

## AMD FidelityFX Super Resolution 1.0 — MIT

`core.js` contains **EASU** (the edge-adaptive upscaling kernel) and **RCAS**
(the sharpening pass) from AMD's FidelityFX Super Resolution 1.0, adapted to
WebGL2 GLSL. `CAS` is retained as the alternate sharpener from the same family.
The variable naming and kernel structure follow AMD's reference, so treat this as
derived from their code rather than an independent reimplementation.

FidelityFX FSR 1.0 is released by Advanced Micro Devices, Inc. under the **MIT
Licence**. Upstream, including the full licence text and copyright notice:

  https://github.com/GPUOpen-Effects/FidelityFX-FSR

If you redistribute this repository you are redistributing that work too, and
MIT requires AMD's copyright notice and permission notice to travel with it.

---

## Tears of Steel — CC BY 3.0, Blender Foundation

*Tears of Steel* (2012), **(CC) Blender Foundation | mango.blender.org**, released
under the **Creative Commons Attribution 3.0** licence.

  https://mango.blender.org/

It appears here in three places, and the third is easy to miss:

1. **Training data.** `cnn/train.py` extracts frames from the 720p release to
   build luma pairs. The film itself is gitignored (355 MB) and is downloaded by
   whoever runs `python cnn/train.py prepare`.

2. **The shipped model weights** — `cnn/weights.json` and the generated
   `cnn-weights.js`. These are *derived from* the film, so the attribution
   follows them into any build that includes them. Both files carry the credit in
   their header.

3. **The test fixtures** — `test/clean.png`, `test/lowbitrate.png`,
   `test/darkrip.png`, `test/lr_clean.png`, `test/lr_compressed.png`. These are
   frames from the film (960×400, the trainer's working size) in degraded and
   undegraded pairs. They are checked into the repository, so they are the copy
   most likely to be redistributed without anyone noticing where they came from.
   See `test/CREDITS.md`.

CC BY 3.0 permits commercial use and derivative works, and requires attribution.
Keep the credit above with any copy, and with any screenshot or figure generated
from these fixtures — the before/after comparisons in `test/compare.html` are
pictures of this film.

---

## Not bundled, but named in the docs

`STATE.md` and `cnn/README.md` compare against **ArtCNN** (MIT), **Anime4K**
(MIT), **FSRCNNX** (GPL-3.0) and **RAVU** (LGPL-3.0). None of their code or
weights are used here — that is the reason `cnn/` trains its own model rather
than porting one. The GPL and LGPL ones in particular were deliberately *not*
adopted, because embedding them would relicense this extension.
