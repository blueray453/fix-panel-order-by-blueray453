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
  // Only roles that are actually placed advance the index, so skipped
  // (dead / wrong-box) roles leave no gaps.
  let index = 0;
  for (const role of desiredOrder) {
    try {
      const actor = Panel.statusArea[role]?.container;
      if (!actor || actor.get_parent() !== box)
        continue;
      box.set_child_at_index(actor, index++);
    } catch (e) {
      // Indicator's actor may have been disposed mid-reorder.
      journal(`safelyReorder: skipping role "${role}": ${e.message}`);
    }
  }
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

  for (const child of children) {
    let role = null;
    try {
      for (const r in StatusArea) {
        if (StatusArea[r] && StatusArea[r].container === child) {
          role = r;
          break;
        }
      }
    } catch (e) {
      // A StatusArea entry mid-teardown can throw; treat as unidentified.
    }
    // Children that aren't statusArea indicators (spacers, etc.) can't be
    // reordered by role, so they are not published.
    if (role && !roles.includes(role))
      roles.push(role);
  }

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

  // Skip redundant writes (and the spurious 'changed' signal).
  const current = state.settings.get_strv(keys.discovered);
  if (current.length === roles.length && current.every((r, i) => r === roles[i]))
    return;
  state.settings.set_strv(keys.discovered, roles);
}

// ---------------------------------------------------------------------------
// Child watchers.
//
// set_child_at_index() repositions existing children and does NOT fire
// child-added / child-removed, so re-applying the order from inside
// child-added cannot loop.
// ---------------------------------------------------------------------------

function connectChildWatchers() {
  for (const [boxType, keys] of Object.entries(BOX_KEYS)) {
    const box = Panel[keys.box];
    if (!box) continue;
    const addedId = box.connect('child-added', () => {
      applyOrder(boxType);
      discoverAndPublish(boxType);
    });
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
  // Clear any stale snapshot from a previous session or crash. Fresh data is
  // published once the panel settles.
  for (const keys of Object.values(BOX_KEYS)) {
    if (state.settings.get_strv(keys.discovered).length > 0)
      state.settings.set_strv(keys.discovered, []);
  }

  let attempts = 0;
  let pending = [
    ...state.settings.get_strv('order-left'),
    ...state.settings.get_strv('order-center'),
    ...state.settings.get_strv('order-right'),
  ];

  state.pollingTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
    attempts++;

    // Keep only roles that have NOT shown up yet.
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

  // Live sync when prefs writes a new order-* value.
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