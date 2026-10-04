// DOM snapshot ported from browser-use/jev-ultrafast snapshot.js (MIT).
// One CDP evaluate reads atomically: visible text, actionable controls, and a
// node-ID map kept in the page. Node IDs are the only handle the loop trusts —
// the model never sees selectors, coordinates or JS; coordinates ride on the
// returned actions for the agent, never inside the decision prompts.
import { MAX_ELEMENTS, PAGE_TEXT_CAP } from "./constants.js";

// Injected once per page (idempotent cache on window.__9rFast), then executed.
const CACHE_BOOTSTRAP = `(() => {
  if (!window.__9rFast) window.__9rFast = {ids:new WeakMap(),nodes:new Map(),next:1};
})()`;

const SNAPSHOT_BODY = `(() => {
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
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],[onclick],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  const role = e => {
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
    while(n&&n!==document.body&&n!==document.documentElement&&segs.length<4){
      if(n.matches(SEG_SEL)){const s=segName(n); if(s) segs.unshift(s);}
      n=n.parentElement;
    }
    const p=segs.length?segs:null;
    pathCache.set(e,p); return p;
  };
  const actions=[];
  // Shadow piercing (open roots): modern component sites (Reddit etc.) keep
  // controls inside shadow trees the plain document query cannot reach.
  const deepQuery=(root,sel)=>{
    const found=[...root.querySelectorAll(sel)];
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) found.push(...deepQuery(e.shadowRoot,sel));
    return found;
  };
  for (const e of deepQuery(document,selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2,
      rname=role(e)||(e.hasAttribute('onclick')?'button':null);
    if (r.width<=0 || r.height<=0) continue; // full page: no viewport cut (orca/openclaw shape)
    if (e.type==='file') {
      actions.push({node:identity(e),role:'button',label:name(e)||'Choose file',
        ctx:ctxOf(e),path:pathOf(e),rect:{x:r.x,y:r.y,w:r.width,h:r.height},kind:'upload',value:''});
      continue;
    }
    if (!rname) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base={node:identity(e),role:rname,label:name(e)||rname,
      ctx:ctxOf(e),path:pathOf(e),rect:{x:r.x,y:r.y,w:r.width,h:r.height}};
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
    if (pointerCandidates.length >= ${MAX_ELEMENTS}) break;
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
    const r=e.getBoundingClientRect();
    if (r.width<=0 || r.height<=0) continue;
    if ([...picked].some(p => p.contains(e))) continue;
    pointerCandidates.push({el:e, base:{node:identity(e),role:'button',label:label.slice(0,80),
      ctx:ctxOf(e),path:pathOf(e),rect:{x:r.x,y:r.y,w:r.width,h:r.height}}});
    picked.add(e);
  }
  for (const c of pointerCandidates) actions.push({...c.base,kind:'click',value:''});
  const words=[], walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const range=document.createRange(); let node,length=0;
  // Page-chrome blacklist (9cowork pattern): nav/footer/cookie/ads and control
  // labels are noise for reading — buttons/options already live in the element table.
  const NOISE='nav,header,footer,aside,form,button,select,option,label,dialog,'+
    '[role="banner"],[role="navigation"],[role="contentinfo"],[role="complementary"],'+
    '.ad,.ads,.advert,.cookie,.cookies,[class*="cookie-"],[id*="cookie"],.popup,.modal,.sidebar,.breadcrumb';
  while ((node=walker.nextNode()) && length<${PAGE_TEXT_CAP}) {
    const value=node.textContent.trim(), parent=node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') ||
        parent.closest(NOISE) || !visible(parent)) continue;
    range.selectNodeContents(node); const r=range.getBoundingClientRect();
    if (r.width>0 && r.height>0) {
      words.push(value); length+=value.length;
    }
  }
  const text=words.join('\\n').slice(0,${PAGE_TEXT_CAP}), height=document.documentElement.scrollHeight;
  const headings=[];
  for (const h of document.querySelectorAll('h1,h2,h3,h4')) {
    if (headings.length>=12) break;
    const t=h.textContent.trim().slice(0,60);
    if (t) headings.push(t);
  }
  const page_key=cache.pageKey();
  const semantics=actions.map(({rect,ctx,path,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,semantics,page_key[6]];
  // Progress marker WITHOUT scroll offsets: scrolling that reveals nothing new
  // must not count as page progress (video players, tall static sections).
  const contentMarker=[performance.timeOrigin,location.href,innerWidth,innerHeight,
    document.title,text,semantics];
  const omitted_actions=Math.max(0,actions.length-${MAX_ELEMENTS});
  actions.splice(${MAX_ELEMENTS});
  actions.forEach((a,i)=>a.id='e'+(i+1));
  if (scrollY+innerHeight<height-2) actions.push({id:'scroll_down',kind:'scroll',label:'Scroll down',delta:560});
  if (scrollY>0) actions.push({id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-560});
  actions.push({id:'wait',kind:'wait',label:'Wait for the page to update'});
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,headings,
    scroll:{y:scrollY,height},actions,marker,contentMarker,page_key,omitted_actions};
})()`;

export const SNAPSHOT_EXPRESSION = `(${CACHE_BOOTSTRAP},${SNAPSHOT_BODY})`;
// Freshness marker only — cheap re-check that the observed page is still the same one.
export const MARKER_EXPRESSION = `(() => { const state=(${SNAPSHOT_BODY}); return state ? state.marker : null; })()`;

export async function evaluate(client, sessionId, expression, { awaitPromise = false } = {}) {
  const result = await client.call("Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise }, sessionId);
  if (result.exceptionDetails) throw new Error("Snapshot evaluation failed — document changed");
  return result.result?.value ?? null;
}
