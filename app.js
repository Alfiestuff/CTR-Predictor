(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const dropzone = $('dropzone');
  const fileInput = $('file');
  const dzTitle = $('dz-title');
  const dzSub = $('dz-sub');
  const results = $('results');
  const preview = $('preview');
  const previewImg = $('preview-img');
  const overlay = $('overlay');
  const attention = $('attention');
  const feedStage = $('feed-stage');
  const titleInput = $('title-input');
  const historySection = $('history');
  const historyList = $('history-list');
  const campaign = $('campaign');
  const adForm = $('ad-form');

  const DZ_SUB_DEFAULT = dzSub.textContent;
  const AD_STORAGE_KEY = 'ctr-rater:ad-config';

  const state = { items: [], activeId: null, nextId: 1, currency: 'USD' };

  // ---------------------------------------------------------------------------
  // Helpers

  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const ramp = (x, a, b) => clamp01((x - a) / (b - a));

  // 0 at lo0, rising to 1 between lo1 and hi1, then falling to `floor` at hi0.
  function plateau(x, lo0, lo1, hi1, hi0, floor = 0) {
    if (x < lo1) return ramp(x, lo0, lo1);
    if (x <= hi1) return 1;
    return 1 - (1 - floor) * ramp(x, hi1, hi0);
  }

  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function aspectLabel(w, h) {
    const r = w / h;
    const known = [[16 / 9, '16:9'], [1, '1:1'], [4 / 3, '4:3'], [3 / 2, '3:2'], [21 / 9, '21:9'], [9 / 16, '9:16']];
    for (const [v, label] of known) if (Math.abs(r - v) / v < 0.02) return label;
    return `${r.toFixed(2)}:1`;
  }

  // ---------------------------------------------------------------------------
  // Pixel access

  function toCanvas(src, w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    return c;
  }

  // Halve repeatedly before the final resize so large downscales average
  // properly instead of aliasing.
  function resize(src, srcW, srcH, targetW) {
    if (targetW >= srcW) return toCanvas(src, srcW, srcH);
    let cur = src;
    let w = srcW;
    let h = srcH;
    while (w / 2 > targetW) {
      w = Math.round(w / 2);
      h = Math.max(1, Math.round(h / 2));
      cur = toCanvas(cur, w, h);
    }
    return toCanvas(cur, targetW, Math.max(1, Math.round(srcH * targetW / srcW)));
  }

  const pixels = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height);

  function grayscale({ data, width, height }) {
    const g = new Float32Array(width * height);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) {
      g[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    }
    return g;
  }

  function stdDev(arr) {
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < arr.length; i++) { sum += arr[i]; sq += arr[i] * arr[i]; }
    const mean = sum / arr.length;
    return Math.sqrt(Math.max(0, sq / arr.length - mean * mean));
  }

  // One pass over the interior pixels:
  //  - density: share of pixels on a strong edge (how busy the image is)
  //  - edgeSharpness: 90th percentile of |Laplacian| on edge pixels only, so
  //    flat cartoon-style areas don't count as "blurry"
  //  - edgeCount: how many edge pixels the sharpness figure is based on
  function edgeStats(g, w, h, threshold) {
    let edges = 0;
    let n = 0;
    const laps = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const tl = g[i - w - 1], t = g[i - w], tr = g[i - w + 1];
        const l = g[i - 1], c = g[i], r = g[i + 1];
        const bl = g[i + w - 1], b = g[i + w], br = g[i + w + 1];
        const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
        const gy = (bl + 2 * b + br) - (tl + 2 * t + tr);
        const mag2 = gx * gx + gy * gy;
        if (mag2 > threshold * threshold) edges++;
        if (mag2 > 80 * 80) laps.push(Math.abs(t + b + l + r - 4 * c));
        n++;
      }
    }
    laps.sort((a, b) => a - b);
    return {
      density: n ? edges / n : 0,
      edgeSharpness: laps.length ? laps[Math.floor(laps.length * 0.9)] : 0,
      edgeCount: laps.length,
    };
  }

  const srgbToLinear = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };

  function rgbToLab(r, g, b) {
    const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
    const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
    const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  // Colour-rarity saliency on a small grid: each cell scores the average Lab
  // distance to every other cell, so a small distinct subject stands out while
  // large common regions (sky, ground) score low. Returns a normalised map plus
  // how much of the saliency is concentrated in the top 15% of cells.
  function saliency({ data, width: w, height: h }) {
    const n = w * h;
    const lab = new Float32Array(n * 3);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const [L, A, B] = rgbToLab(data[p], data[p + 1], data[p + 2]);
      lab[i * 3] = L; lab[i * 3 + 1] = A; lab[i * 3 + 2] = B;
    }

    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const L = lab[i * 3], A = lab[i * 3 + 1], B = lab[i * 3 + 2];
      let s = 0;
      for (let j = 0; j < n; j++) {
        const dL = L - lab[j * 3], dA = A - lab[j * 3 + 1], dB = B - lab[j * 3 + 2];
        s += Math.sqrt(dL * dL + dA * dA + dB * dB);
      }
      raw[i] = s / n;
    }

    const map = new Float32Array(n);
    let max = 0, min = Infinity;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < h && xx >= 0 && xx < w) { s += raw[yy * w + xx]; c++; }
          }
        }
        const v = s / c;
        map[y * w + x] = v;
        if (v > max) max = v;
        if (v < min) min = v;
      }
    }

    // Measured above the least-salient cell, so a uniform background reads as zero.
    for (let i = 0; i < n; i++) map[i] -= min;
    const range = max - min;

    const sorted = Array.from(map).sort((a, b) => b - a);
    const k = Math.max(1, Math.round(n * 0.15));
    let top = 0, total = 0;
    for (let i = 0; i < n; i++) { total += sorted[i]; if (i < k) top += sorted[i]; }

    if (range > 0) for (let i = 0; i < n; i++) map[i] /= range;

    return {
      map, w, h,
      share: total > 0 ? top / total : 0.15,
      topMean: top / k,
    };
  }

  // ---------------------------------------------------------------------------
  // Analysis

  function analyze(img) {
    const W = img.naturalWidth;
    const H = img.naturalHeight;

    const base = resize(img, W, H, 512);
    const baseData = pixels(base);
    const { data } = baseData;
    const w = base.width, h = base.height, n = w * h;
    const gray = grayscale(baseData);

    let lumSum = 0, lumSq = 0, satSum = 0;
    let rgSum = 0, rgSq = 0, ybSum = 0, ybSq = 0;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const l = gray[i];
      lumSum += l; lumSq += l * l;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      satSum += mx === 0 ? 0 : (mx - mn) / mx;
      const rg = r - g, yb = 0.5 * (r + g) - b;
      rgSum += rg; rgSq += rg * rg; ybSum += yb; ybSq += yb * yb;
    }

    const lumMean = lumSum / n;
    const lumStd = Math.sqrt(Math.max(0, lumSq / n - lumMean * lumMean));
    const satMean = satSum / n;
    const rgM = rgSum / n, ybM = ybSum / n;
    const rgStd = Math.sqrt(Math.max(0, rgSq / n - rgM * rgM));
    const ybStd = Math.sqrt(Math.max(0, ybSq / n - ybM * ybM));
    // Hasler & Süsstrunk colourfulness metric.
    const colorfulness = Math.hypot(rgStd, ybStd) + 0.3 * Math.hypot(rgM, ybM);

    const { density, edgeSharpness, edgeCount } = edgeStats(gray, w, h, 100);

    // "Squint test": how much contrast survives at a tiny size.
    const tiny = resize(base, w, h, 48);
    const tinyData = pixels(tiny);
    const squint = stdDev(grayscale(tinyData));
    const sal = saliency(tinyData);

    const ratio = W / H;
    const isWide = Math.abs(ratio - 16 / 9) / (16 / 9) < 0.03;
    const isSquare = Math.abs(ratio - 1) < 0.03;

    const factors = [];
    const add = (f) => factors.push(f);

    {
      const s = plateau(lumMean, 35, 100, 175, 235);
      let detail = 'Well balanced', tip = null;
      if (lumMean < 70) detail = 'Too dark';
      else if (lumMean < 100) detail = 'A little dark';
      else if (lumMean > 205) detail = 'Very bright';
      else if (lumMean > 175) detail = 'A little bright';
      if (lumMean < 100) tip = 'Brighten the scene or add a rim light behind your subject. Dark thumbnails disappear against Roblox’s dark theme.';
      if (lumMean > 175) tip = 'Bring the highlights down a little. Washed-out images look flat next to other tiles.';
      add({ key: 'brightness', label: 'Brightness', weight: 10, score: s, detail, tip });
    }

    {
      const s = ramp(lumStd, 28, 68);
      const detail = lumStd < 38 ? 'Flat' : lumStd < 55 ? 'Moderate' : 'Strong';
      add({ key: 'contrast', label: 'Contrast', weight: 15, score: s, detail,
        tip: 'Separate the subject from the background more: darken or blur the background and light the subject.' });
    }

    {
      const s = plateau(satMean, 0.08, 0.35, 0.72, 0.98, 0.55);
      let detail = 'Vivid', tip = null;
      if (satMean < 0.2) detail = 'Muted';
      else if (satMean < 0.35) detail = 'Slightly muted';
      else if (satMean > 0.85) detail = 'Oversaturated';
      if (satMean < 0.35) tip = 'Push saturation up. The best-performing Roblox thumbnails tend to use bold, saturated colors.';
      if (satMean > 0.72) tip = 'Ease off saturation slightly. Extreme saturation can make the image look low quality.';
      add({ key: 'saturation', label: 'Saturation', weight: 8, score: s, detail, tip });
    }

    {
      const s = ramp(colorfulness, 18, 72);
      const detail = colorfulness < 33 ? 'Limited palette' : colorfulness < 55 ? 'Moderate variety' : 'Colorful';
      add({ key: 'color', label: 'Color variety', weight: 12, score: s, detail,
        tip: 'Add a contrasting accent color, such as orange against blue, so the eye has something to catch on.' });
    }

    {
      const s = 0.6 * ramp(sal.share, 0.2, 0.4) + 0.4 * ramp(sal.topMean, 15, 45);
      const detail = s < 0.4 ? 'No clear subject' : s < 0.7 ? 'Somewhat focused' : 'Clear focal point';
      add({ key: 'focus', label: 'Focal point', weight: 18, score: s, detail,
        tip: 'Give the thumbnail one clear subject, like a character, item or face, and make it large. Turn on the attention map to see where the eye goes.' });
    }

    {
      const s = ramp(squint, 18, 55);
      const detail = s < 0.45 ? 'Muddy when small' : s < 0.75 ? 'Readable when small' : 'Reads well when small';
      add({ key: 'small', label: 'Small-size clarity', weight: 14, score: s, detail,
        tip: 'Most players see your thumbnail at phone size. Use bigger shapes and fewer fine details, and check the mobile preview.' });
    }

    {
      // Too few edges to judge (e.g. a near-blank image): stay neutral.
      const s = edgeCount < 200 ? 0.5 : ramp(edgeSharpness, 12, 50);
      const detail = s < 0.4 ? 'Soft' : s < 0.75 ? 'Fairly sharp' : 'Sharp';
      add({ key: 'sharpness', label: 'Sharpness', weight: 8, score: s, detail,
        tip: 'Render at a higher resolution or reduce blur and depth of field on the subject. Soft thumbnails look low effort.' });
    }

    {
      const s = plateau(density, 0.015, 0.05, 0.17, 0.38, 0.2);
      let detail = 'Clean', tip = null;
      if (density < 0.03) { detail = 'Very plain'; tip = 'The image is very plain. Add a background scene or props that hint at the gameplay.'; }
      else if (density > 0.24) { detail = 'Busy'; tip = 'The image is busy. Remove background clutter and small UI or text so the subject stands out.'; }
      else if (density > 0.17) { detail = 'Slightly busy'; tip = 'Simplify the background a little so the subject stands out.'; }
      add({ key: 'clutter', label: 'Clutter', weight: 7, score: s, detail, tip });
    }

    {
      const res = W >= 1920 && H >= 1080 ? 1 : W >= 1280 ? 0.85 : W >= 768 ? 0.65 : 0.3;
      const asp = isWide ? 1 : isSquare ? 0.5 : 0.4;
      let tip = null;
      if (isSquare) tip = 'This looks like a square icon. Experience thumbnails are shown at 16:9, so export at 1920 × 1080.';
      else if (!isWide) tip = 'Thumbnails are shown at 16:9 and other ratios get cropped. Export at 1920 × 1080.';
      else if (res < 1) tip = 'Export at 1920 × 1080 so the thumbnail stays crisp on large screens.';
      add({ key: 'format', label: 'Size & format', weight: 8, score: 0.5 * res + 0.5 * asp,
        detail: `${W} × ${H}, ${aspectLabel(W, H)}`, tip });
    }

    const totalWeight = factors.reduce((a, f) => a + f.weight, 0);
    const score = 100 * factors.reduce((a, f) => a + f.weight * f.score, 0) / totalWeight;

    const ctr = 0.8 + 11 * (score / 100) ** 1.8;

    const tips = factors
      .filter((f) => f.tip && f.score < 0.7)
      .sort((a, b) => b.weight * (1 - b.score) - a.weight * (1 - a.score))
      .slice(0, 4);

    return { score, ctr, low: ctr * 0.78, high: ctr * 1.25, factors, tips, sal };
  }

  // ---------------------------------------------------------------------------
  // Rendering

  const BANDS = [
    { max: 3, label: 'Below average', verdict: 'This is likely to be scrolled past. Start with the top suggestions below.' },
    { max: 6, label: 'Average', verdict: 'About what a typical thumbnail gets. The suggestions below show where you can gain the most.' },
    { max: 9, label: 'Good', verdict: 'A solid thumbnail. A couple of small changes could push it further.' },
    { max: Infinity, label: 'Strong', verdict: 'This should stand out in the feed. Try it against an alternative to see which one players prefer.' },
  ];

  const bandIndex = (ctr) => BANDS.findIndex((b) => ctr < b.max);

  function drawOverlay(sal) {
    overlay.width = sal.w;
    overlay.height = sal.h;
    const ctx = overlay.getContext('2d');
    const out = ctx.createImageData(sal.w, sal.h);
    for (let i = 0; i < sal.map.length; i++) {
      out.data[i * 4 + 3] = Math.round(255 * 0.8 * (1 - sal.map[i] ** 0.7));
    }
    ctx.putImageData(out, 0, 0);
  }

  function renderResult(item) {
    const r = item.result;

    previewImg.src = item.url;
    drawOverlay(r.sal);

    $('meta').innerHTML = [
      ['Dimensions', `${item.width} × ${item.height}`],
      ['Aspect', aspectLabel(item.width, item.height)],
      ['File size', formatBytes(item.size)],
      ['Format', (item.type.split('/')[1] || 'image').toUpperCase()],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join('');

    feedStage.querySelectorAll('.tile-img img').forEach((el) => { el.src = item.url; });

    const bi = bandIndex(r.ctr);
    $('ctr-value').textContent = r.ctr.toFixed(1);
    $('ctr-range').textContent = `Likely between ${r.low.toFixed(1)}% and ${r.high.toFixed(1)}%`;
    $('scale-marker').style.left = `${(Math.min(r.ctr, 12) / 12) * 100}%`;
    [...$('scale-track').children].forEach((el, i) => el.classList.toggle('on', i === bi));
    [...$('scale-labels').children].forEach((el, i) => el.classList.toggle('on', i === bi));
    $('verdict').textContent = BANDS[bi].verdict;

    $('overall').textContent = `Overall ${Math.round(r.score)} / 100`;
    $('factors').innerHTML = r.factors.map((f) => `
      <li class="factor">
        <div class="factor-row">
          <span class="factor-name">${f.label}</span>
          <span class="factor-detail">${escapeHtml(f.detail)}</span>
          <span class="factor-score">${(f.score * 10).toFixed(1)}</span>
        </div>
        <div class="bar"><i style="width:${(f.score * 100).toFixed(1)}%"></i></div>
      </li>`).join('');

    $('tips').innerHTML = r.tips.length
      ? r.tips.map((f) => `<li><div><strong>${f.label}</strong><p>${escapeHtml(f.tip)}</p></div></li>`).join('')
      : '<li><div><strong>Nothing major to fix</strong><p>The image covers the basics well. The best next step is testing it against an alternative.</p></div></li>';
  }

  function renderHistory() {
    if (state.items.length < 2) {
      historySection.hidden = true;
      return;
    }
    historySection.hidden = false;
    const best = state.items.reduce((a, b) => (b.result.ctr > a.result.ctr ? b : a));
    historyList.innerHTML = state.items.map((item) => `
      <li class="history-item">
        <button type="button" data-id="${item.id}" aria-current="${item.id === state.activeId}">
          <img src="${item.url}" alt="">
          <div>
            <div class="history-name">${escapeHtml(item.name)}</div>
            <div class="history-sub">${BANDS[bandIndex(item.result.ctr)].label} · ${Math.round(item.result.score)} / 100</div>
          </div>
          <span class="history-ctr">${item.result.ctr.toFixed(1)}%${item === best ? '<span class="pill">Best</span>' : ''}</span>
        </button>
      </li>`).join('');
  }

  // ---------------------------------------------------------------------------
  // Ad campaign projection

  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

  function formatCount(n) {
    if (!Number.isFinite(n)) return '–';
    if (n < 10) return n.toFixed(1).replace(/\.0$/, '');
    return compact.format(Math.round(n));
  }

  function formatMoney(n) {
    if (!Number.isFinite(n)) return '–';
    const digits = n < 1 ? 3 : 2;
    return state.currency === 'USD'
      ? `$${n.toLocaleString('en', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
      : `${n.toLocaleString('en', { maximumFractionDigits: digits })} Robux`;
  }

  function readAdConfig() {
    const num = (name) => {
      const v = parseFloat(adForm.elements[name].value);
      return Number.isFinite(v) && v >= 0 ? v : 0;
    };
    return {
      budget: num('budget'),
      cpm: num('cpm'),
      days: Math.max(1, Math.round(num('days'))),
      playRate: Math.min(100, num('playRate')) / 100,
      session: num('session'),
      retention: Math.min(100, num('retention')) / 100,
    };
  }

  function project(cfg, ctrPct) {
    const impressions = cfg.cpm > 0 ? (cfg.budget / cfg.cpm) * 1000 : 0;
    const clicks = impressions * (ctrPct / 100);
    const adVisits = clicks * cfg.playRate;
    const returning = adVisits * cfg.retention;
    // Once the campaign is running, each day also brings back some of
    // yesterday's ad players.
    const dailyVisits = adVisits + returning;
    const avgCcu = (dailyVisits * cfg.session) / 1440;
    return {
      impressions,
      clicks,
      adVisits,
      returning,
      dailyVisits,
      avgCcu,
      peakCcu: avgCcu * 2,
      totalVisits: adVisits * cfg.days + returning * (cfg.days - 1),
      costPerVisit: adVisits > 0 ? cfg.budget / adVisits : NaN,
      totalSpend: cfg.budget * cfg.days,
    };
  }

  function renderCampaign(item) {
    const cfg = readAdConfig();
    const r = item.result;
    const mid = project(cfg, r.ctr);
    const lo = project(cfg, r.low);
    const hi = project(cfg, r.high);

    const range = (key, fmt = formatCount) => `${fmt(lo[key])} – ${fmt(hi[key])}`;
    // Cost per visit falls as CTR rises, so its range runs the other way.
    const stats = [
      ['Impressions per day', formatCount(mid.impressions), `at ${formatMoney(cfg.cpm)} CPM`],
      ['Clicks per day', formatCount(mid.clicks), range('clicks')],
      ['Visits per day', formatCount(mid.dailyVisits), `incl. ${formatCount(mid.returning)} returning`],
      ['Average CCU', formatCount(mid.avgCcu), range('avgCcu')],
      ['Peak CCU', formatCount(mid.peakCcu), range('peakCcu')],
      [`Visits over ${cfg.days} day${cfg.days === 1 ? '' : 's'}`, formatCount(mid.totalVisits), range('totalVisits')],
      ['Cost per visit', formatMoney(mid.costPerVisit), `${formatMoney(hi.costPerVisit)} – ${formatMoney(lo.costPerVisit)}`],
      ['Total spend', formatMoney(mid.totalSpend), `${formatMoney(cfg.budget)} per day`],
    ];

    $('stats').innerHTML = stats
      .map(([k, v, sub]) => `<div><dt>${k}</dt><dd>${v}<small>${sub}</small></dd></div>`)
      .join('');
  }

  function saveAdConfig() {
    try {
      const values = Object.fromEntries(new FormData(adForm));
      localStorage.setItem(AD_STORAGE_KEY, JSON.stringify({ ...values, currency: state.currency }));
    } catch { /* storage unavailable */ }
  }

  function loadAdConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(AD_STORAGE_KEY) || 'null');
      if (!saved) return;
      for (const [k, v] of Object.entries(saved)) {
        if (adForm.elements[k]) adForm.elements[k].value = v;
      }
      if (saved.currency === 'USD' || saved.currency === 'Robux') setCurrency(saved.currency);
    } catch { /* storage unavailable or corrupt */ }
  }

  function setCurrency(currency) {
    state.currency = currency;
    campaign.querySelectorAll('[data-currency]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.currency === currency));
    });
    campaign.querySelectorAll('[data-unit="currency"]').forEach((el) => { el.textContent = currency; });
  }

  function render() {
    const active = state.items.find((i) => i.id === state.activeId);
    const hasItems = state.items.length > 0;

    dropzone.classList.toggle('compact', hasItems);
    dzTitle.innerHTML = hasItems
      ? 'Drop another thumbnail to compare, or <span class="link">browse</span>'
      : 'Drop an image here, or <span class="link">browse</span>';

    results.hidden = !active;
    campaign.hidden = !active;
    if (active) {
      renderResult(active);
      renderCampaign(active);
    }
    renderHistory();
  }

  const activeItem = () => state.items.find((i) => i.id === state.activeId);

  function renderTitle() {
    const title = titleInput.value.trim() || 'My Experience';
    feedStage.querySelectorAll('.tile-title').forEach((el) => { el.textContent = title; });
  }

  // ---------------------------------------------------------------------------
  // Input

  function showError(msg) {
    dzSub.textContent = msg;
    dzSub.classList.add('error');
  }

  function clearError() {
    dzSub.textContent = DZ_SUB_DEFAULT;
    dzSub.classList.remove('error');
  }

  async function addFile(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
      if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty image');
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
    const item = {
      id: state.nextId++,
      name: file.name || 'Pasted image',
      size: file.size,
      type: file.type,
      width: img.naturalWidth,
      height: img.naturalHeight,
      url,
      result: analyze(img),
    };
    state.items.push(item);
    return item;
  }

  async function handleFiles(list) {
    const files = [...list].filter((f) => f.type.startsWith('image/'));
    if (!files.length) {
      showError('That file isn’t an image. Try a PNG, JPG or WebP.');
      return;
    }
    clearError();
    let last = null;
    for (const f of files) {
      try {
        last = await addFile(f);
      } catch {
        showError(`Couldn’t read ${f.name || 'that image'}. Try exporting it as PNG or JPG.`);
      }
    }
    if (last) {
      state.activeId = last.id;
      render();
      if (state.items.length === 1) results.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFiles(fileInput.files);
    fileInput.value = '';
  });

  // Accept drops anywhere on the page.
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    dropzone.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropzone.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('dragging');
    handleFiles(e.dataTransfer.files);
  });

  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) handleFiles(files);
  });

  attention.addEventListener('change', () => {
    preview.classList.toggle('show-attention', attention.checked);
  });

  adForm.addEventListener('input', () => {
    const item = activeItem();
    if (item) renderCampaign(item);
    saveAdConfig();
  });
  adForm.addEventListener('submit', (e) => e.preventDefault());

  campaign.querySelectorAll('[data-currency]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setCurrency(btn.dataset.currency);
      const item = activeItem();
      if (item) renderCampaign(item);
      saveAdConfig();
    });
  });

  const themeButtons = document.querySelectorAll('[data-theme]');
  themeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      themeButtons.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      feedStage.classList.toggle('dark', btn.dataset.theme === 'dark');
      feedStage.classList.toggle('light', btn.dataset.theme === 'light');
    });
  });

  titleInput.addEventListener('input', renderTitle);

  historyList.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-id]');
    if (!btn) return;
    state.activeId = Number(btn.dataset.id);
    render();
  });

  $('clear').addEventListener('click', () => {
    state.items.forEach((i) => URL.revokeObjectURL(i.url));
    state.items = [];
    state.activeId = null;
    attention.checked = false;
    preview.classList.remove('show-attention');
    clearError();
    render();
  });

  loadAdConfig();
  renderTitle();
})();
