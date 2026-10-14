# Node-RED-pakketten beheren

Instellingen → Koppelingen → Node-RED → Palette toont alleen pakketten uit de serverinstelling `NODE_RED_PALETTE_ALLOWLIST`. Standaard is die lijst leeg. Een pakket toevoegen aan deze lijst installeert het niet; elke installatie, versieaanpassing of verwijdering vraagt een nieuwe bevestiging.

Gebruik voor vaste versies records met precies `name` en `version`:

```json
[{ "name": "node-red-node-example", "version": "1.2.3" }]
```

Dit is een schema-voorbeeld, geen pakketadvies. Vervang naam en versie door een pakket en exacte versie die je zelf hebt beoordeeld. Namen beginnen met `node-red-node-` of `node-red-contrib-`. Maximaal twintig unieke namen zijn toegestaan. Een versie is een exacte SemVer van maximaal zestig tekens, eventueel met prerelease- of buildinformatie. Tags, bereiken, URL's en lokale bestandspaden worden geweigerd.

Bestaande lijsten met alleen pakketnamen blijven werken. Deze vorm heeft geen vaste versie: installatie vraagt dan de actuele npm-versie op. NOVA toont dat verschil in het overzicht en vóór bevestiging. Gebruik vaste versies voor voorspelbare wijzigingen.

Het overzicht toont de actieve versie, de toegestane doelversie en een eventueel klaargezette versie. Als die verschillen, verschijnt een knop om de doelversie te installeren. Dit kan ook een oudere versie zijn. De bevestiging vermeldt pakket, doelversie en de huidige versie indien bekend. NOVA laat de versie door Node-RED installeren en leest daarna de inventaris opnieuw. Een eerste installatie kan direct actief zijn. Bij een upgrade houdt Node-RED de oude versie actief en zet de nieuwe versie klaar voor een herstart. NOVA meldt dan expliciet dat de versie is klaargezet, met `verified=false`, en biedt een link naar Services. Een herstart volgt nooit automatisch uit de pakketbevestiging. Verdere installatieverzoeken blijven geblokkeerd zolang een herstart nodig is.

Alleen een exacte overeenkomst van alle node-setrijen bevestigt de actieve of klaargezette versie. Ontbrekende of tegenstrijdige versies leveren geen geslaagde verificatie op. Een klaargezette versie telt als aanvaarde aanvraag; pas een nieuwe inventaris na herstart kan de actieve versie bevestigen.

De bevestiging bindt de actuele pakketlijst en doelversies aan de gelezen inventaris. Wijzigt het beleid of de inventaris vóór uitvoering, dan moet je opnieuw laden en bevestigen. NOVA weigert overlappende eigen palettewijzigingen binnen één proces. Een onafhankelijke wijziging vanuit de Node-RED-editor of een ander NOVA-proces valt buiten die uitsluiting; de Node-RED-API biedt hiervoor geen atomaire revisie.

De echte Node-RED-toegangscontrole blijft gelden: inventaris vraagt `nodes.read`, wijzigingen vragen `nodes.write`. Het optionele beheertoken blijft op de server. NOVA's instellingenbeveiliging, pakketallowlist en eenmalige `DANGEROUS`-bevestiging blijven actief. Pakketcode draait met de rechten van Node-RED; een versiepin beoordeelt die code niet.
