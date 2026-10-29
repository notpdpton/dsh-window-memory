/**
 * Host half of 窗口记忆 (dsh-window-memory).
 *
 * Deliberately empty. Maintaining the main window's position and size is a pure
 * renderer concern: the Desktop shell creates its BrowserWindow in the Electron
 * main process with hardcoded bounds and exposes no geometry IPC, and a Host half
 * runs in a plain Node child, so neither can reach the window. The browser half
 * (this package's ./client) receives the Window Management API, the persisted
 * geometry and the runtime binder; the Host contributes nothing to it.
 *
 * A Loader row still needs a Host module to mount, which is what this file is:
 * exporting `apply` with no registrations keeps the row active and the plugin
 * listed on the Plugins page — and that page's enable switch is this plugin's only
 * control, since the browser half ships no settings page.
 *
 * @module dsh-window-memory
 */

/** Host plugin name, used in diagnostics. */
export const name = 'dshWindow'

/** Nothing to inject: this half registers no services and waits on none. */
export const inject = []

/**
 * Activate the Host half.
 *
 * Intentionally empty: the plugin is entirely a browser feature, and an effect
 * that registered anything here would have no consumer.
 */
export function apply() {}
