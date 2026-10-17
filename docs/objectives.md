# Doelen om in de gaten te houden (standing objectives)

NOVA kan een blijvend doel bewaken zonder dat je het opnieuw vraagt: "zorg dat mijn servers gezond blijven",
"houd de garagedeur in de gaten", "laat het me weten als de dienst uitvalt". Code: `apps/api/src/objectives/`.

## Wat het doet

- Een doel bestaat uit controles. Elke controle is een lezende tool (alleen `READ_ONLY` en alleen deze lijst:
  `proxmox_status`, `proxmox_guests`, `network_check`, `ha_get_state`, `calendar_events`), vaste argumenten en een
  vaste voorwaarde die beschrijft wat er mis is (bijvoorbeeld `nodes[].cpu.usagePercent > 90`).
- Een lichte planner (`setInterval`, `unref`) draait de doelen die aan de beurt zijn. Het volgende tijdstip volgt uit het
  opgeslagen `lastCheckAt`, dus na een herstart gaat het door zonder een stroom van inhaalcontroles; een doel dat
  lang stilstond draait eenmaal.
- De controles lopen via `ToolsService.execute(..., { readOnlyOnly: true })` met sessie `objective_<id>`. Voorwaarden
  worden in code beoordeeld: routinecontroles gebruiken geen model en kosten dus geen gratis quotum.
- Ontdubbelen: een afwijking telt pas na N opeenvolgende controles (debounce, per controle). Er gaat precies een
  melding uit als een afwijking begint (of van samenstelling verandert) en een "Hersteld" als hij verdwijnt.
  Een tool die drie keer achter elkaar faalt telt zelf als afwijking ("de controle zelf mislukt").
- Alleen bij een nieuwe of gewijzigde afwijking met urgentie `warn` of `urgent` start `AgentService.start()` een
  onderzoek ("onderzoek waarom ..."), hooguit een keer per 30 minuten per doel, met 5 beurten en 8 minuten. De KLAAR-samenvatting
  wordt bij het doel bewaard (`lastInvestigation`) en als vervolgmelding in de alertfeed gezet.

## Sjablonen

Het model kiest een sjabloon en vult parameters in; het geeft nooit zelf tools of voorwaarden op. Onbekende sjablonen
worden geweigerd.

| Sjabloon         | Controleert                                                                                      | Parameters                                     |
| ---------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `servers_gezond` | node offline (urgent, 2x), CPU (3x), geheugen (3x), gestopte gasten (info, 2x), dienst down (2x) | `cpuMax` 90, `memMax` 90, `maxStopped` 0       |
| `service_online` | een `network_check`-doel (naam uit `NOVA_CHECK_TARGETS` of de NOVA-stack) antwoordt              | `target`, `consecutive` 2                      |
| `ha_waarde`      | Home Assistant-entiteit vergeleken met een waarde (`cover.garage == open`)                       | `entity`, `operator`, `value`, `consecutive` 1 |
| `agenda_leeg`    | geen afspraken de komende zeven dagen (`calendar_events` leeg)                                   | geen                                           |

`kind: "monitor"` blijft bewaken; `kind: "followup"` meldt een keer en eindigt daarna (`fulfilledAt`).

## Meldingen en stilte

- Urgentie: `info`, `warn`, `urgent` (feed-ernst info, warning, critical).
- Stille uren standaard 23:00-07:00 Europe/Amsterdam: de controle loopt en wordt vastgelegd, maar alleen `urgent` meldt.
  Een niet-gemelde afwijking die na de stille uren nog loopt wordt dan alsnog gemeld.
- Per doel een wachttijd tussen meldingen (standaard 30 minuten; `urgent` negeert die).
- Globaal dagbudget van 8 meldingen (lokale dag); `urgent` mag tot het dubbele. "Hersteld" en onderzoeksmeldingen tellen mee
  maar negeren de wachttijd. De budgetwaarde staat in `objectives.json` (`settings.dailyBudget`).

## Limieten

Maximaal 5 actieve en 20 opgeslagen doelen; interval 5 tot 1440 minuten; een doel kan een vervaldatum hebben (`expiresInDays`) en pauzeert
dan zelf. Geen doel (of achtergrondtaak, sessie `objective_*` of `agent_*`) kan doelen aanmaken, wijzigen of verwijderen.
Dubbele doelen (zelfde sjabloon, soort en parameters) worden samengevoegd.

## Tools en REST

`objective_create`, `objective_update`, `objective_pause`, `objective_resume` (SAFE), `objective_list` (READ_ONLY),
`objective_delete` (CONFIRM, altijd verse bevestiging). Nederlandse aliassen in `tool-selection.ts` ("houd in de gaten",
"monitor", "bewaak", "waarschuw", "laat het me weten", "gezond blijft"). REST achter de gewone app-guard:
`GET /api/objectives`, `PUT /api/objectives/:id` (title, intervalMinutes, cooldownMinutes, quietHours, expiresInDays, enabled, dismiss),
`DELETE /api/objectives/:id`.

## Terugblik

Per doel de laatste 20 resultaten, tellers (controles, afwijkingen, meldingen, onderdrukt, onderzoeken, valse alarmen) en het aantal
afwijkingen in de laatste 7 dagen; `objective_list` toont dat, zodat NOVA kan zeggen "afgelopen week twee storingen".
`objective_update` met `dismiss=true` markeert de huidige melding als vals alarm: NOVA zwijgt erover tot de afwijking
verandert, de teller blijft staan.

## Opslag

`objectives.json` in de datamap, modus 0600, atomisch geschreven met fsync. Alleen metadata komt in het auditlog.

## Bekende beperkingen

- Het onderzoek is alleen-lezen via de opdrachttekst en de bestaande goedkeuringen van `AgentService`; `AgentService.start()`
  kent geen technische alleen-lezen-modus, dus een onderzoek kan om goedkeuring vragen voor een wijzigende tool.
- `agenda_leeg` kan niet zien of de agenda wel gekoppeld is; zonder koppeling telt "leeg" als afwijking.
- `service_online` gebruikt de doelnamen van `network_check`, geen willekeurige host:poort.
- De onderzoekssamenvatting komt daarnaast ook via de eigen "Klaar"-melding van `AgentService` binnen; die telt niet mee in het dagbudget.
- Zie `docs/development-state.md` voor wat wel en niet in productie is bewezen.
