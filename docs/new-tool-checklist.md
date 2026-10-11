# Checklist voor een nieuwe tool

Vul dit in bij iedere nieuwe toolbron of tool. Een ontbrekend punt betekent dat de tool niet wordt ingeschakeld.

## Beoordeling

- [ ] **Doel en eigenaar:** beschrijf in één zin wat de tool doet, wie hem beheert en welke gegevens hij leest of wijzigt.
- [ ] **Invoer en uitvoer:** leg het JSON-schema, limieten, time-out en maximale resultaatgrootte vast. Verwerp ongeldige of overbodige invoer.
- [ ] **Risico:** kies `READ_ONLY`, `SAFE`, `CONFIRM` of `DANGEROUS` op basis van de werkelijke gevolgen. Controleer dat de bron het risico per aanroep kan verhogen waar doel of argumenten dat vereisen.
- [ ] **Bevestiging:** test dat `CONFIRM` en `DANGEROUS` nooit zonder verse, sessiegebonden, eenmalige toestemming uitvoeren; `DANGEROUS` kan geen blijvende toestemming krijgen.
- [ ] **Actieschakelaar:** controleer gedrag met `NOVA_ENABLE_ACTIONS=false` en bij ontbrekende of offline integratie.
- [ ] **Audit:** controleer dat een wijzigende actie vóór uitvoering wordt gelogd, dat logfouten uitvoering blokkeren en dat afronding, weigering en fout worden vastgelegd.
- [ ] **Geheimen en persoonsgegevens:** test redactie in succes-, fout-, audit-, browser- en modeluitvoer. Neem geen credentials op in bevestigingsmetadata, logs of fixtures.
- [ ] **Netwerkgrens:** gebruik de passende net-guard; controleer DNS/herbinding, redirects, private en loopback-adressen, poorten, time-out en response-limiet. Voor vaste API's: pin HTTPS-hosts, weiger redirects tenzij iedere hop opnieuw wordt gecontroleerd, en begrens de body vóór parsing. Interne service-URL's mogen niet via een algemene proxy bereikbaar zijn.
- [ ] **Verificatie:** lees de gewijzigde toestand terug waar dat kan. Rapporteer `verified: null` als de uitkomst niet onafhankelijk gecontroleerd kan worden.
- [ ] **Regressietests:** voeg tests toe voor schema/riscobesluit, toestemming, audit/privacy en netwerkgrens. Test minimaal één weigering en één foutpad.
- [ ] **Documentatie:** werk `docs/tools-and-safety.md` en de relevante configuratie-inventaris bij; noteer externe contractversie en resterende beperkingen.

## Reviewrecord

| Veld                         | Waarde |
| ---------------------------- | ------ |
| Toolnaam / bron              |        |
| Reviewer / datum             |        |
| Risico en motivatie          |        |
| Gegevens en externe diensten |        |
| Tests / bewijs               |        |
| Open beperkingen             |        |

Zie ook [de centrale tool- en veiligheidsregels](tools-and-safety.md), vooral _What happens to every call_, _Audit log_, _Secret sanitising_ en _Outbound requests: net guard_.

## Validatie van deze checklist (2026-10-12)

De checklist is gecontroleerd tegen `ToolsService`, `net-guard.ts`, `safe-request.ts` en de centrale veiligheidsdocumentatie. De punten over dynamisch risico, éénmalige bevestiging, actieschakelaar, audit vóór wijziging, redactie, terugleesverificatie en limieten passen bij de bestaande uitvoerketen. De bron blijft verantwoordelijk voor argumenten/resultaatgrootte en voor het juist gebruik van netwerkbeveiliging.

De controle vond ontbrekende afdekking voor documentatie-/gereserveerde IP-ranges en vaste JSON-API-responses. Die zijn toegevoegd aan de netwerkblokkade en hostallowlist; vaste JSON-API's weigeren redirects en lezen maximaal 1,5 MB vóór JSON-parsing. Gerichte tests controleren IPv4/IPv6-ranges, DNS-antwoorden met een private entry, URL-validatie en responselimiet.

Dit valideert de template en de gedeelde grenzen; het vervangt niet het ingevulde reviewrecord en de gerichte tests per nieuwe tool.
