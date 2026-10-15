# Kleine verrassingen

Schakel **Kleine verrassingen bij een gelegenheid** in onder de helperinstellingen. NOVA gebruikt vaste korte zinnen voor een verjaardag, Nieuwjaar en de [honderdste afgeronde chatbeurt](conversation-milestone.md). Er wordt hiervoor geen taalmodel aangeroepen. Focus, stille uren, bekende afwezigheid en de gedeelde daglimiet blijven gelden; meldingen worden alleen tussen 09:00 en 20:00 lokale tijd aangeboden.

De verjaardag uit de helperinstellingen heeft voorrang. Laat die leeg om een expliciet opgeslagen eigen verjaardag uit het geheugen te gebruiken. Bijvoorbeeld: `Onthoud: ik ben jarig op 15 oktober` of `Remember: my birthday is on October 15`. Gebruik een uitgeschreven maand of een volledige ISO-geboortedatum zoals `1990-10-15`. Een onduidelijke cijferdatum wordt niet geraden. Gebruik het bestaande geheugenoverzicht om een onjuiste of oude herinnering te verwijderen.

Alleen expliciet opgeslagen eigen feiten tellen. Verjaardagen van anderen, citaten, gesprekssamenvattingen en gearchiveerde herinneringen worden niet gebruikt. Bij tegenstrijdige geldige datums volgt geen verjaardagswens vanuit geheugen. NOVA haalt maximaal vijf pagina’s van honderd herinneringen op; een onvolledige, ongeldige of mislukte uitlezing levert geen geheugenverjaardag op. Nieuwjaar en de gespreksmijlpaal blijven dan beschikbaar.

Er is geen cache van de verjaardag: elke geschikte controle leest de actuele opgeslagen feiten opnieuw. De meldingsvoortgang bevat alleen de afgehandelde lokale dag; bronzinnen en geboortedatums worden daarvoor niet opgeslagen of gelogd. Na een geheugenaanvraag controleert NOVA opnieuw de instellingen, lokale tijd, focus en aanwezigheid. Een lopende controle wordt niet dubbel gestart.

De vaste meldingsontvangst bewijst aflevering aan NOVA’s feed. Hoorbare spraak blijft afhankelijk van de bestaande spraakinstellingen en apparaten.
