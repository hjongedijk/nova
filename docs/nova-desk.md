# NOVA Desk

NOVA Desk is een echte Windows-app voor de NOVA-helper en de levende achtergrond. Tot nu toe draaiden die in een Edge-venster (`--app`), met een rechthoekig kader en venstermarges. NOVA Desk toont dezelfde NOVA-pagina's in eigen, randloze vensters: de helper is een afgerond, zwevend paneel met een zachte schaduw (altijd bovenop, niet in de taakbalk, te slepen aan de kopbalk) en de achtergrond is één venster per scherm achter de bureaubladpictogrammen.

De app is geschreven in Rust met [Tauri v2](https://tauri.app) en gebruikt WebView2, dat al in Windows 11 zit (Windows 10: installeer de "WebView2 Runtime" van Microsoft). De broncode staat in `apps/desk/`.

> **Eerlijk over de status:** NOVA Desk is gebouwd en getest zonder Windows-pc. De logica (instellingen, argumenten, venster- en schermberekeningen, de keuze voor de plek achter de pictogrammen, de modus-toestanden) heeft unit-tests die op Linux draaien, en de Windows-code compileert voor het Windows-doel. Het **echte draaien** is nog nergens gedaan. Zie [Wat is niet geverifieerd](#wat-is-niet-geverifieerd) voordat je erop vertrouwt.

## Wat het doet (versie 1)

- **Helper**: randloos, transparante achtergrond met door de pagina getekende afgeronde hoeken (16 px) en schaduw, altijd bovenop, verborgen in de taakbalk. Formaat per weergave zoals in [Windows-agent](windows-agent.md) (overzicht 960×280, chat 960×420, bevestiging 960×200, compact 360×44; rondom komt een doorzichtige rand van 12 px voor schaduw). Standaard boven in het midden van het gekozen scherm; slepen aan de kopbalk onthoudt de plek per scherm; het venster blijft altijd binnen het werkgebied (zonder taakbalk) van het scherm.
- **Wallpaper**: één randloos venster per scherm, achter de pictogrammen geplaatst met dezelfde WorkerW/Progman-logica als de PowerShell-agent (inclusief Windows 11 24H2). Per scherm aan of uit, hersteld bij het starten. Wordt de indeling van het bureaublad niet herkend, dan sluit NOVA Desk het venster weer in plaats van het bovenop je scherm te laten staan.
- **Systeemvak (tray)**: Helper tonen/verbergen, Scherm kiezen, Positie van de helper (midden/links/rechts, herstellen), Wat toon ik (helper/wallpaper/beide), Wallpaper aan/uit per scherm, Inloggen, NOVA openen in de browser, Starten met Windows, Afsluiten. Linksklikken op het pictogram toont of verbergt de helper.
- **Eén exemplaar**: een tweede start geeft zijn argumenten door aan het draaiende exemplaar en stopt. Zo stuurt de Windows-agent NOVA Desk aan, zonder tweede helper.
- **Eigen profiel**: cookies en toestemmingen (microfoon) staan in `%LOCALAPPDATA%\NOVA\desk-profile`, los van je gewone Edge.

## Niet in versie 1

- **Invoer naar de wallpaper** (muis, toetsen en typen op een leeg bureaublad, dat de PowerShell-agent met low-level hooks doet). De NOVA Desk-wallpaper is een kijkvenster: klikken op de bol of het invoerveld werkt niet. Wil je dat wel, zet dan in `agent.json` `"desk": "helper"` (alleen de helper via NOVA Desk, de wallpaper blijft in Edge met invoer) of `"desk": "off"`.
- Sneltoetsen (Ctrl+Alt+N enz.), het tray-pictogram van de agent en meldingen van de agent blijven bij de Windows-agent; die geeft ze door aan NOVA Desk. Zonder agent heeft NOVA Desk alleen zijn eigen tray.
- Een eigen minimaliseerknop (de helper heeft Inklappen en Verbergen) en het herstellen van wallpaper-vensters nadat Verkenner (explorer.exe) opnieuw is gestart: zet de wallpaper dan in het tray-menu uit en aan.

## Installeren en bijwerken

1. Download `nova-windows-agent.zip` van de GitHub-release. Als de bouw van NOVA Desk gelukt is, zit `nova-desk.exe` erin (naast `nova-agent.ps1`); er staat ook een los `nova-desk-windows.zip` bij de release. Staat er geen `nova-desk.exe` in, dan is die bouw mislukt en blijft alles werken via Edge.
2. Pak uit op een vaste plek, bijvoorbeeld `C:\NovaAgent` (dezelfde map als de agent als je die gebruikt).
3. Met de Windows-agent: niets extra's. Staat `nova-desk.exe` naast `nova-agent.ps1`, dan start de agent NOVA Desk voor de helper en de wallpaper in plaats van Edge (herstart de agent: `Start-ScheduledTask NOVAAgent`, of na een update de bestaande taak). Zonder agent: dubbelklik `nova-desk.exe`, of start met het adres van NOVA:

   ```powershell
   .\nova-desk.exe --url http://192.168.1.10:8080 --mode helper
   ```

   Zonder adres opent NOVA Desk een klein venster waarin je het adres van NOVA invult (één keer; het wordt bewaard).

4. Bijwerken: sluit NOVA Desk (tray, Afsluiten), vervang `nova-desk.exe`, start opnieuw (de agent doet dat zelf bij de volgende modus-wijziging of herstart).
5. **Starten met Windows**: vink dit aan in het tray-menu (een sleutel onder `HKCU\...\CurrentVersion\Run`, geen beheerdersrechten) of laat de agent het doen via zijn taak. Beide tegelijk is geen probleem: er draait er maar één.

Verwijderen: Afsluiten, "Starten met Windows" uitvinken, de map en `%LOCALAPPDATA%\NOVA` (instellingen, log en profiel) wissen.

## De eerste keer: inloggen

NOVA staat vaak achter een reverse proxy met een login. NOVA Desk heeft daarom een eigen profiel en toont de login **één keer in het helper-venster zelf**. De eerste start opent het venster groot (960×420) zodat het inlogscherm past. Log in; daarna blijft de sessie in het profiel bewaard. Verloopt de sessie later, kies dan in het tray-menu **Inloggen (helper groot tonen)**.

Staat de loginpagina van de proxy op een ander adres dan NOVA (bijvoorbeeld `https://auth.example.nl`), dan blokkeert NOVA Desk dat omdat het alleen het NOVA-adres toestaat. Zet dat adres dan bewust in `desk.json` bij `allowedOrigins` (zie hieronder). Zulke adressen mogen in het venster getoond worden, maar krijgen nooit de opdrachten van de helper.

## Een scherm kiezen

- In de helper: knop **Scherm** (monitor-icoon) in de kopbalk, zichtbaar bij meer dan één scherm. Het icoon werkt zonder label op smalle vensters; de tooltip noemt het scherm.
- In het tray-menu: **Scherm kiezen**.
- Met een argument: `nova-desk.exe --display 2` (1 = eerste scherm in de volgorde van Windows; 0 = onthouden/hoofdscherm).
- Met NOVA: de keuze in Instellingen, "Scherm voor de helper" gaat via de agent en komt als `--display N` bij NOVA Desk.

NOVA Desk onthoudt het laatst gebruikte scherm (op de naam van het scherm, bijvoorbeeld `\\.\DISPLAY2`, niet op het nummer). Is dat scherm weg, dan gaat de helper naar het hoofdscherm; hij komt nooit buiten beeld. Sluit je het scherm weer aan, dan kun je het opnieuw kiezen.

## Instellingen: `desk.json` en argumenten

`%LOCALAPPDATA%\NOVA\desk.json` (wordt door de app geschreven; handmatig aanpassen mag, ongeldige velden worden genegeerd en in `desk.log` gemeld, een kapot bestand wordt bewaard als `desk.json.bad`):

```json
{
  "url": "https://nova.example.nl",
  "mode": "both",
  "allowedOrigins": ["https://auth.example.nl"],
  "helper": {
    "display": "\\\\.\\DISPLAY2",
    "view": "overview",
    "anchor": "top-centre",
    "positions": { "\\\\.\\DISPLAY2": { "dx": 0, "dy": 0 } }
  },
  "wallpaper": { "\\\\.\\DISPLAY1": "full", "\\\\.\\DISPLAY2": "sphere" }
}
```

| Argument                          | Betekenis                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--url <adres>`                   | `http(s)://host[:poort]`, zonder pad, gebruikersnaam of wachtwoord. Wordt bewaard.                                         |
| `--mode helper\|wallpaper\|both`  | Wat NOVA Desk toont. Bij `both` is de wallpaper stil (geen invoer of spraak); de helper doet het luisteren en typen.       |
| `--display N`                     | Scherm voor de helper (1-gebaseerd, 0 = onthouden).                                                                        |
| `--wallpaper N:full\|sphere\|off` | Wallpaper per scherm (`all:` voor alle schermen); herhaalbaar.                                                             |
| `--view <weergave>`, `--hidden`   | Weergave van de helper (compact, overview, notifications, weather, lists, chat, confirmation) en de dunne autohide-streep. |
| `--show`, `--hide`, `--quit`      | Helper tonen of verbergen; het draaiende exemplaar afsluiten.                                                              |
| `--action …`, `--notify …`        | Voor de agent: een actie (`speak`, `mute`, `settings`, `pause`) of een melding (base64url van JSON) naar de helper-pagina. |

Onbekende of ongeldige argumenten worden geweigerd (er bestaat geen argument om een programma, pad of script uit te voeren).

## Beveiliging

- De vensters laden alleen het ingestelde NOVA-adres (plus `allowedOrigins` als je dat zelf toevoegt). Elke andere navigatie wordt geweigerd; gewone weblinks en `target="_blank"` openen in de standaardbrowser. `file:`, `data:`, `javascript:` en dergelijke worden geblokkeerd.
- Alleen het helper-venster van het NOVA-adres krijgt een handvol opdrachten: schermen opvragen en kiezen, weergave, verbergen en vergroten, en slepen. Het wallpaper-venster krijgt er geen. Het eerste-start-venster mag alleen het adres opslaan. De rechten worden bij het starten voor precies dit adres aangemaakt (Tauri-capabilities).
- Geen ontwikkelaarstools in een release-build, geen debugpoort, geen opdracht om programma's te starten, geen eigen netwerkpoort: de agent stuurt NOVA Desk uitsluitend aan via een tweede start met argumenten. Een melding of actie komt als gevalideerde JSON-tekst op de pagina, nooit als code.
- Het eerste-start-venster heeft een strikte CSP. Voor NOVA's eigen pagina's geldt de CSP die jouw server meestuurt; blokkeert een reverse proxy `ipc:` of `http://ipc.localhost`, dan valt Tauri terug op een andere route.
- Voor een `http://`-adres (thuisnetwerk) geeft NOVA Desk WebView2 `--unsafely-treat-insecure-origin-as-secure=<adres>`, zodat de microfoon werkt, net als de agent bij Edge doet. Dat geldt alleen voor dat ene adres.

## Samenwerking met de Windows-agent

Staat `nova-desk.exe` naast `nova-agent.ps1`, dan blijft de API van de agent gelijk (`/v1/mode`, `/v1/displays`, `/v1/wallpaper`, `/v1/helper/size`, `/v1/helper/notify`), maar het venster is NOVA Desk. Instelling `agent.json` → `desk`:

| Waarde             | Gedrag                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `auto` (standaard) | Helper en wallpaper via NOVA Desk als `nova-desk.exe` er is; anders Edge.                   |
| `helper`           | Alleen de helper via NOVA Desk; de wallpaper blijft in Edge (met invoer naar de wallpaper). |
| `off`              | Altijd Edge, ook als `nova-desk.exe` er staat (een lopend NOVA Desk wordt dan afgesloten).  |

De agent start NOVA Desk niet opnieuw bij elke wijziging: de tweede start geeft de nieuwe modus, het scherm of de weergave aan het draaiende exemplaar door. Er draait nooit tegelijk een Edge-helper en een NOVA Desk-helper (de agent beëindigt een achtergebleven Edge-helper). Sneltoetsen en agent-meldingen werken via de agent; in modus `wallpaper` openen de sneltoetsen de helper niet als NOVA Desk de wallpaper toont.

## Problemen oplossen

| Symptoom                                          | Wat te doen                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Er verschijnt niets                               | Kijk in het tray-menu (zit het pictogram er?) en in `%LOCALAPPDATA%\NOVA\desk.log`. Zonder adres opent het instelvenster. Is WebView2 geïnstalleerd?                     |
| Wit of zwart vierkant rond de helper              | De doorzichtige achtergrond werkt dan niet met jouw WebView2/grafische driver. Meld dit; zie [niet geverifieerd](#wat-is-niet-geverifieerd). Tijdelijk: `"desk": "off"`. |
| Inloggen lukt niet / pagina blijft leeg           | Staat de loginpagina op een ander adres? Zet het in `allowedOrigins`. Daarna in het tray-menu "Inloggen". Het log meldt "blocked navigation".                            |
| De wallpaper staat voor de pictogrammen of is weg | Het log meldt of de bureaubladindeling is herkend. Wordt hij niet herkend, dan sluit NOVA Desk het venster. Gebruik `"desk": "helper"` en laat Edge de wallpaper doen.   |
| Wallpaper weg na herstart van Verkenner           | Zet de wallpaper in het tray-menu uit en weer aan.                                                                                                                       |
| Helper staat op het verkeerde scherm              | Tray, Scherm kiezen; of `--display N`. De volgorde van schermen komt van Windows en kan van de Weergave-instellingen afwijken.                                           |
| Microfoon werkt niet                              | De toestemming wordt per profiel onthouden. Wis `%LOCALAPPDATA%\NOVA\desk-profile` (je moet dan opnieuw inloggen) als je "Blokkeren" koos.                               |
| Twee helpers                                      | Dat hoort niet te kunnen. Sluit alles, controleer `"desk"` in `agent.json` en of er geen oude `msedge`-helper met `nova-helper` in de opdrachtregel draait.              |

## Wat is niet geverifieerd

Hier is alleen op Linux gewerkt. Verifieerd: `cargo test -p nova-desk-core` (77 tests), `cargo check` en een volledige debug-build voor `x86_64-pc-windows-gnu` (inclusief de Tauri-build, die de rechten en de configuratie controleert), de PowerShell-controle van de agent, en een Playwright-controle van de helper-pagina op 640/800/960/1280 px (zie [Helper](helper-design.md)). **Niet** verifieerd op een echte pc:

- Dat de app daadwerkelijk start en dat de vensters verschijnen zoals bedoeld.
- **De plek achter de pictogrammen** (WorkerW/Progman) op jouw Windows-build, ook na een herstart van Verkenner en bij meerdere schermen. De beslissing is een letterlijke port van de agent en getest op de bekende indelingen, maar de Win32-aanroepen zelf draaien nog nergens.
- **DPI per scherm** (100/125/150/200 %, schermen met verschillende schaal): de berekening is getest, de schaalfactoren die WebView2/Tauri teruggeven en het gedrag bij verhuizen tussen schermen niet.
- **Doorzichtige vensters met WebView2**: of de achtergrond echt doorzichtig is (geen wit/zwart vlak), of de schaduw buiten het paneel getekend wordt, en of de doorzichtige rand van 12 px klikken doorlaat of opvangt.
- Slepen aan de kopbalk (`data-tauri-drag-region`) en het bewaren van de plek na het slepen; de volgorde van de schermen ten opzichte van Windows; het tray-menu; starten met Windows; de microfoonvraag en `--unsafely-treat-insecure-origin-as-secure` in WebView2; de opdrachten vanuit een extern (NOVA-)adres.
- De bouw op `windows-latest` (de release-workflow): de job staat op `continue-on-error`, dus een mislukking houdt de release niet tegen maar levert dan geen `nova-desk.exe` op.

Meld wat je ziet (en het `desk.log`); de agent met Edge blijft het veilige terugvalpad.

## Voor ontwikkelaars

```
apps/desk/
  Cargo.toml                       workspace
  crates/nova-desk-core/           geen GUI-afhankelijkheid, volledig getest (cargo test)
    args.rs  config.rs  geometry.rs  mode.rs  desktop.rs  nav.rs  script.rs  view.rs  autostart.rs
  src-tauri/                       dunne Windows-laag (Tauri)
    src/app.rs        start, enkele instantie, argumenten, windows laten overeenkomen met de modus
    src/windows_ops.rs  vensters maken en plaatsen (helper, wallpaper), schermen, slepen
    src/win.rs        Win32: bureaubladindeling vinden, achter de pictogrammen zetten, Run-sleutel
    src/commands.rs   de zes opdrachten die een pagina mag aanroepen (elk een eigen recht)
    src/tray.rs       tray-menu
    capabilities/setup.json, dist/  alleen het instelvenster
```

- Testen: `cd apps/desk && cargo test -p nova-desk-core`. Controleren of de Windows-code compileert (op Linux met `gcc-mingw-w64-x86-64` en `rustup target add x86_64-pc-windows-gnu`): `cargo check --target x86_64-pc-windows-gnu -p nova-desk`. CI doet beide ([ci.yml](../.github/workflows/ci.yml), job `desk`).
- Bouwen op Windows: `cd apps/desk && cargo build --release -p nova-desk` geeft `target/release/nova-desk.exe`. De release-workflow doet dat in de job `desk` (`windows-latest`, `continue-on-error: true`) en legt het resultaat in `nova-windows-agent.zip` en in `nova-desk-windows.zip`.
- De webkant (`apps/web/src/routes/helper/`, `components/helper/`) kent de desk-weergave via `?desk=1` of de klasse `desk` op `<html>` (door NOVA Desk gezet voordat de pagina laadt), en roept NOVA Desk aan via `window.__TAURI__` als dat er is (`lib/api/desk.ts`); zonder blijft het gedrag zoals voorheen. De koprij past zich aan op zijn eigen breedte (container queries). `node scripts/check-helper-layout.mjs` controleert op 640/800/960/1280 px, 100/125/150 % en in beide weergaven dat er niets overlapt.
- Het contract met de agent (argumentlijsten) wordt aan beide kanten getest: `args.rs` (`the_agents_arguments_parse`) en `agents/windows/test/check.ps1`.
