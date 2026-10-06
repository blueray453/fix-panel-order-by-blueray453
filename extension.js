import GLib from 'gi://GLib';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BOXES = ['left', 'center', 'right'];
const DELAY_MS = 100; // let other extensions finish positioning first

export default class FixPanelOrderExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._timeoutId = 0;
    this._signals = [];

    for (const type of BOXES) {
      const box = Main.panel[`_${type}Box`];
      for (const sig of ['child-added', 'child-removed'])
        this._signals.push([box, box.connect(sig, () => this._schedule())]);
      this._signals.push([this._settings,
      this._settings.connect(`changed::order-${type}`, () => this._sync())]);
    }
    this._schedule();
  }

  disable() {
    if (this._timeoutId)
      GLib.Source.remove(this._timeoutId);
    for (const [obj, id] of this._signals)
      obj.disconnect(id);
    this._signals = [];
    this._settings = null;
    this._timeoutId = 0;
  }

  _schedule() {
    if (this._timeoutId)
      return;
    this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DELAY_MS, () => {
      this._timeoutId = 0;
      this._sync();
      return GLib.SOURCE_REMOVE;
    });
  }

  // Reorder each box per settings, then publish what's actually present.
  // set_child_at_index() doesn't emit child-added/removed, so no loop.
  _sync() {
    const area = Main.panel.statusArea;
    const roleOf = new Map(Object.entries(area).map(([role, ind]) => [ind?.container, role]));

    for (const type of BOXES) {
      const box = Main.panel[`_${type}Box`];

      let index = 0;
      for (const role of this._settings.get_strv(`order-${type}`)) {
        const actor = area[role]?.container;
        if (actor?.get_parent() === box)
          box.set_child_at_index(actor, index++);
      }

      const roles = box.get_children().map(c => roleOf.get(c)).filter(Boolean);
      const key = `discovered-${type}`;
      if (roles.join('\n') !== this._settings.get_strv(key).join('\n'))
        this._settings.set_strv(key, roles);
    }
  }
}