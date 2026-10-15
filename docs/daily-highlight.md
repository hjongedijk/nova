# Dagelijks hoogtepunt

Onder Helperinstellingen kun je een dagelijks hoogtepunt inschakelen en een lokale tijd kiezen. De server gebruikt de ingestelde `TZ` (standaard `Europe/Amsterdam`). Zonder onderbouwd positief moment blijft NOVA stil.

Expliciete positieve uitspraken uit het gesprek van dezelfde dag houden voorrang. Anders leest NOVA maximaal 500 recente auditregels uit het bestaande begrensde actielog. Alleen aantoonbaar geslaagde codecontroles (`code_run_tests`, `code_self_test`) en het aanmaken van een routine (`node_red_flow_create`) tellen mee.

Deze acties moeten daadwerkelijk bevestigd, uitgevoerd en geverifieerd zijn. Wachtende of geweigerde bevestigingen, mislukte acties, alleen aangenomen opdrachten, ongeldige datums en gebeurtenissen buiten de lokale dag of in de toekomst tellen niet mee. De nieuwste geldige actie wordt gekozen op het werkelijke tijdstip, ook bij verschillende tijdzone-offsets.

De melding bevat één vaste, niet-identificerende zin. Projectnamen, routines, argumenten, code, uitvoer en oorspronkelijke gespreksuitspraken komen er niet in. Er is geen modelaanroep of extra netwerkverzoek nodig. Het begrensde log is geen volledige daggeschiedenis: oudere gebeurtenissen buiten het leesvenster worden niet alsnog opgezocht.

De bestaande meldings-, focus- en afleverregels blijven gelden. Een tijdelijke leesfout laat de dag onafgerond, zodat het bestaande begrensde herstelpad opnieuw kan proberen. De duurzame ontvangst voorkomt een tweede melding na een herstart, ook als het voortgangsbestand opnieuw moet worden opgebouwd.

Verificatie: de gerichte tests en een geïsoleerde proef met de werkelijk gebouwde `DailyHighlightService`, `AuditService` en `AlertsFeed` dekken bronkeuze, privacy, datums, herstel en een tweede proces zonder herhaling. Dit bewijst geen fysieke hoorbaarheid op een pc of telefoon.
