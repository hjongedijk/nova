# NOVA voor Windows v0.1.1

De helper en wallpaper krijgen expliciet microfoontoegang voor het ingestelde NOVA-adres. De app gebruikt de door Microsoft beschreven workaround voor een WebView2-spraakregressie die een netwerkfout kan melden terwijl internet werkt. Windows-privacyinstellingen en een aanwezige microfoon blijven nodig.

De wallpaper gebruikt echte WebView2-browserinvoer voor klikken, tekstvelden en keuzelijsten, inclusief sleepstatus en DPI-correctie. De helper wordt boven de wallpaper op het bureaublad geplaatst, onder gewone programma's.

Pc-bediening ondersteunt nu ook de mediatoetsen `media_play_pause`, `media_stop`, `media_next` en `media_previous`. De API-koppelcode en noodstop blijven behouden.

Installeer deze versie via **Bijwerken en herstarten** of met **NOVA-Setup-0.1.1.exe**. Controleer na installatie of spreken in de wallpaper werkt. Echte microfoonopname, tekstvelden, keuzelijsten, de vensterlaag en het pauzeren van Plex moeten nog op de Windows-pc worden getest.

Bron van de spraakworkaround: [Microsoft WebView2-melding #5724](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5724).
