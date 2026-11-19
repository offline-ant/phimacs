/** The header's ⋯ menu: actions on the shown agent, and settings. */

import { activateRow, moveListFocus } from './keyboard.js';

type HeaderMenuItem = {
  label: string;
  /** Omitted items always apply; others are left out when they cannot work for the shown agent. */
  available?(): boolean;
  danger?: boolean;
  action(): void;
};

export function setupHeaderMenu(button: HTMLElement, menu: HTMLElement, items: HeaderMenuItem[]) {
  const isOpen = () => !menu.classList.contains('hidden');
  function close() {
    menu.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
  }
  function open() {
    menu.replaceChildren(...items.filter(item => item.available?.() ?? true).map(item => {
      const row = document.createElement('div');
      row.className = `header-menu-item${item.danger ? ' danger' : ''}`;
      row.setAttribute('role', 'menuitem');
      row.tabIndex = 0;
      row.textContent = item.label;
      row.addEventListener('click', event => { event.stopPropagation(); close(); item.action(); });
      row.addEventListener('keydown', event => activateRow(event, row));
      return row;
    }));
    menu.classList.remove('hidden');
    button.setAttribute('aria-expanded', 'true');
    menu.querySelector<HTMLElement>('.header-menu-item')?.focus();
  }
  button.addEventListener('click', event => {
    event.stopPropagation();
    if (isOpen()) close();
    else open();
  });
  menu.addEventListener('keydown', event => moveListFocus(event, Array.from(menu.querySelectorAll<HTMLElement>('.header-menu-item'))));
  document.addEventListener('click', event => { if (isOpen() && !menu.contains(event.target as Node)) close(); });
  return {
    closeIfOpen() {
      if (!isOpen()) return false;
      close();
      return true;
    },
  };
}
