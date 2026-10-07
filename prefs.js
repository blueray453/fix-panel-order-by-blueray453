import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const BOXES = [['left', 'Left Box'], ['center', 'Center Box'], ['right', 'Right Box']];

export default class FixPanelOrderPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({ title: 'Panel Order', icon_name: 'view-list-symbolic' });
        window.add(page);

        const css = new Gtk.CssProvider();
        css.load_from_string(`
      row.drop-before { box-shadow: inset 0 2px 0 0 @accent_color; }
      row.drop-after  { box-shadow: inset 0 -2px 0 0 @accent_color; }
      row.dragging    { opacity: 0.4; }
    `);
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        let dragged = null; // {type, role}; lets each list reject drags from other boxes
        const cleanups = [];

        for (const [type, title] of BOXES) {
            const orderKey = `order-${type}`;
            const discKey = `discovered-${type}`;
            const group = new Adw.PreferencesGroup({ title });
            const list = new Gtk.ListBox({
                selection_mode: Gtk.SelectionMode.NONE,
                css_classes: ['boxed-list'],
            });
            group.add(list);
            page.add(group);

            // Saved order restricted to present roles, then present-but-unsaved ones.
            const shownOrder = () => {
                const present = settings.get_strv(discKey);
                const saved = settings.get_strv(orderKey).filter(r => present.includes(r));
                return [...new Set([...saved, ...present])];
            };

            // Present roles refill the slots present roles occupy; absent roles keep theirs.
            const persist = shown => {
                if (settings.get_strv(discKey).length === 0)
                    return;
                const raw = settings.get_strv(orderKey);
                const queue = [...shown];
                const next = [...new Set(raw)].map(r => shown.includes(r) ? queue.shift() : r).concat(queue);
                if (next.join('\n') !== raw.join('\n'))
                    settings.set_strv(orderKey, next);
            };

            // ---- Drop highlight ----
            let marked = null;
            const clearMark = () => {
                marked?.remove_css_class('drop-before');
                marked?.remove_css_class('drop-after');
                marked = null;
            };

            // Row under y and whether the pointer is in its lower half.
            // Below the last row counts as "after the last row".
            const locate = y => {
                const row = list.get_row_at_y(y);
                if (row)
                    return { row, after: y > row.get_allocation().y + row.get_height() / 2 };
                const last = list.get_last_child();
                return { row: last, after: true };
            };

            const valid = row => dragged?.type === type && row?._role && row._role !== dragged.role;

            // ---- Single drop target for the whole list ----
            const drop = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
            drop.connect('motion', (_t, _x, y) => {
                const { row, after } = locate(y);
                clearMark();
                if (!valid(row))
                    return 0;
                row.add_css_class(after ? 'drop-after' : 'drop-before');
                marked = row;
                return Gdk.DragAction.MOVE;
            });
            drop.connect('leave', clearMark);
            drop.connect('drop', (_t, _value, _x, y) => {
                clearMark();
                const { row, after } = locate(y);
                if (!valid(row))
                    return false;
                const shown = shownOrder().filter(r => r !== dragged.role);
                shown.splice(shown.indexOf(row._role) + (after ? 1 : 0), 0, dragged.role);
                persist(shown);
                rebuild(shown);
                return true;
            });
            list.add_controller(drop);

            // ---- Rows ----
            const addRow = role => {
                const row = new Adw.ActionRow({ title: role });
                row._role = role;
                row.add_prefix(new Gtk.Image({ icon_name: 'list-drag-handle-symbolic' }));

                const source = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
                source.connect('prepare', () => {
                    const value = new GObject.Value();
                    value.init(GObject.TYPE_STRING);
                    value.set_string(role);
                    return Gdk.ContentProvider.new_for_value(value);
                });
                source.connect('drag-begin', src => {
                    dragged = { type, role };
                    row.add_css_class('dragging');
                    src.set_icon(new Gtk.WidgetPaintable({ widget: row }),
                        row.get_width() / 2, row.get_height() / 2);
                });
                source.connect('drag-end', () => {
                    dragged = null;
                    row.remove_css_class('dragging');
                    clearMark();
                });
                row.add_controller(source);

                list.append(row);
            };

            const rebuild = (shown = shownOrder()) => {
                list.remove_all();
                marked = null;
                if (shown.length)
                    shown.forEach(addRow);
                else
                    list.append(new Adw.ActionRow({ title: 'No indicators found here', sensitive: false }));
                persist(shown);
            };

            const id = settings.connect(`changed::${discKey}`, () => rebuild());
            cleanups.push(() => settings.disconnect(id));
            rebuild();
        }

        window.connect('close-request', () => {
            cleanups.forEach(fn => fn());
            return false;
        });
    }
}