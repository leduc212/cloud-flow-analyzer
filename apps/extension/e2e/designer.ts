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
