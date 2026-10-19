# NOVA voor Windows v0.1.4

Wallpaper-invoer gebruikt de actuele positie, renderschaal en zoom van de WebView bij het doorgeven van een klik. Een venster dat op het primaire scherm is aangemaakt, gebruikt daardoor niet langer zijn vastgelegde beginschaal voor klikken op een tweede scherm met een andere schaalinstelling.

De router controleert de actuele venstergrenzen bij invoer. Klikken, loslaten en scrollen volgen dezelfde vertaling; een afgebroken sleepactie blijft buiten de pagina en neemt geen focus van andere apps over.

Geometrietests dekken de combinatie 1080p/100% en 4K/150%, verschoven schermposities en zoom. Daadwerkelijke invoer in Windows WebView2 moet na installatie op Windows worden bevestigd.
