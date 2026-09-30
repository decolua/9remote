// DOM snapshot ported from browser-use/jev-ultrafast snapshot.js (MIT).
// One CDP evaluate reads atomically: visible text, actionable controls, and a
// node-ID map kept in the page. Node IDs are the only handle the loop trusts —
// the model never sees selectors, coordinates or JS.
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
  const safe = e => !['password','file','hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
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
      if (['text','email','url','tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe)
      .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])];
  cache.guard=e=>{
    if (!e?.isConnected || !visible(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,${PAGE_TEXT_CAP})||''];
  };
  const actions=[];
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
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2,
      rname=role(e)||(e.hasAttribute('onclick')?'button':null);
    if (!rname || r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base={node:identity(e),role:rname,label:name(e)||rname,
      ctx:ctxOf(e),rect:{x:r.x,y:r.y,w:r.width,h:r.height}};
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
      const value='value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value});
      if (editable) actions.push({...base,kind:'click',value,label:'Open '+base.label});
    }
  }
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
    if (r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) {
      words.push(value); length+=value.length;
    }
  }
  const text=words.join('\\n').slice(0,${PAGE_TEXT_CAP}), height=document.documentElement.scrollHeight;
  const headings=[];
  for (const h of document.querySelectorAll('h1,h2,h3,h4')) {
    if (headings.length>=12) break;
    const r=h.getBoundingClientRect();
    if (r.bottom>0 && r.top<innerHeight) {
      const t=h.textContent.trim().slice(0,60);
      if (t) headings.push(t);
    }
  }
  const page_key=cache.pageKey(), guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  const semantics=actions.map(({rect,ctx,...action})=>action);
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
    scroll:{y:scrollY,height},actions,marker,contentMarker,page_key,guards,omitted_actions};
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
