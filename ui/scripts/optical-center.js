/**
 * optical-center.js — in-page optical center-of-mass (COM) measurement + alignment.
 *
 * Zero-dependency, browser-agnostic. Runs wherever you have an evaluate
 * primitive: chrome-devtools MCP `evaluate_script`, Playwright/Puppeteer
 * `page.evaluate`, Selenium/WebDriver `execute_script`, a DevTools
 * console/snippet, Agent Browser, or a bookmarklet.
 *
 * PORTABILITY CONTRACT (what makes it work with any tool): this file is a
 * single bare function DECLARATION with no imports/exports and no closure over
 * outer scope; args are plain JSON (selector strings + an options object) and
 * the return is JSON-serializable (no DOM nodes, no functions). So the ONE
 * pattern that works everywhere is: inject this source once (it defines
 * `window.opticalCenter`), then call `window.opticalCenter(...)`. Per-tool
 * one-liners are in SKILL.md → "Works with any browser-automation tool".
 *
 * WHY THIS EXISTS
 *   getBoundingClientRect() centers the LINE BOX, not the visible ink. Two
 *   labels at different font-sizes (e.g. an 18px wordmark next to 14px nav
 *   links) share a line-box center yet their glyph MASS sits at different
 *   heights — so "mathematically centered" reads as misaligned. This measures
 *   the alpha-weighted centroid of the actual rendered glyph ink.
 *
 * NO SCREENSHOT IS INVOLVED. Measurement happens in CSS pixels, in the same
 * coordinate space your CSS nudge lives in, so the output is a directly
 * usable nudge — no bbox handoff, no image processing, no reconciling a JSON
 * number against a flat PNG.
 *
 * USAGE (inline the whole function, then call it):
 *   opticalCenter(['.wordmark', 'a[href="/docs"]', 'a[href="/blog"]'])
 *     → { results:[{selector, comY, deltaFromAnchor}], cssHint:[{selector, nudge}] }
 *
 *   // measure + APPLY + re-verify in one shot (converges even when the nudge
 *   // itself perturbs layout — it re-measures the real post-nudge DOM):
 *   opticalCenter([...selectors], { apply: true })
 *     → { before, after, appliedTranslateY }
 *
 * OPTIONS
 *   anchorIndex  which target everything else aligns TO (default 0)
 *   apply        apply a translate nudge to each non-anchor + re-verify (default false)
 *   tolerance    px within which COMs are "aligned" (default 0.15)
 *   maxIters     apply-loop cap (default 5)
 *   supersample  canvas oversampling for centroid precision (default 8)
 *
 * SCOPE: exact for a single line of text (any font/size/weight/style). For
 * arbitrary raster content (icons, images) use the screenshot-centroid fallback
 * documented in SKILL.md instead.
 */
function opticalCenter(targets, opts = {}) {
  const {
    supersample = 8,
    anchorIndex = 0,
    apply = false,
    tolerance = 0.15,
    maxIters = 5,
  } = opts;

  const resolve = (t) =>
    typeof t === 'string'
      ? { el: document.querySelector(t), sel: t }
      : { el: t.el || document.querySelector(t.selector), sel: t.selector || '(node)' };

  // Descend to the element that DIRECTLY hosts the visible text. Critical: the
  // baseline strut below relies on `vertical-align:baseline`, which is IGNORED
  // inside a flex/grid container — so probing a flex <a> mis-reads the baseline
  // by several px. Walk down through flex/grid and single-child wrappers to the
  // inline element that actually contains the text node, and probe THERE.
  function textHost(el) {
    let cur = el;
    for (let guard = 0; guard < 12; guard++) {
      const kids = [...cur.children];
      const holder = kids.find((k) => k.textContent.trim() === cur.textContent.trim());
      const isContainer = /flex|grid/.test(getComputedStyle(cur).display);
      if (holder && (isContainer || kids.length === 1)) { cur = holder; continue; }
      break;
    }
    return cur;
  }

  // Exact first-line baseline via a zero-size, baseline-aligned strut: an empty
  // inline-block's baseline is its bottom edge, and with height:0 that edge ==
  // its top == the line's baseline. Append, read, remove — no lasting mutation.
  function baselineY(el) {
    const host = textHost(el);
    const s = document.createElement('span');
    s.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    host.appendChild(s);
    const y = s.getBoundingClientRect().top;
    s.remove();
    return y;
  }

  // Alpha-weighted centroid Y of the glyph ink, as an offset from the alphabetic
  // baseline (negative = above baseline). Pure font rendering — this part is exact.
  function centroidFromBaseline(el, text) {
    const cs = getComputedStyle(el);
    const S = supersample;
    const fs = parseFloat(cs.fontSize) * S;
    const c = document.createElement('canvas');
    const pad = fs * 1.5;
    c.width = Math.ceil(fs * Math.max(text.length, 1) * 1.4 + 2 * pad);
    c.height = Math.ceil(fs * 3);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const bY = Math.round(c.height * 0.6);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${fs}px ${cs.fontFamily}`;
    ctx.fillStyle = '#000';
    ctx.fillText(text, pad, bY);
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
    let sumY = 0, sum = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const a = data[(y * width + x) * 4 + 3];
        if (a) { sumY += y * a; sum += a; }
      }
    }
    if (!sum) return 0;
    return (sumY / sum - bY) / S;
  }

  const comY = (el) => {
    const host = textHost(el);
    return baselineY(host) + centroidFromBaseline(host, host.textContent.trim());
  };

  const items = targets.map(resolve);
  const missing = items.filter((i) => !i.el);
  if (missing.length) return { error: 'target(s) not found', missing: missing.map((i) => i.sel) };

  const anchorEl = items[anchorIndex].el;
  const snapshot = () => {
    const a = comY(anchorEl);
    return items.map((i, k) => ({
      selector: i.sel,
      comY: +comY(i.el).toFixed(2),
      deltaFromAnchor: +(comY(i.el) - a).toFixed(2),
      isAnchor: k === anchorIndex,
    }));
  };

  // Paint the analysis ONTO the page so the next screenshot self-documents:
  // a horizontal guide at each target's COM (anchor = solid, others = dashed) with
  // a px-delta label. This collapses "reconcile a JSON number against a flat PNG"
  // into "look — the crosshair sits on the ink." Cleared on the next call/reload.
  function drawOverlay(rows) {
    document.querySelectorAll('[data-optical-overlay]').forEach((n) => n.remove());
    for (const [k, r] of rows.entries()) {
      const el = items[k].el;
      const box = el.getBoundingClientRect();
      const line = document.createElement('div');
      const isA = r.isAnchor;
      line.setAttribute('data-optical-overlay', '');
      line.style.cssText = `position:fixed;left:${box.left - 6}px;top:${r.comY}px;width:${box.width + 12}px;height:0;z-index:2147483647;pointer-events:none;border-top:1px ${isA ? 'solid' : 'dashed'} ${isA ? '#00c853' : '#ff1744'}`;
      const tag = document.createElement('div');
      tag.setAttribute('data-optical-overlay', '');
      tag.style.cssText = `position:fixed;left:${box.right + 4}px;top:${r.comY - 7}px;z-index:2147483647;pointer-events:none;font:11px/1 monospace;color:${isA ? '#00c853' : '#ff1744'};background:#000a;padding:1px 3px;border-radius:2px`;
      tag.textContent = isA ? 'anchor' : `${r.deltaFromAnchor > 0 ? '+' : ''}${r.deltaFromAnchor}px`;
      document.body.append(line, tag);
    }
  }

  const before = snapshot();
  if (!apply) {
    if (opts.overlay) drawOverlay(before);
    return {
      anchorIndex,
      results: before,
      // ready-to-paste correction for each misaligned target
      cssHint: before
        .filter((r) => !r.isAnchor && Math.abs(r.deltaFromAnchor) >= tolerance)
        .map((r) => ({ selector: r.selector, nudge: `translate: 0 ${(-r.deltaFromAnchor).toFixed(2)}px` })),
    };
  }

  // Apply-and-reverify: nudge each non-anchor toward the anchor, RE-MEASURE the
  // real post-nudge DOM, iterate. A nudge (or a wrapping element) can shift the
  // baseline, so the loop converges on the true residual instead of trusting the
  // first delta. This is what turned a naive "-2.3px" into the correct "-0.8px"
  // once the correction was expressed as a wrapping span.
  const applied = {};
  for (let iter = 0; iter < maxIters; iter++) {
    let worst = 0;
    const a = comY(anchorEl);
    for (const i of items) {
      if (i.el === anchorEl) continue;
      const d = comY(i.el) - a;
      worst = Math.max(worst, Math.abs(d));
      if (Math.abs(d) < tolerance) continue;
      const next = (applied[i.sel] || 0) - d;
      i.el.style.translate = `0 ${next}px`;
      applied[i.sel] = +next.toFixed(3);
    }
    if (worst < tolerance) break;
  }
  const after = snapshot();
  if (opts.overlay) drawOverlay(after);
  return { anchorIndex, before, after, appliedTranslateY: applied };
}
