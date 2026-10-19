# NOVA voor Windows v0.1.2

De wallpaper stuurt verticale en horizontale muiswielbewegingen door als vertrouwde WebView2-browserinvoer. Scrollen neemt geen toetsenbordfocus over; invoer boven andere programma's blijft van die programma's.

Wallpaper-vensters worden pas opgebouwd wanneer de desktop-host beschikbaar is en vanaf de constructie als native child geregistreerd. De positie wordt omgerekend naar de werkelijke desktop-host; klikcoördinaten gebruiken de werkelijke clientpositie en DPI van het venster. Nieuwe wallpaper-vensters beginnen met 100% browserzoom, zonder zoomsneltoetsen. Windows-schaling blijft van toepassing.

De bijbehorende serverrelease v0.1.77 herstelt de ronde invoerbalk en verbetert de 1080p-layout bij 100%, 125% en 150% Windows-schaling. Controle op echte Windows-hardware blijft nodig voor Explorer, focus en schermen met verschillende DPI.

De helper zit vast midden bovenaan het geselecteerde scherm, onder andere apps. Opgeslagen versleepoffsets en hoekankers worden voor de plaatsing niet meer gebruikt. De compacte balk blijft 360×44 CSS-pixels; geopende panelen worden 640×360, chat 640×440 en bevestigingen 640×220. NOVA v0.1.77 levert de bijbehorende interface.
