import GLib from 'gi://GLib';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { initLogging, createLogger } from './logger.js';

const journal = createLogger(import.meta.url);

const Panel = Main.panel;
const StatusArea = Main.panel.statusArea;

const BOX_KEYS = {
  left: { box: '_leftBox', order: 'order-left', discovered: 'discovered-left' },
  center: { box: '_centerBox', order: 'order-center', discovered: 'discovered-center' },
  right: { box: '_rightBox', order: 'order-right', discovered: 'discovered-right' },
};

// ---------------------------------------------------------------------------
// Module state.
//
// Everything the extension tracks at runtime lives here, not on the Extension
// instance. The logic below is plain functions reading and writing this
// object, so there is exactly one place to look for "what state does this
// extension keep".
// ---------------------------------------------------------------------------
const state = {
  settings: null,
  settingsChangeIds: [],
  childSignalIds: [],    // [{ box, addedId, removedId }]
  pollingTimeoutId: 0,
};

function resetState() {
  state.settings = null;
  state.settingsChangeIds = [];
  state.childSignalIds = [];
  state.pollingTimeoutId = 0;
}

// ---------------------------------------------------------------------------
// Panel reordering.
// ---------------------------------------------------------------------------

function applyAllOrders() {
  for (const boxType of Object.keys(BOX_KEYS))
    applyOrder(boxType);
}

function applyOrder(boxType) {
  const keys = BOX_KEYS[boxType];
  const box = Panel[keys.box];
  if (!box) {
    journal(`Box ${boxType} not found`);
    return;
  }
  safelyReorder(box, state.settings.get_strv(keys.order));
}

function safelyReorder(box, desiredOrder) {
  desiredOrder.forEach((role, index) => {
    try {
      const indicator = Panel.statusArea[role];
      if (!indicator || !indicator.container)
        return;
      const actor = indicator.container;
      if (actor.get_parent() === box)
        box.set_child_at_index(actor, index);
    } catch (e) {
      // Indicator's actor may have been disposed between the null-check
      // above and here (e.g. its extension was disabled mid-reorder).
      // Skip it — one broken role shouldn't stop the rest from applying.
      journal(`safelyReorder: skipping role "${role}": ${e.message}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Discovery.
// ---------------------------------------------------------------------------

function getRolesInBox(box) {
  const roles = [];
  let children;
  try {
    children = box.get_children();
  } catch (e) {
    journal(`getRolesInBox: box unavailable: ${e.message}`);
    return roles;
  }

  children.forEach(child => {
    let role = null;
    try {
      for (const r in StatusArea) {
        if (StatusArea[r] && StatusArea[r].container === child) {
          role = r;
          break;
        }
      }
    } catch (e) {
      // A StatusArea entry mid-teardown can throw on property access —
      // treat it the same as "couldn't identify this child".
    }
    roles.push(role || 'unknown');
  });

  return roles;
}

function discoverAndPublishAll() {
  for (const boxType of Object.keys(BOX_KEYS))
    discoverAndPublish(boxType);
}

function discoverAndPublish(boxType) {
  const keys = BOX_KEYS[boxType];
  const box = Panel[keys.box];
  if (!box) return;
  const roles = getRolesInBox(box);

  // Skip redundant writes (and the spurious 'changed' signal that would
  // come with them) when nothing actually changed.
  const current = state.settings.get_strv(keys.discovered);
  if (current.length === roles.length && current.every((r, i) => r === roles[i]))
    return;
  state.settings.set_strv(keys.discovered, roles);
}

// ---------------------------------------------------------------------------
// Child watchers.
//
// Keeps discovered-* live as other extensions' indicators load in, get
// removed, or (rarely) move — without this, prefs would only ever see a
// one-time snapshot from startup. set_child_at_index() (used by
// safelyReorder above) repositions existing children and does NOT fire
// child-added/child-removed, so our own reordering never triggers a
// spurious rediscovery here.
// ---------------------------------------------------------------------------

function connectChildWatchers() {
  for (const [boxType, keys] of Object.entries(BOX_KEYS)) {
    const box = Panel[keys.box];
    if (!box) continue;
    const addedId = box.connect('child-added', () => discoverAndPublish(boxType));
    const removedId = box.connect('child-removed', () => discoverAndPublish(boxType));
    state.childSignalIds.push({ box, addedId, removedId });
  }
}

function disconnectChildWatchers() {
  for (const { box, addedId, removedId } of state.childSignalIds) {
    try { box.disconnect(addedId); } catch (e) { /* already gone */ }
    try { box.disconnect(removedId); } catch (e) { /* already gone */ }
  }
  state.childSignalIds = [];
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

function setup() {
  // Poll until every role we're actually asked to place shows up (or we
  // give up after 40 attempts) — driven by whatever the person has saved
  // in order-* now instead of a fixed list of roles.
  let attempts = 0;
  let pending = [
    ...state.settings.get_strv('order-left'),
    ...state.settings.get_strv('order-center'),
    ...state.settings.get_strv('order-right'),
  ];

  state.pollingTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
    attempts++;

    pending = pending.filter(role => {
      const obj = StatusArea[role];
      return !obj || !obj.container;
    });

    if (pending.length === 0 || attempts >= 40) {
      journal(`Panel settled after ${attempts} attempts`);
      applyAllOrders();
      discoverAndPublishAll();
      connectChildWatchers();
      state.pollingTimeoutId = 0;
      return GLib.SOURCE_REMOVE;
    }

    return GLib.SOURCE_CONTINUE;
  });

  // Live sync: when prefs writes a new order-* value, dconf fires
  // 'changed' in THIS process too (it's cross-process), so the panel
  // updates immediately with no shell reload.
  for (const [boxType, keys] of Object.entries(BOX_KEYS)) {
    const id = state.settings.connect(`changed::${keys.order}`, () => applyOrder(boxType));
    state.settingsChangeIds.push(id);
  }
}

function teardown() {
  if (state.pollingTimeoutId) {
    GLib.Source.remove(state.pollingTimeoutId);
    state.pollingTimeoutId = 0;
  }

  disconnectChildWatchers();

  for (const id of state.settingsChangeIds)
    state.settings.disconnect(id);
  state.settingsChangeIds = [];
}

// ---------------------------------------------------------------------------
// Extension entry point.
//
// This class exists only because GNOME Shell requires an Extension subclass
// and because enable/disable hooks and the settings object come from it. All
// the real work is done by the module-level functions above.
// ---------------------------------------------------------------------------

export default class FixPanelOrderExtension extends Extension {
  enable() {
    initLogging(this.uuid, 'both', false);
    journal(`Enabled`);

    resetState();
    state.settings = this.getSettings();

    setup();
  }

  disable() {
    journal(`Disable`);
    teardown();
    state.settings = null;
  }
}