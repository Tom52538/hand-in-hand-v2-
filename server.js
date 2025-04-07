const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// Session-Middleware konfigurieren
app.use(session({
  secret: 'dein-geheimes-schluessel', // Bitte anpassen!
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Auf true setzen, wenn du HTTPS verwendest
}));

// PostgreSQL Datenbank einrichten
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/**
 * Tabelle work_hours:
 * - starttime und endtime als TIME (klein geschrieben in der DB).
 * Tabelle employees:
 * - enthält Sollstunden pro Wochentag
 */
db.query(`
  CREATE TABLE IF NOT EXISTS work_hours (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    date DATE NOT NULL,
    hours DOUBLE PRECISION,
    break_time DOUBLE PRECISION,
    comment TEXT,
    starttime TIME,
    endtime TIME
  );
`).catch(err => console.error("Fehler beim Erstellen der Tabelle work_hours:", err));

db.query(`
  CREATE TABLE IF NOT EXISTS employees (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    mo_hours DOUBLE PRECISION,
    di_hours DOUBLE PRECISION,
    mi_hours DOUBLE PRECISION,
    do_hours DOUBLE PRECISION,
    fr_hours DOUBLE PRECISION
  );
`).then(() => {
  console.log("Tabelle employees erfolgreich erstellt oder bereits vorhanden.");
}).catch(err => console.error("Fehler beim Erstellen der Tabelle employees:", err));

// Middleware, um Admin-Berechtigungen zu prüfen
function isAdmin(req, res, next) {
  if (req.session.isAdmin) {
    next();
  } else {
    res.status(403).send('Access denied. Admin privileges required.');
  }
}

// --------------------------
// Hilfsfunktionen für Zeitformatierung
// --------------------------
/**
 * parseTime("HH:MM") -> Anzahl Minuten seit 00:00
 */
function parseTime(timeStr) {
  const [hh, mm] = timeStr.split(':');
  return parseInt(hh, 10) * 60 + parseInt(mm, 10);
}

/**
 * calculateWorkHours("HH:MM", "HH:MM") -> Anzahl Stunden als Zahl (z. B. 7.5)
 */
function calculateWorkHours(startTime, endTime) {
  const diffInMin = parseTime(endTime) - parseTime(startTime);
  return diffInMin / 60; // Stunden
}

/**
 * Ermittelt anhand des Wochentags die Soll-Stunden (aus employees.*_hours)
 */
function getExpectedHours(row, dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay(); // 0=So, 1=Mo, ...
  if (day === 1) return row.mo_hours || 0;
  if (day === 2) return row.di_hours || 0;
  if (day === 3) return row.mi_hours || 0;
  if (day === 4) return row.do_hours || 0;
  if (day === 5) return row.fr_hours || 0;
  return 0;
}

/**
 * CSV-Funktion mit den Spalten:
 * 1. Name, 2. Datum, 3. Arbeitsbeginn, 4. Arbeitsende,
 * 5. Pause (Minuten), 6. Soll-Arbeitszeit, 7. Ist-Arbeitszeit,
 * 8. Differenz, 9. Bemerkung
 */
function convertToCSV(data) {
  if (!data || data.length === 0) return '';
  
  const csvRows = [];
  csvRows.push([
    "Name",
    "Datum",
    "Arbeitsbeginn",
    "Arbeitsende",
    "Pause (Minuten)",
    "SollArbeitszeit",
    "IstArbeitszeit",
    "Differenz",
    "Bemerkung"
  ].join(','));

  for (const row of data) {
    const dateFormatted = row.date
      ? new Date(row.date).toLocaleDateString("de-DE")
      : "";
    
    // Hier greifen wir auf die konsistenten Felder zu:
    const startTimeFormatted = row.startTime || "";
    const endTimeFormatted   = row.endTime   || "";

    // break_time ist in Stunden gespeichert, daher * 60 für Minuten
    const breakMinutes = (row.break_time * 60).toFixed(0);
    const istHours = row.hours || 0;
    const expected = getExpectedHours(row, row.date);
    const diff = istHours - expected;

    const istFormatted = istHours.toFixed(2);
    const expectedFormatted = expected.toFixed(2);
    const diffFormatted = diff.toFixed(2);

    const values = [
      row.name,
      dateFormatted,
      startTimeFormatted,
      endTimeFormatted,
      breakMinutes,
      expectedFormatted,
      istFormatted,
      diffFormatted,
      row.comment || ''
    ];
    csvRows.push(values.join(','));
  }
  return csvRows.join('\n');
}

// --------------------------
// API-Endpunkte für Arbeitszeiten (Admin)
// --------------------------
/**
 * Liefert alle Einträge an den Admin.
 * Hier wird TO_CHAR verwendet, um starttime und endtime als "HH24:MI" zurückzugeben,
 * mit Alias "startTime" und "endTime".
 */
app.get('/admin-work-hours', isAdmin, (req, res) => {
  const query = `
    SELECT
      id,
      name,
      date,
      hours,
      break_time,
      comment,
      TO_CHAR(starttime, 'HH24:MI') AS "startTime",
      TO_CHAR(endtime,   'HH24:MI') AS "endTime"
    FROM work_hours
    ORDER BY date ASC
  `;
  db.query(query, [])
    .then(result => res.json(result.rows))
    .catch(err => res.status(500).send('Error fetching work hours.'));
});

/**
 * CSV-Download
 * Hier erfolgt ebenfalls die Umwandlung via TO_CHAR und die Aliasnamen werden angepasst.
 */
app.get('/admin-download-csv', isAdmin, (req, res) => {
  const query = `
    SELECT 
      w.id,
      w.name,
      w.date,
      TO_CHAR(w.starttime, 'HH24:MI') AS "startTime",
      TO_CHAR(w.endtime,   'HH24:MI') AS "endTime",
      w.break_time,
      w.comment,
      w.hours,
      e.mo_hours,
      e.di_hours,
      e.mi_hours,
      e.do_hours,
      e.fr_hours
    FROM work_hours w
    LEFT JOIN employees e ON LOWER(w.name) = LOWER(e.name)
    ORDER BY w.date ASC
  `;
  db.query(query, [])
    .then(result => {
      const csv = convertToCSV(result.rows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="arbeitszeiten.csv"');
      res.send(csv);
    })
    .catch(err => res.status(500).send('Error fetching work hours.'));
});

/**
 * Update von Arbeitszeiten
 */
app.put('/api/admin/update-hours', isAdmin, (req, res) => {
  const { id, name, date, startTime, endTime, comment, breakTime } = req.body;

  // Validierung: Arbeitsbeginn muss vor Arbeitsende liegen
  if (parseTime(startTime) >= parseTime(endTime)) {
    return res.status(400).json({ error: 'Arbeitsbeginn darf nicht später als Arbeitsende sein.' });
  }

  const totalHours = calculateWorkHours(startTime, endTime);
  const breakTimeMinutes = parseInt(breakTime, 10) || 0;
  const breakTimeHours = breakTimeMinutes / 60;
  const netHours = totalHours - breakTimeHours;

  const query = `
    UPDATE work_hours
    SET
      name = $1,
      date = $2,
      hours = $3,
      break_time = $4,
      comment = $5,
      starttime = $6,
      endtime = $7
    WHERE id = $8
  `;
  db.query(query, [name, date, netHours, breakTimeHours, comment, startTime, endTime, id])
    .then(() => res.send('Working hours updated successfully.'))
    .catch(err => res.status(500).send('Error updating working hours.'));
});

/**
 * Löschen eines einzelnen Eintrags
 */
app.delete('/api/admin/delete-hours/:id', isAdmin, (req, res) => {
  const { id } = req.params;
  const query = 'DELETE FROM work_hours WHERE id = $1';
  db.query(query, [id])
    .then(() => res.send('Working hours deleted successfully.'))
    .catch(err => res.status(500).send('Error deleting working hours.'));
});

// --------------------------
// API-Endpunkte (öffentlicher Teil) zum Eintragen und Abfragen
// --------------------------
/**
 * Neue Arbeitszeit eintragen
 */
app.post('/log-hours', (req, res) => {
  const { name, date, startTime, endTime, comment, breakTime } = req.body;

  // Validierung: Arbeitsbeginn muss vor Arbeitsende liegen
  if (parseTime(startTime) >= parseTime(endTime)) {
    return res.status(400).json({ error: 'Arbeitsbeginn darf nicht später als Arbeitsende sein.' });
  }

  const checkQuery = `
    SELECT * FROM work_hours
    WHERE LOWER(name) = LOWER($1) AND date = $2
  `;
  db.query(checkQuery, [name, date])
    .then(result => {
      if (result.rows.length > 0) {
        return res.status(400).json({ error: 'Eintrag für diesen Tag existiert bereits.' });
      }
      const totalHours = calculateWorkHours(startTime, endTime);
      const breakTimeMinutes = parseInt(breakTime, 10) || 0;
      const breakTimeHours = breakTimeMinutes / 60;
      const netHours = totalHours - breakTimeHours;

      const insertQuery = `
        INSERT INTO work_hours (name, date, hours, break_time, comment, starttime, endtime)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `;
      db.query(insertQuery, [name, date, netHours, breakTimeHours, comment, startTime, endTime])
        .then(() => res.send('Daten erfolgreich gespeichert.'))
        .catch(err => res.status(500).send('Fehler beim Speichern der Daten.'));
    })
    .catch(err => res.status(500).send('Fehler beim Überprüfen der Daten.'));
});

/**
 * Alle Arbeitszeiten einer Person abrufen
 */
app.get('/get-all-hours', (req, res) => {
  const { name } = req.query;
  if (!name) {
    return res.status(400).send('Name ist erforderlich.');
  }
  // Hier ebenfalls TO_CHAR für die Zeitfelder mit konsistenten Aliasnamen
  const query = `
    SELECT
      id,
      name,
      date,
      hours,
      break_time,
      comment,
      TO_CHAR(starttime, 'HH24:MI') AS "startTime",
      TO_CHAR(endtime,   'HH24:MI') AS "endTime"
    FROM work_hours
    WHERE LOWER(name) = LOWER($1)
    ORDER BY date ASC
  `;
  db.query(query, [name])
    .then(result => res.json(result.rows))
    .catch(err => res.status(500).send('Fehler beim Abrufen der Daten.'));
});

/**
 * Spezifische Arbeitszeit (Tag) einer Person abrufen
 */
app.get('/get-hours', (req, res) => {
  const { name, date } = req.query;
  const query = `
    SELECT
      id,
      name,
      date,
      hours,
      break_time,
      comment,
      TO_CHAR(starttime, 'HH24:MI') AS "startTime",
      TO_CHAR(endtime,   'HH24:MI') AS "endTime"
    FROM work_hours
    WHERE LOWER(name) = LOWER($1)
      AND date = $2
  `;
  db.query(query, [name, date])
    .then(result => {
      if (result.rows.length === 0) {
        return res.status(404).send('Keine Daten gefunden.');
      }
      res.json(result.rows[0]);
    })
    .catch(err => res.status(500).send('Fehler beim Abrufen der Daten.'));
});

/**
 * Gesamte Tabelle work_hours löschen (mit Admin-Passwort)
 */
app.delete('/delete-hours', (req, res) => {
  const { password, confirmDelete } = req.body;
  if (password === 'admin' && (confirmDelete === true || confirmDelete === 'true')) {
    const deleteQuery = 'DELETE FROM work_hours';
    db.query(deleteQuery, [])
      .then(() => res.send('Daten erfolgreich gelöscht.'))
      .catch(err => res.status(500).send('Fehler beim Löschen der Daten.'));
  } else {
    res.status(401).send('Löschen abgebrochen. Passwort erforderlich oder Bestätigung fehlt.');
  }
});

// --------------------------
// Admin-Login
// --------------------------
app.post('/admin-login', (req, res) => {
  const { password } = req.body;
  if (password === 'admin') {
    req.session.isAdmin = true;
    res.send('Admin angemeldet.');
  } else {
    res.status(401).send('Ungültiges Passwort.');
  }
});

// --------------------------
// API-Endpunkte für Mitarbeiterverwaltung (admin-geschützt)
// --------------------------
app.get('/admin/employees', isAdmin, (req, res) => {
  const query = 'SELECT * FROM employees';
  db.query(query, [])
    .then(result => res.json(result.rows))
    .catch(err => res.status(500).send('Fehler beim Abrufen der Mitarbeiter.'));
});

app.post('/admin/employees', isAdmin, (req, res) => {
  const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
  if (!name) {
    return res.status(400).send('Name ist erforderlich.');
  }
  const query = `
    INSERT INTO employees (name, mo_hours, di_hours, mi_hours, do_hours, fr_hours)
    VALUES ($1, $2, $3, $4, $5, $6)
  `;
  db.query(query, [name, mo_hours || 0, di_hours || 0, mi_hours || 0, do_hours || 0, fr_hours || 0])
    .then(result => res.send({ 
      id: result.rowCount, 
      name, 
      mo_hours, 
      di_hours, 
      mi_hours, 
      do_hours, 
      fr_hours 
    }))
    .catch(err => res.status(500).send('Fehler beim Hinzufügen des Mitarbeiters.'));
});

app.put('/admin/employees/:id', isAdmin, (req, res) => {
  const { id } = req.params;
  const { name, mo_hours, di_hours, mi_hours, do_hours, fr_hours } = req.body;
  if (!name) {
    return res.status(400).send('Name ist erforderlich.');
  }
  const query = `
    UPDATE employees
    SET name = $1,
        mo_hours = $2,
        di_hours = $3,
        mi_hours = $4,
        do_hours = $5,
        fr_hours = $6
    WHERE id = $7
  `;
  db.query(query, [name, mo_hours || 0, di_hours || 0, mi_hours || 0, do_hours || 0, fr_hours || 0, id])
    .then(() => res.send('Mitarbeiter erfolgreich aktualisiert.'))
    .catch(err => res.status(500).send('Fehler beim Aktualisieren des Mitarbeiters.'));
});

app.delete('/admin/employees/:id', isAdmin, (req, res) => {
  const { id } = req.params;
  const query = 'DELETE FROM employees WHERE id = $1';
  db.query(query, [id])
    .then(() => res.send('Mitarbeiter erfolgreich gelöscht.'))
    .catch(err => res.status(500).send('Fehler beim Löschen des Mitarbeiters.'));
});

// Öffentlich: Nur die Namen und IDs
app.get('/employees', (req, res) => {
  const query = 'SELECT id, name FROM employees';
  db.query(query, [])
    .then(result => res.json(result.rows))
    .catch(err => res.status(500).send('Fehler beim Abrufen der Mitarbeiter.'));
});

// --------------------------
// Server starten
// --------------------------
app.listen(port, () => {
  console.log(`Server läuft auf http://localhost:${port}`);
});
