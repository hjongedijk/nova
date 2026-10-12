# Lokale plug-inmap

NOVA leest bij het starten maximaal 20 declaratieve webhookvaardigheden uit `NOVA_DATA_DIR/plugins` (`/opt/nova/nova-data/plugins` bij de meegeleverde Compose-stack). Ze verschijnen als `skill_<naam>` in de toolcatalogus. Uitvoerbare plug-ins, JavaScript en willekeurige packages worden niet geladen. Instructievaardigheden beheer je via Instellingen.

Maak de map privé (`0700`) en elk JSON-bestand privé (`0600`). Bestandsnamen bestaan uit kleine letters, cijfers, `_` en `-` en eindigen op `.json`; een bestand is maximaal 16 KiB. Symlinks, ongeldige JSON, dubbele namen, open rechten en onbekende bestandstypen worden genegeerd. Herstart de NOVA-API na een wijziging. Zet de map en eventuele geheime headers niet in Git.

Voorbeeld `plugins/status.json`:

```json
{
  "type": "webhook",
  "name": "Status",
  "description": "Lees de status van mijn eigen dienst wanneer ik daarom vraag",
  "risk": "READ_ONLY",
  "http": {
    "method": "GET",
    "url": "https://example.org/status"
  }
}
```

Vervang de URL door je eigen endpoint. Dezelfde validatie als voor vaardigheden in Instellingen geldt: parameterlimieten, URL-/netwerkcontrole, time-out en verplichte bevestiging op basis van risico. Een schrijvende HTTP-methode kan geen `READ_ONLY` blijven. Controleer na een herstart in de toolcatalogus of `skill_status` verschijnt en test eerst met een onschadelijk endpoint. Bij een naamconflict heeft de vaardigheid uit Instellingen voorrang. Zie [Tools en veiligheid](tools-and-safety.md) voor de bevestigingsregels.
