# Autopilot: NOVA neemt zelf initiatief

De autopilot staat standaard aan. Hij zorgt dat NOVA ook meldt wat er speelt zonder dat je iets vraagt: een afspraak die
bijna begint, een apparaat dat wegvalt, iets in NOVA zelf dat stuk is, een taak die op jou wacht. Code:
`apps/api/src/autopilot/`, de directe delegatie in `apps/api/src/chat/direct-goal.ts`.

## Wat het doet

Elke 5 minuten (`setInterval`, `unref`) draaien vaste, lezende controles. Er is **geen modelaanroep** bij: de controles lopen
via `ToolsService.execute(..., { readOnlyOnly: true })` met sessie `autopilot` en interne services, en elke zin komt uit een
sjabloon (Nederlands, kort, met een concrete volgende stap). Gratis quotum wordt dus niet verbruikt.

| Controle   | Kijkt naar                                                                                                                                                                                                         | Melding                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `calendar` | `calendar_events`: begint binnen 30 minuten                                                                                                                                                                        | een herinnering per afspraak (info)                                                                                        |
| `home`     | `ha_search_entities`: licht, schakelaar, rolluik, slot, klimaat, ventilator, mediaspeler, alarm, stofzuiger                                                                                                        | apparaat "unavailable" in 2 opeenvolgende controles (flapperen telt niet); vanaf 4 tegelijk een melding over de hub (warn) |
| `health`   | routering geblokkeerd of beleid afgedwaald, (bijna) alle gratis modellen falen, SIP-trunk niet geregistreerd, MCP-werkers uit, Home Assistant-verbinding oud, schijf (<15% warn, <5% urgent) en werkgeheugen (<6%) | uitleg in gewone taal met de oorzaak (warn, soms urgent)                                                                   |
| `nudges`   | taak die wacht of onderbroken is, of een doel met een openstaande afwijking, langer dan 30 minuten                                                                                                                 | een duwtje, eenmaal per 6 tot 12 uur (warn/info)                                                                           |
| `today`    | open items op de lijst `taken` en lopende timers, vanaf 08:00 lokaal                                                                                                                                               | een keer per dag (info), alleen als er iets is                                                                             |

Zelfherstel doet alleen veilige dingen en wijzigt nooit instellingen: een gestopte MCP-werker opnieuw verbinden en de
Home Assistant-verbinding vernieuwen, hooguit eens per 30 minuten per ding. Lukt het, dan volgt geen melding (wel een
regel in het activiteitenlog). Een vastzittende modelcooldown wordt niet gewist: die zit in de chatclient en valt buiten
deze module.

Elke bevinding heeft een `id`, urgentie (`info`/`warn`/`urgent`), een ontdubbelsleutel en een eigen cooldown. Dezelfde
sleutel wordt binnen de cooldown niet opnieuw gemeld (afspraak: 24 uur, apparaat: 12 uur, routering en trunk: 6 uur).

## Hoe het bij je komt

1. **Alertfeed** (`JarvisStateStore`, topic `jarvis/alerts`): de interface toont en spreekt het als hij open staat.
2. **Linphone-tekst** naar opgeslagen contacten met "Mag met NOVA praten" (`allowConversation`), via
   `TelephonyService.sendText(naam, tekst)`: ARI `POST /endpoints/sendMessage` met
   `to=pjsip:trunk/sip:<gebruiker>@<domein>` en `from=sip:<trunkgebruiker>@<trunkhost>`. Alleen als telefonie aan staat, de
   trunk is ingesteld, Asterisk bereikbaar is en de trunk niet als offline wordt gemeld. Standaard voor elke urgentie
   (`textMinUrgency`).
3. **Telefoongesprek**: standaard **uit** (`allowCalls: false`). Alleen een urgente bevinding, buiten de stille uren,
   met `allowCalls: true` en een autonomieniveau dat bellen zonder vragen toestaat (`allowsAutoApproval("phone_call")`:
   niet bij `careful`), via de gewone `phone_call`-tool naar het eerste contact met `allowConversation`.

## Grenzen (standaard, allemaal instelbaar)

- Stille uren 23:00-07:00 Europe/Amsterdam: alleen `urgent` komt door (feed en tekst, nooit een gesprek). Wat in de stille
  uren tegenhoudt, wordt bij de eerstvolgende controle na afloop alsnog gemeld als het nog geldt.
- Dagbudget 10 initiatieven en maximaal 3 per uur (alle kanalen samen tellen als een initiatief). `urgent` mag tot het
  dubbele van beide.
- Per bevinding een cooldown (zie boven), controle-interval 5 minuten, daglimiet volgens de lokale dag.

## Standaarddoelen (eenmalig)

Bij de eerste controle, als er nog geen enkel doel bestaat (vlag `bootstrapped` in `autopilot.json`): met Proxmox
`servers_gezond` (dat bevat ook de dienstencontrole), anders per draaiende kernservice (omniroute, mqtt, qdrant, spraak,
Home Assistant; hooguit drie) een `service_online`-doel via `ObjectivesService.create`. Wat de installatie niet heeft,
wordt stil overgeslagen. Verwijder je zo'n doel, dan komt het niet terug.

## Direct delegeren, zonder model

`directGoalQuery()` herkent expliciete opdrachten van minstens vier woorden die geen gewone vraag zijn:
"regel ...", "zoek ... uit", "onderzoek ...", "werk ... af", "plan en voer ... uit", "handel ... af", "sort this out",
"figure out ...", ook beleefd ("kun je dit voor me regelen"). Dan start `AgentService.start(goal)` direct en antwoordt NOVA
"Ik ga ermee aan de slag en meld me zodra het klaar is." "houd ... in de gaten", "laat me weten als ...", "zorg dat ...
blijft" maken een doel als er een duidelijk sjabloon past (`servers_gezond`, `agenda_leeg`, `ha_waarde` met entiteit);
anders beslist het model. Vragen ("wat is het regelen van een lening", "hoe regel ik ...?") gaan altijd naar het model.
Sessies `agent_*` en alleen-lezen tekstchats (Linphone) delegeren nooit; op autonomieniveau `careful` beslist het model.
De haak in `OrchestratorService` is `setGoalDelegator`; de autopilot meldt zich daar aan.

## Zien wat het doet

- `GET /api/autopilot/status`: laatste controle, bevindingen (met uitkomst `gemeld`, `cooldown`, `stil`, `budget`,
  `limiet`), initiatieven vandaag en dit uur, volgende controle, aan/uit, laatste 30 activiteiten.
- `GET /api/autopilot/activity`: het volledige activiteitenlog (maximaal 200). Alleen metadata (soort, controle, urgentie,
  uitkomst), nooit tekst, titels of namen. `lastFindings` in `autopilot.json` bewaart wel de titel van de laatste
  bevindingen (bijvoorbeeld een afspraaknaam); het bestand is 0600.
- `POST /api/autopilot/scan`: een ronde nu draaien (zelfde regels). Tool `autopilot_status` voor "wat heb je zelf gedaan?".

## Instellingen en uitzetten

Alles staat in `autopilot.json` in de datamap (0600, atomisch geschreven, herstart gaat door waar hij was) en via
`GET`/`PUT /api/settings/autopilot` (beveiligd met de instellingen-PIN). Velden: `enabled`, `intervalMinutes`, `quiet`
(`enabled`, `start`, `end`, `timezone`), `dailyBudget`, `hourlyLimit`, `textContacts`, `textMinUrgency`, `allowCalls`,
`scans` (per controle aan/uit), `calendarLeadMinutes`, `staleMinutes`, `selfHeal`.

**Uitzetten (kill switch):** `PUT /api/settings/autopilot` met `{"enabled": false}`, of tegen NOVA zeggen "zet de autopilot
uit" (tool `autopilot_set`), of `"enabled": false` in `autopilot.json` en herstarten. Aan = `true`. Alleen de teksten
berichten uit: `{"textContacts": false}`. Een enkele controle uit: `{"scans": {"home": false}}`.

Let op: als je daarnaast de eigen agenda-herinneringen van het dashboard (Instellingen, rituelen) aanzet, krijg je
afspraken dubbel gemeld; zet er dan een van de twee uit.

## Wat niet is geverifieerd

- Er is **geen live test** van een Linphone-bericht gedaan. `sendText` is getest tegen een nep-ARI (juiste `to`, `from` en
  `body`); of Asterisk de SIP MESSAGE via de trunk echt aflevert en Linphone hem toont, is niet bewezen.
- "Trunk geregistreerd" leest de PJSIP-endpoint `trunk` via ARI: alleen `offline` telt als niet geregistreerd, `unknown`
  telt als gereed. Of Asterisk die status bij jouw provider betrouwbaar bijhoudt, is niet gecontroleerd.
- "Bijna alle modellen falen" gebruikt de OmniRoute-statistieken van de laatste 24 uur (alleen als de beheerkoppeling is
  ingesteld); dat loopt dus achter op een storing van vandaag.
- Het gesprek bij een urgente bevinding is alleen met nepdiensten getest, niet met een echte telefoon.
- Werkgeheugen komt uit `/proc/meminfo` van de host of container, niet uit een cgroup-limiet.
- Er is niets tegen een draaiende productie-installatie geprobeerd.
