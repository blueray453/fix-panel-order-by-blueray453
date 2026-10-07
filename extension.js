import Clutter from 'gi://Clutter';
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

    this._modePanel = null;
    this._origPanelLayout = null;
    this._origFindDraggable = null;
    this._lastWrapTime = 0;

    // Move panel to bottom
    this._movePanelPosition(true);

    // Rearrange indicators (Activities is removed from the layout entirely;
    // _updatePanel() keeps indicators that are not listed hidden).
    this._moveIndicators(true);

    // Stop the panel from starting a window-move grab on press.
    this._disablePanelWindowDrag(true);

    // Scroll on panel to change workspace (wraps around at the ends)
    Main.panel.connectObject('scroll-event',
      (_actor, event) => this._handleScroll(event), this);

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

    Main.panel.disconnectObject(this);

    // Move panel back to top
    this._movePanelPosition(false);

    // Restore the stock panel layout; _updatePanel() shows Activities again.
    this._moveIndicators(false);

    this._disablePanelWindowDrag(false);
  }

  // ---------------------------------------------------------------------
  // Workspace scroll: stock behaviour, with wrap-around at the ends
  // ---------------------------------------------------------------------
  _handleScroll(event) {
    const wm = Main.wm;
    const workspaceManager = global.workspace_manager;

    if (event.type() !== Clutter.EventType.SCROLL)
      return wm.handleWorkspaceScroll(event);

    let step;
    switch (event.get_scroll_direction()) {
      case Clutter.ScrollDirection.UP:
      case Clutter.ScrollDirection.LEFT:
        step = -1;
        break;
      case Clutter.ScrollDirection.DOWN:
      case Clutter.ScrollDirection.RIGHT:
        step = 1;
        break;
      default:
        return wm.handleWorkspaceScroll(event);
    }

    const n = workspaceManager.get_n_workspaces();
    const idx = workspaceManager.get_active_workspace_index();
    const now = GLib.get_monotonic_time() / 1000; // ms

    const atEdge = n > 1 &&
      ((step > 0 && idx === n - 1) || (step < 0 && idx === 0));

    // Normal case: let GNOME handle it, unless we just wrapped.
    if (!atEdge) {
      if (now - this._lastWrapTime < 150)
        return Clutter.EVENT_STOP;
      return wm.handleWorkspaceScroll(event);
    }

    // Edge case: skip if stock just moved us here or we just wrapped,
    // so one flick doesn't chain moves together.
    if (!wm._canScroll || now - this._lastWrapTime < 150)
      return Clutter.EVENT_STOP;

    this._lastWrapTime = now;
    const target = step > 0 ? 0 : n - 1;   // last -> first, first -> last
    wm.actionMoveWorkspace(workspaceManager.get_workspace_by_index(target));

    return Clutter.EVENT_STOP;
  }

  // ---------------------------------------------------------------------
  // Panel position
  // ---------------------------------------------------------------------
  _placePanel() {
    const { panelBox, primaryMonitor: m } = Main.layoutManager;
    if (!m) return;
    panelBox.set_position(m.x, m.y + m.height - panelBox.height);
  }

  _movePanelPosition(active) {
    const lm = Main.layoutManager;
    if (active) {
      this._placePanel();
      // LayoutManager resets panelBox to the top on monitor changes, so
      // reapply our position whenever that happens or the height changes.
      lm.connectObject('monitors-changed', () => this._placePanel(), this);
      lm.panelBox.connectObject('notify::height', () => this._placePanel(), this);
    } else {
      lm.disconnectObject(this);
      lm.panelBox.disconnectObject(this);
      const m = lm.primaryMonitor;
      if (m) lm.panelBox.set_position(m.x, m.y);
    }
  }

  // ---------------------------------------------------------------------
  // Activities / date placement
  //
  // Panel._updatePanel() hides every indicator container and then shows
  // only those listed in the session mode layout, so removing 'activities'
  // from the layout is enough to keep it hidden. Restoring the layout
  // brings it back.
  // ---------------------------------------------------------------------
  _moveIndicators(active) {
    if (active) {
      if (this._modePanel) return;

      // Keep a reference to the exact object we modify, so disable() restores
      // it even if the session mode has changed in the meantime.
      const panel = Main.sessionMode.panel;
      this._modePanel = panel;
      this._origPanelLayout = {
        left: [...panel.left],
        center: [...panel.center],
        right: [...panel.right],
      };

      const drop = new Set(['activities', 'dateMenu']);
      panel.left = panel.left.filter(i => !drop.has(i));
      panel.center = panel.center.filter(i => !drop.has(i));
      panel.right = ['dateMenu', ...panel.right.filter(i => !drop.has(i))];
    } else if (this._modePanel) {
      Object.assign(this._modePanel, this._origPanelLayout);
      this._modePanel = null;
      this._origPanelLayout = null;
    }

    Main.panel._updatePanel();
  }

  // ---------------------------------------------------------------------
  // Disable the panel's "drag maximized window" behaviour.
  //
  // The panel's click gesture (recognize_on_press) calls
  // _getDraggableWindowForPosition() when pressed and returns early if it
  // finds no window. Returning null means no move grab is ever started.
  // ---------------------------------------------------------------------
  _disablePanelWindowDrag(active) {
    const panel = Main.panel;
    if (active) {
      if (this._origFindDraggable) return;
      this._origFindDraggable = panel._getDraggableWindowForPosition;
      panel._getDraggableWindowForPosition = () => null;
    } else if (this._origFindDraggable) {
      panel._getDraggableWindowForPosition = this._origFindDraggable;
      this._origFindDraggable = null;
    }
  }

  // ---------------------------------------------------------------------
  // Panel order (per settings)
  // ---------------------------------------------------------------------
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