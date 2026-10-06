import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const BOXES = [['left', 'Left Box'], ['center', 'Center Box'], ['right', 'Right Box']];

export default class FixPanelOrderPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({ title: 'Panel Order', icon_name: 'view-list-symbolic' });
        window.add(page);

        const cleanups = [];

        for (const [type, title] of BOXES) {
            const orderKey = `order-${type}`;
            const discKey = `discovered-${type}`;
            const group = new Adw.PreferencesGroup({ title });
            page.add(group);
            let rows = [];

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

            const move = (shown, i, delta) => {
                [shown[i], shown[i + delta]] = [shown[i + delta], shown[i]];
                persist(shown);
                rebuild();
            };

            const rebuild = () => {
                rows.forEach(r => group.remove(r));
                const shown = shownOrder();
                persist(shown);

                rows = shown.length ? shown.map((role, i) => {
                    const row = new Adw.ActionRow({ title: role });
                    for (const [icon, delta, enabled] of [
                        ['go-up-symbolic', -1, i > 0],
                        ['go-down-symbolic', 1, i < shown.length - 1],
                    ]) {
                        const btn = new Gtk.Button({
                            icon_name: icon, valign: Gtk.Align.CENTER,
                            css_classes: ['flat'], sensitive: enabled
                        });
                        btn.connect('clicked', () => move(shownOrder(), i, delta));
                        row.add_suffix(btn);
                    }
                    return row;
                }) : [new Adw.ActionRow({ title: 'No indicators found here', sensitive: false })];

                rows.forEach(r => group.add(r));
            };

            const id = settings.connect(`changed::${discKey}`, rebuild);
            cleanups.push(() => settings.disconnect(id));
            rebuild();
        }

        window.connect('close-request', () => {
            cleanups.forEach(fn => fn());
            return false;
        });
    }
}