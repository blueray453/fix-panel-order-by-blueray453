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

// Module-level, single-process state: which row is currently being
// dragged, set on drag-begin and cleared on drag-end. Every row's
// Gtk.DropTarget reads this during 'motion' to decide, synchronously,
// whether it belongs to the same box as the drag source — GTK's own
// value-based drop payload isn't available until 'drop' fires, but we
// need same-box awareness *during* the drag to draw (or withhold) the
// insertion-line indicator and show the correct pointer cursor.
let currentDrag = null; // { boxType, role, sourceList }

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
// GSettings keys. Drops are scoped to their own box two ways: the JSON
// payload is checked at 'drop' (belt), and the currentDrag boxType is
// checked at 'motion' so the wrong-box case never even shows an
// insertion indicator or accepts the drag visually (suspenders).
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
            `changed::${discoveredKey}`, () => this._mergeNewlyDiscovered());

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
        this._highlightedRow = null;

        if (roles.length === 0) {
            const empty = new Adw.ActionRow({ title: 'No indicators found here', sensitive: false });
            this.widget.append(empty);
        } else {
            const discovered = new Set(this._settings.get_strv(this._discoveredKey));
            roles.forEach(role => this._addRow(role, discovered.has(role)));
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

    _addRow(role, isPresent) {
        const row = new Adw.ActionRow({ title: role });
        row._role = role;
        row.add_prefix(new Gtk.Image({ icon_name: 'list-drag-handle-symbolic' }));

        if (!isPresent) {
            row.set_subtitle('Not currently active');
            row.add_css_class('dim-label');
        }

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
            currentDrag = { boxType: this._boxType, role: row._role, sourceList: this };
            row.add_css_class('dragging');

            // Row itself, semi-transparent, follows the pointer — makes it
            // unambiguous which indicator is actually being moved.
            const paintable = new Gtk.WidgetPaintable({ widget: row });
            source.set_icon(paintable, row.get_width() / 2, row.get_height() / 2);
        });
        dragSource.connect('drag-end', () => {
            row.remove_css_class('dragging');
            currentDrag = null;
            this._clearHighlight();
        });
        row.add_controller(dragSource);

        // ---- Drop target ----
        const dropTarget = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);

        dropTarget.connect('motion', (target, x, y) => {
            // Wrong box (or no drag in progress, e.g. a drag from outside
            // this prefs window entirely) — no indicator, reject visually.
            if (!currentDrag || currentDrag.boxType !== this._boxType) {
                this._clearHighlight();
                return 0; // Gdk.DragAction none -> "no drop" cursor here
            }
            if (currentDrag.role === row._role) {
                this._clearHighlight();
                return 0;
            }

            const before = y < row.get_allocated_height() / 2;
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

            const insertAfter = y > row.get_allocated_height() / 2;
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

    _mergeNewlyDiscovered() {
        const discovered = this._settings.get_strv(this._discoveredKey);
        const order = this._settings.get_strv(this._orderKey);
        const newRoles = discovered.filter(r => !order.includes(r));
        if (newRoles.length === 0) {
            this._rebuild(this._effectiveOrder());
            return;
        }
        this._rebuild([...order, ...newRoles]);
    }
}

export default class FixPanelOrderPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        loadCss();

        const settings = this.getSettings();
        this._lists = [];

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
            const list = new ReorderableRoleList(settings, type, orderKey, discoveredKey);
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
            currentDrag = null;
            return false;
        });
    }

    _onExportClicked(window, settings) {
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
                        left: settings.get_strv('order-left'),
                        center: settings.get_strv('order-center'),
                        right: settings.get_strv('order-right'),
                    };
                    const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
                    file.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                } catch (e) {
                    this._showErrorDialog(window, `Export failed: ${e.message}`);
                }
            }
            dialog.destroy();
        });
        dialog.show();
    }

    _onImportClicked(window, settings) {
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

                    if (!Array.isArray(data.left) || !Array.isArray(data.center) || !Array.isArray(data.right))
                        throw new Error('Expected a JSON object with "left", "center", "right" arrays');

                    settings.set_strv('order-left', data.left);
                    settings.set_strv('order-center', data.center);
                    settings.set_strv('order-right', data.right);

                    for (const list of this._lists)
                        list.refresh();
                } catch (e) {
                    this._showErrorDialog(window, `Import failed: ${e.message}`);
                }
            }
            dialog.destroy();
        });
        dialog.show();
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