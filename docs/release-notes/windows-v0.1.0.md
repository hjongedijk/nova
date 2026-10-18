# NOVA voor Windows v0.1.0

Eerste zelfstandige release van **NOVA voor Windows**: één Rust/Tauri-app met agent, helper, levende achtergrond en systeemvakicoon. Installeer **NOVA-Setup-0.1.0.exe** of pak **nova-windows.zip** uit in een vaste map. De server/webinterface heeft een eigen versie en releasecyclus.

De API-koppelcode blijft de toegangssleutel voor deze pc. Na koppelen zijn schermafbeeldingen, muis, toetsenbord, browser en programma's beschikbaar zonder extra lokale toestemmingen. **Ctrl+Alt+Shift+K** pauzeert NOVA direct; hervatten kan via het systeemvak. Windows vraagt bij het starten om beheerrechten. Weigeren laat de app zonder beheerrechten doorgaan. Beveiligde UAC-schermen en Windows-aanmelding blijven handmatig.

De helper en achtergrond gebruiken de webinterface. Native muisinvoer stuurt klikken en bewegingen door naar de wallpaper. De Windows-app kan oude configuratie importeren en daarna de oude PowerShell-agent uitschakelen; bronbestanden blijven bewaard.

Updates komen uit de eigen ondertekende Windows-updatefeed. Controle gebeurt bij het starten en elke zes uur; installatie vereist een klik op **Bijwerken en herstarten**. Handtekeningcontrole en bescherming tegen downgraden blijven actief.

**Een ontwikkelinstaller met versienummer 0.1.0 moet je één keer handmatig vervangen.** Die heeft hetzelfde versienummer en mogelijk het oude updateadres, waardoor deze eerste release niet automatisch wordt aangeboden. Instellingen blijven in **%LOCALAPPDATA%\NOVA**. Sluit NOVA voor het vervangen van een portable executable.

De native code is getest en voor Windows gecompileerd. Installatie, DPI, wallpaper, beheerrechten, pc-bediening en een update tussen twee gepubliceerde versies vereisen nog controle op een echte Windows-pc. Zie [Windows-agent](https://github.com/hjongedijk/nova/blob/windows-v0.1.0/docs/windows-agent.md) voor installatie en terugkeer.
