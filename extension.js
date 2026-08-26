import GLib from 'gi://GLib';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
  initLogging,
  createLogger,
} from './logger.js';

const journal = createLogger(import.meta.url);

const Panel = Main.panel;
const StatusArea = Main.panel.statusArea;

const BOX_KEYS = {
  left: { box: '_leftBox', order: 'order-left', discovered: 'discovered-left' },
  center: { box: '_centerBox', order: 'order-center', discovered: 'discovered-center' },
  right: { box: '_rightBox', order: 'order-right', discovered: 'discovered-right' },
};

export default class FixPanelOrderExtension extends Extension {
  enable() {
    initLogging(this.uuid, 'both', false);
    journal(`Enabled`);

    this._settings = this.getSettings();
    this._settingsChangeIds = [];
    this._childSignalIds = []; // [{ box, addedId, removedId }]
    this._pollingTimeoutId = null;

    // Poll until every role we're actually asked to place shows up (or
    // we give up after 40 attempts) — same reasoning as the original
    // hardcoded-role polling, just driven by whatever the person has
    // saved in order-* now instead of a fixed list.
    let attempts = 0;
    let pending = [
      ...this._settings.get_strv('order-left'),
      ...this._settings.get_strv('order-center'),
      ...this._settings.get_strv('order-right'),
    ];

    this._pollingTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      attempts++;

      pending = pending.filter(role => {
        const obj = StatusArea[role];
        return !obj || !obj.container;
      });

      if (pending.length === 0 || attempts >= 40) {
        journal(`Panel settled after ${attempts} attempts`);
        this._applyAllOrders();
        this._discoverAndPublishAll();
        this._connectChildWatchers();
        this._pollingTimeoutId = null;
        return GLib.SOURCE_REMOVE;
      }

      return GLib.SOURCE_CONTINUE;
    });

    // Live sync: when prefs writes a new order-* value, dconf fires
    // 'changed' in THIS process too (it's cross-process), so the panel
    // updates immediately with no shell reload.
    for (const [boxType, keys] of Object.entries(BOX_KEYS)) {
      const id = this._settings.connect(`changed::${keys.order}`, () => this._applyOrder(boxType));
      this._settingsChangeIds.push(id);
    }
  }

  _applyAllOrders() {
    for (const boxType of Object.keys(BOX_KEYS))
      this._applyOrder(boxType);
  }

  _applyOrder(boxType) {
    const keys = BOX_KEYS[boxType];
    const box = Panel[keys.box];
    if (!box) {
      journal(`Box ${boxType} not found`);
      return;
    }
    this.safelyReorder(box, this._settings.get_strv(keys.order));
  }

  safelyReorder(box, desiredOrder) {
    desiredOrder.forEach((role, index) => {
      const indicator = Panel.statusArea[role];
      if (!indicator || !indicator.container)
        return; // Skip missing ones

      const actor = indicator.container;
      if (actor.get_parent() === box)
        box.set_child_at_index(actor, index);
    });
  }

  // ---- Discovery ----
  // prefs.js runs in a separate process with no access to Main.panel,
  // so it can't introspect the live panel itself. These methods are how
  // it learns what's actually there.
  _getRolesInBox(box) {
    const roles = [];
    box.get_children().forEach(child => {
      let role = null;
      for (const r in StatusArea) {
        if (StatusArea[r].container === child) {
          role = r;
          break;
        }
      }
      roles.push(role || 'unknown');
    });
    return roles;
  }

  _discoverAndPublishAll() {
    for (const boxType of Object.keys(BOX_KEYS))
      this._discoverAndPublish(boxType);
  }

  _discoverAndPublish(boxType) {
    const keys = BOX_KEYS[boxType];
    const box = Panel[keys.box];
    if (!box) return;
    const roles = this._getRolesInBox(box);

    // Skip redundant writes (and the spurious 'changed' signal that
    // would come with them) when nothing actually changed.
    const current = this._settings.get_strv(keys.discovered);
    if (current.length === roles.length && current.every((r, i) => r === roles[i]))
      return;
    this._settings.set_strv(keys.discovered, roles);
  }

  // Keeps discovered-* live as other extensions' indicators load in,
  // get removed, or (rarely) move — without this, prefs would only ever
  // see a one-time snapshot from startup. set_child_at_index() (used by
  // safelyReorder above) repositions existing children and does NOT
  // fire child-added/child-removed, so our own reordering never
  // triggers a spurious rediscovery here.
  _connectChildWatchers() {
    for (const [boxType, keys] of Object.entries(BOX_KEYS)) {
      const box = Panel[keys.box];
      if (!box) continue;
      const addedId = box.connect('child-added', () => this._discoverAndPublish(boxType));
      const removedId = box.connect('child-removed', () => this._discoverAndPublish(boxType));
      this._childSignalIds.push({ box, addedId, removedId });
    }
  }

  _disconnectChildWatchers() {
    for (const { box, addedId, removedId } of this._childSignalIds) {
      try { box.disconnect(addedId); } catch (e) { /* already gone */ }
      try { box.disconnect(removedId); } catch (e) { /* already gone */ }
    }
    this._childSignalIds = [];
  }

  disable() {
    journal(`Disable`);

    if (this._pollingTimeoutId) {
      GLib.Source.remove(this._pollingTimeoutId);
      this._pollingTimeoutId = null;
    }

    this._disconnectChildWatchers();

    for (const id of this._settingsChangeIds)
      this._settings.disconnect(id);
    this._settingsChangeIds = [];

    this._settings = null;
  }
}