export type PickerOption = { value: string; label: string };

const CARET = `<svg class="picker-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5L6 8l3-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHECK = `<svg class="picker-check-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 6.2L4.8 8.7 9.8 3.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function withAllOption(
  values: string[],
  labelFor: (value: string) => string = (value) => value,
): PickerOption[] {
  return [{ value: '', label: '全部' }, ...values.map((value) => ({ value, label: labelFor(value) }))];
}

export function pickerLabel(options: PickerOption[], selected: string): string {
  return options.find((option) => option.value === selected)?.label ?? options[0]?.label ?? '';
}

export function pickerMarkup(
  id: string,
  options: PickerOption[],
  selected: string,
  extraClass = '',
): string {
  const label = pickerLabel(options, selected);
  const items = options
    .map((option) => {
      const on = option.value === selected;
      return `<button type="button" role="option" class="picker-option" data-value="${esc(option.value)}" aria-selected="${on ? 'true' : 'false'}">
        <span class="picker-check">${CHECK}</span>
        <span class="picker-option-label">${esc(option.label)}</span>
      </button>`;
    })
    .join('');
  return `<div class="picker${extraClass ? ` ${extraClass}` : ''}" id="${esc(id)}" data-value="${esc(selected)}">
    <button type="button" class="picker-toggle" aria-haspopup="listbox" aria-expanded="false">
      <span class="picker-label">${esc(label)}</span>
      ${CARET}
    </button>
    <div class="picker-menu" role="listbox" data-owner="${esc(id)}" hidden>${items}</div>
  </div>`;
}

function pickerMenu(picker: Element): HTMLElement | null {
  const id = picker.id;
  return (
    document.querySelector<HTMLElement>(`.picker-menu[data-owner="${CSS.escape(id)}"]`) ??
    picker.querySelector<HTMLElement>('.picker-menu')
  );
}

function closePicker(picker: Element) {
  picker.classList.remove('open');
  picker.querySelector('.picker-toggle')?.setAttribute('aria-expanded', 'false');
  const menu = pickerMenu(picker);
  if (!menu) return;
  menu.hidden = true;
  picker.appendChild(menu);
}

export function closeAllPickers(except?: Element) {
  document.querySelectorAll('.picker.open').forEach((picker) => {
    if (picker !== except) closePicker(picker);
  });
}

function positionMenu(toggle: HTMLElement, menu: HTMLElement) {
  const rect = toggle.getBoundingClientRect();
  menu.style.minWidth = `${Math.max(rect.width, 168)}px`;
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  const box = menu.getBoundingClientRect();
  if (box.right > window.innerWidth - 8) {
    menu.style.left = `${Math.max(8, window.innerWidth - box.width - 8)}px`;
  }
  if (box.bottom > window.innerHeight - 8) {
    menu.style.top = `${Math.max(8, rect.top - box.height - 4)}px`;
  }
}

let documentBound = false;

function ensureDocumentListeners() {
  if (documentBound || typeof document === 'undefined') return;
  documentBound = true;
  document.addEventListener('pointerdown', (event) => {
    const target = event.target as Node | null;
    document.querySelectorAll('.picker.open').forEach((picker) => {
      const menu = pickerMenu(picker);
      if (target && (picker.contains(target) || menu?.contains(target))) return;
      closePicker(picker);
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAllPickers();
  });
  window.addEventListener('resize', () => closeAllPickers());
  document.addEventListener('scroll', () => closeAllPickers(), true);
}

export function bindPickers(root: ParentNode, onChange: (id: string, value: string) => void) {
  ensureDocumentListeners();
  root.querySelectorAll<HTMLElement>('.picker').forEach((picker) => {
    const toggle = picker.querySelector<HTMLButtonElement>('.picker-toggle');
    toggle?.addEventListener('click', (event) => {
      event.stopPropagation();
      const willOpen = !picker.classList.contains('open');
      closeAllPickers();
      if (!willOpen) return;
      picker.classList.add('open');
      toggle.setAttribute('aria-expanded', 'true');
      const menu = picker.querySelector<HTMLElement>('.picker-menu');
      if (menu) {
        menu.hidden = false;
        document.body.appendChild(menu);
        positionMenu(toggle, menu);
      }
    });
    picker.querySelectorAll<HTMLButtonElement>('.picker-option').forEach((option) => {
      option.addEventListener('click', (event) => {
        event.stopPropagation();
        const value = option.dataset.value ?? '';
        picker.dataset.value = value;
        picker.querySelectorAll<HTMLButtonElement>('.picker-option').forEach((item) => {
          item.setAttribute('aria-selected', item === option ? 'true' : 'false');
        });
        const label = picker.querySelector('.picker-label');
        const text = option.querySelector('.picker-option-label')?.textContent ?? '';
        if (label) label.textContent = text;
        closePicker(picker);
        onChange(picker.id, value);
      });
    });
  });
}
