"""
Prosperity CRM — branded icon generator
Outputs all PWA / Apple / Android / favicon sizes to crm/public/icons/
"""

import os, struct
from PIL import Image, ImageDraw, ImageFont

OUT = r"c:\Users\loret\Desktop\prosperity-website\crm\public\icons"
os.makedirs(OUT, exist_ok=True)

# Brand palette
PURPLE_DARK  = (58,  31, 112)   # #3a1f70
PURPLE_MID   = (78,  44, 148)   # #4e2c94
PURPLE_LIGHT = (94,  56, 176)   # #5e38b0
GREEN        = (56, 191, 114)   # #38bf72
WHITE        = (255, 255, 255)

# Try fonts in preference order
def load_font(pt):
    for path in [
        r"C:\Windows\Fonts\segoeuib.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\calibrib.ttf",
        r"C:\Windows\Fonts\verdanab.ttf",
        r"C:\Windows\Fonts\arial.ttf",
    ]:
        try:
            return ImageFont.truetype(path, pt)
        except Exception:
            pass
    return ImageFont.load_default()

def make_gradient(S):
    """Top-to-bottom gradient RGBA image, dark->mid purple."""
    img = Image.new("RGBA", (S, S))
    draw = ImageDraw.Draw(img)
    for y in range(S):
        t = y / max(S - 1, 1)
        r = int(PURPLE_DARK[0] + (PURPLE_MID[0] - PURPLE_DARK[0]) * t)
        g = int(PURPLE_DARK[1] + (PURPLE_MID[1] - PURPLE_DARK[1]) * t)
        b = int(PURPLE_DARK[2] + (PURPLE_MID[2] - PURPLE_DARK[2]) * t)
        draw.line([(0, y), (S - 1, y)], fill=(r, g, b, 255))
    return img

def make_icon(px, maskable=False, solid_bg=False):
    """
    Render one icon at `px` × `px`.
    maskable=True  → square full-bleed (no transparency), "P" within safe zone
    solid_bg=True  → opaque purple bg (for Apple touch icons)
    """
    SCALE = 4                          # super-sample for crisp edges
    S = px * SCALE

    # 1. Background gradient
    bg = make_gradient(S)

    if not maskable:
        # Rounded rect clip mask
        radius = S // 5
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1],
                                               radius=radius, fill=255)
        bg.putalpha(mask)
    # maskable stays square + fully opaque

    draw = ImageDraw.Draw(bg)

    # 2. Optional green accent stripe at the bottom (≥ 96 px)
    if px >= 96:
        stripe_h = max(S // 18, 4)
        margin   = S // 20
        y0 = S - stripe_h - margin
        x0 = S // 9
        x1 = S - S // 9
        r  = stripe_h // 2
        draw.rounded_rectangle([x0, y0, x1, y0 + stripe_h],
                                radius=r, fill=GREEN + (255,))

    # 3. White "P" — optically centred, slightly above mid (baseline shift)
    font_pt = int(S * 0.56)
    font    = load_font(font_pt)
    bbox    = draw.textbbox((0, 0), "P", font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (S - tw) // 2 - bbox[0]
    ty = (S - th) // 2 - bbox[1] - int(S * 0.04)   # shift up slightly

    # Soft shadow for depth (skip at tiny sizes)
    if px >= 48:
        shadow_offset = max(S // 80, 2)
        draw.text((tx + shadow_offset, ty + shadow_offset), "P",
                  fill=(0, 0, 0, 80), font=font)

    draw.text((tx, ty), "P", fill=WHITE + (255,), font=font)

    # 4. Downsample with Lanczos
    final = bg.resize((px, px), Image.LANCZOS)
    return final

# ── sizes to generate ────────────────────────────────────────────────────────

icon_specs = [
    ("icon-16.png",             16,  False, False),
    ("icon-32.png",             32,  False, False),
    ("icon-48.png",             48,  False, False),
    ("icon-72.png",             72,  False, False),
    ("icon-96.png",             96,  False, False),
    ("icon-120.png",           120,  False, False),
    ("icon-128.png",           128,  False, False),
    ("icon-144.png",           144,  False, False),
    ("icon-152.png",           152,  False, False),
    ("icon-167.png",           167,  False, False),
    ("icon-180.png",           180,  False, False),
    ("icon-192.png",           192,  False, False),
    ("icon-256.png",           256,  False, False),
    ("icon-384.png",           384,  False, False),
    ("icon-512.png",           512,  False, False),
    # maskable — full bleed, content within safe zone
    ("icon-maskable-192.png",  192,  True,  False),
    ("icon-maskable-512.png",  512,  True,  False),
    # Apple touch icons — opaque, no transparency
    ("apple-touch-icon.png",   180,  False, True ),
    ("apple-touch-icon-152.png",152, False, True ),
    ("apple-touch-icon-167.png",167, False, True ),
]

for (name, px, maskable, solid_bg) in icon_specs:
    img = make_icon(px, maskable=maskable, solid_bg=solid_bg)
    if solid_bg:
        # Flatten onto solid purple background (no transparency)
        bg_solid = Image.new("RGB", (px, px), PURPLE_DARK)
        if img.mode == "RGBA":
            bg_solid.paste(img, mask=img.split()[3])
        else:
            bg_solid.paste(img)
        bg_solid.save(os.path.join(OUT, name))
    else:
        img.save(os.path.join(OUT, name))
    print(f"  ok  {name:35s}  {px}x{px}" + (" [maskable]" if maskable else ""))

# ── favicon.svg (scalable, used by modern browsers) ──────────────────────────

svg = """\
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#3a1f70"/>
      <stop offset="100%" stop-color="#4e2c94"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="20" ry="20" fill="url(#g)"/>
  <rect x="10" y="87" width="80" height="7" rx="3.5" fill="#38bf72"/>
  <text x="50" y="72" font-family="Segoe UI,Arial,sans-serif" font-weight="700"
        font-size="62" fill="#ffffff" text-anchor="middle">P</text>
</svg>
"""
with open(os.path.join(OUT, "favicon.svg"), "w") as f:
    f.write(svg)
print(f"  ok  {'favicon.svg':35s}  scalable")

# ── favicon.ico (16 + 32 + 48 packed) ────────────────────────────────────────

ico_imgs = [make_icon(s) for s in (16, 32, 48)]
ico_imgs[0].save(
    os.path.join(OUT, "favicon.ico"),
    format="ICO",
    sizes=[(16, 16), (32, 32), (48, 48)],
    append_images=ico_imgs[1:],
)
print(f"  ✓  {'favicon.ico':35s}  16/32/48 packed")

# Also drop a copy at public root (browsers look there first)
root_ico = r"c:\Users\loret\Desktop\prosperity-website\crm\public\favicon.ico"
ico_imgs[0].save(
    root_ico, format="ICO",
    sizes=[(16, 16), (32, 32), (48, 48)],
    append_images=ico_imgs[1:],
)
print(f"  ok  favicon.ico -> public root")

# ── splash / desktop install icon (512 maskable copy) ────────────────────────
# Android uses maskable-512 for adaptive icons and splash
# Desktop Chrome install uses icon-512

print("\nAll icons generated.")
print(f"Output: {OUT}")
