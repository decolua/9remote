// 9remote in-page runner (AutoAgent pattern): a STATIC content script — no
// eval anywhere (MV3 extension CSP blocks it) — exposing the engine's page
// primitives as named ops. Bodies mirror host/features/browserUse/snapshot.js
// and the in-page expressions of engine.js: change either side, change both.
// The ISOLATED world keeps window.__9rFast caching coherent across calls.
if (!window.__9rRunner) {
  window.__9rRunner = true;

  // ---- constants mirrored from host/features/browserUse/constants.js ----
  const MAX_ELEMENTS = 248;
  const PAGE_TEXT_CAP = 12000;
  const READ_TOTAL_CAP = 200000;

  const boot = () => {
    if (!window.__9rFast) window.__9rFast = { ids: new WeakMap(), nodes: new Map(), next: 1 };
    return window.__9rFast;
  };

  // ---- snapshotBody (mirrors snapshot.js snapshotBody) ----
  const numWin = (v, dflt) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  function snapshotBody(win = {}) {
    const cache = boot();
    const WIN_FROM = numWin(win.from, 0), WIN_LEN = Math.max(1, numWin(win.len, MAX_ELEMENTS)), WIN_CAP = Math.max(1, numWin(win.cap, MAX_ELEMENTS));
    const identity = e => {
      if (!cache.ids.has(e)) cache.ids.set(e, cache.next++);
      const id = cache.ids.get(e); cache.nodes.set(id, e); return id;
    };
    for (const [id, e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
    const safe = e => !['hidden'].includes(e.type);
    const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
      e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const name = (e, seen = new Set()) => {
      if (!e || seen.has(e)) return '';
      seen.add(e);
      const referenced = (e.getAttribute('aria-labelledby') || '').split(/\s+/)
        .map(id => name(document.getElementById(id), seen)).filter(Boolean).join(' ');
      const slotText = e => [...e.querySelectorAll('slot')]
        .map(s => [...s.assignedNodes()].map(n => n.textContent || '').join('')).join(' ').trim();
      return referenced || e.getAttribute('aria-label') ||
        [...(e.labels || [])].map(l => name(l, seen)).filter(Boolean).join(' ') ||
        (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
        (e.tagName === 'INPUT' ? '' : [...e.childNodes].map(n => n.nodeType === 3 ? n.textContent :
          n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' ? name(n, seen) : '').join(' ').trim() || slotText(e)) ||
        e.getAttribute('title') || e.getAttribute('placeholder') || (e.tagName === 'IFRAME' ? ((() => { try { return (e.src ? 'iframe: ' + (new URL(e.src).hostname || e.src) : 'iframe'); } catch { return 'iframe'; } })()) : '');
    };
    const roles = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio',
      'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton'];
    const selector = 'a[href],button,input,textarea,select,summary,iframe,[contenteditable="true"],[onclick],' +
      roles.map(role => '[role="' + role + '"]').join(',');
    const role = e => {
      if (e.tagName === 'IFRAME') return 'iframe';
      const explicit = e.getAttribute('role');
      if (roles.includes(explicit)) return explicit;
      if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
      if (e.tagName === 'A') return 'link';
      if (e.tagName === 'SELECT') return 'combobox';
      if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
      if (e.tagName === 'INPUT') {
        if (['checkbox', 'radio'].includes(e.type)) return e.type;
        if (['button', 'submit', 'reset', 'image'].includes(e.type)) return 'button';
        if (e.type === 'search') return 'searchbox';
        if (e.type === 'number') return 'spinbutton';
        if (['text', 'email', 'url', 'tel', 'password'].includes(e.type)) return 'textbox';
      }
      return null;
    };
    cache.pageKey = () => [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
      [...document.querySelectorAll('input,textarea,select')].filter(e => safe(e) && e.type !== 'password')
        .map(e => [identity(e), e.value, e.checked, e.selectedIndex, e.disabled, e.readOnly])];
    const secCache = new WeakMap();
    const ctxOf = e => {
      const sec = e.closest('dialog,[role="dialog"],section,fieldset,form,nav,aside');
      if (!sec) return null;
      if (!secCache.has(sec)) {
        const t = (sec.getAttribute('aria-label') || sec.querySelector('h1,h2,h3,h4,legend')?.textContent || '').trim();
        secCache.set(sec, t.slice(0, 40));
      }
      const v = secCache.get(sec);
      return v || null;
    };
    const SEG_SEL = 'section,nav,aside,main,article,dialog,form,fieldset,[role="dialog"],' +
      '[role="region"],[role="group"],[role="tablist"],[role="tabpanel"],' +
      '[role="navigation"],[role="complementary"],[role="banner"],' +
      '[role="contentinfo"],[role="form"],[role="search"]';
    const segName = s => {
      const a = s.getAttribute('aria-label');
      if (a) return a.slice(0, 40);
      const h = s.querySelector('h1,h2,h3,h4,legend');
      return h ? (h.textContent || '').trim().slice(0, 40) : null;
    };
    const pathCache = new WeakMap();
    const pathOf = e => {
      if (pathCache.has(e)) return pathCache.get(e);
      const segs = []; let n = e.parentElement;
      const doc = e.ownerDocument || document;
      while (n && n !== doc.body && n !== doc.documentElement && segs.length < 4) {
        if (n.matches(SEG_SEL)) { const s = segName(n); if (s) segs.unshift(s); }
        n = n.parentElement;
      }
      if (doc !== document) segs.unshift('iframe');
      const p = segs.length ? segs : null;
      pathCache.set(e, p); return p;
    };
    const getRect = e => {
      const r = e.getBoundingClientRect();
      if (e.ownerDocument && e.ownerDocument !== document) {
        try {
          const fr = e.ownerDocument.defaultView?.frameElement?.getBoundingClientRect();
          if (fr) return { x: fr.x + r.x, y: fr.y + r.y, width: r.width, height: r.height };
        } catch { }
      }
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const actions = [];
    const deepQuery = (root, sel) => {
      const found = [...root.querySelectorAll(sel)];
      for (const e of root.querySelectorAll('*')) {
        if (e.shadowRoot) found.push(...deepQuery(e.shadowRoot, sel));
        if (e.tagName === 'IFRAME') {
          try { if (e.contentDocument) found.push(...deepQuery(e.contentDocument, sel)); } catch { }
        }
      }
      return found;
    };
    const pfxOf = e => {
      const t = e.tagName ? e.tagName.toLowerCase() : '';
      if (t === 'button' || t === 'summary') return 'btn';
      if (t === 'a') return 'a';
      if (t === 'input' || t === 'textarea') return 'inp';
      if (t === 'select') return 'sel';
      if (t === 'iframe') return 'ifr';
      if (t === 'div') return 'div';
      if (t === 'span') return 'span';
      return t ? t.slice(0, 4) : 'e';
    };
    for (const e of deepQuery(document, selector)) {
      if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
      const r = getRect(e), x = r.x + r.width / 2, y = r.y + r.height / 2,
        rname = role(e) || (e.hasAttribute('onclick') ? 'button' : null);
      if (r.width <= 0 || r.height <= 0) continue;
      if (e.type === 'file') {
        actions.push({ node: identity(e), tag: 'input', pfx: 'inp', role: 'button', label: (name(e) || 'Choose file').replace(/\s+/g, ' ').trim(),
          ctx: ctxOf(e), path: pathOf(e), rect: { x: r.x, y: r.y, w: r.width, h: r.height }, kind: 'upload', value: '' });
        continue;
      }
      if (!rname) continue;
      if (rname === 'gridcell' && e.querySelector('button,[role="button"]')) continue;
      const base = { node: identity(e), tag: e.tagName.toLowerCase(), pfx: pfxOf(e), role: rname, label: (name(e) || rname).replace(/\s+/g, ' ').trim(),
        ctx: ctxOf(e), path: pathOf(e), rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        href: (e.tagName === 'A' && e.href && !e.href.startsWith('javascript:')) ? e.href : undefined };
      for (const key of ['checked', 'selected', 'expanded']) {
        const value = e.getAttribute('aria-' + key);
        if (value !== null) base[key] = value;
      }
      if (['checkbox', 'radio'].includes(e.type)) base.checked = String(e.checked);
      if (e.tagName === 'SELECT') {
        const selLabel = e.selectedOptions[0]?.label || 'Current';
        for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
          actions.push({ ...base, kind: 'select', value: o.value,
            current_value: [...e.selectedOptions].map(o => o.label).join(', '), label: selLabel + ' → ' + o.label });
      } else {
        const editable = !e.readOnly && e.getAttribute('aria-readonly') !== 'true' &&
          (['textbox', 'searchbox', 'spinbutton'].includes(rname) ||
            (rname === 'combobox' && ['INPUT', 'TEXTAREA'].includes(e.tagName)));
        const value = e.type === 'password' ? (e.value ? '••••' : '') :
          'value' in e ? String(e.value) :
            e.isContentEditable || rname === 'combobox' ? e.innerText.trim() : '';
        actions.push({ ...base, kind: editable ? 'fill' : 'click', value });
        if (editable) actions.push({ ...base, kind: 'click', value, label: 'Open ' + base.label });
      }
    }
    const picked = new Set(actions.map(a => cache.nodes.get(a.node)));
    const isMarked = e => e.hasAttribute('data-testid') || e.hasAttribute('data-test') ||
      e.hasAttribute('data-ui-name') || e.hasAttribute('data-automation-id') || e.hasAttribute('data-filters-item');
    const pointerCandidates = [];
    for (const e of deepQuery(document, 'div,span,li,label')) {
      if (pointerCandidates.length >= WIN_CAP) break;
      if (e.matches(selector)) continue;
      if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
      const inner = e.querySelector('button,a,input,select,textarea,summary,[contenteditable="true"],[onclick],[role="button"],[role="checkbox"],[role="switch"]');
      if (inner) {
        const ghost = inner.matches('input[type="checkbox"],input[type="radio"]') &&
          !inner.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        if (!ghost) continue;
      }
      const st = getComputedStyle(e);
      if (st.pointerEvents === 'none' || (st.cursor !== 'pointer' && !isMarked(e))) continue;
      const label = name(e);
      if (!label) continue;
      const r = getRect(e);
      if (r.width <= 0 || r.height <= 0) continue;
      if ([...picked].some(p => p.contains(e))) continue;
      pointerCandidates.push({ el: e, base: { node: identity(e), tag: e.tagName.toLowerCase(), pfx: pfxOf(e), role: 'button', label: label.slice(0, 80).replace(/\s+/g, ' ').trim(),
        ctx: ctxOf(e), path: pathOf(e), rect: { x: r.x, y: r.y, w: r.width, h: r.height } } });
      picked.add(e);
    }
    for (const c of pointerCandidates) actions.push({ ...c.base, kind: 'click', value: '' });
    const height = document.documentElement.scrollHeight;
    const words = []; let length = 0;
    const NOISE = 'nav,header,aside,form,button,select,option,label,dialog,' +
      '[role="banner"],[role="navigation"],[role="complementary"],' +
      '.ad,.ads,.advert,.cookie,.cookies,[class*="cookie-"],[id*="cookie"],.popup,.modal,.sidebar,.breadcrumb';
    const collectText = (doc) => {
      if (!doc?.body) return;
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      const range = doc.createRange(); let node;
      while ((node = walker.nextNode()) && length < PAGE_TEXT_CAP) {
        const value = node.textContent.trim(), parent = node.parentElement;
        if (!value || !parent || parent.closest('script,style,noscript,template') ||
          parent.closest(NOISE) || !visible(parent)) continue;
        range.selectNodeContents(node); const r = range.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          if (height <= innerHeight * 1.5 || (r.bottom >= -100 && r.top <= innerHeight + 400)) {
            words.push(value); length += value.length;
          }
        }
      }
    };
    collectText(document);
    for (const f of document.querySelectorAll('iframe')) {
      try { if (f.contentDocument) collectText(f.contentDocument); } catch { }
    }
    const text = words.join('\n').slice(0, PAGE_TEXT_CAP);
    const headings = [];
    for (const h of document.querySelectorAll('h1,h2,h3,h4')) {
      if (headings.length >= 12) break;
      const t = h.textContent.trim().slice(0, 60);
      if (t) headings.push(t);
    }
    const page_key = cache.pageKey();
    const total = actions.length;
    const shown = actions.slice(WIN_FROM, WIN_FROM + WIN_LEN);
    const omitted_actions = Math.max(0, total - (WIN_FROM + shown.length));
    const semantics = shown.map(({ rect, ctx, path, ...action }) => action);
    const frameCount = document.querySelectorAll('iframe').length;
    const marker = [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
      document.title, text, semantics, page_key[6], frameCount];
    const contentMarker = [performance.timeOrigin, location.href, innerWidth, innerHeight,
      document.title, text, semantics, frameCount];
    const actions2 = shown;
    { const seq = new Map(); actions2.forEach(a => { const n = seq.get(a.node) || 0; seq.set(a.node, n + 1);
      const p = a.pfx || 'e';
      a.id = p + a.node + (n ? '-' + n : ''); }); }
    const scrollStep = Math.max(400, Math.round(innerHeight * 0.85));
    if (scrollY + innerHeight < height - 2) actions2.push({ id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: scrollStep });
    if (scrollY > 0) actions2.push({ id: 'scroll_up', kind: 'scroll', label: 'Scroll up', delta: -scrollStep });
    actions2.push({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' });
    return { url: location.href, title: document.title, w: innerWidth, h: innerHeight, text, headings,
      scroll: { y: scrollY, height }, actions: actions2, marker, contentMarker, page_key, omitted_actions,
      total_elements: total, element_from: WIN_FROM };
  }

  // ---- ops ----
  const OPS = {
    snapshot: (win) => snapshotBody(win || {}),
    marker: () => snapshotBody().marker,
    readyState: () => document.readyState,
    href: () => location.href,
    iframeCount: () => document.querySelectorAll('iframe').length,
    stampTitle: (n) => {
      const raw = document.title || '';
      const clean = raw.replace(/^🚀\s*\[\d+\]\s*/, '').trim();
      document.title = clean ? ('🚀 [' + n + '] ' + clean) : ('🚀 [' + n + ']');
      return true;
    },
    decorate: (p) => {
      const c = window.__9rFast; if (!c) return;
      const e = c.nodes.get(p.node);
      const r = e?.getBoundingClientRect();
      if (!r || !r.width) return;
      document.getElementById('__9rFx')?.remove();
      const box = document.createElement('div');
      box.id = '__9rFx';
      box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;' +
        'left:' + (r.x - 3) + 'px;top:' + (r.y - 3) + 'px;width:' + (r.width + 6) + 'px;height:' + (r.height + 6) +
        'px;border:2px solid #ff3b30;border-radius:4px;transition:opacity .3s';
      const dot = document.createElement('div');
      dot.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;' +
        'width:16px;height:16px;border-radius:50%;background:#ff3b30;opacity:.85;' +
        'left:' + (p.x - 68) + 'px;top:' + (p.y - 68) + 'px;' +
        'transition:left .12s ease-out,top .12s ease-out,opacity .3s';
      box.appendChild(dot);
      (document.body || document.documentElement).append(box);
      requestAnimationFrame(() => {
        dot.style.left = (p.x - 8) + 'px';
        dot.style.top = (p.y - 8) + 'px';
      });
      setTimeout(() => {
        box.style.opacity = '0'; dot.style.opacity = '0';
        setTimeout(() => { box.remove(); }, 320);
      }, 240);
      return true;
    },
    // Occlusion/visibility gate — mirrors engine.js resolve()
    resolve: (action) => {
      const c = window.__9rFast; if (!c) return null;
      const e = c.nodes.get(action.node);
      if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
        !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
      if (action.kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true')) return null;
      const frameEl = e.ownerDocument !== document ? e.ownerDocument.defaultView?.frameElement : null;
      const center = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
      let r = e.getBoundingClientRect();
      if (frameEl) {
        const fr = frameEl.getBoundingClientRect();
        r = { x: fr.x + r.x, y: fr.y + r.y, width: r.width, height: r.height };
      }
      if (!r.width || !r.height) return null;
      let p = center(r);
      if (p.x < 0 || p.y < 0 || p.x >= innerWidth || p.y >= innerHeight) {
        e.scrollIntoView({ block: 'center', inline: 'center' });
        r = e.getBoundingClientRect();
        if (frameEl) {
          const fr = frameEl.getBoundingClientRect();
          r = { x: fr.x + r.x, y: fr.y + r.y, width: r.width, height: r.height };
        }
        p = center(r);
        if (!r.width || !r.height || p.x < 0 || p.y < 0 || p.x >= innerWidth || p.y >= innerHeight) return null;
      }
      if (action.kind !== 'fill') {
        const hit = document.elementFromPoint(p.x, p.y);
        if (!hit) return null;
        const up = (el) => { const chain = []; let n = el;
          while (n) { chain.push(n); n = n.assignedSlot || n.parentElement || (n.getRootNode()?.host || null); }
          return chain; };
        const hitChain = up(hit);
        const isHit = e.contains(hit) || up(e).some((a) => a === hit) || hitChain.some((n) => n === e || e.contains(n)) ||
          (frameEl && (hit === frameEl || frameEl.contains(hit) || hit.contains(frameEl)));
        if (!isHit) return null;
      }
      if (action.kind === 'select') {
        if (e.tagName !== 'SELECT' || ![...e.options].some(o => o.value === action.value && !o.disabled)) return null;
        e.value = action.value;
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { x: p.x, y: p.y };
    },
    focus: (node) => { const e = window.__9rFast?.nodes.get(node); if (e) e.focus(); return true; },
    verifyText: (node, text) => {
      const e = window.__9rFast?.nodes.get(node); if (!e) return true;
      const v = 'value' in e ? String(e.value) : (e.innerText || '');
      return v.includes(text);
    },
    focusInsert: (node, text) => {
      const e = window.__9rFast?.nodes.get(node); if (e) e.focus();
      document.execCommand('insertText', false, text);
      return true;
    },
    insertText: (text) => { document.execCommand('insertText', false, String(text ?? '')); return true; },
    selectAll: () => { document.execCommand('selectAll', false, null); return true; },
    scrollBy: (dy, behavior) => { window.scrollBy({ top: Number(dy) || 0, left: 0, behavior: behavior || 'instant' }); return true; },
    scrollByPct: (pct) => { window.scrollBy({ top: Math.round(window.innerHeight * Number(pct || 0)), left: 0, behavior: 'instant' }); return true; },
    scrollToY: (target) => { window.scrollTo({ top: Math.max(0, Number(target) - Math.round(window.innerHeight / 2)), left: 0, behavior: 'instant' }); return true; },
    scrollToEdge: (edge) => {
      const height = document.documentElement.scrollHeight;
      window.scrollTo({ top: edge === 'top' ? 0 : height, left: 0, behavior: 'instant' });
      return true;
    },
    historyGo: (delta) => { history.go(Number(delta) || 0); return true; },
    jsClick: (node) => {
      const e = window.__9rFast?.nodes.get(node);
      if (!e?.isConnected || !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      e.scrollIntoView({ block: 'center' });
      e.click();
      return true;
    },
    scrollToAction: (node) => {
      const e = window.__9rFast?.nodes.get(node);
      if (!e?.isConnected) return false;
      e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      return true;
    },
    scrollToText: (needle) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      const lower = String(needle).toLowerCase();
      while ((node = walker.nextNode())) {
        if (node.textContent.toLowerCase().includes(lower)) {
          const el = node.parentElement;
          if (el && el.isConnected) {
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            return true;
          }
        }
      }
      return false;
    },
    scrollBurstStep: (delta, needles) => {
      window.scrollBy({ top: Number(delta) || 0, left: 0, behavior: 'instant' });
      const vis = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = w.nextNode()) && vis.length < 400) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const b = range.getBoundingClientRect();
        if (b.bottom >= 0 && b.top <= window.innerHeight && b.width > 0) vis.push(node.textContent);
      }
      const t = vis.join('\n');
      return { y: Math.round(window.scrollY), hit: needles.length > 0 && needles.every((s) => t.includes(s)) };
    },
    scrollBurstTo: (needles) => new Promise(resolve => {
      const step = Math.max(400, Math.round(window.innerHeight * 0.85));
      const t0 = performance.now();
      const visibleText = () => {
        const vis = [];
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = w.nextNode()) && vis.length < 400) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const b = range.getBoundingClientRect();
          if (b.bottom >= 0 && b.top <= window.innerHeight && b.width > 0) vis.push(node.textContent);
        }
        return vis.join('\n');
      };
      let hops = 0;
      const hop = () => {
        if (hops >= 60 || performance.now() - t0 > 3000) return resolve({ found: false, hops, y: Math.round(window.scrollY) });
        const before = Math.round(window.scrollY);
        window.scrollBy({ top: step, left: 0, behavior: 'instant' });
        hops++;
        if (Math.round(window.scrollY) === before && hops > 1) return resolve({ found: false, hops, y: before, bottom: true });
        const t = visibleText();
        if (needles.length && needles.every((s) => t.includes(s))) return resolve({ found: true, hops, y: Math.round(window.scrollY) });
        setTimeout(hop, 0);
      };
      hop();
    }),
    stableDom: (quiet, min, cap) => new Promise(resolve => {
      let ob = null, t = null;
      const t0 = performance.now();
      let last = t0;
      const done = () => { if (t) clearTimeout(t); try { ob && ob.disconnect(); } catch { } resolve(1); };
      if (!document.body) { setTimeout(done, Math.min(Math.max(min, quiet), cap)); return; }
      const check = () => {
        const now = performance.now();
        if ((now - last >= quiet && now - t0 >= min) || now - t0 >= cap) return done();
        t = setTimeout(check, 30);
      };
      ob = new MutationObserver(() => { last = performance.now(); });
      ob.observe(document.body, { childList: true, subtree: true, attributes: true });
      check();
    }),
    // Synthetic input (AutoAgent executor pattern) — isTrusted=false
    mouse: (type, x, y) => {
      const el = document.elementFromPoint(x, y) || document.body;
      const px = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: 'mouse', isPrimary: true, view: window };
      const mo = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window };
      if (type === 'move') {
        el.dispatchEvent(new PointerEvent('pointermove', px));
        el.dispatchEvent(new MouseEvent('mousemove', mo));
        return true;
      }
      if (type === 'down') {
        el.dispatchEvent(new PointerEvent('pointerover', px));
        el.dispatchEvent(new MouseEvent('mouseover', mo));
        el.dispatchEvent(new PointerEvent('pointerdown', px));
        el.dispatchEvent(new MouseEvent('mousedown', { ...mo, buttons: 1 }));
        if (typeof el.focus === 'function') el.focus({ preventScroll: true });
        return true;
      }
      el.dispatchEvent(new PointerEvent('pointerup', px));
      el.dispatchEvent(new MouseEvent('mouseup', mo));
      if (typeof el.click === 'function') el.click();
      else el.dispatchEvent(new MouseEvent('click', mo));
      return true;
    },
    key: (p) => {
      const vkOf = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39 };
      const t = document.activeElement || document.body;
      if (typeof t.focus === 'function') t.focus({ preventScroll: true });
      if (p.commands && p.commands.includes('selectAll')) { document.execCommand('selectAll', false, null); return true; }
      const key = p.key || '';
      const vk = p.vk ?? vkOf[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
      const ev = { key, code: p.code || key, keyCode: vk, which: vk, bubbles: true, cancelable: true, view: window,
        ctrlKey: !!(p.modifiers & 2), altKey: !!(p.modifiers & 1), metaKey: !!(p.modifiers & 4), shiftKey: !!(p.modifiers & 8) };
      t.dispatchEvent(new KeyboardEvent(p.type === 'keyDown' ? 'keydown' : 'keyup', ev));
      if (p.type === 'keyDown' && key === 'Enter') {
        const form = t instanceof HTMLInputElement && t.form;
        if (form) {
          const btn = form.querySelector('button[type="submit"], input[type="submit"]');
          if (btn) btn.click(); else if (form.requestSubmit) form.requestSubmit();
        } else if (t instanceof HTMLTextAreaElement) document.execCommand('insertLineBreak');
      }
      return true;
    },
    read: (parent, from, len) => {
      const needle = String(parent || '').toLowerCase().slice(0, 40);
      const fromNum = Math.max(0, Math.floor(Number(from) || 0));
      const lenNum = len == null ? PAGE_TEXT_CAP : Math.min(READ_TOTAL_CAP, Math.max(1, Math.floor(Number(len) || 1)));
      const visible = e => !e.closest('[aria-hidden="true"],[inert],[hidden],details:not([open]),template');
      const NOISE = 'nav,header,aside,form,button,select,option,label,dialog,' +
        '[role="banner"],[role="navigation"],[role="complementary"],[role="menu"],[role="listbox"],' +
        '.select-menu,.select-menu-modal,details-menu,' +
        '.ad,.ads,.advert,.cookie,.cookies,[class*="cookie-"],[id*="cookie"],.popup,.modal,.sidebar,.breadcrumb';
      const SEG_SEL = 'section,nav,aside,main,article,dialog,form,fieldset,[role="dialog"],' +
        '[role="region"],[role="group"],[role="tablist"],[role="tabpanel"],' +
        '[role="navigation"],[role="complementary"],[role="banner"],' +
        '[role="contentinfo"],[role="form"],[role="search"]';
      const segName = s => { const a = s.getAttribute('aria-label'); if (a) return a.slice(0, 40);
        const h = s.querySelector('h1,h2,h3,h4,legend'); return h ? (h.textContent || '').trim().slice(0, 40) : null; };
      const deep = (root, sel) => { const f = [...root.querySelectorAll(sel)];
        for (const e of root.querySelectorAll('*')) if (e.shadowRoot) f.push(...deep(e.shadowRoot, sel)); return f; };
      const named = deep(document, SEG_SEL).map(segName).filter(Boolean);
      let root = document.body;
      if (needle === '') {
        const solo = sel => { const f = deep(document, sel); return f.length === 1 ? f[0] : null; };
        root = solo('article') || solo('main,[role="main"]') || root;
      } else {
        const hit = deep(document, SEG_SEL).find(s => { const n = segName(s); return n && n.toLowerCase().includes(needle); });
        if (!hit) return { error: 'no section matches', sections: [...new Set(named)] };
        root = hit;
      }
      const noiseSkip = c => { const n = c.closest(NOISE); return Boolean(n) && n !== root && !n.contains(root); };
      const BLOCK = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,dt,dd,figure,table';
      const isBlock = e => e.nodeType === 1 && e.matches(BLOCK);
      const shortUrl = u => { try {
        const url = new URL(u, location.href);
        if (url.origin !== location.origin) return url.host + url.pathname + url.search + url.hash;
        if (url.pathname === location.pathname && url.search === location.search) return url.hash || url.pathname;
        return url.pathname + url.search + url.hash;
      } catch { return u; } };
      const inlineText = e => [...e.childNodes].map(n => n.nodeType === 3 ? n.textContent :
        (n.nodeType === 1 && !isBlock(n) && !n.matches('script,style,noscript,template') && visible(n) && !noiseSkip(n)) ?
          (n.tagName === 'A' && n.href && !n.href.startsWith('javascript:') ?
            '[' + inlineText(n) + '](' + shortUrl(n.href) + ')' : inlineText(n)) : '').join(' ');
      const clean = s => String(s || '').replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
      const lines = []; let length = 0;
      const push = (raw, indent) => { const t = clean(raw); if (!t) return false;
        const out = (indent ? '  '.repeat(indent) : '') + t; lines.push(out); length += out.length + 1;
        return length >= READ_TOTAL_CAP; };
      const descend = (el, liDepth) => {
        const children = [...el.children].filter(c => !c.matches('script,style,noscript,template') && !noiseSkip(c) && visible(c));
        let i = 0;
        while (i < children.length) {
          const c = children[i];
          if (isBlock(c)) { if (blockLine(c, liDepth)) return true; i++; continue; }
          let j = i; while (j < children.length && !isBlock(children[j]) && children[j].tagName === c.tagName && !children[j].children.length) j++;
          if (j - i >= 2) {
            const cells = children.slice(i, j).map(k => clean(inlineText(k))).filter(Boolean);
            if (cells.length >= 2) { if (push(cells.join(' · '), liDepth)) return true; i = j; continue; }
          }
          if (c.querySelector(BLOCK)) { if (descend(c, liDepth)) return true; }
          else {
            const ks = [...c.children];
            if (ks.length >= 2 && ks.every(k => k.tagName === ks[0].tagName && !k.children.length)) {
              const cells = ks.map(k => clean(inlineText(k))).filter(Boolean);
              if (cells.length >= 2) { if (push(cells.join(' · '), liDepth)) return true; i++; continue; }
            }
            if (push(inlineText(c), liDepth)) return true;
          }
          i++;
        }
        return false;
      };
      const blockLine = (b, liDepth) => {
        const tag = b.tagName;
        if (/^H[1-6]$/.test(tag)) return push('#'.repeat(+tag[1]) + ' ' + clean(b.textContent), 0);
        if (tag === 'LI') {
          const d = liDepth || 0;
          const t = inlineText(b); if (t && push('- ' + t, d)) return true;
          return b.querySelector(BLOCK) ? descend(b, d + 1) : false;
        }
        if (tag === 'TABLE') {
          for (const tr of b.querySelectorAll('tr')) {
            const cells = [...tr.children].map(td => clean(td.textContent)).filter(Boolean);
            if (cells.length && push('| ' + cells.join(' | ') + ' |', liDepth || 0)) return true;
          }
          return false;
        }
        const t = inlineText(b); if (t && push(t, liDepth)) return true;
        return b.querySelector(BLOCK) ? descend(b, liDepth) : false;
      };
      const directText = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ');
      const t = directText(root); if (t) push(t, 0);
      descend(root, 0);
      let total = 0; for (const l of lines) total += l.length + 1;
      let cum = 0, out = [], taken = 0;
      for (const l of lines) {
        cum += l.length + 1;
        if (cum <= fromNum) continue;
        let pushLine = l;
        if (taken + pushLine.length > lenNum) {
          pushLine = pushLine.slice(0, Math.max(0, lenNum - taken));
        }
        out.push(pushLine); taken += pushLine.length + 1;
        if (taken >= lenNum) break;
      }
      return { url: location.href, title: document.title, text: out.join('\n'), total, sections: [...new Set(named)] };
    }
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.t !== "op") return false;
    (async () => {
      try {
        const fn = OPS[msg.op];
        if (!fn) return sendResponse({ ok: false, err: `unknown op: ${msg.op}` });
        const v = await fn(...(msg.args || []));
        sendResponse({ ok: true, v: v ?? null });
      } catch (e) {
        sendResponse({ ok: false, err: String(e?.message || e) });
      }
    })();
    return true; // async reply
  });
}
