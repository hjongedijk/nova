# Gespreksmijlpaal

Met **Kleine verrassingen bij een gelegenheid** ingeschakeld telt NOVA afgeronde gewone chatbeurten. Na honderd beurten wacht één vaste melding op een geschikt moment. De teller begint bij inschakeling; oude gesprekken worden niet doorzocht. Uitschakelen pauzeert de teller en melding. Opnieuw inschakelen vervolgt de bestaande stand.

Een beurt telt wanneer `/api/chat` of `/api/chat-stream` succesvol een volledig antwoord heeft afgerond. Gewone Node-RED-vraagoproepen via deze routes tellen ook mee. Het is dus geen telling van unieke menselijke vragen. Mislukte of onderbroken antwoorden en de aparte proactieve achtergrondroute tellen niet mee. Een herhaalde aanvraag die opnieuw volledig wordt afgehandeld is een nieuwe beurt.

De melding volgt dezelfde regels als andere kleine verrassingen: alleen overdag, buiten focus en stille uren, en niet bij bekende afwezigheid. Een verjaardag of Nieuwjaar krijgt voorrang. De gedeelde daglimiet schuift de mijlpaal zo nodig door naar een volgende dag. De melding gebruikt vaste tekst, zonder taalmodel.

`conversation-milestone.json` bevat alleen een versienummer, een teller tot maximaal honderd en een aflevervlag. Het bestand is privé, atomisch geschreven en na een herstart bruikbaar. Berichttekst, sessienummers, personen en tijdstippen staan niet in de teller. Beschadigde opslag stopt alleen de mijlpaal; chat blijft beschikbaar. Herstel van het bestand wordt bij een volgende beurt of geplande controle opnieuw geprobeerd.

Een vaste afleveridentiteit in de bestaande privé meldingshistorie voorkomt dubbele melding na een mislukte bevestigingswrite. Deze ontvangst blijft bewaard wanneer andere workflowmeldingen de begrensde historie vullen. De ontvangst bewijst dat NOVA de melding heeft aangenomen; hoorbare weergave hangt af van de bestaande spraakinstellingen en apparaten.
