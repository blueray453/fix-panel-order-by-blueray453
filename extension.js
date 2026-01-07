import GLib from 'gi://GLib';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { setLogging, setLogFn, journal } from './utils.js'

const Panel = Main.panel;
const StatusArea = Main.panel.statusArea;

export default class NotificationThemeExtension extends Extension {
  enable() {
    setLogFn((msg, error = false) => {
      let level;
      if (error) {
        level = GLib.LogLevelFlags.LEVEL_CRITICAL;
      } else {
        level = GLib.LogLevelFlags.LEVEL_MESSAGE;
      }

      GLib.log_structured(
        'fix-panel-order-by-blueray453',
        level,
        {
          MESSAGE: `${msg}`,
          SYSLOG_IDENTIFIER: 'fix-panel-order-by-blueray453',
          CODE_FILE: GLib.filename_from_uri(import.meta.url)[0]
        }
      );
    });

    setLogging(true);

    // Main.overview.dash.height = 0;
    // Main.overview.dash.hide();

    // journalctl -f -o cat SYSLOG_IDENTIFIER=fix-panel-order-by-blueray453
    journal(`Enabled`);

    const LEFT_ORDER = [
      "window-list-menu",
      "workspace-indicator"
    ];

    // Hardcoded center box order
    const CENTER_ORDER = [
    ];

    const RIGHT_ORDER = [
      "ShowNetSpeedButton",
      "printers",
      "lockkeys@febueldo.test",
      "color-picker@tuberry",
      "clipboardIndicator",
      "emoji-copy@felipeftn",
      "athan@goodm4ven"
    ];

    let attempts = 0;

    let ALL_ORDER = [...LEFT_ORDER,...CENTER_ORDER, ...RIGHT_ORDER];
    // Start polling every 100ms
    this._pollingTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      attempts++;

      // Filter out roles that are already found
      ALL_ORDER = ALL_ORDER.filter(role => {
        const obj = StatusArea[role];
        // journal(`Checking role: ${role}`);

        // Keep only roles NOT found yet
        return !obj || !obj.container;
      });

      // journal(`ALL_ORDER ${ALL_ORDER}`);
      if (ALL_ORDER.length === 0) {
        journal(`Attempt ${attempts}`);
        // journal("All center and right roles found — panel ready!");

        // Run your organization logic now
        this.safelyReorder('left', LEFT_ORDER);
        this.safelyReorder('center', CENTER_ORDER);
        this.safelyReorder('right', RIGHT_ORDER);

        return GLib.SOURCE_REMOVE; // stop polling
      }

      // Polling Limit
      if (attempts >= 40) {
        // journal("Stopped polling after 25 attempts — roles not fully found.");
        return GLib.SOURCE_REMOVE; // Stop regardless of success
      }

      return GLib.SOURCE_CONTINUE; // keep polling
    });
  }

  safelyReorder(boxType, desiredOrder) {
    const box = Panel[`_${boxType}Box`];

    if (!box) {
      log(`Box ${boxType} not found`);
      return;
    }

    // Walk the desired order and reposition existing indicators
    desiredOrder.forEach((role, index) => {
      const indicator = Panel.statusArea[role];
      if (!indicator || !indicator.container)
        return; // Skip missing ones

      const actor = indicator.container;

      // Only reorder if the indicator is already inside this box
      // journal(`Actor Parent: ${actor.get_parent()}`);
      // journal(`Box: ${box}`);
      if (actor.get_parent() === box) {
        box.set_child_at_index(actor, index);
        // journal(`Set Child`);
      }
    });
    // journal(`=== ${boxType} box organization complete ===`);
  }

  _getRolesInBox(box, boxName = '', log = true) {
    const roles = [];

    box.get_children().forEach((child, index) => {
      let role = null;

      for (const r in StatusArea) {
        if (StatusArea[r].container === child) {
          role = r;
          break;
        }
      }

      const roleName = role || 'unknown';
      roles.push(roleName);

      if (log) {
        journal(`${boxName}[${index}]: ${roleName}`);
      }
    });

    return roles;
  }

  disable() {
    journal(`Disable`);
    if (this._pollingTimeoutId) {
      GLib.Source.remove(this._pollingTimeoutId);
      this._pollingTimeoutId = null;
    }

    this._getRolesInBox(Panel._leftBox, 'LEFT BOX');
    this._getRolesInBox(Panel._centerBox, 'CENTER BOX');
    this._getRolesInBox(Panel._rightBox, 'RIGHT BOX');
  }
}
