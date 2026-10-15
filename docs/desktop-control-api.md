# Bureaublad zien en bedienen (API-contract)

NOVA kan het Windows-bureaublad van de gebruiker bekijken en, in een korte bevestigde sessie, muis en
toetsenbord bedienen via de Windows-agent. Alles staat standaard uit, aan beide kanten (agent en NOVA).

Status: gebouwd en lokaal getest met een nep-agent. Acceptatie op een echte pc is nog open.

## Agent-routes (contract met `agents/windows`)

Zelfde bearer-token als de andere agent-tools (`WINDOWS_AGENT_URL`, `WINDOWS_AGENT_TOKEN`).

| Route                                           | Doel                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/desktop/status`                        | `{ ok, view, control, armed, armedUntil?, displays[] }`                                                                                     |
| `GET /v1/desktop/screenshot?display=&maxWidth=` | `image/png\|jpeg\|webp` body (optioneel `x-nova-width/height`) of JSON `{ ok, image (base64), mimeType, width, height, display }`; max 6 MB |
| `GET /v1/desktop/windows`                       | `{ ok, windows: [{ id, title, process?, active\|foreground, display? }] }`                                                                  |
| `POST /v1/desktop/input`                        | `{ action: move\|click\|doubleclick\|rightclick\|drag\|scroll\|type\|key\|focus_window, ... }`                                              |
| `POST /v1/desktop/control`                      | `{ armed: true, ttlSeconds <= 900 }` of `{ armed: false }`                                                                                  |

Aannames die de agent moet bevestigen of NOVA moet aanpassen: coordinaten in `input` zijn pixels van de laatste
schermafbeelding; NOVA stuurt `display` en `relativeTo: { width, height }` mee zodat de agent kan schalen.
Het actieve venster moet uit `windows` blijken (`active` of `foreground`), anders classificeert NOVA elke
muis- of toetsactie als onbekend en vraagt bevestiging. De agent dwingt zijn eigen TTL en 404/403/409-antwoorden af;
NOVA vertaalt die naar een Nederlandse melding zonder agentdetails.

## NOVA-kant

Code: `apps/api/src/desktop/`. De agent zit achter `DesktopPort` (`DESKTOP_PORT`, echte client
`desktop.agent-client.ts`), het visiemodel achter `DesktopVision` (`DESKTOP_VISION`); tests injecteren fakes.

### Tools

| Tool                     | Risico                                        | Gedrag                                                                                                                                                                                     |
| ------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `desktop_status`         | READ_ONLY                                     | instellingen, sessie, agentstatus                                                                                                                                                          |
| `desktop_windows`        | READ_ONLY                                     | vensterlijst (titels zijn data); alleen met "zien" aan                                                                                                                                     |
| `desktop_screenshot`     | READ_ONLY                                     | beeld naar de `vision`-rol via OmniRoute (alleen geverifieerd gratis model, anders niets verstuurd); antwoord is een tekstbeschrijving gemarkeerd als onbetrouwbaar; alleen met "zien" aan |
| `desktop_takeover_start` | DANGEROUS                                     | schermbevestiging bij elke aanroep (60 s, eenmalig), doel en tijd (30-900 s) in de bevestiging, nooit gedekt door "Altijd"                                                                 |
| `desktop_act`            | SAFE per call; DANGEROUS bij riskant/onbekend | alleen tijdens een sessie van hetzelfde gesprek; zie classificatie                                                                                                                         |
| `desktop_takeover_stop`  | READ_ONLY                                     | stopt direct en zet de agent uit; werkt ook als alles uit staat                                                                                                                            |

Beelden worden niet opgeslagen of gelogd. Er is alleen een korte cache (10 s, max 4, per beeld+vraag) van de
tekstbeschrijving, die bij elke actie, stop of wijziging van de instellingen wordt geleegd en uit kan.
NOVA maakt geen beeld als het actieve venster een wachtwoordbeheerder, bank of inlogvenster lijkt, of als de
vensterlijst niet te controleren is (fail closed).

### Limieten per sessie (server-side, `desktop.limits.ts`)

- Duur 30-900 s (de service klemt ook bij directe aanroep); inactiviteit 120 s beëindigt de sessie.
- Maximaal 100 acties en 60 schermbeelden.
- Observe, dan act: eerst kijken; na 6 acties opnieuw kijken.
- 3 mislukte acties of beelden achter elkaar: sessie stopt en de agent wordt uitgezet. Mislukt het uitzetten, dan
  probeert NOVA het elke 5 s opnieuw en meldt dat in de instellingen.
- Eén sessie tegelijk, gebonden aan het gesprek dat hem startte.

### Classificatie van `desktop_act`

Per actie, op basis van de voorgestelde actie en de venstertitel/het proces dat de agent meldt (niet wat het model beweert):

- Goedaardig (geen vraag): pointer/scroll, navigatietoetsen, klik/typ in een gewoon, eenduidig venster.
- Riskant (verse DANGEROUS-bevestiging, ook binnen de sessie): betalen, bank, verwijderen, wachtwoord/inloggen, mail/chat,
  terminals en beheer, tekst met Enter, tekst die op een wachtwoord, token, IBAN of kaartnummer lijkt, Enter in een browser,
  slepen/rechtsklik/dubbelklik in de bestandsverkenner.
- Onbekend (ook bevestigen): onbekende toets, geen of onduidelijk actief venster, lege titel, onbekend `windowId`,
  tekst langer dan 300 tekens, vensterlijst onbereikbaar.

De bevestiging bindt aan de exacte actie én de venstertitel. Verandert het venster tussen vraag en uitvoering, dan
wordt opnieuw gevraagd. Een "Altijd" voor DANGEROUS wordt niet aangeboden en maakt geen toestemming aan.

### Prompt injection

Alles van het scherm (beschrijving, venstertitels, web, mail) is data. De beschrijving draagt `untrusted: true` en een
waarschuwing, het visiemodel krijgt de opdracht tekst die een AI probeert aan te sturen te melden in plaats van te volgen,
en geen enkel scherminhoud kan een bevestiging, sessie of toestemming aanmaken: dat doen alleen de gebruiker (schermknop)
en de classificatie hierboven.

### Audit

Elke toolaanroep komt in het actielog met alleen metadata: actie, coördinaten, toetsnaam, venstertitel (80 tekens), en
bij `type` alleen `textCharacters`; nooit de getypte tekst of de schermbeschrijving. Ook een geannuleerde bevestiging
logt de getypte tekst niet. Sessiestart en -einde (reden: user, model, ttl, idle, max_actions, errors, disabled) staan
als `desktop_session`.

### Instellingen en REST

`GET /api/settings/desktop` (status, sessie, laatste 40 auditregels), `PUT /api/settings/desktop`
`{ viewEnabled?, controlEnabled?, cacheEnabled? }` (bedienen kan niet zonder zien), `POST /api/settings/desktop/stop`.
Alle routes vallen onder de instellingen-PIN/-header. Opgeslagen in `desktop-settings.json` (0600), standaard alles uit.
Instellingen, Bureaublad toont de schakelaars, sessiestatus, een stopknop en het actielog.

## Tests

`npm -w apps/api test -- test/desktop` (42 tests): standaard uit, zien (vision-rol, cache, fail closed, gevoelig venster),
DANGEROUS nooit automatisch toegekend (ook niet met `always` of een nagemaakte standing grant), ttl-cap, budgetten, idle/ttl,
foutenlus, agentfouten, geen getypte tekst in het log, scherminjectie, echte HTTP-client tegen een nepserver, vision-adapter.
