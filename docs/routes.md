# Routes en reistijd

NOVA kan op verzoek een geschatte route tussen twee plaatsen berekenen. Staat `NOVA_HOME_LAT`/`NOVA_HOME_LON` of Home Assistant `zone.home` goed, dan volstaat een bestemming. De routebron ontvangt alleen twee coördinaten. Plaatsnamen worden met de bestaande Open-Meteo-stadsgeocoder opgelost; straatadressen zijn niet ondersteund.

Maak voor persoonlijk gebruik een gratis Standard-sleutel bij [openrouteservice](https://openrouteservice.org/plans/) en zet `OPENROUTESERVICE_API_KEY` alleen in de lokale deployment-`.env`. Herstart daarna de API-container. Zonder sleutel biedt NOVA `route_estimate` niet aan. De sleutel komt niet in Git, de browser, toolresultaten of auditlogs.

De tool gebruikt de [Directions-API](https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/requests-and-return-types) voor auto, fiets of lopen. Resultaten tonen afstand, geschatte minuten en bronvermelding. **Er zit geen live verkeersinformatie in.** Pakketvolging is nog niet beschikbaar. De gratis Standard-dienst heeft gebruikslimieten; NOVA roept haar alleen aan na een expliciete routevraag. De dienst ontvangt locatiecoördinaten; gebruik hem niet voor locaties die je niet extern wilt delen.

Bij een ingestelde CalDAV-agenda kan NOVA op verzoek ook een vertrekadvies voor één afspraak maken. Noem de **exacte titel** en de **bestemmingsplaats**; de agenda bevat op dit moment geen betrouwbaar adresveld. NOVA gebruikt de begintijd, de autoroute en standaard 15 minuten marge. Bij twee afspraken met dezelfde titel volgt geen gok. Dit is alleen advies: er wordt geen wekker of proactieve melding ingesteld.
