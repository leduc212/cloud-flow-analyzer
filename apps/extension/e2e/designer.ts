// A stand-in for the Power Automate designer, close enough to exercise the pane: a React
// Flow-like canvas that pans only by dragging the empty pane, draws only the nodes near the
// visible area (like the real designer), and has collapsible containers whose header node is
// "<name>-#scope" with a `.msla-collapse-toggle` button.

export interface DesignerItem {
  id: string;
  depth?: number;
  parent?: string;
  container?: boolean;
  collapsed?: boolean;
}

export function designerPage(items: DesignerItem[], token: string): string {
  return `<!doctype html><html><head><style>
body{margin:0;font-family:sans-serif} .top{height:48px;background:#0f6cbd;color:#fff;padding:12px;box-sizing:border-box}
.react-flow{position:fixed;top:48px;left:0;right:0;bottom:0;overflow:hidden;background:#f5f5f5}
.react-flow__pane{position:absolute;inset:0}
.react-flow__viewport{position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none}
.react-flow__node{position:absolute;width:300px;height:56px;background:#fff;border:1px solid #999;border-radius:6px;display:flex;align-items:center;gap:8px;padding:0 10px;box-sizing:border-box;pointer-events:all}
</style></head><body><div class="top">Power Automate (test designer)</div>
<div class="react-flow"><div class="react-flow__renderer"><div class="react-flow__pane"></div>
<div class="react-flow__viewport" style="transform:translate(0px,0px) scale(1)"></div></div></div>
<script>
  const items = ${JSON.stringify(items)};
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  const visible = (i) => !i.parent || (!byId[i.parent].collapsed && visible(byId[i.parent]));
  const vp = document.querySelector('.react-flow__viewport');
  const canvas = document.querySelector('.react-flow');
  let tx = 0, ty = 0, drag = null;
  window.toggleClicks = 0;
  function render() {
    vp.innerHTML = '';
    const box = canvas.getBoundingClientRect();
    let y = 40;
    for (const i of items) {
      if (!visible(i)) continue;
      const depth = i.depth || 0;
      const x = 300 + depth * 700, top = y;
      y += depth ? 600 : 120;
      const onScreen = x + tx < box.width + 50 && x + 300 + tx > -50 && top + ty < box.height + 50 && top + 56 + ty > -50;
      if (!onScreen) continue;
      const n = document.createElement('div');
      n.className = 'react-flow__node';
      n.dataset.id = i.container ? i.id + '-#scope' : i.id;
      n.style.left = x + 'px';
      n.style.top = top + 'px';
      if (i.container) {
        const t = document.createElement('button');
        t.className = 'msla-collapse-toggle';
        t.setAttribute('aria-label', i.collapsed ? 'Expand' : 'Collapse');
        t.onclick = () => { i.collapsed = !i.collapsed; window.toggleClicks++; setTimeout(render, 100); };
        n.append(t);
      }
      n.append(i.id.replace(/_/g, ' '));
      vp.append(n);
    }
  }
  render();
  const pane = document.querySelector('.react-flow__pane');
  pane.addEventListener('mousedown', (e) => { if (e.button === 0) drag = { x: e.clientX, y: e.clientY, tx, ty }; });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    tx = drag.tx + e.clientX - drag.x; ty = drag.ty + e.clientY - drag.y;
    vp.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(1)';
    render();
  });
  window.addEventListener('mouseup', () => { drag = null; });
  // The portal calls the API with the user's token; the extension picks it up from here.
  fetch('https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments?api-version=2020-06-01', {
    headers: { Authorization: 'Bearer ${token}' },
  }).catch(() => {});
</script></body></html>`;
}

/** A portal page that isn't a designer (e.g. the flow list), which still signs in like the portal. */
export function plainPage(text: string, token: string): string {
  return `<!doctype html><html><body><main>${text}</main><script>
  fetch('https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments?api-version=2020-06-01', {
    headers: { Authorization: 'Bearer ${token}' },
  }).catch(() => {});
</script></body></html>`;
}

/**
 * A closer stand-in for the new designer, laid out from a flow definition the way it draws one:
 * every container is a box node named after the action with a "<name>-#scope" header on top;
 * Condition branches and Switch cases sit side by side under the header, each with a
 * "<branch>-#subgraph" card (and a "<branch>" box when open); only nodes that overlap the
 * visible canvas are drawn. `collapsed` lists containers and branches (e.g.
 * "Condition-elseActions") that start collapsed; clicking a toggle in `stuck` does nothing.
 */
export function flowDesignerPage(
  definition: { triggers: Record<string, unknown>; actions: Record<string, unknown> },
  collapsed: string[],
  token: string,
  stuck: string[] = [],
): string {
  return `<!doctype html><html><head><style>
body{margin:0;font-family:sans-serif} .top{height:48px;background:#0f6cbd;color:#fff;padding:12px;box-sizing:border-box}
.react-flow{position:fixed;top:48px;left:0;right:0;bottom:0;overflow:hidden;background:#f5f5f5}
.react-flow__pane{position:absolute;inset:0}
.react-flow__viewport{position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none}
.react-flow__node{position:absolute;box-sizing:border-box;font-size:12px}
.card{background:#fff;border:1px solid #999;border-radius:6px;display:flex;align-items:center;gap:8px;padding:0 10px;pointer-events:all}
.box{border:1px dashed #bbb;border-radius:8px}
</style></head><body><div class="top">Power Automate (test designer)</div>
<div class="react-flow"><div class="react-flow__renderer"><div class="react-flow__pane"></div>
<div class="react-flow__viewport" style="transform:translate(0px,0px) scale(1)"></div></div></div>
<script>
  const flow = ${JSON.stringify(definition)};
  const collapsed = new Set(${JSON.stringify(collapsed)});
  const stuck = new Set(${JSON.stringify(stuck)});
  const W = 240, H = 44, GAP = 50, CARD_W = 120, CARD_H = 32, PAD = 30, BGAP = 60;
  const vp = document.querySelector('.react-flow__viewport');
  const canvas = document.querySelector('.react-flow');
  let tx = 0, ty = 0, drag = null, nodes = [], started = false;
  window.toggleClicks = 0;

  function ordered(actions) {
    const names = Object.keys(actions), done = new Set(), out = [];
    while (out.length < names.length) {
      const ready = names.find((n) => !done.has(n) &&
        Object.keys(actions[n].runAfter || {}).every((p) => done.has(p) || !(p in actions)));
      const pick = ready || names.find((n) => !done.has(n));
      done.add(pick); out.push(pick);
    }
    return out;
  }
  function branches(name, a) {
    const t = (a.type || '').toLowerCase();
    if (t === 'if') return [[name + '-actions', a.actions || {}], [name + '-elseActions', (a.else || {}).actions || {}]];
    if (t === 'switch') return [
      ...Object.entries(a.cases || {}).map(([c, v]) => [c, v.actions || {}]),
      [name + '-defaultCase', (a.default || {}).actions || {}],
    ];
    return null;
  }
  const isContainer = (a) => ['scope', 'foreach', 'until', 'if', 'switch'].includes((a.type || '').toLowerCase());
  function list(entries) {
    const items = entries.map(([name, a]) => layout(name, a));
    const w = Math.max(W, ...items.map((i) => i.w));
    const h = items.reduce((sum, i) => sum + i.h, 0) + GAP * Math.max(items.length - 1, 0);
    return { w, h, empty: items.length === 0, place(x, y) {
      for (const i of items) { i.place(x + (w - i.w) / 2, y); y += i.h + GAP; }
    } };
  }
  function layout(name, a) {
    if (!isContainer(a)) return { w: W, h: H, place: (x, y) => nodes.push({ id: name, x, y, w: W, h: H, text: name }) };
    const header = (x, y) => nodes.push({ id: name + '-#scope', x, y, w: W, h: H, text: name, toggle: name });
    if (collapsed.has(name)) return { w: W, h: H, place(x, y) {
      nodes.push({ id: name, x, y, w: W, h: H, box: true }); header(x, y);
    } };
    const br = branches(name, a);
    if (!br) {
      const inner = list(ordered(a.actions || {}).map((n) => [n, a.actions[n]]));
      const w = Math.max(W, inner.w) + 2 * PAD, h = H + (inner.empty ? 0 : GAP + inner.h) + PAD;
      return { w, h, place(x, y) {
        nodes.push({ id: name, x, y, w, h, box: true });
        header(x + (w - W) / 2, y);
        inner.place(x + (w - inner.w) / 2, y + H + GAP);
      } };
    }
    const parts = br.map(([id, acts]) => {
      const sub = collapsed.has(id) ? null : list(ordered(acts).map((n) => [n, acts[n]]));
      const w = Math.max(CARD_W, sub ? sub.w : 0);
      const h = CARD_H + (sub && !sub.empty ? GAP + sub.h : 0);
      return { id, sub, w, h };
    });
    const w = parts.reduce((sum, p) => sum + p.w, 0) + BGAP * (parts.length - 1) + 2 * PAD;
    const h = H + GAP + Math.max(...parts.map((p) => p.h)) + PAD;
    return { w, h, place(x, y) {
      nodes.push({ id: name, x, y, w, h, box: true });
      header(x + (w - W) / 2, y);
      let bx = x + PAD;
      const by = y + H + GAP;
      for (const p of parts) {
        if (p.sub) nodes.push({ id: p.id, x: bx, y: by, w: p.w, h: p.h, box: true });
        nodes.push({ id: p.id + '-#subgraph', x: bx + (p.w - CARD_W) / 2, y: by, w: CARD_W, h: CARD_H, text: p.id, toggle: p.id, card: true });
        if (p.sub) p.sub.place(bx + (p.w - p.sub.w) / 2, by + CARD_H + GAP);
        bx += p.w + BGAP;
      }
    } };
  }
  function render() {
    nodes = [];
    const top = list([
      ...Object.entries(flow.triggers),
      ...ordered(flow.actions).map((n) => [n, flow.actions[n]]),
    ]);
    top.place(0, 40);
    vp.innerHTML = '';
    const view = canvas.getBoundingClientRect();
    if (!started) {
      // Opens with the trigger in the middle, like the designer.
      started = true;
      tx = Math.round(view.width / 2 - (nodes[0].x + nodes[0].w / 2));
      vp.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(1)';
    }
    for (const n of nodes) {
      const onScreen = n.x + tx < view.width && n.x + n.w + tx > 0 && n.y + ty < view.height && n.y + n.h + ty > 0;
      if (!onScreen) continue;
      const el = document.createElement('div');
      el.className = 'react-flow__node ' + (n.box ? 'box' : 'card');
      el.dataset.id = n.id;
      Object.assign(el.style, { left: n.x + 'px', top: n.y + 'px', width: n.w + 'px', height: n.h + 'px' });
      if (n.toggle) {
        const t = document.createElement('button');
        const shut = collapsed.has(n.toggle);
        t.setAttribute('aria-expanded', String(!shut));
        t.setAttribute('aria-label', (shut ? 'Expand' : 'Collapse') + (n.card ? '' : ' ' + n.text.replace(/_/g, ' ')));
        t.textContent = shut ? '+' : '-';
        t.onclick = () => {
          window.toggleClicks++;
          if (stuck.has(n.toggle)) return;
          if (shut) collapsed.delete(n.toggle); else collapsed.add(n.toggle);
          setTimeout(render, 100);
        };
        el.append(t);
      }
      if (n.text) el.append(n.text.replace(/_/g, ' '));
      vp.append(el);
    }
  }
  render();
  const pane = document.querySelector('.react-flow__pane');
  pane.addEventListener('mousedown', (e) => { if (e.button === 0) drag = { x: e.clientX, y: e.clientY, tx, ty }; });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    tx = drag.tx + e.clientX - drag.x; ty = drag.ty + e.clientY - drag.y;
    vp.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(1)';
    render();
  });
  window.addEventListener('mouseup', () => { drag = null; });
  fetch('https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments?api-version=2020-06-01', {
    headers: { Authorization: 'Bearer ${token}' },
  }).catch(() => {});
</script></body></html>`;
}
