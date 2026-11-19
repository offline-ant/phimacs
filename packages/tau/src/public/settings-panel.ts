// Settings sheet: theme, compaction, fullscreen and authentication toggles.

import { getCurrentTheme, themes, chooseTheme, type ThemeId } from './themes.js';
import { app } from './app-state.js';
import { rpcCommand } from './composer.js';

export const settingsPanel = document.getElementById('settings-panel')!;
export const settingsOverlay = document.getElementById('settings-overlay')!;
const themeGrid = document.getElementById('theme-grid')!;

export const toggleAutoCompact = document.getElementById('toggle-auto-compact')!;

function buildThemeGrid() {
  themeGrid.innerHTML = '';
  const current = getCurrentTheme();

  for (const [id, theme] of Object.entries(themes) as [ThemeId, (typeof themes)[ThemeId]][]) {
    const btn = document.createElement('button');
    btn.className = `theme-swatch${current === id ? ' active' : ''}`;
    const dots = (theme.colors || []).map(c =>
      `<span class="swatch-dot" style="background:${c}"></span>`
    ).join('');
    btn.innerHTML = `<span class="swatch-colors">${dots}</span>`;
    btn.addEventListener('click', () => {
      chooseTheme(id);
      themeGrid.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
    });
    themeGrid.appendChild(btn);
  }
}

export async function openSettings() {
  buildThemeGrid();
  settingsPanel.classList.remove('hidden');
  settingsOverlay.classList.remove('hidden');

  // Fetch current state for toggles. Ask Pi directly so the auto-compaction
  // toggle shows the value the viewed view's Pi process really uses.
  try {
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_state', sessionId: app.activeLiveSessionId, refresh: true }),
    });
    const data = await resp.json();
    if (data.success && data.data) {
      const s = data.data;
      if (typeof s.autoCompactionEnabled === 'boolean') {
        toggleAutoCompact.className = `settings-toggle${s.autoCompactionEnabled ? ' on' : ''}`;
      }
    }
  } catch (e) {
    // Silent
  }

  // Fetch auth state
  try {
    const authData = await rpcCommand({ type: 'get_auth' });
    if (authData?.success && authData.data?.configured) {
      authSection.style.display = '';
      toggleAuth.className = `settings-toggle${authData.data.enabled ? ' on' : ''}`;
    } else {
      authSection.style.display = 'none';
    }
  } catch {
    authSection.style.display = 'none';
  }
}

export function closeSettings() {
  settingsPanel.classList.add('hidden');
  settingsOverlay.classList.add('hidden');
}

// Auth toggle
export const toggleAuth = document.getElementById('toggle-auth')!;
const authSection = document.getElementById('settings-auth-section')!;
