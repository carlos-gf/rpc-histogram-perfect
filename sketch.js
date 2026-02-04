let src;
let outA, outB, outCTRL;

const W = 900;
const H = 900;

const CTRL_TILE = 36;

const BLUR_A = 18.0;
const BLUR_B = 34.0;
const B_LEVELS = 10;

let srcBaseName = "image";
let hiddenFileInput;

function setup() {
  const cnv = createCanvas(W, H);
  pixelDensity(1);
  noLoop();

  cnv.parent("canvas-holder");

  hiddenFileInput = createFileInput(handleFile);
  hiddenFileInput.hide();

  const chooseBtn = document.getElementById("chooseBtn");
  const zipBtn = document.getElementById("zipBtn");

  if (!chooseBtn || !zipBtn) {
    alert("Buttons not found. Check index.html ids chooseBtn and zipBtn.");
    return;
  }

  chooseBtn.addEventListener("click", () => {
    hiddenFileInput.elt.click();
  });

  zipBtn.addEventListener("click", () => {
    saveOutputsZip();
  });

  redraw();
}

function draw() {
  background(0);

  if (!src) {
    fill(220);
    textSize(14);
    text("Choose an image below.", 12, 40);
    textSize(12);
    text("Then download all outputs as a ZIP.", 12, 60);
    return;
  }

  const pad = 16;
  const topOffset = 20;

  const cellW = (width - pad * 3) / 2;
  const cellH = (height - pad * 3 - topOffset) / 2;

  drawFit(src, pad, pad + topOffset, cellW, cellH);
  if (outA) drawFit(outA, pad * 2 + cellW, pad + topOffset, cellW, cellH);
  if (outB) drawFit(outB, pad, pad * 2 + cellH + topOffset, cellW, cellH);
  if (outCTRL) drawFit(outCTRL, pad * 2 + cellW, pad * 2 + cellH + topOffset, cellW, cellH);

  fill(235);
  textSize(12);
  text("SRC", pad, pad + topOffset + 4);
  text("RPC_A", pad * 2 + cellW, pad + topOffset + 4);
  text("RPC_B", pad, pad * 2 + cellH + topOffset + 4);
  text("CTRL", pad * 2 + cellW, pad * 2 + cellH + topOffset + 4);
}

function handleFile(file) {
  if (!file || file.type !== "image") return;

  srcBaseName = baseName(file.name || "image");

  loadImage(file.data, (img) => {
    src = centerCropSquare(img);
    src.resize(W, H);

    regenerate();
  });
}

function regenerate() {
  const fieldA = buildBlurredLuminanceField(src, BLUR_A, 0);
  const fieldB = buildBlurredLuminanceField(src, BLUR_B, B_LEVELS);

  outA = permuteHistogramPerfect(src, fieldA, true);
  outB = permuteHistogramPerfect(src, fieldB, false);

  outCTRL = shuffleTilesDeterministic(src, CTRL_TILE, stableSeedFromName(srcBaseName));

  const zipBtn = document.getElementById("zipBtn");
  if (zipBtn) zipBtn.disabled = false;

  redraw();
}

async function saveOutputsZip() {
  if (!(src && outA && outB && outCTRL)) {
    alert("Load an image first.");
    return;
  }

  const stamp = timestamp();
  const base = `${srcBaseName}_${stamp}`;

  const zip = new JSZip();

  const canvasBlob = await canvasToBlob();
  zip.file(`${base}_CANVAS.png`, canvasBlob);

  zip.file(`${base}_SRC.png`, imageToBlob(src));
  zip.file(`${base}_RPC_A.png`, imageToBlob(outA));
  zip.file(`${base}_RPC_B.png`, imageToBlob(outB));
  zip.file(`${base}_CTRL.png`, imageToBlob(outCTRL));

  const content = await zip.generateAsync({ type: "blob" });
  saveAs(content, `${base}_outputs.zip`);
}

function canvasToBlob() {
  return new Promise((resolve) => {
    const cnv = document.querySelector("canvas");
    cnv.toBlob((blob) => resolve(blob), "image/png");
  });
}

function imageToBlob(img) {
  return dataURLToBlob(img.canvas.toDataURL("image/png"));
}

function dataURLToBlob(dataURL) {
  const parts = dataURL.split(",");
  const mime = parts[0].match(/:(.*?);/)[1];
  const bstr = atob(parts[1]);

  let n = bstr.length;
  const u8 = new Uint8Array(n);

  while (n--) u8[n] = bstr.charCodeAt(n);

  return new Blob([u8], { type: mime });
}

/* Core logic */

function buildBlurredLuminanceField(img, blurRadius, quantLevels) {
  const w = img.width;
  const h = img.height;

  const lum = createImage(w, h);
  img.loadPixels();
  lum.loadPixels();

  for (let i = 0; i < w * h; i++) {
    const r = img.pixels[i * 4 + 0];
    const g = img.pixels[i * 4 + 1];
    const b = img.pixels[i * 4 + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    lum.pixels[i * 4 + 0] = y;
    lum.pixels[i * 4 + 1] = y;
    lum.pixels[i * 4 + 2] = y;
    lum.pixels[i * 4 + 3] = 255;
  }

  lum.updatePixels();
  lum.filter(BLUR, blurRadius);

  lum.loadPixels();
  const field = new Float32Array(w * h);

  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const i = yy * w + xx;
      let v = lum.pixels[i * 4] / 255.0;

      if (quantLevels > 0) v = Math.floor(v * quantLevels) / quantLevels;

      v += xx * 1e-7 + yy * 1e-9;
      field[i] = v;
    }
  }

  return field;
}

function permuteHistogramPerfect(img, dstField, sourceUsesHue) {
  const w = img.width;
  const h = img.height;
  const n = w * h;

  img.loadPixels();

  const srcIdx = new Int32Array(n);
  const dstIdx = new Int32Array(n);
  const srcKey = new Float32Array(n);
  const dstKey = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    srcIdx[i] = i;
    dstIdx[i] = i;
    dstKey[i] = dstField[i];

    const r = img.pixels[i * 4 + 0];
    const g = img.pixels[i * 4 + 1];
    const b = img.pixels[i * 4 + 2];

    if (sourceUsesHue) {
      const c = color(r, g, b);
      colorMode(HSB, 1);

      const hh = hue(c);
      const ss = saturation(c);
      const vv = brightness(c);

      srcKey[i] = hh + ss * 0.08 + vv * 0.02;

      colorMode(RGB, 255);
    } else {
      srcKey[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
  }

  sortIdxByKey(srcIdx, srcKey);
  sortIdxByKey(dstIdx, dstKey);

  const out = createImage(w, h);
  out.loadPixels();

  for (let k = 0; k < n; k++) {
    const s = srcIdx[k];
    const d = dstIdx[k];

    out.pixels[d * 4 + 0] = img.pixels[s * 4 + 0];
    out.pixels[d * 4 + 1] = img.pixels[s * 4 + 1];
    out.pixels[d * 4 + 2] = img.pixels[s * 4 + 2];
    out.pixels[d * 4 + 3] = 255;
  }

  out.updatePixels();
  return out;
}

function shuffleTilesDeterministic(img, tile, seed) {
  const w = img.width;
  const h = img.height;

  const out = createImage(w, h);
  img.loadPixels();
  out.loadPixels();

  const cols = Math.floor(w / tile);
  const rows = Math.floor(h / tile);

  const tileCount = cols * rows;
  const order = new Int32Array(tileCount);
  for (let i = 0; i < tileCount; i++) order[i] = i;

  const rng = mulberry32(seed >>> 0);
  for (let i = tileCount - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  let t = 0;
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const pick = order[t++];

      const sx = (pick % cols) * tile;
      const sy = Math.floor(pick / cols) * tile;

      const dx = tx * tile;
      const dy = ty * tile;

      for (let yy = 0; yy < tile; yy++) {
        for (let xx = 0; xx < tile; xx++) {
          const s = (sy + yy) * w + (sx + xx);
          const d = (dy + yy) * w + (dx + xx);

          out.pixels[d * 4 + 0] = img.pixels[s * 4 + 0];
          out.pixels[d * 4 + 1] = img.pixels[s * 4 + 1];
          out.pixels[d * 4 + 2] = img.pixels[s * 4 + 2];
          out.pixels[d * 4 + 3] = 255;
        }
      }
    }
  }

  out.updatePixels();
  return out;
}

/* Helpers */

function sortIdxByKey(idx, key) {
  Array.from(idx)
    .sort((a, b) => key[a] - key[b])
    .forEach((v, i) => (idx[i] = v));
}

function drawFit(img, x, y, w, h) {
  const ar = img.width / img.height;
  const br = w / h;

  let dw, dh, dx, dy;

  if (ar > br) {
    dw = w;
    dh = Math.round(w / ar);
    dx = x;
    dy = y + (h - dh) / 2;
  } else {
    dh = h;
    dw = Math.round(h * ar);
    dx = x + (w - dw) / 2;
    dy = y;
  }

  image(img, dx, dy, dw, dh);
}

function centerCropSquare(img) {
  const s = Math.min(img.width, img.height);
  const ox = Math.floor((img.width - s) / 2);
  const oy = Math.floor((img.height - s) / 2);
  return img.get(ox, oy, s, s);
}

function baseName(filename) {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

function stableSeedFromName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (31 * h + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function timestamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${y}${m}${da}_${hh}${mm}${ss}`;
}
