import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Gtk.FileDialog's save()/open() are async-callback style in the GI
// binding; promisify so we can await them below.
Gio._promisify(Gtk.FileDialog.prototype, 'save', 'save_finish');
Gio._promisify(Gtk.FileDialog.prototype, 'open', 'open_finish');

const BOXES = [
    { type: 'left', title: 'Left Box', orderKey: 'order-left', discoveredKey: 'discovered-left' },
    { type: 'center', title: 'Center Box', orderKey: 'order-center', discoveredKey: 'discovered-center' },
    { type: 'right', title: 'Right Box', orderKey: 'order-right', discoveredKey: 'discovered-right' },
];

// ==================== REORDERABLE ROLE LIST ====================
// One drag-reorderable Gtk.ListBox bound to one box's order-*/discovered-*
// GSettings keys. Every drop writes the full new order straight back to
// order-* — the running extension picks that up live via dconf.
class ReorderableRoleList {
    constructor(settings, orderKey, discoveredKey) {
        this._settings = settings;
        this._orderKey = orderKey;
        this._discoveredKey = discoveredKey;

        this.widget = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });

        this._discoveredChangedId = settings.connect(
            `changed::${discoveredKey}`, () => this._mergeNewlyDiscovered());

        this.refresh();
    }

    destroy() {
        if (this._discoveredChangedId) {
            this._settings.disconnect(this._discoveredChangedId);
            this._discoveredChangedId = null;
        }
    }

    // Public: called after an import, or any time the caller wants the
    // widget to reflect whatever is currently in GSettings.
    refresh() {
        this._rebuild(this._effectiveOrder());
    }

    // order-* entries first (in the person's saved order), then any
    // discovered role not yet listed, appended at the end. This becomes
    // both what's shown AND what's saved — so simply opening prefs for
    // the first time captures every indicator currently in the box, not
    // just the ones this extension originally hardcoded.
    _effectiveOrder() {
        const order = this._settings.get_strv(this._orderKey);
        const discovered = this._settings.get_strv(this._discoveredKey);
        const merged = [...order];
        for (const role of discovered) {
            if (!merged.includes(role))
                merged.push(role);
        }
        return merged;
    }

    _persist(order) {
        this._settings.set_strv(this._orderKey, order);
    }

    _rebuild(roles) {
        let child = this.widget.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this.widget.remove(child);
            child = next;
        }

        if (roles.length === 0) {
            const empty = new Adw.ActionRow({ title: 'No indicators found here', sensitive: false });
            this.widget.append(empty);
        } else {
            roles.forEach(role => this._addRow(role));
        }

        // Keep order-* in sync with whatever's actually displayed —
        // guarantees "current indicators" (including ones never explicitly
        // saved before) survive a shell restart in their current position.
        this._persist(roles);
    }

    _addRow(role) {
        const row = new Adw.ActionRow({ title: role });
        row._role = role;
        row.add_prefix(new Gtk.Image({ icon_name: 'list-drag-handle-symbolic' }));

        const dragSource = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
        dragSource.connect('prepare', () => {
            const value = new GObject.Value();
            value.init(GObject.TYPE_STRING);
            value.set_string(row._role);
            return Gdk.ContentProvider.new_for_value(value);
        });
        dragSource.connect('drag-begin', () => row.add_css_class('dragging'));
        dragSource.connect('drag-end', () => row.remove_css_class('dragging'));
        row.add_controller(dragSource);

        const dropTarget = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
        dropTarget.connect('drop', (target, draggedRole, x, y) => {
            if (draggedRole === row._role)
                return false;
            const insertAfter = y > row.get_allocated_height() / 2;
            this._moveRole(draggedRole, row._role, insertAfter);
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

    // A new indicator appeared (or one vanished) while prefs is open.
    // Only append genuinely new roles — don't disturb the person's
    // current row order/scroll position for something that isn't new.
    _mergeNewlyDiscovered() {
        const discovered = this._settings.get_strv(this._discoveredKey);
        const order = this._settings.get_strv(this._orderKey);
        const newRoles = discovered.filter(r => !order.includes(r));
        if (newRoles.length === 0)
            return;
        this._rebuild([...order, ...newRoles]);
    }
}

export default class FixPanelOrderPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        this._lists = [];

        const page = new Adw.PreferencesPage({
            title: 'Panel Order',
            icon_name: 'view-list-symbolic',
        });
        window.add(page);

        const introGroup = new Adw.PreferencesGroup({
            description: 'Drag indicators to reorder them within a box. Changes apply to the panel immediately.',
        });
        page.add(introGroup);

        for (const { type, title, orderKey, discoveredKey } of BOXES) {
            const group = new Adw.PreferencesGroup({ title });
            const list = new ReorderableRoleList(settings, orderKey, discoveredKey);
            this._lists.push(list);
            group.add(list.widget);
            page.add(group);
        }

        // ---- Import / Export ----
        const ioGroup = new Adw.PreferencesGroup({
            title: 'Backup',
            description: 'Save or load the order of all three boxes as a JSON file',
        });
        page.add(ioGroup);

        const ioRow = new Adw.ActionRow({ title: 'Panel order file' });

        const exportBtn = new Gtk.Button({ label: 'Export…', valign: Gtk.Align.CENTER });
        exportBtn.connect('clicked', () => this._onExportClicked(window, settings));
        ioRow.add_suffix(exportBtn);

        const importBtn = new Gtk.Button({ label: 'Import…', valign: Gtk.Align.CENTER });
        importBtn.connect('clicked', () => this._onImportClicked(window, settings));
        ioRow.add_suffix(importBtn);

        ioGroup.add(ioRow);

        window.connect('close-request', () => {
            for (const list of this._lists)
                list.destroy();
            this._lists = [];
            return false;
        });
    }

    async _onExportClicked(window, settings) {
        const dialog = new Gtk.FileDialog({
            title: 'Export Panel Order',
            initial_name: 'panel-order.json',
        });
        try {
            const file = await dialog.save(window, null);
            const data = {
                left: settings.get_strv('order-left'),
                center: settings.get_strv('order-center'),
                right: settings.get_strv('order-right'),
            };
            const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
            file.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            if (e.matches && e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                return; // person just closed the dialog — not an error
            this._showErrorDialog(window, `Export failed: ${e.message}`);
        }
    }

    async _onImportClicked(window, settings) {
        const dialog = new Gtk.FileDialog({ title: 'Import Panel Order' });
        const filter = new Gtk.FileFilter({ name: 'JSON files' });
        filter.add_pattern('*.json');
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype });
        filters.append(filter);
        dialog.set_filters(filters);

        try {
            const file = await dialog.open(window, null);
            const [, contents] = file.load_contents(null);
            const data = JSON.parse(new TextDecoder().decode(contents));

            if (!Array.isArray(data.left) || !Array.isArray(data.center) || !Array.isArray(data.right))
                throw new Error('Expected a JSON object with "left", "center", "right" arrays');

            settings.set_strv('order-left', data.left);
            settings.set_strv('order-center', data.center);
            settings.set_strv('order-right', data.right);

            for (const list of this._lists)
                list.refresh();
        } catch (e) {
            if (e.matches && e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                return;
            this._showErrorDialog(window, `Import failed: ${e.message}`);
        }
    }

    _showErrorDialog(window, message) {
        const dialog = new Adw.AlertDialog({
            heading: 'Panel Order',
            body: message,
        });
        dialog.add_response('ok', 'OK');
        dialog.present(window);
    }
}