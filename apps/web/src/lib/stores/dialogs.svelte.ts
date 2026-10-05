/** Which full-screen dialogs are open. The menu opens them; each dialog component closes itself. */
export const dialogs = $state({
  settings: false,
  admin: false,
  history: false,
  /** Tab the settings dialog should open on (the menu's "Vaardigheden" asks for "abilities"); the dialog clears it. */
  settingsTab: null as string | null,
});
