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
- [ ] **Netwerkgrens:** gebruik de passende net-guard; controleer DNS/herbinding, redirects, private en loopback-adressen, poorten, time-out en response-limiet. Interne service-URL's mogen niet via een algemene proxy bereikbaar zijn.
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
