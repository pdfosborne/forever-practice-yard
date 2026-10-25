// A spec's main-screen panel (Spec.panel): text and fields that write the
// spec's options. Rebuilt after every change, so the text follows the values.
import type { Combat } from '../engine/combat';
import type { Spec } from '../engine/types';

export class SpecPanelView {
  readonly el: HTMLDetailsElement;

  /** `set` saves the changes (null removes an option) and calls refresh(). */
  constructor(private spec: Spec, private combat: Combat, private set: (changes: Record<string, string | number | null>) => void) {
    this.el = document.createElement('details');
    this.el.className = 'spec-panel';
    // Open on a wide screen, folded on a phone.
    this.el.open = !matchMedia('(max-width: 720px)').matches;
    this.refresh();
  }

  refresh(): void {
    const p = this.spec.panel?.(this.combat);
    if (!p) return;
    const open = this.el.open;
    this.el.innerHTML = '';
    const summary = document.createElement('summary');
    summary.textContent = p.title;
    this.el.append(summary);
    for (const t of p.text) {
      const para = document.createElement('p');
      para.textContent = t;
      this.el.append(para);
    }
    for (const f of p.fields) {
      if (f.group) {
        const g = document.createElement('div');
        g.className = 'spec-panel-group';
        g.textContent = f.group;
        this.el.append(g);
      }
      const label = document.createElement('label');
      label.append(f.name);
      let input: HTMLInputElement | HTMLSelectElement;
      if (f.kind === 'choice') {
        input = document.createElement('select');
        for (const ch of f.choices ?? []) input.append(new Option(ch.label, ch.value, false, ch.value === f.value));
        input.addEventListener('change', () => this.set({ [f.key]: input.value }));
      } else if (f.kind === 'toggle') {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!Number(f.value);
        box.addEventListener('change', () => this.set({ [f.key]: box.checked ? 1 : 0 }));
        input = box;
      } else {
        const num = document.createElement('input');
        num.type = 'number';
        num.step = String(f.step ?? 1);
        if (f.min !== undefined) num.min = String(f.min);
        num.value = String(f.value);
        num.addEventListener('change', () => { if (num.value !== '' && Number.isFinite(Number(num.value))) this.set({ [f.key]: Number(num.value) }); });
        input = num;
      }
      // Typing in the panel must not move the character or press buttons.
      input.addEventListener('keydown', (e) => e.stopPropagation());
      label.append(input);
      this.el.append(label);
    }
    if (p.resetKeys.length) {
      const reset = document.createElement('button');
      reset.className = 'hud-btn';
      reset.textContent = 'Default values';
      reset.addEventListener('click', () => this.set(Object.fromEntries(p.resetKeys.map((k) => [k, null]))));
      this.el.append(reset);
    }
    this.el.open = open;
  }
}
