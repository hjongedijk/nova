# NOVA lists and Home Assistant to-do

NOVA keeps its existing private local lists in `jarvis-state.json`. When Home Assistant is
configured and exposes a `todo` entity that is visible under NOVA's Home Assistant access policy,
list tools use that entity when its entity ID or friendly name exactly matches the requested list
(case-insensitive). This makes additions and removals visible in Home Assistant and any connected
to-do provider. There is no fuzzy matching: duplicate names are rejected and inaccessible entities
are ignored. A list with no matching entity remains local.

`list_show` reads pending items with Home Assistant's `todo.get_items`; returned titles are
untrusted personal data, returning at most 30 items per list and 10 lists at once. Add and remove use `todo.add_item` and `todo.remove_item` with the exact
entity and item UID. Clearing a Home Assistant list uses the existing fresh-confirmation gate and
removes its pending items one by one; an oversized list is refused rather than partially cleared.
If a Home Assistant request fails, NOVA reports that failure
instead of silently writing to a local list. The daily overview includes local lists; Home Assistant
lists are available directly through `list_show`.

No additional token or setting is needed beyond the existing Home Assistant connection and entity
visibility controls. This uses Home Assistant's built-in to-do actions, so it works with its local
list, shopping list, and supported third-party to-do integrations.
