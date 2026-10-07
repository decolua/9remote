// DOM snapshot ported from browser-use/jev-ultrafast snapshot.js (MIT).
// One CDP evaluate reads atomically: visible text, actionable controls, and a
// node-ID map kept in the page. Node IDs are the only handle the loop trusts —
// the model never sees selectors, coordinates or JS; coordinates ride on the
// returned actions for the agent, never inside the decision prompts.
import { MAX_ELEMENTS, PAGE_TEXT_CAP, READ_TOTAL_CAP, ELEMENT_DEEP_CAP } from "./constants.js";

// Injected once per page (idempotent cache on window.__9rFast), then executed.
const CACHE_BOOTSTRAP = `(() => {
  if (!window.__9rFast) window.__9rFast = {ids:new WeakMap(),nodes:new Map(),next:1};
})()`;

// win.from/win.len window the element table (the `ls --from` pages); win.cap
// raises the collection ceiling for windowed reads. Defaults keep the hot
// Jev loop byte-identical with the pre-windowing wire format.
const numWin = (v, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
const snapshotBody = (win = {}) => `(() => {
  const WIN_FROM=${numWin(win.from, 0)}, WIN_LEN=${Math.max(1, numWin(win.len, MAX_ELEMENTS))}, WIN_CAP=${Math.max(1, numWin(win.cap, MAX_ELEMENTS))};
  const cache = window.__9rFast;
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  // Password fields ARE observable (login forms) but never carry their value.
  // File inputs are observed too (kind 'upload') — the agent sets them via CDP,
  // never via a click (a native picker would wedge the loop).
  const safe = e => !['hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    const slotText=e=>[...e.querySelectorAll('slot')]
      .map(s=>[...s.assignedNodes()].map(n=>n.textContent||'').join('')).join(' ').trim();
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim() || slotText(e)) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || (e.tagName==='IFRAME' ? ((() => { try { return (e.src ? 'iframe: '+(new URL(e.src).hostname||e.src) : 'iframe'); } catch { return 'iframe'; } })()) : '');
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,iframe,[contenteditable="true"],[onclick],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  const role = e => {
    if (e.tagName==='IFRAME') return 'iframe';
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel','password'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(e=>safe(e)&&e.type!=='password')
      .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])];
  // Section context (heading/legend/aria-label of the enclosing dialog/section/
  // form) lets same-label controls be told apart without a tree layout.
  const secCache=new WeakMap();
  const ctxOf=e=>{
    const sec=e.closest('dialog,[role="dialog"],section,fieldset,form,nav,aside');
    if(!sec) return null;
    if(!secCache.has(sec)){
      const t=(sec.getAttribute('aria-label')||sec.querySelector('h1,h2,h3,h4,legend')?.textContent||'').trim();
      secCache.set(sec,t.slice(0,40));
    }
    const v=secCache.get(sec);
    return v||null;
  };
  // Structural path for the tree renderer: walk ancestors, keep landmark/
  // section wrappers that carry a name (aria-label or first heading/legend).
  const SEG_SEL='section,nav,aside,main,article,dialog,form,fieldset,[role="dialog"],'+
    '[role="region"],[role="group"],[role="tablist"],[role="tabpanel"],'+
    '[role="navigation"],[role="complementary"],[role="banner"],'+
    '[role="contentinfo"],[role="form"],[role="search"]';
  const segName=s=>{
    const a=s.getAttribute('aria-label');
    if(a) return a.slice(0,40);
    const h=s.querySelector('h1,h2,h3,h4,legend');
    return h?(h.textContent||'').trim().slice(0,40):null;
  };
  const pathCache=new WeakMap();
  const pathOf=e=>{
    if(pathCache.has(e)) return pathCache.get(e);
    const segs=[]; let n=e.parentElement;
    const doc=e.ownerDocument||document;
    while(n&&n!==doc.body&&n!==doc.documentElement&&segs.length<4){
      if(n.matches(SEG_SEL)){const s=segName(n); if(s) segs.unshift(s);}
      n=n.parentElement;
    }
    if (doc !== document) segs.unshift('iframe');
    const p=segs.length?segs:null;
    pathCache.set(e,p); return p;
  };
  const getRect=e=>{
    const r=e.getBoundingClientRect();
    if(e.ownerDocument&&e.ownerDocument!==document){
      try{
        const fr=e.ownerDocument.defaultView?.frameElement?.getBoundingClientRect();
        if(fr) return {x:fr.x+r.x,y:fr.y+r.y,width:r.width,height:r.height};
      }catch{}
    }
    return {x:r.x,y:r.y,width:r.width,height:r.height};
  };
  const actions=[];
  // Shadow piercing + same-origin iframe piercing: modern component sites keep
  // controls inside shadow trees and embed forms inside same-origin frames.
  const deepQuery=(root,sel)=>{
    const found=[...root.querySelectorAll(sel)];
    for (const e of root.querySelectorAll('*')) {
      if (e.shadowRoot) found.push(...deepQuery(e.shadowRoot,sel));
      if (e.tagName==='IFRAME') {
        try { if (e.contentDocument) found.push(...deepQuery(e.contentDocument,sel)); } catch {}
      }
    }
    return found;
  };
  const pfxOf=e=>{
    const t=e.tagName?e.tagName.toLowerCase():'';
    if(t==='button'||t==='summary') return 'btn';
    if(t==='a') return 'a';
    if(t==='input'||t==='textarea') return 'inp';
    if(t==='select') return 'sel';
    if(t==='iframe') return 'ifr';
    if(t==='div') return 'div';
    if(t==='span') return 'span';
    return t?t.slice(0,4):'e';
  };
  for (const e of deepQuery(document,selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r=getRect(e), x=r.x+r.width/2, y=r.y+r.height/2,
      rname=role(e)||(e.hasAttribute('onclick')?'button':null);
    if (r.width<=0 || r.height<=0) continue; // full page: no viewport cut (orca/openclaw shape)
    if (e.type==='file') {
      actions.push({node:identity(e),tag:'input',pfx:'inp',role:'button',label:(name(e)||'Choose file').replace(/\\s+/g,' ').trim(),
        ctx:ctxOf(e),path:pathOf(e),rect:{x:r.x,y:r.y,w:r.width,h:r.height},kind:'upload',value:''});
      continue;
    }
    if (!rname) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base={node:identity(e),tag:e.tagName.toLowerCase(),pfx:pfxOf(e),role:rname,label:(name(e)||rname).replace(/\\s+/g,' ').trim(),
      ctx:ctxOf(e),path:pathOf(e),rect:{x:r.x,y:r.y,w:r.width,h:r.height},
      href:(e.tagName==='A'&&e.href&&!e.href.startsWith('javascript:'))?e.href:undefined};
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (e.tagName==='SELECT') {
      // Label = currently-selected option, not all option text (keeps labels short for Jev).
      const selLabel=e.selectedOptions[0]?.label||'Current';
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:selLabel+' → '+o.label});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      // Masked at the source: a typed password never enters any state, prompt or
      // report — but "••••" still tells Jev (and the marker) the field is filled.
      const value=e.type==='password' ? (e.value?'••••':'') :
        'value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value});
      if (editable) actions.push({...base,kind:'click',value,label:'Open '+base.label});
    }
  }
  // Custom widgets: filter checkboxes, steppers and chip rows on real sites are
  // plain div/span with no ARIA role — the a11y selector above cannot see them.
  // Collect nodes that either carry pointer styling or a test-attribute marker
  // (data-testid / data-ui-name … devs stamp exactly their interactive parts)
  // and carry a name; an ancestor already collected absorbs its descendants.
  const picked=new Set(actions.map(a=>cache.nodes.get(a.node)));
  const isMarked=e=>e.hasAttribute('data-testid')||e.hasAttribute('data-test')||
    e.hasAttribute('data-ui-name')||e.hasAttribute('data-automation-id')||e.hasAttribute('data-filters-item');
  const pointerCandidates=[];
  for (const e of deepQuery(document,'div,span,li,label')) {
    if (pointerCandidates.length >= WIN_CAP) break;
    if (e.matches(selector)) continue; // the a11y selector owns this element
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const inner = e.querySelector('button,a,input,select,textarea,summary,[contenteditable="true"],[onclick],[role="button"],[role="checkbox"],[role="switch"]');
    if (inner) {
      // A label wrapping a VISUALLY-HIDDEN checkbox/radio is that control's
      // click proxy — keep it; anything holding a live control stays skipped.
      const ghost = inner.matches('input[type="checkbox"],input[type="radio"]') &&
        !inner.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
      if (!ghost) continue;
    }
    const st=getComputedStyle(e);
    if (st.pointerEvents==='none' || (st.cursor!=='pointer' && !isMarked(e))) continue;
    const label=name(e);
    if (!label) continue;
    const r=getRect(e);
    if (r.width<=0 || r.height<=0) continue;
    if ([...picked].some(p => p.contains(e))) continue;
    pointerCandidates.push({el:e, base:{node:identity(e),tag:e.tagName.toLowerCase(),pfx:pfxOf(e),role:'button',label:label.slice(0,80).replace(/\\s+/g,' ').trim(),
      ctx:ctxOf(e),path:pathOf(e),rect:{x:r.x,y:r.y,w:r.width,h:r.height}}});
    picked.add(e);
  }
  for (const c of pointerCandidates) actions.push({...c.base,kind:'click',value:''});
  const height=document.documentElement.scrollHeight;
  const words=[]; let length=0;
  // Page-chrome blacklist (9cowork pattern): nav/cookie/ads and control
  // labels are noise for reading — buttons/options already live in the element table.
  const NOISE='nav,header,aside,form,button,select,option,label,dialog,'+
    '[role="banner"],[role="navigation"],[role="complementary"],'+
    '.ad,.ads,.advert,.cookie,.cookies,[class*="cookie-"],[id*="cookie"],.popup,.modal,.sidebar,.breadcrumb';
  const collectText = (doc) => {
    if (!doc?.body) return;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const range = doc.createRange(); let node;
    while ((node=walker.nextNode()) && length<${PAGE_TEXT_CAP}) {
      const value=node.textContent.trim(), parent=node.parentElement;
      if (!value || !parent || parent.closest('script,style,noscript,template') ||
          parent.closest(NOISE) || !visible(parent)) continue;
      range.selectNodeContents(node); const r=range.getBoundingClientRect();
      if (r.width>0 && r.height>0) {
        if (height <= innerHeight * 1.5 || (r.bottom >= -100 && r.top <= innerHeight + 400)) {
          words.push(value); length+=value.length;
        }
      }
    }
  };
  collectText(document);
  for (const f of document.querySelectorAll('iframe')) {
    try { if (f.contentDocument) collectText(f.contentDocument); } catch {}
  }
  const text=words.join('\\n').slice(0,${PAGE_TEXT_CAP});
  const headings=[];
  for (const h of document.querySelectorAll('h1,h2,h3,h4')) {
    if (headings.length>=12) break;
    const t=h.textContent.trim().slice(0,60);
    if (t) headings.push(t);
  }
  const page_key=cache.pageKey();
  // Window FIRST — the marker fingerprint describes exactly the observed set,
  // so a deep-collect for a windowed ls read never inflates the marker wire cost.
  const total=actions.length;
  const shown=actions.slice(WIN_FROM,WIN_FROM+WIN_LEN);
  const omitted_actions=Math.max(0,total-(WIN_FROM+shown.length));
  const semantics=shown.map(({rect,ctx,path,...action})=>action);
  const frameCount=document.querySelectorAll('iframe').length;
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,semantics,page_key[6],frameCount];
  // Progress marker WITHOUT scroll offsets: scrolling that reveals nothing new
  // must not count as page progress (video players, tall static sections).
  const contentMarker=[performance.timeOrigin,location.href,innerWidth,innerHeight,
    document.title,text,semantics,frameCount];
  const actions2=shown;
  // Display id = tag prefix + stable node id: a list shift must not
  // renumber elements the caller still holds (chain ids, label guards). Extra
  // rows on one node (select options, fill+click pair) get a -N suffix.
  {const seq=new Map();actions2.forEach(a=>{const n=seq.get(a.node)||0;seq.set(a.node,n+1);
    const p=a.pfx||'e';
    a.id=p+a.node+(n?'-'+n:'');});}
  const scrollStep=Math.max(400,Math.round(innerHeight*0.85));
  if (scrollY+innerHeight<height-2) actions2.push({id:'scroll_down',kind:'scroll',label:'Scroll down',delta:scrollStep});
  if (scrollY>0) actions2.push({id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-scrollStep});
  actions2.push({id:'wait',kind:'wait',label:'Wait for the page to update'});
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,headings,
    scroll:{y:scrollY,height},actions:actions2,marker,contentMarker,page_key,omitted_actions,
    total_elements:total,element_from:WIN_FROM};
})()`;

// Parameterized snapshot: windowed/deep reads (ls --from) bake their numbers
// in; every default caller keeps the historical wire format.
export function snapshotExpression(win = {}) {
  return `(${CACHE_BOOTSTRAP},${snapshotBody(win)})`;
}
export const SNAPSHOT_EXPRESSION = snapshotExpression();
// Freshness marker only — cheap re-check that the observed page is still the same one.
export const MARKER_EXPRESSION = `(() => { const state=(${snapshotBody()}); return state ? state.marker : null; })()`;

// Markdown-lite content reader (the `read` op). Same vocabulary as --parent:
// a section matches by its tree name (segName). Structure: headings keep their
// level, paragraphs merge inline runs into one line, runs of same-tag leaf
// siblings join " · " (chips, div-rows, role=row grids), real tables render
// pipe rows, nested lists indent 2 spaces per level. Same NOISE/visibility
// rules and cap as the snapshot walker.
export function readExpression(parent, from = 0, len = null) {
  const needle = JSON.stringify(String(parent || "").toLowerCase());
  const fromNum = Math.max(0, Math.floor(Number(from) || 0));
  const lenNum = len == null ? PAGE_TEXT_CAP : Math.min(READ_TOTAL_CAP, Math.max(1, Math.floor(Number(len) || 1)));
  return `(() => {
  const needle = ${needle};
  // READER visibility: content-visibility:auto (GitHub timeline) reports
  // checkVisibility=false while textContent stays readable — gate on intent
  // markers only, not rendered-ness.
  const visible = e => !e.closest('[aria-hidden="true"],[inert],[hidden],details:not([open]),template');
  const NOISE='nav,header,aside,form,button,select,option,label,dialog,'+
    '[role="banner"],[role="navigation"],[role="complementary"],[role="menu"],[role="listbox"],'+
    '.select-menu,.select-menu-modal,details-menu,'+
    '.ad,.ads,.advert,.cookie,.cookies,[class*="cookie-"],[id*="cookie"],.popup,.modal,.sidebar,.breadcrumb';
  const SEG_SEL='section,nav,aside,main,article,dialog,form,fieldset,[role="dialog"],'+
    '[role="region"],[role="group"],[role="tablist"],[role="tabpanel"],'+
    '[role="navigation"],[role="complementary"],[role="banner"],'+
    '[role="contentinfo"],[role="form"],[role="search"]';
  const segName=s=>{const a=s.getAttribute('aria-label'); if(a) return a.slice(0,40);
    const h=s.querySelector('h1,h2,h3,h4,legend'); return h?(h.textContent||'').trim().slice(0,40):null;};
  const deep=(root,sel)=>{const f=[...root.querySelectorAll(sel)];
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) f.push(...deep(e.shadowRoot,sel)); return f;};
  const named=deep(document,SEG_SEL).map(segName).filter(Boolean);
  let root=document.body;
  if(needle!==''){
    const hit=deep(document,SEG_SEL).find(s=>{const n=segName(s); return n&&n.toLowerCase().includes(needle);});
    if(!hit) return {error:'no section matches',sections:[...new Set(named)]};
    root=hit;
  }
  // A NOISE ancestor of the chosen root does not apply — the root was picked.
  const noiseSkip=c=>{const n=c.closest(NOISE); return Boolean(n)&&n!==root&&!n.contains(root);};
  const BLOCK='p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,dt,dd,figure,table';
  const isBlock=e=>e.nodeType===1&&e.matches(BLOCK);
  // Inline run: text of descendants, stopping at any block boundary. Anchors
  // become [label](url) so grep --links and readers see the destination.
  // URLs are shortened: same-origin -> path-only (the page origin rides the
  // response), cross-origin -> host/path — repeating https://host hundreds of
  // times wasted a third of the read budget on link-heavy pages.
  const shortUrl=u=>{try{
    const url=new URL(u,location.href);
    if(url.origin!==location.origin) return url.host+url.pathname+url.search+url.hash;
    if(url.pathname===location.pathname&&url.search===location.search) return url.hash||url.pathname;
    return url.pathname+url.search+url.hash;
  }catch{return u}};
  const inlineText=e=>[...e.childNodes].map(n=>n.nodeType===3?n.textContent:
    (n.nodeType===1&&!isBlock(n)&&!n.matches('script,style,noscript,template')&&visible(n)&&!noiseSkip(n))?
      (n.tagName==='A'&&n.href&&!n.href.startsWith('javascript:')?
        '['+inlineText(n)+']('+shortUrl(n.href)+')':inlineText(n)):'').join(' ');
  const clean=s=>String(s||'').replace(/\\s+/g,' ').replace(/\\s+([.,;:!?])/g,'$1').trim();
  const lines=[]; let len=0;
  const push=(raw,indent)=>{const t=clean(raw); if(!t) return false;
    const out=(indent?'  '.repeat(indent):'')+t; lines.push(out); len+=out.length+1;
    return len>=${READ_TOTAL_CAP};};
  const descend=(el,liDepth)=>{
    const children=[...el.children].filter(c=>!c.matches('script,style,noscript,template')&&!noiseSkip(c)&&visible(c));
    let i=0;
    while(i<children.length){
      const c=children[i];
      if(isBlock(c)){ if(blockLine(c,liDepth)) return true; i++; continue; }
      let j=i; while(j<children.length&&!isBlock(children[j])&&children[j].tagName===c.tagName&&!children[j].children.length) j++;
      if(j-i>=2){
        const cells=children.slice(i,j).map(k=>clean(inlineText(k))).filter(Boolean);
        if(cells.length>=2){ if(push(cells.join(' · '),liDepth)) return true; i=j; continue; }
      }
      // Inline-only subtrees (lone leaves and wrappers like GitHub's
      // <div class=row><a>#12</a></div>) carry text no ancestor emitted — one
      // line each. Wrappers that CONTAIN blocks recurse; anything else would
      // duplicate text an ancestor's inlineText already consumed.
      if(c.querySelector(BLOCK)){ if(descend(c,liDepth)) return true; }
      else {
        // Inline-only wrapper: a same-tag leaf run inside IS a row ("a · b · c");
        // anything else collapses to one line — no recursion, no duplication.
        const ks=[...c.children];
        if(ks.length>=2&&ks.every(k=>k.tagName===ks[0].tagName&&!k.children.length)){
          const cells=ks.map(k=>clean(inlineText(k))).filter(Boolean);
          if(cells.length>=2){ if(push(cells.join(' · '),liDepth)) return true; i++; continue; }
        }
        if(push(inlineText(c),liDepth)) return true;
      }
      i++;
    }
    return false;
  };
  const blockLine=(b,liDepth)=>{
    const tag=b.tagName;
    if(/^H[1-6]$/.test(tag)) return push('#'.repeat(+tag[1])+' '+clean(b.textContent),0);
    if(tag==='LI'){
      const d=liDepth||0;
      const t=inlineText(b); if(t&&push('- '+t,d)) return true;
      return b.querySelector(BLOCK) ? descend(b,d+1) : false;
    }
    if(tag==='TABLE'){
      for(const tr of b.querySelectorAll('tr')){
        const cells=[...tr.children].map(td=>clean(td.textContent)).filter(Boolean);
        if(cells.length&&push('| '+cells.join(' | ')+' |',liDepth||0)) return true;
      }
      return false;
    }
    const t=inlineText(b); if(t&&push(t,liDepth)) return true;
    return b.querySelector(BLOCK) ? descend(b,liDepth) : false;
  };
  // Floating text of a CONTAINER is its direct text nodes only — recursion here
  // would swallow nav/footer noise and chip rows (they are not blocks).
  const directText=e=>[...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join(' ');

  const t=directText(root); if(t) push(t,0);
  descend(root,0);
  // Window over the rendered lines (line-aligned): [from, from+len). total is
  // the full render length so the agent knows whether to page on.
  let total=0; for(const l of lines) total+=l.length+1;
  const from=${fromNum}, maxLen=${lenNum};
  let cum=0, out=[], taken=0;
  for(const l of lines){
    cum+=l.length+1;
    if(cum<=from) continue;
    let pushLine = l;
    if(taken + pushLine.length > maxLen) {
      pushLine = pushLine.slice(0, Math.max(0, maxLen - taken));
    }
    out.push(pushLine); taken+=pushLine.length+1;
    if(taken>=maxLen) break;
  }
  return {url:location.href,title:document.title,text:out.join('\\n'),total,sections:[...new Set(named)]};
})()`;
}

export async function evaluate(client, sessionId, expression, { awaitPromise = false, timeoutMs } = {}) {
  const result = await client.call("Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise }, sessionId, timeoutMs);
  if (result.exceptionDetails) throw new Error("Snapshot evaluation failed — document changed");
  return result.result?.value ?? null;
}

// In-page quiet window (chrome-devtools-mcp WaitForHelper pattern): a
// MutationObserver tracks the last mutation; resolve once the page has been
// quiet for `quiet` ms AND the action floor `min` ms has passed — exactly when
// the old host-side marker poll would exit, minus the poll granularity. The
// in-page 30ms check reads one variable (no CDP round trips, no snapshot
// re-runs), and the cap lives in-page so a wedged renderer cannot hold the
// evaluate forever.
export function stableDomExpression(quietMs, minMs, capMs) {
  const quiet = Math.max(1, Math.floor(quietMs));
  const min = Math.max(0, Math.floor(minMs));
  const cap = Math.max(min + quiet + 1, Math.floor(capMs));
  return `new Promise(resolve => {
  let ob = null, t = null;
  const t0 = performance.now();
  let last = t0;
  const done = () => { if (t) clearTimeout(t); try { ob && ob.disconnect(); } catch { } resolve(1); };
  if (!document.body) { setTimeout(done, Math.min(Math.max(${min}, ${quiet}), ${cap})); return; }
  const check = () => {
    const now = performance.now();
    if ((now - last >= ${quiet} && now - t0 >= ${min}) || now - t0 >= ${cap}) return done();
    t = setTimeout(check, 30);
  };
  ob = new MutationObserver(() => { last = performance.now(); });
  ob.observe(document.body, { childList: true, subtree: true, attributes: true });
  check();
})`;
}

