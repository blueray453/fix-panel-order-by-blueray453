import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const BOXES = [
    { type: 'left', title: 'Left Box', orderKey: 'order-left', discoveredKey: 'discovered-left' },
    { type: 'center', title: 'Center Box', orderKey: 'order-center', discoveredKey: 'discovered-center' },
    { type: 'right', title: 'Right Box', orderKey: 'order-right', discoveredKey: 'discovered-right' },
];

// ---------------------------------------------------------------------------
// Module state. Reset on every fillPreferencesWindow().
// ---------------------------------------------------------------------------
const state = {
    settings: null,
    lists: [],
    // Set on drag-begin, cleared on drag-end. Lets every row's DropTarget
    // know synchronously, during 'motion', whether the drag belongs to the
    // same box.
    currentDrag: null,   // { boxType, role, sourceList }
};

function resetState(settings) {
    state.settings = settings;
    state.lists = [];
    state.currentDrag = null;
}

// ---------------------------------------------------------------------------
// CSS.
// ---------------------------------------------------------------------------

function loadCss() {
    const provider = new Gtk.CssProvider();
    provider.load_from_string(`
    row.drop-before {
      box-shadow: inset 0 2px 0 0 @accent_color;
    }
    row.drop-after {
      box-shadow: inset 0 -2px 0 0 @accent_color;
    }
    row.dragging {
      opacity: 0.4;
    }
  `);
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(),
        provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    );
}

// ==================== REORDERABLE ROLE LIST ====================
// One drag-reorderable Gtk.ListBox bound to one box's order-*/discovered-*
// keys. Only roles currently present in this box are shown. Absent roles
// (temporarily hidden indicators like network/VPN, or disabled extensions)
// stay in order-* in their original slot, so they return to the right place.
class ReorderableRoleList {
    constructor(settings, boxType, orderKey, discoveredKey) {
        this._settings = settings;
        this._boxType = boxType;
        this._orderKey = orderKey;
        this._discoveredKey = discoveredKey;
        this._highlightedRow = null;

        this.widget = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });

        this._discoveredChangedId = settings.connect(
            `changed::${discoveredKey}`, () => this.refresh());

        this.refresh();
    }

    destroy() {
        if (this._discoveredChangedId) {
            this._settings.disconnect(this._discoveredChangedId);
            this._discoveredChangedId = null;
        }
    }

    refresh() {
        this._rebuild(this._effectiveOrder());
    }

    // The order as displayed: saved order restricted to roles present in
    // THIS box right now, followed by present roles not saved yet.
    shownOrder() {
        return this._effectiveOrder();
    }

    // Saved roles that are present, plus new ones appended.
    _effectiveOrder() {
        const order = this._settings.get_strv(this._orderKey);
        const present = this._settings.get_strv(this._discoveredKey)
            .filter(r => r !== 'unknown');

        const merged = order.filter((r, i) =>
            present.includes(r) && order.indexOf(r) === i);
        for (const role of present) {
            if (!merged.includes(role))
                merged.push(role);
        }
        return merged;
    }

    // Slot-preserving save: present roles fill the slots that present roles
    // already occupy (in their new order); absent roles keep their exact
    // slot. Skipped while discovered-* is empty (before the shell has
    // published), so an unpublished snapshot never wipes the saved order.
    _persist(shown) {
        if (this._settings.get_strv(this._discoveredKey).length === 0)
            return;

        const raw = this._settings.get_strv(this._orderKey);
        // De-duplicate so slot counting stays consistent.
        const saved = raw.filter((r, i) => raw.indexOf(r) === i);

        const queue = [...shown];
        const next = [];
        for (const role of saved)
            next.push(shown.includes(role) ? queue.shift() : role);

        // Present roles that had no saved slot yet go at the end.
        next.push(...queue);

        if (JSON.stringify(next) !== JSON.stringify(raw))
            this._settings.set_strv(this._orderKey, next);
    }

    // Drop absent roles from order-* so it mirrors exactly what is shown.
    forgetInactive() {
        const shown = this._effectiveOrder();
        const saved = this._settings.get_strv(this._orderKey);
        if (JSON.stringify(shown) !== JSON.stringify(saved))
            this._settings.set_strv(this._orderKey, shown);
    }

    _rebuild(roles) {
        let child = this.widget.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this.widget.remove(child);
            child = next;
        }
        this._highlightedRow = null;

        if (roles.length === 0) {
            const empty = new Adw.ActionRow({ title: 'No indicators found here', sensitive: false });
            this.widget.append(empty);
        } else {
            roles.forEach(role => this._addRow(role));
        }

        this._persist(roles);
    }

    _clearHighlight() {
        if (this._highlightedRow) {
            this._highlightedRow.remove_css_class('drop-before');
            this._highlightedRow.remove_css_class('drop-after');
            this._highlightedRow = null;
        }
    }

    _setHighlight(row, before) {
        if (this._highlightedRow && this._highlightedRow !== row)
            this._clearHighlight();
        row.remove_css_class(before ? 'drop-after' : 'drop-before');
        row.add_css_class(before ? 'drop-before' : 'drop-after');
        this._highlightedRow = row;
    }

    _addRow(role) {
        const row = new Adw.ActionRow({ title: role });
        row._role = role;
        row.add_prefix(new Gtk.Image({ icon_name: 'list-drag-handle-symbolic' }));

        // ---- Drag source ----
        const dragSource = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
        dragSource.connect('prepare', () => {
            const payload = JSON.stringify({ boxType: this._boxType, role: row._role });
            const value = new GObject.Value();
            value.init(GObject.TYPE_STRING);
            value.set_string(payload);
            return Gdk.ContentProvider.new_for_value(value);
        });
        dragSource.connect('drag-begin', (source, drag) => {
            state.currentDrag = { boxType: this._boxType, role: row._role, sourceList: this };
            row.add_css_class('dragging');

            const paintable = new Gtk.WidgetPaintable({ widget: row });
            source.set_icon(paintable, row.get_width() / 2, row.get_height() / 2);
        });
        dragSource.connect('drag-end', () => {
            row.remove_css_class('dragging');
            state.currentDrag = null;
            this._clearHighlight();
        });
        row.add_controller(dragSource);

        // ---- Drop target ----
        const dropTarget = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);

        dropTarget.connect('motion', (target, x, y) => {
            if (!state.currentDrag || state.currentDrag.boxType !== this._boxType) {
                this._clearHighlight();
                return 0;
            }
            if (state.currentDrag.role === row._role) {
                this._clearHighlight();
                return 0;
            }

            const before = y < row.get_height() / 2;
            this._setHighlight(row, before);
            return Gdk.DragAction.MOVE;
        });

        dropTarget.connect('leave', () => {
            if (this._highlightedRow === row)
                this._clearHighlight();
        });

        dropTarget.connect('drop', (target, payloadStr, x, y) => {
            this._clearHighlight();

            let payload;
            try {
                payload = JSON.parse(payloadStr);
            } catch (e) {
                return false;
            }
            if (!payload || typeof payload.role !== 'string' || typeof payload.boxType !== 'string')
                return false;
            if (payload.boxType !== this._boxType)
                return false;
            if (payload.role === row._role)
                return false;

            const insertAfter = y > row.get_height() / 2;
            this._moveRole(payload.role, row._role, insertAfter);
            return true;
        });

        row.add_controller(dropTarget);

        this.widget.append(row);
    }

    _moveRole(draggedRole, targetRole, insertAfter) {
        const order = this._effectiveOrder().filter(r => r !== draggedRole);
        let idx = order.indexOf(targetRole);
        if (idx === -1)
            idx = order.length;
        else if (insertAfter)
            idx += 1;
        order.splice(idx, 0, draggedRole);
        this._rebuild(order);
    }
}

// ---------------------------------------------------------------------------
// Import / export.
// ---------------------------------------------------------------------------

// Export only roles that are currently present, so absent/disabled roles
// don't leak into the file. Falls back to the saved order if the shell
// hasn't published a snapshot yet.
function exportOrderFor(orderKey, discoveredKey) {
    const order = state.settings.get_strv(orderKey);
    const present = new Set(state.settings.get_strv(discoveredKey));
    if (present.size === 0)
        return order;
    return order.filter(r => present.has(r));
}

function onExportClicked(window) {
    const dialog = new Gtk.FileChooserNative({
        title: 'Export Panel Order',
        transient_for: window,
        action: Gtk.FileChooserAction.SAVE,
        accept_label: '_Save',
        cancel_label: '_Cancel',
    });
    dialog.set_current_name('panel-order.json');

    const filter = new Gtk.FileFilter();
    filter.set_name('JSON files');
    filter.add_pattern('*.json');
    dialog.add_filter(filter);

    dialog.connect('response', (self, id) => {
        if (id === Gtk.ResponseType.ACCEPT) {
            try {
                const file = dialog.get_file();
                const data = {
                    left: exportOrderFor('order-left', 'discovered-left'),
                    center: exportOrderFor('order-center', 'discovered-center'),
                    right: exportOrderFor('order-right', 'discovered-right'),
                };
                const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
                file.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            } catch (e) {
                showErrorDialog(window, `Export failed: ${e.message}`);
            }
        }
        dialog.destroy();
    });
    dialog.show();
}

function onImportClicked(window) {
    const dialog = new Gtk.FileChooserNative({
        title: 'Import Panel Order',
        transient_for: window,
        action: Gtk.FileChooserAction.OPEN,
        accept_label: '_Open',
        cancel_label: '_Cancel',
    });

    const filter = new Gtk.FileFilter();
    filter.set_name('JSON files');
    filter.add_pattern('*.json');
    dialog.add_filter(filter);

    dialog.connect('response', (self, id) => {
        if (id === Gtk.ResponseType.ACCEPT) {
            try {
                const file = dialog.get_file();
                const [, contents] = file.load_contents(null);
                const data = JSON.parse(new TextDecoder().decode(contents));

                const valid = a => Array.isArray(a) && a.every(r => typeof r === 'string');
                if (!valid(data.left) || !valid(data.center) || !valid(data.right))
                    throw new Error('Expected a JSON object with "left", "center", "right" arrays of strings');

                state.settings.set_strv('order-left', data.left);
                state.settings.set_strv('order-center', data.center);
                state.settings.set_strv('order-right', data.right);

                for (const list of state.lists)
                    list.refresh();
            } catch (e) {
                showErrorDialog(window, `Import failed: ${e.message}`);
            }
        }
        dialog.destroy();
    });
    dialog.show();
}

function showErrorDialog(window, message) {
    const dialog = new Adw.AlertDialog({
        heading: 'Panel Order',
        body: message,
    });
    dialog.add_response('ok', 'OK');
    dialog.present(window);
}

// ---------------------------------------------------------------------------
// Page construction.
// ---------------------------------------------------------------------------

function buildPage(window) {
    const page = new Adw.PreferencesPage({
        title: 'Panel Order',
        icon_name: 'view-list-symbolic',
    });
    window.add(page);

    const introGroup = new Adw.PreferencesGroup({
        description: 'Drag indicators to reorder them within a box. Indicators can\'t be dragged between boxes. Changes apply to the panel immediately.',
    });
    page.add(introGroup);

    for (const { type, title, orderKey, discoveredKey } of BOXES) {
        const group = new Adw.PreferencesGroup({ title });
        const list = new ReorderableRoleList(state.settings, type, orderKey, discoveredKey);
        state.lists.push(list);
        group.add(list.widget);
        page.add(group);
    }

    // ---- Import / Export / Forget ----
    const ioGroup = new Adw.PreferencesGroup({
        title: 'Backup',
        description: 'Save or load the order of all three boxes as a JSON file. "Forget inactive" removes saved positions of indicators that are not currently in the panel.',
    });
    page.add(ioGroup);

    const ioRow = new Adw.ActionRow({ title: 'Panel order file' });

    const exportBtn = new Gtk.Button({ label: 'Export…', valign: Gtk.Align.CENTER });
    exportBtn.connect('clicked', () => onExportClicked(window));
    ioRow.add_suffix(exportBtn);

    const importBtn = new Gtk.Button({ label: 'Import…', valign: Gtk.Align.CENTER });
    importBtn.connect('clicked', () => onImportClicked(window));
    ioRow.add_suffix(importBtn);

    const cleanBtn = new Gtk.Button({ label: 'Forget inactive', valign: Gtk.Align.CENTER });
    cleanBtn.connect('clicked', () => {
        // Don't wipe everything if the shell hasn't published yet.
        if (!state.lists.some(l => l.shownOrder().length > 0))
            return;
        for (const list of state.lists)
            list.forgetInactive();
    });
    ioRow.add_suffix(cleanBtn);

    ioGroup.add(ioRow);

    window.connect('close-request', () => {
        for (const list of state.lists)
            list.destroy();
        state.lists = [];
        state.currentDrag = null;
        return false;
    });
}

// ---------------------------------------------------------------------------
// Preferences entry point.
// ---------------------------------------------------------------------------

export default class FixPanelOrderPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        loadCss();
        resetState(this.getSettings());
        buildPage(window);
    }
}